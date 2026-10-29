import { type TaskKind } from "./types.ts";
import { isPlanningTaskKind, type PlanningTaskKind } from "./task.ts";

/**
 * WHAT "COMPLETE" MEANS for the initial delivered turn of a dispatched task, as trusted
 * policy rather than as prose an agent or a verifier has to infer.
 *
 * WHY THIS MODULE EXISTS
 *
 * A dispatched `ship` task is delivered a completion handoff telling it to commit locally and
 * stop before push, pull request and CI - Mission Control owns those. Its durable objective,
 * written by a human, very often still says "open a reviewable pull request". Prompted
 * completion then asks a tool-less verifier "is the durable objective satisfied?", the
 * verifier reads an objective demanding a PR that nobody opened, answers no, and the
 * completed work-cycle generation is spent on a silent hold. Every later tick skips the
 * generation as already handled, so a finished implementation never reaches the workflow
 * that was bound to review it. That deadlock is what this contract closes.
 *
 * The fix is deliberately NOT "rewrite the objective" and NOT "let the verifier read the
 * handoff out of the transcript". The objective stays exactly what the human asked for,
 * and transcript text is evidence being judged, never policy. Instead the boundary the
 * agent was ACTUALLY given is carried here, structurally, keyed by durable task kind, and
 * handed to the verifier as trusted policy beside the objective.
 *
 * WHY IT IS SHARED AND BROWSER-SAFE
 *
 * Two surfaces have to mean the same thing by construction: the appendix delivered to the
 * agent (`server/task-contract.ts`) and the trusted-policy block in the verify prompt
 * (`server/foreman/queue-prompt.ts`). Two independently maintained wordings of
 * "ship-complete" is precisely how the boundary drifts, so both render from the one record
 * below. No `node:` imports, per `src/shared/` ownership - this is wire-and-policy shape
 * only.
 */

/** One post-completion action the agent must NOT take on its initial delivered turn. */
export interface DeferredCompletionAction {
  /** Stable id, for tests and for future callers that need to name one action. */
  id: string;
  /** Imperative phrasing, for the "do not …" sentence delivered to the agent. */
  imperative: string;
  /** Noun phrasing, for the verifier's trusted-policy list. */
  noun: string;
}

/**
 * The initial completion boundary for one task kind.
 *
 * `complete` and `deferred` are the whole contract: what has to be true for the delivered
 * turn to be finished, and what is explicitly somebody else's job afterwards. Both are
 * rendered, never re-stated, by the two surfaces that consume them.
 */
export interface TaskCompletionContract {
  kind: TaskKind;
  /** Who owns the deferred work once this boundary is crossed. */
  owner: string;
  /** One line naming the boundary, used as the heading of both renderings. */
  boundary: string;
  /** What must be complete for the initial delivered turn to be complete. */
  complete: readonly string[];
  /** Post-completion work explicitly deferred away from this turn. */
  deferred: readonly DeferredCompletionAction[];
}

const SHIP_CONTRACT: TaskCompletionContract = {
  kind: "ship",
  owner: "Mission Control",
  boundary: "the initial implementation handoff of a dispatched ship task",
  complete: [
    "the requested implementation is done",
    "repository documentation the change requires is updated",
    "the focused tests and verification the change requires have been run",
    "the scoped work is committed locally on the task branch, so HEAD holds the change",
    "workflow evidence registration the task asked for is done when an active Persona workflow accepts it",
  ],
  // Commit is deliberately NOT deferred: workflow Check nodes run against the session's
  // captured HEAD commit and never the working tree, so an uncommitted change is invisible
  // to them. The local commit belongs to this turn; publishing it does not.
  deferred: [
    { id: "push", imperative: "push", noun: "pushing a branch" },
    {
      id: "pull-request",
      imperative: "create or update a pull request",
      noun: "creating or updating a pull request",
    },
    {
      id: "review",
      imperative: "act on pull-request review feedback",
      noun: "pull-request review follow-through",
    },
    { id: "ci", imperative: "wait for pull-request CI", noun: "waiting for pull-request CI" },
  ],
};

