import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import { trackedTaskManagers } from "./helpers/task-manager.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { Task } from "../src/shared/types.ts";
// Pure and browser-safe, so a static import cannot open the DB ahead of the home below.
import { movableBaseBranch } from "../src/shared/task.ts";

// Moving an in-flight task's base branch to where its base branch merged (#771). Every fixture
// is a stack: `feat/base` cut from `main`, and the task's worktree `feat/stacked` cut from
// `feat/base`. Then `feat/base` merges into `main` from another clone and is deleted on origin,
// which is exactly the state a stacked task is stranded in. Origin also carries `feat/mid`, a
// non-default branch a base can merge into instead.

const home = mkdtempSync(join(tmpdir(), "mission-base-move-home-"));
const repos = mkdtempSync(join(tmpdir(), "mission-base-move-repos-"));
const bin = mkdtempSync(join(tmpdir(), "mission-base-move-bin-"));
process.env.HARNESS_HOME = home;
process.env.HARNESS_WORKSPACE_DIRS = repos;
// `gh` answers `pr list` with whatever `gh-prs.json` holds, fails when `gh-fail` exists, and
// records every argv to `gh-calls`.
writeFileSync(join(bin, "gh"), [
  "#!/bin/sh",
  `echo "$@" >> "${bin}/gh-calls"`,
  `if [ -f "${bin}/gh-fail" ]; then echo "gh: not logged in" >&2; exit 1; fi`,
  `cat "${bin}/gh-prs.json"`,
  "",
].join("\n"));
chmodSync(join(bin, "gh"), 0o755);
process.env.MISSION_GH_BIN = join(bin, "gh");

const { openDb, getTask, taskWorkEpisodeForTask } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const taskManager = trackedTaskManagers(TaskManager);
const { buildApp } = await import("../src/server/routes.ts");
const { pollAndReconcilePrs } = await import("../src/server/pr.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { changedPathsSince, computeSessionDiff } = await import("../src/server/diff.ts");
const { withTaskKindContract } = await import("../src/server/task-contract.ts");
const { renderSessionAction } = await import("../src/server/workflows/feedback.ts");
const { prBaseBranchFor } = await import("../src/server/workflows/context.ts");
const SELECTABLE_WORKFLOWS = {
  workflowSelectionBlock: () => null,
  localPlanPublication: () => null,
} as unknown as import("../src/server/workflows/manager.ts").WorkflowManager;

after(() => {
  for (const dir of [home, repos, bin]) rmSync(dir, { recursive: true, force: true });
  delete process.env.MISSION_GH_BIN;
});

beforeEach(() => {
  openDb().exec("DELETE FROM tasks;");
  rmSync(join(bin, "gh-fail"), { force: true });
  rmSync(join(bin, "gh-calls"), { force: true });
  ghReports([]);
});

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@test", "-c", "user.name=t", ...args], { stdio: "pipe" })
    .toString()
    .trim();

function ghReports(
  prs: Array<{ url: string; state: string; mergedAt: string | null; baseRefName: string | null; headRefOid?: string }>,
): void {
  writeFileSync(join(bin, "gh-prs.json"), JSON.stringify(prs));
}

const ghCalls = (): string[] =>
  existsSync(join(bin, "gh-calls")) ? readFileSync(join(bin, "gh-calls"), "utf8").trim().split("\n") : [];

const BASE_PR = "https://github.com/mc-test/stack/pull/7";

/**
 * The stranded stack. `origin` reads as a GitHub repository, so `gh` gets a `--repo`, while
 * `insteadOf` sends git's own traffic to the bare repository. The checkout's `origin/main` is
 * left behind the merge, so measuring from it proves the move fetched.
 */
interface StackShape {
  /**
   * How `feat/base` landed in `main`: a merge commit, a squash that leaves its tip outside, or
   * not at all (abandoned, its pull request closed unmerged).
   */
  landing?: "merge" | "squash" | "none";
  /** Leave `feat/base` on origin after it landed, as a long-lived branch would be. */
  keepBase?: boolean;
  /** Then push one more commit to the kept `feat/base`: work `main` does not have. */
  advanceBase?: boolean;
}

function strandedStack(
  name: string,
  { landing = "merge", keepBase = false, advanceBase = false }: StackShape = {},
): { repo: string; wt: string; mergedHead: string } {
  const repo = join(repos, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "file.txt"), "main\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "main");
  const origin = join(repos, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  const url = `https://github.com/mc-test/${name}.git`;
  git(repo, "config", `url.${origin}.insteadOf`, url);
  git(repo, "remote", "add", "origin", url);
  git(repo, "push", "-qu", "origin", "main");
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  git(repo, "push", "-q", "origin", "main:refs/heads/feat/mid");
  git(repo, "checkout", "-qb", "feat/base");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "push", "-q", "origin", "feat/base");
  git(repo, "checkout", "-q", "main");
  git(repo, "fetch", "-q", "origin");
  git(repo, "remote", "set-head", "origin", "main");

  const wt = join(repos, `${name}-wt`);
  git(repo, "worktree", "add", "-q", "-b", "feat/stacked", wt, "origin/feat/base");
  writeFileSync(join(wt, "stacked.txt"), "stacked\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", "stacked");

  // `feat/base`'s pull request merges into `main` elsewhere, and by default its branch is deleted.
  const other = join(repos, `${name}-other`);
  execFileSync("git", ["clone", "-q", origin, other]);
  git(other, "fetch", "-q", "origin", "feat/base");
  const mergedHead = git(other, "rev-parse", "FETCH_HEAD");
  if (landing === "merge") {
    git(other, "merge", "-q", "--no-ff", "-m", "Merge feat/base", "FETCH_HEAD");
  } else if (landing === "squash") {
    git(other, "merge", "-q", "--squash", "FETCH_HEAD");
    git(other, "commit", "-qm", "Squashed feat/base");
  }
  git(other, "push", "-q", "origin", "main");
  if (!keepBase) {
    git(other, "push", "-q", "origin", ":feat/base");
    git(repo, "update-ref", "-d", "refs/remotes/origin/feat/base");
  } else if (advanceBase) {
    git(other, "checkout", "-qb", "feat/base", "FETCH_HEAD");
    writeFileSync(join(other, "later.txt"), "after the merge\n");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "later work on the base");
    git(other, "push", "-q", "origin", "feat/base");
  }
  return { repo: realpathSync(repo), wt: realpathSync(wt), mergedHead };
}

