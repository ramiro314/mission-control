import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  storageProblem,
  WorktreeLeaseActivitySchema,
  type WorktreeLeaseActivity,
} from "@shared/storage-health.ts";
import { getAppConfig, setAppConfig } from "../db.ts";
import {
  defaultWorktreeActivityDeps,
  worktreeActivityFingerprint,
  type ActivityFingerprint,
} from "../git/worktree-activity.ts";
import { unref } from "../util/timers.ts";
import { getWorktreesConfig } from "./config.ts";
import type { WorktreeOwnerReference } from "./manager.ts";
import { nativeWorktreeOwnerReferenced } from "./owners.ts";
import type { StorageProblemObservation } from "../storage-health.ts";
import type { WorktreeSlotRow } from "./store.ts";

// The Git-visible activity clock for LIVE leases, and the `stale-lease` problems it implies.
//
// A slot whose owner is still live but whose checkout has not changed for `staleLeaseDays` is
// flagged, never reclaimed: nothing in this module removes, returns or resets anything. The
// clock is the same probe the finished-task retention sweep trusts (`worktree-activity.ts`),
// and it keeps that sweep's bias. A clock is seeded at the first successful probe of a lease,
// never backdated to `leased_at`, and a probe that cannot answer moves nothing.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How often every live lease is probed. Far shorter than the smallest threshold (one day), and
 * long enough that probing a fleet of busy checkouts stays background work. A lease is also
 * probed as soon as the pool changes, so a new one starts its clock at once.
 */
export const LEASE_ACTIVITY_OBSERVE_INTERVAL_MS = 60 * 60 * 1000;

/** A `warm` owner is a Warm or seed running inside the daemon, not a live lease. */
const LIVE_OWNER_KINDS = new Set(["task", "check", "manual"]);

function liveReference(slot: WorktreeSlotRow): WorktreeOwnerReference | null {
  if (slot.state !== "leased" || !slot.activeLeaseId || !slot.activeOwnerKey) return null;
  if (!slot.activeOwnerKind || !LIVE_OWNER_KINDS.has(slot.activeOwnerKind)) return null;
  return {
    slotId: slot.id,
    leaseId: slot.activeLeaseId,
    owner: { kind: slot.activeOwnerKind as "task" | "check" | "manual", key: slot.activeOwnerKey },
  };
}

export interface LeaseActivityDeps {
  slots: () => WorktreeSlotRow[];
  /** Whether the lease's domain owner still exists. Throwing means unknown. */
  ownerLive: (reference: WorktreeOwnerReference) => boolean;
  probe: (path: string) => Promise<ActivityFingerprint>;
  staleLeaseDays: () => number;
  now: () => number;
  read: () => WorktreeLeaseActivity;
  write: (record: WorktreeLeaseActivity) => void;
  intervalMs: number;
  /** Timer seam. Returns a canceller. */
  schedule: (fn: () => void, ms: number) => () => void;
}

function storedLeaseActivity(): WorktreeLeaseActivity {
  const parsed = WorktreeLeaseActivitySchema.safeParse(
    getAppConfig(APP_CONFIG_ENTRIES.worktreeLeaseActivity),
  );
  return parsed.success ? parsed.data : {};
}

export const defaultLeaseActivityDeps: Omit<LeaseActivityDeps, "slots"> = {
  ownerLive: (reference) => nativeWorktreeOwnerReferenced(reference),
  probe: (path) => worktreeActivityFingerprint(path, defaultWorktreeActivityDeps),
  staleLeaseDays: () => getWorktreesConfig().staleLeaseDays,
  now: Date.now,
  read: storedLeaseActivity,
  write: (record) => setAppConfig(APP_CONFIG_ENTRIES.worktreeLeaseActivity, record),
  intervalMs: LEASE_ACTIVITY_OBSERVE_INTERVAL_MS,
  schedule: (fn, ms) => {
    const timer = unref(setTimeout(fn, ms));
    return () => clearTimeout(timer);
  },
};

/** One stale live lease: its slot and when its checkout last changed. */
export interface StaleLease {
  slot: WorktreeSlotRow;
  leaseId: string;
  changedAt: number;
}

export class LeaseActivityObserver {
  private readonly deps: LeaseActivityDeps;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = true;
  private cancelTimer: (() => void) | null = null;
  private lastStale: string | null = null;

