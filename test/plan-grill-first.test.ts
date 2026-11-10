import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { AgentType } from "../src/shared/types.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";

// Throwaway state dir, set before anything reads config - see tasks-db.test.ts.
const home = mkdtempSync(join(tmpdir(), "mission-plan-grill-first-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager, resolveGrillFirstPin } = await import("../src/server/tasks.ts");
const { applySkillsConfig } = await import("../src/server/skills/config.ts");
const { getTask } = await import("../src/server/db.ts");
const { planGrillsFirst } = await import("../src/shared/task.ts");
const { PLAN_APPENDIX_MARKER, PLAN_GRILL_SKILL_ID, planContractAppendix } = await import("../src/server/plans/prompt.ts");
const { planDispatchBlock, planningSkillsForAgent } = await import("../src/server/plans/skills.ts");
const { PLAN_DECISIONS_TOOL } = await import("../src/server/plans/tools.ts");
const { withTaskKindContract } = await import("../src/server/task-contract.ts");
const { buildApp } = await import("../src/server/routes.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/**
 * Grill me first, as a behavior of the Plan kind: a plan task pinned with it interviews the
 * human with the `grill` skill before drafting, then runs the plan contract it always had.
 * Off, the contract is byte for byte the one a plan task got before the setting existed.
 */

const SKILLS = { htmlPlans: "/html-plans", phasedPlan: "/phased-plan" };
const GRILLING = { ...SKILLS, grill: "/grill" };

/** Every skill on, rendered the way Claude spells an invocation. */
const allOn = (_agent: AgentType, id: string) => ({ ok: true as const, command: `/${id}` });

test("off, a plan contract is exactly the one it was, whatever invocations are handed in", () => {
  for (const storage of ["repository", "local"] as const) {
    const before = planContractAppendix(SKILLS, false, storage);
    assert.equal(planContractAppendix(GRILLING, false, storage, false), before);
    assert.doesNotMatch(before, /Grill me first|\/grill/);
  }
});

test("on, the interview comes first and the plan flow after it is unchanged", () => {
  for (const storage of ["repository", "local"] as const) {
    const off = planContractAppendix(SKILLS, false, storage);
    const on = planContractAppendix(GRILLING, false, storage, true);
    assert.ok(on.startsWith(PLAN_APPENDIX_MARKER), storage);
    const step = on.indexOf("\nGrill me first. Before anything below");
    const grill = on.indexOf("\n/grill\n");
    const htmlPlans = on.indexOf("/html-plans");
    assert.ok(step > 0 && step < grill && grill < htmlPlans, `${storage}: the grill skill is invoked before html-plans`);
    assert.match(on, new RegExp(`Every round is one \`${PLAN_DECISIONS_TOOL}\` form`));
    assert.match(on, /Ask at least one round/);
    assert.match(on, /A dismissed round ends the work: draft no plan/);
    // Forms with nothing preselected are the case it must survive: no answer is assumed.
    assert.match(on, /may open with nothing selected/);
    assert.match(on, /never\nyour recommendation or an unanswered question/);
    assert.match(on, /offer no phased implementation\nfollow-up in them/);
    // Every line of the plan contract still follows, the phased follow-up included.
    for (const line of off.split("\n").slice(1)) assert.ok(on.includes(line), `${storage}: kept "${line}"`);
    assert.match(on, /phased implementation follow-up once per root plan/);
  }
});

test("a grilling contract without its invocation is refused, not delivered with a hole", () => {
  assert.throws(() => planContractAppendix(SKILLS, false, "repository", true), /grill skill invocation/);
});

test("only a plan task pinned on grills first; shape grills on its own terms", () => {
  assert.equal(planGrillsFirst(mkTask({ kind: "plan", grillFirst: true })), true);
  assert.equal(planGrillsFirst(mkTask({ kind: "plan", grillFirst: false })), false);
  assert.equal(planGrillsFirst(mkTask({ kind: "plan" })), false, "a row from before the pin is off");
  assert.equal(planGrillsFirst(mkTask({ kind: "shape", grillFirst: true })), false);
  assert.equal(planGrillsFirst(mkTask({ kind: "ship", grillFirst: true })), false);
});

test("the gate resolves grill first, and refuses a grilling plan whose grill skill is off", () => {
  assert.deepEqual(planningSkillsForAgent("claude", { kind: "plan", grillFirst: true }, allOn), {
    ok: true,
    commands: GRILLING,
  });
  assert.deepEqual(planningSkillsForAgent("claude", { kind: "plan" }, allOn), { ok: true, commands: SKILLS });

  const grillOff = (agent: AgentType, id: string) =>
    id === PLAN_GRILL_SKILL_ID ? { ok: false as const, message: "Enable the grill skill." } : allOn(agent, id);
  const refused = planDispatchBlock(mkTask({ kind: "plan", grillFirst: true }), grillOff);
  assert.match(refused ?? "", /^Enable the grill skill\. A plan task's intent invokes the planning skills/);
  assert.equal(planDispatchBlock(mkTask({ kind: "plan", grillFirst: false }), grillOff), null, "off needs no grill");
});

test("delivery composes the grilling contract only for a task pinned on", () => {
  const on = mkTask({ kind: "plan", grillFirst: true });
  assert.match(withTaskKindContract(on, on.intent, { planSkills: GRILLING }), /Grill me first\./);
  const off = mkTask({ kind: "plan", grillFirst: false });
  assert.doesNotMatch(withTaskKindContract(off, off.intent, { planSkills: GRILLING }), /Grill me first/);
  assert.throws(() => withTaskKindContract(on, on.intent, { planSkills: SKILLS }), /grill skill invocation/);
});

test("creation pins the Settings default, a dispatch overrides it, and a later change moves nothing", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const create = (kind: "plan" | "ship", grillFirst?: boolean) =>
    tasks.create({ repoRoot: "/repos/demo", intent: "plan it", title: `${kind} ${String(grillFirst)}`, kind, grillFirst, backlog: true });

  applySkillsConfig({ planGrillFirst: false });
  assert.equal(create("plan").grillFirst, false);
  assert.equal(create("plan", true).grillFirst, true, "the dispatch form turns it on for one task");

  applySkillsConfig({ planGrillFirst: true });
  const defaulted = create("plan");
  assert.equal(defaulted.grillFirst, true);
  assert.equal(create("plan", false).grillFirst, false, "the dispatch form turns it off for one task");
  assert.equal(create("ship", true).grillFirst, false, "no other kind grills first");

  // Durable, and pinned: the row reads back as filed after the default moves.
  applySkillsConfig({ planGrillFirst: false });
  assert.equal(getTask(defaulted.id)?.grillFirst, true);
});

test("an edit changes the pin, and a switch into plan pins the default then", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  applySkillsConfig({ planGrillFirst: false });
  const plan = tasks.create({ repoRoot: "/repos/demo", intent: "plan it", title: "Edit me", kind: "plan", backlog: true });

  const turnedOn = await tasks.update(plan.id, { grillFirst: true });
  assert.equal(turnedOn.ok, true, turnedOn.error);
  assert.equal(getTask(plan.id)?.grillFirst, true);
  const retitled = await tasks.update(plan.id, { title: "Renamed" });
  assert.equal(retitled.ok, true, retitled.error);
  assert.equal(getTask(plan.id)?.grillFirst, true, "an unrelated edit keeps the pin");

  applySkillsConfig({ planGrillFirst: true });
  const ship = tasks.create({ repoRoot: "/repos/demo", intent: "build it", title: "Becomes a plan", kind: "ship", backlog: true });
  assert.equal(ship.grillFirst, false);
  const switched = await tasks.update(ship.id, { kind: "plan" });
  assert.equal(switched.ok, true, switched.error);
  assert.equal(getTask(ship.id)?.grillFirst, true);

  // Off plan the column holds 0, by edit as by creation: a switch out clears it, a pin named
  // for a non-plan task is not stored, and an explicit off on the way back in is kept.
  const out = await tasks.update(ship.id, { kind: "ship" });
  assert.equal(out.ok, true, out.error);
  assert.equal(getTask(ship.id)?.grillFirst, false);
  const named = await tasks.update(ship.id, { grillFirst: true });
  assert.equal(named.ok, true, named.error);
  assert.equal(getTask(ship.id)?.grillFirst, false);
  const back = await tasks.update(ship.id, { kind: "plan", grillFirst: false });
  assert.equal(back.ok, true, back.error);
  assert.equal(getTask(ship.id)?.grillFirst, false, "the named choice beats the default on the way in");
});

test("one rule resolves the pin for creation and edits alike", () => {
  applySkillsConfig({ planGrillFirst: true });
  const plan = (grillFirst: boolean) => mkTask({ kind: "plan", grillFirst });
  assert.equal(resolveGrillFirstPin("ship", true), false, "off plan, nothing is pinned");
  assert.equal(resolveGrillFirstPin("shape", undefined), false);
  assert.equal(resolveGrillFirstPin("plan", false), false, "a named choice wins");
  assert.equal(resolveGrillFirstPin("plan", undefined), true, "a new plan takes the default");
  assert.equal(resolveGrillFirstPin("plan", undefined, mkTask({ kind: "ship" })), true, "entering plan takes the default");
  assert.equal(resolveGrillFirstPin("plan", undefined, plan(false)), false, "a plan keeps its pin");
  assert.equal(resolveGrillFirstPin("ship", undefined, plan(true)), false, "leaving plan clears it");
  applySkillsConfig({ planGrillFirst: false });
  assert.equal(resolveGrillFirstPin("plan", undefined, plan(true)), true, "a later default moves no plan");
});

/**
 * The dispatch route's own refusal, which the form shows: an immediate plan dispatch that
 * will grill first is refused with 409 when the grill skill is off, and that includes a
 * dispatch that names nothing and takes Grill me first from the Settings default.
 */
test("an immediate plan dispatch that grills first is refused at the route when the grill skill is off", async () => {
  const repo = join(home, "dispatch-repo");
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "initial"]);
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const launched: string[] = [];
  (tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } }).dispatcher.dispatch =
    async (id: string) => void launched.push(id);
  const app = buildApp({
    registry,
    reviews: {} as unknown as ReviewManager,
    tasks,
    queues: {} as unknown as QueueManager,
  });
  // After work None keeps the Workflow gate out of it, so a refusal is the skill gate's.
  const dispatch = async (title: string, grillFirst?: boolean): Promise<Response> =>
    app.request("/api/tasks", {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify({ repoRoot: repo, intent: "Plan archive exports", title, kind: "plan", agent: "claude", workflowId: null, grillFirst }),
    });

  const synced = applySkillsConfig({
    enabled: true,
    planGrillFirst: true,
    skills: { grill: false, "html-plans": true, "phased-plan": true },
  });
  assert.deepEqual(synced.problems, []);
  const filedBefore = registry.listTasks().length;

  // Grill me first from the Settings default, named nowhere in the request.
  const refused = await dispatch("From the default");
  assert.equal(refused.status, 409);
  const error = ((await refused.json()) as { error: string }).error;
  assert.match(error, /Enable Skills and the grill skill/);
  assert.match(error, /Settings → Skills/);
  // Named on the request, with the default off.
  applySkillsConfig({ planGrillFirst: false });
  assert.equal((await dispatch("Named on the form", true)).status, 409);
  assert.equal(registry.listTasks().length, filedBefore, "a refusal files nothing");
  assert.deepEqual(launched, []);

  // The same dispatch with Grill me first off passes the gate: the grill skill is not needed.
  applySkillsConfig({ planGrillFirst: true });
  const accepted = await dispatch("Overridden off", false);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const task = (await accepted.json()) as { id: string; grillFirst: boolean; status: string };
  assert.equal(task.grillFirst, false);
  assert.equal(task.status, "dispatching");
  assert.deepEqual(launched, [task.id]);
});
