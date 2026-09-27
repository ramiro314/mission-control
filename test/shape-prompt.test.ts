import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PLAN_PAGE_FILENAME, PLAN_SOURCE_PATH_SHAPE } from "../src/shared/plans.ts";
import { skillCommand } from "../src/shared/harness-capabilities.ts";
import type { SkillsConfig } from "../src/shared/protocol.ts";
import type { Task } from "../src/shared/types.ts";
import { MISSION_MCP_TOOLS, kindMissionMcpRequirement } from "../src/server/mission-mcp.ts";
import { PLAN_APPENDIX_MARKER, PLAN_HTML_SKILL_ID } from "../src/server/plans/prompt.ts";
import {
  SHAPE_APPENDIX_MARKER,
  SHAPE_FOLLOW_UP_DECISION_ID,
  SHAPE_GRILL_SKILL_ID,
  shapeContractAppendix,
} from "../src/server/plans/shape.ts";
import {
  PLANNING_SKILLS,
  planDispatchBlock,
  planningSkillsForAgent,
  planningSkillsForSession,
} from "../src/server/plans/skills.ts";
import { PLAN_DECISIONS_TOOL, PLAN_PUBLICATION_TOOL, PLAN_SCHEDULING_TOOL } from "../src/server/plans/tools.ts";
import {
  requiredSkillCommand,
  skillInvocationForAgent,
  type RequiredSkillCommandDeps,
} from "../src/server/skills/invoke.ts";
import { noteKeyFor } from "../src/server/registry.ts";
import { withTaskKindContract } from "../src/server/task-contract.ts";
import { mkSession } from "./helpers/session-fixture.ts";

/**
 * What a shape task is told, and when it is refused.
 *
 * A shape task grills first and plans second. Its contract points at the bundled `grill`
 * skill and at `html-plans`, so both are launch requirements exactly as plan's two skills
 * are; and it replaces html-plans' phased follow-up with Create tickets / Stop.
 */

const src = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Shape the export feature",
    intent: "Shape how exports should work.",
    kind: "shape",
    agent: "claude",
    priority: null,
    labels: [],
    dependencies: [],
    enabled: true,
    model: null,
    effort: null,
    workflowId: null,
    source: null,
    repoRoot: "/repos/demo",
    worktreePath: "/work/demo",
    status: "running",
    extraRepos: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Task;
}

const CLAUDE_SKILLS = { grill: "/grill", htmlPlans: "/html-plans" };

/** The shape kind's skills, read from the one table that owns them. */
const SHAPE_SKILL_IDS: string[] = Object.values(PLANNING_SKILLS.shape);

const config: SkillsConfig = {
  enabled: true,
  defaultSkillEnabled: false,
  skills: Object.fromEntries(SHAPE_SKILL_IDS.map((id) => [id, true])),
  generation: 3,
  generationAt: 100,
};

function deps(over: Partial<RequiredSkillCommandDeps> = {}): RequiredSkillCommandDeps {
  return {
    config: () => config,
    catalog: () => ({
      readable: true,
      skills: SHAPE_SKILL_IDS.map((id) => ({
        id,
        name: id,
        description: `The ${id} procedure`,
        category: "planning" as const,
        enforcement: "triggered" as const,
      })),
      present: new Set<string>(SHAPE_SKILL_IDS),
      problems: [],
    }),
    acks: () => new Map(),
    installProblem: () => null,
    command: skillCommand,
    ...over,
  };
}

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------
// The contract text
// ---------------------------------------------------------------------------

test("a shape task gets the shape contract after its intent, and never the plan one", () => {
  const task = mkTask();
  const delivered = withTaskKindContract(task, task.intent, { planSkills: CLAUDE_SKILLS });
  assert.ok(delivered.startsWith(task.intent));
  assert.ok(delivered.indexOf(SHAPE_APPENDIX_MARKER) > task.intent.length - 1);
  assert.ok(!delivered.includes(PLAN_APPENDIX_MARKER));

  const plan = mkTask({ kind: "plan" });
  const planDelivered = withTaskKindContract(plan, plan.intent, {
    planSkills: { htmlPlans: "/html-plans", phasedPlan: "/phased-plan" },
  });
  assert.ok(!planDelivered.includes(SHAPE_APPENDIX_MARKER), "the plan kind is unchanged");
});

