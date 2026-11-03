import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Session History's Mission Control join: a session's task work episode binding (current, else
 * the newest historical one), its task, the Mission Control session that ran it and its
 * `usage_ledger` cost, joined when a row is served and never stored. Covers the list's title,
 * kind rule and filters, the detail with and without the join, the Mission Control-only record
 * for a bound id the catalog never indexed, and the 404 for an id neither knows.
 *
 * Every transcript is a fixture in a temp projects directory; nothing reads `~/.claude`.
 */

const home = mkdtempSync(join(tmpdir(), "mission-history-mission-"));
process.env.MISSION_HOME = home;

const { createClaudeHistory } = await import("../src/server/harness/claude/history.ts");
const { HistoryService } = await import("../src/server/history/service.ts");
const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
import type { HistoryMissionRecord, HistoryPage, HistorySessionDetail, HistorySessionSummary } from "../src/shared/history.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";

const LOOPBACK = { host: "127.0.0.1:7317" };
const AGENT_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
let ordinal = 0;

function sessionId(): string {
  ordinal += 1;
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

/** A session of one kind: interactive, or a one-shot background run (no tools). */
function writeSession(
  projects: string,
  id: string,
  shape: { kind: "interactive" | "one_shot"; prompt: string; at: string; cost?: number; prLink?: string },
): void {
  const base = {
    sessionId: id,
    cwd: "/work",
    entrypoint: shape.kind === "interactive" ? "cli" : "sdk-ts",
    version: "2.1.296",
    gitBranch: "main",
    timestamp: shape.at,
    isSidechain: false,
  };
  const lines: unknown[] = [];
  if (shape.kind === "one_shot") {
    lines.push({ ...base, type: "attachment", attachment: { type: "prompt_snapshot", cliPrefix: AGENT_PREFIX, tools: [], systemPrompt: [] } });
  }
  lines.push({ ...base, type: "user", message: { role: "user", content: shape.prompt } });
  lines.push({ ...base, type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }] } });
  if (shape.cost !== undefined) lines.push({ ...base, type: "cost-state", totalCostUSD: shape.cost });
  if (shape.prLink) lines.push({ ...base, type: "pr-link", prUrl: shape.prLink, prNumber: 9, prRepository: "o/r" });
  const dir = join(projects, "-work");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

/** The detail's catalog row, failing when the route answered with a Mission Control-only record. */
function catalogOf(detail: HistorySessionDetail): HistorySessionSummary {
  assert.ok(detail.catalog, "the detail carries a catalog row");
  return detail.catalog;
}

/** The detail's Mission Control-only record, failing when the route answered with a catalog row. */
function missionOnly(detail: HistorySessionDetail): HistoryMissionRecord {
  assert.equal(detail.catalog, null, "the catalog has no row for this id");
  assert.ok(detail.catalog === null);
  return detail.mission;
}

let taskOrdinal = 0;

/** A task, and its binding to `agentSessionId`: current unless `historical`. */
function bindTask(agentSessionId: string, shape: {
  title: string;
  status?: string;
  outcome?: string | null;
  outcomeUrl?: string | null;
  prUrl?: string | null;
  mergedAt?: number | null;
  historical?: boolean;
  agent?: string;
  updatedAt?: number;
}): string {
  taskOrdinal += 1;
  const taskId = `task-${taskOrdinal}`;
  const db = openDb();
  db.prepare(
    `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, branch, status, outcome, outcome_url, workflow_id, labels, created_at, updated_at)
     VALUES (?, ?, 'intent', 'ship', ?, '/repos/app', 'task-branch', ?, ?, ?, 'wf-1', '["history"]', 1, 1)`,
  ).run(taskId, shape.title, shape.agent ?? "claude", shape.status ?? "done", shape.outcome ?? null, shape.outcomeUrl ?? null);
  const table = shape.historical ? "historical_task_work_episode_bindings" : "task_work_episode_bindings";
  db.prepare(
    `INSERT INTO ${table} (task_id, episode_id, session_id, agent_session_id, branch, pr_url, merged_at, bound_at, updated_at)
     VALUES (?, ?, ?, ?, 'bound-branch', ?, ?, 1, ?)`,
  ).run(taskId, `ep-${taskId}`, `mc-${taskId}`, agentSessionId, shape.prUrl ?? null, shape.mergedAt ?? null, shape.updatedAt ?? 1);
  return taskId;
}

