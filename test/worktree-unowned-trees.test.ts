import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { setWorktreesConfig } from "../src/server/worktrees/config.ts";
import { WorktreeManager } from "../src/server/worktrees/manager.ts";
import { inspectWorktreeOccupancy, type WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { finishedTrees, OrphanProcessMonitor } from "../src/server/worktrees/orphan-processes.ts";
import { ORPHAN_TREE_GRACE_MS, OrphanTreeSweep } from "../src/server/worktrees/orphan-sweep.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import { WorktreeClaimSchema } from "../src/shared/protocol.ts";
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
writeFileSync(join(repo, ".gitignore"), "*.log\n");
git(repo, "add", ".");
git(repo, "commit", "-q", "-m", "init");
git(repo, "push", "-q", "origin", "main");

let referenced: string[] = [];
/** Set to make every occupancy read, the sweep's and the preview's, answer unknown. */
let occupancyUnknown = false;
const occupancy = async (paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> => occupancyUnknown
  ? new Map(paths.map((path) => [path, { status: "unknown", reason: "lsof timed out" }]))
  : inspectWorktreeOccupancy(paths);
const sweep = new OrphanTreeSweep({
  directories: [worktreesDir, checksDir],
  stateHome: join(root, "state"),
  referencedPaths: () => referenced,
  slotPaths: () => [],
  sourceRepositories: () => [repo],
  inFlight: new InFlightTrees(),
  occupancy,
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
  occupancy,
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

test("a kept tree a process has since entered cannot be discarded: the preview is blocked and the sweep refuses", async () => {
  const path = dirtyWorktree();
  await sweep.sweep();
  assert.equal((await preview(path)).body.allowed, true, "kept and free, it could be discarded");

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: path, stdio: "ignore" });
  children.add(child);
  child.once("exit", () => children.delete(child));
  await once(child, "spawn");
  try {
    const blocked = await preview(path);
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.allowed, false);
    assert.ok(blocked.body.blockers.includes("Known processes must exit before the tree can be removed; Kill them from its row first."), blocked.body.blockers.join("; "));
    // The sweep's own check, which a confirmed preview reaches, refuses on its own too.
    assert.equal(await sweep.discard(path), "1 process(es) still use it");
    assert.ok(existsSync(join(path, "notes.md")));
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
});

test("a kept tree whose processes cannot be read is never discarded", async () => {
  const path = dirtyWorktree();
  await sweep.sweep();
  occupancyUnknown = true;
  try {
    const blocked = await preview(path);
    assert.equal(blocked.body.allowed, false);
    assert.ok(blocked.body.blockers.includes("lsof timed out"), blocked.body.blockers.join("; "));
    assert.equal(await sweep.discard(path), "its processes could not be inspected: lsof timed out");
  } finally {
    occupancyUnknown = false;
  }
  assert.ok(existsSync(join(path, "notes.md")));
});

test("the preview labels changed, untracked and ignored paths", async () => {
  const path = dirtyWorktree();
  writeFileSync(join(path, "README.md"), "edited\n");
  writeFileSync(join(path, "debug.log"), "ignored output\n");
  await sweep.sweep();

  const shown = await preview(path);
  const files = shown.body.consequences.find((line) => line.startsWith("Files it deletes include: "));
  assert.equal(files, "Files it deletes include: README.md (changed), notes.md (untracked), debug.log (ignored).");
});

/** The `Files it deletes include:` line of a fresh preview of `path`. */
async function filesLine(path: string): Promise<string> {
  const line = (await preview(path)).body.consequences.find((each) => each.startsWith("Files it deletes include: "));
  assert.ok(line);
  return line;
}

function names(line: string): string[] {
  return line.slice("Files it deletes include: ".length).replace(/(, and more)?\.$/, "").split(", ");
}

test("the preview names at most ten deleted paths and says when there are more", async () => {
  const worktree = join(worktreesDir, `many-${trees++}`);
  git(repo, "worktree", "add", "-q", "-b", `harness/many-${trees}`, worktree);
  for (let index = 0; index <= 10; index += 1) writeFileSync(join(worktree, `file-${String(index).padStart(2, "0")}.md`), "x\n");
  const eleven = join(checksDir, "eleven-files");
  const ten = join(checksDir, "ten-files");
  for (const [folder, count] of [[eleven, 11], [ten, 10]] as const) {
    mkdirSync(join(folder, "nested"), { recursive: true });
    for (let index = 0; index < count; index += 1) writeFileSync(join(folder, index % 2 ? "nested" : "", `file-${index}.txt`), "x\n");
  }
  await sweep.sweep();

  const fromStatus = await filesLine(worktree);
  assert.ok(fromStatus.endsWith(", and more."), fromStatus);
  assert.deepEqual(names(fromStatus), Array.from({ length: 10 }, (_, index) => `file-${String(index).padStart(2, "0")}.md (untracked)`));

  const fromWalk = await filesLine(eleven);
  assert.ok(fromWalk.endsWith(", and more."), fromWalk);
  assert.equal(names(fromWalk).length, 10);

  const exactlyTen = await filesLine(ten);
  assert.ok(!exactlyTen.includes("and more"), exactlyTen);
  assert.equal(names(exactlyTen).length, 10);
});

test("Execute refuses any write after the preview, including ones the preview's file list cannot show", async () => {
  // Each edit leaves the listed work and the first ten listed paths exactly as they were.
  const edits: Array<{ name: string; before: (path: string) => void; after: (path: string) => void; kept: string }> = [
    {
      name: "an already-modified tracked file edited again",
      before: (path) => writeFileSync(join(path, "README.md"), "edited\n"),
      after: (path) => writeFileSync(join(path, "README.md"), "edited a second time\n"),
      kept: "README.md",
    },
    {
      name: "a new file once ten paths are already listed",
      before: (path) => {
        for (let index = 0; index < 10; index += 1) writeFileSync(join(path, `a-${index}.md`), "x\n");
      },
      after: (path) => writeFileSync(join(path, "z-late.md"), "written after the preview\n"),
      kept: "z-late.md",
    },
    {
      name: "more output in an ignored file",
      before: (path) => writeFileSync(join(path, "debug.log"), "first\n"),
      after: (path) => writeFileSync(join(path, "debug.log"), "first\nsecond\n"),
      kept: "debug.log",
    },
  ];
  for (const edit of edits) {
    const path = dirtyWorktree();
    edit.before(path);
    await sweep.sweep();
    const shown = await preview(path);
    assert.equal(shown.body.allowed, true, `${edit.name}: ${shown.body.blockers.join("; ")}`);
    edit.after(path);
    const shownAgain = await preview(path);
    assert.deepEqual(shownAgain.body.consequences, shown.body.consequences, `${edit.name}: the visible preview is unchanged`);

    const done = await execute(shown.body.token, ["dirty"]);
    assert.equal(done.failed?.changed, true, edit.name);
    assert.ok(existsSync(join(path, edit.kept)), edit.name);
  }
});

test("a fresh sweep never joins a pass that started before it, so a Kill's retry sees the process gone", async () => {
  const directory = join(root, "fresh-state", "worktrees");
  const path = join(directory, "held");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "scratch.md"), "still open in a shell\n");
  let alive = true;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  let firstRead = () => {};
  const reading = new Promise<void>((resolve) => { firstRead = resolve; });
  const gated = new OrphanTreeSweep({
    directories: [directory],
    stateHome: join(root, "fresh-state"),
    referencedPaths: () => [],
    slotPaths: () => [],
    sourceRepositories: () => [],
    inFlight: new InFlightTrees(),
    occupancy: async (paths) => {
      // The first pass reads occupancy while the process lives, then stalls past the kill.
      const occupants = alive
        ? [{ pid: 4242, ppid: 1, startRaw: "Tue Oct 27 09:00:00 2026", startMs: 0, command: "node", cwd: path, knownOwner: null }]
        : [];
      if (reads++ === 0) {
        firstRead();
        await gate;
      }
      return new Map(paths.map((each) => [each, { status: "known", occupants }]));
    },
    now: () => Date.now() + 2 * ORPHAN_TREE_GRACE_MS,
  });

  const running = gated.sweep();
  await reading;
  alive = false;
  assert.equal(gated.sweep(), running, "a plain sweep joins the pass in flight");
  const fresh = gated.sweepFresh();
  release();
  assert.ok((await running).skipped.some((each) => each.path === path && each.reason === "occupied"));
  assert.deepEqual((await fresh).kept.map((tree) => tree.path), [path], "the fresh pass sees the folder free and keeps it");
});

