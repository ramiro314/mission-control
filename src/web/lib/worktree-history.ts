import type { WorktreeSlotHistoryEntry, WorktreeSlotHistoryPage } from "@shared/protocol.ts";
import type { WorktreePoolTimingsView, WorktreeSlotTimingsView, WorktreeTimingView } from "@shared/worktrees.ts";
import { duration } from "./format.ts";

/**
 * What an open list holds once a refresh of its newest page lands. Rows are append-only, so a
 * page that reaches what is shown adds only what is newer, and the older rows and their cursor
 * stay: replacing them would lose the row at the cursor to a Show older still in flight, which
 * the refreshed page has pushed past its end and the older page starts below. A page that does
 * not reach what is shown has an unknown gap under it, so it starts the list again.
 */
export function refreshedSlotHistory(
  shown: WorktreeSlotHistoryPage | null,
  page: WorktreeSlotHistoryPage,
): WorktreeSlotHistoryPage {
  const newest = shown?.entries[0]?.id;
  const oldest = page.entries.at(-1)?.id;
  if (!shown || newest === undefined || oldest === undefined || oldest > newest) return page;
  return {
    entries: [...page.entries.filter((entry) => entry.id > newest), ...shown.entries],
    nextBefore: page.nextBefore === null ? null : shown.nextBefore,
  };
}

export type WorktreeTimedStep = keyof WorktreeSlotTimingsView;

const STEP_HEADLINES: Record<WorktreeTimedStep, string> = {
  provisioning: "Provisioned",
  claim: "Claim",
  seed: "Seed",
};

/**
 * How a timed step came out, which the slot card and a History row both say the same way. An
 * outcome a later build added reads as itself.
 */
export function timingSummary(
  step: WorktreeTimedStep,
  { outcome, durationMs, sourceOrdinal }: Pick<WorktreeTimingView, "outcome" | "durationMs" | "sourceOrdinal">,
): string {
  const took = (word: "in" | "after") => durationMs === null ? "" : ` ${word} ${duration(durationMs)}`;
  switch (`${step}:${outcome}`) {
    case "provisioning:new": return `new slot${took("in")}`;
    case "provisioning:reused": return `reused slot${took("in")}`;
    case "claim:succeeded": return `succeeded${took("in")}`;
    case "claim:failed": return `failed${took("after")}`;
    case "claim:skipped": return "skipped, dependencies already matched";
    case "claim:shutdown": return `stopped by a shutdown${took("after")}`;
    case "seed:placed": return `from slot ${sourceOrdinal ?? "unknown"}${took("in")}`;
    case "seed:none": return "none";
    case "seed:abandoned": return `abandoned${took("after")}`;
    case "seed:interrupted": return `cut off${took("after")}`;
    default: return outcome ?? "unknown";
  }
}

/** A timed History row's first line, or null for a row of any other kind. */
export function timingHeadline(entry: WorktreeSlotHistoryEntry): string | null {
  if (entry.kind !== "provisioning" && entry.kind !== "claim" && entry.kind !== "seed") return null;
  const source = entry.meta?.sourceOrdinal;
  const sourceOrdinal = typeof source === "number" ? source : null;
  return `${STEP_HEADLINES[entry.kind]}: ${timingSummary(entry.kind, { ...entry, sourceOrdinal })}`;
}

/** The pool row's line, or null while history holds no new slot to say anything about. */
export function poolTimingSummary({ newSlots, medianProvisioningMs, seededSlots }: WorktreePoolTimingsView): string | null {
  if (medianProvisioningMs === null) return null;
  const rate = Math.round((seededSlots / newSlots) * 100);
  return `Median new slot ${duration(medianProvisioningMs)} · seed hit rate ${rate}% (${seededSlots} of last ${newSlots} new ${newSlots === 1 ? "slot" : "slots"})`;
}
