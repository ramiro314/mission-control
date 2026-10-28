import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openDb } from "../src/server/db.ts";
import { Registry } from "../src/server/registry.ts";
import { ReviewManager } from "../src/server/reviews.ts";
import { TaskManager } from "../src/server/tasks.ts";
import { QueueManager } from "../src/server/queue.ts";
import { buildApp } from "../src/server/routes.ts";
import { InFlightTrees } from "../src/server/worktrees/in-flight.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import { WorktreeManager } from "../src/server/worktrees/manager.ts";
import { inspectWorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { finishedTrees, OrphanProcessMonitor } from "../src/server/worktrees/orphan-processes.ts";
import { ORPHAN_TREE_GRACE_MS, OrphanTreeSweep } from "../src/server/worktrees/orphan-sweep.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import type { WorktreeActionPreview, WorktreeOperationView } from "../src/shared/worktrees.ts";

// Worktrees > Unowned trees: a folder the orphan sweep kept for its work is discarded only
// through a preview that names it, and only a folder the sweep keeps right now can be named.
// A process holding an unreferenced folder is reported like one in a finished slot. Real git,
// real folders, real processes: what is at stake is deleting the wrong directory.

const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-unowned-trees-")));
const worktreesDir = join(root, "state", "worktrees");
const checksDir = join(root, "state", "check-worktrees");
mkdirSync(worktreesDir, { recursive: true });
mkdirSync(checksDir, { recursive: true });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const origin = join(root, "origin.git");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
const repo = join(root, "repo");
execFileSync("git", ["clone", "-q", origin, repo], { stdio: "ignore" });
git(repo, "config", "user.email", "test@example.com");
git(repo, "config", "user.name", "test");
writeFileSync(join(repo, "README.md"), "fixture\n");
git(repo, "add", ".");
git(repo, "commit", "-q", "-m", "init");
git(repo, "push", "-q", "origin", "main");

let referenced: string[] = [];
const sweep = new OrphanTreeSweep({
  directories: [worktreesDir, checksDir],
  stateHome: join(root, "state"),
  referencedPaths: () => referenced,
  slotPaths: () => [],
  sourceRepositories: () => [repo],
  inFlight: new InFlightTrees(),
  occupancy: inspectWorktreeOccupancy,
  // An hour ahead, so every folder here is past the creation grace.
  now: () => Date.now() + 2 * ORPHAN_TREE_GRACE_MS,
});

const db = openDb();
const registry = new Registry();
const tasks = new TaskManager(registry);
const manager = new WorktreeManager(db, {
  resolvePolicy: () => ({ enabled: true, maxSlots: 2, setupArgv: null }),
});
const operations = new WorktreeOperationsService(manager, {
  legacy: new LegacyTreehouseService(db),
  tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
  checks: new CheckLeaseManager(db, { manager, legacy: new LegacyTreehouseService(db) }),
  checkRecovery: async () => "unknown",
  notifyChanged: () => {},
  diskBytes: async () => 0,
  unownedTrees: sweep,
});
const app = buildApp({
  registry,
  reviews: new ReviewManager(registry),
  tasks,
  queues: new QueueManager(registry),
  worktrees: manager,
  worktreeOperations: operations,
});
const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

const children = new Set<ChildProcess>();
after(() => {
  for (const child of children) child.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<Response> {
  return app.request(path, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
}

async function preview(path: string): Promise<{ status: number; body: WorktreeActionPreview & { error?: string } }> {
  const response = await post("/api/worktrees/actions/preview", { action: "removeUnowned", path });
  return { status: response.status, body: await response.json() as WorktreeActionPreview & { error?: string } };
}

/** Execute a preview and wait for its background operation; returns its failure, if any. */
async function execute(token: string, acknowledgements: string[]): Promise<{ status: number; failed: WorktreeOperationView | null }> {
  const response = await post("/api/worktrees/actions/execute", { token, acknowledgements });
  if (response.status !== 202) return { status: response.status, failed: null };
  const { operation } = await response.json() as { operation: WorktreeOperationView };
  await operations.idle();
  const failed = (await operations.inventory()).operations.find((each) => each.id === operation.id) ?? null;
  return { status: 202, failed };
}

let trees = 0;
function dirtyWorktree(): string {
  const path = join(worktreesDir, `dirty-${trees++}`);
  git(repo, "worktree", "add", "-q", "-b", `harness/dirty-${trees}`, path);
  writeFileSync(join(path, "notes.md"), "work in progress\n");
  return path;
}

test("only a tree the sweep keeps can be previewed, so any other path is refused before anything is inspected", async () => {
  const kept = dirtyWorktree();
  await sweep.sweep();
  const clean = join(worktreesDir, "never-kept");
  mkdirSync(clean);

  for (const path of [homedir(), repo, clean, join(worktreesDir, "missing")]) {
    const refused = await preview(path);
    assert.equal(refused.status, 404, path);
    assert.match(refused.body.error ?? "", /not an unowned tree Mission Control kept/);
  }
  assert.ok(existsSync(kept));
  assert.ok(existsSync(clean));
});

test("discard-and-remove previews the path and its work, needs the acknowledgement, and removes only that tree", async () => {
  const path = dirtyWorktree();
  const sibling = dirtyWorktree();
  await sweep.sweep();

  const shown = await preview(path);
  assert.equal(shown.status, 200);
  assert.equal(shown.body.allowed, true, shown.body.blockers.join("; "));
  assert.deepEqual(shown.body.affected.map((each) => each.path), [path]);
  assert.deepEqual(shown.body.requiredAcknowledgements, ["dirty"]);
  assert.ok(shown.body.consequences.includes(`Discards the work in ${path}: checkout has uncommitted, untracked or ignored work.`), shown.body.consequences.join("\n"));
  assert.ok(shown.body.consequences.some((line) => line.startsWith("Files it deletes include: notes.md (untracked)")), shown.body.consequences.join("\n"));
  assert.ok(shown.body.consequences.some((line) => /git worktree remove --force/.test(line)));

  // Without the acknowledgement nothing is queued and the tree stays.
  assert.equal((await execute(shown.body.token, [])).status, 422);
  assert.ok(existsSync(join(path, "notes.md")));

  const again = await preview(path);
  const done = await execute(again.body.token, ["dirty"]);
  assert.equal(done.status, 202);
  assert.equal(done.failed, null, done.failed?.error ?? "");
  assert.equal(existsSync(path), false);
  assert.ok(!git(repo, "worktree", "list").includes(path), "its registration went with it");
  assert.ok(existsSync(join(sibling, "notes.md")), "another kept tree is untouched");

  // The problem goes at once: its subject is reported gone, and the sibling's stays.
  const observed = sweep.problems();
  const subjects = observed.firstSeen?.map((each) => each.subject) ?? [];
  assert.ok(subjects.some((subject) => subject.startsWith(`dirty-orphan-folder:${sibling}:`)));
  assert.ok(!subjects.some((subject) => subject.startsWith(`dirty-orphan-folder:${path}:`)));
  assert.ok(observed.goneSubjects?.some((subject) => subject.startsWith(`dirty-orphan-folder:${path}:`)));
});

test("a folder that is not a worktree is previewed by its files and deleted with them", async () => {
  const path = join(checksDir, "lost-git-file");
  mkdirSync(join(path, "src"), { recursive: true });
  writeFileSync(join(path, "src", "index.ts"), "export {};\n");
  await sweep.sweep();

  const shown = await preview(path);
  assert.equal(shown.body.allowed, true, shown.body.blockers.join("; "));
  assert.ok(shown.body.consequences.includes(`Discards the work in ${path}: folder is not a Git worktree but still holds files.`));
  assert.ok(shown.body.consequences.includes("Files it deletes include: src/index.ts."));
  assert.ok(shown.body.consequences.includes("The folder is not a Git worktree, so it is deleted with every file in it."));
  assert.equal((await execute(shown.body.token, ["dirty"])).failed, null);
  assert.equal(existsSync(path), false);
});

test("Execute refuses a tree whose work changed after the preview, and keeps it", async () => {
  const path = dirtyWorktree();
  await sweep.sweep();
  const shown = await preview(path);
  writeFileSync(join(path, "later.md"), "written after the preview\n");

  const done = await execute(shown.body.token, ["dirty"]);
  assert.equal(done.failed?.changed, true);
  assert.match(done.failed?.error ?? "", /changed after preview/);
  assert.ok(existsSync(join(path, "later.md")));
});

test("the sweep refuses a discard once a row names the tree, even with a confirmed preview", async () => {
  const path = dirtyWorktree();
  await sweep.sweep();
  referenced = [path];
  try {
    assert.equal(await sweep.discard(path), "a task or check now names that tree");
  } finally {
    referenced = [];
  }
  assert.ok(existsSync(join(path, "notes.md")));
});

test("a process holding an unreferenced folder keeps it from any discard, is reported, and its Kill sweeps the folder again", async () => {
  const path = join(worktreesDir, "held");
  mkdirSync(path);
  writeFileSync(join(path, "scratch.md"), "still open in a shell\n");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: path, stdio: "ignore" });
  children.add(child);
  child.once("exit", () => children.delete(child));
  await once(child, "spawn");

  // Occupied: skipped, not kept, but listed for the process scan.
  const swept = await sweep.sweep();
  assert.ok(swept.skipped.some((each) => each.path === path && each.reason === "occupied"));
  assert.ok(sweep.unreferenced().includes(path));
  assert.equal((await preview(path)).status, 404, "nothing to discard until the sweep keeps it");

  const retried: string[] = [];
  const monitor = new OrphanProcessMonitor({
    trees: () => finishedTrees({ slots: [], taskReturns: [], returningChecks: [], unownedTrees: sweep.unreferenced() }),
    retryReturn: async (owner) => {
      retried.push(owner.kind);
      await sweep.sweep();
    },
    unpooledRoots: [worktreesDir, checksDir],
  });
  await monitor.scan();
  const problem = monitor.problems().find((each) => each.process?.pid === child.pid);
  assert.ok(problem?.process);
  assert.deepEqual(problem.link, { target: "unowned-tree", path });
  assert.match(problem.message, /which no task or check owns/);

  const killed = await monitor.kill({
    path, pid: problem.process.pid, startedAt: problem.process.startedAt, command: problem.process.command,
  });
  assert.equal(killed.ok, true);
  assert.deepEqual(retried, ["unowned"]);
  await sweep.sweep();
  // Free of its process, the folder still holds a file, so the sweep now keeps it for a discard.
  assert.ok(sweep.problems().firstSeen?.some((each) => each.subject.includes(path)));
  assert.equal((await preview(path)).body.allowed, true);
});
