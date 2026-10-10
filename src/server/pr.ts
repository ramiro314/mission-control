import { classifyCheckEntry, type CiCheckEntryState } from "@shared/ci-checks.ts";
import { PR_POLL_MS, ghBin } from "./config.ts";
import type { PrMatch, Registry } from "./registry.ts";
import type { PrChecks, PrMergeable, PrState } from "@shared/types.ts";
import { currentMergeability, nextMergeability, prMergeableFromGitHub } from "@shared/pr-mergeable.ts";
import type { ConflictObservation, PrConflictTracker } from "./pr-conflicts.ts";
import { unref } from "./util/timers.ts";
import { recordTelemetryPrMerges, telemetryPrPollTargets } from "./telemetry/index.ts";
import { run } from "./util/exec.ts";
import { originGitHubRepository, type GitHubRepositoryIdentity } from "./inspector/github.ts";

// Keeps each session's PR chip honest by asking `gh` for the pull request on the
// session's current branch. It is the source of truth behind the chip: it
// discovers PRs the hook never saw (Codex sessions, PRs opened in the web UI),
// surfaces whether that PR is open or merged, and retracts the chip only when the
// session moves to a branch that no longer matches the PR's head. The hook only
// ever sets a link optimistically; nothing but this poller can confirm a merge,
// because a merge happens outside the session where no hook can observe it.
//
// A merged PR is deliberately kept (not cleared): once your work lands you can
// still see the PR that carried it, right up until the session is reset onto a
// different branch. Only a *closed-unmerged* PR is treated as "no PR".
//
// Cheap by construction: live sessions cost one `gh` call per distinct worktree;
// persisted links are concurrency-limited and back off independently.
//
// The by-URL half answers for pull requests no live session can be asked about. It serves
// two harvests - unsatisfied dependency edges, and the bindings of tasks a merge could
// still complete - through ONE cadence, because they overlap constantly (the task you are
// waiting on is usually also a task) and two would poll the same URL twice at two
// backoffs.

/** Branches that never carry a PR, so we never spend a `gh` call on them. */
const DEFAULT_BRANCHES = new Set(["main", "master"]);

type PrLookup = "error" | null | Omit<PrMatch, "branch" | "agentSessionId" | "episodeId">;
/**
 * What the by-URL poller learned about one pull request. `closed` is a pull request closed
 * without merging: the session poller still reads it as "no PR", but a task bound to it is
 * told (`Registry.reconcilePrClosures`). `null` is "nothing to report", which an injected
 * lookup may still return for a closed PR.
 */
type PrStateMatch = {
  state: PrState | "closed";
  mergedAt: number | null;
  /** Null when GitHub answered `UNKNOWN`, or when an injected lookup did not ask. */
  mergeable?: PrMergeable | null;
  baseRef?: string | null;
  headSha?: string | null;
};
type PrStateLookup = "error" | PrStateMatch | null;

const PR_URL_CONCURRENCY = 4;
const PR_URL_MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Per-URL cadence for the by-URL poller: when each pull request may be asked about again,
 * and how far its backoff has grown. One instance serves every harvest - see the header.
 */
export class PrUrlPollState {
  private entries = new Map<string, { attempts: number; nextAt: number }>();

  due(urls: string[], now: number): string[] {
    const current = new Set(urls);
    for (const url of this.entries.keys()) {
      if (!current.has(url)) this.entries.delete(url);
    }
    return urls.filter((url) => (this.entries.get(url)?.nextAt ?? 0) <= now);
  }

  record(url: string, result: PrStateLookup, now: number): void {
    if (result !== "error" && result?.state === "merged") {
      this.entries.delete(url);
      return;
    }
    const attempts = (this.entries.get(url)?.attempts ?? 0) + 1;
    const delay = Math.min(
      PR_POLL_MS * 2 ** Math.min(attempts - 1, 8),
      PR_URL_MAX_BACKOFF_MS,
    );
    this.entries.set(url, { attempts, nextAt: now + delay });
  }
}

async function forEachConcurrent<T>(
  values: T[],
  limit: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const value = values[next++];
        if (value !== undefined) await visit(value);
      }
    }),
  );
}

/**
 * The `gh pr list` arguments for the pull requests whose head is `branch`. `--repo` names the
 * checkout's `origin` whenever it is a GitHub remote, because `gh`'s own choice outside a
 * terminal is a remote named `upstream` - on a fork, the parent, which an org enforcing SAML
 * SSO refuses. A non-GitHub `origin` leaves the choice to `gh`, as before.
 */
