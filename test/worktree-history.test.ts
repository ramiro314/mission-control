import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { openDb } from "../src/server/db.ts";
import { Registry } from "../src/server/registry.ts";
import { ReviewManager } from "../src/server/reviews.ts";
import { TaskManager } from "../src/server/tasks.ts";
import { QueueManager } from "../src/server/queue.ts";
import { buildApp } from "../src/server/routes.ts";
import { buildClaimEnvironment, type ClaimStepResult } from "../src/server/worktrees/claim.ts";
import { NativeWorktreeGit } from "../src/server/worktrees/git.ts";
import { WorktreeManager, type WorktreeManagerDeps } from "../src/server/worktrees/manager.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { WorktreeStore, type WorktreeSlotRow, type WorktreeTimingEntry } from "../src/server/worktrees/store.ts";
import { REGISTRATION_OR_IDENTITY, withObservationFailure } from "../src/server/worktrees/quarantine-reasons.ts";
import { taskResourceGeneration } from "../src/server/task-resource-generation.ts";
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

test("the limits are the numbers the operator chose, not whatever the constant says", () => {
  assert.deepEqual(WORKTREE_HISTORY_LIMITS, {
    pageEntries: 50,
    textBytes: 2048,
    metaBytes: 2048,
    retentionDays: 90,
    rowsPerPool: 2000,
    timingWindowSlots: 10,
  });
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
  assert.deepEqual([backRow.fromState, backRow.toState, backRow.actor], ["provisioning", "available", "automatic"]);
  assert.equal(backRow.detail, "slot process occupancy is unknown (ps timed out)", "the failed read that refused it");

  const { result: pruning, row: removal } = oneRowFrom(() => store.markPruning(handedBack.id, handedBack.version, 600)!);
  assert.deepEqual([removal.fromState, removal.toState, removal.actor], ["available", "pruning", "operator"]);

  const { row: gone } = oneRowFrom(() => store.removePruned(pruning.id, pruning.version, 610, "operator"));
  assert.deepEqual([gone.fromState, gone.toState, gone.actor], ["pruning", null, "operator"]);
  assert.equal(store.slot(pruning.id), null);
  assert.equal(historyOf(pruning.id).length, 10, "the row went and its history stayed");
});

test("a reservation handed back is recorded against the owner it was reserved for", () => {
  const slot = leased();
  const returning = store.markReturning(slot.id, slot.version, "b".repeat(40), 300)!;
  const free = store.completeRelease(returning.id, returning.version, "b".repeat(40), 400)!;
  const reservation = store.reserveAvailable({
    slotId: free.id,
    version: free.version,
    leaseId: "lease-task",
    ownerKind: "task",
    ownerKey: "task-2",
    requestedHeadSha: "b".repeat(40),
    now: 500,
  })!;
  const { row } = oneRowFrom(() => store.releaseReservation({
    slotId: reservation.id,
    version: reservation.version,
    leaseId: "lease-task",
    requestedHeadSha: "b".repeat(40),
    lastError: null,
    now: 510,
  }));
  assert.deepEqual([row.fromState, row.toState, row.actor, row.detail], ["provisioning", "available", "owner", null]);
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
  const versions = historyOf(lease.slotId)
    .filter((entry) => entry.kind === "transition")
    .reverse()
    .map((entry) => entry.meta?.version);
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

test("Open terminal's lease, and handing it back unused, name the operator", async () => {
  const { clone, sha } = repository("mission-history-terminal-");
  const m = realManager();
  const acquired = await m.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "manual", key: "m-terminal" } });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  assert.equal((await m.release(acquired.lease, { ownerAuthorized: true })).outcome, "released");
  const before = trail(acquired.lease.slotId).length;

  const taken = await m.leaseAsIs(acquired.lease.slotId, { kind: "manual", key: "terminal-1" });
  assert.equal(taken.outcome, "leased", JSON.stringify(taken));
  if (taken.outcome !== "leased") return;
  assert.equal(await m.handBackAsIs(taken.lease), true);

  assert.deepEqual(trail(acquired.lease.slotId).slice(before), [
    "available -> provisioning (operator)",
    "provisioning -> leased (operator)",
    "leased -> returning (operator)",
    "returning -> available (operator)",
  ]);
});

