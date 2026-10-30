import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { Registry } from "../src/server/registry.ts";
import { TaskManager } from "../src/server/tasks.ts";
import { stubRun } from "../src/server/util/exec.ts";
import { worktreeRepositoryIdentity } from "../src/server/util/git.ts";
import { WorktreeManager } from "../src/server/worktrees/manager.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import {
  LegacyTreehouseAdapter,
  LegacyTreehouseService,
} from "../src/server/worktrees/legacy-treehouse.ts";
import type { WorktreeOccupancy, WorktreeOccupant } from "../src/server/worktrees/occupancy.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";
import { mkTask } from "./helpers/session-fixture.ts";

type Run = typeof import("../src/server/util/exec.ts").run;

const db = openDb();
const changed: number[] = [];
const occupancy = (paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> =>
  Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants: [] }])));
const manager = new WorktreeManager(db, {
  occupancy,
  resolvePolicy: () => ({ enabled: true, maxSlots: 2, setupArgv: null }),
  publishChanged: () => changed.push(Date.now()),
});
const checks = new CheckLeaseManager(db, { manager, legacy: new LegacyTreehouseService(db) });
const operations = new WorktreeOperationsService(manager, {
  legacy: new LegacyTreehouseService(db),
  tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
  checks,
  checkRecovery: async () => "unknown",
  notifyChanged: () => changed.push(Date.now()),
  diskBytes: async () => 1024,
});

after(() => db.exec("DELETE FROM task_repos; DELETE FROM tasks; DELETE FROM worktree_slots; DELETE FROM worktree_pools; DELETE FROM app_config WHERE key = 'worktrees';"));

test("inventory skips recursive disk walks and a preview measures only its fixed target", async () => {
  const { clone } = mkOriginAndClone("mission-worktree-lazy-size-");
  const acquired = await manager.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "manual", key: "manual-lazy-size" },
  });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  const reads: string[] = [];
  const measured = new WorktreeOperationsService(manager, {
    legacy: new LegacyTreehouseService(db),
    tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
    checks,
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async (path) => {
      reads.push(path);
      return 2048;
    },
  });

  const inventory = await measured.inventory();
  assert.deepEqual(reads, [], "listing must not recursively walk every checkout");
  const listed = inventory.repositories.flatMap((repo) => repo.slots)
    .find((slot) => slot.id === acquired.lease.slotId);
  assert.equal(listed?.diskBytes, null);

  const preview = await measured.preview({ action: "return", slotId: acquired.lease.slotId });
  assert.deepEqual(reads, [acquired.lease.path]);
  assert.equal(preview.affected.find((item) => item.id === acquired.lease.slotId)?.diskBytes, 2048);
});

test("preview tokens bind exact state, require acknowledgements, and are single use", async () => {
  const { clone } = mkOriginAndClone("mission-worktree-action-");
  const acquired = await manager.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "manual", key: "manual-action" },
  });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;

  const dirtyPath = join(acquired.lease.path, "keep-me.txt");
  writeFileSync(dirtyPath, "uncommitted\n");
  const preview = await operations.preview({ action: "return", slotId: acquired.lease.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.deepEqual(preview.requiredAcknowledgements, ["dirty"]);
  await assert.rejects(
    operations.execute(preview.token, []),
    (error: unknown) => error instanceof Error && /missing acknowledgement/.test(error.message),
  );
  await assert.rejects(
    operations.execute(preview.token, ["dirty"]),
    (error: unknown) => error instanceof Error && /expired|valid/.test(error.message),
    "a refused execute still consumes the token",
  );

  const overAcknowledged = await operations.preview({ action: "return", slotId: acquired.lease.slotId });
  await assert.rejects(
    operations.execute(overAcknowledged.token, ["dirty", "unlanded"]),
    (error: unknown) => error instanceof Error && /unexpected acknowledgement/.test(error.message),
    "an acknowledgement the preview did not require cannot become a later destructive override",
  );

  const accepted = await operations.preview({ action: "return", slotId: acquired.lease.slotId });
  assert.deepEqual(await operations.execute(accepted.token, ["dirty"]), {
    ok: true,
    action: "return",
    message: "Worktree returned to warm capacity.",
  });
  assert.equal(manager.lookupLease({ leaseId: acquired.lease.leaseId }).state, "released");
  assert.equal(changed.length > 0, true);
  assert.equal(existsSync(dirtyPath), false, "fixture file was removed by the manager reset");
});

test("safe prune removes only a fixed clean, merged, unreferenced candidate", async () => {
  const { clone } = mkOriginAndClone("mission-worktree-prune-");
  const acquired = await manager.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "manual", key: "manual-prune" },
  });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  assert.equal((await manager.release(acquired.lease, { ownerAuthorized: true, requireClean: true })).outcome, "released");

  const preview = await operations.preview({ action: "prune", poolId: acquired.lease.poolId, mode: "safe" });
  assert.equal(preview.allowed, true);
  assert.equal(preview.affected.some((target) => target.id === acquired.lease.slotId), true);
  await operations.execute(preview.token, []);
  assert.equal(manager.store.slot(acquired.lease.slotId), null);
});

