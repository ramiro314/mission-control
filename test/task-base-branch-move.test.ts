import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";
import { trackedTaskManagers } from "./helpers/task-manager.ts";
import type { Task } from "../src/shared/types.ts";

// Moving an in-flight task's base branch to where that branch merged. Each fixture stacks a
// feature worktree on `feat/a`, merges `feat/a` on origin and deletes it there, so every
// reader that still asked for `origin/feat/a` would fail.

const home = mkdtempSync(join(tmpdir(), "mission-base-branch-move-home-"));
const repos = mkdtempSync(join(tmpdir(), "mission-base-branch-move-repos-"));
process.env.HARNESS_HOME = home;

const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const taskManager = trackedTaskManagers(TaskManager);
const { moveMergedBaseBranches, mergedPrListArgs, parseMergedPullRequestBase } =
  await import("../src/server/base-branch-move.ts");
const { changedPathsSince, computeSessionDiff } = await import("../src/server/diff.ts");
const { resetPreview } = await import("../src/server/actions.ts");
const { withTaskKindContract } = await import("../src/server/task-contract.ts");
const { prBaseBranchFor } = await import("../src/server/workflows/context.ts");
const { workflowPullRequestConflictContract } = await import("../src/server/workflows/agent-contract.ts");
const { getTask } = await import("../src/server/db.ts");