test("a card's Repair names the operator, and its automatic recovery stays automatic", async () => {
  const { clone, sha } = repository("mission-history-repair-");
  const m = realManager();
  const legacy = new LegacyTreehouseService(db);
  const operations = new WorktreeOperationsService(m, {
    legacy,
    tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
    checks: new CheckLeaseManager(db, { manager: m, legacy }),
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => 0,
  });
  const broken = async (key: string) => {
    const acquired = await m.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "task", key } });
    assert.equal(acquired.outcome, "acquired");
    if (acquired.outcome !== "acquired") throw new Error("not acquired");
    assert.equal((await m.release(acquired.lease, { ownerAuthorized: true })).outcome, "released");
    assert.ok(m.store.quarantine(acquired.lease.slotId, REGISTRATION_OR_IDENTITY.unsafeRegistration, null, Date.now()));
    rmSync(join(acquired.lease.path, ".git"));
    return acquired.lease.slotId;
  };

  const carded = await broken("task-repair-card");
  const preview = await operations.preview({ action: "repair", slotId: carded });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  await operations.execute(preview.token, []);
  assert.deepEqual(trail(carded).slice(-2), [
    "quarantined -> returning (operator)",
    "returning -> available (operator)",
  ]);

  const passed = await broken("task-repair-pass");
  await m.recoverQuarantines();
  assert.deepEqual(trail(passed).slice(-2), [
    "quarantined -> returning (automatic)",
    "returning -> available (automatic)",
  ]);
});

test("a reservation an operator's action hands back names the operator", async () => {
  const { clone, sha } = repository("mission-history-handback-");
  const claim: WorktreeClaim = {
    steps: [{ argv: [process.execPath, "-e", ""], env: [] }], timeoutMinutes: 1, fingerprintPaths: [],
  };
  // A process walks in during the reservation: idle at the screening, occupied once reserved.
  let m: WorktreeManager | null = null;
  m = realManager({
    resolvePolicy: () => ({ enabled: true, maxSlots: 4, setupArgv: null, claim }),
    claimEnvironment: async (names) => claimEnvironment(names),
    occupancy: (paths) => Promise.resolve(new Map(paths.map((path) => [path, {
      status: "known" as const,
      occupants: m?.store.slotByPath(path)?.state === "provisioning" && m.store.slotByPath(path)?.activeOwnerKey !== "m1"
        ? [{ pid: 4242, ppid: 1, startRaw: "x", startMs: 1, command: "node", cwd: path, knownOwner: null }]
        : [],
    }]))),
  });
  const acquired = await m.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "manual", key: "m1" } });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  assert.equal((await m.release(acquired.lease, { ownerAuthorized: true })).outcome, "released");
  const { slotId } = acquired.lease;

  const opened = await m.leaseAsIs(slotId, { kind: "manual", key: "terminal-entered" });
  assert.equal(opened.outcome, "refused", JSON.stringify(opened));
  assert.deepEqual(trail(slotId).slice(-2), [
    "available -> provisioning (operator)",
    "provisioning -> available (operator)",
  ]);

  const warmed = await m.warmSlot({
    slotId, operationId: "op-entered", signal: new AbortController().signal, output: () => {}, log: null,
  });
  assert.equal(warmed.outcome, "skipped", JSON.stringify(warmed));
  assert.deepEqual(trail(slotId).slice(-2), [
    "available -> provisioning (operator)",
    "provisioning -> available (operator)",
  ]);
});