function baseMerged(baseRefName: string | null = "main", headRefOid?: string): void {
  ghReports([
    { url: BASE_PR, state: "MERGED", mergedAt: "2026-11-01T10:00:00Z", baseRefName, ...(headRefOid ? { headRefOid } : {}) },
  ]);
}

function appFor(registry = new Registry()) {
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager, workflows: SELECTABLE_WORKFLOWS });
  const move = (id: string) => app.request(`/api/tasks/${encodeURIComponent(id)}/base-branch/move`, {
    method: "POST",
    headers: { host: "127.0.0.1:7317" },
  });
  const get = (path: string) => app.request(path, { headers: { host: "127.0.0.1:7317" } });
  return { app, move, get, registry, tasks };
}

/** A running task on `feat/base` whose session stands in the stacked worktree. */
function runningStack(name: string, shape: StackShape = {}) {
  const { repo, wt, mergedHead } = strandedStack(name, shape);
  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: name, agent: "claude", name, nameSource: "process", cwd: wt,
    gitBranch: "feat/stacked", gitRoot: wt, repoRoot: repo, pid: 301, tty: null, terminals: [], startedAt: Date.now(),
  }]);
  const session = registry.snapshot().sessions.find((s) => s.name === name)!;
  registry.upsertTask(mkTask({
    id: `task-${name}`, kind: "ship", status: "running", repoRoot: repo, baseBranch: "feat/base",
    sessionId: session.id, worktreePath: wt, branch: "feat/stacked", baseSha: mergedHead,
  }));
  return { repo, wt, mergedHead, session, taskId: `task-${name}`, ...appFor(registry) };
}

