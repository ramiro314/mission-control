import type { AgentType, Task } from "@shared/types.ts";
import { resolveTaskAgent } from "./harnesses.ts";
import { SHAPE_TICKETS_SKILL_ID } from "./plans/shape.ts";
import { skillInvocationForAgent } from "./skills/invoke.ts";
import { shapeTicketsAcceptance } from "./shape-tickets.ts";
import type { TaskManager } from "./tasks.ts";

/** What starting a tickets follow-up did, or why it did nothing. */
export type ShapeTicketsStartResult =
  | { kind: "started"; task: Task }
  /** Created, but its launch was refused: it waits in the backlog with `reason` as its error. */
  | { kind: "queued"; task: Task; reason: string }
  | { kind: "refused"; status: 404 | 409 | 500; error: string };

export interface ShapeTicketsDeps {
  tasks: TaskManager;
  /** Injected so a route test never reads the operator's skills config. */
  skillForAgent?: typeof skillInvocationForAgent;
  /** The configured harness for a shape task, read at the call. */
  defaultAgent?: () => AgentType;
}

/**
 * Start a merged shape task's tickets follow-up: the manual **Create tickets** action.
 *
 * Accepted only by `shapeTicketsAcceptance`, re-checked here rather than trusting the menu.
 * The check and the create run with no `await` between them, so two clicks cannot both pass
 * the "no live or done follow-up" rule. The follow-up is then dispatched; a refused launch
 * leaves it in the backlog with the reason, as a Retro follow-up does.
 */
export async function startShapeTicketsFollowup(
  sourceTaskId: string,
  deps: ShapeTicketsDeps,
): Promise<ShapeTicketsStartResult> {
  const source = deps.tasks.get(sourceTaskId) ?? deps.tasks.getDurable(sourceTaskId);
  if (!source) return { kind: "refused", status: 404, error: "no such task" };
  const accepted = shapeTicketsAcceptance(
    source,
    (id) => deps.tasks.get(id) ?? deps.tasks.getDurable(id),
  );
  if (!accepted.ok) return { kind: "refused", status: 409, error: accepted.reason };

  let task: Task;
  try {
    task = deps.tasks.createShapeTicketsFollowup({
      sourceTask: source,
      sourceEpisodeId: accepted.posture.binding.episodeId,
      sourceSessionId: accepted.posture.binding.sessionId,
      sourcePrUrl: accepted.posture.prUrl,
      agent: shapeTicketsAgent(source.agent, deps),
    });
  } catch (error) {
    return {
      kind: "refused",
      status: 500,
      error: `The tickets follow-up could not be created: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const dispatched = await deps.tasks.dispatch(task.id);
  if (dispatched.ok) return { kind: "started", task: dispatched.task };
  const reason = dispatched.error.trim().slice(0, 400) || "the task could not be launched yet";
  const current = deps.tasks.recordBacklogRefusal(task.id, reason) ?? deps.tasks.get(task.id) ?? task;
  return { kind: "queued", task: current, reason };
}

/**
 * The Retro follow-up's runner rule: the shape task's own agent when it can run the tickets
 * skill, otherwise the shape kind's configured default. When neither can, the default is kept
 * and the dispatch gate refuses the launch with the skills panel's own sentence.
 */
function shapeTicketsAgent(sourceAgent: AgentType, deps: ShapeTicketsDeps): AgentType {
  const resolve = deps.skillForAgent ?? skillInvocationForAgent;
  if (resolve(sourceAgent, SHAPE_TICKETS_SKILL_ID).ok) return sourceAgent;
  return (deps.defaultAgent ?? (() => resolveTaskAgent("shape")))();
}