test("a return the daemon decides on its own is automatic, through the check and task routes", async () => {
  const { clone, sha } = repository("mission-history-daemon-");
  const m = realManager({ ownerReferenced: async () => true });
  const legacy = new LegacyTreehouseService(db);
  const registry = new Registry();
  const tasks = new TaskManager(registry, undefined, undefined, undefined, undefined, undefined, m);
  const checks = new CheckLeaseManager(db, { manager: m, legacy });
  const take = async (key: string) => {
    const acquired = await m.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "task", key } });
    assert.equal(acquired.outcome, "acquired");
    if (acquired.outcome !== "acquired") throw new Error("not acquired");
    return acquired.lease;
  };
  const settled = (id: string, lease: Awaited<ReturnType<typeof take>>) => {
    const task = mkTask({
      id,
      status: "failed",
      repoRoot: clone,
      worktreePath: lease.path,
      provider: "mission",
      worktreeLeaseId: lease.leaseId,
    });
    registry.upsertTask(task);
    return task;
  };
  const daemonRows = ["leased -> returning (automatic)", "returning -> available (automatic)"];

  // A check lease its attempt stopped tending, reclaimed by one real maintenance pass.
  const attemptId = "check-leaked";
  await checks.acquireForAttempt({ attemptId, submissionId: "sub-leaked", nodeId: "node-leaked", repoRoot: clone, headSha: sha });
  const leaked = m.store.slots().find((slot) => slot.activeOwnerKey === attemptId)!;
  checks.handOffForReclaim(attemptId);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    m.startMaintenance(() => checks.reclaimLeaked(async () => "empty"));
    mock.timers.tick(300_000);
    await m.stop();
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(trail(leaked.id).slice(-2), daemonRows);

  const reclaimed = await take("task-settled:0");
  const task = settled("task-settled", reclaimed);
  await tasks["reclaimSettledTreesIfClean"](task.id);
  assert.deepEqual(trail(reclaimed.slotId).slice(-2), daemonRows);

  const retained = await take("task-retained:0");
  const retainedTask = settled("task-retained", retained);
  const outcome = await tasks.enqueueRetentionCleanup({
    taskId: retainedTask.id,
    generation: taskResourceGeneration(retainedTask),
    fingerprint: "fp",
    probe: async () => ({ kind: "known", digest: "fp" }),
  });
  assert.equal(outcome.kind, "reclaimed", JSON.stringify(outcome));
  assert.deepEqual(trail(retained.slotId).slice(-2), daemonRows);
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
      argv: [process.execPath, "-e", "console.log(process.env.CLAIM_TOKEN+['output','of','the','step'].join('-'));process.exit(3)"],
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
  assert.ok(!rows.includes("output-of-the-step"), "and nothing the step printed");

  const [row] = historyOf(slot.id).filter((entry) => entry.kind === "claim");
  assert.equal(row!.outcome, "failed");
  assert.equal(row!.reason, "step 1 of 1 exited with code 3");
  assert.match(row!.detail!, /process\.env\.CLAIM_TOKEN/, "the step's command, which is the operator's own argv");
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

function timing(slotId: string, kind: WorktreeTimingEntry["kind"], at: number, durationMs: number, outcome: string, poolId = "pool-a"): void {
  store.recordTiming(
    { id: slotId, poolId, ordinal: 1 },
    { kind, at, durationMs, outcome, reason: null, actor: "owner" } as WorktreeTimingEntry,
  );
}

test("a pool's timings are the median and seed hits of its last 10 new slots, read from history", () => {
  assert.deepEqual(store.poolTimings("pool-a"), { newSlots: 0, medianProvisioningMs: null, seededSlots: 0 });

  timing("first", "provisioning", 1, 1_000, "new");
  assert.deepEqual(store.poolTimings("pool-a"), { newSlots: 1, medianProvisioningMs: 1_000, seededSlots: 0 });

  timing("hit", "seed", 2, 5, "placed");
  timing("hit", "provisioning", 3, 3_000, "new");
  timing("miss", "seed", 4, 5, "none");
  timing("miss", "provisioning", 5, 8_000, "new");
  assert.deepEqual(store.poolTimings("pool-a"), { newSlots: 3, medianProvisioningMs: 3_000, seededSlots: 1 }, "odd: the middle one");
  timing("late", "provisioning", 6, 100_000, "new");
  assert.deepEqual(store.poolTimings("pool-a"), { newSlots: 4, medianProvisioningMs: 5_500, seededSlots: 1 }, "even: between the two");

  // Neither a reused slot's lease, nor a later seed of an existing slot, nor another pool counts.
  timing("hit", "provisioning", 7, 9_999_999, "reused");
  timing("first", "seed", 8, 5, "placed");
  timing("first", "provisioning", 9, 9_999_999, "reused");
  timing("other", "provisioning", 10, 9_999_999, "new", "pool-b");
  assert.deepEqual(store.poolTimings("pool-a"), { newSlots: 4, medianProvisioningMs: 5_500, seededSlots: 1 });

  // The window: ten newer new slots, all seeded, push out all four above.
  for (let index = 0; index < 10; index += 1) {
    timing(`window-${index}`, "seed", 20 + index, 5, "placed");
    timing(`window-${index}`, "provisioning", 40 + index, (index + 1) * 60_000, "new");
  }
  assert.deepEqual(store.poolTimings("pool-a"), { newSlots: 10, medianProvisioningMs: 330_000, seededSlots: 10 });
});