after(() => {
  for (const dir of [home, repos]) rmSync(dir, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@test", "-c", "user.name=t", ...args], { stdio: "pipe" })
    .toString()
    .trim();

function commit(dir: string, file: string, message: string): void {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), `${message}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
}

/**
 * `main` and `release/2.0` on a bare origin; `feat/a` cut from `parent` and pushed; a feature
 * worktree on `feat/b` cut from `origin/feat/a`. Then `feat/a` lands on `parent` and is
 * deleted on origin, and the clone prunes it, as GitHub's delete-on-merge leaves things.
 */
function stackedThenMerged(name: string, parent: "main" | "release/2.0") {
  const repo = join(repos, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  commit(repo, "file.txt", "main");
  const origin = join(repos, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-qu", "origin", "main");
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  git(repo, "checkout", "-qb", "release/2.0");
  commit(repo, "release.txt", "release");
  git(repo, "push", "-q", "origin", "release/2.0");
  git(repo, "checkout", "-qb", "feat/a", parent);
  commit(repo, "a.txt", "feature a");
  git(repo, "push", "-q", "origin", "feat/a");
  git(repo, "checkout", "-q", "main");
  git(repo, "fetch", "-q", "origin");
  git(repo, "remote", "set-head", "origin", "main");

  const wt = join(repos, `${name}-wt`);
  git(repo, "worktree", "add", "-q", "-b", "feat/b", wt, "origin/feat/a");
  commit(wt, "b.txt", "feature b");

  git(repo, "push", "-q", "origin", `feat/a:${parent}`);
  git(repo, "push", "-q", "origin", "--delete", "feat/a");
  git(repo, "fetch", "-q", "--prune", "origin");
  return { repo: realpathSync(repo), wt: realpathSync(wt) };
}

function inFlight(repoRoot: string, over: Partial<Task> = {}) {
  const registry = new Registry();
  const tasks = taskManager(registry);
  registry.upsertTask(mkTask({ id: "stacked", status: "running", repoRoot, baseBranch: "feat/a", ...over }));
  const sweepTasks = {
    candidates: () => registry.baseBranchMoveCandidates(),
    move: (id: string, from: string, to: string | null) => tasks.moveBaseBranch(id, from, to),
  };
  return { registry, tasks, sweepTasks };
}

test("a task whose base merged into origin's default and was deleted moves to the default", async () => {
  const { repo, wt } = stackedThenMerged("to-default", "main");
  const { registry, sweepTasks } = inFlight(repo);
  const before = await computeSessionDiff(wt, undefined, "feat/a");
  assert.equal(before.ok, false, "the deleted base cannot be measured from");

  const asked: string[] = [];
  const moves = await moveMergedBaseBranches(sweepTasks, {
    mergedInto: async (_root, branch) => (asked.push(branch), "main"),
  });

  assert.deepEqual(asked, ["feat/a"]);
  assert.deepEqual(moves, [{ taskId: "stacked", from: "feat/a", to: null }]);
  const moved = registry.getTask("stacked")!;
  assert.equal(moved.baseBranch, null, "origin's default is stored as null");
  assert.equal(moved.baseBranchMovedFrom, "feat/a", "the move is recorded on the task");
  assert.equal(getTask("stacked")?.baseBranchMovedFrom, "feat/a", "and persisted");

  const after = await computeSessionDiff(wt, undefined, moved.baseBranch ?? null);
  assert.equal(after.ok, true, after.error ?? "");
  assert.equal(after.base, "main");
  assert.match(after.patch, /b\.txt/);
  assert.deepEqual(await changedPathsSince(wt, moved.baseBranch ?? null), { ok: true, repoRoot: wt, paths: ["b.txt"] });
  const reset = await resetPreview(mkSession({ id: "s1", cwd: wt, gitBranch: null, terminals: [], tty: null }), moved.baseBranch ?? null);
  assert.equal(reset.ok, true, reset.error ?? "");
  assert.equal(reset.target, "origin/main");
  assert.doesNotMatch(withTaskKindContract(moved, "Build it"), /Base branch/, "a later contract names no other base");
});

test("a task whose base merged into another branch moves there, and every later instruction names it", async () => {
  const { repo, wt } = stackedThenMerged("to-release", "release/2.0");
  const { registry, sweepTasks } = inFlight(repo);

  await moveMergedBaseBranches(sweepTasks, { mergedInto: async () => "release/2.0" });

  const moved = registry.getTask("stacked")!;
  assert.equal(moved.baseBranch, "release/2.0");
  assert.equal(moved.baseBranchMovedFrom, "feat/a");
  const diff = await computeSessionDiff(wt, undefined, moved.baseBranch ?? null);
  assert.equal(diff.ok, true, diff.error ?? "");
  assert.equal(diff.base, "release/2.0");
  assert.match(diff.patch, /b\.txt/);
  assert.doesNotMatch(diff.patch, /release\.txt/, "measured from release/2.0, not from main");
  assert.deepEqual(await changedPathsSince(wt, moved.baseBranch ?? null), { ok: true, repoRoot: wt, paths: ["b.txt"] });
  const reset = await resetPreview(mkSession({ id: "s1", cwd: wt, gitBranch: null, terminals: [], tty: null }), moved.baseBranch ?? null);
  assert.equal(reset.target, "origin/release/2.0");
  assert.match(withTaskKindContract(moved, "Build it"), /This task's base branch is `release\/2\.0`/);
  assert.match(workflowPullRequestConflictContract(prBaseBranchFor(moved, repo)), /git merge origin\/release\/2\.0/);
});

test("a base branch origin still has is never moved, even with a merged pull request behind it", async () => {
  const { repo } = stackedThenMerged("still-there", "main");
  const { registry, sweepTasks } = inFlight(repo, { baseBranch: "release/2.0" });

  const moves = await moveMergedBaseBranches(sweepTasks, { mergedInto: async () => "main" });

  assert.deepEqual(moves, []);
  assert.equal(registry.getTask("stacked")?.baseBranch, "release/2.0");
  assert.equal(registry.getTask("stacked")?.baseBranchMovedFrom ?? null, null);
});

test("a deleted base with no merged pull request, or a gh failure, leaves the task alone", async () => {
  const { repo } = stackedThenMerged("unmerged", "main");
  for (const answer of [null, "error"] as const) {
    const { registry, sweepTasks } = inFlight(repo);
    assert.deepEqual(await moveMergedBaseBranches(sweepTasks, { mergedInto: async () => answer }), []);
    assert.equal(registry.getTask("stacked")?.baseBranch, "feat/a");
  }
});

test("backlog tasks and tasks without a base are not candidates, and each base is asked about once", async () => {
  const registry = new Registry();
  const tasks = taskManager(registry);
  registry.upsertTask(mkTask({ id: "one", status: "running", repoRoot: "/repo", baseBranch: "feat/a" }));
  registry.upsertTask(mkTask({ id: "two", status: "failed", repoRoot: "/repo", baseBranch: "feat/a" }));
  registry.upsertTask(mkTask({ id: "shelved", status: "backlog", repoRoot: "/repo", baseBranch: "feat/a" }));
  registry.upsertTask(mkTask({ id: "plain", status: "running", repoRoot: "/repo", baseBranch: null }));
  // The registry also loads the rows earlier tests in this file persisted, on other roots.
  const candidates = () => registry.baseBranchMoveCandidates().filter((t) => t.repoRoot === "/repo");
  assert.deepEqual(candidates().map((t) => t.id).sort(), ["one", "two"]);

  const asked: string[] = [];
  const moves = await moveMergedBaseBranches(
    { candidates, move: (id, from, to) => tasks.moveBaseBranch(id, from, to) },
    {
      remoteBranch: async (root, branch) => (asked.push(`${root} ${branch}`), { ok: true, value: null }),
      mergedInto: async () => "main",
      resolve: async () => ({ ok: true, baseBranch: null }),
      fetch: async () => {},
    },
  );
  assert.deepEqual(asked, ["/repo feat/a"]);
  assert.deepEqual(moves.map((m) => m.taskId).sort(), ["one", "two"]);
  assert.equal(registry.getTask("shelved")?.baseBranch, "feat/a", "the backlog keeps its edit path");
});

test("a move is refused for a backlog task, a base that changed since it was read, and a task being assigned", async () => {
  const registry = new Registry();
  const tasks = taskManager(registry);
  registry.upsertTask(mkTask({ id: "shelved", status: "backlog", baseBranch: "feat/a" }));
  registry.upsertTask(mkTask({ id: "running", status: "running", baseBranch: "feat/c" }));
  registry.upsertTask(mkTask({ id: "assigning", status: "running", baseBranch: "feat/a" }));
  (tasks as unknown as { assigningTasks: Set<string> }).assigningTasks.add("assigning");

  assert.deepEqual(tasks.moveBaseBranch("shelved", "feat/a", null), {
    ok: false, error: "a backlog task's base branch is changed by editing it",
  });
  assert.deepEqual(tasks.moveBaseBranch("running", "feat/a", null), {
    ok: false, error: "task's base branch is no longer feat/a",
  });
  assert.deepEqual(tasks.moveBaseBranch("assigning", "feat/a", null), { ok: false, error: "task is being assigned" });
  for (const [id, base] of [["shelved", "feat/a"], ["running", "feat/c"], ["assigning", "feat/a"]] as const) {
    assert.equal(registry.getTask(id)?.baseBranch, base, `${id} keeps its base`);
    assert.equal(registry.getTask(id)?.baseBranchMovedFrom ?? null, null, `${id} records no move`);
  }
});

test("an unreachable origin, a refused new base, or a base merged into itself leaves the task alone", async () => {
  const cases: Array<[string, Partial<import("../src/server/base-branch-move.ts").BaseBranchMoveDeps>]> = [
    ["unreachable origin", { remoteBranch: async () => ({ ok: false, reason: "timed out", outcomeUnknown: true }) }],
    ["refused new base origin still has", {
      remoteBranch: async (_root, branch) => ({ ok: true, value: branch === "feat/a" ? null : "f".repeat(40) }),
      resolve: async () => ({ ok: false, error: "could not check base branch main on origin: timed out" }),
    }],
    ["merged into itself", { mergedInto: async (_root, branch) => branch }],
  ];
  for (const [name, override] of cases) {
    const registry = new Registry();
    const tasks = taskManager(registry);
    const id = `alone-${name.replaceAll(" ", "-")}`;
    registry.upsertTask(mkTask({ id, status: "running", repoRoot: "/repo-alone", baseBranch: "feat/a" }));
    const moves = await moveMergedBaseBranches(
      {
        candidates: () => registry.baseBranchMoveCandidates().filter((t) => t.id === id),
        move: (taskId, from, to) => tasks.moveBaseBranch(taskId, from, to),
      },
      {
        remoteBranch: async () => ({ ok: true, value: null }),
        mergedInto: async () => "main",
        resolve: async () => ({ ok: true, baseBranch: null }),
        fetch: async () => {},
        ...override,
      },
    );
    assert.deepEqual(moves, [], name);
    assert.equal(registry.getTask(id)?.baseBranch, "feat/a", name);
    assert.equal(registry.getTask(id)?.baseBranchMovedFrom ?? null, null, name);
  }
});

/** A sweep over one running task on `feat/a`, against an origin described by `merges`. */
async function sweepChain(
  id: string,
  merges: Record<string, string>,
  { unreachable = new Set<string>(), present = new Set<string>(["main"]) } = {},
) {
  const registry = new Registry();
  const tasks = taskManager(registry);
  registry.upsertTask(mkTask({ id, status: "running", repoRoot: "/repo-chain", baseBranch: "feat/a" }));
  const moves = await moveMergedBaseBranches(
    {
      candidates: () => registry.baseBranchMoveCandidates().filter((t) => t.id === id),
      move: (taskId, from, to) => tasks.moveBaseBranch(taskId, from, to),
    },
    {
      remoteBranch: async (_root, branch) => unreachable.has(branch)
        ? { ok: false, reason: "timed out", outcomeUnknown: true }
        : { ok: true, value: present.has(branch) ? "f".repeat(40) : null },
      mergedInto: async (_root, branch) => merges[branch] ?? null,
      resolve: async (_root, branch) => present.has(branch)
        ? { ok: true, baseBranch: branch === "main" ? null : branch }
        : { ok: false, error: `base branch ${branch} does not exist on /repo-chain's origin` },
      fetch: async () => {},
    },
  );
  return { moves, task: registry.getTask(id)! };
}