function ledger(
  noteKey: string,
  cost: number,
  known = 1,
  shape: { spendKind?: string; costBasis?: string } = {},
): void {
  openDb().prepare(
    `INSERT INTO usage_ledger (note_key, agent, model_id, window_end_ns, ts, cost_usd, cost_known, spend_kind, cost_basis)
     VALUES (?, 'claude', 'claude-opus-5-5', ?, 1, ?, ?, ?, ?)`,
  ).run(noteKey, String(Math.random()), cost, known, shape.spendKind ?? "session", shape.costBasis ?? "reported");
}

function fixture(registry = new Registry()) {
  openDb().exec(`
    DELETE FROM history_sessions; DELETE FROM history_search_segments; DELETE FROM tasks;
    DELETE FROM task_work_episode_bindings; DELETE FROM historical_task_work_episode_bindings;
    DELETE FROM session_agent_bindings; DELETE FROM usage_ledger;
  `);
  const projects = mkdtempSync(join(tmpdir(), "mission-history-mission-projects-"));
  const history = new HistoryService({ readers: [{ agent: "claude", spec: createClaudeHistory(projects) }], resolveRepository: () => null });
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks: {} as TaskManager, queues: {} as QueueManager, history });
  const get = (path: string) => app.request(path, { headers: LOOPBACK });
  const list = async (query = "") => {
    const res = await get(`/api/history/sessions${query}`);
    assert.equal(res.status, 200, query);
    return (await res.json() as HistoryPage).sessions;
  };
  return { projects, history, get, list, done: () => rmSync(projects, { recursive: true, force: true }) };
}

test("a bound session carries its task, outcome and PR; an unbound one is complete without them", async () => {
  const f = fixture();
  const bound = sessionId();
  const unbound = sessionId();
  writeSession(f.projects, bound, { kind: "interactive", prompt: "fix the login", at: "2026-10-20T10:00:00.000Z", cost: 2 });
  writeSession(f.projects, unbound, { kind: "interactive", prompt: "just chatting", at: "2026-10-20T11:00:00.000Z", cost: 1 });
  const taskId = bindTask(bound, {
    title: "Fix the login retry",
    outcome: "opened PR #12",
    outcomeUrl: "https://github.com/o/r/pull/12",
    prUrl: "https://github.com/o/r/pull/12",
    mergedAt: 5_000,
  });
  openDb().prepare("INSERT INTO session_agent_bindings (session_id, agent_session_id, updated_at) VALUES ('mc-1', ?, 1)").run(bound);
  ledger(bound, 9);
  await f.history.reconciler.trigger();

  const rows = await f.list();
  const row = rows.find((entry) => entry.agentSessionId === bound);
  assert.deepEqual(row?.mission, {
    task: {
      id: taskId,
      title: "Fix the login retry",
      kind: "ship",
      status: "done",
      outcome: "opened PR #12",
      outcomeUrl: "https://github.com/o/r/pull/12",
      workflowId: "wf-1",
      labels: ["history"],
    },
    prUrl: "https://github.com/o/r/pull/12",
    mergedAt: 5_000,
    branch: "bound-branch",
    repoRoot: "/repos/app",
    missionSessionId: "mc-1",
    ledgerCostUsd: 9,
  });
  assert.equal(row?.costUsd, 2, "the transcript's cost-state is preferred over the ledger");
  assert.equal(row?.costSource, "transcript");

  const plain = rows.find((entry) => entry.agentSessionId === unbound);
  assert.equal(plain?.mission, null);
  assert.equal(plain?.costUsd, 1);
  assert.equal(plain?.firstPrompt, "just chatting", "a record with no Mission Control data is still complete");

  const detail = catalogOf(await (await f.get(`/api/history/sessions/claude/${bound}`)).json() as HistorySessionDetail);
  assert.deepEqual(detail, row, "the detail serves the row exactly as the list does");
  assert.deepEqual(Object.keys(await (await f.get(`/api/history/sessions/claude/${bound}`)).json() as object), ["catalog", "subagents"]);
  const plainDetail = catalogOf(await (await f.get(`/api/history/sessions/claude/${unbound}`)).json() as HistorySessionDetail);
  assert.equal(plainDetail.mission, null);
  assert.equal(plainDetail.firstPrompt, "just chatting");
  f.done();
});