test("a slot's timings are the newest of each kind, each with its duration and outcome", () => {
  const slot = { id: "slot-a", poolId: "pool-a", ordinal: 1 };
  assert.deepEqual(store.slotTimings("slot-a"), { provisioning: null, claim: null, seed: null });
  timing("slot-a", "provisioning", 1, 1_000, "new");
  timing("slot-a", "provisioning", 2, 2_000, "reused");
  store.recordTiming(slot, {
    kind: "seed", at: 3, durationMs: 40, outcome: "placed", reason: null, actor: "owner", meta: { sourceSlotId: "slot-b", sourceOrdinal: 7 },
  });
  store.recordTiming(slot, {
    kind: "claim", at: 4, durationMs: 50, outcome: "failed", reason: "step 1 of 1 exited", detail: "yarn install", actor: "owner",
  });
  assert.deepEqual(store.slotTimings("slot-a"), {
    provisioning: { at: 2, outcome: "reused", durationMs: 2_000, reason: null, sourceOrdinal: null },
    claim: { at: 4, outcome: "failed", durationMs: 50, reason: "step 1 of 1 exited", sourceOrdinal: null },
    seed: { at: 3, outcome: "placed", durationMs: 40, reason: null, sourceOrdinal: 7 },
  });
  const claim = historyOf("slot-a")[0]!;
  assert.deepEqual([claim.kind, claim.durationMs, claim.detail, claim.toState], ["claim", 50, "yarn install", null]);
});

/**
 * A repository whose `deps/` a claim installs and a seed copies, and a manager whose clock moves
 * only when a step spends time, so every duration below is exact. `occupied` names a path that
 * reads as occupied once: an idle sibling is otherwise leased in preference to a new slot, so
 * this is how a new slot reaches one, an occupant leaving between its screening and its seed.
 */
function timedManager(
  prefix: string,
  options: {
    seed?: WorktreeClaim["seed"];
    install?: number;
    clone?: number;
    cloneResult?: Awaited<ReturnType<WorktreeManagerDeps["cloneTree"]>>;
    /** What the claim's step does in place of succeeding; undefined lets it install and succeed. */
    step?: (m: WorktreeManager) => ClaimStepResult | undefined;
    git?: WorktreeManagerDeps["git"];
  },
) {
  const { origin, clone } = mkOriginAndClone(prefix);
  writeFileSync(join(origin, ".gitignore"), "deps/\n");
  gitIn(origin, "add", "-A");
  gitIn(origin, "commit", "-qm", "ignore deps");
  gitIn(clone, "fetch", "-q", "origin");
  gitIn(clone, "reset", "-q", "--hard", "origin/main");
  const sha = gitIn(clone, "rev-parse", "HEAD");
  const state = { now: 1_000_000, steps: 0, occupied: null as string | null };
  const claim: WorktreeClaim = {
    steps: [{ argv: ["install"], env: [] }],
    timeoutMinutes: 60,
    fingerprintPaths: [".gitignore"],
    ...(options.seed ? { seed: options.seed } : {}),
  };
  const m: WorktreeManager = realManager({
    now: () => state.now,
    resolvePolicy: () => ({ enabled: true, maxSlots: 4, setupArgv: null, claim }),
    claimEnvironment: async (names) => claimEnvironment(names),
    ...(options.git ? { git: options.git } : {}),
    occupancy: (paths) => Promise.resolve(new Map(paths.map((path) => {
      if (path !== state.occupied) return [path, { status: "known", occupants: [] }];
      state.occupied = null;
      return [path, {
        status: "known",
        occupants: [{ pid: 4242, ppid: 1, startMs: 1, startRaw: "1", command: "editor", cwd: path, knownOwner: null, session: null }],
      }];
    }))),
    runClaimStep: async (request): Promise<ClaimStepResult> => {
      state.steps += 1;
      state.now += options.install ?? 0;
      const result = options.step?.(m);
      if (result) return result;
      mkdirSync(join(request.cwd, "deps"), { recursive: true });
      writeFileSync(join(request.cwd, "deps", "marker"), "installed\n");
      return { outcome: "exited", code: 0, signal: null, tail: "", truncatedBytes: 0 };
    },
    cloneTree: async (request) => {
      state.now += options.clone ?? 0;
      if (options.cloneResult) return options.cloneResult;
      cpSync(request.source, request.destination, { recursive: true });
      return { outcome: "cloned" };
    },
  });
  const acquire = (key: string, baseSha = sha) =>
    m.acquire({ repositoryPath: clone, baseSha, owner: { kind: "task", key }, runClaim: true });
  const lease = async (key: string, baseSha = sha) => {
    const acquired = await acquire(key, baseSha);
    assert.equal(acquired.outcome, "acquired", JSON.stringify(acquired));
    if (acquired.outcome !== "acquired") throw new Error("not acquired");
    return acquired.lease;
  };
  return { m, acquire, lease, state, origin, clone };
}