test("bulk prune preview measures only safe candidates and measures them concurrently", async () => {
  const { clone } = mkOriginAndClone("mission-worktree-prune-size-");
  const head = gitIn(clone, "rev-parse", "HEAD");
  const first = await manager.acquire({
    repositoryPath: clone,
    baseSha: head,
    owner: { kind: "manual", key: "prune-size-1" },
  });
  const second = await manager.acquire({
    repositoryPath: clone,
    baseSha: head,
    owner: { kind: "manual", key: "prune-size-2" },
  });
  assert.equal(first.outcome, "acquired");
  assert.equal(second.outcome, "acquired");
  if (first.outcome !== "acquired" || second.outcome !== "acquired") return;
  assert.equal((await manager.release(first.lease, { ownerAuthorized: true, requireClean: true })).outcome, "released");
  assert.equal((await manager.release(second.lease, { ownerAuthorized: true, requireClean: true })).outcome, "released");

  const reads: string[] = [];
  let releaseReads!: () => void;
  const readsReleased = new Promise<void>((resolve) => { releaseReads = resolve; });
  let reportFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { reportFirstStarted = resolve; });
  let reportBothStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => { reportBothStarted = resolve; });
  const measured = new WorktreeOperationsService(manager, {
    legacy: new LegacyTreehouseService(db),
    tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
    checks,
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async (path) => {
      reads.push(path);
      if (reads.length === 1) reportFirstStarted();
      if (reads.length === 2) reportBothStarted();
      await readsReleased;
      return 4096;
    },
  });

  const pendingPreview = measured.preview({ action: "prune", poolId: first.lease.poolId, mode: "safe" });
  await firstStarted;
  const startedInParallel = await Promise.race([
    bothStarted.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  releaseReads();
  assert.equal(startedInParallel, true, "all fixed candidate size reads should start before any one finishes");
  const preview = await pendingPreview;
  assert.deepEqual(new Set(reads), new Set([first.lease.path, second.lease.path]));
  assert.deepEqual(new Set(preview.affected.map((target) => target.id)), new Set([
    first.lease.slotId,
    second.lease.slotId,
  ]));
  assert.equal(preview.affected.every((target) => target.diskBytes === 4096), true);
});

test("pool Destroy binds a fixed slot set and emits one completed-action invalidation", async () => {
  const { clone } = mkOriginAndClone("mission-worktree-pool-destroy-");
  const head = gitIn(clone, "rev-parse", "HEAD");
  const first = await manager.acquire({ repositoryPath: clone, baseSha: head, owner: { kind: "manual", key: "pool-destroy-1" } });
  const second = await manager.acquire({ repositoryPath: clone, baseSha: head, owner: { kind: "manual", key: "pool-destroy-2" } });
  assert.equal(first.outcome, "acquired");
  assert.equal(second.outcome, "acquired");
  if (first.outcome !== "acquired" || second.outcome !== "acquired") return;
  await manager.release(first.lease, { ownerAuthorized: true, requireClean: true });
  await manager.release(second.lease, { ownerAuthorized: true, requireClean: true });

  const preview = await operations.preview({
    action: "destroy",
    target: { kind: "pool", poolId: first.lease.poolId },
  });
  assert.equal(preview.allowed, true);
  assert.deepEqual(new Set(preview.affected.map((target) => target.id)), new Set([first.lease.slotId, second.lease.slotId]));
  const before = changed.length;
  await operations.execute(preview.token, []);
  assert.equal(changed.length, before + 1);
  assert.equal(manager.store.slot(first.lease.slotId), null);
  assert.equal(manager.store.slot(second.lease.slotId), null);
});

test("a changed slot version invalidates the preview before any action runs", async () => {
  const { clone } = mkOriginAndClone("mission-worktree-stale-");
  const acquired = await manager.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "manual", key: "manual-stale" },
  });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  const preview = await operations.preview({ action: "return", slotId: acquired.lease.slotId });
  // updateObserved changes diagnostics, not the slot version. Change only the version so
  // this checks the target binding independently of the global inventory revision.
  db.prepare("UPDATE worktree_slots SET version = version + 1 WHERE id = ?").run(acquired.lease.slotId);
  await assert.rejects(
    operations.execute(preview.token, []),
    (error: unknown) => error instanceof Error && /changed after preview/.test(error.message),
  );
});

