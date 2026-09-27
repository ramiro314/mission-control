import { samePlanPublicationContext, type PlanPublicationContext } from "@shared/plan-publication.ts";
import { isPlanningTaskKind } from "@shared/task.ts";
import type { TaskKind } from "@shared/types.ts";

/**
 * The publication ownership a prompted wrap-up must hold to, read only for planning kinds.
 *
 * `hold` is true when a planning task (plan or shape) cannot say who owns its pull request:
 * an unavailable or failed read is never permission to publish. Other kinds read nothing.
 */
export async function promptedWrapupPlanPublication(
  kind: TaskKind | null | undefined,
  read: () => Promise<PlanPublicationContext>,
): Promise<{ context: PlanPublicationContext | null; hold: boolean }> {
  if (!isPlanningTaskKind(kind)) return { context: null, hold: false };
  const context = await read().catch(() => null);
  return { context, hold: !context || context.owner === "unavailable" };
}

/** A verifier may await a model while the operator changes the binding. Spend no stale verdict. */
export async function withPlanPublicationGuard<T>(
  expected: PlanPublicationContext | null,
  verify: () => Promise<T>,
  read: () => Promise<PlanPublicationContext>,
): Promise<T | null> {
  if (!expected) return verify(); // Other task kinds retain their existing path.
  if (expected.owner === "unavailable") return null;
  const result = await verify();
  return await planPublicationStillCurrent(expected, read) ? result : null;
}

export async function planPublicationStillCurrent(
  expected: PlanPublicationContext,
  read: () => Promise<PlanPublicationContext>,
): Promise<boolean> {
  const current = await read().catch(() => null);
  return current !== null && samePlanPublicationContext(expected, current);
}
