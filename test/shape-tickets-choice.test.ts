import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanDecision, Task } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { trackedTaskManagers } from "./helpers/task-manager.ts";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-shape-tickets-choice-"));
const migrationHome = mkdtempSync(join(tmpdir(), "mission-shape-tickets-choice-migration-"));
const bin = mkdtempSync(join(tmpdir(), "mission-shape-tickets-choice-gh-"));
process.env.HARNESS_HOME = home;
// The real by-URL lookup, answered by a fake `gh` that reports every pull request CLOSED.
const fakeGh = join(bin, "gh");
writeFileSync(fakeGh, `#!/bin/sh\necho '{"state":"CLOSED","mergedAt":null}'\n`);
chmodSync(fakeGh, 0o755);

const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { pollAndReconcilePrs } = await import("../src/server/pr.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const {
  bindTaskWorkEpisode,
  openDb,
  reserveShapeTicketFollowup,
  shapeTicketFollowupsForSource,
  shapeTicketsStateFor,
  transitionShapeTicketsState,
} = await import("../src/server/db.ts");
const { stampShapeTicketsAwaitingReview } = await import("../src/server/shape-tickets.ts");
const { SHAPE_FOLLOW_UP_DECISION_ID } = await import("../src/server/plans/shape.ts");
const taskManager = trackedTaskManagers(TaskManager);

after(() => {
  for (const dir of [home, migrationHome, bin]) rmSync(dir, { recursive: true, force: true });
});

/**
 * The plan review's Create tickets choice, recorded on a shape task and acted on at its merge.
 *
 * Stamped at delivery, set by the review, then either started (or queued) by a merge-quorum
 * completion or lapsed by an ending without one, including a plan PR closed unmerged.
 */

const NOW = 5_000_000;

function discovered(id: string, cwd: string): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: `agent-${id}`,
    nameSource: "process",
    cwd,
    gitBranch: "shape/work",
    gitRoot: "/repo",
    repoRoot: "/repo",
    pid: 100,
    tty: null,
    terminals: [],
    startedAt: 0,
  };
}

/** A running shape task bound to a discovered session's work episode, as a dispatch leaves it. */
function shaping(id: string, over: Partial<Task> = {}) {
  const registry = new Registry();
  const tasks = taskManager(registry);
  const taskId = `task-${id}`;
  const cwd = `/repo/${id}`;
  registry.applyDiscovery([discovered(id, cwd)]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: `${id}-episode`,
    cwd,
    transcriptPath: null,
    env: {},
  });
  registry.upsertTask(baseTask({
    id: taskId,
    title: `Shape ${id}`,
    kind: "shape",
    status: "running",
    sessionId: id,
    worktreePath: cwd,
    repoRoot: "/repo",
    workflowId: "builtin-workflow:plan-validation",
    ...over,
  }));
  registry.bindTaskToWorkEpisode(taskId, id);
  const episode = registry.workEpisodeForSession(id)!;
  return { registry, tasks, id, taskId, cwd, episode };
}

type Fixture = ReturnType<typeof shaping>;

/** Record a choice the way the review would, on a task stamped at delivery. */
function choose(f: Fixture, choice: "pending" | "stop"): void {
  assert.ok(stampShapeTicketsAwaitingReview({ id: f.taskId, kind: "shape" }));
  assert.ok(transitionShapeTicketsState(f.taskId, ["awaiting-review"], choice));
}