test("task and check slots delegate cleanup to their domain owners", async () => {
  const taskRepo = mkOriginAndClone("mission-worktree-task-action-").clone;
  const taskLease = await manager.acquire({
    repositoryPath: taskRepo,
    baseSha: gitIn(taskRepo, "rev-parse", "HEAD"),
    owner: { kind: "task", key: "task-settings:0" },
  });
  assert.equal(taskLease.outcome, "acquired");
  if (taskLease.outcome !== "acquired") return;
  const secondaryRepo = mkOriginAndClone("mission-worktree-task-secondary-").clone;
  const secondaryLease = await manager.acquire({
    repositoryPath: secondaryRepo,
    baseSha: gitIn(secondaryRepo, "rev-parse", "HEAD"),
    owner: { kind: "task", key: "task-settings:1" },
  });
  assert.equal(secondaryLease.outcome, "acquired");
  if (secondaryLease.outcome !== "acquired") return;
  writeFileSync(join(secondaryLease.lease.path, "secondary-draft.txt"), "keep this visible\n");
  let taskReclaims = 0;
  const delegated = new WorktreeOperationsService(manager, {
    legacy: new LegacyTreehouseService(db),
    tasks: {
      get: (id) => id === "task-settings"
        ? {
            id,
            title: "Settings task",
            resources: [{
              position: 0,
              repoRoot: taskRepo,
              path: taskLease.lease.path,
              provider: "mission",
              leaseId: taskLease.lease.leaseId,
              branch: null,
            }, {
              position: 1,
              repoRoot: secondaryRepo,
              path: secondaryLease.lease.path,
              provider: "mission",
              leaseId: secondaryLease.lease.leaseId,
              branch: null,
            }],
          }
        : null,
      reclaim: async (id) => {
        if (id === "task-settings") taskReclaims += 1;
        const released = await Promise.all([
          manager.release(taskLease.lease, { ownerAuthorized: true }),
          manager.release(secondaryLease.lease, { ownerAuthorized: true }),
        ]);
        const failure = released.find((result) => result.outcome !== "released");
        return { ok: !failure, ...(failure && "reason" in failure ? { error: failure.reason } : {}) };
      },
    },
    checks,
    checkRecovery: async () => "empty",
    notifyChanged: () => changed.push(Date.now()),
    diskBytes: async () => 0,
  });
  const taskPreview = await delegated.preview({ action: "return", slotId: taskLease.lease.slotId });
  assert.equal(taskPreview.allowed, true);
  assert.deepEqual(
    new Set(taskPreview.affected.map((target) => target.id)),
    new Set([taskLease.lease.slotId, secondaryLease.lease.slotId]),
    "TaskManager's full multi-repository cleanup scope is present in the preview",
  );
  assert.deepEqual(taskPreview.requiredAcknowledgements, ["dirty"]);
  await delegated.execute(taskPreview.token, ["dirty"]);
  assert.equal(taskReclaims, 1, "one task reclaim owns every affected repository");

  const checkRepo = mkOriginAndClone("mission-worktree-check-action-").clone;
  const attemptId = "check-settings";
  await checks.acquireForAttempt({
    attemptId,
    submissionId: "submission-settings",
    nodeId: "node-settings",
    repoRoot: checkRepo,
    headSha: gitIn(checkRepo, "rev-parse", "HEAD"),
  });
  const checkSlot = (await manager.status()).flatMap((pool) => pool.slots)
    .find((slot) => slot.slot.activeOwnerKind === "check" && slot.slot.activeOwnerKey === attemptId)!;
  const active = await delegated.preview({ action: "return", slotId: checkSlot.slot.id });
  assert.equal(active.allowed, false);
  assert.match(active.blockers.join(" "), /still active/);

  checks.handOffForReclaim(attemptId);
  const recoverable = await delegated.preview({ action: "return", slotId: checkSlot.slot.id });
  assert.equal(recoverable.allowed, true);
  await delegated.execute(recoverable.token, []);
  assert.equal(checks.unresolvedLeaseForNode("submission-settings", "node-settings"), false);
});

