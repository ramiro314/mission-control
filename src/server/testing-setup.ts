// The "Set up flake-aware testing" repository action, and the one Command write its agent may make
// through MCP. That bounds the agent's MCP tools only: the `/api/*` Command routes accept any
// loopback caller without a token, an agent's shell included (see docs/security.md). The same is
// true of `propose_command_document` (`command-document-proposals.ts`), whose operator review
// bounds the MCP surface and not the apply route behind it.
//
// Two halves of one supervised task. `startTestingSetup` files and launches a ship task whose
// intent invokes the `testing-setup` skill in the mode the operator chose:
//
// - committed: the skill audits the repository, asks the human in one decision form, and applies
//   only what was approved. `setAffectedTestsCommand` is how the approved `affected-tests`
//   template reaches Mission Control: a machine-local Command override, written through the same
//   `WorkflowCommandManager.replace` the Command editor's route uses.
// - stored: the skill changes no file. It proposes per-folder `affected-tests` overrides and
//   stored testing settings as one Command document with `propose_command_document`, and the
//   operator applies it from the preview, which is that mode's one approval step.
import type { AgentType, Task } from "@shared/types.ts";
import type { TestingSetupMode, TestingSetupStartResponse } from "@shared/protocol.ts";
import { WORKFLOW_LIMITS, commandTemplateProblem, type WorkflowCommandView } from "@shared/workflow.ts";
import { TESTING_SETUP_SKILL } from "@shared/skills.ts";
import { skillLoadingAgents } from "@shared/harness-capabilities.ts";
import { isTerminalTask } from "@shared/task-status.ts";
import { PLAN_DECISIONS_TOOL } from "./plans/tools.ts";
import { resolveTaskAgent } from "./harnesses.ts";
import { resolveTaskRepoRoot } from "./repos.ts";
import { skillInvocationForAgent } from "./skills/invoke.ts";
import { MANUAL_DISPATCH_TASK_CREATE, type TaskManager } from "./tasks.ts";
import {
  SET_AFFECTED_TESTS_COMMAND_TOOL,
  TESTING_SETUP_STORED_LABEL,
  TESTING_SETUP_TASK_LABEL,
} from "./testing-setup-tool.ts";
import { PROPOSE_COMMAND_DOCUMENT_TOOL } from "./command-document-proposals.ts";
import type { MissionMcpTool } from "./mission-mcp.ts";
import type { WorkflowCommandManager, WorkflowCommandMutation } from "./workflows/commands.ts";

export type TestingSetupResult =
  | ({ kind: "started" } & TestingSetupStartResponse)
  | { kind: "refused"; status: 400 | 409; error: string };

export interface TestingSetupDeps {
  tasks: Pick<TaskManager, "create" | "dispatch" | "get" | "list">;
  resolveRepoRoot?: typeof resolveTaskRepoRoot;
  skillForAgent?: typeof skillInvocationForAgent;
  /** The ship kind's default harness; injected so a test does not read the Harnesses config. */
  defaultAgent?: () => AgentType;
  /** The Command catalog, read only to tell the agent the repository's current template. */
  commands?: Pick<WorkflowCommandManager, "get"> | null;
}

/**
 * The Mission MCP tools each mode's intent names, so the launch pre-approves exactly those; a
 * tool the prompt names but the launch did not approve stops on a permission prompt.
 *
 * Stored has no decision form. Its proposal writes nothing live, and the operator's preview in
 * Library › Commands is where every change is approved, so a form before it would ask twice.
 * Neither mode is offered the other's Command tool.
 */
export const TESTING_SETUP_MODE_TOOLS: Record<TestingSetupMode, readonly MissionMcpTool[]> = {
  committed: [PLAN_DECISIONS_TOOL, SET_AFFECTED_TESTS_COMMAND_TOOL],
  stored: [PROPOSE_COMMAND_DOCUMENT_TOOL],
};