/** The plan PR merged on an episode of this task: the evidence every merge path completes on. */
function merged(f: Fixture, url: string): void {
  openDb()
    .prepare(
      `INSERT INTO historical_task_work_episode_bindings
         (task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha,
          merged_at, bound_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(f.taskId, `${f.id}-merged-episode`, f.id, f.id, "shape/work", url, "sha", NOW - 1, 1, 1);
}

/** The agent goes away, so the merge reconciler (not idleness) concludes the task. */
function agentGone(f: Fixture): void {
  f.registry.applyDiscovery([]);
  f.registry.emit("event", { type: "session_remove", id: f.id });
}

/** Let the background follow-up start finish its awaits. */
async function settled(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Make every dispatch accepted, without launching anything. */
function acceptDispatch(tasks: Fixture["tasks"]): string[] {
  const launched: string[] = [];
  tasks.backlogDispatchRefusal = () => null;
  (tasks as unknown as { dispatcher: { dispatch: (id: string) => Promise<void> } }).dispatcher = {
    dispatch: async (id) => {
      launched.push(id);
    },
  };
  return launched;
}

// ---------------------------------------------------------------------------
// Stamping and the review
// ---------------------------------------------------------------------------

test("only a shaping task delivered under the new contract is stamped; every other row stays empty", () => {
  const registry = new Registry();
  registry.upsertTask(baseTask({ id: "stamp-shape", kind: "shape" }));
  registry.upsertTask(baseTask({ id: "stamp-ship" }));
  registry.upsertTask(baseTask({ id: "stamp-followup", kind: "shape" }));
  reserveShapeTicketFollowup({
    followupTaskId: "stamp-followup",
    sourceTaskId: "stamp-shape",
    sourceEpisodeId: "e",
    sourceSessionId: "s",
    sourcePrUrl: "https://github.com/acme/demo/pull/1",
    now: 1,
  });

  assert.equal(shapeTicketsStateFor("stamp-shape"), null, "an existing row is empty");
  assert.equal(stampShapeTicketsAwaitingReview({ id: "stamp-ship", kind: "ship" }), false);
  assert.equal(stampShapeTicketsAwaitingReview({ id: "stamp-followup", kind: "shape" }), false, "a follow-up is never stamped");
  assert.equal(shapeTicketsStateFor("stamp-followup"), null);
  assert.equal(stampShapeTicketsAwaitingReview({ id: "stamp-shape", kind: "shape" }), true);
  assert.equal(shapeTicketsStateFor("stamp-shape"), "awaiting-review");
  registry.republishShapeTickets("stamp-shape");
  assert.equal(registry.getTask("stamp-shape")?.shapeTickets?.state, "awaiting-review", "the wire state reads the column");
  assert.equal(registry.getTask("stamp-ship")?.shapeTickets ?? null, null);

  // A retried dispatch keeps the choice an earlier review recorded.
  transitionShapeTicketsState("stamp-shape", ["awaiting-review"], "pending");
  assert.equal(stampShapeTicketsAwaitingReview({ id: "stamp-shape", kind: "shape" }), false);
  assert.equal(shapeTicketsStateFor("stamp-shape"), "pending");

  // A stale Task snapshot written back cannot undo it: the column is not `upsertTask`'s.
  registry.upsertTask({ ...registry.getTask("stamp-shape")!, title: "renamed" });
  assert.equal(shapeTicketsStateFor("stamp-shape"), "pending");
});

const FOLLOW_UP: PlanDecision = {
  id: SHAPE_FOLLOW_UP_DECISION_ID,
  question: "What should happen after this plan is approved?",
  options: [
    { id: "create-tickets", label: "Create tickets after the plan merges", recommended: true },
    { id: "stop", label: "Stop" },
  ],
};

test("a resolved plan review records pending or stop; the latest wins, a dismissal and an unstamped task are never written", () => {
  const f = shaping("review");
  const reviews = new ReviewManager(f.registry);
  const answer = (choice: string) => {
    const review = reviews.create(f.id, "plan-decisions", "Plan review", `# Plan ${Math.random()}`, [FOLLOW_UP]);
    reviews.resolve(review.id, "answer", choice, "human", [
      { decisionId: SHAPE_FOLLOW_UP_DECISION_ID, selected: [choice], other: null },
    ]);
  };

  // Unstamped: dispatched before the choice was recorded, so it files tickets in-session.
  answer("create-tickets");
  assert.equal(shapeTicketsStateFor(f.taskId), null, "an unstamped task is never written");

  stampShapeTicketsAwaitingReview({ id: f.taskId, kind: "shape" });
  answer("create-tickets");
  assert.equal(shapeTicketsStateFor(f.taskId), "pending");
  assert.equal(f.registry.getTask(f.taskId)?.shapeTickets?.state, "pending", "re-sent on the wire");

  answer("stop");
  assert.equal(shapeTicketsStateFor(f.taskId), "stop", "the latest resolved review wins");

  const dismissed = reviews.create(f.id, "plan-decisions", "Plan review", "# dismissed", [FOLLOW_UP]);
  reviews.resolve(dismissed.id, "dismiss", null, "human");
  assert.equal(shapeTicketsStateFor(f.taskId), "stop", "a dismissal writes nothing");

  answer("create-tickets");
  assert.equal(shapeTicketsStateFor(f.taskId), "pending");
});

// ---------------------------------------------------------------------------
// The merge starts the follow-up
// ---------------------------------------------------------------------------

