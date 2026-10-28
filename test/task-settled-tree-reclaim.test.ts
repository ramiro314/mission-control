import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";
import { mkTask } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-settled-tree-"));
process.env.HARNESS_HOME = home;

const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { StorageHealthService } = await import("../src/server/storage-health.ts");
const { databaseBackupStatusFrom } = await import("../src/shared/database-backups.ts");

type Manager = InstanceType<typeof TaskManager>;

const roots: string[] = [];
after(() => {
  rmSync(home, { recursive: true, force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Real git: the clean rule is about what git reports, so nothing here is stubbed. */
const IGNORED = ["node_modules/", "dist/", ".evidence/", "e2e/.artifacts/", ".env"].join("\n");

/**
 * A pushed `.gitignore` in a fresh origin, and a `harness/*` worktree of it at origin's head,
 * so a tree nobody touches is clean: nothing uncommitted, untracked or unpushed.
 */
function settledWorktree(name: string): { repoRoot: string; worktree: string; branch: string } {
  const { root, clone } = mkOriginAndClone(`mission-settled-${name}-`);
  roots.push(root);
  writeFileSync(join(clone, ".gitignore"), `${IGNORED}\n`);
  gitIn(clone, "add", ".gitignore");
  gitIn(clone, "commit", "-qm", "ignore");
  // A non-bare origin refuses its checked-out branch, so the base is published beside it.
  gitIn(clone, "push", "-q", "origin", "HEAD:refs/heads/settled-base");
  gitIn(clone, "fetch", "-q", "origin");
  const worktree = join(root, "tree");
  const branch = `harness/${name}`;
  gitIn(clone, "worktree", "add", "-q", "-b", branch, worktree);
  return { repoRoot: clone, worktree, branch };
}

function write(worktree: string, relative: string, body = "x\n"): void {
  mkdirSync(dirname(join(worktree, relative)), { recursive: true });
  writeFileSync(join(worktree, relative), body);
}

async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

/** A task whose agent died with the daemon, as a restart finds it, and the manager that settles it. */
function restartWith(id: string, tree: { repoRoot: string; worktree: string; branch: string }): {
  registry: InstanceType<typeof Registry>;
  manager: Manager;
  changes: () => number;
} {
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id,
    title: `Settled ${id}`,
    status: "running",
    dispatchedAt: 5_000,
    repoRoot: tree.repoRoot,
    worktreePath: tree.worktree,
    branch: tree.branch,
    provider: "git",
    sessionId: `proc:${id}`,
  }));
  const manager = new TaskManager(
    registry,
    undefined,
    { taskLiveness: () => false } as never,
    undefined,
    undefined,
    {
      occupancy: async (paths) => new Map(paths.map((path) => [path, { status: "known" as const, occupants: [] }])),
    },
  );
  let changes = 0;
  manager.registerSettledTreesListener(() => {
    changes += 1;
  });
  return { registry, manager, changes: () => changes };
}

/** Whether this task's kept tree is listed yet. Other cases' tasks may be listed first. */
function listed(manager: Manager, id: string): boolean {
  return (manager.dirtySettledTreeProblems().firstSeen ?? [])
    .some((each) => each.subject === `dirty-settled-tree:${id}`);
}

function health(manager: Manager, record: Record<string, { firstSeenAt: number; lastSeenAt: number }>, now: number) {
  return new StorageHealthService({
    backups: { status: () => databaseBackupStatusFrom(undefined), keptCopies: () => [] },
    publish: () => {},
    sources: [() => manager.dirtySettledTreeProblems()],
    now: () => now,
    readFirstSeen: () => record,
    writeFirstSeen: (next) => {
      for (const key of Object.keys(record)) delete record[key];
      Object.assign(record, next);
    },
  }).recompute();
}

test("a settled task whose tree holds only regenerable ignored directories is reclaimed at once", async () => {
  const tree = settledWorktree("regenerable");
  write(tree.worktree, "node_modules/left-pad/index.js");
  write(tree.worktree, "dist/bundle.js");
  write(tree.worktree, "packages/web/node_modules/react/index.js");
  const { registry, manager } = restartWith("settled-regenerable", tree);

  await until(() => registry.getTask("settled-regenerable")?.worktreePath === null, "the clean tree was not reclaimed");
  const task = registry.getTask("settled-regenerable")!;
  assert.equal(task.status, "failed", "reclaim keeps the settled status and outcome");
  assert.equal(task.error, "the agent's session did not survive a restart");
  assert.equal(existsSync(tree.worktree), false, "the checkout is gone from disk");
  assert.equal(gitIn(tree.repoRoot, "branch", "--list", tree.branch), "", "its harness branch is deleted");
  assert.deepEqual(manager.dirtySettledTreeProblems(), { problems: [], firstSeen: [], goneSubjects: [] });
});

const KEPT: Array<{ name: string; reason: RegExp; dirty: (worktree: string) => void }> = [
  { name: "uncommitted", reason: /uncommitted/, dirty: (worktree) => write(worktree, "keep.txt", "edited\n") },
  { name: "untracked", reason: /uncommitted/, dirty: (worktree) => write(worktree, "notes.md") },
  {
    name: "unpushed",
    reason: /unpublished commits/,
    dirty: (worktree) => {
      write(worktree, "feature.ts");
      gitIn(worktree, "add", "feature.ts");
      gitIn(worktree, "commit", "-qm", "local only");
    },
  },
  { name: "evidence", reason: /ignored work/, dirty: (worktree) => write(worktree, ".evidence/report.md") },
  { name: "artifacts", reason: /ignored work/, dirty: (worktree) => write(worktree, "e2e/.artifacts/shot.png") },
  { name: "env", reason: /ignored work/, dirty: (worktree) => write(worktree, ".env", "TOKEN=1\n") },
];

for (const { name, reason, dirty } of KEPT) {
  test(`a settled task whose tree holds ${name} work keeps its window and is listed`, async () => {
    const tree = settledWorktree(name);
    write(tree.worktree, "node_modules/left-pad/index.js");
    dirty(tree.worktree);
    const id = `settled-${name}`;
    const { registry, manager } = restartWith(id, tree);

    await until(() => listed(manager, id), "the kept tree was never listed");
    const task = registry.getTask(id)!;
    assert.equal(task.status, "failed");
    assert.equal(task.worktreePath, tree.worktree, "the tree is retained");
    assert.equal(existsSync(tree.worktree), true);

    // Earlier cases' rows persist in this file's database, so a fresh registry settles them too.
    const record = {};
    const mine = (now: number) => health(manager, record, now).problems
      .filter((each) => each.id.startsWith(`dirty-settled-tree:${id}:`));
    const problems = mine(42_000);
    assert.equal(problems.length, 1);
    const [problem] = problems;
    assert.equal(problem!.id, `dirty-settled-tree:${id}:42000`);
    assert.equal(problem!.kind, "dirty-settled-tree");
    assert.equal(problem!.bannered, false, "a tree kept by policy is listed in Storage only");
    assert.match(problem!.message, new RegExp(`Settled ${id} settled with work left in .*tree`));
    assert.match(problem!.message, reason);
    assert.deepEqual(problem!.link, { target: "worktrees" }, "a git tree has no slot card to link to");

    // A later pass keeps the first-seen time, so the id survives a recompute.
    assert.deepEqual(mine(99_000).map((each) => each.id), [`dirty-settled-tree:${id}:42000`]);
  });
}

test("a kept tree reclaimed by hand takes its problem and first-seen entry with it", async () => {
  const tree = settledWorktree("reclaimed-by-hand");
  write(tree.worktree, ".env", "TOKEN=1\n");
  const id = "settled-by-hand";
  const { registry, manager, changes } = restartWith(id, tree);
  await until(() => listed(manager, id), "the kept tree was never listed");
  const record: Record<string, { firstSeenAt: number; lastSeenAt: number }> = {};
  const subject = `dirty-settled-tree:${id}`;
  health(manager, record, 1_000);
  assert.ok(record[subject], "the kept tree is stamped first-seen");

  const before = changes();
  assert.deepEqual(await manager.reclaim(id), { ok: true });
  assert.equal(registry.getTask(id)?.worktreePath, null);
  assert.ok(changes() > before, "storage health is asked again once the tree is gone");
  assert.equal(health(manager, record, 2_000).problems.some((each) => each.id.startsWith(`${subject}:`)), false);
  assert.equal(record[subject], undefined, "a gone subject drops its first-seen entry at once");
});
