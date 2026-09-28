import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { Session, Task } from "../src/shared/types.ts";

const home = mkdtempSync(join(tmpdir(), "mission-complete-frees-worktree-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { checkoutWouldLoseWork, resetWouldDestroyWork } = await import("../src/server/actions.ts");
const { bindTaskWorkEpisode } = await import("../src/server/db.ts");
const { CompleteTaskSchema } = await import("../src/shared/protocol.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/**
 * "Free this task's worktree" on Complete. The safety rule is the whole feature: a checkout
 * with uncommitted or untracked files is never freed unless the operator ticked an unsafe
 * box (`discardWork`), local-only commits are excused only when a merged PR's recorded head
 * contains them, and unchecked Complete is today's call exactly. Real temporary Git
 * repositories throughout, because every one of these answers is a Git read.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();

let counter = 0;

/** A clone of a bare origin with one pushed commit, and a `harness/*` worktree cut from it. */
function repoWithWorktree(name = "repo"): { repoRoot: string; worktreePath: string; branch: string } {
  const base = realpathSync(mkdtempSync(join(home, `${name}-`)));
  const origin = join(base, "origin.git");
  const repoRoot = join(base, name);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, repoRoot], { stdio: "pipe" });
  writeFileSync(join(repoRoot, "README.md"), "hello\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-q", "-m", "init");
  git(repoRoot, "push", "-q", "origin", "HEAD:main");
  counter += 1;
  const branch = `harness/free-${counter}`;
  const worktreePath = join(base, `wt-${counter}`);
  git(repoRoot, "worktree", "add", "-q", "-b", branch, worktreePath);
  return { repoRoot, worktreePath: realpathSync(worktreePath), branch };
}

function commit(cwd: string, file: string): string {
  writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
}

function gitTask(id: string, over: Partial<Task> = {}): Task {
  const { repoRoot, worktreePath, branch } = repoWithWorktree();
  return mkTask({
    id,
    status: "running",
    repoRoot,
    worktreePath,
    branch,
    provider: "git",
    homeName: null,
    sessionId: null,
    ...over,
  });
}

function mergedBinding(taskId: string, prHeadSha: string | null): void {
  bindTaskWorkEpisode({
    taskId,
    episodeId: `ep-${taskId}`,
    sessionId: `s-${taskId}`,
    agentSessionId: `a-${taskId}`,
    branch: "harness/x",
    prUrl: `https://github.com/o/r/pull/${counter}`,
    prHeadSha,
    mergedAt: 5_000,
    boundAt: 1_000,
    updatedAt: 5_000,
  });
}

function setup(deps?: ConstructorParameters<typeof TaskManager>[1]) {
  const registry = new Registry();
  const tasks = new TaskManager(registry, deps);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const complete = async (id: string, body: Record<string, unknown>) => {
    const res = await app.request(`/api/tasks/${id}/complete`, {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify({ outcome: "shipped", ...body }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const preview = async (id: string) => {
    const res = await app.request(`/api/tasks/${id}/free-preview`, {
      headers: { host: "127.0.0.1:7317" },
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { registry, tasks, complete, preview };
}

// ---- the path-level Git check -----------------------------------------------------------

test("a clean, pushed checkout loses nothing", async () => {
  const { worktreePath } = repoWithWorktree();
  assert.deepEqual(await checkoutWouldLoseWork(worktreePath), {
    uncommitted: 0,
    localOnlyCommits: 0,
    reasons: [],
  });
});

test("uncommitted and untracked files are counted", async () => {
  const { worktreePath } = repoWithWorktree();
  writeFileSync(join(worktreePath, "README.md"), "edited\n");
  writeFileSync(join(worktreePath, "new.txt"), "new\n");
  const loss = await checkoutWouldLoseWork(worktreePath);
  assert.equal(loss.uncommitted, 2);
  assert.deepEqual(loss.reasons, ["it has 2 uncommitted file(s)"]);
});

test("uncommitted files are never excused, even by a merged head that holds HEAD", async () => {
  const { worktreePath } = repoWithWorktree();
  const head = git(worktreePath, "rev-parse", "HEAD");
  writeFileSync(join(worktreePath, "new.txt"), "new\n");
  const loss = await checkoutWouldLoseWork(worktreePath, { excuseCommitsAncestorOf: [head] });
  assert.deepEqual(loss.reasons, ["it has 1 uncommitted file(s)"]);
});

test("a local-only commit is counted, and excused only when a merged head contains HEAD", async () => {
  const { worktreePath } = repoWithWorktree();
  const first = commit(worktreePath, "a.txt");
  const second = commit(worktreePath, "b.txt");
  assert.deepEqual((await checkoutWouldLoseWork(worktreePath)).reasons, [
    "it has 2 commit(s) no origin ref has",
  ]);
  // HEAD equal to the merged head.
  assert.deepEqual(
    (await checkoutWouldLoseWork(worktreePath, { excuseCommitsAncestorOf: [second] })).reasons,
    [],
  );
  // HEAD a descendant of the merged head: the commit after it is not excused.
  assert.deepEqual(
    (await checkoutWouldLoseWork(worktreePath, { excuseCommitsAncestorOf: [first] })).reasons,
    ["it has 2 commit(s) no origin ref has"],
  );
  // HEAD an ancestor of the merged head.
  git(worktreePath, "reset", "-q", "--hard", first);
  assert.deepEqual(
    (await checkoutWouldLoseWork(worktreePath, { excuseCommitsAncestorOf: [second] })).reasons,
    [],
  );
});

test("a merged head Git cannot find excuses nothing", async () => {
  const { worktreePath } = repoWithWorktree();
  commit(worktreePath, "a.txt");
  const loss = await checkoutWouldLoseWork(worktreePath, {
    excuseCommitsAncestorOf: ["0123456789abcdef0123456789abcdef01234567"],
  });
  assert.deepEqual(loss.reasons, ["it has 1 commit(s) no origin ref has"]);
});

test("an unreadable path yields a reason", async () => {
  const loss = await checkoutWouldLoseWork(join(home, "does-not-exist"));
  assert.deepEqual(loss.reasons, ["it is not a git repository"]);
});

test("resetWouldDestroyWork keeps its exact sentences", async () => {
  const session = (cwd: string | null): Session => mkSession({ cwd });
  assert.equal(await resetWouldDestroyWork(session(null)), "the session has no working directory");
  const { worktreePath } = repoWithWorktree();
  assert.equal(await resetWouldDestroyWork(session(worktreePath)), null);
  commit(worktreePath, "a.txt");
  assert.equal(await resetWouldDestroyWork(session(worktreePath)), "it has 1 commit(s) no origin ref has");
  writeFileSync(join(worktreePath, "dirty.txt"), "x\n");
  assert.equal(await resetWouldDestroyWork(session(worktreePath)), "it has 1 uncommitted file(s)");
  const plain = mkdtempSync(join(tmpdir(), "mission-not-git-"));
  try {
    assert.equal(await resetWouldDestroyWork(session(plain)), "it is not a git repository");
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

// ---- task freeability -------------------------------------------------------------------

test("an assigned task and a pipeline task have nothing to free", async () => {
  const { registry, tasks } = setup();
  registry.upsertTask(mkTask({ id: "assigned", status: "running", worktreePath: null }));
  assert.deepEqual(await tasks.worktreeFreeability("assigned"), {
    applicable: false,
    freeable: false,
    reasons: [],
  });
  registry.upsertTask(gitTask("pipeline", { kind: "pipeline" as Task["kind"] }));
  assert.equal((await tasks.worktreeFreeability("pipeline"))?.applicable, false);
  assert.equal(await tasks.worktreeFreeability("nope"), null);
});

test("a clean task is freeable; a dirty one is not, even with a merged PR", async () => {
  const { registry, tasks } = setup();
  const clean = gitTask("clean");
  registry.upsertTask(clean);
  assert.deepEqual(await tasks.worktreeFreeability("clean"), {
    applicable: true,
    freeable: true,
    reasons: [],
  });
  const dirty = gitTask("dirty");
  registry.upsertTask(dirty);
  mergedBinding("dirty", git(dirty.worktreePath!, "rev-parse", "HEAD"));
  writeFileSync(join(dirty.worktreePath!, "wip.txt"), "wip\n");
  assert.deepEqual(await tasks.worktreeFreeability("dirty"), {
    applicable: true,
    freeable: false,
    reasons: ["it has 1 uncommitted file(s)"],
  });
});

test("local-only commits are excused by the merged PR's recorded head, never past it", async () => {
  const { registry, tasks } = setup();
  const task = gitTask("merged-head");
  registry.upsertTask(task);
  const merged = commit(task.worktreePath!, "a.txt");
  mergedBinding("merged-head", merged);
  assert.equal((await tasks.worktreeFreeability("merged-head"))?.freeable, true);
  commit(task.worktreePath!, "after-merge.txt");
  assert.deepEqual((await tasks.worktreeFreeability("merged-head"))?.reasons, [
    "it has 2 commit(s) no origin ref has",
  ]);

  const headless = gitTask("merged-no-head");
  registry.upsertTask(headless);
  commit(headless.worktreePath!, "a.txt");
  mergedBinding("merged-no-head", null);
  assert.equal((await tasks.worktreeFreeability("merged-no-head"))?.freeable, false);
});

test("a multi-repo task with one dirty checkout is not freeable, and names that repo", async () => {
  const { registry, tasks } = setup();
  const extra = repoWithWorktree("attached");
  writeFileSync(join(extra.worktreePath, "wip.txt"), "wip\n");
  registry.upsertTask(gitTask("multi", {
    extraRepos: [{
      repoRoot: extra.repoRoot,
      worktreePath: extra.worktreePath,
      branch: extra.branch,
      provider: "git",
      worktreeLeaseId: null,
      baseSha: null,
      prUrl: null,
      prState: null,
      mergedAt: null,
    }],
  }));
  assert.deepEqual(await tasks.worktreeFreeability("multi"), {
    applicable: true,
    freeable: false,
    reasons: ["attached: it has 1 uncommitted file(s)"],
  });
});

// ---- routes -----------------------------------------------------------------------------

test("free-preview answers the predicate, and 404s an unknown task", async () => {
  const { registry, preview } = setup();
  registry.upsertTask(gitTask("preview"));
  assert.deepEqual(await preview("preview"), {
    status: 200,
    body: { applicable: true, freeable: true, reasons: [] },
  });
  assert.equal((await preview("missing")).status, 404);
});

test("no option: the body and the kept worktree are exactly today's", async () => {
  assert.equal(CompleteTaskSchema.parse({ outcome: "x" }).freeWorktree, undefined);
  const { registry, complete } = setup();
  const task = gitTask("plain");
  registry.upsertTask(task);
  const { status, body } = await complete("plain", {});
  assert.equal(status, 200);
  assert.equal(body.status, "done");
  assert.equal("freed" in body, false);
  assert.equal("freeError" in body, false);
  assert.equal(body.worktreePath, task.worktreePath);
  assert.equal(existsSync(task.worktreePath!), true);
});

test("ifSafe on a safe task records done and frees the worktree", async () => {
  const { registry, complete } = setup();
  const task = gitTask("safe");
  registry.upsertTask(task);
  const { status, body } = await complete("safe", { freeWorktree: "ifSafe" });
  assert.equal(status, 200);
  assert.equal(body.status, "done");
  assert.equal(body.freed, true);
  assert.equal(body.worktreePath, null);
  assert.equal(registry.getTask("safe")?.worktreePath, null);
  assert.equal(existsSync(task.worktreePath!), false);
});

test("ifSafe on a dirty task records done and keeps the tree with freeError", async () => {
  const { registry, complete } = setup();
  const task = gitTask("dirty-route");
  registry.upsertTask(task);
  writeFileSync(join(task.worktreePath!, "wip.txt"), "wip\n");
  const { body } = await complete("dirty-route", { freeWorktree: "ifSafe" });
  assert.equal(body.status, "done");
  assert.equal(body.freed, false);
  assert.equal(body.freeError, "worktree kept: it has 1 uncommitted file(s)");
  assert.equal(registry.getTask("dirty-route")?.worktreePath, task.worktreePath);
  assert.equal(existsSync(join(task.worktreePath!, "wip.txt")), true);
});

test("ifSafe re-checks after the agent is stopped, so its last write keeps the tree", async () => {
  // The agent still runs until reclaim stops it. The kill seam stands in for that stop and
  // writes the file an agent would have written in the meantime; only a check made AFTER it
  // can see the file.
  const task = gitTask("late-write", { homeName: "late-home", sessionId: "late-session" });
  const { registry, complete, tasks } = setup({
    resetWouldDestroyWork,
    kill: async () => {
      writeFileSync(join(task.worktreePath!, "late.txt"), "late\n");
      return { ok: true };
    },
  });
  (registry as unknown as { sessions: Map<string, Session> }).sessions.set(
    "late-session",
    mkSession({ id: "late-session", cwd: task.worktreePath }),
  );
  registry.upsertTask(task);
  assert.equal((await tasks.worktreeFreeability("late-write"))?.freeable, true, "safe at preview");
  const { body } = await complete("late-write", { freeWorktree: "ifSafe" });
  assert.equal(body.status, "done");
  assert.equal(body.freed, false);
  assert.match(String(body.freeError), /^worktree kept: it has 1 uncommitted file\(s\)$/);
  assert.equal(existsSync(join(task.worktreePath!, "late.txt")), true);
});

test("discardWork frees a dirty task", async () => {
  const { registry, complete } = setup();
  const task = gitTask("discard");
  registry.upsertTask(task);
  writeFileSync(join(task.worktreePath!, "wip.txt"), "wip\n");
  const { body } = await complete("discard", { freeWorktree: "discardWork" });
  assert.equal(body.status, "done");
  assert.equal(body.freed, true);
  assert.equal(existsSync(task.worktreePath!), false);
});

test("a refused reclaim keeps done and reports freeError", async () => {
  // A tree that is not a worktree of its recorded repo makes `git worktree remove` refuse.
  const { registry, complete } = setup();
  const stray = mkdtempSync(join(home, "stray-"));
  mkdirSync(join(stray, "sub"));
  const task = gitTask("refused");
  registry.upsertTask({ ...task, worktreePath: realpathSync(stray) });
  const { body } = await complete("refused", { freeWorktree: "discardWork" });
  assert.equal(body.status, "done");
  assert.equal(body.freed, false);
  assert.match(String(body.freeError), /could not reclaim task resources/);
  assert.equal(registry.getTask("refused")?.status, "done");
});

test("an option on a task with nothing to free completes it and frees nothing", async () => {
  const { registry, complete } = setup();
  registry.upsertTask(mkTask({ id: "assigned-route", status: "running", worktreePath: null }));
  const { body } = await complete("assigned-route", { freeWorktree: "ifSafe" });
  assert.equal(body.status, "done");
  assert.equal(body.freed, false);
  assert.equal("freeError" in body, false);
});