/** Oldest first, as [kind, outcome, duration, actor], without the transitions. */
function timedRows(slotId: string) {
  return historyOf(slotId)
    .filter((entry) => entry.kind !== "transition")
    .reverse()
    .map((entry) => [entry.kind, entry.outcome, entry.durationMs, entry.actor]);
}

test("a new slot records its seed, claim and provisioning, and a reused one its own provisioning", async () => {
  const { m, lease, state } = timedManager("mission-history-timing-new-", { seed: { paths: ["deps"], exclude: [] }, install: 600_000 });
  const first = await lease("task-first");
  assert.deepEqual(timedRows(first.slotId), [
    ["seed", "none", 0, "owner"],
    ["claim", "succeeded", 600_000, "owner"],
    ["provisioning", "new", 600_000, "owner"],
  ]);
  assert.equal(historyOf(first.slotId).find((entry) => entry.kind === "seed")!.reason, "no idle sibling holds a current install");

  assert.equal((await m.release(first, { ownerAuthorized: true })).outcome, "released");
  const second = await lease("task-second");
  assert.equal(second.slotId, first.slotId, "the same slot, reused");
  assert.equal(state.steps, 1, "its install still matches");
  assert.deepEqual(timedRows(first.slotId).slice(3), [
    ["claim", "skipped", 0, "owner"],
    ["provisioning", "reused", 0, "owner"],
  ], "and no seed was wanted, so none is recorded over the last real one");
  assert.deepEqual(m.store.poolTimings(first.poolId), { newSlots: 1, medianProvisioningMs: 600_000, seededSlots: 0 });
});

test("a seed names its source and its duration, and a new slot it served counts as a hit", async () => {
  const { m, lease, state } = timedManager("mission-history-timing-hit-", {
    seed: { paths: ["deps"], exclude: [] }, install: 600_000, clone: 5_000,
  });
  const source = await lease("task-source");
  assert.equal((await m.release(source, { ownerAuthorized: true })).outcome, "released");
  const sourceSlot = m.store.slot(source.slotId)!;

  state.occupied = sourceSlot.path;
  const seeded = await lease("task-seeded");
  assert.notEqual(seeded.slotId, source.slotId, "a new slot");
  assert.equal(state.steps, 1, "the seed's source matches this commit, so the steps were skipped");
  assert.deepEqual(timedRows(seeded.slotId), [
    ["seed", "placed", 5_000, "owner"],
    ["claim", "succeeded", 5_000, "owner"],
    ["provisioning", "new", 5_000, "owner"],
  ]);
  assert.equal(m.store.slotTimings(seeded.slotId).seed!.sourceOrdinal, sourceSlot.ordinal);
  assert.equal(historyOf(seeded.slotId).find((entry) => entry.kind === "seed")!.meta!.sourceSlotId, sourceSlot.id);
  assert.deepEqual(m.store.poolTimings(seeded.poolId), { newSlots: 2, medianProvisioningMs: 302_500, seededSlots: 1 });
});

