import { isActiveTask } from "@shared/task-status.ts";
import type { Task, TaskShapeTickets } from "@shared/types.ts";
import {
  getTask as getDurableTask,
  historicalTaskWorkEpisodeBindingsForTask,
  retroPrPostureForTask,
  shapeTicketFollowupForTask,
  shapeTicketFollowupsForSource,
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

export type ShapeTicketsAcceptance =
  | { ok: true; posture: Extract<RetroPrPosture, { kind: "merged" }> }
  | { ok: false; reason: string };

/**
 * Whether **Create tickets** may start a follow-up for this task now.
 *
 * The task must be a `shape` task that is done with a merged pull-request posture, the same
 * check the post-merge Retro makes (`retroPrPostureForTask`), and none of its follow-ups may
 * be live (backlog, dispatching, running) or done. A cancelled or failed follow-up does not
 * count, so the action can be retried after one.
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
  for (const followup of followups) {
    const existing = lookup(followup.followupTaskId);
    if (!existing) continue;
    if (existing.status === "done") {
      return { ok: false, reason: `Its tickets follow-up "${existing.title}" already finished.` };
    }
    if (existing.status === "backlog" || isActiveTask(existing.status)) {
      return { ok: false, reason: `Its tickets follow-up "${existing.title}" is already ${existing.status}.` };
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
