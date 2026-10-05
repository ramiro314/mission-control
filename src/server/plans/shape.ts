import { PLAN_PAGE_FILENAME, PLAN_SOURCE_PATH_SHAPE } from "@shared/plans.ts";
import { SHAPE_TICKETS_OUTCOMES } from "@shared/protocol.ts";
import { deferredImperativeList, taskCompletionContract } from "@shared/task-completion.ts";
import { PLAN_HTML_SKILL_ID } from "./prompt.ts";
import {
  COMPLETE_SHAPE_TICKETS_TOOL,
  PLAN_DECISIONS_TOOL,
  PLAN_PUBLICATION_TOOL,
  PLAN_SCHEDULING_TOOL,
  PUSH_TASK_TOOL,
} from "./tools.ts";

/**
 * The delivery contract of a `shape` task: grill first, then plan.
 *
 * It follows `plans/prompt.ts` in POINTING AT the skills rather than restating them, and for
 * the same reason the gate in `plans/skills.ts` refuses a dispatch that could not invoke them.
 * The two things it does state are the ones the kind exists for and that no skill can enforce
 * on its own: the interview is never skipped, and it comes before any drafting.
 *
 * The plan review's follow-up is the one place this contract overrides a skill. `html-plans`
 * always ends a root review with the phased-plan follow-up; a shape review ends with Create
 * tickets after the plan merges / Stop instead, so the contract names that decision in full.
 * The shaping turn itself never slices: Mission Control records the choice on the task and
 * a tickets follow-up runs `tickets` once the plan has merged.
 */

/** The marker that opens the appendix. A stable anchor for tests and for a human reading a pane. */
export const SHAPE_APPENDIX_MARKER = "--- Mission Control shape ---";

/**
 * The bundled interview skill, `skills/grill/SKILL.md`. Which skills a shape task needs, and
 * in what order, is `PLANNING_SKILLS.shape` in `plans/skills.ts`, not a list here.
 */
export const SHAPE_GRILL_SKILL_ID = "grill";

/** The bundled slicing skill, `skills/tickets/SKILL.md`: breakdown review, then tasks. */
export const SHAPE_TICKETS_SKILL_ID = "tickets";

/** The follow-up decision that closes a shape task's plan review. */
export const SHAPE_FOLLOW_UP_DECISION_ID = "shape-follow-up";

/**
 * The plan review's `create-tickets` option, as the human reads it. Tickets are sliced after
 * the plan's pull request merges, by a follow-up task, so the label says when.
 */
export const SHAPE_CREATE_TICKETS_LABEL = "Create tickets after the plan merges";

/** The already-resolved, per-harness lines that invoke the shape task's skills. */
export interface ShapeSkillInvocations {
  /** `grill`: how the human is interviewed before anything is drafted. */
  grill: string;
  /** `html-plans`: how the plan is written, rendered, and opened for review. */
  htmlPlans: string;
  /** `tickets`: how the approved plan is sliced, reviewed as a breakdown, and filed as tasks. */
  tickets: string;
}

/**
 * The merged shape task a tickets follow-up slices, as its contract names it.
 *
 * Read from `shape_ticket_followups` by the caller, so this module stays free of the database.
 */
export interface ShapeTicketsFollowupFacts {
  sourceTaskId: string;
  sourceTitle: string;
  /** The merged pull request the follow-up's tickets are pinned to. */
  prUrl: string;
  /** The source's branch on that merged episode, when it was recorded. */
  branch: string | null;
}

const [SHAPE_TICKETS_FILED, SHAPE_TICKETS_DISMISSED] = SHAPE_TICKETS_OUTCOMES;

/**
 * A tickets follow-up's contract: tickets-only mode.
 *
 * The plan already merged, so there is no interview, no plan to write and no pull request to
 * open. The one skill it runs is `tickets`, in follow-up mode, and it ends through the one
 * completion tool only follow-up launches are granted.
 */