test("a seed abandoned at its source names it and why, and is no hit", async () => {
  const { m, lease, state } = timedManager("mission-history-timing-abandoned-", {
    seed: { paths: ["deps"], exclude: [] },
    clone: 2_000,
    cloneResult: { outcome: "failed", reason: "this volume cannot clone" },
  });
  const source = await lease("task-source");
  assert.equal((await m.release(source, { ownerAuthorized: true })).outcome, "released");

  state.occupied = m.store.slot(source.slotId)!.path;
  const target = await lease("task-target");
  assert.equal(state.steps, 2, "the steps ran instead");
  assert.deepEqual(timedRows(target.slotId).slice(0, 2), [
    ["seed", "abandoned", 2_000, "owner"],
    ["claim", "succeeded", 2_000, "owner"],
  ]);
  const seed = m.store.slotTimings(target.slotId).seed!;
  assert.match(seed.reason!, /this volume cannot clone/);
  assert.equal(seed.sourceOrdinal, m.store.slot(source.slotId)!.ordinal);
  assert.equal(m.store.poolTimings(target.poolId).seededSlots, 0);
});

test("a pool whose claim lists no seed says so, and a lease with no claim records only its provisioning", async () => {
  const { lease } = timedManager("mission-history-timing-unseeded-", {});
  const claimed = await lease("task-claimed");
  assert.deepEqual(timedRows(claimed.slotId).map(([kind]) => kind), ["seed", "claim", "provisioning"]);
  assert.equal(store.slotTimings(claimed.slotId).seed!.reason, "the pool's claim configures no seed");

  const { clone, sha } = repository("mission-history-timing-unclaimed-");
  const acquired = await realManager().acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "task", key: "task-plain" } });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  assert.deepEqual(timedRows(acquired.lease.slotId).map(([kind]) => kind), ["provisioning"]);
});

test("a Warm's claim names the operator, and a Warm is no provisioning", async () => {
  const { m, lease } = timedManager("mission-history-timing-warm-", {});
  const first = await lease("task-first");
  assert.equal((await m.release(first, { ownerAuthorized: true })).outcome, "released");
  const before = timedRows(first.slotId).length;

  const warmed = await m.warmSlot({
    slotId: first.slotId, operationId: "op-warm-timing", signal: new AbortController().signal, output: () => {}, log: null,
  });
  assert.equal(warmed.outcome, "warmed", JSON.stringify(warmed));
  assert.deepEqual(timedRows(first.slotId).slice(before), [["claim", "skipped", 0, "operator"]]);
});

test("a timing that cannot be written costs that row, never the lease", async () => {
  const { lease, m } = timedManager("mission-history-timing-refused-", {});
  db.exec(`
    CREATE TEMP TRIGGER refuse_history BEFORE INSERT ON main.worktree_slot_history
    WHEN NEW.kind IN ('provisioning', 'claim', 'seed')
    BEGIN SELECT RAISE(ABORT, 'history refused'); END;
  `);
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const granted = await lease("task-refused");
    assert.equal(m.store.slot(granted.slotId)!.state, "leased");
    assert.deepEqual(timedRows(granted.slotId), []);
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.some((args) => /the provisioning timing of .* was not recorded/.test(String(args[0]))));
});

test("the inventory carries each slot's last timings and its pool's summary", async () => {
  const { m, lease } = timedManager("mission-history-timing-inventory-", { install: 60_000 });
  const granted = await lease("task-inventory");
  const legacy = new LegacyTreehouseService(db);
  const operations = new WorktreeOperationsService(m, {
    legacy,
    tasks: { get: () => null, reclaim: async () => ({ ok: true }) },
    checks: new CheckLeaseManager(db, { manager: m, legacy }),
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => 0,
  });
  const [repo] = (await operations.inventory()).repositories;
  assert.deepEqual(repo!.timings, { newSlots: 1, medianProvisioningMs: 60_000, seededSlots: 0 });
  const slot = repo!.slots.find((candidate) => candidate.id === granted.slotId)!;
  assert.equal(slot.timings.provisioning!.outcome, "new");
  assert.equal(slot.timings.claim!.durationMs, 60_000);
  assert.equal(slot.timings.seed!.outcome, "none");
});


const SEED_DEPS = { paths: ["deps"], exclude: [] };