export function prListArgs(branch: string, repo: GitHubRepositoryIdentity | null): string[] {
  return [
    "pr",
    "list",
    ...(repo ? ["--repo", `${repo.owner}/${repo.repo}`] : []),
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "url,number,state,statusCheckRollup,createdAt,mergedAt,headRefOid,mergeable,baseRefName",
    "--limit",
    "20",
  ];
}

/**
 * Ask `gh` for the pull request whose head is `branch`, on the repository `cwd`'s
 * `origin` names (`prListArgs`). Prefers a still-open PR, else
 * falls back to a merged one (so a landed PR keeps showing). Returns `null` when
 * the branch has provably no open/merged PR (only closed-unmerged, or none), or
 * `"error"` when `gh` is missing/unauthenticated/timed out - which the reconciler
 * treats as "unknown, leave the existing chip alone" rather than a reason to clear.
 */
async function queryPr(cwd: string, branch: string): Promise<PrLookup> {
  const [res, head] = await Promise.all([
    originGitHubRepository(cwd).then((repo) =>
      run(ghBin(), prListArgs(branch, repo), { cwd, timeoutMs: 8000 }),
    ),
    run("git", ["rev-parse", "HEAD"], { cwd, timeoutMs: 8000 }),
  ]);
  const worktreeHeadSha = head.stdout.trim();
  if (res.code !== 0 || head.code !== 0 || !worktreeHeadSha) return "error";
  try {
    const arr = JSON.parse(res.stdout || "[]") as unknown;
    if (!Array.isArray(arr)) return "error"; // malformed output is an anomaly, not "no PR"
    // `gh` lists newest-first; prefer an open PR, else the most recent merged one.
    // A closed-unmerged PR is ignored, so the chip drops like there's no PR.
    const open = arr.find((p) => prStateOf(p) === "open");
    const match = open ?? arr.find((p) => prStateOf(p) === "merged");
    if (!match) return null;
    const { url, number, createdAt, mergedAt, headRefOid, mergeable, baseRefName } = match as {
      url?: unknown;
      number?: unknown;
      createdAt?: unknown;
      mergedAt?: unknown;
      headRefOid?: unknown;
      mergeable?: unknown;
      baseRefName?: unknown;
    };
    const state = prStateOf(match);
    const createdAtMs = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
    const mergedAtMs = typeof mergedAt === "string" ? Date.parse(mergedAt) : Number.NaN;
    if (typeof url !== "string" || !Number.isFinite(createdAtMs) || typeof headRefOid !== "string") {
      return "error";
    }
    if (state === "merged" && !Number.isFinite(mergedAtMs)) return "error";
    return {
      url,
      number: typeof number === "number" ? number : null,
      state: state as PrState,
      checks: checksOf(match),
      createdAt: createdAtMs,
      mergedAt: state === "merged" ? mergedAtMs : null,
      headSha: headRefOid,
      worktreeHeadSha,
      mergeable: prMergeableFromGitHub(mergeable),
      baseRef: typeof baseRefName === "string" ? baseRefName : null,
    };
  } catch {
    return "error";
  }
}

/**
 * The head commit of a worktree, or null when nothing there can answer.
 *
 * Null is the honest answer for a tree that has been torn down or returned to the pool, and
 * the completion quorum reads it as "unchanged" - which is what lets a multi-repo task whose
 * checkouts were reclaimed ever complete. It is deliberately distinct from "nobody has
 * looked", which the registry represents by having no entry at all and which HOLDS
 * completion.
 */
