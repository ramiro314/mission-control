import { SUBMIT_WORKFLOW_EVIDENCE_TOOL } from "./workflows/evidence-tool.ts";

export interface ExecutionAuthorizationContext {
  /** The receiving prompt can use the selected Persona workflow's evidence tool. */
  workflowEvidence: boolean;
  /** The prompt continues work already owned by a workflow run. */
  workflowContinuation: boolean;
  /**
   * The prompt is itself one of the pull-request grant holders: the workflow Pull Request
   * action's packet or the Runs "Ask the session to open a PR" handoff. Every other prompt,
   * including every initial task prompt and every repair or Inspector packet, gets the task
   * authorization, which withholds the creation grant and allows only updating a PR that
   * already exists. Foreman's PR instructions and a human asking in the session are the other
   * two holders; they grant in their own words and never render this contract.
   */
  pullRequestGrant: boolean;
}

const LIMITS =
  "It does not authorize merge, another repository, or another external write, and it does not change sandbox approval or server-side validation.";

const PULL_REQUEST_GRANT = [
  "When this task or the current workflow asks for a pull request, the operator has already authorized you to commit the scoped work, push its task branch, and create or update that pull request in the repository scope Mission Control issued. Act directly without asking for another confirmation.",
  `This authorization is conditional, not a requirement. An explicit no-PR instruction wins. ${LIMITS}`,
].join("\n");

const TASK_AUTHORIZATION = [
  "Do not push or open a pull request on your own initiative, even when the task text or repository instructions mention one. Mission Control's workflow Pull Request action, a Foreman pull-request instruction, or the human asking in this session grants that.",
  "Once this task's pull request exists, you may push to update it. Before then, push only where your task's completion contract requires pushing its branch.",
  `The operator has authorized you to commit the scoped work. ${LIMITS}`,
].join("\n");

const WORKFLOW_EVIDENCE_AUTHORIZATION =
  `The operator has already authorized \`${SUBMIT_WORKFLOW_EVIDENCE_TOOL}\` for task-produced, checkout-relative artifacts, the repository slot Mission Control issued, and \`repositoryScope: "all"\` only when Mission Control issued that scope. Call it directly without asking the human to approve the payload or Mission Control destination; server-side validation remains authoritative.`;

const WORKFLOW_RESUBMISSION_OWNERSHIP =
  "Finish the requested work, register useful new evidence when eligible, and stop. Mission Control's engine or the Runs UI owns any resubmission; do not ask the human to resubmit the workflow.";

/** Mission Control's standing execution policy, rendered around task- or workflow-owned work. */
export function executionAuthorizationContract(context: ExecutionAuthorizationContext): string {
  return [
    "## Mission Control execution authorization",
    context.pullRequestGrant ? PULL_REQUEST_GRANT : TASK_AUTHORIZATION,
    ...(context.workflowEvidence ? [WORKFLOW_EVIDENCE_AUTHORIZATION] : []),
    ...(context.workflowContinuation ? [WORKFLOW_RESUBMISSION_OWNERSHIP] : []),
  ].join("\n");
}

/** The evidence-specific policy arm, reused inside the optional evidence usage appendix. */
export function workflowEvidenceAuthorizationContract(): string {
  return [WORKFLOW_EVIDENCE_AUTHORIZATION, WORKFLOW_RESUBMISSION_OWNERSHIP].join("\n");
}