test("cost falls back to usage_ledger when the transcript has none, and an unpriced ledger stays unknown", async () => {
  const f = fixture();
  const priced = sessionId();
  const unpriced = sessionId();
  writeSession(f.projects, priced, { kind: "interactive", prompt: "a", at: "2026-10-20T10:00:00.000Z" });
  writeSession(f.projects, unpriced, { kind: "interactive", prompt: "b", at: "2026-10-20T10:01:00.000Z" });
  ledger(priced, 1.5);
  ledger(priced, 0.25);
  ledger(unpriced, 1);
  ledger(unpriced, 0, 0);
  await f.history.reconciler.trigger();

  const rows = await f.list();
  const row = rows.find((entry) => entry.agentSessionId === priced);
  assert.equal(row?.costUsd, 1.75);
  assert.equal(row?.costSource, "ledger");
  const unknown = rows.find((entry) => entry.agentSessionId === unpriced);
  assert.equal(unknown?.costUsd, null, "a subtotal of priced rows is never shown as the total");
  assert.equal(unknown?.costSource, null);
  f.done();
});

test("the ledger fallback counts session spend only, and rows on different cost bases give no cost", async () => {
  const f = fixture();
  const withAutomation = sessionId();
  const mixed = sessionId();
  writeSession(f.projects, withAutomation, { kind: "interactive", prompt: "a", at: "2026-10-20T10:00:00.000Z" });
  writeSession(f.projects, mixed, { kind: "interactive", prompt: "b", at: "2026-10-20T10:01:00.000Z" });
  ledger(withAutomation, 2);
  ledger(withAutomation, 40, 1, { spendKind: "automation" });
  ledger(mixed, 1, 1, { costBasis: "reported" });
  ledger(mixed, 2, 1, { costBasis: "api-equivalent" });
  await f.history.reconciler.trigger();

  const rows = await f.list();
  const session = rows.find((entry) => entry.agentSessionId === withAutomation);
  assert.equal(session?.costUsd, 2, "automation spend under the same key is not this session's");
  assert.equal(session?.costSource, "ledger");
  const disagreeing = rows.find((entry) => entry.agentSessionId === mixed);
  assert.equal(disagreeing?.costUsd, null, "a sum across cost bases is not one figure");
  assert.equal(disagreeing?.costSource, null);
  f.done();
});

test("a task-bound background run is in the default list, and a newer binding wins over a historical one", async () => {
  const f = fixture();
  const boundRun = sessionId();
  const freeRun = sessionId();
  writeSession(f.projects, boundRun, { kind: "one_shot", prompt: "review this diff", at: "2026-10-20T10:00:00.000Z" });
  writeSession(f.projects, freeRun, { kind: "one_shot", prompt: "summarize", at: "2026-10-20T10:01:00.000Z" });
  bindTask(boundRun, { title: "Older task", historical: true, updatedAt: 1 });
  bindTask(boundRun, { title: "Newest historical task", historical: true, updatedAt: 9 });
  await f.history.reconciler.trigger();

  const ids = (await f.list()).map((row) => row.agentSessionId);
  assert.ok(ids.includes(boundRun), "a session a task ran is a conversation whatever its kind");
  assert.ok(!ids.includes(freeRun), "an unbound one-shot run stays behind the Kind filter");
  const row = (await f.list()).find((entry) => entry.agentSessionId === boundRun);
  assert.equal(row?.mission?.task?.title, "Newest historical task");

  bindTask(boundRun, { title: "Current task", updatedAt: 2 });
  const current = (await f.list()).find((entry) => entry.agentSessionId === boundRun);
  assert.equal(current?.mission?.task?.title, "Current task", "the current binding beats any historical one");
  // An explicit kind narrows to that kind, bound or not.
  assert.deepEqual((await f.list("?kind=interactive")).map((r) => r.agentSessionId), []);
  assert.deepEqual(new Set((await f.list("?kind=one_shot")).map((r) => r.agentSessionId)), new Set([boundRun, freeRun]));
  f.done();
});