async function queryHead(dir: string): Promise<string | null> {
  const r = await run("git", ["-C", dir, "rev-parse", "HEAD"], { timeoutMs: 8000 });
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

async function queryPrUrl(url: string): Promise<PrStateLookup> {
  const res = await run(
    ghBin(),
    ["pr", "view", url, "--json", "state,mergedAt,mergeable,baseRefName,headRefOid"],
    { timeoutMs: 8000 },
  );
  if (res.code !== 0) return "error";
  try {
    const parsed = JSON.parse(res.stdout) as {
      state?: unknown;
      mergedAt?: unknown;
      mergeable?: unknown;
      baseRefName?: unknown;
      headRefOid?: unknown;
    };
    const facts = {
      mergeable: prMergeableFromGitHub(parsed.mergeable),
      baseRef: typeof parsed.baseRefName === "string" ? parsed.baseRefName : null,
      headSha: typeof parsed.headRefOid === "string" ? parsed.headRefOid : null,
    };
    const state = prStateOf(parsed);
    if (state === null) {
      return parsed.state === "CLOSED" ? { state: "closed", mergedAt: null, ...facts } : "error";
    }
    if (state === "open") return { state, mergedAt: null, ...facts };
    const mergedAt = typeof parsed.mergedAt === "string" ? Date.parse(parsed.mergedAt) : Number.NaN;
    return Number.isFinite(mergedAt) ? { state, mergedAt, ...facts } : "error";
  } catch {
    return "error";
  }
}

/** Map `gh`'s uppercase PR state to our surfaced states; closed-unmerged -> null. */
function prStateOf(p: unknown): PrState | null {
  const raw = (p as { state?: unknown })?.state;
  if (raw === "OPEN") return "open";
  if (raw === "MERGED") return "merged";
  return null; // CLOSED (unmerged) or anything unexpected
}

type CheckState = "fail" | "pending" | "pass";

const CHECK_STATE: Record<CiCheckEntryState, CheckState> = {
  failing: "fail",
  pending: "pending",
  passing: "pass",
};

/** One `statusCheckRollup` entry, classified by the shared rule. Null for an unknown shape. */
function checkEntryState(e: unknown): CheckState | null {
  const state = classifyCheckEntry(e);
  return state === null ? null : CHECK_STATE[state];
}

/**
 * Roll a PR's `statusCheckRollup` up to a single chip state: any failing check
 * dominates (that's what the card's alert keys off), else pending while any is
 * still running, else passing. Null when the PR carries no checks at all.
 */
function checksOf(p: unknown): PrChecks | null {
  const rollup = (p as { statusCheckRollup?: unknown })?.statusCheckRollup;
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let sawPending = false;
  let sawPass = false;
  for (const e of rollup) {
    const s = checkEntryState(e);
    if (s === "fail") return "failing";
    if (s === "pending") sawPending = true;
    else if (s === "pass") sawPass = true;
  }
  if (sawPending) return "pending";
  if (sawPass) return "passing";
  return null;
}

/**
 * Query every feature-branch session's open PR and reconcile the results onto
 * every session in one pass. Sessions on a default branch (or none) are never
 * queried; reconciliation still clears any stale link they carry, which is what
 * retires a chip after the session moves off the branch its PR belonged to.
 */
export async function pollAndReconcilePrs(
  registry: Registry,
  lookup: (cwd: string, branch: string) => Promise<PrLookup> = queryPr,
  lookupUrl: (url: string) => Promise<PrStateLookup> = queryPrUrl,
  urlState = new PrUrlPollState(),
  now = Date.now(),
  lookupHead: (dir: string) => Promise<string | null> = queryHead,
  /** Seam for the telemetry harvest, so a focused test can drive it without a real store. */
  telemetryTargets: (() => string[]) | null = null,
  /** The conflict episodes, or null where a caller does not track them. */
  conflicts: PrConflictTracker | null = null,
): Promise<void> {
  const targets = registry.prPollTargets();
  // The SECONDARY repositories of every live multi-repo task, each with its own worktree and
  // branch. Same cost rule as the primary list - one `gh` call per distinct cwd - and empty
  // whenever no multi-repo task is running, which is the ordinary case.
  const repoTargets = registry.extraRepoPrPollTargets();
  // Every multi-repo worktree the completion quorum still needs a head for. Read here rather
  // than at reconcile time because the reconciler is synchronous and runs on every session
  // event: a `git` call there would be a subprocess on the hot path. This tick is the one
  // place that already spends subprocesses, and it runs immediately before the reconciler it
  // feeds, so the observation is as fresh as the merge that triggers the question.
  const headTargets = registry.worktreeHeadTargets();
  // Both harvests, deduplicated: a task waiting on its own merge is very often also the
  // task something else declared a dependency on, and asking twice would spend two `gh`
  // calls and two backoffs on one pull request.
  //
  // The OPERATIONAL set, kept as its own value rather than folded into `linkedUrls` below.
  // These are the URLs whose merge may complete a task and release its dependents, and only
  // these reach `reconcilePrMerges`. A telemetry-only URL - one whose task binding was
  // invalidated, so `taskPrPollTargets` no longer harvests it - must not acquire that
  // authority by riding along in the same map.
  const operationalUrls = new Set([
    ...registry.dependencyPrPollTargets(),
    ...registry.taskPrPollTargets(),
  ]);
  // The THIRD harvest: pull requests telemetry retained an observation of, whose operational
  // binding may be long gone. A third cadence would spend a second `gh` call and a second
  // backoff on a pull request the first two are usually already asking about, so it shares
  // this one and is deduplicated into it.
  //
  // The FOURTH: every open conflict episode's PR, so an exited session with no task - which
  // neither harvest above reaches - is still asked about until its conflict closes. Linked,
  // never operational: keeping a conflict in view gains it no merge-completion authority.
  const linkedUrls = [
    ...new Set([
      ...operationalUrls,
      ...(telemetryTargets?.() ?? telemetryPrPollTargets(now)),
      ...(conflicts?.episodes.urls() ?? []),
    ]),
  ];
  const found = new Map<string, PrMatch>();
  const skip = new Set<string>();
  const repoFound = new Map<string, PrMatch>();
  const repoSkip = new Set<string>();

  const queryable = targets.filter((t) => t.branch && !DEFAULT_BRANCHES.has(t.branch));
  const repoQueryable = repoTargets.filter((t) => !DEFAULT_BRANCHES.has(t.branch));
  if (
    queryable.length === 0 &&
    repoQueryable.length === 0 &&
    linkedUrls.length === 0 &&
    headTargets.length === 0
  ) {
    registry.reconcilePrs(found, skip); // clears any lingering link, spawns nothing
    conflicts?.reconcile(new Map(), now);
    return;
  }

  // A branch is checked out in exactly one worktree, so one `gh` call per cwd
  // answers for every session sharing it - and a secondary repo's worktree is simply
  // another cwd, so the whole fan-out still costs one call per checkout.
  const byCwd = new Map<string, string>();
  for (const t of queryable) byCwd.set(t.cwd, t.branch as string);
  for (const t of repoQueryable) byCwd.set(t.cwd, t.branch);
  const results = new Map<string, PrLookup>();
  const heads = new Map<string, string | null>();
  await Promise.all([
    ...[...byCwd].map(async ([cwd, branch]) => {
      results.set(cwd, await lookup(cwd, branch));
    }),
    forEachConcurrent(headTargets, PR_URL_CONCURRENCY, async (dir) => {
      heads.set(dir, await lookupHead(dir));
    }),
  ]);
  // Before the reconcilers below, which is the ordering the quorum depends on: both of them
  // can complete a task, and a task completed against last tick's heads is a task completed
  // against a repository whose work may since have moved off its baseline.
  if (headTargets.length > 0) registry.recordWorktreeHeads(heads);

  for (const t of queryable) {
    const r = results.get(t.cwd);
    if (r === "error") skip.add(t.id);
    else if (r) {
      found.set(t.id, {
        ...r,
        branch: t.branch as string,
        agentSessionId: t.agentSessionId,
        episodeId: t.episodeId,
      });
    }
    // r === null (no open/merged PR) -> omitted from both -> reconcile clears the chip
  }
  for (const t of repoQueryable) {
    const r = results.get(t.cwd);
    if (r === "error") repoSkip.add(t.key);
    else if (r) {
      repoFound.set(t.key, {
        ...r,
        branch: t.branch,
        agentSessionId: t.agentSessionId,
        episodeId: t.episodeId,
      });
    }
  }
  const observed = new Map(
    [...found.values(), ...repoFound.values()].map((match) => [match.url, match]),
  );
  const mergedUrls = new Map<string, number>();
  // The branch each of those merged into, which decides whether a task with a base branch landed.
  const mergedBases = new Map<string, string | null>();
  const closedUrls = new Set<string>();
  const urlResults = new Map<string, PrStateMatch>();
  const dueUrls = urlState.due(linkedUrls, now);
  for (const url of linkedUrls) {
    const match = observed.get(url);
    if (!match) continue;
    if (match.state === "merged" && match.mergedAt !== null) {
      mergedUrls.set(url, match.mergedAt);
      mergedBases.set(url, match.baseRef ?? null);
    }
  }
  await forEachConcurrent(
    dueUrls.filter((url) => !observed.has(url)),
    PR_URL_CONCURRENCY,
    async (url) => {
      const result = await lookupUrl(url);
      urlState.record(url, result, now);
      if (result !== "error" && result !== null) urlResults.set(url, result);
      if (result !== "error" && result?.state === "merged" && result.mergedAt !== null) {
        mergedUrls.set(url, result.mergedAt);
        mergedBases.set(url, result.baseRef ?? null);
      }
      // Read from the URL itself, which is the only place a closed, unmerged state survives:
      // the branch lookup drops it, and the URL is asked about here precisely because the
      // branch lookup no longer observes an open PR for it.
      if (result !== "error" && result?.state === "closed") closedUrls.add(url);
    },
  );
  registry.reconcilePrs(found, skip);
  // After the session pass, and deliberately: `reconcilePrs` can settle a task through the
  // primary's merge, and the per-repo pass then has the task's own row already up to date.
  registry.reconcileRepoPrs(repoFound, repoSkip);
  // Mergeability only, onto every snapshot that names one of these pull requests. After both
  // branch passes, so a by-URL read never races the branch poller's own answer for the same
  // session, and with no authority over `prState` or completion - those stay below.
  registry.reconcilePrUrlMergeability(
    new Map(
      [...urlResults].map(([url, r]) => [
        url,
        {
          open: r.state === "open",
          mergeable: r.mergeable ?? null,
          baseRef: r.baseRef ?? null,
          headSha: r.headSha ?? null,
        },
      ]),
    ),
  );
  // FILTERED to the operational harvest. Existing behaviour is byte-identical for every URL
  // that was already eligible, and a telemetry-only URL cannot enter `mergedPrFor`, complete
  // a task or satisfy a dependency edge by having been polled on the same tick. A URL that
  // carries BOTH reasons is in this set, so its operational reconciliation runs exactly as
  // it did before, under its own eligibility and selection-time rules.
  const operationalMerges = new Map(
    [...mergedUrls].filter(([url]) => operationalUrls.has(url)),
  );
  registry.reconcilePrMerges(operationalMerges, mergedBases);
  // Closures carry no completion authority, but they do move task state (a pending shape
  // choice lapses), so they take the same operational filter as merges.
  registry.reconcilePrClosures(new Set([...closedUrls].filter((url) => operationalUrls.has(url))));
  // And the observation-only half, which has authority over nothing. It emits the verified
  // late-delivery fact and stamps the retained row, carrying the attribution frozen when the
  // pull request was first associated rather than whatever the task is bound to today.
  // Delivery is resolved against each observation's current task/session/repository binding.
  // A URL can remain operational for another task or a dependency after this author lost it.
  recordTelemetryPrMerges(mergedUrls, undefined, now);
  // Last, once every snapshot above has moved: the episodes read who references each PR.
  conflicts?.reconcile(conflictReads(observed, urlResults), now);
}

/**
 * Every read this tick made, from either path, as the conflict episodes take it. A read's
 * mergeability goes through the one reading rule, so it answers only for the head it names.
 */
function conflictReads(
  branch: ReadonlyMap<string, PrMatch>,
  byUrl: ReadonlyMap<string, PrStateMatch>,
): Map<string, ConflictObservation> {
  const reads = new Map<string, ConflictObservation>();
  const add = (url: string, state: ConflictObservation["state"], r: {
    mergeable?: PrMergeable | null;
    baseRef?: string | null;
    headSha?: string | null;
  }): void => {
    const read = {
      open: state === "open",
      mergeable: r.mergeable ?? null,
      baseRef: r.baseRef ?? null,
      headSha: r.headSha ?? null,
    };
    reads.set(url, {
      state,
      mergeable: currentMergeability(nextMergeability(null, read)),
      baseRef: read.baseRef,
      headSha: read.headSha,
    });
  };
  for (const [url, r] of byUrl) add(url, r.state, r);
  for (const [url, match] of branch) add(url, match.state, match);
  return reads;
}

/**
 * Re-derive the blocked pull requests whenever a workflow run changes. A run moving past its
 * last Wait for CI, or finishing, changes whether its workflow still handles a conflict, and
 * that must not wait for the next poll. Returns the unsubscribe.
 */
export function reclassifyOnWorkflowRunChange(
  registry: Pick<Registry, "subscribe">,
  conflicts: Pick<PrConflictTracker, "reclassify">,
): () => void {
  return registry.subscribe((event) => {
    if (event.type === "workflow_run_upsert" || event.type === "workflow_run_remove") {
      conflicts.reclassify();
    }
  });
}

/**
 * Drive PR reconciliation on an interval. Ticks never overlap; a slow sweep just
 * delays the next. A no-op (no subprocesses) whenever no session sits on a
 * feature branch and no dependency or task binding contributes a URL.
 */
export function startPrPoller(
  registry: Registry,
  conflicts: PrConflictTracker,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const urlState = new PrUrlPollState();
  const unsubscribe = reclassifyOnWorkflowRunChange(registry, conflicts);

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await pollAndReconcilePrs(
        registry,
        queryPr,
        queryPrUrl,
        urlState,
        Date.now(),
        queryHead,
        null,
        conflicts,
      );
    } catch (err) {
      console.error("[pr] poll failed:", err);
    }
    if (stopped) return;
    timer = unref(setTimeout(tick, PR_POLL_MS));
  };

  void tick();
  return () => {
    stopped = true;
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