test("a stacked task's base moves to where its base branch merged, and is recorded on the task", async () => {
  const f = runningStack("moves");
  baseMerged("main", f.mergedHead);
  const res = await f.move(f.taskId);
  assert.equal(res.status, 200, await res.clone().text());
  const moved = (await res.json()) as Task;
  assert.equal(moved.baseBranch, "main", "the target is stored by name, origin's default included");
  assert.deepEqual(
    { ...moved.baseBranchMove, movedAt: 0 },
    { from: "feat/base", to: "main", toDefault: true, toSha: git(f.repo, "rev-parse", "origin/main"), prUrl: BASE_PR, movedAt: 0 },
  );
  const stored = getTask(f.taskId)!;
  assert.equal(stored.baseBranch, "main");
  assert.deepEqual(stored.baseBranchMove, moved.baseBranchMove, "the move is persisted on the row");
  assert.equal(f.registry.getTask(f.taskId)?.status, "running", "nothing else about the task changes");
  // `gh` was asked about the base branch's own merged pull requests, on the GitHub repository.
  assert.match(ghCalls().join("\n"), /pr list --repo mc-test\/moves --head feat\/base --state merged/);
  // The session card carries it, for the footer's control.
  const card = f.registry.snapshot().sessions.find((s) => s.id === f.session.id)!;
  assert.equal(card.task?.baseBranch, "main");
  assert.equal(card.task?.baseBranchMove?.toDefault, true);
});

test("a move onto a non-default branch stores it as not the default, so the base can move again", async () => {
  const f = runningStack("onto-mid");
  baseMerged("feat/mid", f.mergedHead);
  const res = await f.move(f.taskId);
  assert.equal(res.status, 200, await res.clone().text());
  const moved = getTask(f.taskId)!;
  assert.equal(moved.baseBranch, "feat/mid");
  assert.equal(moved.baseBranchMove?.to, "feat/mid");
  assert.equal(moved.baseBranchMove?.toDefault, false, "feat/mid is not origin's default");
  const card = f.registry.snapshot().sessions.find((s) => s.id === f.session.id)!;
  assert.equal(card.task?.baseBranch, "feat/mid");
  assert.equal(card.task?.baseBranchMove?.toDefault, false);
});

test("a cancelled or failed task, which a merge can still complete, may move its base", async () => {
  const f = runningStack("stopped");
  baseMerged("main", f.mergedHead);
  for (const status of ["cancelled", "failed"] as const) {
    const id = `stopped-${status}`;
    f.registry.upsertTask(mkTask({ id, status, repoRoot: f.repo, baseBranch: "feat/base", baseSha: f.mergedHead }));
    const res = await f.move(id);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(getTask(id)?.baseBranch, "main");
    assert.equal(getTask(id)?.status, status, "the move does not change the task's status");
  }
});

test("of several merged pull requests on the base branch, the newest decides the target", async () => {
  const f = runningStack("newest");
  const older = "https://github.com/mc-test/newest/pull/3";
  // Listed oldest first, so taking the first or last row as given would pick the wrong one.
  ghReports([
    { url: older, state: "MERGED", mergedAt: "2026-10-01T10:00:00Z", baseRefName: "main" },
    { url: BASE_PR, state: "MERGED", mergedAt: "2026-11-01T10:00:00Z", baseRefName: "feat/mid", headRefOid: f.mergedHead },
  ]);
  const res = await f.move(f.taskId);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(getTask(f.taskId)?.baseBranch, "feat/mid");
  assert.equal(getTask(f.taskId)?.baseBranchMove?.prUrl, BASE_PR);
});

test("a move whose origin fetch fails is refused with nothing written", async () => {
  const f = runningStack("unfetched");
  baseMerged("main", f.mergedHead);
  const fetched: string[] = [];
  const res = await f.tasks.moveBaseBranch(f.taskId, {
    fetch: async (root) => {
      fetched.push(root);
      return { ok: false, reason: "git fetch origin failed: could not resolve host", outcomeUnknown: false };
    },
  });
  assert.deepEqual(fetched, [f.repo], "the target resolved, so the fetch was reached");
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.status, 502);
  assert.equal(!res.ok && res.error, "could not fetch origin: git fetch origin failed: could not resolve host");
  assert.equal(getTask(f.taskId)?.baseBranch, "feat/base");
  assert.equal(getTask(f.taskId)?.baseBranchMove, null);
});