test("a base whose merged-into branch also merged and was deleted moves to where that chain ends", async () => {
  const { moves, task } = await sweepChain("two-hops", { "feat/a": "feat/x", "feat/x": "main" });
  assert.deepEqual(moves, [{ taskId: "two-hops", from: "feat/a", to: null }]);
  assert.equal(task.baseBranch, null);
  assert.equal(task.baseBranchMovedFrom, "feat/a", "the record names the task's own old base");
});

test("a chain that cannot be followed to a branch origin has leaves the task alone", async () => {
  const cases = {
    "unreachable at the second hop": sweepChain("chain-unreachable", { "feat/a": "feat/x", "feat/x": "main" }, { unreachable: new Set(["feat/x"]) }),
    "deleted without merging at the second hop": sweepChain("chain-unmerged", { "feat/a": "feat/x" }),
    "a cycle": sweepChain("chain-cycle", { "feat/a": "feat/x", "feat/x": "feat/a" }),
    "longer than the hop limit": sweepChain("chain-long", { "feat/a": "b1", b1: "b2", b2: "b3", b3: "b4", b4: "b5", b5: "main" }),
  };
  for (const [name, swept] of Object.entries(cases)) {
    const { moves, task } = await swept;
    assert.deepEqual(moves, [], name);
    assert.equal(task.baseBranch, "feat/a", name);
    assert.equal(task.baseBranchMovedFrom ?? null, null, name);
  }
});

