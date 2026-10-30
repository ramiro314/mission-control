import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { openDb } from "../src/server/db.ts";
import { Registry } from "../src/server/registry.ts";
import { ReviewManager } from "../src/server/reviews.ts";
import { TaskManager } from "../src/server/tasks.ts";
import { QueueManager } from "../src/server/queue.ts";
import { buildApp } from "../src/server/routes.ts";
import { buildClaimEnvironment } from "../src/server/worktrees/claim.ts";
import { WorktreeManager, type WorktreeManagerDeps } from "../src/server/worktrees/manager.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { WorktreeStore, type WorktreeSlotRow } from "../src/server/worktrees/store.ts";
import { withObservationFailure } from "../src/server/worktrees/quarantine-reasons.ts";
import { WorktreeSlotHistoryPageSchema, type WorktreeClaim } from "../src/shared/protocol.ts";
import {
  WORKTREE_HISTORY_ACTORS,
  WORKTREE_HISTORY_KINDS,
  WORKTREE_HISTORY_LIMITS,
} from "../src/shared/worktrees.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";
import { mkTask } from "./helpers/session-fixture.ts";

const db = openDb();
const store = new WorktreeStore(db);
const DAY_MS = 24 * 60 * 60 * 1000;
const CLAIM_SECRET = "claim-secret-value-7f3a";

function claimEnvironment(names: Iterable<string>) {
  return buildClaimEnvironment({
    names: [...names],
    daemonEnv: { ...process.env, CLAIM_TOKEN: CLAIM_SECRET },
    daemonToken: "daemon-token-for-history",
    loginShell: {},
  });
}

afterEach(() => {
  db.exec(`
    DROP TRIGGER IF EXISTS temp.refuse_history;
    DELETE FROM worktree_slot_history;
    DELETE FROM worktree_slots;
    DELETE FROM worktree_pools;
    DELETE FROM app_config WHERE key = 'worktrees';
  `);
});

function pool(id = "pool-a") {
  return store.ensurePool({
    id,
    gitCommonDirectory: `/repo/${id}/.git`,
    mainCheckoutRoot: `/repo/${id}`,
    poolPath: `/pools/${id}`,
    now: 1,
  });
}

function reserved(poolId = pool().id, id = "slot-a"): WorktreeSlotRow {
  const slot = store.reserveNew({
    poolId,
    maxSlots: 16,
    id,
    pathForOrdinal: (ordinal) => `/pools/${poolId}/${ordinal}/repo`,
    leaseId: `lease-${id}`,
    ownerKind: "task",
    ownerKey: "task-1",
    requestedHeadSha: "a".repeat(40),
    now: 100,
  });
  assert.ok(slot);
  return slot;
}

function leased(): WorktreeSlotRow {
  const slot = reserved();
  return store.finalizeLease(slot.id, slot.version, "a".repeat(40), 200)!;
}

function historyOf(slotId: string) {
  return store.slotHistory(slotId).entries;
}

