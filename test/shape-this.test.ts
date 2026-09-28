import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { WorkflowManager } from "../src/server/workflows/manager.ts";

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

/** A bare app over one swept backlog task, with launches counted instead of spawned. */
function shapeRoute() {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const launched: string[] = [];
  (tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } }).dispatcher.dispatch =
    async (id: string) => void launched.push(id);
  registry.upsertTask(mkTask({
    id: "t1",
    status: "backlog",
    kind: "ship",
    agent: "claude",
    source: SOURCE,
    labels: ["needs-shaping"],
    priority: "high",
    workflowId: null,
  }));
  const app = buildApp({
    registry,
    reviews: {} as unknown as ReviewManager,
    tasks,
    queues: {} as unknown as QueueManager,
    workflows: { dispatchWorkflowBlock: () => null } as unknown as WorkflowManager,
  });
  const shape = async (): Promise<Response> =>
    app.request("/api/tasks/t1/shape", {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify({ overrideDisabled: true }),
    });
  return { registry, launched, shape };
}

test("a refused Shape this changes nothing and returns the dispatch's refusal", async () => {
  applySkillsConfig({ enabled: true, skills: { grill: false, "html-plans": true, tickets: true } });
  const { registry, launched, shape } = shapeRoute();
  const before = registry.getTask("t1")!;

  const res = await shape();

  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /Enable Skills and the grill skill/);
  assert.match(body.error, /A shape task's intent invokes the planning skills/);
  assert.deepEqual(registry.getTask("t1"), before, "the task is exactly as it was");
  assert.deepEqual(launched, []);
});

test("an accepted Shape this converts the task to shape, keeps its source link, and dispatches it", async () => {
  const synced = applySkillsConfig({ enabled: true, skills: { grill: true, "html-plans": true, tickets: true } });
  assert.deepEqual(synced.problems, []);
  const { registry, launched, shape } = shapeRoute();

  const res = await shape();

  assert.equal(res.status, 200, await res.clone().text());
  const stored = registry.getTask("t1")!;
  assert.equal(stored.kind, "shape");
  assert.equal(stored.workflowId, PLAN_VALIDATION_WORKFLOW_ID);
  assert.deepEqual(stored.source, SOURCE);
  assert.deepEqual(stored.labels, ["needs-shaping"]);
  assert.equal(stored.priority, "high");
  assert.deepEqual(launched, ["t1"]);
});