test("the contract grills before html-plans, and never skips the interview", () => {
  const appendix = shapeContractAppendix(CLAUDE_SKILLS);
  const grill = appendix.indexOf("/grill");
  const html = appendix.indexOf("/html-plans");
  assert.ok(grill > 0 && html > grill, "grill is invoked first, html-plans after");
  assert.match(appendix, /at least one round, even when the\s+request already looks complete/);
  assert.match(appendix, /until nothing is left to ask/);
  assert.match(appendix, new RegExp(`Every round is one \`${escape(PLAN_DECISIONS_TOOL)}\` form`));
  assert.match(appendix, /A dismissed round ends the work\. Do not draft a plan/);
  assert.match(appendix, /never read a dismissal back as a selection/);
  assert.match(appendix, new RegExp(escape(PLAN_SOURCE_PATH_SHAPE)));
  assert.match(appendix, new RegExp(escape(PLAN_PAGE_FILENAME)));
  assert.match(appendix, /not a change/);
});

test("the plan review's follow-up is Create tickets / Stop, replacing the phased follow-up", () => {
  const appendix = shapeContractAppendix(CLAUDE_SKILLS);
  assert.match(appendix, new RegExp(SHAPE_FOLLOW_UP_DECISION_ID));
  assert.match(appendix, /`create-tickets` \(Create tickets, recommended\) and `stop` \(Stop\)/);
  assert.match(appendix, /replaces the skill's phased\s+implementation follow-up/);
  assert.ok(!appendix.includes("/phased-plan"), "a shape task is never told to phase");
});

test("a shape task takes the plan's completion handoff when a workflow is bound", () => {
  const bound = withTaskKindContract(mkTask({ workflowId: "wf" }), "shape it", { planSkills: CLAUDE_SKILLS });
  assert.match(bound, /## Shape task completion handoff/);
  assert.match(bound, /the human has reviewed and approved the plan/);
  assert.match(bound, /do not create or update a pull request, act on pull-request review feedback, wait for pull-request CI, or merge the pull request/);
  assert.match(bound, new RegExp(PLAN_PUBLICATION_TOOL));

  const unbound = withTaskKindContract(mkTask(), "shape it", { planSkills: CLAUDE_SKILLS });
  assert.doesNotMatch(unbound, /## Shape task completion handoff/);
  assert.match(unbound, /No workflow was selected/);
});

test("a shape task delivered without resolved invocations fails loudly", () => {
  assert.throws(
    () => withTaskKindContract(mkTask(), "shape it"),
    /without resolved planning-skill invocations/,
  );
});

test("the bundled grill skill asks rounds the way the contract promises", () => {
  const skill = src(`skills/${SHAPE_GRILL_SKILL_ID}/SKILL.md`);
  assert.match(skill, new RegExp(`^---\\nname: ${SHAPE_GRILL_SKILL_ID}\\n`));
  assert.match(skill, new RegExp(escape(PLAN_DECISIONS_TOOL)));
  assert.match(skill, /`recommended: true`/);
  assert.match(skill, /`allowOther: true` on \*\*every\*\* decision/);
  assert.match(skill, /Grilling is never skipped/);
  assert.match(skill, /\*\*Dismissed:\*\* stop the session/);
  // Credited, and standalone: it must not lean on the mattpocock-skills plugin being installed.
  assert.match(skill, /Matt Pocock/);
  assert.match(skill, /MIT License/);
  assert.doesNotMatch(skill, /mattpocock-skills:/);
  assert.match(src("NOTICE"), /skills\/grill[\s\S]*Copyright \(c\) 2026 Matt Pocock/);
});

// ---------------------------------------------------------------------------
// The launch: tools and the skill gate
// ---------------------------------------------------------------------------

test("every shape launch pre-approves the tools its prompt names", () => {
  const appendix = shapeContractAppendix(CLAUDE_SKILLS);
  for (const tool of [PLAN_DECISIONS_TOOL, PLAN_PUBLICATION_TOOL]) {
    assert.ok(appendix.includes(tool), `the prompt names ${tool}`);
  }
  const required = kindMissionMcpRequirement(mkTask(), null);
  const expected = [PLAN_DECISIONS_TOOL, PLAN_SCHEDULING_TOOL, PLAN_PUBLICATION_TOOL];
  for (const tool of expected) assert.ok(([...MISSION_MCP_TOOLS] as string[]).includes(tool));
  assert.deepEqual([...(required?.tools ?? [])].sort(), [...expected].sort());
});

test("dispatch is refused, naming the toggle, when either shape skill is off", () => {
  for (const off of SHAPE_SKILL_IDS) {
    const block = planDispatchBlock(mkTask(), (_agent, id) =>
      id === off
        ? { ok: false, message: `Enable Skills and the ${id} skill before sending this instruction.` }
        : { ok: true, command: `/${id}` });
    assert.ok(block, `a shape dispatch without ${off} is refused`);
    assert.match(block, new RegExp(`Enable Skills and the ${off} skill`));
    assert.match(block, /A shape task's intent invokes the planning skills/);
    assert.match(block, /Settings → Skills/);
  }
  // A shape task does not need phased-plan: only its own two skills are asked for.
  const asked: string[] = [];
  planDispatchBlock(mkTask(), (_agent, id) => {
    asked.push(id);
    return { ok: true, command: `/${id}` };
  });
  assert.deepEqual(asked, [SHAPE_GRILL_SKILL_ID, PLAN_HTML_SKILL_ID]);
});

test("the launch resolver renders each harness's own invocation", () => {
  const forAgent: typeof skillInvocationForAgent = (agent, id) => skillInvocationForAgent(agent, id, deps());
  assert.deepEqual(planningSkillsForAgent("claude", "shape", forAgent), { ok: true, commands: CLAUDE_SKILLS });
  assert.deepEqual(planningSkillsForAgent("pi", "shape", forAgent), {
    ok: true,
    commands: { grill: "/skill:grill", htmlPlans: "/skill:html-plans" },
  });
  const off = planningSkillsForAgent("claude", "shape", (agent, id) =>
    skillInvocationForAgent(agent, id, deps({ config: () => ({ ...config, enabled: false }) })));
  assert.equal(off.ok, false);
});

test("the assignment resolver refuses a session still holding the previous skill set", () => {
  const stale = mkSession({ agent: "claude", startedAt: 1 });
  const forSession = (over: Partial<RequiredSkillCommandDeps> = {}): typeof requiredSkillCommand =>
    (session, id) => requiredSkillCommand(session, id, deps(over));
  const refused = planningSkillsForSession(stale, "shape", forSession());
  assert.equal(refused.ok, false);
  const current = planningSkillsForSession(stale, "shape", forSession({
    acks: () => new Map([[noteKeyFor(stale), config.generation]]),
  }));
  assert.deepEqual(current, { ok: true, commands: CLAUDE_SKILLS });
});

test("each delivery seam resolves planning skills through the one shared resolver", () => {
  // Plan and shape share one resolve-or-refuse path per seam, keyed by the task's kind.
  const dispatcher = src("src/server/dispatcher.ts");
  assert.match(dispatcher, /planningSkillsForAgent\)\(task\.agent, task\.kind\)/);
  assert.ok(!dispatcher.includes("planningSkillsForSession"));
  const tasks = src("src/server/tasks.ts");
  assert.match(tasks, /planningSkillsForSession\)\(s, t\.kind\)/);
  assert.ok(!tasks.includes("planningSkillsForAgent"));
});

test("one table names every planning kind's skills, and a kind's invocations never satisfy another", () => {
  assert.deepEqual(Object.keys(PLANNING_SKILLS).sort(), ["plan", "shape"]);
  assert.deepEqual(Object.values(PLANNING_SKILLS.shape), [SHAPE_GRILL_SKILL_ID, PLAN_HTML_SKILL_ID]);
  // A shape task handed plan's invocations is refused rather than delivered with a hole in it.
  assert.throws(
    () => withTaskKindContract(mkTask(), "shape it", {
      planSkills: { htmlPlans: "/html-plans", phasedPlan: "/phased-plan" },
    }),
    /shape task t1 reached delivery without resolved planning-skill invocations/,
  );
});
