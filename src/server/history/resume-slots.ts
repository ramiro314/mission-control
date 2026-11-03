import type { HistoryResumeSlot } from "@shared/history.ts";
import { canonical } from "../worktrees/git.ts";
import {
  observedIdleRefusal,
  type NativeWorktreeLease,
  type WorktreeLeaseForResumeResult,
  type WorktreeManager,
  type WorktreeOwner,
} from "../worktrees/manager.ts";

/**
 * The worktree pool as a History Resume sees it: which slot a directory is, which slots of a
 * repository are idle, and the one manager operation that leases a slot for a Resume. The
 * routes build it over the daemon's `WorktreeManager`, so History never holds a second view of
 * slot state.
 */

/** One slot, as observed now. */
export interface HistoryResumeObservedSlot {
  slot: HistoryResumeSlot;
  /** The slot's path resolved through symlinks, which a resolved directory is compared with. */
  canonicalPath: string;
  /** Its pool's main checkout, resolved through symlinks: the repository the slot belongs to. */
  repository: string;
  /** Acquisition's own idle rule held: available, unowned, clean, and nothing running in it. */
  idle: boolean;
}

export interface HistoryResumeSlots {
  observe(): Promise<HistoryResumeObservedSlot[]>;
  lease(slotId: string, owner: WorktreeOwner, branch: string | null): Promise<WorktreeLeaseForResumeResult>;
  /** Return a lease a failed launch never used, resetting the slot as any Return does. */
  giveBack(lease: NativeWorktreeLease): Promise<boolean>;
  /**
   * Whether the slot is still held by a launch: by its recorded lease, or by its owner key when
   * no lease was recorded. False once the lease is Returned, destroyed or recovered.
   */
  holds(slotId: string, leaseKey: string | null, ownerKey: string): boolean;
}

export function historyResumeSlots(manager: WorktreeManager): HistoryResumeSlots {
  return {
    async observe() {
      const pools = await manager.status();
      return Promise.all(pools.flatMap((pool) => pool.slots.map(async (status) => ({
        slot: { slotId: status.slot.id, ordinal: status.slot.ordinal, path: status.slot.path, head: status.observedHead },
        canonicalPath: await canonical(status.slot.path),
        repository: await canonical(pool.pool.mainCheckoutRoot),
        idle: observedIdleRefusal(status) === null,
      }))));
    },
    lease: (slotId, owner, branch) => manager.leaseForResume(slotId, owner, branch),
    async giveBack(lease) {
      const released = await manager.release(lease, { ownerAuthorized: true, requireClean: true });
      return released.outcome === "released" || released.outcome === "alreadyReleased";
    },
    holds: (slotId, leaseKey, ownerKey) => manager.holds(slotId, leaseKey, { kind: "manual", key: ownerKey }),
  };
}

/** Whether a slot belongs to `repoRoot`, compared resolved through symlinks. */
export async function sameRepository(repository: string, repoRoot: string | null): Promise<boolean> {
  return repoRoot !== null && repository === await canonical(repoRoot);
}