function rowCount(): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM worktree_slot_history`).get() as { n: number }).n);
}

/** The one row `write` must add, read as the newest row of its slot. */
function oneRowFrom<T>(write: () => T): { result: T; row: ReturnType<typeof historyOf>[number] } {
  const before = rowCount();
  const result = write();
  assert.equal(rowCount(), before + 1, "exactly one history row");
  const row = db.prepare(`SELECT slot_id FROM worktree_slot_history ORDER BY id DESC LIMIT 1`).get() as { slot_id: string };
  return { result, row: historyOf(row.slot_id)[0]! };
}

function noRowFrom(write: () => unknown): void {
  const before = rowCount();
  write();
  assert.equal(rowCount(), before, "no history row");
}

test("the kind and actor vocabularies are the plan's, in the plan's order", () => {
  assert.deepEqual(WORKTREE_HISTORY_KINDS, ["transition", "operation", "observation", "claim", "seed", "provisioning"]);
  assert.deepEqual(WORKTREE_HISTORY_ACTORS, ["automatic", "operator", "owner"]);
});

test("every slot transition writes exactly one row with the states either side of it", () => {
  const poolId = pool().id;
  const { result: created, row: first } = oneRowFrom(() => reserved(poolId));
  assert.deepEqual(
    [first.kind, first.fromState, first.toState, first.actor, first.reason, first.at],
    ["transition", null, "provisioning", "owner", "new slot reserved for task:task-1", 100],
  );
  assert.equal(first.slotId, created.id);
  assert.equal(first.ordinal, created.ordinal);
  assert.deepEqual(first.meta, { version: created.version, head: null });

  const { result: slot, row: granted } = oneRowFrom(() =>
    store.finalizeLease(created.id, created.version, "a".repeat(40), 200)!);
  assert.deepEqual(
    [granted.fromState, granted.toState, granted.actor, granted.reason],
    ["provisioning", "leased", "owner", "lease granted to task:task-1"],
  );
  assert.deepEqual(granted.meta, { version: slot.version, head: "a".repeat(40) });

  const { result: quarantined, row: fault } = oneRowFrom(() =>
    store.quarantine(slot.id, "worktree reset failed", "fatal: unable to write new index file", 250)!);
  assert.deepEqual(
    [fault.fromState, fault.toState, fault.actor, fault.reason, fault.detail],
    ["leased", "quarantined", "automatic", "worktree reset failed", "fatal: unable to write new index file"],
  );

  const { result: restored, row: restore } = oneRowFrom(() =>
    store.restoreLease(quarantined.id, quarantined.version, "lease-slot-a", 260)!);
  assert.deepEqual([restore.fromState, restore.toState, restore.actor], ["quarantined", "leased", "automatic"]);
  assert.match(restore.reason ?? "", /worktree reset failed/);

  const { result: returning, row: started } = oneRowFrom(() =>
    store.markReturning(restored.id, restored.version, "b".repeat(40), 300, "operator")!);
  assert.deepEqual([started.fromState, started.toState, started.actor], ["leased", "returning", "operator"]);

  const { result: done, row: completed } = oneRowFrom(() =>
    store.completeRelease(returning.id, returning.version, "b".repeat(40), 400)!);
  assert.deepEqual([completed.fromState, completed.toState, completed.actor], ["returning", "available", "owner"]);

  const { result: again, row: reservedAgain } = oneRowFrom(() =>
    store.reserveAvailable({
      slotId: done.id,
      version: done.version,
      leaseId: "lease-2",
      ownerKind: "warm",
      ownerKey: "seed-1",
      requestedHeadSha: "b".repeat(40),
      now: 500,
    })!);
  assert.deepEqual([reservedAgain.fromState, reservedAgain.toState, reservedAgain.actor], ["available", "provisioning", "automatic"]);

  const { result: handedBack, row: backRow } = oneRowFrom(() =>
    store.releaseReservation({
      slotId: again.id,
      version: again.version,
      leaseId: "lease-2",
      requestedHeadSha: "b".repeat(40),
      lastError: withObservationFailure(null, "slot process occupancy is unknown (ps timed out)"),
      now: 510,
    })!);
  assert.deepEqual([backRow.fromState, backRow.toState], ["provisioning", "available"]);
  assert.equal(backRow.detail, "slot process occupancy is unknown (ps timed out)", "the failed read that refused it");

  const { result: pruning, row: removal } = oneRowFrom(() => store.markPruning(handedBack.id, handedBack.version, 600)!);
  assert.deepEqual([removal.fromState, removal.toState, removal.actor], ["available", "pruning", "operator"]);

  const { row: gone } = oneRowFrom(() => store.removePruned(pruning.id, pruning.version, 610, "operator"));
  assert.deepEqual([gone.fromState, gone.toState, gone.actor], ["pruning", null, "operator"]);
  assert.equal(store.slot(pruning.id), null);
  assert.equal(historyOf(pruning.id).length, 10, "the row went and its history stayed");
});

test("a quarantined slot's own moves each write a row: a new reason, and a withdrawn lease", () => {
  const slot = leased();
  const first = store.quarantine(slot.id, "worktree reset failed", null, 300)!;
  const { result: again, row } = oneRowFrom(() => store.quarantine(first.id, "return verification failed", null, 310)!);
  assert.deepEqual([row.fromState, row.toState], ["quarantined", "quarantined"]);
  const { row: withdrawn } = oneRowFrom(() => store.withdrawQuarantinedLease(again.id, again.version, "lease-slot-a", 320));
  assert.deepEqual([withdrawn.fromState, withdrawn.toState, withdrawn.actor], ["quarantined", "quarantined", "automatic"]);
  assert.match(withdrawn.reason ?? "", /task:task-1/);
});

test("a compare-and-swap that misses writes no row", () => {
  const slot = leased();
  const stale = slot.version - 1;
  noRowFrom(() => assert.equal(store.finalizeLease(slot.id, slot.version, "x", 1), null));
  noRowFrom(() => assert.equal(store.markReturning(slot.id, stale, "x", 1), null));
  noRowFrom(() => assert.equal(store.completeRelease(slot.id, slot.version, "x", 1), null));
  noRowFrom(() => assert.equal(store.markPruning(slot.id, slot.version, 1), null));
  noRowFrom(() => assert.equal(store.quarantine(slot.id, "reason", null, 1, stale), null));
  noRowFrom(() => assert.equal(store.restoreLease(slot.id, slot.version, "lease-slot-a", 1), null));
  noRowFrom(() => assert.equal(store.withdrawQuarantinedLease(slot.id, slot.version, "lease-slot-a", 1), null));
  noRowFrom(() => assert.equal(store.removePruned(slot.id, slot.version), false));
  noRowFrom(() => assert.equal(store.quarantine("no-such-slot", "reason", null, 1), null));
  noRowFrom(() => assert.equal(store.reserveAvailable({
    slotId: slot.id, version: slot.version, leaseId: "l", ownerKind: "task", ownerKey: "k", requestedHeadSha: "x", now: 1,
  }), null));
  noRowFrom(() => assert.equal(store.releaseReservation({
    slotId: slot.id, version: slot.version, leaseId: "l", requestedHeadSha: null, lastError: null, now: 1,
  }), null));
  noRowFrom(() => assert.equal(store.reserveNew({
    poolId: slot.poolId, maxSlots: 1, id: "over-capacity", pathForOrdinal: () => "/nowhere",
    leaseId: "l", ownerKind: "task", ownerKey: "k", requestedHeadSha: "x", now: 1,
  }), null));
});

test("a transition whose history row cannot be written does not happen", () => {
  const slot = leased();
  const spare = reserved(slot.poolId, "slot-removed");
  const granted = store.finalizeLease(spare.id, spare.version, "a".repeat(40), 200)!;
  const returning = store.markReturning(granted.id, granted.version, "b".repeat(40), 300)!;
  const free = store.completeRelease(returning.id, returning.version, "b".repeat(40), 400)!;
  const pruning = store.markPruning(free.id, free.version, 500)!;
  db.exec(`
    CREATE TEMP TRIGGER refuse_history BEFORE INSERT ON main.worktree_slot_history
    BEGIN SELECT RAISE(ABORT, 'history refused'); END;
  `);
  const rows = rowCount();
  assert.throws(() => store.quarantine(slot.id, "reason", null, 300), /history refused/);
  assert.throws(() => store.markReturning(slot.id, slot.version, "b".repeat(40), 300), /history refused/);
  assert.throws(() => reserved(slot.poolId, "slot-b"), /history refused/);
  assert.throws(() => store.removePruned(pruning.id, pruning.version, 510, "operator"), /history refused/);
  assert.throws(
    () => store.noteLastError(slot.id, slot.version, withObservationFailure(null, "a failed read"), 520),
    /history refused/,
  );
  assert.equal(db.isTransaction, false, "every attempt closed its transaction");
  assert.deepEqual(store.slot(slot.id), slot, "the slot row is exactly as it was");
  assert.equal(store.slot("slot-b"), null);
  assert.deepEqual(store.slot(pruning.id), pruning, "a removal that cannot be recorded leaves its row in place");
  assert.equal(rowCount(), rows);
});

test("a transition inside a caller's transaction commits and rolls back with it", () => {
  const slot = leased();
  const rows = rowCount();
  db.exec("BEGIN IMMEDIATE;");
  assert.ok(store.quarantine(slot.id, "reason", null, 300));
  assert.equal(db.isTransaction, true, "the store left the caller's transaction open");
  db.exec("ROLLBACK;");
  assert.equal(store.slot(slot.id)?.state, "leased");
  assert.equal(rowCount(), rows);
});

test("observation rows mark only where a slot's failed-read state starts and clears", () => {
  const slot = leased();
  const failed = withObservationFailure(null, "slot Git state is unknown (git status timed out after 15 s)");

  const { row: started } = oneRowFrom(() => assert.ok(store.noteLastError(slot.id, slot.version, failed, 300)));
  assert.deepEqual(
    [started.kind, started.fromState, started.toState, started.outcome, started.actor, started.detail],
    ["observation", "leased", "leased", "started", "automatic", "slot Git state is unknown (git status timed out after 15 s)"],
  );

  noRowFrom(() => store.noteLastError(slot.id, slot.version, failed, 310));
  noRowFrom(() => store.updateObserved(slot.id, "a".repeat(40), failed, 320));
  noRowFrom(() => store.noteLastError(
    slot.id, slot.version, withObservationFailure(null, "slot Git state is unknown (git status timed out after 30 s)"), 330,
  ));

  const { row: cleared } = oneRowFrom(() => store.updateObserved(slot.id, "a".repeat(40), null, 340));
  assert.deepEqual(
    [cleared.kind, cleared.outcome, cleared.detail],
    ["observation", "cleared", "slot Git state is unknown (git status timed out after 30 s)"],
  );

  noRowFrom(() => store.updateObserved(slot.id, "a".repeat(40), null, 350));
  noRowFrom(() => store.noteLastError(slot.id, slot.version, "an error that is no failed read", 360));
  noRowFrom(() => assert.equal(store.noteLastError(slot.id, slot.version + 1, failed, 370), false));
});

test("a failed read over a quarantine's own detail starts and clears like any other", () => {
  const slot = store.quarantine(leased().id, "worktree reset failed", "fatal: index.lock", 300)!;
  const noted = withObservationFailure(slot.lastError, "pool marker could not be read");
  const { row: started } = oneRowFrom(() => store.noteLastError(slot.id, slot.version, noted, 310));
  assert.equal(started.outcome, "started");
  assert.equal(started.detail, "pool marker could not be read", "only the note, never the quarantine's detail");
  const { row: cleared } = oneRowFrom(() => store.noteLastError(slot.id, slot.version, "fatal: index.lock", 320));
  assert.equal(cleared.outcome, "cleared");
});

test("reason, detail and meta are bounded in bytes without splitting a character", () => {
  const slot = leased();
  const huge = "é".repeat(5000);
  const { row } = oneRowFrom(() => store.quarantine(slot.id, huge, huge, 300));
  const limit = WORKTREE_HISTORY_LIMITS.textBytes;
  for (const text of [row.reason!, row.detail!]) {
    assert.ok(Buffer.byteLength(text, "utf8") <= limit);
    assert.ok(Buffer.byteLength(text, "utf8") >= limit - 1, "the budget is spent");
    assert.ok(!text.includes("�"), "no split character");
  }

  db.prepare(`UPDATE worktree_slots SET current_head_sha = ? WHERE id = ?`).run("h".repeat(5000), slot.id);
  const current = store.slot(slot.id)!;
  const { row: oversized } = oneRowFrom(() => store.quarantine(slot.id, "again", null, 310, current.version));
  assert.deepEqual(oversized.meta, { truncated: true }, "an oversized meta is replaced, never cut into bad JSON");
});

test("retention drops rows older than 90 days, and a removed slot's rows go only then", () => {
  const now = 1_000 * DAY_MS;
  const slot = leased();
  const quarantined = store.quarantine(slot.id, "r", null, now - 2 * DAY_MS, undefined, true)!;
  const pruning = store.markPruning(quarantined.id, quarantined.version, now - DAY_MS)!;
  assert.ok(store.removePruned(pruning.id, pruning.version, now - DAY_MS, "operator"));
  assert.equal(store.slot(slot.id), null);

  const cutoff = now - WORKTREE_HISTORY_LIMITS.retentionDays * DAY_MS;
  const dropped = store.pruneHistory(now);
  assert.equal(dropped, 2, "the reservation and the grant, written at 100 and 200");
  assert.ok(historyOf(slot.id).every((entry) => entry.at >= cutoff));
  assert.equal(historyOf(slot.id).length, 3, "a removed slot's recent rows remain");

  db.prepare(`UPDATE worktree_slot_history SET at = ? WHERE slot_id = ?`).run(cutoff, slot.id);
  assert.equal(store.pruneHistory(now), 0, "exactly 90 days old is not older than 90 days");
  assert.equal(store.pruneHistory(now + 1), 3, "and a moment later it is");
  assert.deepEqual(historyOf(slot.id), []);
});

test("retention keeps the newest 2,000 rows of each pool, by age, with id breaking a tie", () => {
  const now = 1_000 * DAY_MS;
  const { rowsPerPool } = WORKTREE_HISTORY_LIMITS;
  const insert = db.prepare(
    `INSERT INTO worktree_slot_history (pool_id, slot_id, ordinal, at, kind) VALUES (?, ?, 1, ?, 'transition')`,
  );
  // Every row is older than the one inserted before it, so ids run opposite to age, and a cut
  // by id alone would keep exactly the wrong rows. The rows at `rowsPerPool - 1` and
  // `rowsPerPool` tie, so the cut falls between them and only the id can decide it.
  const ageOf = (index: number) => (index === rowsPerPool ? rowsPerPool - 1 : index);
  const ids: number[] = [];
  db.exec("BEGIN;");
  for (let index = 0; index < rowsPerPool + 5; index += 1) {
    ids.push(Number(insert.run("pool-big", "slot-big", now - ageOf(index)).lastInsertRowid));
  }
  // Older than the big pool's cut and well inside 90 days: only its own pool's cap may judge it.
  for (let index = 0; index < 3; index += 1) insert.run("pool-small", "slot-small", now - 10 * rowsPerPool - index);
  db.exec("COMMIT;");

  const survivors = () => (db
    .prepare(`SELECT id FROM worktree_slot_history WHERE pool_id = 'pool-big' ORDER BY id`)
    .all() as Array<{ id: number }>).map((row) => row.id);
  assert.equal(store.pruneHistory(now), 5);
  assert.deepEqual(
    survivors(),
    [...ids.slice(0, rowsPerPool - 1), ids[rowsPerPool]!],
    "the newest by age stay: of the tied pair the higher id stays, and the lower id and everything older go",
  );
  assert.equal(store.slotHistory("slot-small").entries.length, 3, "another pool's rows are its own");
  assert.equal(store.pruneHistory(now), 0, "a pass with nothing to drop drops nothing");
});

test("each maintenance pass applies retention, and a failure there never stops the pass", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const pass = async () => {
    mock.timers.tick(300_000);
    for (let turn = 0; turn < 3; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const insert = db.prepare(
    `INSERT INTO worktree_slot_history (pool_id, slot_id, ordinal, at, kind) VALUES ('p', 's', 1, ?, 'transition')`,
  );
  const now = Date.now();
  insert.run(now - 91 * DAY_MS);
  insert.run(now - DAY_MS);
  const manager = new WorktreeManager(db, {
    occupancy: (paths) => Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants: [] }]))),
  });
  let passes = 0;
  manager.startMaintenance(async () => {}, () => { passes += 1; });
  try {
    await pass();
    assert.equal(passes, 1);
    assert.deepEqual(store.slotHistory("s").entries.map((entry) => entry.at), [now - DAY_MS]);

    const errors: unknown[][] = [];
    const originalError = console.error;
    const originalPrune = manager.store.pruneHistory;
    console.error = (...args: unknown[]) => { errors.push(args); };
    manager.store.pruneHistory = () => { throw new Error("database is busy"); };
    try {
      await pass();
    } finally {
      console.error = originalError;
      manager.store.pruneHistory = originalPrune;
    }
    assert.equal(passes, 2, "the pass went on");
    assert.ok(errors.some((args) => String(args[0]).includes("slot history retention failed")));
  } finally {
    await manager.stop();
    mock.timers.reset();
  }
});

/** A real manager, real Git and an origin that can be Reset to. */
function repository(prefix: string) {
  const { origin, clone } = mkOriginAndClone(prefix);
  return { origin, clone, sha: gitIn(clone, "rev-parse", "HEAD") };
}

function realManager(deps: Partial<WorktreeManagerDeps> = {}): WorktreeManager {
  return new WorktreeManager(db, {
    occupancy: (paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> =>
      Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants: [] }]))),
    fileHolders: async () => [],
    resolvePolicy: () => ({ enabled: true, maxSlots: 4, setupArgv: null }),
    ...deps,
  });
}

/** Oldest first, as "<from> -> <to> (<actor>)". */
function trail(slotId: string): string[] {
  return historyOf(slotId)
    .filter((entry) => entry.kind === "transition")
    .reverse()
    .map((entry) => `${entry.fromState} -> ${entry.toState} (${entry.actor})`);
}

test("a slot's whole life through the real manager reads back in order, each step by its actor", async () => {
  const { clone, sha } = repository("mission-history-life-");
  const m = realManager();
  const acquired = await m.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "task", key: "task-life" } });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  const { lease } = acquired;

  assert.equal((await m.release(lease, { ownerAuthorized: true })).outcome, "released");
  const removed = await m.removeSlot({ slotId: lease.slotId, allowDirty: false, allowUnmerged: false });
  assert.equal(removed.outcome, "removed");

  assert.deepEqual(trail(lease.slotId), [
    "null -> provisioning (owner)",
    "provisioning -> leased (owner)",
    "leased -> returning (owner)",
    "returning -> available (owner)",
    "available -> pruning (operator)",
    "pruning -> null (operator)",
  ]);
  const versions = historyOf(lease.slotId).reverse().map((entry) => entry.meta?.version);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 5], "one row per version, and the removal keeps the last");
});

test("Recover records who ran it, and a quarantine records why", async () => {
  const { clone, sha } = repository("mission-history-recover-");
  const m = realManager();
  const run = async (key: string, automatic: boolean) => {
    const acquired = await m.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "task", key } });
    assert.equal(acquired.outcome, "acquired");
    if (acquired.outcome !== "acquired") throw new Error("not acquired");
    const { slotId, slotVersion } = acquired.lease;
    assert.ok(m.store.quarantine(slotId, "slot Git state is unknown", null, Date.now(), slotVersion, true));
    const recovered = await m.recoverSlot({ slotId, allowDirty: false, automatic });
    assert.equal(recovered.outcome, "recovered", JSON.stringify(recovered));
    return trail(slotId).slice(-3);
  };
  assert.deepEqual(await run("task-operator", false), [
    "leased -> quarantined (automatic)",
    "quarantined -> returning (operator)",
    "returning -> available (operator)",
  ]);
  assert.deepEqual((await run("task-automatic", true)).slice(-2), [
    "quarantined -> returning (automatic)",
    "returning -> available (automatic)",
  ]);
});

test("reconcile finishing an interrupted return or a removal is recorded as automatic", async () => {
  const { clone, sha } = repository("mission-history-reconcile-");
  const m = realManager({ ownerReferenced: async () => true });
  const take = async (key: string) => {
    const acquired = await m.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "task", key } });
    assert.equal(acquired.outcome, "acquired");
    if (acquired.outcome !== "acquired") throw new Error("not acquired");
    return acquired.lease;
  };
  const interrupted = await take("task-interrupted");
  const removing = await take("task-removing");
  assert.ok(m.store.markReturning(interrupted.slotId, interrupted.slotVersion, sha, Date.now()));
  assert.equal((await m.release(removing, { ownerAuthorized: true })).outcome, "released");
  const free = m.store.slot(removing.slotId)!;
  assert.ok(m.store.markPruning(free.id, free.version, Date.now()));
  gitIn(clone, "worktree", "remove", "--force", removing.path);

  await m.reconcile();

  assert.equal(m.store.slot(interrupted.slotId)?.state, "available");
  assert.equal(trail(interrupted.slotId).at(-1), "returning -> available (automatic)");
  assert.equal(m.store.slot(removing.slotId), null);
  assert.equal(trail(removing.slotId).at(-1), "pruning -> null (automatic)");
});

test("a Return run from Settings names the operator through the manual, task and check routes", async () => {
  const { clone, sha } = repository("mission-history-settings-");
  const m = realManager();
  const legacy = new LegacyTreehouseService(db);
  const registry = new Registry();
  const tasks = new TaskManager(registry, undefined, undefined, undefined, undefined, undefined, m);
  const checks = new CheckLeaseManager(db, { manager: m, legacy });
  let taskResource: { path: string; leaseId: string } | null = null;
  const operations = new WorktreeOperationsService(m, {
    legacy,
    // The view the preview reads is written here. The reclaim is TaskManager's own, which stops
    // the task and reaches the release through `teardownWorktree`.
    tasks: {
      get: (id) => id === "task-settings" && taskResource
        ? {
            id,
            title: "Settings task",
            resources: [{ position: 0, repoRoot: clone, provider: "mission", branch: null, ...taskResource }],
          }
        : null,
      reclaim: (id) => tasks.reclaim(id),
    },
    checks,
    checkRecovery: async () => "empty",
    notifyChanged: () => {},
    diskBytes: async () => 0,
  });
  const take = async (owner: { kind: "manual" | "task"; key: string }) => {
    const acquired = await m.acquire({ repositoryPath: clone, baseSha: sha, owner });
    assert.equal(acquired.outcome, "acquired");
    if (acquired.outcome !== "acquired") throw new Error("not acquired");
    return acquired.lease;
  };
  const returnFromSettings = async (slotId: string) => {
    const preview = await operations.preview({ action: "return", slotId });
    assert.equal(preview.allowed, true, preview.blockers.join("; "));
    await operations.execute(preview.token, []);
    assert.deepEqual(trail(slotId).slice(-2), [
      "leased -> returning (operator)",
      "returning -> available (operator)",
    ]);
  };

  await returnFromSettings((await take({ kind: "manual", key: "manual-settings" })).slotId);

  const task = await take({ kind: "task", key: "task-settings:0" });
  taskResource = { path: task.path, leaseId: task.leaseId };
  registry.upsertTask(mkTask({
    id: "task-settings",
    status: "failed",
    repoRoot: clone,
    worktreePath: task.path,
    provider: "mission",
    worktreeLeaseId: task.leaseId,
  }));
  await returnFromSettings(task.slotId);

  const attemptId = "check-settings";
  await checks.acquireForAttempt({
    attemptId,
    submissionId: "submission-settings",
    nodeId: "node-settings",
    repoRoot: clone,
    headSha: sha,
  });
  const check = m.store.slots().find((slot) => slot.activeOwnerKind === "check" && slot.activeOwnerKey === attemptId)!;
  checks.handOffForReclaim(attemptId);
  await returnFromSettings(check.id);

  const owned = await take({ kind: "task", key: "task-own-return" });
  assert.equal((await m.release(owned, { ownerAuthorized: true })).outcome, "released");
  assert.equal(trail(owned.slotId).at(-1), "returning -> available (owner)", "outside an action it stays the owner's");
});

test("a Warm names the operator, and the return that ends it does too", async () => {
  const { clone, sha } = repository("mission-history-warm-");
  const m = realManager({
    resolvePolicy: () => ({
      enabled: true,
      maxSlots: 4,
      setupArgv: null,
      claim: { steps: [{ argv: [process.execPath, "-e", ""], env: [] }], timeoutMinutes: 1, fingerprintPaths: [] },
    }),
    claimEnvironment: async (names) => claimEnvironment(names),
  });
  const acquired = await m.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "manual", key: "m1" } });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  assert.equal((await m.release(acquired.lease, { ownerAuthorized: true })).outcome, "released");
  const before = trail(acquired.lease.slotId).length;

  const warmed = await m.warmSlot({
    slotId: acquired.lease.slotId,
    operationId: "op-warm",
    signal: new AbortController().signal,
    output: () => {},
    log: null,
  });
  assert.equal(warmed.outcome, "warmed", JSON.stringify(warmed));
  assert.deepEqual(trail(acquired.lease.slotId).slice(before), [
    "available -> provisioning (operator)",
    "provisioning -> leased (operator)",
    "leased -> returning (operator)",
    "returning -> available (operator)",
  ]);
});

test("a failing claim's variable value and output never reach history", async () => {
  const { clone, sha } = repository("mission-history-claim-");
  const claim: WorktreeClaim = {
    steps: [{
      argv: [process.execPath, "-e", "console.log(process.env.CLAIM_TOKEN);console.error(process.env.CLAIM_TOKEN);process.exit(3)"],
      env: ["CLAIM_TOKEN"],
    }],
    timeoutMinutes: 1,
    fingerprintPaths: [],
  };
  const m = realManager({
    resolvePolicy: () => ({ enabled: true, maxSlots: 4, setupArgv: null, claim }),
    claimEnvironment: async (names) => claimEnvironment(names),
  });
  const acquired = await m.acquire({
    repositoryPath: clone, baseSha: sha, owner: { kind: "task", key: "task-claim" }, runClaim: true,
  });
  assert.equal(acquired.outcome, "acquired", "a failed claim still grants its lease, with a warning");
  if (acquired.outcome !== "acquired") return;
  const slot = m.store.slot(acquired.lease.slotId)!;
  assert.equal(slot.depsState, "failed");

  const rows = JSON.stringify(db.prepare(`SELECT * FROM worktree_slot_history WHERE slot_id = ?`).all(slot.id));
  assert.equal(trail(slot.id).length, 2, "the reservation and the grant");
  assert.ok(!rows.includes(CLAIM_SECRET), "no claim variable value");
  assert.ok(!rows.includes("CLAIM_TOKEN"), "and nothing of the failing step at all");
});

test("a setup command that prints a claim variable leaves its name in history, not its value", async () => {
  const { clone, sha } = repository("mission-history-setup-");
  const claim: WorktreeClaim = {
    steps: [{ argv: ["unused"], env: ["CLAIM_TOKEN"] }],
    timeoutMinutes: 1,
    fingerprintPaths: [],
  };
  const m = realManager({
    resolvePolicy: () => ({
      enabled: true,
      maxSlots: 4,
      setupArgv: [process.execPath, "-e", "console.error('auth failed for ' + process.env.CLAIM_TOKEN); process.exit(3)"],
      claim,
    }),
    claimEnvironment: async (names) => claimEnvironment(names),
  });
  const acquired = await m.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "task", key: "task-setup" } });
  assert.equal(acquired.outcome, "outcomeUnknown");
  const [slot] = m.store.slots();
  assert.equal(slot?.state, "quarantined");
  const [row] = historyOf(slot!.id);
  assert.equal(row?.reason, "operator-authored setup command failed");
  assert.equal(row?.detail, "auth failed for [CLAIM_TOKEN redacted]");
  assert.equal(slot?.lastError, "auth failed for [CLAIM_TOKEN redacted]", "the slot row is redacted too");
  assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM worktree_slot_history`).all()).includes(CLAIM_SECRET));
});

