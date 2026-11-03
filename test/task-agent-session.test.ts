import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `Task.agentSessionId` links a finished task to its session in History, so it has to survive
// the current binding being replaced: a session that moves on to another task deletes this
// task's current row and leaves only the historical one.

const home = mkdtempSync(join(tmpdir(), "mission-task-agent-session-"));
process.env.MISSION_HOME = home;

const { bindTaskWorkEpisode, getTask, listTasks, upsertTask } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { AGENT_TYPES } = await import("../src/shared/types.ts");
const { HARNESS_CAPABILITIES } = await import("../src/shared/harness-capabilities.ts");
const { HARNESSES } = await import("../src/server/harness/index.ts");
const { taskHistoryHref } = await import("../src/web/lib/open-task.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";
const AGENT_C = "33333333-3333-4333-8333-333333333333";

function binding(over: { taskId: string; episodeId: string; sessionId: string; agentSessionId: string; boundAt: number }) {
  return {
    ...over,
    branch: null,
    prUrl: `https://github.example/o/r/pull/${over.episodeId}`,
    prHeadSha: null,
    mergedAt: null,
    updatedAt: over.boundAt,
  };
}

function agentSessionOf(taskId: string): string | null {
  const single = getTask(taskId)?.agentSessionId ?? null;
  const batch = listTasks().find((task) => task.id === taskId)?.agentSessionId ?? null;
  assert.equal(batch, single, "listTasks and getTask must read the same binding");
  return single;
}

test("a task with no work episode binding has no agent session", () => {
  upsertTask(mkTask({ id: "unbound", status: "done" }));
  assert.equal(agentSessionOf("unbound"), null);
});

test("the current binding names the agent session", () => {
  upsertTask(mkTask({ id: "current", status: "done" }));
  bindTaskWorkEpisode(binding({ taskId: "current", episodeId: "c1", sessionId: "s-current", agentSessionId: AGENT_A, boundAt: 100 }));
  assert.equal(agentSessionOf("current"), AGENT_A);
});

test("the current binding wins over a newer historical one", () => {
  upsertTask(mkTask({ id: "rolled", status: "done" }));
  bindTaskWorkEpisode(binding({ taskId: "rolled", episodeId: "r1", sessionId: "s-rolled", agentSessionId: AGENT_B, boundAt: 100 }));
  // A rollover archives r1 and makes r2 current.
  bindTaskWorkEpisode(binding({ taskId: "rolled", episodeId: "r2", sessionId: "s-rolled", agentSessionId: AGENT_A, boundAt: 50 }));
  assert.equal(agentSessionOf("rolled"), AGENT_A);
});

test("a replaced current binding falls back to the newest historical binding", () => {
  upsertTask(mkTask({ id: "moved", status: "done" }));
  bindTaskWorkEpisode(binding({ taskId: "moved", episodeId: "m1", sessionId: "s-moved", agentSessionId: AGENT_A, boundAt: 100 }));
  bindTaskWorkEpisode(binding({ taskId: "moved", episodeId: "m2", sessionId: "s-moved", agentSessionId: AGENT_B, boundAt: 200 }));
  // The session takes another task, which deletes this task's current row after archiving it.
  upsertTask(mkTask({ id: "next", status: "running" }));
  bindTaskWorkEpisode(binding({ taskId: "next", episodeId: "n1", sessionId: "s-moved", agentSessionId: AGENT_C, boundAt: 300 }));
  assert.equal(agentSessionOf("moved"), AGENT_B);
  assert.equal(agentSessionOf("next"), AGENT_C);
});

test("a published task carries what its bindings say, not the value it was upserted with", () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "published", status: "running", agentSessionId: null }));
  bindTaskWorkEpisode(binding({ taskId: "published", episodeId: "p1", sessionId: "s-published", agentSessionId: AGENT_A, boundAt: 100 }));
  // An upsert carrying the stale in-memory value still publishes what the bindings say.
  registry.upsertTask({ ...registry.getTask("published")!, status: "done" });
  assert.equal(registry.getTask("published")?.agentSessionId, AGENT_A);
});

function episode(sessionId: string, agentSessionId: string) {
  return {
    episodeId: `episode-${sessionId}`,
    sessionId,
    agentSessionId,
    branch: null,
    prUrl: null,
    prHeadSha: null,
    mergedAt: null,
    promptedAt: null,
    awaitingAgentRebind: false,
    rebindFromTranscriptPath: null,
    startedAt: 100,
    updatedAt: 100,
  };
}

function upserts(registry: InstanceType<typeof Registry>, taskId: string): Array<string | null> {
  const seen: Array<string | null> = [];
  registry.subscribe((event) => {
    if (event.type === "task_upsert" && event.task.id === taskId) seen.push(event.task.agentSessionId);
  });
  return seen;
}

test("binding a held task through the registry re-sends it with its agent session", () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "bound-live", status: "running", sessionId: "s-bound-live" }));
  const seen = upserts(registry, "bound-live");
  assert.equal(registry.bindTaskToWorkEpisode("bound-live", "s-bound-live", episode("s-bound-live", AGENT_B)), true);
  // No upsert follows: the bind alone moves the held task and tells the dashboard.
  assert.equal(registry.getTask("bound-live")?.agentSessionId, AGENT_B);
  assert.deepEqual(seen, [AGENT_B]);
});

test("a reset that invalidates a finished task's binding re-sends it with what remains", () => {
  const registry = new Registry();
  upsertTask(mkTask({ id: "reset-live", status: "done", sessionId: "s-reset-live" }));
  // Merged, so the registry's provenance cleanup keeps the archived row for a finished task.
  bindTaskWorkEpisode({
    ...binding({ taskId: "reset-live", episodeId: "old", sessionId: "s-reset-live", agentSessionId: AGENT_A, boundAt: 100 }),
    mergedAt: 150,
  });
  bindTaskWorkEpisode(binding({ taskId: "reset-live", episodeId: "new", sessionId: "s-reset-live", agentSessionId: AGENT_C, boundAt: 200 }));
  registry.upsertTask(getTask("reset-live")!);
  assert.equal(registry.getTask("reset-live")?.agentSessionId, AGENT_C);
  const seen = upserts(registry, "reset-live");
  // The session's identity is reset, which deletes the task's current binding: the archived
  // episode is what is left, and the held task follows it without a restart.
  registry.resetWorkEpisode("s-reset-live");
  assert.equal(getTask("reset-live")?.agentSessionId, AGENT_A);
  assert.equal(registry.getTask("reset-live")?.agentSessionId, AGENT_A);
  assert.deepEqual(seen, [AGENT_A]);
});

test("readsHistory and the server's history slot are one fact", () => {
  for (const agent of AGENT_TYPES) {
    assert.equal(
      HARNESS_CAPABILITIES[agent].readsHistory,
      HARNESSES[agent].history !== null,
      `${agent}: readsHistory disagrees with whether a history reader exists`,
    );
  }
});

test("a task links to History only with a bound session its harness reads", () => {
  assert.equal(taskHistoryHref({ agent: "claude", agentSessionId: AGENT_A }), `#/history/claude/${AGENT_A}`);
  assert.equal(taskHistoryHref({ agent: "claude", agentSessionId: null }), null);
  assert.equal(taskHistoryHref({ agent: "claude", agentSessionId: "not-a-session-id" }), null);
  for (const agent of AGENT_TYPES) {
    if (HARNESS_CAPABILITIES[agent].readsHistory) continue;
    assert.equal(taskHistoryHref({ agent, agentSessionId: AGENT_A }), null, `${agent} has no history reader`);
  }
});