  constructor(
    deps: Partial<LeaseActivityDeps> & Pick<LeaseActivityDeps, "slots">,
    /**
     * Runs after every pass, whatever it found, so storage health recomputes on its cadence.
     * `staleChanged` says whether the set of stale slots, or any one's date, moved since the
     * last pass, which is when a slot card's chip needs redrawing.
     */
    private readonly afterPass: (staleChanged: boolean) => void = () => {},
  ) {
    this.deps = { ...defaultLeaseActivityDeps, ...deps };
  }

  /** Probe now, then on every interval until `stop()`. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      this.request();
      this.cancelTimer = this.deps.schedule(tick, this.deps.intervalMs);
    };
    tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    await this.running;
  }

  /**
   * Ask for a pass. At most one runs at a time; a request made while one runs gets exactly one
   * more after it, so a lease acquired mid-pass is still seen promptly.
   */
  request(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && !this.stopped);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /**
   * Probe every live lease once. A changed digest, or a lease seen for the first time, sets its
   * clock to now; an unchanged one keeps it. A lease whose owner is gone, or that no longer holds
   * its slot, loses its clock. One whose owner or probe cannot be read keeps the clock it had.
   */
  async pass(): Promise<void> {
    let staleChanged = false;
    try {
      const before = this.deps.read();
      const next: WorktreeLeaseActivity = {};
      for (const slot of this.deps.slots()) {
        const reference = liveReference(slot);
        if (!reference) continue;
        const prior = before[reference.leaseId];
        const clock = await this.observe(slot, reference, prior?.slotId === slot.id ? prior : undefined);
        if (clock) next[reference.leaseId] = clock;
      }
      if (JSON.stringify(before) !== JSON.stringify(next)) this.deps.write(next);
      const stale = JSON.stringify([...this.staleSinceBySlot()]);
      staleChanged = stale !== this.lastStale;
      this.lastStale = stale;
    } catch (error) {
      console.error("[worktrees] lease activity pass failed:", error);
    }
    try {
      this.afterPass(staleChanged);
    } catch (error) {
      console.error("[worktrees] after lease activity pass hook failed:", error);
    }
  }

  /** One live lease's clock after this pass, or undefined when it should have none. */
  private async observe(
    slot: WorktreeSlotRow,
    reference: WorktreeOwnerReference,
    kept: WorktreeLeaseActivity[string] | undefined,
  ): Promise<WorktreeLeaseActivity[string] | undefined> {
    let live: boolean;
    try {
      live = this.deps.ownerLive(reference);
    } catch {
      return kept;
    }
    if (!live) return undefined;
    let fingerprint: ActivityFingerprint;
    try {
      fingerprint = await this.deps.probe(slot.path);
    } catch (error) {
      fingerprint = { kind: "unknown", reason: String(error) };
    }
    if (fingerprint.kind === "unknown") return kept;
    if (kept?.digest === fingerprint.digest) return kept;
    return { slotId: slot.id, digest: fingerprint.digest, changedAt: this.deps.now() };
  }

  /**
   * Every lease that is live right now and whose clock is at least `staleLeaseDays` old. Read
   * from the slot rows and the stored clocks only, so it is synchronous and runs no Git.
   */
  staleLeases(): StaleLease[] {
    const thresholdMs = this.deps.staleLeaseDays() * DAY_MS;
    const now = this.deps.now();
    const record = this.deps.read();
    const stale: StaleLease[] = [];
    for (const slot of this.deps.slots()) {
      const reference = liveReference(slot);
      const entry = reference ? record[reference.leaseId] : undefined;
      if (!reference || !entry || entry.slotId !== slot.id) continue;
      if (now - entry.changedAt < thresholdMs) continue;
      let live: boolean;
      try {
        live = this.deps.ownerLive(reference);
      } catch {
        live = false;
      }
      if (live) stale.push({ slot, leaseId: reference.leaseId, changedAt: entry.changedAt });
    }
    return stale;
  }

  /** For each slot holding a stale live lease, when that lease last changed. */
  staleSinceBySlot(): Map<string, number> {
    return new Map(this.staleLeases().map((lease) => [lease.slot.id, lease.changedAt]));
  }

  /** The storage-health source: one Storage-only `stale-lease` problem per stale live lease. */
  problems(): StorageProblemObservation {
    return {
      problems: this.staleLeases().map((lease) => storageProblem(
        "stale-lease",
        lease.slot.id,
        lease.leaseId,
        `${lease.slot.path} is still leased but has had no Git-visible change since ${
          new Date(lease.changedAt).toISOString().slice(0, 10)
        }`,
        { target: "slot", slotId: lease.slot.id },
      )),
    };
  }
}