test("the history route pages newest first, 50 at a time, and survives the slot", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const manager = realManager();
  const legacy = new LegacyTreehouseService(db);
  const operations = new WorktreeOperationsService(manager, {
    legacy,
    tasks: { get: () => null, reclaim: (id) => tasks.reclaim(id) },
    checks: new CheckLeaseManager(db, { manager, legacy }),
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => 0,
  });
  const app = buildApp({
    registry,
    reviews: new ReviewManager(registry),
    tasks,
    queues: new QueueManager(registry),
    worktrees: manager,
    worktreeOperations: operations,
  });
  const headers = { host: "127.0.0.1:7317" };
  const page = async (query = "") => {
    const response = await app.request(`/api/worktrees/slot-paged/history${query}`, { headers });
    assert.equal(response.status, 200);
    return WorktreeSlotHistoryPageSchema.parse(await response.json());
  };

  assert.deepEqual(await page(), { entries: [], nextBefore: null }, "a slot with no history answers empty");

  const insert = db.prepare(
    `INSERT INTO worktree_slot_history (pool_id, slot_id, ordinal, at, kind, reason) VALUES ('p', 'slot-paged', 7, ?, 'transition', ?)`,
  );
  for (let index = 1; index <= 120; index += 1) insert.run(index, `entry ${index}`);

  const first = await page();
  const size = WORKTREE_HISTORY_LIMITS.pageEntries;
  assert.equal(size, 50);
  assert.equal(first.entries.length, size);
  assert.deepEqual([first.entries[0]!.reason, first.entries.at(-1)!.reason], ["entry 120", "entry 71"]);
  const second = await page(`?before=${first.nextBefore}`);
  assert.deepEqual([second.entries[0]!.reason, second.entries.at(-1)!.reason], ["entry 70", "entry 21"]);
  const last = await page(`?before=${second.nextBefore}`);
  assert.equal(last.entries.length, 20);
  assert.equal(last.entries.at(-1)!.reason, "entry 1");
  assert.equal(last.nextBefore, null);

  for (const bad of ["?before=0", "?before=-1", "?before=soon", "?after=1"]) {
    const refused = await app.request(`/api/worktrees/slot-paged/history${bad}`, { headers });
    assert.equal(refused.status, 400, bad);
  }
});

