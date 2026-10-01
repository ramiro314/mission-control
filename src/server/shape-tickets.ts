import type { ShapeTicketsOutcome } from "@shared/protocol.ts";
import { isActiveTask } from "@shared/task-status.ts";
import type { Task, TaskShapeTickets } from "@shared/types.ts";
import {
  getTask as getDurableTask,
  historicalTaskWorkEpisodeBindingsForTask,
  retroPrPostureForTask,
  shapeTicketFollowupForTask,
  shapeTicketFollowupsForSource,
  taskEdgeSelectionsTo,
  taskWorkEpisodeForTask,
  type RetroPrPosture,
  type ShapeTicketFollowupRelation,
} from "./db.ts";
import type { MissionMcpRequirement } from "./mission-mcp.ts";
import type { ShapeTicketsFollowupFacts } from "./plans/shape.ts";
import { COMPLETE_SHAPE_TICKETS_TOOL } from "./plans/tools.ts";

// What Mission Control knows about a shape task's tickets follow-ups, read from
// `shape_ticket_followups` and the Task rows it names. Database-only on purpose: the Registry
// derives the wire field from it on every publish, so it must not reach back into the
// TaskManager or the Registry itself.

/** Reads a task by id, from the live board first and SQLite second. */
export type TaskLookup = (id: string) => Task | undefined;

const durableLookup: TaskLookup = (id) => getDurableTask(id) ?? undefined;

/**
 * What a tickets follow-up's task outcome reads, per `complete_shape_tickets` outcome.
 *
 * Here rather than beside the completion, because the acceptance rule below reads it back:
 * a follow-up that ended `dismissed` filed nothing, so it does not block another.
 */
export const SHAPE_TICKETS_OUTCOME_TEXT: Record<ShapeTicketsOutcome, string> = {
  filed: "Tickets filed",
  dismissed: "Breakdown dismissed: no tickets filed",
};

export type ShapeTicketsAcceptance =
  | { ok: true; posture: Extract<RetroPrPosture, { kind: "merged" }> }
  | { ok: false; reason: string };

/**
 * Whether **Create tickets** may start a follow-up for this task now.
 *
 * The task must be a `shape` task that is done with a merged pull-request posture, the same
 * check the post-merge Retro makes (`retroPrPostureForTask`). None of its follow-ups may be
 * live (backlog, dispatching, running) or done with its tickets filed, and none that ENDED
 * otherwise - cancelled, failed, dismissed, or deleted - may have filed any ticket.
 *
 * "Filed" is read from the tickets themselves: a ticket a follow-up files carries a task edge
 * to the source, selected when it was filed, so any such edge selected at or after an ended
 * follow-up was created is that follow-up's (or a later one's) work. Tickets an old-style
 * shaping session filed in-session were selected before the merge, so before any follow-up
 * existed, and never block. A follow-up stopped after a failed `create_task` has usually filed
 * the tickets before it, and a fresh follow-up would file them again.
 */
export function shapeTicketsAcceptance(
  task: Task,
  lookup: TaskLookup = durableLookup,
  followups: readonly ShapeTicketFollowupRelation[] = shapeTicketFollowupsForSource(task.id),
): ShapeTicketsAcceptance {
  if (task.kind !== "shape") {
    return { ok: false, reason: "Create tickets applies only to a shape task." };
  }
  if (task.status !== "done") {
    return {
      ok: false,
      reason: `This shape task is ${task.status}. Create tickets needs it done through its plan's merged pull request.`,
    };
  }
  const posture = retroPrPostureForTask(task.id);
  if (posture?.kind !== "merged") {
    return {
      ok: false,
      reason: "This shape task has no merged pull request, so there is no merged plan to slice.",
    };
  }
  let selections: number[] | null = null;
  for (const followup of followups) {
    const existing = lookup(followup.followupTaskId);
    if (existing?.status === "done" && existing.outcome !== SHAPE_TICKETS_OUTCOME_TEXT.dismissed) {
      return { ok: false, reason: `Its tickets follow-up "${existing.title}" already filed its tickets.` };
    }
    if (existing && (existing.status === "backlog" || isActiveTask(existing.status))) {
      return { ok: false, reason: `Its tickets follow-up "${existing.title}" is already ${existing.status}.` };
    }
    // Ended without completing as filed. Read the tickets once, only when it comes to this.
    selections ??= taskEdgeSelectionsTo(task.id);
    const filed = selections.filter((selectedAt) => selectedAt >= followup.createdAt).length;
    if (filed > 0) {
      return {
        ok: false,
        reason: `An earlier tickets follow-up ${existing ? `("${existing.title}", ${existing.status}) ` : ""}`
          + `filed ${filed} ticket${filed === 1 ? "" : "s"} before it ended, and another would file them again. `
          + "File the rest by hand, or delete those tickets to slice the plan afresh.",
      };
    }
  }
  return { ok: true, posture };
}

/** The wire projection: `null` for every kind but shape. */
export function shapeTicketsSummary(task: Task, lookup: TaskLookup = durableLookup): TaskShapeTickets | null {
  if (task.kind !== "shape") return null;
  const followups = shapeTicketFollowupsForSource(task.id);
  return {
    // The newest follow-up that still exists. A relation outlives a deleted follow-up, and one
    // whose task was never created (its create threw after the reservation) names nothing.
    followupTaskId: followups.find((followup) => lookup(followup.followupTaskId))?.followupTaskId ?? null,
    canCreate: shapeTicketsAcceptance(task, lookup, followups).ok,
  };
}

/** The merged shape task a tickets follow-up slices, or null when this task is not one. */
export function shapeTicketsFollowupFacts(
  followupTaskId: string,
  lookup: TaskLookup = durableLookup,
): ShapeTicketsFollowupFacts | null {
  const relation = shapeTicketFollowupForTask(followupTaskId);
  if (!relation) return null;
  const binding = [
    taskWorkEpisodeForTask(relation.sourceTaskId),
    ...historicalTaskWorkEpisodeBindingsForTask(relation.sourceTaskId),
  ].find((candidate) => candidate?.episodeId === relation.sourceEpisodeId);
  return {
    sourceTaskId: relation.sourceTaskId,
    sourceTitle: lookup(relation.sourceTaskId)?.title ?? relation.sourceTaskId,
    prUrl: relation.sourcePrUrl,
    branch: binding?.branch ?? null,
  };
}

/**
 * A tickets follow-up's launch requirement: whatever its caller asked for, plus the completion
 * tool. Read from the relation at launch, so a follow-up dispatched later by hand or by the
 * autopilot is granted it too, and no other task ever is.
 */
export function withShapeTicketsCompletion(
  task: Pick<Task, "id" | "kind">,
  requested: MissionMcpRequirement | null,
): MissionMcpRequirement | null {
  if (task.kind !== "shape" || !shapeTicketFollowupForTask(task.id)) return requested;
  const tools = new Set(requested?.tools ?? []);
  tools.add(COMPLETE_SHAPE_TICKETS_TOOL);
  return { tools: [...tools] };
}

/**
 * What a tickets follow-up is asked, in the human's words. The procedure is its contract's
 * (`shapeTicketsFollowupAppendix`), which names the source, the merged PR and the branch.
 */
export function shapeTicketsFollowupIntent(source: Pick<Task, "id" | "title">, prUrl: string): string {
  return [
    `Create tickets for the merged plan of the shape task "${source.title}" (${source.id}).`,
    `Its plan merged in ${prUrl}. Slice that plan into tickets, get the breakdown approved, and`,
    "file the approved tickets as backlog tasks linked to that shape task.",
  ].join("\n");
}
