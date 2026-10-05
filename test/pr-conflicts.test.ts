import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlockedPr, ServerEvent } from "../src/shared/types.ts";

// Isolate the daemon's SQLite DB before anything reads config/db.
process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "harness-pr-conflicts-"));
const { Registry } = await import("../src/server/registry.ts");
const { pollAndReconcilePrs, PrUrlPollState } = await import("../src/server/pr.ts");
const { PrConflictEpisodes, PrConflictTracker, unhandledReason } = await import(
  "../src/server/pr-conflicts.ts"
);
const { ForemanConfigSchema } = await import("../src/shared/protocol.ts");
const { mkSession } = await import("./helpers/session-fixture.ts");

const PR = "https://github.com/o/r/pull/42";

const conflicting = (headSha: string, baseRef = "main") =>
  ({ state: "open", mergeable: "conflicting", baseRef, headSha }) as const;

/** Foreman live in the fixture session's repository: everything that lets it drive. */
const LIVE = ForemanConfigSchema.parse({
  enabled: true,
  mode: "live",
  repoAllowlist: ["/wt"],
});

const policy = (over: Partial<typeof LIVE> = {}, workflowOwns = false) => ({
  foreman: { ...LIVE, ...over },
  workflowOwns: () => workflowOwns,
});

test("an episode opens on the first conflicting read and closes on mergeable, merged or closed", () => {
  for (const end of [
    { state: "open", mergeable: "mergeable", baseRef: "main", headSha: "A" },
    { state: "merged", mergeable: null, baseRef: "main", headSha: "A" },
    { state: "closed", mergeable: null, baseRef: "main", headSha: "A" },
  ] as const) {
    const episodes = new PrConflictEpisodes();
    episodes.observe(PR, { state: "open", mergeable: "mergeable", baseRef: "main", headSha: "A" }, 1);
    assert.deepEqual(episodes.list(), [], "a mergeable PR opens nothing");

    episodes.observe(PR, conflicting("A"), 5);
    assert.deepEqual(episodes.list(), [{ url: PR, since: 5, baseRef: "main", headSha: "A" }]);

    episodes.observe(PR, end, 9);
    assert.deepEqual(episodes.list(), [], `${end.state} ${end.mergeable} closes it`);
  }
});

test("an unknown current head leaves an open episode as it is", () => {
  const episodes = new PrConflictEpisodes();
  episodes.observe(PR, conflicting("A"), 5);
  episodes.observe(PR, { state: "open", mergeable: null, baseRef: "main", headSha: "B" }, 9);
  assert.deepEqual(episodes.list(), [{ url: PR, since: 5, baseRef: "main", headSha: "A" }]);

  const none = new PrConflictEpisodes();
  none.observe(PR, { state: "open", mergeable: null, baseRef: "main", headSha: "B" }, 9);
  assert.deepEqual(none.list(), [], "and opens nothing");
});

test("headSha advances on each new conflicting head without opening a new episode", () => {
  const episodes = new PrConflictEpisodes();
  episodes.observe(PR, conflicting("A"), 5);
  episodes.observe(PR, conflicting("B", "develop"), 9);
  episodes.observe(PR, conflicting("C", "develop"), 12);
  assert.deepEqual(episodes.list(), [{ url: PR, since: 5, baseRef: "develop", headSha: "C" }]);
});

test("an episode closes once no session and no task reference its PR", () => {
  const episodes = new PrConflictEpisodes();
  episodes.observe(PR, conflicting("A"), 5);
  episodes.retain((url) => url === PR);
  assert.deepEqual(episodes.urls(), [PR]);
  episodes.retain(() => false);
  assert.deepEqual(episodes.urls(), []);
});

test("session-gone: no live session owns the PR", () => {
  assert.equal(unhandledReason(null, policy()), "session-gone");
});

test("foreman-cannot-nudge covers every case Foreman's follow-through refuses to type", () => {
  const live = mkSession({ cwd: "/wt/app", state: "idle" });
  assert.equal(unhandledReason(live, policy()), null, "Foreman drives this one");
  const cases: Array<[string, ReturnType<typeof mkSession>, ReturnType<typeof policy>]> = [
    ["trackMergeConflicts off", live, policy({ trackMergeConflicts: false })],
    ["not invited", { ...live, foremanInvite: null }, policy()],
    ["dry-run", live, policy({ mode: "dry-run" })],
    ["Foreman off", live, policy({ enabled: false })],
    ["not allowlisted", { ...live, cwd: "/elsewhere" }, policy()],
    ["no hooks", { ...live, hooksSeen: false }, policy()],
  ];
  for (const [why, session, p] of cases) {
    assert.equal(unhandledReason(session, p), "foreman-cannot-nudge", why);
  }
});

test("a session an active workflow owns is not reported here", () => {
  const live = mkSession({ cwd: "/wt/app", state: "idle", foremanInvite: null });
  assert.equal(unhandledReason(live, policy({}, true)), null);
});

