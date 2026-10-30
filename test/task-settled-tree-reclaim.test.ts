import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const { setWorktreesConfig } = await import("../src/server/worktrees/config.ts");
const { WorktreeClaimSchema } = await import("../src/shared/protocol.ts");

type Manager = InstanceType<typeof TaskManager>;

const roots: string[] = [];
after(() => {
  rmSync(home, { recursive: true, force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Real git: the clean rule is about what git reports, so nothing here is stubbed. */
const IGNORED = ["node_modules/", "dist/", ".evidence/", "e2e/.artifacts/", ".env", ".yarn/install-state.gz"].join("\n");

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

type Tree = { repoRoot: string; worktree: string; branch: string };
type StartupDeps = NonNullable<ConstructorParameters<typeof TaskManager>[5]>;

const unoccupied: NonNullable<StartupDeps["occupancy"]> = async (paths) =>
  new Map(paths.map((path) => [path, { status: "known" as const, occupants: [] }]));

/** A task whose agent died with the daemon, as a restart finds it, and the manager that settles it. */
function restartWith(id: string, tree: Tree, options: {
  /** A second repository's tree, attached to the same task. */
  attached?: Tree;
  occupancy?: StartupDeps["occupancy"];
  returnBlocker?: StartupDeps["returnBlocker"];
  provider?: "git" | "mission" | "treehouse";
} = {}): {
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
    provider: options.provider ?? "git",
    sessionId: `proc:${id}`,
    extraRepos: options.attached
      ? [{
          repoRoot: options.attached.repoRoot,
          worktreePath: options.attached.worktree,
          branch: options.attached.branch,
          provider: "git",
          worktreeLeaseId: null,
          baseSha: null,
          prUrl: null,
          prState: null,
          mergedAt: null,
        }]
      : [],
  }));
  const manager = new TaskManager(
    registry,
    undefined,
    { taskLiveness: () => false } as never,
    undefined,
    undefined,
    {
      occupancy: options.occupancy ?? unoccupied,
      ...(options.returnBlocker ? { returnBlocker: options.returnBlocker } : {}),
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

/** Settle `id`, then wait for every queued startup job, its clean check included, to finish. */
async function settled(registry: InstanceType<typeof Registry>, manager: Manager, id: string): Promise<void> {
  await until(() => registry.getTask(id)?.status === "failed", "the task was never settled");
  await manager.settleWorktreeReturns();
}

const OCCUPIED: Array<{ name: string; occupancy: NonNullable<StartupDeps["occupancy"]> }> = [
  {
    name: "a process occupies",
    occupancy: async (paths) => new Map(paths.map((path) => [path, {
      status: "known" as const,
      occupants: [{ pid: 4242, ppid: 1, startRaw: "leaked", startMs: 1, command: "node vite", cwd: path, knownOwner: null }],
    }])),
  },
  {
    name: "cannot be inspected for processes",
    occupancy: async (paths) => new Map(paths.map((path) => [path, { status: "unknown" as const, reason: "lsof timed out" }])),
  },
];

for (const { name, occupancy } of OCCUPIED) {
  test(`a clean settled tree that ${name} is neither reclaimed nor listed`, async () => {
    const tree = settledWorktree(`occupied-${name.split(" ")[0]}`);
    write(tree.worktree, "node_modules/left-pad/index.js");
    const id = `settled-occupied-${name.split(" ")[0]}`;
    const { registry, manager } = restartWith(id, tree, { occupancy });

    await settled(registry, manager, id);
    assert.equal(registry.getTask(id)?.worktreePath, tree.worktree, "an occupied tree is kept");
    assert.equal(existsSync(tree.worktree), true);
    assert.equal(registry.getTask(id)?.error, "the agent's session did not survive a restart");
    // Clean, so not a dirty settled tree: the process is the orphan report's to name.
    assert.equal(listed(manager, id), false);
  });
}

test("a settled task is reclaimed only when every tree it holds is clean", async () => {
  const clean = settledWorktree("multi-clean");
  write(clean.worktree, "dist/bundle.js");
  const dirty = settledWorktree("multi-dirty");
  write(dirty.worktree, ".env", "TOKEN=1\n");
  const id = "settled-multi";
  const { registry, manager } = restartWith(id, clean, { attached: dirty });

  await until(() => listed(manager, id), "the task with one dirty tree was never listed");
  const task = registry.getTask(id)!;
  assert.equal(task.worktreePath, clean.worktree, "the clean primary is kept with its dirty sibling");
  assert.equal(task.extraRepos[0]?.worktreePath, dirty.worktree);
  assert.equal(existsSync(clean.worktree), true);
  assert.equal(existsSync(dirty.worktree), true);
  const [problem] = health(manager, {}, 7_000).problems
    .filter((each) => each.id.startsWith(`dirty-settled-tree:${id}:`));
  assert.match(problem!.message, new RegExp(`work left in ${dirty.worktree} \\(checkout has uncommitted, untracked or ignored work\\)`));
});

test("a settled tree Git cannot read keeps its window and is listed", async () => {
  const tree = settledWorktree("unreadable");
  const id = "settled-unreadable";
  const { registry, manager } = restartWith(id, tree, {
    returnBlocker: async () => "working tree could not be read",
  });

  await until(() => listed(manager, id), "the unreadable tree was never listed");
  assert.equal(registry.getTask(id)?.worktreePath, tree.worktree);
  assert.equal(existsSync(tree.worktree), true);
  const [problem] = health(manager, {}, 8_000).problems
    .filter((each) => each.id.startsWith(`dirty-settled-tree:${id}:`));
  assert.match(problem!.message, /\(working tree could not be read\)/);
});

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

/** Give the pool that owns `tree` a claim whose seed lists the yarn install state. */
function claimSeeds(tree: Tree): void {
  setWorktreesConfig({
    repositories: {
      [realpathSync(join(tree.repoRoot, ".git"))]: {
        claim: WorktreeClaimSchema.parse({ steps: [{ argv: ["yarn", "install"] }], seed: { paths: ["node_modules", ".yarn/install-state.gz"] } }),
      },
    },
  });
}

test("a disposable tree holding its pool's seed path is reclaimed; one also holding .env is listed", async () => {
  const seeded = settledWorktree("seed-path");
  claimSeeds(seeded);
  write(seeded.worktree, ".yarn/install-state.gz");
  const { registry, manager } = restartWith("settled-seed-path", seeded);
  await until(() => registry.getTask("settled-seed-path")?.worktreePath === null, "the seed-path tree was not reclaimed");
  assert.equal(existsSync(seeded.worktree), false);
  assert.equal(listed(manager, "settled-seed-path"), false);

  const env = settledWorktree("seed-path-env");
  claimSeeds(env);
  write(env.worktree, ".yarn/install-state.gz");
  write(env.worktree, ".env", "TOKEN=1\n");
  const kept = restartWith("settled-seed-path-env", env);
  await until(() => listed(kept.manager, "settled-seed-path-env"), "the tree holding .env was never listed");
  assert.equal(kept.registry.getTask("settled-seed-path-env")?.worktreePath, env.worktree);
  assert.equal(existsSync(join(env.worktree, ".env")), true);
  const [problem] = health(kept.manager, {}, 9_000).problems
    .filter((each) => each.id.startsWith("dirty-settled-tree:settled-seed-path-env:"));
  assert.equal(problem!.kind, "dirty-settled-tree");
});

test("a tree whose pool has no claim keeps its install state as work", async () => {
  const tree = settledWorktree("no-claim");
  write(tree.worktree, ".yarn/install-state.gz");
  const { registry, manager } = restartWith("settled-no-claim", tree);
  await until(() => listed(manager, "settled-no-claim"), "the tree was never listed");
  assert.equal(registry.getTask("settled-no-claim")?.worktreePath, tree.worktree);
});

test("a disposable or Treehouse tree takes the delete rule's seed paths; a pool slot keeps its folder and never does", async () => {
  for (const provider of ["git", "treehouse", "mission"] as const) {
    const tree = settledWorktree(`rule-${provider}`);
    claimSeeds(tree);
    const asked: Array<Parameters<NonNullable<StartupDeps["returnBlocker"]>>[1]> = [];
    const id = `settled-rule-${provider}`;
    const { manager } = restartWith(id, tree, {
      provider,
      returnBlocker: async (path, options) => {
        // Earlier cases' tasks persist in this file's database and are settled here too.
        if (path === tree.worktree) asked.push(options);
        return "checkout has uncommitted, untracked or ignored work";
      },
    });
    await until(() => listed(manager, id), `the ${provider} tree was never listed`);
    // A pool slot takes the reset rule through its manager, so the delete rule's probe never runs.
    assert.deepEqual(asked, provider === "mission"
      ? []
      : [{ regenerableIgnored: true, seed: { paths: ["node_modules", ".yarn/install-state.gz"], exclude: [] } }]);
  }
});
