import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { WorkflowManager } from "../src/server/workflows/manager.ts";
import type { Task } from "../src/shared/types.ts";
import type { WorkflowLaunchBlock } from "../src/shared/workflow.ts";

// Throwaway state dir, set before anything reads config - see tasks-db.test.ts.
const home = mkdtempSync(join(tmpdir(), "mission-shape-this-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { shapeThisPatch } = await import("../src/shared/task.ts");
const { PLAN_VALIDATION_WORKFLOW_ID } = await import("../src/shared/builtin-workflow.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { applySkillsConfig } = await import("../src/server/skills/config.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/**
 * "Shape this" on a backlog card is `POST /api/tasks/:id/shape`: the kind edit and the
 * dispatch in one request, refused before either when the converted task could not launch.
 * The edit converts the task to shape and leaves everything the task came with in place -
 * above all its source link, which is what later lets its tickets become sub-issues of the
 * item it was swept from.
 */

test("Shape this converts a swept task to shape and keeps its source link, labels and dependencies", async () => {
  const r = new Registry();
  const tasks = new TaskManager(r);
  const source = { sourceId: "gh", externalId: "acme/demo#17", url: "https://github.com/acme/demo/issues/17" };
  const dependencies = [{
    type: "source" as const,
    sourceId: "gh",
    externalId: "acme/infra#99",
    url: "https://github.com/acme/infra/issues/99",
    title: "Provision the queue",
    state: "completed" as const,
    checkedAt: 900,
    selectedAt: 900,
    satisfiedAt: 950,
  }];
  r.upsertTask(mkTask({
    id: "t1",
    kind: "ship",
    source,
    labels: ["needs-shaping", "infra"],
    priority: "high",
    dependencies,
    workflowId: null,
  }));

  const out = await tasks.update("t1", shapeThisPatch({}));

  assert.equal(out.ok, true, out.error);
  const stored = r.getTask("t1")!;
  assert.equal(stored.kind, "shape");
  assert.equal(stored.status, "backlog", "the edit converts; the dispatch that follows launches");
  assert.deepEqual(stored.source, source);
  assert.deepEqual(stored.labels, ["needs-shaping", "infra"]);
  assert.equal(stored.priority, "high");
  assert.deepEqual(stored.dependencies, dependencies);
  // The kind's own review, as the dispatch form picks it on a switch to shape.
  assert.equal(stored.workflowId, PLAN_VALIDATION_WORKFLOW_ID);
});

test("the patch names only the kind and its review, so nothing else on the task can move", () => {
  assert.deepEqual(Object.keys(shapeThisPatch({})).sort(), ["kind", "workflowId"]);
});

test("the patch carries the shape row from Settings when one is set", () => {
  assert.deepEqual(shapeThisPatch({ shape: "wf-mine" }), { kind: "shape", workflowId: "wf-mine" });
  assert.deepEqual(shapeThisPatch({ shape: null }), { kind: "shape", workflowId: null });
});

// ---- POST /api/tasks/:id/shape ---------------------------------------------------------

const SOURCE = { sourceId: "gh", externalId: "acme/demo#17", url: "https://github.com/acme/demo/issues/17" };

/** Every call the Workflow gate stub received, as (workflowId, agent, repoRoot). */
type GateCall = [string, string, string];

/**
 * A bare app over one swept backlog task, with launches counted instead of spawned.
 *
 * `gate` is what the stubbed `dispatchWorkflowBlock` answers; `null` for the gate means the
 * daemon has no Workflow manager at all.
 */
function shapeRoute(opts: {
  over?: Partial<Task>;
  gate?: WorkflowLaunchBlock | null | "no-manager";
  extra?: Task[];
} = {}) {
  const registry = new Registry();
  for (const t of opts.extra ?? []) registry.upsertTask(t);
  const tasks = new TaskManager(registry);
  const launched: string[] = [];
  (tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } }).dispatcher.dispatch =
    async (id: string) => void launched.push(id);
  registry.upsertTask(mkTask({
    id: "t1",
    status: "backlog",
    kind: "ship",
    agent: "claude",
    repoRoot: "/repo/demo",
    source: SOURCE,
    labels: ["needs-shaping"],
    priority: "high",
    workflowId: null,
    ...opts.over,
  }));
  const gateCalls: GateCall[] = [];
  const gate = opts.gate ?? null;
  const workflows = gate === "no-manager"
    ? undefined
    : ({
        dispatchWorkflowBlock: (workflowId: string, agent: string, repoRoot: string) => {
          gateCalls.push([workflowId, agent, repoRoot]);
          return gate;
        },
      } as unknown as WorkflowManager);
  const app = buildApp({
    registry,
    reviews: {} as unknown as ReviewManager,
    tasks,
    queues: {} as unknown as QueueManager,
    workflows,
  });
  const shape = async (body: Record<string, unknown> = { overrideDisabled: true }): Promise<Response> =>
    app.request("/api/tasks/t1/shape", {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { registry, launched, gateCalls, shape };
}

/** Enable the three skills a shape dispatch needs, so a refusal comes from the gate under test. */
function enableShapeSkills(): void {
  const synced = applySkillsConfig({ enabled: true, skills: { grill: true, "html-plans": true, tickets: true } });
  assert.deepEqual(synced.problems, []);
}

/** Assert a refused Shape this: 409, the given text, the task untouched and nothing launched. */
async function assertRefusedUnchanged(
  route: ReturnType<typeof shapeRoute>,
  res: Response,
  error: RegExp,
  status = 409,
): Promise<void> {
  assert.equal(res.status, status);
  assert.match(((await res.json()) as { error: string }).error, error);
  assert.deepEqual(route.launched, []);
}

test("a refused Shape this changes nothing and returns the dispatch's refusal", async () => {
  applySkillsConfig({ enabled: true, skills: { grill: false, "html-plans": true, tickets: true } });
  const route = shapeRoute();
  const before = route.registry.getTask("t1")!;

  const res = await route.shape();

  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /Enable Skills and the grill skill/);
  assert.match(body.error, /A shape task's intent invokes the planning skills/);
  assert.deepEqual(route.registry.getTask("t1"), before, "the task is exactly as it was");
  assert.deepEqual(route.launched, []);
});

test("a Shape this the shape review's Workflow gate refuses changes nothing", async () => {
  enableShapeSkills();
  const route = shapeRoute({ gate: { message: "Live delivery is not allowed for this repository." } });
  const before = route.registry.getTask("t1")!;

  const res = await route.shape();

  await assertRefusedUnchanged(route, res, /^Live delivery is not allowed for this repository\.$/);
  assert.deepEqual(route.registry.getTask("t1"), before, "the task is exactly as it was");
  // Asked of the review the CONVERTED task would carry, not the task's current (null) one.
  assert.deepEqual(route.gateCalls, [[PLAN_VALIDATION_WORKFLOW_ID, "claude", "/repo/demo"]]);
});

test("a Shape this with no Workflow manager to ask is refused with 503 and changes nothing", async () => {
  enableShapeSkills();
  const route = shapeRoute({ gate: "no-manager" });
  const before = route.registry.getTask("t1")!;

  const res = await route.shape();

  await assertRefusedUnchanged(route, res, /Workflow manager unavailable/, 503);
  assert.deepEqual(route.registry.getTask("t1"), before);
});

test("a task that has left the backlog cannot be shaped", async () => {
  enableShapeSkills();
  const route = shapeRoute({ over: { status: "running" } });
  const before = route.registry.getTask("t1")!;

  const res = await route.shape();

  await assertRefusedUnchanged(route, res, /^task is running, not in the backlog$/);
  assert.deepEqual(route.registry.getTask("t1"), before);
  assert.deepEqual(route.gateCalls, [], "refused before any Workflow gate is asked");
});

test("a Shape this on a task waiting on a dependency changes nothing", async () => {
  enableShapeSkills();
  const prerequisite = mkTask({ id: "t0", title: "Lay the base", status: "backlog" });
  const route = shapeRoute({
    extra: [prerequisite],
    over: {
      dependencies: [{
        type: "task",
        taskId: "t0",
        title: "Lay the base",
        sessionId: null,
        episodeId: null,
        agentSessionId: null,
        branch: null,
        prUrl: null,
        selectedAt: null,
        satisfiedAt: null,
      }],
    },
  });
  const before = route.registry.getTask("t1")!;

  const res = await route.shape();

  await assertRefusedUnchanged(route, res, /^task is waiting on Lay the base$/);
  assert.deepEqual(route.registry.getTask("t1"), before);
});

test("a parked task is refused unless the caller overrides the hold, and changes nothing", async () => {
  enableShapeSkills();
  const route = shapeRoute({ over: { enabled: false } });
  const before = route.registry.getTask("t1")!;

  const res = await route.shape({ overrideDisabled: false });

  await assertRefusedUnchanged(route, res, /^task is disabled - Foreman will not schedule it/);
  assert.deepEqual(route.registry.getTask("t1"), before);
});

test("an accepted Shape this converts the task to shape, keeps its source link, and dispatches it", async () => {
  enableShapeSkills();
  const { registry, launched, gateCalls, shape } = shapeRoute();

  const res = await shape();

  assert.equal(res.status, 200, await res.clone().text());
  const stored = registry.getTask("t1")!;
  assert.equal(stored.kind, "shape");
  assert.equal(stored.workflowId, PLAN_VALIDATION_WORKFLOW_ID);
  assert.deepEqual(stored.source, SOURCE);
  assert.deepEqual(stored.labels, ["needs-shaping"]);
  assert.equal(stored.priority, "high");
  assert.deepEqual(launched, ["t1"]);
  assert.deepEqual(gateCalls, [[PLAN_VALIDATION_WORKFLOW_ID, "claude", "/repo/demo"]]);
});