test("merge-quorum completion of a pending shape task starts exactly one follow-up, then reads started", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = shaping("started");
  const launched = acceptDispatch(f.tasks);
  choose(f, "pending");
  // The bound workflow is still open: nothing reads its run state.
  merged(f, "https://github.com/acme/demo/pull/501");

  agentGone(f);
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  await settled();

  const followups = shapeTicketFollowupsForSource(f.taskId);
  assert.equal(followups.length, 1, "exactly one follow-up");
  const followup = f.registry.getTask(followups[0]!.followupTaskId)!;
  assert.equal(followup.title, `Tickets: Shape started`);
  assert.equal(followup.workflowId, null);
  assert.deepEqual(launched, [followup.id], "dispatched");
  assert.equal(shapeTicketsStateFor(f.taskId), "started");
  assert.deepEqual(f.registry.getTask(f.taskId)?.shapeTickets, {
    state: "started",
    followupTaskId: followup.id,
    canCreate: false,
  });

  // A replayed completion of the same task starts nothing more.
  await f.tasks.complete(f.taskId, "merged again");
  await settled();
  assert.equal(shapeTicketFollowupsForSource(f.taskId).length, 1);
});

test("a refused dispatch reads queued, and queued becomes started when that follow-up is dispatched later", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = shaping("queued");
  choose(f, "pending");
  merged(f, "https://github.com/acme/demo/pull/502");

  // The test daemon has every skill off, so the launch is refused.
  agentGone(f);
  await settled();
  const [relation] = shapeTicketFollowupsForSource(f.taskId);
  assert.ok(relation);
  const followup = f.registry.getTask(relation.followupTaskId)!;
  assert.equal(followup.status, "backlog");
  assert.match(followup.error ?? "", /skill/, "it waits with the reason");
  assert.equal(shapeTicketsStateFor(f.taskId), "queued");
  assert.equal(f.registry.getTask(f.taskId)?.shapeTickets?.state, "queued");

  const launched = acceptDispatch(f.tasks);
  const dispatched = await f.tasks.dispatch(followup.id);
  assert.equal(dispatched.ok, true);
  assert.deepEqual(launched, [followup.id]);
  assert.equal(shapeTicketsStateFor(f.taskId), "started");
  assert.equal(f.registry.getTask(f.taskId)?.shapeTickets?.state, "started");
});

test("a merge on a task that chose Stop, or recorded nothing, starts nothing", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  for (const [name, choice] of [["stopped", "stop"], ["unstamped", null]] as const) {
    const f = shaping(name);
    acceptDispatch(f.tasks);
    if (choice) choose(f, choice);
    merged(f, `https://github.com/acme/demo/pull/${name}`);
    agentGone(f);
    await settled();
    assert.equal(f.registry.getTask(f.taskId)?.status, "done");
    assert.deepEqual(shapeTicketFollowupsForSource(f.taskId), [], `${name}: nothing created`);
    assert.equal(shapeTicketsStateFor(f.taskId), choice);
  }
});

// ---------------------------------------------------------------------------
// Lapsing
// ---------------------------------------------------------------------------

test("completion or cancellation without the merge lapses a pending choice, and nothing is created", async () => {
  const completed = shaping("lapse-complete");
  choose(completed, "pending");
  await completed.tasks.complete(completed.taskId, "done by hand");
  await settled();
  assert.equal(shapeTicketsStateFor(completed.taskId), "lapsed");
  assert.equal(completed.registry.getTask(completed.taskId)?.shapeTickets?.state, "lapsed");
  assert.deepEqual(shapeTicketFollowupsForSource(completed.taskId), []);

  const cancelled = shaping("lapse-cancel");
  choose(cancelled, "pending");
  cancelled.registry.upsertTask({ ...cancelled.registry.getTask(cancelled.taskId)!, status: "cancelled" });
  assert.equal(shapeTicketsStateFor(cancelled.taskId), "lapsed");
  assert.deepEqual(shapeTicketFollowupsForSource(cancelled.taskId), []);

  // An agent that went away with no merge recorded fails the task, which lapses it too.
  const failed = shaping("lapse-failed");
  choose(failed, "pending");
  agentGone(failed);
  assert.equal(failed.registry.getTask(failed.taskId)?.status, "failed");
  assert.equal(shapeTicketsStateFor(failed.taskId), "lapsed");

  // Stop is not lapsed: there was nothing to create.
  const stopped = shaping("lapse-stop");
  choose(stopped, "stop");
  await stopped.tasks.complete(stopped.taskId, "done by hand");
  assert.equal(shapeTicketsStateFor(stopped.taskId), "stop");
});