/**
 * File the testing-setup task for one repository and launch it.
 *
 * Gated on the skill FIRST, for retro's reason: the skill is where the one approval form and
 * "apply only what was approved" live, so a task that reached an agent without it would edit CI
 * on the strength of a sentence in its intent. The refusal is the resolver's own sentence, so it
 * names the toggle exactly as the retro refusal does.
 *
 * `workflowId: null`, deliberately. A committed setup owns its pull request and proves the setup
 * on that pull request's own CI while the session is still open, and the human has already
 * approved every change in the decision form. A review workflow bound on top would hold the pull
 * request behind Personas and Checks the approval form already answered, and on a repository with
 * no `affected-tests` Command yet its gate could not run anyway. A stored setup commits nothing,
 * so there is no pull request for a workflow to review.
 *
 * `mode` is the operator's choice, made before this is called; it decides the title, the intent,
 * the tools the launch pre-approves (`TESTING_SETUP_MODE_TOOLS`) and, for stored, the second
 * label that keeps `set_affected_tests_command` away from the task. Nothing else differs.
 */
export async function startTestingSetup(
  repoRoot: string,
  mode: TestingSetupMode,
  deps: TestingSetupDeps,
): Promise<TestingSetupResult> {
  const resolved = await (deps.resolveRepoRoot ?? resolveTaskRepoRoot)(repoRoot);
  if (!resolved.ok) return { kind: "refused", status: 400, error: resolved.error };

  // One setup at a time per repository, in either mode. A second agent auditing the same
  // unmerged state would open a competing pull request with overlapping CI edits, or replace the
  // first one's proposal before it was reviewed, so a start is refused while an
  // earlier testing-setup task for this repository is still open (backlog or live). A finished,
  // failed or cancelled one does not block, which is how "run it again later" works.
  const open = deps.tasks.list().find((task) =>
    task.repoRoot === resolved.repoRoot
    && task.labels.includes(TESTING_SETUP_TASK_LABEL)
    && !isTerminalTask(task.status));
  if (open) {
    return {
      kind: "refused",
      status: 409,
      error: `A testing setup task for this repository is already ${open.status === "backlog" ? "in the backlog" : "open"} `
        + `("${open.title}"). Finish or cancel it before starting another.`,
    };
  }

  const runner = testingSetupAgent(deps);
  if ("problem" in runner) {
    return {
      kind: "refused",
      status: 409,
      error: `${runner.problem} A testing setup task started now would reach an agent that cannot `
        + "load the procedure its intent names.",
    };
  }

  const overrides = deps.commands?.get("affected-tests")?.overrides ?? [];
  const leaf = repoLeafName(resolved.repoRoot);
  const task = deps.tasks.create(
    {
      repoRoot: resolved.repoRoot,
      extraRepoRoots: [],
      title: (mode === "stored"
        ? `Set up flake-aware testing (stored): ${leaf}`
        : `Set up flake-aware testing: ${leaf}`).slice(0, 120),
      intent: mode === "stored"
        ? storedTestingSetupIntent(resolved.repoRoot, repositoryOverrides(resolved.repoRoot, overrides))
        : testingSetupIntent(
          resolved.repoRoot,
          overrides.find((entry) => entry.repoRoot === resolved.repoRoot)?.command ?? null,
        ),
      kind: "ship",
      agent: runner.agent,
      workflowId: null,
      backlog: true,
      labels: mode === "stored" ? [TESTING_SETUP_TASK_LABEL, TESTING_SETUP_STORED_LABEL] : [TESTING_SETUP_TASK_LABEL],
    },
    undefined,
    MANUAL_DISPATCH_TASK_CREATE,
  );
  const launched = await deps.tasks.dispatch(task.id, {
    missionMcp: { tools: TESTING_SETUP_MODE_TOOLS[mode] },
  });
  if (launched.ok) return { kind: "started", task: launched.task ?? task, launched: true };
  return {
    kind: "started",
    task: launched.task ?? deps.tasks.get(task.id) ?? task,
    launched: false,
    reason: launched.error.trim().slice(0, 400) || "the task could not be launched yet",
  };
}