test("task previews bind attached disposable Git risks outside native inventory", async () => {
  const primaryRepo = mkOriginAndClone("mission-worktree-task-git-primary-").clone;
  const gitRepo = mkOriginAndClone("mission-worktree-task-git-secondary-").clone;
  const gitPath = join(gitRepo, "..", "task-git-secondary-worktree");
  const gitIdentity = worktreeRepositoryIdentity(gitRepo);
  assert.ok(gitIdentity);
  let gitDirty = true;
  const occupied = {
    pid: 42,
    ppid: 1,
    startRaw: "task-git-process",
    startMs: 1,
    command: "agent helper",
    cwd: gitPath,
    knownOwner: "task-settings-git",
  };
  const taskOccupancy = (paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> =>
    Promise.resolve(new Map(paths.map((path) => [
      path,
      { status: "known" as const, occupants: path === gitPath ? [occupied] : [] },
    ])));
  const taskManager = new WorktreeManager(db, {
    occupancy: taskOccupancy,
    resolvePolicy: () => ({ enabled: true, maxSlots: 2, setupArgv: null }),
  });
  const primary = await taskManager.acquire({
    repositoryPath: primaryRepo,
    baseSha: gitIn(primaryRepo, "rev-parse", "HEAD"),
    owner: { kind: "task", key: "task-settings-git:0" },
  });
  assert.equal(primary.outcome, "acquired");
  if (primary.outcome !== "acquired") return;
  let reclaimed = false;
  const delegated = new WorktreeOperationsService(taskManager, {
    legacy: new LegacyTreehouseService(db),
    tasks: {
      get: (id) => id === "task-settings-git"
        ? {
            id,
            title: "Task with disposable secondary",
            resources: [{
              position: 0,
              repoRoot: primaryRepo,
              path: primary.lease.path,
              provider: "mission",
              leaseId: primary.lease.leaseId,
              branch: null,
            }, {
              position: 1,
              repoRoot: gitRepo,
              path: gitPath,
              provider: "git",
              leaseId: null,
              branch: "harness/task-settings-git",
            }],
          }
        : null,
      reclaim: async () => {
        reclaimed = true;
        return { ok: true };
      },
    },
    checks,
    checkRecovery: async () => "unknown",
    notifyChanged: () => changed.push(Date.now()),
    diskBytes: async () => 0,
    occupancy: taskOccupancy,
    git: {
      inspect: async (path) => ({
        ok: true,
        value: {
          path,
          head: "a".repeat(40),
          dirty: gitDirty,
          commonDirectory: gitIdentity.gitCommonDirectory,
          detached: true,
        },
      }),
      observedDefaultSha: async () => ({ ok: true, value: "b".repeat(40) }),
      mergedInto: async () => ({ ok: true, value: false }),
    },
  });

  const preview = await delegated.preview({ action: "return", slotId: primary.lease.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.equal(preview.affected.some((target) => target.provider === "git" && target.path === gitPath), true);
  assert.deepEqual(new Set(preview.requiredAcknowledgements), new Set(["dirty", "unlanded"]));
  assert.equal(preview.risks.some((entry) => entry.key === "occupied"), true);
  assert.match(preview.consequences.join(" "), /1 process\(es\).*TaskManager stops its owned agent/);

  gitDirty = false;
  await assert.rejects(
    delegated.execute(preview.token, ["dirty", "unlanded"]),
    (error: unknown) => error instanceof Error && /changed after preview/.test(error.message),
    "a disposable secondary's Git change invalidates the task-wide token",
  );
  assert.equal(reclaimed, false);
});

test("a task Return states the discard of ignored work its slot's own dirty reading cannot see", async () => {
  // The settled-task case (D20): a restart kept this tree for its `.env` alone. Git status
  // without `--ignored` calls it clean, so the preview used to discard it with no word at all.
  const { origin, clone: repo } = mkOriginAndClone("mission-worktree-task-ignored-");
  writeFileSync(join(origin, ".gitignore"), "node_modules/\n.env\n");
  gitIn(origin, "add", ".gitignore");
  gitIn(origin, "commit", "-qm", "ignore");
  gitIn(repo, "fetch", "-q", "origin");
  const lease = await manager.acquire({
    repositoryPath: repo,
    baseSha: gitIn(repo, "rev-parse", "origin/main"),
    owner: { kind: "task", key: "task-ignored:0" },
  });
  assert.equal(lease.outcome, "acquired");
  if (lease.outcome !== "acquired") return;
  const delegated = new WorktreeOperationsService(manager, {
    legacy: new LegacyTreehouseService(db),
    tasks: {
      get: (id) => id === "task-ignored"
        ? {
            id,
            title: "Settled task",
            resources: [{
              position: 0,
              repoRoot: repo,
              path: lease.lease.path,
              provider: "mission",
              leaseId: lease.lease.leaseId,
              branch: null,
            }],
          }
        : null,
      reclaim: async () => ({ ok: true }),
    },
    checks,
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => 0,
  });

  // Regenerable directories are discounted, as the settled-task reclaim discounts them.
  mkdirSync(join(lease.lease.path, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(lease.lease.path, "node_modules", "pkg", "index.js"), "x\n");
  const regenerable = await delegated.preview({ action: "return", slotId: lease.lease.slotId });
  assert.deepEqual(regenerable.requiredAcknowledgements, []);
  assert.equal(regenerable.consequences.some((line) => line.startsWith("Discards")), false);

  writeFileSync(join(lease.lease.path, ".env"), "TOKEN=1\n");
  const preview = await delegated.preview({ action: "return", slotId: lease.lease.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.deepEqual(preview.requiredAcknowledgements, ["dirty"]);
  assert.ok(preview.consequences.includes(
    `Discards the uncommitted, untracked or ignored work in ${lease.lease.path}.`,
  ), preview.consequences.join(" | "));
  await assert.rejects(delegated.execute(preview.token, []), /missing acknowledgement: dirty/);

  // A commit nobody pushed is named on its own line, with no dirty acknowledgement for it.
  unlinkSync(join(lease.lease.path, ".env"));
  writeFileSync(join(lease.lease.path, "local.txt"), "never pushed\n");
  gitIn(lease.lease.path, "add", "local.txt");
  gitIn(lease.lease.path, "-c", "user.name=t", "-c", "user.email=t@test", "commit", "-qm", "local only");
  const unpushed = await delegated.preview({ action: "return", slotId: lease.lease.slotId });
  assert.equal(unpushed.allowed, true, unpushed.blockers.join("; "));
  assert.deepEqual(unpushed.requiredAcknowledgements, ["unlanded"]);
  assert.ok(unpushed.consequences.includes(
    `Discards the commits in ${lease.lease.path} that were never pushed.`,
  ), unpushed.consequences.join(" | "));
  assert.equal(unpushed.consequences.some((line) => line.startsWith("Discards the uncommitted")), false);

  // Both at once: the dirty tree still names the commits it would throw away.
  writeFileSync(join(lease.lease.path, ".env"), "TOKEN=1\n");
  const both = await delegated.preview({ action: "return", slotId: lease.lease.slotId });
  assert.deepEqual(new Set(both.requiredAcknowledgements), new Set(["dirty", "unlanded"]));
  for (const line of [
    `Discards the uncommitted, untracked or ignored work in ${lease.lease.path}.`,
    `Discards the commits in ${lease.lease.path} that were never pushed.`,
  ]) {
    assert.ok(both.consequences.includes(line), `${line} missing from: ${both.consequences.join(" | ")}`);
  }
  await manager.release(lease.lease, { ownerAuthorized: true });
});

test("an owned quarantine names its owner, offers the owner's own Return, and refuses it while a process is inside", async () => {
  let referenced: boolean | "unreadable" = true;
  const inside = new Map<string, WorktreeOccupant[]>();
  const ownedManager = new WorktreeManager(db, {
    occupancy: (paths) => Promise.resolve(new Map(paths.map((path) => [
      path,
      { status: "known" as const, occupants: inside.get(path) ?? [] },
    ]))),
    resolvePolicy: () => ({ enabled: true, maxSlots: 2, setupArgv: null }),
    ownerReferenced: async () => {
      if (referenced === "unreadable") throw new Error("tasks table is locked");
      return referenced;
    },
    pause: async () => {},
  });
  const primaryRepo = mkOriginAndClone("mission-worktree-owned-quarantine-").clone;
  const primary = await ownedManager.acquire({
    repositoryPath: primaryRepo,
    baseSha: gitIn(primaryRepo, "rev-parse", "HEAD"),
    owner: { kind: "task", key: "task-owned-quarantine:0" },
  });
  const secondaryRepo = mkOriginAndClone("mission-worktree-owned-quarantine-secondary-").clone;
  const secondary = await ownedManager.acquire({
    repositoryPath: secondaryRepo,
    baseSha: gitIn(secondaryRepo, "rev-parse", "HEAD"),
    owner: { kind: "task", key: "task-owned-quarantine:1" },
  });
  assert.equal(primary.outcome, "acquired");
  assert.equal(secondary.outcome, "acquired");
  if (primary.outcome !== "acquired" || secondary.outcome !== "acquired") return;
  let reclaims = 0;
  const owned = new WorktreeOperationsService(ownedManager, {
    legacy: new LegacyTreehouseService(db),
    tasks: {
      get: (id) => id === "task-owned-quarantine"
        ? {
            id,
            title: "Owned quarantine task",
            resources: [primary.lease, secondary.lease].map((lease, position) => ({
              position,
              repoRoot: position === 0 ? primaryRepo : secondaryRepo,
              path: lease.path,
              provider: "mission" as const,
              leaseId: lease.leaseId,
              branch: null,
            })),
          }
        : null,
      reclaim: async () => {
        reclaims += 1;
        // TaskManager's own return, which hands each lease back exactly as it is, quarantined
        // or not.
        for (const lease of [primary.lease, secondary.lease]) {
          const { lease: current } = ownedManager.lookupLease({ leaseId: lease.leaseId }) as { lease: typeof lease };
          const released = await ownedManager.release(current, { ownerAuthorized: true });
          if (released.outcome !== "released") return { ok: false, error: "reason" in released ? released.reason : released.outcome };
        }
        return { ok: true };
      },
    },
    checks,
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => 0,
  });
  ownedManager.store.quarantine(primary.lease.slotId, "worktree reset failed", "git checkout failed", Date.now());
  const card = async () => (await owned.inventory()).repositories.flatMap((repo) => repo.slots)
    .find((slot) => slot.id === primary.lease.slotId)!;

  const listed = await card();
  assert.equal(listed.state, "quarantined");
  assert.deepEqual(listed.owner, { kind: "task", key: "task-owned-quarantine:0", label: "Owned quarantine task" });
  assert.deepEqual(listed.actions, ["return", "destroy"], "Return through the owner; Recover is for an owner that is gone");

  // The preview is the task's ordinary Return: every tree the task holds, not only this slot.
  const preview = await owned.preview({ action: "return", slotId: primary.lease.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.deepEqual(
    new Set(preview.affected.map((target) => target.id)),
    new Set([primary.lease.slotId, secondary.lease.slotId]),
  );
  assert.ok(preview.consequences.includes(
    "Stops the task agent, captures required archives and snapshots, and clears every task repository through TaskManager.",
  ), preview.consequences.join(" | "));

  // A process inside the quarantined slot refuses it, even though a task Return would stop its
  // own agent in a leased one.
  inside.set(primary.lease.path, [{
    pid: 4242, ppid: 1, startRaw: "x", startMs: 1, command: "node watcher.js", cwd: primary.lease.path, knownOwner: null,
  }]);
  const occupied = await owned.preview({ action: "return", slotId: primary.lease.slotId });
  assert.equal(occupied.allowed, false);
  assert.match(occupied.blockers.join(" "), /Slot \d+ is quarantined with 1 process\(es\) inside; they must exit before its owner can return it\./);
  // The same process in the task's leased slot is still the agent TaskManager stops.
  inside.clear();
  inside.set(secondary.lease.path, [{
    pid: 4243, ppid: 1, startRaw: "x", startMs: 1, command: "claude", cwd: secondary.lease.path, knownOwner: null,
  }]);
  assert.equal((await owned.preview({ action: "return", slotId: primary.lease.slotId })).allowed, true);
  inside.clear();

  // An owner that no longer references the slot gets Recover instead of Return.
  referenced = false;
  assert.deepEqual((await card()).actions, ["destroy", "recover"]);
  const gone = await owned.preview({ action: "return", slotId: primary.lease.slotId });
  assert.equal(gone.allowed, false);
  assert.match(gone.blockers.join(" "), /owner no longer references it; Recover it instead/);
  // One that cannot be read, even on its retry, gets neither: unknown is never a way back.
  referenced = "unreadable";
  assert.deepEqual((await card()).actions, ["destroy"]);
  const unknown = await owned.preview({ action: "return", slotId: primary.lease.slotId });
  assert.equal(unknown.allowed, false);
  assert.match(unknown.blockers.join(" "), /Whether slot \d+'s owner still references it is unknown\./);
  referenced = true;

  const accepted = await owned.preview({ action: "return", slotId: primary.lease.slotId });
  await owned.execute(accepted.token, []);
  assert.equal(reclaims, 1, "one task return owns every tree");
  const returned = ownedManager.store.slot(primary.lease.slotId)!;
  assert.equal(returned.state, "available");
  assert.equal(returned.quarantineReason, null);
  assert.equal(returned.activeLeaseId, null);
  assert.equal(existsSync(primary.lease.path), true, "the slot is kept as warm capacity");
});

test("a quarantined slot under a warm lease offers no Return, and the preview names the way out for a live seed or a dead one", async () => {
  const seedManager = new WorktreeManager(db, {
    occupancy,
    resolvePolicy: () => ({ enabled: true, maxSlots: 2, setupArgv: null }),
  });
  const { clone } = mkOriginAndClone("mission-worktree-warm-quarantine-");
  const acquired = await seedManager.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "manual", key: "manual-warm-quarantine" },
  });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  // A seed's own `warm` lease, quarantined while the seed still runs: the manager calls a warm
  // owner referenced exactly while its operation is live in this daemon, which nothing outside
  // a real seed can arrange, so the test marks it live directly.
  db.prepare(
    "UPDATE worktree_slots SET active_owner_kind = 'warm', active_owner_key = 'warm-op-1' WHERE id = ?",
  ).run(acquired.lease.slotId);
  (seedManager as unknown as { liveWarmOwners: Set<string> }).liveWarmOwners.add("warm-op-1");
  seedManager.store.quarantine(acquired.lease.slotId, "worktree reset failed", null, Date.now());
  const seeded = new WorktreeOperationsService(seedManager, {
    legacy: new LegacyTreehouseService(db),
    tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
    checks,
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => 0,
  });
  const listed = (await seeded.inventory()).repositories.flatMap((repo) => repo.slots)
    .find((slot) => slot.id === acquired.lease.slotId)!;
  assert.equal(listed.owner?.kind, "warm");
  assert.equal(listed.actions.includes("return"), false, "the seed returns its own lease when its copy ends");
  const preview = await seeded.preview({ action: "return", slotId: acquired.lease.slotId });
  assert.equal(preview.allowed, false);
  assert.ok(preview.blockers.includes("A dependency seed holds this slot and returns it when its copy ends."), preview.blockers.join("; "));
  assert.equal(preview.consequences.some((line) => line.includes("manual lease")), false);

  // A restart ends the seed, so nothing is coming back for the slot: the preview must not say
  // it is. Destroy stays refused, as execute refuses every `warm` owner, and points at Recover.
  (seedManager as unknown as { liveWarmOwners: Set<string> }).liveWarmOwners.delete("warm-op-1");
  const gone = "owner no longer references it; Recover it instead.";
  const card = (await seeded.inventory()).repositories.flatMap((repo) => repo.slots)
    .find((slot) => slot.id === acquired.lease.slotId)!;
  assert.deepEqual(card.actions, ["destroy", "recover"]);
  for (const request of [
    { action: "destroy", target: { kind: "slot", slotId: acquired.lease.slotId } },
    { action: "return", slotId: acquired.lease.slotId },
  ] as const) {
    const refused = await seeded.preview(request);
    assert.equal(refused.allowed, false);
    assert.deepEqual(refused.blockers.filter((line) => line.includes(gone)).length, 1, refused.blockers.join("; "));
    assert.equal(refused.blockers.some((line) => line.includes("dependency seed holds")), false);
  }

  // Before reconcile judges it, the slot is still leased and has no Recover to point at.
  db.prepare("UPDATE worktree_slots SET state = 'leased', quarantine_reason = NULL, quarantined_at = NULL WHERE id = ?")
    .run(acquired.lease.slotId);
  const leased = await seeded.preview({ action: "destroy", target: { kind: "slot", slotId: acquired.lease.slotId } });
  assert.equal(leased.allowed, false);
  assert.match(leased.blockers.join(" "), /The seed that held slot \d+ is gone; Reconcile returns its lease\./);
  assert.equal(leased.blockers.join(" ").includes("Recover"), false);

  // An incomplete lease identity is unknown, not a seed at work.
  db.prepare("UPDATE worktree_slots SET active_lease_id = NULL WHERE id = ?").run(acquired.lease.slotId);
  const unknown = await seeded.preview({ action: "destroy", target: { kind: "slot", slotId: acquired.lease.slotId } });
  assert.equal(unknown.allowed, false);
  assert.match(unknown.blockers.join(" "), /Whether slot \d+'s owner still references it is unknown\./);
  assert.equal(unknown.blockers.some((line) => line.includes("dependency seed holds")), false);
});

test("a manual lease is named by its label", async () => {
  const { clone } = mkOriginAndClone("mission-worktree-manual-label-");
  const acquired = await manager.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "manual", key: "0123456789abcdef:fix the flaky spec" },
  });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  const listed = (await operations.inventory()).repositories.flatMap((repo) => repo.slots)
    .find((slot) => slot.id === acquired.lease.slotId);
  assert.equal(listed?.owner?.label, "Manual lease 01234567: fix the flaky spec");
  await manager.release(acquired.lease, { ownerAuthorized: true });
});

test("legacy task Return reaches the exact conditional adapter through TaskManager", async () => {
  const registry = new Registry();
  const repoRoot = "/repo/settings-legacy-task";
  const path = "/treehouse/settings-legacy-task/repo";
  const leaseId = "settings-legacy-lease";
  const calls: string[][] = [];
  let returned = false;
  const execute: Run = async (_bin, args) => {
    calls.push([...args]);
    if (args[0] === "--version") {
      return stubRun({ stdout: "v2.1.1\n", stderr: "", code: 0 });
    }
    if (args[0] === "status" && args[1] === "--json") {
      return stubRun({
        stdout: JSON.stringify(returned ? [] : [{
          name: "1",
          path,
          status: "leased",
          lease_id: leaseId,
          lease_holder: "mission-control",
          leased_at: "2026-08-16T12:00:00Z",
          processes: [],
        }]),
        stderr: "",
        code: 0,
      });
    }
    if (args[0] === "return") {
      returned = true;
      return stubRun({ stdout: "", stderr: "", code: 0 });
    }
    assert.fail(`unexpected Treehouse command: ${args.join(" ")}`);
  };
  const legacy = new LegacyTreehouseService(db, {
    adapter: new LegacyTreehouseAdapter({ execute, present: () => true }),
    occupancy,
    git: {
      inspect: async (target) => ({
        ok: true as const,
        value: {
          path: target,
          head: "a".repeat(40),
          dirty: false,
          commonDirectory: repoRoot,
          detached: true,
        },
      }),
    },
  });
  const tasks = new TaskManager(
    registry,
    undefined,
    undefined,
    undefined,
    undefined,
    {},
    manager,
    legacy,
  );
  registry.upsertTask(mkTask({
    id: "settings-legacy-task",
    title: "Drain the exact legacy task",
    repoRoot,
    status: "done",
    provider: "treehouse",
    worktreePath: path,
    worktreeLeaseId: leaseId,
    completedAt: 1,
  }));
  const delegated = new WorktreeOperationsService(manager, {
    legacy,
    tasks: {
      get: (id) => {
        const task = registry.getTask(id);
        if (!task || !task.worktreePath) return null;
        return {
          id: task.id,
          title: task.title,
          resources: [{
            position: 0,
            repoRoot: task.repoRoot,
            path: task.worktreePath,
            provider: task.provider,
            leaseId: task.worktreeLeaseId,
            branch: task.branch,
          }],
        };
      },
      reclaim: (id) => tasks.reclaim(id),
    },
    checks,
    checkRecovery: async () => "unknown",
    notifyChanged: () => changed.push(Date.now()),
    diskBytes: async () => 0,
  });

  const preview = await delegated.preview({
    action: "legacyReturn",
    owner: { kind: "task", id: "settings-legacy-task", position: 0 },
  });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  const changedBeforeExecute = changed.length;
  assert.deepEqual(await delegated.execute(preview.token, []), {
    ok: true,
    action: "legacyReturn",
    message: "Exact legacy lease returned through its domain owner.",
  });
  assert.equal(changed.length, changedBeforeExecute + 1, "legacy-only success invalidates every open panel once");
  assert.deepEqual(
    calls.find((args) => args[0] === "return"),
    ["return", "--force", "--if-lease-id", leaseId, "--if-lease-holder", "mission-control", path],
  );
  assert.equal(calls.filter((args) => args[0] === "return").length, 1);
  assert.equal(registry.getTask("settings-legacy-task")?.provider, null);
  assert.equal(registry.getTask("settings-legacy-task")?.worktreePath, null);
  assert.equal(registry.getTask("settings-legacy-task")?.worktreeLeaseId, null);
});

// A setup command that fails during materialization quarantines a reservation the task never
// received. The task records nothing and finishes, so a slot still stamped with that task as
// its active owner could be neither Returned nor Destroyed, and Reconcile skipped it.
function orphanHarness() {
  const orphanManager = new WorktreeManager(db, {
    occupancy,
    resolvePolicy: () => ({ enabled: true, maxSlots: 2, setupArgv: ["setup"] }),
    runSetup: async () => ({ ok: false, reason: "setup exited 1", outcomeUnknown: false }),
  });
  const orphanOperations = new WorktreeOperationsService(orphanManager, {
    legacy: new LegacyTreehouseService(db),
    // The owning task still exists and is done, with no native resource recorded.
    tasks: {
      get: (id) => id.startsWith("task-orphan") ? { id, title: "Finished task", resources: [] } : null,
      reclaim: async () => ({ ok: false, error: "unexpected task reclaim" }),
    },
    checks,
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => 0,
  });
  return { orphanManager, orphanOperations };
}

async function quarantinedBySetup(orphanManager: WorktreeManager, prefix: string, key: string) {
  const { clone } = mkOriginAndClone(prefix);
  const result = await orphanManager.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "task", key },
  });
  assert.deepEqual(result, { outcome: "outcomeUnknown", reason: "setup exited 1" });
  const poolId = orphanManager.store.pools()
    .find((pool) => pool.gitCommonDirectory === worktreeRepositoryIdentity(clone)?.gitCommonDirectory)?.id;
  const slot = orphanManager.store.slots().find((candidate) => candidate.poolId === poolId);
  assert.ok(slot);
  assert.equal(slot.quarantineReason, "operator-authored setup command failed");
  return slot;
}

test("a setup-failed reservation is quarantined without an owner and Destroy removes it", async () => {
  const { orphanManager, orphanOperations } = orphanHarness();
  const slot = await quarantinedBySetup(orphanManager, "mission-worktree-orphan-setup-", "task-orphan-setup:0");
  assert.equal(slot.state, "quarantined");
  assert.equal(slot.activeLeaseId, null, "the lease was never granted, so no owner may hold it");
  assert.equal(slot.activeOwnerKind, null);
  assert.equal(slot.activeOwnerKey, null);

  const preview = await orphanOperations.preview({ action: "destroy", target: { kind: "slot", slotId: slot.id } });
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.allowed, true);
  await orphanOperations.execute(preview.token, []);
  assert.equal(orphanManager.store.slot(slot.id), null);
  assert.equal(existsSync(slot.path), false);
});

