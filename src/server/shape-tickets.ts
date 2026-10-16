import type { PlanIdentity } from "@shared/managed-plans.ts";
import type { ShapeTicketsOutcome } from "@shared/protocol.ts";
import { isActiveTask } from "@shared/task-status.ts";
import { isLocalPlanningTask } from "@shared/task.ts";
import type { PlanDecisionAnswer, ShapeTicketsState, Task, TaskShapeTickets } from "@shared/types.ts";
import {
  getTask as getDurableTask,
  historicalTaskWorkEpisodeBindingsForTask,
  retroPrPostureForTask,
  shapeTicketFollowupForTask,
  shapeTicketFollowupsForSource,
  shapeTicketsStateFor,
  taskEdgeSelectionsTo,
  taskWorkEpisodeForTask,
  transitionShapeTicketsState,
  type ShapeTicketFollowupRelation,
} from "./db.ts";
import type { MissionMcpRequirement } from "./mission-mcp.ts";
import { latestPublicationReceiptForTask } from "./plans/inputs.ts";
import { SHAPE_FOLLOW_UP_DECISION_ID, type ShapeTicketsFollowupFacts } from "./plans/shape.ts";
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

/**
 * Where an accepted follow-up's plan landed: the merged pull request of a repository plan, or
 * the published revision of a local one. `ref` is what `shape_ticket_followups.source_pr_url`
 * stores: the PR URL, or `localShapePlanRef` of the revision (the column predates local plans).
 */
export interface ShapeTicketsSource {
  episodeId: string;
  sessionId: string;
  ref: string;
}

export type ShapeTicketsAcceptance =
  | { ok: true; source: ShapeTicketsSource }
  | { ok: false; reason: string };

const LOCAL_PLAN_REF_PREFIX = "plan:";

/** A published local revision as a follow-up relation stores it. */
export function localShapePlanRef(plan: PlanIdentity): string {
  return `${LOCAL_PLAN_REF_PREFIX}${plan.repoKey}:${plan.planId}:${plan.revision}`;
}

/** The local revision a relation's `ref` names, or null for a merged pull request's URL. */
export function localShapePlanOf(ref: string): PlanIdentity | null {
  if (!ref.startsWith(LOCAL_PLAN_REF_PREFIX)) return null;
  const [repoKey, planId, revision] = ref.slice(LOCAL_PLAN_REF_PREFIX.length).split(":");
  const parsed = Number(revision);
  if (!repoKey || !planId || !Number.isSafeInteger(parsed) || parsed < 1) return null;
  return { repoKey, planId, revision: parsed };
}

/**
 * Where a done shape task's plan landed, or the reason there is none: the merged pull request
 * for a repository plan (`retroPrPostureForTask`, the post-merge Retro's check), the newest
 * published revision for a plan pinned to local storage.
 */
function shapeTicketsSourceFor(task: Task): ShapeTicketsSource | string {
  if (isLocalPlanningTask(task)) {
    const receipt = latestPublicationReceiptForTask(task.id);
    if (!receipt) return "This shape task has no published local plan, so there is no approved plan to slice.";
    const episodeId = receipt.episodeId ?? taskWorkEpisodeForTask(task.id)?.episodeId ?? null;
    if (!episodeId) return "This shape task's published plan names no work episode to link its tickets to.";
    return { episodeId, sessionId: receipt.sessionId, ref: localShapePlanRef(receipt) };
  }
  const posture = retroPrPostureForTask(task.id);
  if (posture?.kind !== "merged") {
    return "This shape task has no merged pull request, so there is no merged plan to slice.";
  }
  return { episodeId: posture.binding.episodeId, sessionId: posture.binding.sessionId, ref: posture.prUrl };
}

