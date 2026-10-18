import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { ServerEvent, Session, Task } from "../src/shared/types.ts";
import type { SdkExitCause } from "../src/server/harness/types.ts";
import type { TaskArchiveGate } from "../src/server/tasks.ts";

// Slice 3 of the session OOM isolation plan: a driver's `exited` cause rides `beginEviction`,
// outlives the row, and becomes the task's failure text. Driven through the real Registry and
// TaskManager; only the clock is mocked, so the 8 s linger and the 60 s drop can be walked.

const home = mkdtempSync(join(tmpdir(), "mission-oom-exit-cause-"));
process.env.HARNESS_HOME = home;
const { Registry, EXIT_CAUSE_TTL_MS } = await import("../src/server/registry.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { openDb } = await import("../src/server/db.ts");
after(() => rmSync(home, { recursive: true, force: true }));

/** `EXIT_LINGER_MS` in `registry.ts`: how long an exited card stays before `session_remove`. */
const LINGER_MS = 8000;
const OOM: SdkExitCause = { kind: "out_of_memory", peakBytes: 1610612736 };
const OOM_TEXT = "stopped: the session ran out of memory (peak 1.5 GB)";
const KEPT = " - use Clean up or re-dispatch for any retained worktrees";

let seq = 0;

/** A live SDK session bound to a running task, and every event the registry emits for it. */
function bound(t: TestContext, over: Partial<Task> = {}, gate?: TaskArchiveGate) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  setShippingConfig({ closeSessionAfterMerge: false });
  const registry = new Registry();
  const tasks = new TaskManager(registry, undefined, undefined, undefined, gate);
  const id = `sdk:oom-${++seq}`;
  const taskId = `task-oom-${seq}`;
  const cwd = join(home, `wt-${seq}`);
  registry.registerSdkSession({ id, agent: "claude", name: "agent", cwd });
  registry.upsertTask(mkTask({
    id: taskId,
    title: "Ship the thing",
    status: "running",
    sessionId: id,
    worktreePath: cwd,
    homeName: "Ship the thing",
    repoRoot: "/repo",
    ...over,
  }));
  const events: ServerEvent[] = [];
  registry.subscribe((e) => {
    if ((e.type === "session_remove" && e.id === id) || (e.type === "session_upsert" && e.session.id === id)) events.push(e);
  });
  const exits: Session[] = [];
  registry.onSessionExit((s) => {
    if (s.id === id) exits.push(s);
  });
  return { registry, tasks, id, taskId, events, exits };
}

/** A historical binding whose pull request merged, the evidence `mergeOutcomeFor` reads. */
function mergedPr(taskId: string, sessionId: string, url: string): void {
  openDb()
    .prepare(
      `INSERT INTO historical_task_work_episode_bindings
         (task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha,
          merged_at, bound_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(taskId, `episode-${taskId}`, sessionId, sessionId, "feat/work", url, "sha", 2000, 1, 1);
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("an exited event with an out_of_memory cause fails the task with the out-of-memory text", (t) => {
  const f = bound(t);
  f.registry.applyDriverEvent(f.id, { kind: "exited", reason: "Claude Code process exited with code 143", resumable: true, cause: OOM });
  assert.equal(f.registry.getTask(f.taskId)?.status, "running", "nothing settles before session_remove");
  t.mock.timers.tick(LINGER_MS);
  const task = f.registry.getTask(f.taskId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error, `${OOM_TEXT}${KEPT}`);
  assert.equal(task.sessionId, null);
});

test("without a peak the parenthetical is dropped, and without retained resources so is the suffix", (t) => {
  const f = bound(t, { worktreePath: null, homeName: null });
  f.registry.applyDriverEvent(f.id, { kind: "exited", reason: "ended", resumable: false, cause: { kind: "out_of_memory", peakBytes: null } });
  t.mock.timers.tick(LINGER_MS);
  assert.equal(f.registry.getTask(f.taskId)?.error, "stopped: the session ran out of memory");
});

test("without a cause the failure text is unchanged", (t) => {
  const f = bound(t);
  f.registry.applyDriverEvent(f.id, { kind: "exited", reason: "the session ended", resumable: true });
  t.mock.timers.tick(LINGER_MS);
  const task = f.registry.getTask(f.taskId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error, `the agent's session ended with no outcome recorded${KEPT}`);
});

test("takeExitCause returns the cause once after session_remove", (t) => {
  // No running task: nothing takes the cause before this test does.
  const f = bound(t);
  f.registry.upsertTask({ ...f.registry.getTask(f.taskId)!, status: "done", sessionId: null });
  f.registry.applyDriverEvent(f.id, { kind: "exited", reason: "ended", resumable: true, cause: OOM });
  t.mock.timers.tick(LINGER_MS);
  assert.equal(f.registry.getSession(f.id), undefined, "the row is gone");
  assert.deepEqual(f.registry.takeExitCause(f.id), OOM);
  assert.equal(f.registry.takeExitCause(f.id), null, "a second read finds nothing");
});

