import { basename } from "node:path";
import { storageProblem, type StorageProblem } from "@shared/storage-health.ts";
import { lockCausedQuarantine } from "./index-lock.ts";
import type { WorktreeSlotRow } from "./store.ts";

/**
 * `quarantined-slot:<slot id>:<quarantined_at>` for every quarantined slot. The entry time is
 * the slot row's own durable column, so a restart keeps the id and a slot that leaves
 * quarantine and later re-enters it is a new occurrence. A row an older build quarantined has
 * its entry time stamped by the migration; `updatedAt` only covers a row written around both.
 */
export function quarantinedSlotProblems(slots: readonly WorktreeSlotRow[]): StorageProblem[] {
  return slots.filter((slot) => slot.state === "quarantined").map((slot) => {
    const cause = lockCausedQuarantine(slot.lastError)
      ? "a stale index.lock blocked its reset"
      : slot.quarantineReason ?? "it could not be proven idle";
    return storageProblem(
      "quarantined-slot",
      slot.id,
      slot.quarantinedAt ?? slot.updatedAt,
      `Slot ${slot.ordinal} of ${basename(slot.path)} is quarantined: ${cause}`,
      { target: "slot", slotId: slot.id },
    );
  });
}