// --- the base has to have landed, not just share a name with a merged pull request ---

test("a base still on origin moves once its tip is in the target", async () => {
  const f = runningStack("kept-merged", { keepBase: true });
  baseMerged("main", f.mergedHead);
  const res = await f.move(f.taskId);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(getTask(f.taskId)?.baseBranch, "main");
});

test("a squash-merged base still on origin moves while its tip is the merged pull request's head", async () => {
  const f = runningStack("kept-squashed", { landing: "squash", keepBase: true });
  // A squash leaves the base's tip outside `main`, so only the pull request's head vouches for it.
  baseMerged("main", "f".repeat(40));
  const unvouched = await f.move(f.taskId);
  assert.equal(unvouched.status, 409, await unvouched.clone().text());
  baseMerged("main", f.mergedHead);
  const res = await f.move(f.taskId);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(getTask(f.taskId)?.baseBranch, "main");
});

test("a base with work newer than its merged pull request is refused, as a long-lived branch would be", async () => {
  const f = runningStack("moved-on", { keepBase: true, advanceBase: true });
  // `feat/base` merged into `main` once, like a `develop` release, and has moved on since.
  baseMerged("main", f.mergedHead);
  const res = await f.move(f.taskId);
  assert.equal(res.status, 409, await res.clone().text());
  assert.equal(
    ((await res.json()) as { error: string }).error,
    `base branch feat/base has moved on since ${BASE_PR} merged it into main, so it has not landed there`,
  );
  assert.equal(getTask(f.taskId)?.baseBranch, "feat/base");
  assert.equal(getTask(f.taskId)?.baseBranchMove, null);
});

