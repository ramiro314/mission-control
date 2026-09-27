import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

// Throwaway state dir, set before anything reads config - see tasks-db.test.ts.
const home = mkdtempSync(join(tmpdir(), "mission-shape-this-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { SHAPE_THIS_PATCH } = await import("../src/shared/task.ts");
const { PLAN_VALIDATION_WORKFLOW_ID } = await import("../src/shared/builtin-workflow.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/**
 * "Shape this" on a backlog card is the ordinary kind edit followed by the ordinary dispatch.
 * These pin the edit half: the patch the card sends converts the task to shape and leaves
 * everything the task came with in place - above all its source link, which is what later
 * lets its tickets become sub-issues of the item it was swept from.
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

  const out = await tasks.update("t1", SHAPE_THIS_PATCH);

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
  assert.deepEqual(Object.keys(SHAPE_THIS_PATCH).sort(), ["kind", "workflowId"]);
});
