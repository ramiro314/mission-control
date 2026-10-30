import type { DatabaseSync } from "node:sqlite";
import type { WorktreeSlotHistoryEntry, WorktreeSlotHistoryPage } from "../../shared/protocol.ts";
import {
  WORKTREE_HISTORY_LIMITS,
  type WorktreeClaimOutcome,
  type WorktreeHistoryActor,
  type WorktreeHistoryKind,
  type WorktreePoolTimingsView,
  type WorktreeProvisioningOutcome,
  type WorktreeSeedOutcome,
  type WorktreeSlotTimingsView,
  type WorktreeTimingView,
} from "../../shared/worktrees.ts";
import { clipUtf8Bytes } from "../util/utf8.ts";
import { splitObservationFailure } from "./quarantine-reasons.ts";

export const WORKTREE_SLOT_STATES = [
  "provisioning",
  "available",
  "leased",
  "returning",
  "pruning",
  "quarantined",
] as const;
export type WorktreeSlotState = (typeof WORKTREE_SLOT_STATES)[number];

/**
 * A slot's dependency claim state. Append-only, like the slot states: a later build adds a
 * value, it never renames one. A NULL column is "never claimed".
 *
 * - `current`: every step of the last claim succeeded; the fingerprint beside it is trusted.
 * - `claiming`: the write-ahead before a claim's first step. Only a live claim holds it, so
 *   startup finding it means the claim was interrupted.
 * - `failed`: the last claim failed, timed out or was stopped; it left no fingerprint.
 * - `interrupted`: startup found `claiming` or `seeding`, or a seed was stopped or timed out.
 *   The next claim removes the seed paths and starts cold.
 * - `seeding`: the write-ahead before a seed renames anything into the tree. Like `claiming`,
 *   only a live claim holds it.
 */
export const WORKTREE_DEPS_STATES = ["current", "claiming", "failed", "interrupted", "seeding"] as const;
export type WorktreeDepsState = (typeof WORKTREE_DEPS_STATES)[number];

/** The write-aheads. Only a live claim holds one, so one found with no claim running was cut off. */
export const WORKTREE_DEPS_WRITE_AHEAD_STATES = ["claiming", "seeding"] as const satisfies readonly WorktreeDepsState[];

export function isDepsWriteAhead(state: string | null): boolean {
  return (WORKTREE_DEPS_WRITE_AHEAD_STATES as readonly string[]).includes(state ?? "");
}

/**
 * Whether a slot's last claim or seed was cut off, so its seed paths may be half renamed and
 * its next claim must start cold: `interrupted`, a write-ahead, or a state a later build wrote.
 * Only no state at all, `current` and `failed` are settled.
 */
export function depsCutOff(state: string | null): boolean {
  return state !== null && state !== "current" && state !== "failed";
}