/** The ship kind's default harness when it can load the skill, else the first one that can. */
function testingSetupAgent(deps: TestingSetupDeps): { agent: AgentType } | { problem: string } {
  const preferred = (deps.defaultAgent ?? (() => resolveTaskAgent("ship")))();
  const loaders = skillLoadingAgents();
  const candidates = [preferred, ...loaders.filter((agent) => agent !== preferred)];
  const resolve = deps.skillForAgent ?? skillInvocationForAgent;
  let problem: string | null = null;
  for (const agent of candidates) {
    const resolved = resolve(agent, TESTING_SETUP_SKILL);
    if (resolved.ok) return { agent };
    problem ??= resolved.message;
  }
  return { problem: problem ?? `The ${TESTING_SETUP_SKILL} skill is unavailable.` };
}

function repoLeafName(repoRoot: string): string {
  return repoRoot.split("/").filter(Boolean).pop() ?? repoRoot;
}

/**
 * The `affected-tests` overrides at the repository and in folders below it, as repository-relative
 * paths (`""` is the root), in path order. A stored setup works per app, so it is told about every
 * folder's override, not only the root's.
 */
export function repositoryOverrides(
  repoRoot: string,
  overrides: ReadonlyArray<{ repoRoot: string; command: readonly string[] }>,
): Array<{ path: string; command: readonly string[] }> {
  const prefix = `${repoRoot.replace(/\/+$/, "")}/`;
  return overrides
    .flatMap((entry) => {
      if (entry.repoRoot === repoRoot) return [{ path: "", command: entry.command }];
      if (entry.repoRoot.startsWith(prefix)) {
        return [{ path: entry.repoRoot.slice(prefix.length), command: entry.command }];
      }
      return [];
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The line both intents state their mode in, and the one the skill reads it from. Spelled once
 * so the prompt and the skill's "Choose the mode" section cannot drift apart.
 */
export function testingSetupModeLine(mode: TestingSetupMode): string {
  return `Testing setup mode: ${mode}.`;
}

/**
 * What a committed setup's agent is told. The procedure is the skill's; the intent only names it,
 * the mode and the scope.
 */
export function testingSetupIntent(repoRoot: string, currentCommand: readonly string[] | null): string {
  return [
    `Bring ${repoRoot} into Mission Control's flake-aware testing contract.`,
    "",
    `${testingSetupModeLine("committed")} The human chose to commit the testing configuration:`,
    "the repository gets .mission/testing.json with its CI changes.",
    "",
    currentCommand
      ? `Mission Control's affected-tests Command for this repository is currently: ${currentCommand.join(" ")}`
      : "Mission Control has no affected-tests Command for this repository yet.",
    "",
    `Invoke the ${TESTING_SETUP_SKILL} skill and follow it: it owns the audit, the single`,
    `approval form (${PLAN_DECISIONS_TOOL}), the apply step, and the verification. Change nothing`,
    "the human did not approve in that form. When the audit finds nothing to change, report that",
    "and stop without a commit or pull request.",
    "",
    `Set the repository's affected-tests Command only with ${SET_AFFECTED_TESTS_COMMAND_TOOL},`,
    "and only with the exact template the human approved.",
  ].join("\n");
}

/**
 * What a stored setup's agent is told: the same skill in its stored mode, every current
 * `affected-tests` override at or below the repository, and the one tool its result goes through.
 */
export function storedTestingSetupIntent(
  repoRoot: string,
  current: ReadonlyArray<{ path: string; command: readonly string[] }>,
): string {
  return [
    `Bring ${repoRoot} into Mission Control's flake-aware testing contract without committing a`,
    "testing file.",
    "",
    `${testingSetupModeLine("stored")} The human chose to keep the testing configuration in Mission`,
    "Control: change no file in this repository and make no commit. The affected-tests Commands",
    "and testing settings are stored per folder in Mission Control.",
    "",
    current.length > 0
      ? [
        "Mission Control's affected-tests Commands for this repository are currently:",
        ...current.map((entry) =>
          `- ${entry.path === "" ? "(repository root)" : entry.path}: ${entry.command.join(" ")}`),
      ].join("\n")
      : "Mission Control has no affected-tests Command for this repository or any folder in it yet.",
    "",
    `Invoke the ${TESTING_SETUP_SKILL} skill and follow its stored mode: it owns the audit, the`,
    "Command document and the verification. When the audit finds nothing to change, report that",
    "and stop without a proposal.",
    "",
    `Submit the result only with ${PROPOSE_COMMAND_DOCUMENT_TOOL}, as one Command document. It`,
    "applies nothing: the human reviews it in the preview in Library › Commands and applies or",
    `dismisses it there. Do not call ${SET_AFFECTED_TESTS_COMMAND_TOOL}.`,
  ].join("\n");
}

export type SetAffectedTestsCommandResult =
  | { ok: true; repoRoot: string; view: WorkflowCommandView; replayed: boolean }
  | { ok: false; status: 400 | 403 | 409 | 503; error: string; code?: string };

/**
 * Set the `affected-tests` override for the repository a testing-setup session works on.
 *
 * The scope is decided here, never by the caller: the slot is fixed, and the repository is the
 * `repoRoot` of the task the calling session runs - the main checkout, which is the key an
 * operator's own override for that repository uses - so an override set here is the one the
 * Command editor shows and the one a worktree of that repository resolves. A session that is not
 * running a testing-setup task is refused, and so is a stored-mode one (`TESTING_SETUP_STORED_LABEL`),
 * whose Commands reach the catalog only through the operator's proposal preview, so the tool
 * cannot become a general way for an agent to
 * change what Checks run.
 *
 * Every other override and the slot's default and run budget are carried over unchanged, under
 * the slot's current revision. A concurrent edit is retried once against the new revision rather
 * than overwritten.
 */
export function setAffectedTestsCommand(
  input: { task: Task | undefined; command: string[] },
  manager: Pick<WorkflowCommandManager, "get" | "replace"> | null,
): SetAffectedTestsCommandResult {
  const { task, command } = input;
  if (!task || !task.labels.includes(TESTING_SETUP_TASK_LABEL)) {
    return {
      ok: false,
      status: 403,
      error: `${SET_AFFECTED_TESTS_COMMAND_TOOL} is available only to a session running a `
        + "testing-setup task.",
    };
  }
  if (task.labels.includes(TESTING_SETUP_STORED_LABEL)) {
    return {
      ok: false,
      status: 403,
      error: `${SET_AFFECTED_TESTS_COMMAND_TOOL} is not available to a stored testing setup: propose its `
        + `affected-tests Commands with ${PROPOSE_COMMAND_DOCUMENT_TOOL} for the human to apply.`,
    };
  }
  const problem = commandTemplateProblem("affected-tests", command);
  if (problem) return { ok: false, status: 400, error: problem, code: "workflow_command_invalid_template" };
  if (!manager) return { ok: false, status: 503, error: "Command catalog unavailable" };

  const repoRoot = task.repoRoot;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const view = manager.get("affected-tests");
    if (!view) return { ok: false, status: 503, error: "Command catalog unavailable" };
    const current = view.overrides.find((entry) => entry.repoRoot === repoRoot);
    if (current && sameArgv(current.command, command)) {
      return { ok: true, repoRoot, view, replayed: true };
    }
    const others = view.overrides.filter((entry) => entry.repoRoot !== repoRoot);
    if (others.length + 1 > WORKFLOW_LIMITS.commandOverrides) {
      return { ok: false, status: 409, error: "The affected-tests Command has no room for another repository." };
    }
    const result: WorkflowCommandMutation = manager.replace("affected-tests", {
      expectedRevision: view.revision,
      defaultCommand: view.defaultCommand,
      maxRuns: view.maxRuns,
      overrides: [...others, { repoRoot, command }],
    });
    if (result.ok) return { ok: true, repoRoot, view: result.view, replayed: false };
    if (result.reason !== "revision_conflict") {
      return {
        ok: false,
        status: 409,
        error: result.reason.replaceAll("_", " "),
        code: `workflow_command_${result.reason}`,
      };
    }
  }
  return {
    ok: false,
    status: 409,
    error: "The affected-tests Command changed twice while it was being set. Try again.",
    code: "workflow_command_revision_conflict",
  };
}

function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((arg, index) => arg === b[index]);
}