test("a binding joins only its own agent's row", async () => {
  const f = fixture();
  const id = sessionId();
  writeSession(f.projects, id, { kind: "interactive", prompt: "x", at: "2026-10-20T10:00:00.000Z" });
  bindTask(id, { title: "A Codex task", agent: "codex" });
  await f.history.reconciler.trigger();
  assert.equal((await f.list()).find((row) => row.agentSessionId === id)?.mission, null);
  assert.deepEqual((await f.list("?link=task")).map((row) => row.agentSessionId), []);
  f.done();
});

test("the link, outcome and PR filters combine with the existing filters", async () => {
  const f = fixture();
  const merged = sessionId();
  const failed = sessionId();
  const external = sessionId();
  const externalPr = sessionId();
  writeSession(f.projects, merged, { kind: "interactive", prompt: "ship it", at: "2026-10-20T10:00:00.000Z" });
  writeSession(f.projects, failed, { kind: "one_shot", prompt: "broken run", at: "2026-10-21T10:00:00.000Z" });
  writeSession(f.projects, external, { kind: "interactive", prompt: "outside work", at: "2026-10-22T10:00:00.000Z" });
  writeSession(f.projects, externalPr, {
    kind: "interactive",
    prompt: "outside pr",
    at: "2026-10-23T10:00:00.000Z",
    prLink: "https://github.com/o/r/pull/9",
  });
  bindTask(merged, { title: "Merged feature", prUrl: "https://github.com/o/r/pull/1", mergedAt: 7 });
  bindTask(failed, { title: "Failed attempt", status: "failed" });
  await f.history.reconciler.trigger();

  const ids = async (query: string) => new Set((await f.list(query)).map((row) => row.agentSessionId));
  assert.deepEqual(await ids("?link=task"), new Set([merged, failed]));
  assert.deepEqual(await ids("?link=external"), new Set([external, externalPr]));
  assert.deepEqual(await ids("?outcome=done"), new Set([merged]));
  assert.deepEqual(await ids("?outcome=failed"), new Set([failed]));
  assert.deepEqual(await ids("?pr=merged"), new Set([merged]));
  assert.deepEqual(await ids("?pr=any"), new Set([merged, externalPr]), "a PR the transcript recorded counts too");
  assert.deepEqual(await ids("?pr=none"), new Set([failed, external]));
  // With the existing filters: date range, kind and search.
  assert.deepEqual(await ids(`?link=task&from=${Date.parse("2026-10-21T00:00:00.000Z")}`), new Set([failed]));
  assert.deepEqual(await ids("?link=external&kind=all&pr=none"), new Set([external]));
  assert.deepEqual(await ids("?q=merged%20feature"), new Set([merged]), "a bound row is found by its task title");
  assert.deepEqual(await ids("?q=outside&link=task"), new Set());

  for (const bad of ["?link=managed", "?outcome=shipped", "?pr=open"]) {
    assert.equal((await f.get(`/api/history/sessions${bad}`)).status, 400, bad);
  }
  f.done();
});