/** A PR poll against a real registry, with `gh` stood in for. */
function harness() {
  const reg = new Registry();
  reg.applyDiscovery([
    {
      syntheticId: "live",
      agent: "claude",
      name: "the agent",
      nameSource: "process",
      cwd: "/wt/app",
      gitBranch: "feat/x",
      gitRoot: null,
      repoRoot: null,
      pid: 1,
      tty: null,
      terminals: [],
      startedAt: 0,
    },
  ]);
  const frames: BlockedPr[][] = [];
  reg.subscribe((e: ServerEvent) => {
    if (e.type === "blocked_prs") frames.push(e.prs);
  });
  const tracker = new PrConflictTracker(reg, () => LIVE);
  const urlState = new PrUrlPollState();
  let branchRead: "conflicting" | "mergeable" = "conflicting";
  type UrlRead = { state: "open" | "merged"; mergeable: "conflicting" | "mergeable" };
  let urlRead: UrlRead = { state: "open", mergeable: "conflicting" };
  const askedByUrl: string[] = [];
  const operational: string[][] = [];
  const realMerges = reg.reconcilePrMerges.bind(reg);
  reg.reconcilePrMerges = (merged: Map<string, number>) => {
    operational.push([...merged.keys()]);
    realMerges(merged);
  };
  let now = 1_000_000;
  const poll = () =>
    pollAndReconcilePrs(
      reg,
      async () => ({
        url: PR,
        number: 42,
        state: "open" as const,
        checks: null,
        createdAt: 1,
        mergedAt: null,
        headSha: "A",
        worktreeHeadSha: "A",
        mergeable: branchRead,
        baseRef: "main",
      }),
      async (url) => {
        askedByUrl.push(url);
        return {
          state: urlRead.state,
          mergedAt: urlRead.state === "merged" ? 7 : null,
          mergeable: urlRead.mergeable,
          baseRef: "main",
          headSha: "B",
        };
      },
      urlState,
      (now += 10 * 60_000),
      async () => null,
      () => [],
      tracker,
    );
  return {
    reg,
    frames,
    tracker,
    askedByUrl,
    operational,
    poll,
    setBranch: (v: typeof branchRead) => (branchRead = v),
    setUrl: (v: UrlRead) => (urlRead = v),
  };
}

test("blocked_prs is emitted only when the blocked set changes", async () => {
  const h = harness();
  await h.poll();
  assert.equal(h.frames.length, 1);
  assert.equal(h.frames[0]![0]!.reason, "foreman-cannot-nudge", "discovered sessions are uninvited");
  assert.equal(h.frames[0]![0]!.repo, "o/r");
  assert.equal(h.frames[0]![0]!.baseRef, "main");
  assert.deepEqual(h.reg.snapshot().blockedPrs, h.frames[0], "and it rides the snapshot");

  await h.poll();
  await h.poll();
  assert.equal(h.frames.length, 1, "the same set is not re-sent");

  h.setBranch("mergeable");
  await h.poll();
  assert.deepEqual(h.frames.at(-1), [], "the fix clears it");
  assert.equal(h.frames.length, 2);
});

test("an open episode keeps an exited task-less session's PR on the by-URL poller, never as operational", async () => {
  const h = harness();
  await h.poll();
  assert.deepEqual(h.askedByUrl, [], "the branch poller answers for a live session");

  // The session exits. No task names the PR, so only the open episode keeps it polled.
  h.reg.applyDiscovery([]);
  assert.equal(h.reg.getSession("live")!.state, "exited");
  // GitHub answers "merged": were the episode's URL operational, the merge would reach
  // `reconcilePrMerges`. It must not.
  h.setUrl({ state: "merged", mergeable: "conflicting" });
  await h.poll();
  assert.deepEqual(h.askedByUrl, [PR], "the episode's URL is harvested");
  assert.deepEqual(h.operational.at(-1), [], "but gains no merge-completion authority");
});

test("an exited session's conflict reads session-gone and clears when the PR is mergeable", async () => {
  const h = harness();
  await h.poll();
  h.reg.applyDiscovery([]);
  await h.poll();
  const row = h.frames.at(-1)![0]!;
  assert.equal(row.reason, "session-gone");
  assert.equal(row.headSha, "B", "the latest conflicting head, from the by-URL read");
  assert.equal(row.sessionName, "the agent", "the exited session still names the row");
  assert.equal(h.frames.length, 2, "a reason change is one frame");

  h.setUrl({ state: "open", mergeable: "mergeable" });
  await h.poll();
  assert.deepEqual(h.frames.at(-1), []);
  assert.deepEqual(h.tracker.episodes.urls(), [], "and its PR leaves the harvest");
  const asked = h.askedByUrl.length;
  await h.poll();
  assert.equal(h.askedByUrl.length, asked, "nothing asks about it any more");
});