export interface WorktreePoolRow {
  id: string;
  gitCommonDirectory: string;
  mainCheckoutRoot: string;
  poolPath: string;
  ordinalHighWater: number;
  lastReconciledAt: number | null;
  reconciliationError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorktreeSlotRow {
  id: string;
  poolId: string;
  ordinal: number;
  path: string;
  /** Read as string so a newer append-only state fails closed instead of being coerced. */
  state: string;
  version: number;
  requestedHeadSha: string | null;
  currentHeadSha: string | null;
  activeLeaseId: string | null;
  activeOwnerKind: string | null;
  activeOwnerKey: string | null;
  leasedAt: number | null;
  lastReleasedLeaseId: string | null;
  lastReleasedOwnerKind: string | null;
  lastReleasedOwnerKey: string | null;
  lastUsedAt: number | null;
  quarantineReason: string | null;
  lastError: string | null;
  /** When the slot last entered quarantine. Kept across a re-quarantine of a quarantined slot. */
  quarantinedAt: number | null;
  /** Read as string for the same fail-closed reason as `state`. Null is never claimed. */
  depsState: string | null;
  depsFingerprint: string | null;
  /** The commit the fingerprint was taken at. */
  depsFingerprintSha: string | null;
  depsClaimedAt: number | null;
  /** The last claim's failure: the failing step and its output tail. */
  depsLastError: string | null;
  /** The full log of the most recent Warm that held this slot. */
  depsLogPath: string | null;
  createdAt: number;
  updatedAt: number;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function poolRow(row: Record<string, unknown>): WorktreePoolRow {
  return {
    id: String(row.id),
    gitCommonDirectory: String(row.git_common_dir),
    mainCheckoutRoot: String(row.main_checkout_root),
    poolPath: String(row.pool_path),
    ordinalHighWater: Number(row.ordinal_high_water),
    lastReconciledAt: row.last_reconciled_at === null ? null : Number(row.last_reconciled_at),
    reconciliationError: row.reconciliation_error === null ? null : String(row.reconciliation_error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function slotRow(row: Record<string, unknown>): WorktreeSlotRow {
  return {
    id: String(row.id),
    poolId: String(row.pool_id),
    ordinal: Number(row.ordinal),
    path: String(row.path),
    state: String(row.state),
    version: Number(row.version),
    requestedHeadSha: row.requested_head_sha === null ? null : String(row.requested_head_sha),
    currentHeadSha: row.current_head_sha === null ? null : String(row.current_head_sha),
    activeLeaseId: row.active_lease_id === null ? null : String(row.active_lease_id),
    activeOwnerKind: row.active_owner_kind === null ? null : String(row.active_owner_kind),
    activeOwnerKey: row.active_owner_key === null ? null : String(row.active_owner_key),
    leasedAt: row.leased_at === null ? null : Number(row.leased_at),
    lastReleasedLeaseId:
      row.last_released_lease_id === null ? null : String(row.last_released_lease_id),
    lastReleasedOwnerKind:
      row.last_released_owner_kind === null ? null : String(row.last_released_owner_kind),
    lastReleasedOwnerKey:
      row.last_released_owner_key === null ? null : String(row.last_released_owner_key),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    quarantineReason: row.quarantine_reason === null ? null : String(row.quarantine_reason),
    lastError: row.last_error === null ? null : String(row.last_error),
    quarantinedAt: row.quarantined_at === null || row.quarantined_at === undefined
      ? null
      : Number(row.quarantined_at),
    depsState: nullableString(row.deps_state),
    depsFingerprint: nullableString(row.deps_fingerprint),
    depsFingerprintSha: nullableString(row.deps_fingerprint_sha),
    depsClaimedAt: row.deps_claimed_at === null || row.deps_claimed_at === undefined
      ? null
      : Number(row.deps_claimed_at),
    depsLastError: nullableString(row.deps_last_error),
    depsLogPath: nullableString(row.deps_log_path),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A row's fields beyond the slot it belongs to. Only what a writer knows; the rest stays NULL. */
interface WorktreeHistoryInput {
  at: number;
  kind: WorktreeHistoryKind;
  fromState: string | null;
  toState: string | null;
  reason: string | null;
  /** Never a claim step's output: only a failed read's or a Git command's bounded reason. */
  detail?: string | null;
  outcome?: string | null;
  actor: WorktreeHistoryActor;
  durationMs?: number | null;
  meta?: Record<string, unknown> | null;
}

/** What a transition's history row says; the store fills in the states on either side of it. */
type WorktreeTransitionEntry = Pick<WorktreeHistoryInput, "reason" | "detail" | "actor">;

/** A timed step's history row: when it ended, how long it took, and how it came out. */
export type WorktreeTimingEntry =
  & Pick<WorktreeHistoryInput, "at" | "reason" | "detail" | "actor" | "meta">
  & { durationMs: number }
  & (
    | { kind: "provisioning"; outcome: WorktreeProvisioningOutcome }
    | { kind: "claim"; outcome: WorktreeClaimOutcome }
    | { kind: "seed"; outcome: WorktreeSeedOutcome }
  );

function boundedMeta(meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta) return null;
  const json = JSON.stringify(meta);
  return Buffer.byteLength(json, "utf8") <= WORKTREE_HISTORY_LIMITS.metaBytes ? json : '{"truncated":true}';
}

function parsedMeta(json: string | null): Record<string, unknown> | null {
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function historyEntry(row: Record<string, unknown>): WorktreeSlotHistoryEntry {
  return {
    id: Number(row.id),
    slotId: String(row.slot_id),
    ordinal: Number(row.ordinal),
    at: Number(row.at),
    kind: String(row.kind),
    fromState: nullableString(row.from_state),
    toState: nullableString(row.to_state),
    reason: nullableString(row.reason),
    detail: nullableString(row.detail),
    operation: nullableString(row.operation),
    outcome: nullableString(row.outcome),
    actor: nullableString(row.actor),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    meta: parsedMeta(nullableString(row.meta)),
  };
}

function timingView(row: Record<string, unknown> | undefined): WorktreeTimingView | null {
  if (!row) return null;
  const meta = parsedMeta(nullableString(row.meta));
  const source = meta?.sourceOrdinal;
  return {
    at: Number(row.at),
    outcome: nullableString(row.outcome),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    reason: nullableString(row.reason),
    sourceOrdinal: typeof source === "number" ? source : null,
    sourceQuarantined: meta?.sourceQuarantined === true,
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Who a lease's own step belongs to, unless the caller knows better: `warm` is maintenance. */
function leaseActor(ownerKind: string | null): WorktreeHistoryActor {
  return ownerKind === "warm" ? "automatic" : "owner";
}

/** "<kind>:<key>", as a history reason names a lease's owner. */
function ownerName(kind: string | null, key: string | null): string {
  return kind === null ? "no owner" : `${kind}:${key ?? "unknown"}`;
}

/**
 * The slot states a claim's writes may land in: a reservation still provisioning inside its
 * acquire, or a slot a Warm holds under its `warm` lease.
 */
export type WorktreeClaimSlotState = "provisioning" | "leased";

/** The only reader/writer for native operational pool and slot rows. */
export class WorktreeStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Run `write` in a transaction of its own, or in the one already open on this connection. */
  private transact<T>(write: () => T): T {
    const owns = !this.db.isTransaction;
    if (owns) this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = write();
      if (owns) this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      if (owns && this.db.isTransaction) {
        try {
          this.db.exec("ROLLBACK;");
        } catch {}
      }
      throw error;
    }
  }

  private record(slot: Pick<WorktreeSlotRow, "id" | "poolId" | "ordinal">, entry: WorktreeHistoryInput): void {
    const text = (value: string | null | undefined) =>
      value === null || value === undefined ? null : clipUtf8Bytes(value, WORKTREE_HISTORY_LIMITS.textBytes);
    this.db
      .prepare(
        `INSERT INTO worktree_slot_history
           (pool_id, slot_id, ordinal, at, kind, from_state, to_state, reason, detail, outcome, actor, duration_ms, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        slot.poolId,
        slot.id,
        slot.ordinal,
        entry.at,
        entry.kind,
        entry.fromState,
        entry.toState,
        text(entry.reason),
        text(entry.detail),
        entry.outcome ?? null,
        entry.actor,
        entry.durationMs ?? null,
        boundedMeta(entry.meta),
      );
  }

  /**
   * One provisioning, claim or seed row. These report on a step that already happened and change
   * no slot row, so unlike a transition's they stand alone, and the caller decides what a row
   * that cannot be written costs.
   */
  recordTiming(slot: Pick<WorktreeSlotRow, "id" | "poolId" | "ordinal">, entry: WorktreeTimingEntry): void {
    this.record(slot, { ...entry, fromState: null, toState: null });
  }

  /**
   * One slot transition: `write` changes the row, and its one history row commits with it. A
   * compare-and-swap that misses writes no row, and a row that cannot be written rolls the
   * transition back, so history cannot drift from the slot. Every write that raises `version`
   * comes through here, or through `reserveNew` and `removePruned`, which record the same way.
   */
  private transition(
    slotId: string,
    now: number,
    write: () => { changes: number | bigint },
    entry: (before: WorktreeSlotRow) => WorktreeTransitionEntry,
  ): WorktreeSlotRow | null {
    return this.transact(() => {
      const before = this.slot(slotId);
      if (!before || Number(write().changes) !== 1) return null;
      const after = this.slot(slotId)!;
      this.record(after, {
        ...entry(before),
        at: now,
        kind: "transition",
        fromState: before.state,
        toState: after.state,
        meta: { version: after.version, head: after.currentHeadSha },
      });
      return after;
    });
  }

  /**
   * A write of `last_error` that is not a transition. It leaves one history row only when the
   * failed-read note appears or goes, so a pass that fails the same way again stays silent. A
   * transition that drops the note needs no row of its own: its one row is the record.
   */
  private observed(
    slotId: string,
    lastError: string | null,
    now: number,
    write: () => { changes: number | bigint },
  ): boolean {
    return this.transact(() => {
      const before = this.slot(slotId);
      if (Number(write().changes) !== 1) return false;
      const prior = splitObservationFailure(before?.lastError ?? null).failure;
      const next = splitObservationFailure(lastError).failure;
      if (before && (prior === null) !== (next === null)) {
        this.record(before, {
          at: now,
          kind: "observation",
          fromState: before.state,
          toState: before.state,
          reason: next === null ? "a read succeeded again" : "a read failed, and the slot kept its state",
          detail: next ?? prior,
          outcome: next === null ? "cleared" : "started",
          actor: "automatic",
        });
      }
      return true;
    });
  }

  /** One page of a slot's history, newest first. A destroyed slot's rows still answer. */
  slotHistory(slotId: string, before: number | null = null): WorktreeSlotHistoryPage {
    const size = WORKTREE_HISTORY_LIMITS.pageEntries;
    const rows = (before === null
      ? this.db
          .prepare(`SELECT * FROM worktree_slot_history WHERE slot_id = ? ORDER BY id DESC LIMIT ?`)
          .all(slotId, size + 1)
      : this.db
          .prepare(`SELECT * FROM worktree_slot_history WHERE slot_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
          .all(slotId, before, size + 1)) as unknown as Record<string, unknown>[];
    const entries = rows.slice(0, size).map(historyEntry);
    return { entries, nextBefore: rows.length > size ? entries[size - 1]!.id : null };
  }

  /** The id of a slot's newest history row of any kind, or null when it has none. */
  lastHistoryId(slotId: string): number | null {
    const row = this.db.prepare(`SELECT MAX(id) AS id FROM worktree_slot_history WHERE slot_id = ?`).get(slotId) as
      { id: number | null };
    return row.id;
  }

  /** The newest provisioning, claim and seed rows of a slot, for its card. */
  slotTimings(slotId: string): WorktreeSlotTimingsView {
    const last = (kind: "provisioning" | "claim" | "seed") =>
      timingView(this.db
        .prepare(`SELECT * FROM worktree_slot_history WHERE slot_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`)
        .get(slotId, kind) as Record<string, unknown> | undefined);
    return { provisioning: last("provisioning"), claim: last("claim"), seed: last("seed") };
  }

  /**
   * A pool's newest new slots, read from history alone. A new slot has one `new` provisioning row
   * and it is that slot's first, so any seed row before it belongs to the same provisioning.
   */
  poolTimings(poolId: string): WorktreePoolTimingsView {
    const rows = this.db
      .prepare(
        `SELECT p.duration_ms AS duration, EXISTS (
           SELECT 1 FROM worktree_slot_history s
           WHERE s.slot_id = p.slot_id AND s.kind = 'seed' AND s.outcome = 'placed' AND s.id < p.id
         ) AS seeded
         FROM worktree_slot_history p
         WHERE p.pool_id = ? AND p.kind = 'provisioning' AND p.outcome = 'new'
         ORDER BY p.id DESC LIMIT ?`,
      )
      .all(poolId, WORKTREE_HISTORY_LIMITS.timingWindowSlots) as Array<{ duration: number; seeded: number }>;
    return {
      newSlots: rows.length,
      medianProvisioningMs: median(rows.map((row) => Number(row.duration))),
      seededSlots: rows.filter((row) => row.seeded === 1).length,
    };
  }

  /**
   * History retention, once per maintenance pass: rows past their age, then whatever a pool
   * holds beyond its cap, oldest first. A destroyed slot's rows age out like any other.
   */
  pruneHistory(now: number): number {
    const { retentionDays, rowsPerPool } = WORKTREE_HISTORY_LIMITS;
    return this.transact(() => {
      let dropped = Number(
        this.db.prepare(`DELETE FROM worktree_slot_history WHERE at < ?`).run(now - retentionDays * DAY_MS).changes,
      );
      const pools = this.db.prepare(`SELECT DISTINCT pool_id FROM worktree_slot_history`).all() as Array<{ pool_id: string }>;
      for (const { pool_id: poolId } of pools) {
        const oldestKept = this.db
          .prepare(
            `SELECT at, id FROM worktree_slot_history WHERE pool_id = ?
             ORDER BY at DESC, id DESC LIMIT 1 OFFSET ?`,
          )
          .get(poolId, rowsPerPool - 1) as { at: number; id: number } | undefined;
        if (!oldestKept) continue;
        dropped += Number(
          this.db
            .prepare(
              `DELETE FROM worktree_slot_history
               WHERE pool_id = ? AND (at < ? OR (at = ? AND id < ?))`,
            )
            .run(poolId, oldestKept.at, oldestKept.at, oldestKept.id).changes,
        );
      }
      return dropped;
    });
  }

  pools(): WorktreePoolRow[] {
    return (this.db.prepare(`SELECT * FROM worktree_pools ORDER BY created_at, id`).all() as unknown as Record<string, unknown>[])
      .map(poolRow);
  }

  poolCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM worktree_pools`).get() as { n: number };
    return Number(row.n);
  }

  pool(id: string): WorktreePoolRow | null {
    const row = this.db.prepare(`SELECT * FROM worktree_pools WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? poolRow(row) : null;
  }

  poolByCommonDirectory(commonDirectory: string): WorktreePoolRow | null {
    const row = this.db.prepare(`SELECT * FROM worktree_pools WHERE git_common_dir = ?`).get(
      commonDirectory,
    ) as Record<string, unknown> | undefined;
    return row ? poolRow(row) : null;
  }

  ensurePool(input: {
    id: string;
    gitCommonDirectory: string;
    mainCheckoutRoot: string;
    poolPath: string;
    now: number;
  }): WorktreePoolRow {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO worktree_pools
           (id, git_common_dir, main_checkout_root, pool_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.gitCommonDirectory,
        input.mainCheckoutRoot,
        input.poolPath,
        input.now,
        input.now,
      );
    const existing = this.poolByCommonDirectory(input.gitCommonDirectory);
    if (!existing || existing.poolPath !== input.poolPath) {
      throw new Error("native pool identity conflicts with an existing common directory or pool path");
    }
    if (existing.mainCheckoutRoot !== input.mainCheckoutRoot) {
      this.db
        .prepare(`UPDATE worktree_pools SET main_checkout_root = ?, updated_at = ? WHERE id = ?`)
        .run(input.mainCheckoutRoot, input.now, existing.id);
      return this.pool(existing.id)!;
    }
    return existing;
  }

  slots(poolId?: string): WorktreeSlotRow[] {
    const rows = poolId
      ? this.db.prepare(`SELECT * FROM worktree_slots WHERE pool_id = ? ORDER BY ordinal`).all(poolId)
      : this.db.prepare(`SELECT * FROM worktree_slots ORDER BY pool_id, ordinal`).all();
    return (rows as unknown as Record<string, unknown>[]).map(slotRow);
  }

  slot(id: string): WorktreeSlotRow | null {
    const row = this.db.prepare(`SELECT * FROM worktree_slots WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? slotRow(row) : null;
  }

  slotByPath(path: string): WorktreeSlotRow | null {
    const row = this.db.prepare(`SELECT * FROM worktree_slots WHERE path = ?`).get(path) as
      | Record<string, unknown>
      | undefined;
    return row ? slotRow(row) : null;
  }

  slotByLeaseId(leaseId: string): WorktreeSlotRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM worktree_slots
          WHERE active_lease_id = ? OR last_released_lease_id = ?
          LIMIT 1`,
      )
      .get(leaseId, leaseId) as Record<string, unknown> | undefined;
    return row ? slotRow(row) : null;
  }

  poolForSlot(slotId: string): WorktreePoolRow | null {
    const row = this.db
      .prepare(
        `SELECT p.* FROM worktree_pools p
         JOIN worktree_slots s ON s.pool_id = p.id WHERE s.id = ?`,
      )
      .get(slotId) as Record<string, unknown> | undefined;
    return row ? poolRow(row) : null;
  }

  reserveNew(input: {
    poolId: string;
    maxSlots: number;
    id: string;
    pathForOrdinal: (ordinal: number) => string;
    leaseId: string;
    ownerKind: string;
    ownerKey: string;
    requestedHeadSha: string;
    now: number;
  }): WorktreeSlotRow | null {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const count = this.db
        .prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(ordinal), 0) AS max_ordinal FROM worktree_slots WHERE pool_id = ?`)
        .get(input.poolId) as { n: number; max_ordinal: number };
      if (Number(count.n) >= input.maxSlots) {
        this.db.exec("COMMIT;");
        return null;
      }
      const pool = this.db
        .prepare(`SELECT ordinal_high_water FROM worktree_pools WHERE id = ?`)
        .get(input.poolId) as { ordinal_high_water: number } | undefined;
      const highWater = Number(pool?.ordinal_high_water);
      const maxOrdinal = Number(count.max_ordinal);
      if (
        !pool ||
        !Number.isSafeInteger(highWater) ||
        highWater < 0 ||
        !Number.isSafeInteger(maxOrdinal) ||
        maxOrdinal < 0
      ) {
        throw new Error("native pool ordinal high-water mark is invalid");
      }
      const ordinal = Math.max(highWater, maxOrdinal) + 1;
      if (!Number.isSafeInteger(ordinal)) {
        throw new Error("native pool ordinal space is exhausted");
      }
      const advanced = this.db
        .prepare(
          `UPDATE worktree_pools SET ordinal_high_water = ?, updated_at = ?
           WHERE id = ? AND ordinal_high_water = ?`,
        )
        .run(ordinal, input.now, input.poolId, highWater);
      if (Number(advanced.changes) !== 1) {
        throw new Error("native pool ordinal high-water mark could not be advanced");
      }
      this.db
        .prepare(
          `INSERT INTO worktree_slots
             (id, pool_id, ordinal, path, state, version, requested_head_sha,
              active_lease_id, active_owner_kind, active_owner_key, leased_at,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, 'provisioning', 1, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.poolId,
          ordinal,
          input.pathForOrdinal(ordinal),
          input.requestedHeadSha,
          input.leaseId,
          input.ownerKind,
          input.ownerKey,
          input.now,
          input.now,
          input.now,
        );
      const reserved = this.slot(input.id)!;
      this.record(reserved, {
        at: input.now,
        kind: "transition",
        fromState: null,
        toState: reserved.state,
        reason: `new slot reserved for ${ownerName(input.ownerKind, input.ownerKey)}`,
        actor: leaseActor(input.ownerKind),
        meta: { version: reserved.version, head: null },
      });
      this.db.exec("COMMIT;");
      return reserved;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw error;
    }
  }

  reserveAvailable(input: {
    slotId: string;
    version: number;
    leaseId: string;
    ownerKind: string;
    ownerKey: string;
    requestedHeadSha: string;
    now: number;
    /** Who caused this, when it is not the lease's owner: an operator's Warm. */
    actor?: WorktreeHistoryActor;
  }): WorktreeSlotRow | null {
    return this.transition(
      input.slotId,
      input.now,
      () => this.db
        .prepare(
          `UPDATE worktree_slots SET
             state = 'provisioning', version = version + 1, requested_head_sha = ?,
             active_lease_id = ?, active_owner_kind = ?, active_owner_key = ?, leased_at = ?,
             quarantine_reason = NULL, last_error = NULL, updated_at = ?
           WHERE id = ? AND state = 'available' AND version = ?`,
        )
        .run(
          input.requestedHeadSha,
          input.leaseId,
          input.ownerKind,
          input.ownerKey,
          input.now,
          input.now,
          input.slotId,
          input.version,
        ),
      () => ({
        reason: `reserved for ${ownerName(input.ownerKind, input.ownerKey)}`,
        actor: input.actor ?? leaseActor(input.ownerKind),
      }),
    );
  }

  /**
   * Undo a reservation that was refused before anything in the slot changed: the slot is
   * available again, exactly as `reserveAvailable` found it, with `lastError` recorded.
   */
  releaseReservation(input: {
    slotId: string;
    version: number;
    leaseId: string;
    requestedHeadSha: string | null;
    lastError: string | null;
    now: number;
    /** Who caused this, when it is not the lease's owner: an operator's Warm or Open terminal. */
    actor?: WorktreeHistoryActor;
  }): WorktreeSlotRow | null {
    return this.transition(
      input.slotId,
      input.now,
      () => this.db
        .prepare(
          `UPDATE worktree_slots SET
             state = 'available', version = version + 1, requested_head_sha = ?,
             active_lease_id = NULL, active_owner_kind = NULL, active_owner_key = NULL, leased_at = NULL,
             quarantine_reason = NULL, last_error = ?, updated_at = ?
           WHERE id = ? AND state = 'provisioning' AND version = ? AND active_lease_id = ?`,
        )
        .run(input.requestedHeadSha, input.lastError, input.now, input.slotId, input.version, input.leaseId),
      (before) => ({
        reason: "reservation handed back before anything in the slot changed",
        // A read that refused the reservation starts its failed-read note here, on this one row.
        detail: splitObservationFailure(input.lastError).failure,
        actor: input.actor ?? leaseActor(before.activeOwnerKind),
      }),
    );
  }

  finalizeLease(
    slotId: string,
    version: number,
    currentHeadSha: string,
    now: number,
    actor?: WorktreeHistoryActor,
  ): WorktreeSlotRow | null {
    return this.transition(
      slotId,
      now,
      () => this.db
        .prepare(
          `UPDATE worktree_slots SET
             state = 'leased', version = version + 1, current_head_sha = ?, last_used_at = ?,
             last_released_lease_id = NULL, last_released_owner_kind = NULL,
             last_released_owner_key = NULL, quarantine_reason = NULL, last_error = NULL,
             updated_at = ?
           WHERE id = ? AND state = 'provisioning' AND version = ?`,
        )
        .run(currentHeadSha, now, now, slotId, version),
      (before) => ({
        reason: `lease granted to ${ownerName(before.activeOwnerKind, before.activeOwnerKey)}`,
        actor: actor ?? leaseActor(before.activeOwnerKind),
      }),
    );
  }

  markReturning(
    slotId: string,
    version: number,
    targetSha: string,
    now: number,
    actor?: WorktreeHistoryActor,
  ): WorktreeSlotRow | null {
    return this.transition(
      slotId,
      now,
      () => this.db
        .prepare(
          `UPDATE worktree_slots SET
             state = 'returning', version = version + 1, requested_head_sha = ?,
             last_error = NULL, updated_at = ?
           WHERE id = ? AND state IN ('leased', 'quarantined') AND version = ?`,
        )
        .run(targetSha, now, slotId, version),
      (before) => ({
        reason: `return started from ${ownerName(before.activeOwnerKind, before.activeOwnerKey)}`,
        actor: actor ?? leaseActor(before.activeOwnerKind),
      }),
    );
  }

  completeRelease(
    slotId: string,
    version: number,
    currentHeadSha: string,
    now: number,
    actor?: WorktreeHistoryActor,
  ): WorktreeSlotRow | null {
    return this.transition(
      slotId,
      now,
      () => this.db
        .prepare(
          `UPDATE worktree_slots SET
             state = 'available', version = version + 1, current_head_sha = ?,
             last_released_lease_id = active_lease_id,
             last_released_owner_kind = active_owner_kind,
             last_released_owner_key = active_owner_key,
             active_lease_id = NULL, active_owner_kind = NULL, active_owner_key = NULL,
             leased_at = NULL, last_used_at = ?, quarantine_reason = NULL, last_error = NULL,
             updated_at = ?
           WHERE id = ? AND state = 'returning' AND version = ?`,
        )
        .run(currentHeadSha, now, now, slotId, version),
      (before) => ({
        reason: "returned to the pool",
        actor: actor ?? leaseActor(before.activeOwnerKind),
      }),
    );
  }

  /** Removal starts only from an operator's Destroy or prune. */
  markPruning(slotId: string, version: number, now: number): WorktreeSlotRow | null {
    return this.transition(
      slotId,
      now,
      () => this.db
        .prepare(
          `UPDATE worktree_slots SET state = 'pruning', version = version + 1,
             last_error = NULL, updated_at = ?
           WHERE id = ? AND state IN ('available', 'quarantined') AND version = ?
             AND active_lease_id IS NULL AND active_owner_kind IS NULL AND active_owner_key IS NULL`,
        )
        .run(now, slotId, version),
      () => ({ reason: "removal started", actor: "operator" }),
    );
  }

  /**
   * `withdrawGrant` is for a reservation quarantined before its lease was ever handed to the
   * owner: the owner cannot hold or release an identity it never received, so the slot keeps
   * its quarantine but drops the active identity in the same compare-and-swap.
   */
  quarantine(
    slotId: string,
    reason: string,
    error: string | null,
    now: number,
    expectedVersion?: number,
    withdrawGrant = false,
  ): WorktreeSlotRow | null {
    const where = expectedVersion === undefined ? "id = ?" : "id = ? AND version = ?";
    const args = expectedVersion === undefined
      ? [now, reason, error, now, slotId]
      : [now, reason, error, now, slotId, expectedVersion];
    const withdraw = withdrawGrant
      ? "active_lease_id = NULL, active_owner_kind = NULL, active_owner_key = NULL, leased_at = NULL,"
      : "";
    return this.transition(
      slotId,
      now,
      () => this.db
        .prepare(
          // A slot already quarantined keeps its entry time: the same occurrence continues.
          `UPDATE worktree_slots SET
             quarantined_at = CASE WHEN state = 'quarantined' AND quarantined_at IS NOT NULL
               THEN quarantined_at ELSE ? END,
             state = 'quarantined', version = version + 1, ${withdraw}
             quarantine_reason = ?, last_error = ?, updated_at = ? WHERE ${where}`,
        )
        .run(...args),
      () => ({ reason, detail: error, actor: "automatic" }),
    );
  }

  /**
   * Drop an exact active identity from a quarantined slot whose owner has been proven not to
   * reference it. The slot stays quarantined; only the stale owner is withdrawn.
   */
  withdrawQuarantinedLease(slotId: string, version: number, leaseId: string, now: number): WorktreeSlotRow | null {
    return this.transition(
      slotId,
      now,
      () => this.db
        .prepare(
          `UPDATE worktree_slots SET version = version + 1,
             active_lease_id = NULL, active_owner_kind = NULL, active_owner_key = NULL,
             leased_at = NULL, updated_at = ?
           WHERE id = ? AND state = 'quarantined' AND version = ? AND active_lease_id = ?`,
        )
        .run(now, slotId, version, leaseId),
      (before) => ({
        reason: `lease of ${ownerName(before.activeOwnerKind, before.activeOwnerKey)} withdrawn: its owner does not reference it`,
        actor: "automatic",
      }),
    );
  }

  /**
   * Put a slot quarantined only by a failed read back under the lease it never lost. Nothing
   * else about the lease changes, and nothing on disk does: its owner holds the same identity.
   */
  restoreLease(slotId: string, version: number, leaseId: string, now: number): WorktreeSlotRow | null {
    return this.transition(
      slotId,
      now,
      () => this.db
        .prepare(
          `UPDATE worktree_slots SET state = 'leased', version = version + 1,
             quarantine_reason = NULL, quarantined_at = NULL, last_error = NULL, updated_at = ?
           WHERE id = ? AND state = 'quarantined' AND version = ? AND active_lease_id = ?`,
        )
        .run(now, slotId, version, leaseId),
      (before) => ({
        reason: `lease restored after a quarantine for: ${before.quarantineReason ?? "no recorded reason"}`,
        actor: "automatic",
      }),
    );
  }

  /**
   * The claim's write-ahead: ONE durable write that records the intent and clears the
   * fingerprint, before any step touches the tree. Only a reservation still provisioning at
   * the exact version its claim holds can take it. The version is deliberately left alone:
   * dependency state is not a slot transition, and the lease commit's compare-and-swap still
   * names the reservation it was granted.
   */
  beginClaim(slotId: string, version: number, now: number, slotState: WorktreeClaimSlotState = "provisioning"): boolean {
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET deps_state = 'claiming', deps_fingerprint = NULL,
           deps_fingerprint_sha = NULL, updated_at = ?
         WHERE id = ? AND state = ? AND version = ?`,
      )
      .run(now, slotId, slotState, version);
    return Number(changed.changes) === 1;
  }

  /**
   * The seed's write-ahead, before anything is renamed into the tree. The same shape as
   * `beginClaim`: one write that records the intent and clears the fingerprint.
   */
  beginSeed(slotId: string, version: number, now: number, slotState: WorktreeClaimSlotState = "provisioning"): boolean {
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET deps_state = 'seeding', deps_fingerprint = NULL,
           deps_fingerprint_sha = NULL, updated_at = ?
         WHERE id = ? AND state = ? AND version = ?`,
      )
      .run(now, slotId, slotState, version);
    return Number(changed.changes) === 1;
  }

  /**
   * Settle a seed that held the write-ahead. `current` is a seed whose source's fingerprint is
   * this commit's, so the steps are skipped and the inherited fingerprint is trusted.
   * `interrupted` is a seed that was stopped, timed out, or could not be placed whole: its
   * paths may be half renamed, so the next claim removes them and starts cold.
   */
  finishSeed(
    slotId: string,
    version: number,
    outcome:
      | { state: "current"; fingerprint: string; sha: string }
      | { state: "interrupted"; error: string | null },
    now: number,
    slotState: WorktreeClaimSlotState = "provisioning",
  ): boolean {
    const current = outcome.state === "current";
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET deps_state = ?, deps_fingerprint = ?, deps_fingerprint_sha = ?,
           deps_claimed_at = ?, deps_last_error = ?, updated_at = ?
         WHERE id = ? AND state = ? AND version = ? AND deps_state = 'seeding'`,
      )
      .run(
        outcome.state,
        current ? outcome.fingerprint : null,
        current ? outcome.sha : null,
        now,
        current ? null : outcome.error,
        now,
        slotId,
        slotState,
        version,
      );
    return Number(changed.changes) === 1;
  }

  /**
   * Settle a claim that held the write-ahead. A failure records no fingerprint. `interrupted`
   * is a claim whose cleanup of an interrupted seed did not finish: the obligation to remove
   * the seed paths stays with the slot, so its next claim tries again.
   */
  finishClaim(
    slotId: string,
    version: number,
    outcome:
      | { state: "current"; fingerprint: string | null; sha: string }
      | { state: "failed" | "interrupted"; error: string },
    now: number,
    slotState: WorktreeClaimSlotState = "provisioning",
  ): boolean {
    const current = outcome.state === "current";
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET deps_state = ?, deps_fingerprint = ?, deps_fingerprint_sha = ?,
           deps_claimed_at = ?, deps_last_error = ?, updated_at = ?
         WHERE id = ? AND state = ? AND version = ? AND deps_state = 'claiming'`,
      )
      .run(
        outcome.state,
        current ? outcome.fingerprint : null,
        current ? outcome.sha : null,
        now,
        current ? null : outcome.error,
        now,
        slotId,
        slotState,
        version,
      );
    return Number(changed.changes) === 1;
  }

  /**
   * Startup found a claim's or a seed's write-ahead with no live claim behind it. The
   * fingerprint was already cleared by the write-ahead; clearing it again here keeps that true
   * for a row an older build might have touched.
   */
  markClaimInterrupted(slotId: string, now: number): boolean {
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET deps_state = 'interrupted', deps_fingerprint = NULL,
           deps_fingerprint_sha = NULL, updated_at = ?
         WHERE id = ? AND deps_state IN (${WORKTREE_DEPS_WRITE_AHEAD_STATES.map(() => "?").join(", ")})`,
      )
      .run(now, slotId, ...WORKTREE_DEPS_WRITE_AHEAD_STATES);
    return Number(changed.changes) === 1;
  }

  /**
   * Record the log of the Warm holding this slot now, as the slot's most recent. Not a slot
   * transition, so the version is left alone. Only the Warm's own lease can write it.
   */
  setDepsLogPath(slotId: string, leaseId: string, path: string, now: number): boolean {
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET deps_log_path = ?, updated_at = ?
         WHERE id = ? AND state = 'leased' AND active_lease_id = ? AND active_owner_kind = 'warm'`,
      )
      .run(path, now, slotId, leaseId);
    return Number(changed.changes) === 1;
  }

  /** Every Warm log a slot row still names. */
  depsLogPaths(): Set<string> {
    const rows = this.db
      .prepare(`SELECT deps_log_path FROM worktree_slots WHERE deps_log_path IS NOT NULL`)
      .all() as Array<{ deps_log_path: string }>;
    return new Set(rows.map((row) => String(row.deps_log_path)));
  }

  updateObserved(slotId: string, currentHeadSha: string | null, error: string | null, now: number): void {
    this.observed(slotId, error, now, () => this.db
      .prepare(`UPDATE worktree_slots SET current_head_sha = ?, last_error = ?, updated_at = ? WHERE id = ?`)
      .run(currentHeadSha, error, now, slotId));
  }

  /**
   * Record what the last observation of a slot found, and nothing else. The version is
   * compared and left alone: an observation is not a transition, so it never invalidates an
   * operation that judged this version, and it never lands on a slot that changed since.
   */
  noteLastError(slotId: string, version: number, error: string | null, now: number): boolean {
    return this.observed(slotId, error, now, () => this.db
      .prepare(`UPDATE worktree_slots SET last_error = ?, updated_at = ? WHERE id = ? AND version = ?`)
      .run(error, now, slotId, version));
  }

  /** The slot's row goes and its history stays, so this row's `toState` is NULL. */
  removePruned(
    slotId: string,
    version: number,
    now: number = Date.now(),
    actor: WorktreeHistoryActor = "automatic",
  ): boolean {
    return this.transact(() => {
      const before = this.slot(slotId);
      const changed = this.db
        .prepare(`DELETE FROM worktree_slots WHERE id = ? AND state = 'pruning' AND version = ?`)
        .run(slotId, version);
      if (!before || Number(changed.changes) !== 1) return false;
      this.record(before, {
        at: now,
        kind: "transition",
        fromState: before.state,
        toState: null,
        reason: "slot removed",
        actor,
        meta: { version: before.version, head: before.currentHeadSha },
      });
      return true;
    });
  }

  recordReconciliation(poolId: string, now: number, error: string | null): void {
    this.db
      .prepare(
        `UPDATE worktree_pools SET last_reconciled_at = ?, reconciliation_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, error, now, poolId);
  }
}