test("a bound id with no catalog row returns the Mission Control-only record, which the reconciler never writes", async () => {
  const f = fixture();
  const indexed = sessionId();
  const removed = sessionId();
  writeSession(f.projects, indexed, { kind: "interactive", prompt: "still here", at: "2026-10-20T10:00:00.000Z" });
  const taskId = bindTask(removed, {
    title: "Deleted before indexing",
    status: "done",
    outcome: "merged",
    outcomeUrl: "https://github.com/o/r/pull/4",
    prUrl: "https://github.com/o/r/pull/4",
    mergedAt: 3,
  });
  ledger(removed, 4.5);
  openDb().prepare("INSERT INTO session_agent_bindings (session_id, agent_session_id, updated_at) VALUES ('mc-removed', ?, 1)").run(removed);
  await f.history.reconciler.trigger();

  const res = await f.get(`/api/history/sessions/claude/${removed}`);
  assert.equal(res.status, 200);
  const detail = missionOnly(await res.json() as HistorySessionDetail);
  assert.equal(detail.agent, "claude");
  assert.equal(detail.agentSessionId, removed);
  assert.equal(detail.liveSessionId, null);
  assert.equal(detail.task?.id, taskId);
  assert.equal(detail.task?.title, "Deleted before indexing");
  assert.equal(detail.task?.kind, "ship");
  assert.equal(detail.task?.outcome, "merged");
  assert.equal(detail.prUrl, "https://github.com/o/r/pull/4");
  assert.equal(detail.branch, "bound-branch");
  assert.equal(detail.repoRoot, "/repos/app");
  assert.equal(detail.ledgerCostUsd, 4.5);
  assert.equal((await f.get(`/api/history/sessions/claude/${removed.toUpperCase()}`)).status, 200, "a UUID's case does not matter");

  assert.equal(detail.missionSessionId, "mc-removed", "beside a task binding, the Mission Control session is reported");

  // Nothing to read: the conversation of a record with no catalog row is unknown to History.
  assert.equal((await f.get(`/api/history/sessions/claude/${removed}/messages`)).status, 404);

  // The reconciler indexes what is on disk and nothing else, even after another pass.
  await f.history.reconciler.trigger();
  const catalogIds = (openDb().prepare("SELECT agent_session_id FROM history_sessions").all() as { agent_session_id: string }[])
    .map((row) => row.agent_session_id);
  assert.deepEqual(catalogIds, [indexed]);
  assert.ok(!(await f.list("?kind=all")).some((row) => row.agentSessionId === removed), "the list holds catalog rows only");
  f.done();
});

test("a running session the catalog has not indexed yet returns the Mission Control-only record with its live id", async () => {
  const registry = new Registry();
  const f = fixture(registry);
  const id = sessionId();
  bindTask(id, { title: "Running, not indexed yet", status: "running" });
  await f.history.reconciler.trigger();
  registry.registerSdkSession({ id: "sdk:history-unindexed", agent: "claude", name: "running", cwd: "/work", agentSessionId: id });

  const detail = missionOnly(await (await f.get(`/api/history/sessions/claude/${id}`)).json() as HistorySessionDetail);
  assert.equal(detail.task?.title, "Running, not indexed yet");
  assert.equal(detail.liveSessionId, "sdk:history-unindexed");
  f.done();
});

test("an id neither the catalog nor a task binding of its agent names is a 404, whatever else Mission Control holds", async () => {
  const f = fixture();
  const ledgerOnly = sessionId();
  const codexBound = sessionId();
  const sessionOnly = sessionId();
  ledger(ledgerOnly, 1);
  bindTask(codexBound, { title: "A Codex task", agent: "codex" });
  // Every session Mission Control ran has a session_agent_bindings row, and it records no
  // agent: a Codex session's row must not put it in Claude's History as removed.
  const ran = openDb().prepare("INSERT INTO session_agent_bindings (session_id, agent_session_id, updated_at) VALUES (?, ?, 1)");
  ran.run("proc:codex-session", codexBound);
  ran.run("proc:unknown-agent", sessionOnly);
  await f.history.reconciler.trigger();
  for (const path of [
    `/api/history/sessions/claude/${sessionId()}`,
    `/api/history/sessions/claude/${ledgerOnly}`,
    // Bound, but to another agent's task, and run by Mission Control.
    `/api/history/sessions/claude/${codexBound}`,
    // Run by Mission Control, with no task to say which agent it was.
    `/api/history/sessions/claude/${sessionOnly}`,
    // Codex declares no history reader, so History does not address its sessions at all.
    `/api/history/sessions/codex/${codexBound}`,
    "/api/history/sessions/claude/not-a-uuid",
  ]) {
    assert.equal((await f.get(path)).status, 404, path);
  }
  f.done();
});
