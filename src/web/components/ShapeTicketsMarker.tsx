import type { Task } from "@shared/types.ts";
import { shapeTicketsMarker } from "../lib/shape-tickets.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * A shape task's tickets marker: what will happen to its tickets, or what happened.
 *
 * One component for the board card (`variant="tile"`, in the card's flag vocabulary) and for
 * the drawer and Sitrep row (`variant="chip"`), so the surfaces cannot disagree on a state's
 * words. A pending or lapsed choice is a note. A queued or started one opens its follow-up
 * through `onOpenTask`, which is the app's one way to open a task; it is a button with the
 * link role, because a task has no address of its own to put in an `href`.
 */
export function ShapeTicketsMarker({
  task,
  onOpenTask,
  variant,
}: {
  task: Pick<Task, "kind" | "shapeTickets"> | null | undefined;
  onOpenTask?: (taskId: string) => void;
  variant: "tile" | "chip";
}): React.JSX.Element | null {
  const marker = shapeTicketsMarker(task);
  if (!marker) return null;
  const className = `${variant === "tile" ? "tile-flag tf-shape-tickets" : "shape-tickets-chip"} shape-tickets-${marker.state}`;
  const followupTaskId = marker.followupTaskId;
  if (followupTaskId && onOpenTask) {
    return (
      <Tooltip label={marker.tooltip}>
        <button
          type="button"
          role="link"
          className={`${className} shape-tickets-open`}
          onClick={(event) => {
            // The board card opens its own session on a click; this one opens the follow-up.
            event.stopPropagation();
            onOpenTask(followupTaskId);
          }}
        >
          {marker.label}
        </button>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={marker.tooltip}>
      <span className={className} role="note" aria-label={marker.label}>
        {marker.label}
      </span>
    </Tooltip>
  );
}
