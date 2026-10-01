import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { ServerEvent, Task } from "../src/shared/types.ts";

const home = mkdtempSync(join(tmpdir(), "mission-shape-tickets-followup-"));
process.env.MISSION_HOME = home;

const { ensureToken } = await import("../src/server/auth.ts");
const { bindTaskWorkEpisode, shapeTicketFollowupForTask } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { startShapeTicketsFollowup } = await import("../src/server/shape-tickets-followup.ts");
const { SHAPE_TICKETS_OUTCOME_TEXT, withShapeTicketsCompletion } = await import("../src/server/shape-tickets.ts");
const { COMPLETE_SHAPE_TICKETS_TOOL } = await import("../src/server/plans/tools.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const PR = "https://github.com/acme/demo/pull/7";

/** A done shape task whose plan PR merged, on the board. */
function mergedShape(registry: InstanceType<typeof Registry>, id: string, over: Partial<Task> = {}): Task {
  bindTaskWorkEpisode({
    taskId: id,
    episodeId: `${id}-episode`,
    sessionId: `${id}-session`,
    agentSessionId: `agent:${id}`,
    branch: `shape/${id}`,
    prUrl: PR,
    prHeadSha: "a".repeat(40),
    mergedAt: 2_000,
    boundAt: 100,
    updatedAt: 2_000,
  });
  const task = mkTask({
    id,
    title: `Shape ${id}`,
    kind: "shape",
    agent: "codex",
    status: "done",
    outcome: "plan merged",
    repoRoot: "/repos/primary",
    workflowId: "builtin-workflow:plan-validation",
    ...over,
  });
  registry.upsertTask(task);
  return task;
}

function setup() {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const upserts: Task[] = [];
  registry.on("event", (e: ServerEvent) => {
    if (e.type === "task_upsert") upserts.push(e.task);
  });
  return { registry, tasks, app, upserts };
}

async function createTickets(app: ReturnType<typeof buildApp>, id: string) {
  const res = await app.request(`/api/tasks/${id}/shape-tickets`, {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: "{}",
  });
  return { status: res.status, body: await res.json() };
}

test("the wire task derives shapeTickets for shape tasks only, and allows Create tickets only once merged", () => {
  const { registry } = setup();
  registry.upsertTask(mkTask({ id: "wire-ship", status: "done" }));
  assert.equal(registry.getTask("wire-ship")!.shapeTickets ?? null, null, "no field for another kind");

  registry.upsertTask(mkTask({ id: "wire-running", kind: "shape", status: "running" }));
  assert.deepEqual(registry.getTask("wire-running")!.shapeTickets, { state: null, followupTaskId: null, canCreate: false });

  registry.upsertTask(mkTask({ id: "wire-unmerged", kind: "shape", status: "done" }));
  assert.deepEqual(registry.getTask("wire-unmerged")!.shapeTickets, { state: null, followupTaskId: null, canCreate: false });

  mergedShape(registry, "wire-merged");
  assert.deepEqual(registry.getTask("wire-merged")!.shapeTickets, { state: null, followupTaskId: null, canCreate: true });
});

test("Create tickets is refused with a 409 and a reason unless the task is a done, merged shape task", async () => {
  const { registry, app } = setup();
  registry.upsertTask(mkTask({ id: "refuse-ship", status: "done" }));
  registry.upsertTask(mkTask({ id: "refuse-running", kind: "shape", status: "running" }));
  registry.upsertTask(mkTask({ id: "refuse-unmerged", kind: "shape", status: "done" }));
  const before = registry.listTasks().length;

  assert.deepEqual(await createTickets(app, "refuse-missing"), { status: 404, body: { error: "no such task" } });
  const ship = await createTickets(app, "refuse-ship");
  assert.equal(ship.status, 409);
  assert.match(ship.body.error, /only to a shape task/);
  const running = await createTickets(app, "refuse-running");
  assert.equal(running.status, 409);
  assert.match(running.body.error, /is running.*merged pull request/);
  const unmerged = await createTickets(app, "refuse-unmerged");
  assert.equal(unmerged.status, 409);
  assert.match(unmerged.body.error, /no merged pull request/);
  assert.equal(registry.listTasks().length, before, "nothing was created");
});

test("Create tickets files a linked tickets-only shape task, re-sends the source, and refuses a duplicate", async () => {
  const { registry, app, upserts } = setup();
  const source = mergedShape(registry, "create-src", {
    extraRepos: [{
      repoRoot: "/repos/secondary",
      worktreePath: null,
      branch: null,
      provider: null,
      worktreeLeaseId: null,
      baseSha: null,
      prUrl: null,
      prState: null,
      mergedAt: null,
    }],
  });
  upserts.length = 0;

  // The test daemon has every skill off, so the launch is refused: the follow-up stays in the
  // backlog carrying that reason.
  const created = await createTickets(app, source.id);
  assert.equal(created.status, 200);
  assert.equal(created.body.kind, "queued");
  assert.match(created.body.reason, /skill/);
  const followup = registry.getTask(created.body.task.id)!;
  assert.equal(followup.kind, "shape");
  assert.equal(followup.title, `Tickets: ${source.title}`);
  assert.equal(followup.workflowId, null, "After work is explicitly None");
  assert.equal(followup.repoRoot, source.repoRoot);
  assert.deepEqual(followup.extraRepos.map((repo) => repo.repoRoot), ["/repos/secondary"]);
  assert.equal(followup.status, "backlog");
  assert.equal(followup.error, created.body.reason);
  assert.match(followup.intent, new RegExp(PR.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
  assert.deepEqual(shapeTicketFollowupForTask(followup.id), {
    followupTaskId: followup.id,
    sourceTaskId: source.id,
    sourceEpisodeId: `${source.id}-episode`,
    sourceSessionId: `${source.id}-session`,
    sourcePrUrl: PR,
    createdAt: shapeTicketFollowupForTask(followup.id)!.createdAt,
    updatedAt: shapeTicketFollowupForTask(followup.id)!.updatedAt,
  });

  // The source was re-sent with its newest follow-up and no longer offers the action.
  const sent = upserts.filter((task) => task.id === source.id).at(-1);
  assert.deepEqual(sent?.shapeTickets, { state: null, followupTaskId: followup.id, canCreate: false });

  // A live (backlogged) follow-up refuses a duplicate.
  const duplicate = await createTickets(app, source.id);
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /already backlog/);

  // Cancelling the follow-up re-sends the source, which offers the action again.
  upserts.length = 0;
  registry.upsertTask({ ...registry.getTask(followup.id)!, status: "cancelled" });
  assert.deepEqual(
    upserts.filter((task) => task.id === source.id).at(-1)?.shapeTickets,
    { state: null, followupTaskId: followup.id, canCreate: true },
  );
  const retry = await createTickets(app, source.id);
  assert.equal(retry.status, 200, "a cancelled follow-up can be retried");
  assert.notEqual(retry.body.task.id, followup.id);
  assert.equal(registry.getTask(source.id)!.shapeTickets?.followupTaskId, retry.body.task.id, "newest first");

  // A follow-up that filed its tickets refuses another one.
  registry.upsertTask({ ...registry.getTask(retry.body.task.id)!, status: "done", outcome: SHAPE_TICKETS_OUTCOME_TEXT.filed });
  const afterDone = await createTickets(app, source.id);
  assert.equal(afterDone.status, 409);
  assert.match(afterDone.body.error, /already filed its tickets/);
});

test("the follow-up runs on the source's agent when it can run tickets, else on the default", async () => {
  const { registry, tasks } = setup();
  const launched: string[] = [];
  tasks.dispatch = async (id) => {
    launched.push(id);
    return { ok: true, task: tasks.get(id)! };
  };
  const source = mergedShape(registry, "agent-src", { agent: "codex" });
  const own = await startShapeTicketsFollowup(source.id, {
    tasks,
    skillForAgent: () => ({ ok: true, command: "/tickets" }),
    defaultAgent: () => "claude",
  });
  assert.equal(own.kind, "started");
  assert.equal(own.kind === "started" && own.task.agent, "codex");
  assert.deepEqual(launched, [own.kind === "started" ? own.task.id : ""]);

  const other = mergedShape(registry, "agent-src-2", { agent: "codex" });
  const fallback = await startShapeTicketsFollowup(other.id, {
    tasks,
    skillForAgent: (agent) =>
      agent === "codex"
        ? { ok: false, message: "Enable the tickets skill." }
        : { ok: true, command: "/tickets" },
    defaultAgent: () => "claude",
  });
  assert.equal(fallback.kind === "started" && fallback.task.agent, "claude");
});

test("only a tickets follow-up's launch is granted complete_shape_tickets", () => {
  const { registry } = setup();
  const source = mergedShape(registry, "grant-src");
  const followupId = new TaskManager(registry).createShapeTicketsFollowup({
    sourceTask: source,
    sourceEpisodeId: `${source.id}-episode`,
    sourceSessionId: `${source.id}-session`,
    sourcePrUrl: PR,
    agent: "claude",
  }).id;
  assert.deepEqual(
    withShapeTicketsCompletion({ id: followupId, kind: "shape" }, { tools: ["request_input"] }),
    { tools: ["request_input", COMPLETE_SHAPE_TICKETS_TOOL] },
  );
  assert.equal(withShapeTicketsCompletion({ id: source.id, kind: "shape" }, null), null);
  assert.equal(withShapeTicketsCompletion({ id: "grant-ship", kind: "ship" }, null), null);
});

/** A follow-up that was dispatched: running, in a worktree, with a live session. */
function runningFollowup(registry: InstanceType<typeof Registry>, tasks: InstanceType<typeof TaskManager>, sourceId: string) {
  const source = mergedShape(registry, sourceId);
  const created = tasks.createShapeTicketsFollowup({
    sourceTask: source,
    sourceEpisodeId: `${source.id}-episode`,
    sourceSessionId: `${source.id}-session`,
    sourcePrUrl: PR,
    agent: "claude",
  });
  const running = {
    ...created,
    status: "running" as const,
    worktreePath: `/worktrees/${created.id}`,
    sessionId: `sdk:${created.id}`,
    updatedAt: Date.now(),
  };
  registry.upsertTask(running);
  registry.registerSdkSession({
    id: running.sessionId,
    agent: "claude",
    name: `tickets ${sourceId}`,
    cwd: running.worktreePath,
    agentSessionId: `agent:${created.id}`,
  });
  return { source, followup: running, payload: { env: {}, sessionId: `agent:${created.id}`, cwd: running.worktreePath } };
}

async function complete(app: ReturnType<typeof buildApp>, body: unknown, authed = true) {
  const res = await app.request("/mcp/shape-tickets/complete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authed ? { "x-harness-token": ensureToken() } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("complete_shape_tickets takes the follow-up to done after filing, requests closure, and replays", async () => {
  const { registry, tasks, app, upserts } = setup();
  const { source, followup, payload } = runningFollowup(registry, tasks, "filed-src");

  assert.equal((await complete(app, { ...payload, outcome: "filed" }, false)).status, 401);
  assert.equal(
    (await complete(app, { ...payload, outcome: "filed", taskId: source.id })).status,
    400,
    "the operation has no caller-controlled target",
  );
  assert.equal((await complete(app, { ...payload, outcome: "shipped" })).status, 400);

  upserts.length = 0;
  const first = await complete(app, { ...payload, outcome: "filed" });
  assert.equal(first.status, 200);
  assert.equal(first.body.replayed, false);
  assert.equal(first.body.sourceTaskId, source.id);
  assert.equal(first.body.task.id, followup.id);
  assert.equal(first.body.task.status, "done");
  assert.equal(first.body.task.outcome, SHAPE_TICKETS_OUTCOME_TEXT.filed);
  assert.equal(first.body.sessionClosureRequested, true, "its session is closed with the outcome");
  assert.equal(registry.getTask(followup.id)!.status, "done");
  assert.equal(registry.getTask(source.id)!.status, "done", "the source is untouched");
  // The follow-up's status change re-sent the source, though its summary did not move.
  assert.deepEqual(
    upserts.filter((task) => task.id === source.id).at(-1)?.shapeTickets,
    { state: null, followupTaskId: followup.id, canCreate: false },
  );

  const replay = await complete(app, { ...payload, outcome: "filed" });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  const conflicting = await complete(app, { ...payload, outcome: "dismissed" });
  assert.equal(conflicting.status, 409);
  assert.match(conflicting.body.error, /different outcome/);
});

test("complete_shape_tickets takes the follow-up to done after a dismissed breakdown", async () => {
  const { registry, tasks, app } = setup();
  const { followup, payload } = runningFollowup(registry, tasks, "dismissed-src");
  const result = await complete(app, { ...payload, outcome: "dismissed" });
  assert.equal(result.status, 200);
  assert.equal(registry.getTask(followup.id)!.status, "done");
  assert.equal(registry.getTask(followup.id)!.outcome, SHAPE_TICKETS_OUTCOME_TEXT.dismissed);
});

test("complete_shape_tickets is refused for a session that is not running a tickets follow-up", async () => {
  const { registry, tasks, app } = setup();
  const shaping = mkTask({
    id: "not-followup",
    kind: "shape",
    status: "running",
    worktreePath: "/worktrees/not-followup",
    sessionId: "sdk:not-followup",
  });
  registry.upsertTask(shaping);
  registry.registerSdkSession({
    id: "sdk:not-followup",
    agent: "claude",
    name: "shaping",
    cwd: "/worktrees/not-followup",
    agentSessionId: "agent:not-followup",
  });
  const refused = await complete(app, {
    env: {},
    sessionId: "agent:not-followup",
    cwd: "/worktrees/not-followup",
    outcome: "filed",
  });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /not running a shape task's tickets follow-up/);
  assert.equal(registry.getTask("not-followup")!.status, "running");
  void tasks;
});

test("complete_shape_tickets is refused for a follow-up that is no longer active", async () => {
  const { registry, tasks, app } = setup();

  // Failed but still holding its worktree, so the session is still attributed to it: the
  // refusal comes from the status check, and nothing is completed.
  const failed = runningFollowup(registry, tasks, "failed-src");
  registry.upsertTask({ ...registry.getTask(failed.followup.id)!, status: "failed", updatedAt: Date.now() });
  const refused = await complete(app, { ...failed.payload, outcome: "filed" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /this tickets follow-up is failed, so it cannot report an outcome/);
  assert.equal(registry.getTask(failed.followup.id)!.status, "failed");
  assert.equal(registry.getTask(failed.followup.id)!.outcome, null);

  // Cancelled: the Registry no longer attributes the session to it at all, so the call is
  // refused before the status check, and the task stays cancelled.
  const cancelled = runningFollowup(registry, tasks, "cancelled-src");
  registry.upsertTask({ ...registry.getTask(cancelled.followup.id)!, status: "cancelled", updatedAt: Date.now() });
  const gone = await complete(app, { ...cancelled.payload, outcome: "dismissed" });
  assert.equal(gone.status, 404);
  assert.match(gone.body.error, /no task is attributed to this session/);
  assert.equal(registry.getTask(cancelled.followup.id)!.status, "cancelled");
  assert.equal(registry.getTask(cancelled.followup.id)!.outcome, null);
});

test("deleting a backlogged follow-up re-sends its source, which offers Create tickets again", async () => {
  const { registry, tasks, app, upserts } = setup();
  const source = mergedShape(registry, "delete-src");
  // Launch refused (every skill is off here), so the follow-up waits in the backlog.
  const created = await createTickets(app, source.id);
  assert.equal(created.body.kind, "queued");
  assert.deepEqual(registry.getTask(source.id)!.shapeTickets, { state: null, followupTaskId: created.body.task.id, canCreate: false });

  upserts.length = 0;
  const removed = await tasks.remove(created.body.task.id);
  assert.equal(removed.ok, true);
  assert.deepEqual(
    upserts.filter((task) => task.id === source.id).at(-1)?.shapeTickets,
    { state: null, followupTaskId: null, canCreate: true },
    "the source is re-sent without a reload",
  );
  assert.equal((await createTickets(app, source.id)).status, 200, "and the route agrees");
});

test("a relation whose follow-up task was never created is not reported as the newest follow-up", async () => {
  const { reserveShapeTicketFollowup } = await import("../src/server/db.ts");
  const { registry, tasks } = setup();
  const source = mergedShape(registry, "orphan-src");
  const real = tasks.createShapeTicketsFollowup({
    sourceTask: source,
    sourceEpisodeId: `${source.id}-episode`,
    sourceSessionId: `${source.id}-session`,
    sourcePrUrl: PR,
    agent: "claude",
  });
  // What a create that threw after its reservation leaves behind: a newer row naming nothing.
  reserveShapeTicketFollowup({
    followupTaskId: "orphan-never-created",
    sourceTaskId: source.id,
    sourceEpisodeId: `${source.id}-episode`,
    sourceSessionId: `${source.id}-session`,
    sourcePrUrl: PR,
    now: Date.now() + 60_000,
  });
  registry.upsertTask({ ...registry.getTask(source.id)!, updatedAt: Date.now() });
  assert.deepEqual(registry.getTask(source.id)!.shapeTickets, { state: null, followupTaskId: real.id, canCreate: false });
});

test("a dismissed breakdown does not withdraw Create tickets, and the retry is accepted", async () => {
  const { registry, tasks, app, upserts } = setup();
  const { source, payload } = runningFollowup(registry, tasks, "redo-src");
  assert.equal(registry.getTask(source.id)!.shapeTickets?.canCreate, false, "blocked while it runs");

  upserts.length = 0;
  assert.equal((await complete(app, { ...payload, outcome: "dismissed" })).status, 200);
  // Re-sent with the action offered again: the dismissed follow-up filed nothing.
  assert.equal(upserts.filter((task) => task.id === source.id).at(-1)?.shapeTickets?.canCreate, true);
  const retry = await createTickets(app, source.id);
  assert.equal(retry.status, 200);
  assert.equal(registry.getTask(source.id)!.shapeTickets?.followupTaskId, retry.body.task.id);
});

test("an ended follow-up that filed tickets keeps blocking Create tickets until those tickets are gone", async () => {
  const { registry, tasks, app, upserts } = setup();
  const { source, followup } = runningFollowup(registry, tasks, "partial-src");

  // An in-session ticket from the old flow: its edge to the source predates every follow-up,
  // so it is never read as a follow-up's work.
  registry.upsertTask(mkTask({
    id: "partial-in-session",
    status: "backlog",
    dependencies: [{
      type: "task",
      taskId: source.id,
      title: source.title,
      sessionId: `${source.id}-session`,
      episodeId: `${source.id}-episode`,
      agentSessionId: null,
      branch: null,
      prUrl: PR,
      selectedAt: 1_000,
      satisfiedAt: 2_000,
    }],
  }));

  // The follow-up files one ticket the way the skill does, then its next create_task fails
  // and the human cancels it.
  const ticket = tasks.create({
    repoRoot: "/repos/primary",
    title: "Ticket 1",
    intent: "the first ticket",
    kind: "ship",
    backlog: true,
    dependencies: [{ type: "session", sessionId: followup.sessionId }],
  });
  assert.equal(ticket.dependencies[0]?.type === "task" && ticket.dependencies[0].taskId, source.id);
  registry.upsertTask({ ...registry.getTask(followup.id)!, status: "cancelled", updatedAt: Date.now() });

  assert.equal(registry.getTask(source.id)!.shapeTickets?.canCreate, false);
  const refused = await createTickets(app, source.id);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /filed 1 ticket before it ended, and another would file them again/);

  // With the partial work removed, slicing afresh is allowed, and the source is re-sent so the
  // Sitrep offers it again; the in-session ticket does not block.
  upserts.length = 0;
  assert.equal((await tasks.remove(ticket.id)).ok, true);
  assert.equal(upserts.filter((task) => task.id === source.id).at(-1)?.shapeTickets?.canCreate, true);
  assert.equal((await createTickets(app, source.id)).status, 200);
});