test("Reconcile withdraws a stale owner from an existing orphaned quarantine so Destroy works", async () => {
  const { orphanManager, orphanOperations } = orphanHarness();
  const slot = await quarantinedBySetup(orphanManager, "mission-worktree-orphan-legacy-", "task-orphan-legacy:0");
  // The state an earlier build left behind: quarantined but still stamped with the owner.
  db.prepare(
    `UPDATE worktree_slots SET active_lease_id = 'lease-never-granted', active_owner_kind = 'task',
       active_owner_key = 'task-orphan-legacy:0', leased_at = 1 WHERE id = ?`,
  ).run(slot.id);

  const blocked = await orphanOperations.preview({ action: "destroy", target: { kind: "slot", slotId: slot.id } });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.blockers.join(" "), /durable resource set/);
  assert.deepEqual(await orphanManager.removeSlot({ slotId: slot.id, allowDirty: false, allowUnmerged: false }), {
    outcome: "refused",
    reason: "slot still carries active lease identity",
  });

  await orphanManager.reconcile();
  const recovered = orphanManager.store.slot(slot.id)!;
  assert.equal(recovered.state, "quarantined", "withdrawing the owner never makes the slot available");
  assert.equal(recovered.activeLeaseId, null);

  const preview = await orphanOperations.preview({ action: "destroy", target: { kind: "slot", slotId: slot.id } });
  assert.deepEqual(preview.blockers, []);
  await orphanOperations.execute(preview.token, []);
  assert.equal(orphanManager.store.slot(slot.id), null);
});