/** The one slot a refused acquire reserved, which no lease handed back. */
function onlySlot(m: WorktreeManager, except?: string): WorktreeSlotRow {
  const [slot, ...rest] = m.store.slots().filter((candidate) => candidate.id !== except);
  assert.ok(slot);
  assert.deepEqual(rest, []);
  return slot;
}

function seedRow(slotId: string) {
  return historyOf(slotId).find((entry) => entry.kind === "seed")!;
}

test("a claim stopped by a shutdown records its duration, and no grant means no provisioning row", async () => {
  const { m, acquire } = timedManager("mission-history-timing-shutdown-", {
    install: 7_000,
    step: (manager) => {
      manager.stopClaims();
      return { outcome: "stopped", tail: "", truncatedBytes: 0 };
    },
  });
  assert.equal((await acquire("task-shutdown")).outcome, "outcomeUnknown");
  assert.deepEqual(timedRows(onlySlot(m).id), [
    ["seed", "none", 0, "owner"],
    ["claim", "shutdown", 7_000, "owner"],
  ]);
  assert.deepEqual(m.store.poolTimings(onlySlot(m).poolId), { newSlots: 0, medianProvisioningMs: null, seededSlots: 0 });
});

test("a claim whose outcome could not be recorded keeps that reason, and is granted nothing", async () => {
  const { m, acquire } = timedManager("mission-history-timing-unrecorded-", { install: 4_000 });
  m.store.finishClaim = () => false;
  assert.equal((await acquire("task-unrecorded")).outcome, "outcomeUnknown");
  const slot = onlySlot(m);
  assert.deepEqual(timedRows(slot.id).slice(-1), [["claim", "unrecorded", 4_000, "owner"]]);
  assert.equal(m.store.slotTimings(slot.id).claim!.reason, "the dependency claim outcome could not be recorded");
  assert.equal(m.store.slotTimings(slot.id).provisioning, null);
});

test("a new slot granted after a failed claim is recorded, and counts at the time it took", async () => {
  const { m, lease } = timedManager("mission-history-timing-failed-grant-", {
    install: 30_000,
    step: () => ({ outcome: "exited", code: 3, signal: null, tail: "", truncatedBytes: 0 }),
  });
  const granted = await lease("task-failed-claim");
  assert.deepEqual(timedRows(granted.slotId), [
    ["seed", "none", 0, "owner"],
    ["claim", "failed", 30_000, "owner"],
    ["provisioning", "new", 30_000, "owner"],
  ]);
  assert.deepEqual(m.store.poolTimings(granted.poolId), { newSlots: 1, medianProvisioningMs: 30_000, seededSlots: 0 });
});

test("a seed cut off at its source names it and why, and is no hit", async () => {
  const { m, lease, state } = timedManager("mission-history-timing-cut-off-", {
    seed: SEED_DEPS,
    clone: 3_000,
    cloneResult: { outcome: "timedOut" },
  });
  const source = await lease("task-source");
  assert.equal((await m.release(source, { ownerAuthorized: true })).outcome, "released");
  const sourceOrdinal = m.store.slot(source.slotId)!.ordinal;

  state.occupied = m.store.slot(source.slotId)!.path;
  const target = await lease("task-target");
  assert.deepEqual(timedRows(target.slotId), [
    ["seed", "interrupted", 3_000, "owner"],
    ["claim", "failed", 3_000, "owner"],
    ["provisioning", "new", 3_000, "owner"],
  ]);
  const seed = m.store.slotTimings(target.slotId).seed!;
  assert.equal(seed.reason, "did not run, because the dependency seed reached the claim's time limit");
  assert.equal(seed.sourceOrdinal, sourceOrdinal);
  assert.deepEqual(m.store.poolTimings(target.poolId), { newSlots: 2, medianProvisioningMs: 1_500, seededSlots: 0 });
});

test("a seed whose intent could not be recorded names its source, and is granted nothing", async () => {
  const { m, acquire, lease, state } = timedManager("mission-history-timing-seed-unrecorded-", { seed: SEED_DEPS });
  const source = await lease("task-source");
  assert.equal((await m.release(source, { ownerAuthorized: true })).outcome, "released");
  const sourceSlot = m.store.slot(source.slotId)!;

  state.occupied = sourceSlot.path;
  m.store.beginSeed = () => false;
  assert.equal((await acquire("task-target")).outcome, "outcomeUnknown");
  const target = onlySlot(m, source.slotId);
  assert.deepEqual(timedRows(target.id).map(([kind, outcome]) => [kind, outcome]), [["seed", "unrecorded"], ["claim", "unrecorded"]]);
  assert.equal(seedRow(target.id).meta!.sourceOrdinal, sourceSlot.ordinal);
  assert.equal(m.store.slotTimings(target.id).claim!.reason, "the dependency seed intent could not be recorded");
});

