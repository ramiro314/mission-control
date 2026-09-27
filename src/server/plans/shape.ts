import { PLAN_PAGE_FILENAME, PLAN_SOURCE_PATH_SHAPE } from "@shared/plans.ts";
import { deferredImperativeList, taskCompletionContract } from "@shared/task-completion.ts";
import { PLAN_HTML_SKILL_ID } from "./prompt.ts";
import { PLAN_DECISIONS_TOOL, PLAN_PUBLICATION_TOOL } from "./tools.ts";

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
 * tickets / Stop instead, so the contract names that decision in full.
 */

/** The marker that opens the appendix. A stable anchor for tests and for a human reading a pane. */
export const SHAPE_APPENDIX_MARKER = "--- Mission Control shape ---";

/**
 * The bundled interview skill, `skills/grill/SKILL.md`. Which skills a shape task needs, and
 * in what order, is `PLANNING_SKILLS.shape` in `plans/skills.ts`, not a list here.
 */
export const SHAPE_GRILL_SKILL_ID = "grill";

/** The follow-up decision that closes a shape task's plan review. */
export const SHAPE_FOLLOW_UP_DECISION_ID = "shape-follow-up";

/** The already-resolved, per-harness lines that invoke the shape task's skills. */
export interface ShapeSkillInvocations {
  /** `grill`: how the human is interviewed before anything is drafted. */
  grill: string;
  /** `html-plans`: how the plan is written, rendered, and opened for review. */
  htmlPlans: string;
}

export function shapeContractAppendix(skills: ShapeSkillInvocations, workflowBound = false): string {
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
    "   `create-tickets` (Create tickets, recommended) and `stop` (Stop). It replaces the skill's phased",
    "   implementation follow-up; do not offer that one here.",
    "5. On Stop, keep the approved plan and finish. On Create tickets, record the choice in the plan and",
    "   finish; filing the tickets as tasks is not available on this build yet, so do not improvise it.",
    "",
    `Before publication, call \`${PLAN_PUBLICATION_TOOL}\` to refresh who owns the pull request. A failed or unavailable read is not permission to publish directly.`,
  ];
  const contract = taskCompletionContract("shape", workflowBound);
  if (contract) {
    lines.push(
      "",
      "## Shape task completion handoff",
      "The selected workflow owns the pull request. Complete the shaping work below, report its artifacts, then end this turn:",
      ...contract.complete.map((requirement) => `- ${requirement}`),
      `During this shaping turn, do not ${deferredImperativeList(contract)}, even if a skill or repository instruction normally includes those steps.`,
      "If the publication-context tool confirms the binding was removed and owner is skill, open the plan's pull request yourself unless a separate instruction forbids it.",
      "Commit and push the plan before ending the turn. Foreman starts the bound automatic workflow after this handoff; a Manual binding waits for manual submission.",
    );
  } else {
    lines.push("No workflow was selected. After the plan is approved, commit and push it and open the plan's pull request. Refresh publication ownership first and honor any stronger no-PR instruction.");
  }
  return lines.join("\n");
}