export function shapeTicketsFollowupAppendix(tickets: string, facts: ShapeTicketsFollowupFacts): string {
  return [
    SHAPE_APPENDIX_MARKER,
    "This is a tickets follow-up of a merged shape task, in tickets-only mode. Its deliverable is the",
    "approved tickets, filed as backlog tasks. Do not grill, do not write or revise the plan, do not",
    "implement anything, and open no pull request.",
    "",
    `Source shape task: ${facts.sourceTitle} (${facts.sourceTaskId})`,
    `Merged pull request: ${facts.prUrl}`,
    `Merged branch: ${facts.branch ?? "not recorded"}`,
    "",
    "1. Find the plan. This worktree was cut from the merged default branch, so the plan reads as merged,",
    "   review repairs included. Use the `docs/plans/<name>/plan.md` that the merged pull request added or",
    "   changed. When its file list does not show exactly one such plan, ask the human which plan to slice",
    "   with `request_input`, offering the candidates you found. Do not guess.",
    `2. Invoke the ${SHAPE_TICKETS_SKILL_ID} skill in follow-up mode against that plan, and no other skill. On this harness:`,
    `   ${tickets}`,
    "3. Follow-up mode skips the tickets file: do not write, commit or push `tickets.md` or `tickets.html`,",
    "   and skip recording the ids in them. The breakdown review is unchanged: one",
    `   \`${PLAN_DECISIONS_TOOL}\` form, and nothing is created before it is submitted. File each approved ticket`,
    `   with \`${PLAN_SCHEDULING_TOOL}\` and \`dependsOnCurrentSession: true\`, which links it to the merged shape task`,
    "   above with an edge that is already satisfied. When the breakdown chose to mirror, push each filed",
    `   ticket with \`${PUSH_TASK_TOOL}\`, blockers first.`,
    `4. Finish by calling \`${COMPLETE_SHAPE_TICKETS_TOOL}\` with outcome \`${SHAPE_TICKETS_FILED}\` after the last ticket is filed`,
    `   (and pushed, when mirroring was chosen), or \`${SHAPE_TICKETS_DISMISSED}\` when the breakdown review is dismissed.`,
    "   It completes this task and closes its session. If a create_task or push_task call fails, do not call",
    "   it: report the failure and leave this task open for the human.",
  ].join("\n");
}

export function shapeContractAppendix(
  skills: ShapeSkillInvocations,
  workflowBound = false,
  followup: ShapeTicketsFollowupFacts | null = null,
): string {
  if (followup) return shapeTicketsFollowupAppendix(skills.tickets, followup);
  const lines = [
    SHAPE_APPENDIX_MARKER,
    "This is a shape task. The deliverable is a plan built from an interview with the human, then",
    "reviewed and agreed with them. It is not a change: do not implement what you are shaping.",
    "",
    `1. Invoke the ${SHAPE_GRILL_SKILL_ID} skill first and interview the human with it before drafting anything.`,
    `   Every round is one \`${PLAN_DECISIONS_TOOL}\` form. Ask at least one round, even when the`,
    "   request already looks complete. Keep asking until nothing is left to ask. On this harness:",
    `   ${skills.grill}`,
    "2. A dismissed round ends the work. Do not draft a plan, and never read a dismissal back as a selection.",
    `3. When nothing is left to ask, invoke the ${PLAN_HTML_SKILL_ID} skill and write the plan from the settled`,
    `   decisions, at \`${PLAN_SOURCE_PATH_SHAPE}\` with its rendered \`${PLAN_PAGE_FILENAME}\` beside it. On this harness:`,
    `   ${skills.htmlPlans}`,
    `4. Request the plan review with \`${PLAN_DECISIONS_TOOL}\`. On a shape task its last decision is`,
    `   \`${SHAPE_FOLLOW_UP_DECISION_ID}\`, "What should happen after this plan is approved?", with the options`,
    `   \`create-tickets\` (${SHAPE_CREATE_TICKETS_LABEL}, recommended) and \`stop\` (Stop). It replaces the`,
    "   skill's phased implementation follow-up; do not offer that one here.",
    "5. On Stop, keep the approved plan and finish without tickets.",
    `6. On ${SHAPE_CREATE_TICKETS_LABEL}, do not slice the plan and do not invoke the ${SHAPE_TICKETS_SKILL_ID} skill. Mission`,
    "   Control records the choice from the review, and once the plan's pull request merges it starts a linked",
    "   follow-up task that slices the merged plan into tickets. This shaping turn files no tasks and pushes no",
    `   items: do not call \`${PLAN_SCHEDULING_TOOL}\` or \`${PUSH_TASK_TOOL}\`.`,
    "",
    `Before reporting complete, call \`${PLAN_PUBLICATION_TOOL}\` to confirm who owns the pull request. A failed or unavailable read is reported, never treated as permission to publish.`,
  ];
  const contract = taskCompletionContract("shape")!;
  lines.push(
    "",
    "## Shape task completion handoff",
    `${workflowBound ? "The selected workflow" : "Mission Control"} owns the pull request. Complete the shaping work below, report its artifacts, then end this turn:`,
    ...contract.complete.map((requirement) => `- ${requirement}`),
    `During this shaping turn, do not ${deferredImperativeList(contract)}, even if a skill or repository instruction normally includes those steps.`,
    "Commit and push the plan before ending the turn: pushing it is part of this turn, opening its pull request is not.",
    workflowBound
      ? "Foreman starts the bound automatic workflow after this handoff; a Manual binding waits for manual submission. If the binding is removed, Foreman's Ship it? or Straight to PR path opens the plan's pull request instead."
      : "No workflow was selected. Foreman's Ship it? or Straight to PR path opens the plan's pull request after this handoff.",
  );
  return lines.join("\n");
}