test("an exit cause nobody takes is dropped 60 s after session_remove", (t) => {
  // A session with no task keeps only the log line: nothing ever takes its cause.
  const g = bound(t);
  g.registry.upsertTask({ ...g.registry.getTask(g.taskId)!, status: "done", sessionId: null });
  g.registry.applyDriverEvent(g.id, { kind: "exited", reason: "ended", resumable: true, cause: OOM });
  t.mock.timers.tick(LINGER_MS);
  t.mock.timers.tick(EXIT_CAUSE_TTL_MS - 1);
  t.mock.timers.tick(1);
  assert.equal(EXIT_CAUSE_TTL_MS, 60_000);
  assert.equal(g.registry.takeExitCause(g.id), null, "dropped 60 s after session_remove");
});

test("an entry is still there just inside the 60 s window", (t) => {
  const f = bound(t);
  f.registry.upsertTask({ ...f.registry.getTask(f.taskId)!, status: "done", sessionId: null });
  f.registry.applyDriverEvent(f.id, { kind: "exited", reason: "ended", resumable: true, cause: OOM });
  t.mock.timers.tick(LINGER_MS + EXIT_CAUSE_TTL_MS - 1);
  assert.deepEqual(f.registry.takeExitCause(f.id), OOM);
});

test("a scout task that settles a beat after session_remove still gets the out-of-memory text", async (t) => {
  // A scout whose pull request merged but whose report was never archived: `agentWentAway`
  // tries the completion, the archive gate refuses it, and `settleAgentGone` runs only then.
  // The gate is held open across `session_remove` and half the drop window.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let asked = false;
  const gate: TaskArchiveGate = {
    ensureReady: async () => {
      asked = true;
      await held;
      return { ok: false, problems: ["no report was submitted"] };
    },
    settleBeforeCleanup: async () => ({ ok: true }),
  };
  const f = bound(t, { kind: "scout", branch: null }, gate);
  mergedPr(f.taskId, f.id, "https://github.com/example/repo/pull/901");
  f.registry.applyDriverEvent(f.id, { kind: "exited", reason: "ended", resumable: true, cause: OOM });
  t.mock.timers.tick(LINGER_MS);
  for (let i = 0; i < 20 && !asked; i++) await flush();
  assert.ok(asked, "the completion reached the archive gate");
  assert.equal(f.registry.getTask(f.taskId)?.status, "running", "not settled while the gate is held");

  t.mock.timers.tick(EXIT_CAUSE_TTL_MS / 2);
  release();
  for (let i = 0; i < 20 && f.registry.getTask(f.taskId)?.status === "running"; i++) await flush();
  const task = f.registry.getTask(f.taskId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error, `${OOM_TEXT}${KEPT}`);
});

test("a merged pull request still settles done, cause or not", async (t) => {
  const f = bound(t);
  const url = "https://github.com/example/repo/pull/902";
  mergedPr(f.taskId, f.id, url);
  f.registry.applyDriverEvent(f.id, { kind: "exited", reason: "ended", resumable: true, cause: OOM });
  t.mock.timers.tick(LINGER_MS);
  for (let i = 0; i < 20 && f.registry.getTask(f.taskId)?.status === "running"; i++) await flush();
  const task = f.registry.getTask(f.taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.outcomeUrl, url);
  assert.equal(task.error, null);
});

test("eviction goes through beginEviction alone, and session_exit and session_remove keep their shapes", (t) => {
  const f = bound(t);
  f.registry.applyDriverEvent(f.id, { kind: "exited", reason: "ended", resumable: true, cause: OOM });
  // The supervisor's repeat after the stream ends, which carries no cause, changes nothing.
  f.registry.applyDriverEvent(f.id, { kind: "exited", reason: "driver ended", resumable: false });
  t.mock.timers.tick(LINGER_MS);
  assert.equal(f.exits.length, 1, "one session_exit");
  assert.equal(f.exits[0]!.state, "exited");
  assert.equal("cause" in f.exits[0]!, false, "the session carries no cause");
  const removes = f.events.filter((e) => e.type === "session_remove");
  assert.deepEqual(removes, [{ type: "session_remove", id: f.id }], "one session_remove, still just its id");
  for (const e of f.events) {
    if (e.type === "session_upsert") assert.equal("cause" in e.session, false);
  }
  assert.equal(f.registry.getTask(f.taskId)?.error, `${OOM_TEXT}${KEPT}`, "the repeat did not clear the cause");
});