test("the signature stops at regenerable directories, which a discard deletes either way", async () => {
  const path = dirtyWorktree();
  const dependency = join(path, "node_modules", "pkg", "index.js");
  mkdirSync(join(path, "node_modules", "pkg"), { recursive: true });
  writeFileSync(dependency, "module.exports = 1;\n");
  await sweep.sweep();
  const shown = await preview(path);
  // A write deep inside node_modules/ is not walked, so it does not stale the preview.
  writeFileSync(dependency, "module.exports = 2; // rebuilt\n");
  const done = await execute(shown.body.token, ["dirty"]);
  assert.equal(done.failed, null, done.failed?.error ?? "");
  assert.equal(existsSync(path), false);
});

test("the preview and its signature take the delete rule: the pool's seed paths are regenerable", async () => {
  const commonDirectory = realpathSync(join(repo, ".git"));
  writeFileSync(join(commonDirectory, "info", "exclude"), ".yarn/install-state.gz\nvendor-cache/\n");
  setWorktreesConfig({
    repositories: {
      [commonDirectory]: {
        claim: WorktreeClaimSchema.parse({ steps: [{ argv: ["yarn", "install"] }], seed: { paths: [".yarn/install-state.gz", "vendor-cache"] } }),
      },
    },
  });
  try {
    // Kept for its unpushed commit; the install state and the seeded cache lose no work.
    const path = join(worktreesDir, `seeded-${trees++}`);
    git(repo, "worktree", "add", "-q", "-b", `harness/seeded-${trees}`, path);
    writeFileSync(join(path, "README.md"), "local only\n");
    git(path, "commit", "-qam", "local only");
    mkdirSync(join(path, ".yarn"));
    writeFileSync(join(path, ".yarn", "install-state.gz"), "state\n");
    const cached = join(path, "vendor-cache", "pkg", "index.js");
    mkdirSync(join(path, "vendor-cache", "pkg"), { recursive: true });
    writeFileSync(cached, "1\n");
    await sweep.sweep();

    const shown = await preview(path);
    assert.ok(shown.body.consequences.includes(`Discards the work in ${path}: checkout has unpublished commits.`), shown.body.consequences.join("\n"));
    assert.equal(await filesLine(path), "Files it deletes include: .yarn/install-state.gz (regenerable), vendor-cache/ (regenerable).");
    // A write inside a seed path is not walked, so it does not stale the preview.
    writeFileSync(cached, "2 // reinstalled\n");
    const done = await execute(shown.body.token, ["dirty"]);
    assert.equal(done.failed, null, done.failed?.error ?? "");
    assert.equal(existsSync(path), false);
  } finally {
    setWorktreesConfig({ repositories: { [commonDirectory]: null } });
    writeFileSync(join(commonDirectory, "info", "exclude"), "");
  }
});