/**
 * The planning requirements plan and shape share, in one place, so a shape task is never
 * verified against a stale copy of the plan's boundary. Each kind adds only its own
 * middle: plan its phases, shape the absence of tickets.
 */
const PLANNING_APPROVED_PLAN = [
  "the human has reviewed and approved the plan, and their decisions are incorporated; dismissal is not approval",
  "the plan's Markdown and rendered HTML are complete and consistent",
] as const;
const PLANNING_VERIFIED_HANDOFF = [
  "the verification the planning work requires has been run",
  "workflow evidence registration the task asked for is done when an active Persona workflow accepts it, including the current plan text and required cross-file context",
] as const;
const PLAN_PHASING_REQUIREMENT = "the human has been offered the selectable phased-plan follow-up once per root plan, on its first review, to break up and schedule it or stop, even when there are no other open choices; only their selection authorizes phasing and scheduling, and later repair or re-approval reviews retain that choice without another offer, as do derived phases";

const PLAN_CONTRACT: TaskCompletionContract = {
  kind: "plan",
  owner: "Mission Control",
  boundary: "the planning handoff before publication",
  complete: [
    PLAN_PHASING_REQUIREMENT,
    ...PLANNING_APPROVED_PLAN,
    "when requested, phase files, the audited dependency graph, and the phase-to-task-id map are complete; declined phasing requires no phase tasks",
    "Markdown artifacts referenced by phase tasks and policy-included HTML are committed and pushed, with exact paths verified before scheduling; policy-excluded HTML is verified in its retained revision, and every phase task depends on the planning session",
    ...PLANNING_VERIFIED_HANDOFF,
  ],
  // Plans need durable artifacts before scheduling. Push is deliberately retained.
  deferred: [
    ...SHIP_CONTRACT.deferred.filter((action) => action.id !== "push"),
    { id: "merge", imperative: "merge the pull request", noun: "merging the pull request" },
  ],
};

const LOCAL_PLAN_CONTRACT: TaskCompletionContract = {
  ...PLAN_CONTRACT,
  boundary: "the local plan publication handoff",
  complete: [
    PLAN_PHASING_REQUIREMENT,
    "the complete final Markdown and HTML bundle is saved as an immutable local revision",
    "the human explicitly approved that exact final bundle through a managed plan review; dismissal is not approval",
    "requested phases carry exact structured Markdown inputs, local artifact prerequisites, and direct implementation merge dependencies",
    "applicable focused validation and final plan text evidence are registered for the selected workflow",
    "the task contains only local plan artifacts; code and mixed tasks keep their normal shipping workflow",
    "when no workflow is selected, publish_plan has verified and published the approved local revision",
  ],
  deferred: SHIP_CONTRACT.deferred,
};

/**
 * A shape task's boundary: the plan's, without phases or tickets.
 *
 * The shaping turn delivers an approved plan and nothing scheduled from it. A Create tickets
 * answer is recorded by Mission Control and acted on only after the plan's pull request
 * merges, by a follow-up task, so the verifier must not expect ticket or phase tasks here.
 * Worded as "not required" rather than "forbidden", because a shape session dispatched before
 * this contract still files its tickets in-session and is judged by this same record.
 */
const SHAPE_CONTRACT: TaskCompletionContract = {
  kind: "shape",
  owner: "Mission Control",
  boundary: "the shaping handoff before publication",
  complete: [
    ...PLANNING_APPROVED_PLAN,
    "no ticket or phase tasks are required from this turn: Mission Control records a Create tickets choice and files the tickets in a follow-up task after the plan's pull request merges",
    "the plan is committed and pushed",
    ...PLANNING_VERIFIED_HANDOFF,
  ],
  deferred: PLAN_CONTRACT.deferred,
};

/**
 * A shape task pinned to local storage: the local plan's boundary without phases or tickets.
 *
 * Its plan never reaches Git, so a Create tickets choice starts the follow-up when the approved
 * revision is published locally rather than when a pull request merges.
 */