test("a sibling that could not be held is why there was no seed", async () => {
  const { m, lease, state } = timedManager("mission-history-timing-unheld-", { seed: SEED_DEPS });
  const source = await lease("task-source");
  assert.equal((await m.release(source, { ownerAuthorized: true })).outcome, "released");

  state.occupied = m.store.slot(source.slotId)!.path;
  m.store.reserveAvailable = () => null;
  const target = await lease("task-target");
  assert.deepEqual([seedRow(target.slotId).outcome, seedRow(target.slotId).reason], ["none", "no idle sibling could be held"]);
  assert.equal(m.store.slotTimings(target.slotId).seed!.sourceOrdinal, null);
});

test("siblings that could not be read are why there was no seed", async () => {
  // The second listing is the seed's own screening: acquisition's read the pool as it should.
  let listings = 0;
  let failing = false;
  class SeedListingFails extends NativeWorktreeGit {
    override list(...args: Parameters<NativeWorktreeGit["list"]>): ReturnType<NativeWorktreeGit["list"]> {
      listings += 1;
      return failing && listings === 2
        ? Promise.resolve({ ok: false, reason: "git worktree list timed out after 15 s", outcomeUnknown: true })
        : super.list(...args);
    }
  }
  const { m, lease, state } = timedManager("mission-history-timing-unread-", { seed: SEED_DEPS, git: new SeedListingFails() });
  const source = await lease("task-source");
  assert.equal((await m.release(source, { ownerAuthorized: true })).outcome, "released");

  listings = 0;
  failing = true;
  state.occupied = m.store.slot(source.slotId)!.path;
  const target = await lease("task-target");
  assert.equal(seedRow(target.slotId).outcome, "none");
  assert.match(seedRow(target.slotId).reason!, /^its siblings could not be read: .*git worktree list timed out after 15 s/);
});

test("a stale slot with no sibling matching its commit says that is why it had no seed", async () => {
  const { m, lease, origin, clone } = timedManager("mission-history-timing-stale-", { seed: SEED_DEPS });
  const first = await lease("task-first");
  assert.equal((await m.release(first, { ownerAuthorized: true })).outcome, "released");

  writeFileSync(join(origin, ".gitignore"), "deps/\n# a new fingerprint\n");
  gitIn(origin, "add", "-A");
  gitIn(origin, "commit", "-qm", "change the fingerprint");
  gitIn(clone, "fetch", "-q", "origin");
  const second = await lease("task-second", gitIn(clone, "rev-parse", "origin/main"));
  assert.equal(second.slotId, first.slotId, "the same slot, now stale");
  const newest = historyOf(first.slotId).filter((entry) => entry.kind === "seed")[0]!;
  assert.deepEqual([newest.outcome, newest.reason], ["none", "no idle sibling matches this commit's dependencies"]);
});

test("cut-off seed paths that cannot be removed are why there was no seed", async () => {
  // `keep.txt` is tracked, so the wipe refuses it whole.
  const { m, lease } = timedManager("mission-history-timing-wipe-", { seed: { paths: ["keep.txt"], exclude: [] } });
  const first = await lease("task-first");
  assert.equal((await m.release(first, { ownerAuthorized: true })).outcome, "released");
  db.prepare(`UPDATE worktree_slots SET deps_state = 'interrupted', deps_fingerprint = NULL WHERE id = ?`).run(first.slotId);

  const second = await lease("task-second");
  assert.equal(second.slotId, first.slotId);
  assert.deepEqual(timedRows(first.slotId).slice(3).map(([kind, outcome]) => [kind, outcome]), [
    ["seed", "none"],
    ["claim", "failed"],
    ["provisioning", "reused"],
  ]);
  assert.equal(m.store.slotTimings(first.slotId).seed!.reason, "the paths of the seed that was cut off could not be removed");
});