test("a plan PR read CLOSED by the poller signals the task once and lapses a pending choice", async () => {
  const url = "https://github.com/acme/demo/pull/601";
  const f = shaping("closed");
  choose(f, "pending");
  // The live session's branch lookup observed the PR open, so the binding carries it.
  f.registry.reconcilePrs(
    new Map([[f.id, {
      url,
      number: 601,
      state: "open" as const,
      checks: null,
      branch: "shape/work",
      agentSessionId: `${f.id}-episode`,
      episodeId: f.episode.episodeId,
      createdAt: f.episode.startedAt,
      mergedAt: null,
      headSha: "head",
      worktreeHeadSha: "head",
    }]]),
    new Set(),
  );
  assert.ok(f.registry.taskPrPollTargets().includes(url));
  const closures: string[] = [];
  f.registry.onTaskPrClosed((e) => closures.push(`${e.taskId} ${e.url}`));

  // Open and merged by URL emit nothing.
  await pollAndReconcilePrs(f.registry, async () => null, async () => ({ state: "open" as const, mergedAt: null }));
  assert.deepEqual(closures, []);
  assert.equal(shapeTicketsStateFor(f.taskId), "pending");

  // The branch lookup drops a closed PR as "no PR"; the by-URL lookup reads its raw CLOSED,
  // here through the real `gh pr view` path against a fake gh.
  process.env.HARNESS_GH_BIN = fakeGh;
  try {
    await pollAndReconcilePrs(f.registry, async () => null, undefined, undefined, NOW);
    await pollAndReconcilePrs(f.registry, async () => null, undefined, undefined, NOW + 60 * 60_000);
  } finally {
    delete process.env.HARNESS_GH_BIN;
  }
  assert.deepEqual(closures, [`${f.taskId} ${url}`], "once, however often it is re-polled");
  assert.equal(shapeTicketsStateFor(f.taskId), "lapsed");
  assert.equal(f.registry.getTask(f.taskId)?.status, "running", "a closed PR does not end the task");
  assert.deepEqual(shapeTicketFollowupsForSource(f.taskId), [], "nothing is created");

  // A replacement PR on the same task merges later: the lapsed choice still starts it.
  setShippingConfig({ closeSessionAfterMerge: false });
  const launched = acceptDispatch(f.tasks);
  const replacement = "https://github.com/acme/demo/pull/602";
  // The agent went away with its PR closed, so the task failed; the choice stays lapsed.
  agentGone(f);
  assert.equal(f.registry.getTask(f.taskId)?.status, "failed");
  assert.equal(shapeTicketsStateFor(f.taskId), "lapsed");
  // A recovery session reopens the work on a new episode, and its PR merges.
  bindTaskWorkEpisode({
    taskId: f.taskId,
    episodeId: `${f.id}-recovery`,
    sessionId: `${f.id}-recovery-session`,
    agentSessionId: `agent:${f.id}-recovery`,
    branch: "shape/work-2",
    prUrl: replacement,
    prHeadSha: "b".repeat(40),
    mergedAt: NOW,
    boundAt: NOW - 10,
    updatedAt: NOW,
  });
  f.tasks.reconcileMergedTasks();
  await settled();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  assert.equal(shapeTicketFollowupsForSource(f.taskId).length, 1);
  assert.equal(shapeTicketFollowupsForSource(f.taskId)[0]?.sourcePrUrl, replacement);
  assert.equal(launched.length, 1);
  assert.equal(shapeTicketsStateFor(f.taskId), "started");
});

test("a merged PR emits no closure", async () => {
  const url = "https://github.com/acme/demo/pull/603";
  const f = shaping("merged-no-close");
  choose(f, "pending");
  const closures: string[] = [];
  f.registry.onTaskPrClosed((e) => closures.push(e.url));
  await pollAndReconcilePrs(f.registry, async () => null, async (candidate) =>
    candidate === url ? { state: "merged" as const, mergedAt: NOW } : null);
  assert.deepEqual(closures, []);
  assert.equal(shapeTicketsStateFor(f.taskId), "pending");
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test("opening a pre-feature database adds the choice column, and existing rows read empty", () => {
  const run = (script: string): string =>
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, SHAPE_CHOICE_MIGRATION_HOME: migrationHome },
      encoding: "utf8",
    }).trim();
  run(`
    process.env.HARNESS_HOME = process.env.SHAPE_CHOICE_MIGRATION_HOME;
    const { openDb } = await import("./src/server/db.ts");
    const db = openDb();
    db.prepare("INSERT INTO tasks (id, title, intent, kind, agent, status, repo_root, created_at, updated_at) VALUES ('old-shape', 't', 'i', 'shape', 'claude', 'running', '/repo', 1, 1)").run();
    db.exec("ALTER TABLE tasks DROP COLUMN shape_tickets");
    db.close();
  `);
  const inspect = run(`
    process.env.HARNESS_HOME = process.env.SHAPE_CHOICE_MIGRATION_HOME;
    const { openDb, shapeTicketsStateFor } = await import("./src/server/db.ts");
    const db = openDb();
    const columns = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
    console.log(JSON.stringify({ has: columns.includes("shape_tickets"), state: shapeTicketsStateFor("old-shape") }));
  `);
  assert.deepEqual(JSON.parse(inspect.split("\n").at(-1)!), { has: true, state: null });
});