test("the preview and its signature never treat what the seed excludes as regenerable", async () => {
  const commonDirectory = realpathSync(join(repo, ".git"));
  writeFileSync(join(commonDirectory, "info", "exclude"), "vendor-cache/\n");
  setWorktreesConfig({
    repositories: {
      [commonDirectory]: {
        claim: WorktreeClaimSchema.parse({ steps: [{ argv: ["yarn", "install"] }], seed: { paths: ["vendor-cache"], exclude: ["vendor-cache/secrets/*"] } }),
      },
    },
  });
  try {
    const path = join(worktreesDir, `excluded-${trees++}`);
    git(repo, "worktree", "add", "-q", "-b", `harness/excluded-${trees}`, path);
    const token = join(path, "vendor-cache", "secrets", "token");
    mkdirSync(join(path, "vendor-cache", "secrets"), { recursive: true });
    writeFileSync(token, "first\n");
    await sweep.sweep();

    const shown = await preview(path);
    assert.equal(shown.status, 200, "the sweep kept the tree for it");
    assert.ok(shown.body.consequences.includes(`Discards the work in ${path}: checkout has uncommitted, untracked or ignored work.`), shown.body.consequences.join("\n"));
    assert.equal(await filesLine(path), "Files it deletes include: vendor-cache/ (ignored).");
    // The walk goes on past the seed path, so a later write to the excluded file stales the preview.
    writeFileSync(token, "first\nsecond\n");
    const done = await execute(shown.body.token, ["dirty"]);
    assert.notEqual(done.status === 202 && done.failed === null, true, "Execute must refuse");
    assert.ok(existsSync(token));
  } finally {
    setWorktreesConfig({ repositories: { [commonDirectory]: null } });
    writeFileSync(join(commonDirectory, "info", "exclude"), "");
  }
});

test("an entry the walk cannot read is part of the signature, not a failed preview", async () => {
  const path = join(checksDir, "unreadable-inside");
  const locked = join(path, "locked");
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(path, "notes.md"), "kept\n");
  writeFileSync(join(locked, "secret.md"), "x\n");
  await sweep.sweep();
  const readable = await preview(path);
  assert.equal(readable.status, 200);
  chmodSync(locked, 0o000);
  try {
    const shown = await preview(path);
    assert.equal(shown.status, 200, shown.body.error ?? "");
    assert.equal(shown.body.allowed, true, shown.body.blockers.join("; "));
    // The tree now reads differently, so the earlier preview is stale.
    assert.equal((await execute(readable.body.token, ["dirty"])).failed?.changed, true);
  } finally {
    chmodSync(locked, 0o755);
  }
  assert.ok(existsSync(join(locked, "secret.md")));
});
