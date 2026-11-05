import { AsyncLocalStorage } from "node:async_hooks";
import type { WorktreeHistoryActor } from "@shared/worktrees.ts";

const acting = new AsyncLocalStorage<WorktreeHistoryActor>();

/**
 * Who the slot history names for the work `operation` starts. A release is reached through
 * whichever domain owns the lease (a task's reclaim, a check's recovery, a manual return), so the
 * actor travels with the work instead of through each of them: an operator's action from
 * Settings, or a decision the daemon made on its own, such as retention or a leaked lease.
 */
export function runAsWorktreeActor<T>(actor: WorktreeHistoryActor, operation: () => Promise<T>): Promise<T> {
  return acting.run(actor, operation);
}

/** The actor set around this work, or undefined when a lease's own step names its owner. */
export function currentWorktreeActor(): WorktreeHistoryActor | undefined {
  return acting.getStore();
}