const LOCAL_SHAPE_CONTRACT: TaskCompletionContract = {
  ...LOCAL_PLAN_CONTRACT,
  kind: "shape",
  boundary: "the local shaping handoff",
  complete: [
    "the complete final Markdown and HTML bundle is saved as an immutable local revision",
    "the human explicitly approved that exact final bundle through a managed plan review; dismissal is not approval",
    "no ticket or phase tasks are required from this turn: Mission Control records a Create tickets choice and files the tickets in a follow-up task after the approved revision is published",
    "applicable focused validation and final plan text evidence are registered for the selected workflow",
    "the task contains only local plan artifacts",
    "when no workflow is selected, publish_plan has verified and published the approved local revision",
  ],
};

/** A planning kind's boundary when its plan is pinned to local storage. */
const LOCAL_PLANNING_CONTRACT: Record<PlanningTaskKind, TaskCompletionContract> = {
  plan: LOCAL_PLAN_CONTRACT,
  shape: LOCAL_SHAPE_CONTRACT,
};

/**
 * The contract per kind, or null for a kind that draws no such boundary.
 *
 * `Record<TaskKind, …>` for the same reason `KIND_CONTRACT` in `server/task-contract.ts`
 * uses one: a new task kind does not compile until it has said what its completion
 * boundary is, including saying it has none. Ship, Bugfix and Document defer post-completion
 * work; plan and shape defer publication follow-through whether or not a workflow is bound: the
 * bound workflow's Pull Request action or Foreman's wrap-up opens the planning pull request.
 * Other kinds are judged against their objective unchanged.
 */
const KIND_COMPLETION_CONTRACT: Record<TaskKind, TaskCompletionContract | null> = {
  document: {
    ...SHIP_CONTRACT,
    kind: "document",
    boundary: "the initial documentation handoff of a dispatched document task",
    complete: [
      "the requested repository documentation is complete in its authoritative owner documents",
      "changed documentation is accurate, consistent with relevant current references, and concise without duplicating maintained contracts",
      "the focused documentation checks and verification the change requires have been run",
      "current documentation and comparison context are registered as workflow evidence when an active Persona workflow accepts it",
    ],
  },
  ship: SHIP_CONTRACT,
  bugfix: { ...SHIP_CONTRACT, kind: "bugfix", boundary: "the initial implementation handoff of a dispatched bugfix task" },
  scout: null,
  plan: PLAN_CONTRACT,
  pipeline: null,
  chat: null,
  shape: SHAPE_CONTRACT,
};

/**
 * The trusted initial completion contract for a durable task kind, or null.
 *
 * Kind-only by design: no agent opens its own pull request on the initial turn, so the
 * boundary does not depend on whether a workflow is bound. A planning task's pinned storage is
 * the one other input: a locally stored plan or shape plan has no pull request and hands off
 * through its own record.
 */
export function taskCompletionContract(
  kind: TaskKind | null | undefined,
  planStorage: "repository" | "local" = "repository",
): TaskCompletionContract | null {
  if (isPlanningTaskKind(kind) && planStorage === "local") return LOCAL_PLANNING_CONTRACT[kind];
  return kind ? KIND_COMPLETION_CONTRACT[kind] ?? null : null;
}

/** Current daemon authority overrides an evidence demand retained in an older prompt or gap. */
export function workflowEvidenceRequirement(eligible: boolean): string {
  return eligible
    ? "An active Persona workflow accepts evidence. Complete the workflow evidence registration the task requires before handoff."
    : "No active Persona workflow accepts evidence. Workflow evidence registration is not required for this handoff. Do not request it or treat its absence as a blocking gap, even if an earlier instruction or review requested it. Implementation, required documentation, and focused verification are still required.";
}

/** "push, create or update a pull request, … or wait for pull-request CI". */
export function deferredImperativeList(contract: TaskCompletionContract): string {
  return joinWithOr(contract.deferred.map((action) => action.imperative));
}

function joinWithOr(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`;
}
