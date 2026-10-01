import type { Task } from "@shared/types.ts";

/**
 * What a shape task's tickets marker says, read once for every surface that draws it: the
 * board card, the board drawer (console detail) and the Sitrep's Recent outcomes row.
 *
 * The server derives `shapeTickets` and nulls it for every other kind; the kind is checked
 * here as well so a non-shape task can never grow a marker from a stale or hand-built row.
 * Only four states are drawn. `awaiting-review` and `stop` are the absence of a pending
 * choice, and say nothing a person needs to act on.
 */
export interface ShapeTicketsMarkerView {
  state: "pending" | "queued" | "started" | "lapsed";
  label: string;
  tooltip: string;
  /** The follow-up the marker opens, or null for a marker that is only a note. */
  followupTaskId: string | null;
}

export function shapeTicketsMarker(
  task: Pick<Task, "kind" | "shapeTickets"> | null | undefined,
): ShapeTicketsMarkerView | null {
  if (task?.kind !== "shape" || !task.shapeTickets) return null;
  const { state, followupTaskId } = task.shapeTickets;
  switch (state) {
    case "pending":
      return {
        state,
        label: "Tickets after merge",
        tooltip: "When this plan's pull request merges, a linked task slices the merged plan into tickets",
        followupTaskId: null,
      };
    case "lapsed":
      return {
        state,
        label: "Tickets lapsed",
        tooltip: "Create tickets lapsed: this task ended without its plan merging, so no tickets task was created",
        followupTaskId: null,
      };
    // Both point at the follow-up. Without one (it was deleted) there is nothing to open, and
    // a bare "Tickets" would say nothing, so neither is drawn.
    case "queued":
      return followupTaskId
        ? {
            state,
            label: "Tickets queued",
            tooltip: "Open the tickets task, waiting in the backlog because its launch was refused",
            followupTaskId,
          }
        : null;
    case "started":
      return followupTaskId
        ? {
            state,
            label: "Tickets",
            tooltip: "Open the linked task that slices this merged plan into tickets",
            followupTaskId,
          }
        : null;
    default:
      return null;
  }
}