test("a page that ends exactly on the last row offers no older page", () => {
  const size = WORKTREE_HISTORY_LIMITS.pageEntries;
  const insert = db.prepare(
    `INSERT INTO worktree_slot_history (pool_id, slot_id, ordinal, at, kind, reason) VALUES ('p', ?, 1, ?, 'transition', ?)`,
  );
  for (let index = 1; index <= size; index += 1) insert.run("slot-exact", index, `entry ${index}`);
  const exact = store.slotHistory("slot-exact");
  assert.equal(exact.entries.length, size);
  assert.equal(exact.nextBefore, null, "exactly a page: nothing older to offer");

  for (let index = 1; index <= size + 1; index += 1) insert.run("slot-over", index, `entry ${index}`);
  const first = store.slotHistory("slot-over");
  assert.equal(first.entries.length, size);
  assert.equal(first.nextBefore, first.entries.at(-1)!.id);
  const second = store.slotHistory("slot-over", first.nextBefore);
  assert.deepEqual(second.entries.map((entry) => entry.reason), ["entry 1"], "one more page, holding the last entry");
  assert.equal(second.nextBefore, null);
});

test("a row a later build wrote reads back as itself, and a broken meta reads as none", () => {
  db.prepare(
    `INSERT INTO worktree_slot_history (pool_id, slot_id, ordinal, at, kind, actor, meta)
     VALUES ('p', 'slot-later', 1, 5, 'a-later-kind', 'a-later-actor', '{broken')`,
  ).run();
  const [entry] = store.slotHistory("slot-later").entries;
  assert.deepEqual([entry!.kind, entry!.actor, entry!.meta], ["a-later-kind", "a-later-actor", null]);
  assert.ok(WorktreeSlotHistoryPageSchema.safeParse(store.slotHistory("slot-later")).success);
});