test("a base deleted unmerged is not moved by an older merged pull request on the same branch name", async () => {
  const f = runningStack("reused-name", { landing: "none" });
  // Months ago an earlier `feat/base` merged into `feat/mid`. Its head predates this task's
  // `feat/base`, which was abandoned and deleted without merging.
  const earlierHead = git(f.repo, "rev-parse", "main");
  const refused = async (pattern: RegExp) => {
    const res = await f.move(f.taskId);
    assert.equal(res.status, 409, await res.clone().text());
    assert.match(((await res.json()) as { error: string }).error, pattern);
    assert.equal(getTask(f.taskId)?.baseBranch, "feat/base");
    assert.equal(getTask(f.taskId)?.baseBranchMove, null);
  };
  baseMerged("feat/mid", earlierHead);
  await refused(/^https:\/\/github\.com\/mc-test\/stack\/pull\/7 does not carry the feat\/base this task was stacked on/);
  // A head nobody can produce, even fetched by id, is not evidence either.
  baseMerged("feat/mid", "e".repeat(40));
  await refused(/does not carry the feat\/base this task was stacked on/);
  // Nor is any pull request, for a task that recorded no start commit to compare.
  f.registry.upsertTask({ ...f.registry.getTask(f.taskId)!, baseSha: null });
  baseMerged("feat/mid", f.mergedHead);
  await refused(/this task recorded no start commit, so .* cannot be confirmed as its base branch's merge/);
});

test("a squash-merged stack of three is walked down one merge at a time", async () => {
  // main <- feat/mid <- feat/base <- the task, each hop landing by squash and its branch deleted.
  const name = "walk-down";
  const repo = join(repos, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "file.txt"), "main\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "main");
  const origin = join(repos, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  git(repo, "config", `url.${origin}.insteadOf`, `https://github.com/mc-test/${name}.git`);
  git(repo, "remote", "add", "origin", `https://github.com/mc-test/${name}.git`);
  git(repo, "push", "-qu", "origin", "main");
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  const commitOn = (branch: string, from: string, file: string) => {
    git(repo, "checkout", "-qb", branch, from);
    writeFileSync(join(repo, file), `${branch}\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", branch);
    git(repo, "push", "-q", "origin", branch);
    return git(repo, "rev-parse", "HEAD");
  };
  const midTip = commitOn("feat/mid", "main", "mid.txt");
  const baseTip = commitOn("feat/base", "feat/mid", "base.txt");
  git(repo, "checkout", "-q", "main");
  git(repo, "fetch", "-q", "origin");
  git(repo, "remote", "set-head", "origin", "main");
  const other = join(repos, `${name}-other`);
  execFileSync("git", ["clone", "-q", origin, other]);
  /** Squash `head` into `into` on origin and delete `head`, returning the head that merged. */
  const squash = (head: string, into: string): string => {
    git(other, "fetch", "-q", "origin");
    git(other, "checkout", "-qB", into, `origin/${into}`);
    const merged = git(other, "rev-parse", `origin/${head}`);
    git(other, "merge", "-q", "--squash", `origin/${head}`);
    git(other, "commit", "-qm", `Squashed ${head}`);
    git(other, "push", "-q", "origin", into, `:${head}`);
    return merged;
  };

  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "walker", status: "running", repoRoot: realpathSync(repo), baseBranch: "feat/base", baseSha: baseTip }));
  const { move } = appFor(registry);
  const hop = async (head: string, into: string, url: string) => {
    ghReports([{ url, state: "MERGED", mergedAt: "2026-11-01T10:00:00Z", baseRefName: into, headRefOid: squash(head, into) }]);
    const res = await move("walker");
    assert.equal(res.status, 200, await res.clone().text());
    return getTask("walker")!;
  };

  const first = await hop("feat/base", "feat/mid", "https://github.com/mc-test/walk-down/pull/7");
  assert.equal(first.baseBranch, "feat/mid");
  assert.equal(first.baseBranchMove?.toSha, git(repo, "rev-parse", "origin/feat/mid"), "the squash commit anchors the next move");
  assert.equal(first.baseSha, baseTip, "the dispatch start commit is left as it was");
  // An older feat/mid pull request, from before feat/base landed in it, predates the anchor.
  ghReports([{
    url: "https://github.com/mc-test/walk-down/pull/2", state: "MERGED", mergedAt: "2026-10-01T10:00:00Z",
    baseRefName: "main", headRefOid: midTip,
  }]);
  const stale = await move("walker");
  assert.equal(stale.status, 409, await stale.clone().text());
  assert.match(((await stale.json()) as { error: string }).error, /pull\/2 does not carry the feat\/mid this task was stacked on/);
  assert.equal(getTask("walker")?.baseBranch, "feat/mid");
  // feat/mid's own pull request carries the squash of feat/base, never `baseTip` itself.
  const second = await hop("feat/mid", "main", "https://github.com/mc-test/walk-down/pull/8");
  assert.equal(second.baseBranch, "main");
  assert.deepEqual(
    { ...second.baseBranchMove, movedAt: 0 },
    {
      from: "feat/mid", to: "main", toDefault: true, toSha: git(repo, "rev-parse", "origin/main"),
      prUrl: "https://github.com/mc-test/walk-down/pull/8", movedAt: 0,
    },
  );
});

// --- the footer's offer ---

test("the footer offers a move for the base the task has now, not for a stale move record", () => {
  const ontoMain = { from: "feat/base", to: "main", toDefault: true, toSha: "c".repeat(40), prUrl: BASE_PR, movedAt: 1 };
  assert.equal(movableBaseBranch({ status: "running", baseBranch: "feat/base", baseBranchMove: null }), "feat/base");
  assert.equal(movableBaseBranch({ status: "failed", baseBranch: "feat/base" }), "feat/base");
  assert.equal(movableBaseBranch({ status: "running", baseBranch: "main", baseBranchMove: ontoMain }), null, "already on the default");
  // Moved onto `main`, sent back, edited onto a new stacked base and dispatched again.
  assert.equal(movableBaseBranch({ status: "running", baseBranch: "feat/other", baseBranchMove: ontoMain }), "feat/other");
  assert.equal(
    movableBaseBranch({ status: "running", baseBranch: "feat/mid", baseBranchMove: { ...ontoMain, to: "feat/mid", toDefault: false } }),
    "feat/mid",
    "a move onto a non-default branch can be followed again",
  );
  for (const status of ["backlog", "dispatching", "done"] as const) {
    assert.equal(movableBaseBranch({ status, baseBranch: "feat/base" }), null, status);
  }
  assert.equal(movableBaseBranch({ status: "running", baseBranch: null }), null);
});

test("after the move the Diff view, evidence diff and affected-tests base measure from the new base, though the old branch is gone", async () => {
  const f = runningStack("measures");
  const diffOf = async () => (await (await f.get(`/api/sessions/${f.session.id}/diff`)).json()) as {
    ok: boolean; base: string | null; filesChanged: number; patch: string; error: string | null;
  };
  const before = await diffOf();
  assert.equal(before.ok, false, "the deleted base fails rather than falling back");
  assert.match(before.error ?? "", /feat\/base is not in this repository's remote-tracking refs/);

  baseMerged("main", f.mergedHead);
  assert.equal((await f.move(f.taskId)).status, 200);

  const after = await diffOf();
  assert.equal(after.ok, true, after.error ?? "");
  assert.equal(after.base, "main");
  assert.equal(after.filesChanged, 1, "the merged base's own change is not this task's");
  assert.match(after.patch, /stacked\.txt/);
  assert.doesNotMatch(after.patch, /base\.txt/);

  // The two followers read the same base, through the binding's own resolution.
  const base = prBaseBranchFor(getTask(f.taskId)!, "");
  assert.equal(base, "main");
  const evidence = await computeSessionDiff(f.wt, undefined, base);
  assert.equal(evidence.ok && evidence.filesChanged, 1);
  assert.deepEqual(await changedPathsSince(f.wt, base), { ok: true, repoRoot: f.wt, paths: ["stacked.txt"] });
});

test("after the move resets, the task contract and the Pull Request action name the new base", async () => {
  const f = runningStack("names");
  baseMerged("main", f.mergedHead);
  assert.equal((await f.move(f.taskId)).status, 200);
  const moved = getTask(f.taskId)!;

  const preview = (await (await f.get(`/api/sessions/${f.session.id}/reset/preview`)).json()) as {
    ok: boolean; target: string | null; error: string | null;
  };
  assert.equal(preview.ok, true, preview.error ?? "");
  assert.equal(preview.target, "origin/main");

  assert.match(withTaskKindContract(moved, "Build it"), /This task's base branch is `main`/);
  const action = renderSessionAction({
    origin: { kind: "run", workflowName: "Review", workflowVersion: 1, runId: "run-1", repoRoot: null },
    actionName: "Pull Request", promptMarkdown: "Open the PR.", skillCommand: null,
    workflowEvidence: false, pullRequestGrant: true, baseBranch: prBaseBranchFor(moved, ""),
  });
  assert.ok(action.ok);
  assert.match(action.payload, /Base branch: main /);
  assert.match(action.payload, /-f base=main /);
});

test("a move is refused, with nothing written, unless the task is in flight on a base whose pull request merged", async () => {
  const f = runningStack("refusals");
  const refusal = async (id: string, status: number, pattern: RegExp) => {
    const res = await f.move(id);
    assert.equal(res.status, status, await res.clone().text());
    assert.match(((await res.json()) as { error: string }).error, pattern);
  };

  await refusal("no-such-task", 404, /no such task/);
  await refusal(f.taskId, 409, /feat\/base has no merged pull request/);
  ghReports([{ url: BASE_PR, state: "OPEN", mergedAt: null, baseRefName: "main" }]);
  await refusal(f.taskId, 409, /no merged pull request/);
  writeFileSync(join(bin, "gh-fail"), "");
  await refusal(f.taskId, 502, /could not ask GitHub for feat\/base's pull request: gh: not logged in/);
  rmSync(join(bin, "gh-fail"));
  baseMerged(null);
  await refusal(f.taskId, 502, /did not say which branch .* merged into/);
  baseMerged("release/gone");
  await refusal(f.taskId, 409, /base branch release\/gone does not exist on .*'s origin/);
  assert.equal(getTask(f.taskId)?.baseBranch, "feat/base");
  assert.equal(getTask(f.taskId)?.baseBranchMove, null);

  baseMerged("main", f.mergedHead);
  for (const [id, status, baseBranch, pattern] of [
    ["shelved", "backlog", "feat/base", /in the backlog; edit its base branch instead/],
    ["finished", "done", "feat/base", /task is done/],
    ["launching", "dispatching", "feat/base", /still dispatching/],
    ["plain", "running", null, /no base branch to move/],
  ] as const) {
    f.registry.upsertTask(mkTask({ id, status, repoRoot: f.repo, baseBranch }));
    await refusal(id, 409, pattern);
    assert.equal(getTask(id)?.baseBranchMove ?? null, null);
  }
});

test("a backlog task still changes its base through the edit, which stores origin's default as null", async () => {
  const f = runningStack("backlog-edit");
  f.registry.upsertTask(mkTask({ id: "shelved", status: "backlog", repoRoot: f.repo, baseBranch: "feat/base" }));
  const res = await f.app.request("/api/tasks/shelved/update", {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({ baseBranch: "main" }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(getTask("shelved")?.baseBranch, null);
  assert.equal(getTask("shelved")?.baseBranchMove ?? null, null);
});

// --- the merge watcher, after the move ---

test("after the move a merge into the new base completes the task and satisfies its dependent", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const { repo, mergedHead } = strandedStack("lands");
  const registry = new Registry();
  const tasks = taskManager(registry);
  const id = "lands";
  const cwd = `/repo/${id}`;
  const taskId = `task-${id}`;
  registry.applyDiscovery([{
    syntheticId: id, agent: "claude", name: `agent-${id}`, nameSource: "process", cwd,
    gitBranch: "feat/stacked", gitRoot: "/repo", repoRoot: "/repo", pid: 100, tty: null, terminals: [], startedAt: 0,
  }]);
  registry.applyHook({ agent: "claude", event: "Stop", sessionId: `${id}-episode`, cwd, transcriptPath: null, env: {} });
  registry.upsertTask(mkTask({
    id: taskId, title: "Stacked", status: "running", sessionId: id, worktreePath: cwd, homeName: "Stacked",
    repoRoot: repo, baseBranch: "feat/base", baseSha: mergedHead,
  }));
  registry.bindTaskToWorkEpisode(taskId, id);
  registry.upsertTask(mkTask({
    id: `${id}-dependent`, title: "Next", status: "backlog", repoRoot: repo,
    dependencies: [{
      type: "task", taskId, title: "Stacked", sessionId: null, episodeId: null, agentSessionId: null,
      branch: null, prUrl: null, selectedAt: 1, satisfiedAt: null,
    }],
  }));
  const episode = registry.workEpisodeForSession(id)!;
  const url = "https://github.com/mc-test/lands/pull/8";
  registry.reconcilePrs(new Map([[id, {
    url, number: 8, state: "open" as const, checks: "passing" as const, branch: "feat/stacked",
    agentSessionId: `${id}-episode`, episodeId: episode.episodeId, createdAt: episode.startedAt,
    mergedAt: null, headSha: "head", worktreeHeadSha: "head", baseRef: "feat/base",
  }]]), new Set());
  registry.applyDiscovery([]);
  registry.emit("event", { type: "session_remove", id });
  const urlPoll = () => pollAndReconcilePrs(
    registry,
    async () => null,
    async (candidate) => (candidate === url ? { state: "merged" as const, mergedAt: 5_000_000, baseRef: "main" } : null),
  );
  const dependent = () => registry.getTask(`${id}-dependent`)!;

  // GitHub retargeted the stacked pull request to `main` and it merged there: not yet the task's.
  await urlPoll();
  assert.equal(taskWorkEpisodeForTask(taskId)?.mergedAt, null);
  assert.equal(dependent().dependencies[0]?.satisfiedAt, null);

  baseMerged("main", mergedHead);
  const moved = await tasks.moveBaseBranch(taskId);
  assert.ok(moved.ok, moved.ok ? "" : moved.error);

  await urlPoll();
  const done = registry.getTask(taskId)!;
  assert.equal(done.status, "done");
  assert.equal(done.outcomeUrl, url);
  assert.notEqual(dependent().dependencies[0]?.satisfiedAt, null, "stamped on the edge");
  assert.deepEqual(tasks.dependencyBlockers(dependent()), []);
});