/**
 * Whether **Create tickets** may start a follow-up for this task now.
 *
 * The task must be a `shape` task that is done with its plan landed: a merged pull-request
 * posture, the check the post-merge Retro makes (`retroPrPostureForTask`), or for a plan pinned
 * to local storage a published revision. None of its follow-ups may be
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
      reason: isLocalPlanningTask(task)
        ? `This shape task is ${task.status}. Create tickets needs it done through its plan's local publication.`
        : `This shape task is ${task.status}. Create tickets needs it done through its plan's merged pull request.`,
    };
  }
  const source = shapeTicketsSourceFor(task);
  if (typeof source === "string") return { ok: false, reason: source };
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
  return { ok: true, source };
}

/** The wire projection: `null` for every kind but shape. */
export function shapeTicketsSummary(task: Task, lookup: TaskLookup = durableLookup): TaskShapeTickets | null {
  if (task.kind !== "shape") return null;
  const followups = shapeTicketFollowupsForSource(task.id);
  return {
    state: shapeTicketsStateFor(task.id),
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
  const plan = localShapePlanOf(relation.sourcePrUrl);
  return {
    sourceTaskId: relation.sourceTaskId,
    sourceTitle: lookup(relation.sourceTaskId)?.title ?? relation.sourceTaskId,
    prUrl: plan ? null : relation.sourcePrUrl,
    branch: plan ? null : binding?.branch ?? null,
    plan,
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
export function shapeTicketsFollowupIntent(source: Pick<Task, "id" | "title">, ref: string): string {
  const plan = localShapePlanOf(ref);
  return [
    plan
      ? `Create tickets for the published local plan of the shape task "${source.title}" (${source.id}).`
      : `Create tickets for the merged plan of the shape task "${source.title}" (${source.id}).`,
    plan
      ? `Its plan was published locally as revision ${plan.revision} of plan ${plan.planId}. Slice that plan into tickets, get the breakdown approved, and`
      : `Its plan merged in ${ref}. Slice that plan into tickets, get the breakdown approved, and`,
    "file the approved tickets as backlog tasks linked to that shape task.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The recorded choice: `tasks.shape_tickets`, one transition per signal
// ---------------------------------------------------------------------------

/**
 * What puts a shape task's moved choice on the wire: the Registry.
 *
 * The choice is written by its own accessor rather than through `upsertTask`, so a move is
 * invisible to the dashboard until the task is re-sent. Every transition below takes this and
 * re-sends the task whenever the row moved, so no caller can move the choice and forget to.
 */
export interface ShapeTicketsPublisher {
  republishShapeTickets(taskId: string): void;
}

/** One compare-and-set move, re-sent on the wire when it happened. */
function moveShapeTickets(
  publisher: ShapeTicketsPublisher,
  taskId: string,
  from: readonly (ShapeTicketsState | null)[],
  next: ShapeTicketsState,
): boolean {
  const moved = transitionShapeTicketsState(taskId, from, next);
  if (moved) publisher.republishShapeTickets(taskId);
  return moved;
}

/** The choices a merge-quorum completion acts on: the human chose Create tickets. */
const AWAITING_MERGE: readonly ShapeTicketsState[] = ["pending", "lapsed"];

/**
 * Stamp a shape task dispatched under the contract that defers tickets to the merge.
 *
 * Only a never-stamped shaping task moves: a retried dispatch keeps the choice its earlier
 * review recorded, and a tickets follow-up is never stamped (the store refuses it). This is
 * the discriminator that keeps a shape session already in flight under the old prompt, which
 * files tickets in-session, from ever being followed up at its merge.
 */
export function stampShapeTicketsAwaitingReview(
  task: Pick<Task, "id" | "kind">,
  publisher: ShapeTicketsPublisher,
): boolean {
  return task.kind === "shape" && moveShapeTickets(publisher, task.id, [null], "awaiting-review");
}

/**
 * What a resolved plan review's `shape-follow-up` answer records, or null when it carries none.
 *
 * Read by option id, never by label, so the copy can change without changing the meaning.
 */
export function shapeFollowUpChoice(
  selections: readonly PlanDecisionAnswer[] | null | undefined,
): Extract<ShapeTicketsState, "pending" | "stop"> | null {
  const answer = selections?.find((selection) => selection.decisionId === SHAPE_FOLLOW_UP_DECISION_ID);
  if (!answer) return null;
  if (answer.selected.includes("create-tickets")) return "pending";
  if (answer.selected.includes("stop")) return "stop";
  return null;
}

/**
 * Record the latest resolved plan review's choice on a stamped shape task.
 *
 * The latest review wins, so pending and stop overwrite each other, and a lapsed choice takes
 * a new answer (a recovery session re-asking after a closed PR). An unstamped task is never
 * written, and neither is one whose follow-up already exists (queued or started).
 */
export function recordShapeTicketsChoice(
  taskId: string,
  choice: Extract<ShapeTicketsState, "pending" | "stop">,
  publisher: ShapeTicketsPublisher,
): boolean {
  return moveShapeTickets(publisher, taskId, ["awaiting-review", "pending", "stop", "lapsed"], choice);
}

/** A pending choice lapses: the task ended without its merge, or its PR closed unmerged. */
export function lapseShapeTickets(taskId: string, publisher: ShapeTicketsPublisher): boolean {
  return moveShapeTickets(publisher, taskId, ["pending"], "lapsed");
}

/** Whether a merge-quorum completion should start this task's follow-up. */
export function shapeTicketsAwaitMerge(taskId: string): boolean {
  const state = shapeTicketsStateFor(taskId);
  return state !== null && AWAITING_MERGE.includes(state);
}

/** The automatic follow-up was created and dispatched. */
export function markShapeTicketsStarted(taskId: string, publisher: ShapeTicketsPublisher): boolean {
  return moveShapeTickets(publisher, taskId, AWAITING_MERGE, "started");
}

/** A queued follow-up was dispatched later, by hand or by the autopilot. */
export function promoteQueuedShapeTickets(taskId: string, publisher: ShapeTicketsPublisher): boolean {
  return moveShapeTickets(publisher, taskId, ["queued"], "started");
}

/** The automatic follow-up was created, but its launch was refused. */
export function markShapeTicketsQueued(taskId: string, publisher: ShapeTicketsPublisher): boolean {
  return moveShapeTickets(publisher, taskId, AWAITING_MERGE, "queued");
}
