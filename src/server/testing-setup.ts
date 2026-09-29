// The "Set up flake-aware testing" repository action, and the one Command write its agent may make.
//
// Two halves of one supervised task. `startTestingSetup` files and launches a ship task whose
// intent invokes the `testing-setup` skill; the skill audits the repository, asks the human in
// one decision form, and applies only what was approved. `setAffectedTestsCommand` is how the
// approved `affected-tests` template reaches Mission Control: a machine-local Command override,
// written through the same `WorkflowCommandManager.replace` the Command editor's route uses.
import type { AgentType, Task } from "@shared/types.ts";
import type { TestingSetupStartResponse } from "@shared/protocol.ts";
import { WORKFLOW_LIMITS, commandTemplateProblem, type WorkflowCommandView } from "@shared/workflow.ts";
import { TESTING_SETUP_SKILL } from "@shared/skills.ts";
import { skillLoadingAgents } from "@shared/harness-capabilities.ts";
import { PLAN_DECISIONS_TOOL } from "./plans/tools.ts";
import { resolveTaskAgent } from "./harnesses.ts";
import { resolveTaskRepoRoot } from "./repos.ts";
import { skillInvocationForAgent } from "./skills/invoke.ts";
import { MANUAL_DISPATCH_TASK_CREATE, type TaskManager } from "./tasks.ts";
import { SET_AFFECTED_TESTS_COMMAND_TOOL, TESTING_SETUP_TASK_LABEL } from "./testing-setup-tool.ts";
import type { WorkflowCommandManager, WorkflowCommandMutation } from "./workflows/commands.ts";

export type TestingSetupResult =
  | ({ kind: "started" } & TestingSetupStartResponse)
  | { kind: "refused"; status: 400 | 409; error: string };

export interface TestingSetupDeps {
  tasks: Pick<TaskManager, "create" | "dispatch" | "get">;
  resolveRepoRoot?: typeof resolveTaskRepoRoot;
  skillForAgent?: typeof skillInvocationForAgent;
  /** The ship kind's default harness; injected so a test does not read the Harnesses config. */
  defaultAgent?: () => AgentType;
  /** The Command catalog, read only to tell the agent the repository's current template. */
  commands?: Pick<WorkflowCommandManager, "get"> | null;
}

/**
 * File the testing-setup task for one repository and launch it.
 *
 * Gated on the skill FIRST, for retro's reason: the skill is where the one approval form and
 * "apply only what was approved" live, so a task that reached an agent without it would edit CI
 * on the strength of a sentence in its intent. The refusal is the resolver's own sentence, so it
 * names the toggle exactly as the retro refusal does.
 *
 * `workflowId: null`, deliberately. The skill owns its pull request and proves the setup on that
 * pull request's own CI while the session is still open, and the human has already approved every
 * change in the decision form. A review workflow bound on top would hold the pull request behind
 * Personas and Checks the approval form already answered, and on a repository with no
 * `affected-tests` Command yet its gate could not run anyway.
 */
export async function startTestingSetup(
  repoRoot: string,
  deps: TestingSetupDeps,
): Promise<TestingSetupResult> {
  const resolved = await (deps.resolveRepoRoot ?? resolveTaskRepoRoot)(repoRoot);
  if (!resolved.ok) return { kind: "refused", status: 400, error: resolved.error };

  const runner = testingSetupAgent(deps);
  if ("problem" in runner) {
    return {
      kind: "refused",
      status: 409,
      error: `${runner.problem} A testing setup task started now would reach an agent that cannot `
        + "load the procedure its intent names.",
    };
  }

  const task = deps.tasks.create(
    {
      repoRoot: resolved.repoRoot,
      extraRepoRoots: [],
      title: `Set up flake-aware testing: ${repoLeafName(resolved.repoRoot)}`.slice(0, 120),
      intent: testingSetupIntent(
        resolved.repoRoot,
        deps.commands?.get("affected-tests")?.overrides
          .find((entry) => entry.repoRoot === resolved.repoRoot)?.command ?? null,
      ),
      kind: "ship",
      agent: runner.agent,
      workflowId: null,
      backlog: true,
      labels: [TESTING_SETUP_TASK_LABEL],
    },
    undefined,
    MANUAL_DISPATCH_TASK_CREATE,
  );
  // The decision form and the Command write are named in the intent, so the launch pre-approves
  // both; a tool the prompt names but the launch did not approve stops on a permission prompt.
  const launched = await deps.tasks.dispatch(task.id, {
    missionMcp: { tools: [PLAN_DECISIONS_TOOL, SET_AFFECTED_TESTS_COMMAND_TOOL] },
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

/** What the agent is told. The procedure is the skill's; the intent only names it and the scope. */
export function testingSetupIntent(repoRoot: string, currentCommand: readonly string[] | null): string {
  return [
    `Bring ${repoRoot} into Mission Control's flake-aware testing contract.`,
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
 * running a testing-setup task is refused, so the tool cannot become a general way for an agent to
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