test("a failed fetch of the new base still moves the task", async () => {
  const registry = new Registry();
  const tasks = taskManager(registry);
  registry.upsertTask(mkTask({ id: "fetch-fails", status: "running", repoRoot: "/repo-fetch", baseBranch: "feat/a" }));
  const moves = await moveMergedBaseBranches(
    {
      candidates: () => registry.baseBranchMoveCandidates().filter((t) => t.id === "fetch-fails"),
      move: (taskId, from, to) => tasks.moveBaseBranch(taskId, from, to),
    },
    {
      remoteBranch: async () => ({ ok: true, value: null }),
      mergedInto: async () => "main",
      resolve: async () => ({ ok: true, baseBranch: null }),
      fetch: async () => { throw new Error("fetch failed"); },
    },
  );
  assert.deepEqual(moves, [{ taskId: "fetch-fails", from: "feat/a", to: null }]);
  assert.equal(registry.getTask("fetch-fails")?.baseBranchMovedFrom, "feat/a");
});

test("editing a backlog task's base drops the record of an earlier move", async () => {
  const registry = new Registry();
  const tasks = taskManager(registry);
  registry.upsertTask(mkTask({ id: "requeued", status: "backlog", baseBranch: null, baseBranchMovedFrom: "feat/a" }));
  const edited = await tasks.update("requeued", { baseBranch: "release/2.0" });
  assert.equal(edited.ok, true, edited.error);
  assert.equal(registry.getTask("requeued")?.baseBranchMovedFrom, null);
});

test("the merged pull request's base is read from gh for the named repository", () => {
  assert.deepEqual(mergedPrListArgs("feat/a", "example/repo"), [
    "pr", "list", "--repo", "example/repo", "--head", "feat/a", "--state", "merged", "--json", "baseRefName", "--limit", "1",
  ]);
  assert.equal(parseMergedPullRequestBase(`[{"baseRefName":"main"}]`), "main");
  assert.equal(parseMergedPullRequestBase("[]"), null);
  assert.equal(parseMergedPullRequestBase(""), null);
  assert.equal(parseMergedPullRequestBase(`[{"baseRefName":""}]`), "error");
  assert.equal(parseMergedPullRequestBase("{}"), "error");
  assert.equal(parseMergedPullRequestBase("not json"), "error");
});
