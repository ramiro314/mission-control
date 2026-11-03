import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * History Resume: the launch record that claims a session before anything else happens, its
 * binding to the session discovery registers, every way an open launch closes, and the routes
 * that refuse with a reason. The terminal is a fake launcher, so nothing opens a window, and
 * every transcript is a fixture in a temp projects directory.
 */

const home = mkdtempSync(join(tmpdir(), "mission-history-resume-"));
process.env.MISSION_HOME = home;

const { createClaudeHistory } = await import("../src/server/harness/claude/history.ts");
const { HistoryService } = await import("../src/server/history/service.ts");
const { HistoryResumeLaunches, trackHistoryResumeLaunches } = await import("../src/server/history/resume-launches.ts");
const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { TerminalLaunchError } = await import("../src/server/terminal/launch-error.ts");
const { managedResumeRoot, recheckManagedResumes, revokeUnclaimedResumes } = await import("../src/server/harness/resume.ts");
const { beginResumeLaunch, claimResumeLease, createResumeLease } = await import("../src/server/terminal/resume-lease.ts");
import { historyResumeCheckoutWarning, type HistoryResumeOptions } from "../src/shared/history.ts";
import type { ServerEvent } from "../src/shared/types.ts";
import type { HistoryResumeLauncher, HistoryResumeSession } from "../src/server/history/resume.ts";
import type { HistoryResumeCandidate } from "../src/server/history/resume-launches.ts";
import type { HistoryResumeSlots } from "../src/server/history/resume-slots.ts";
import type { PreparedResume } from "../src/server/harness/resume.ts";
import type { TerminalLaunchOutcome } from "../src/server/terminal/targets.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";

const LOOPBACK = { host: "127.0.0.1:7317", "content-type": "application/json" };
const GRACE = 10_000;
let ordinal = 0;

function sessionId(): string {
  ordinal += 1;
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

function reset(): void {
  openDb().exec(
    "DELETE FROM history_sessions; DELETE FROM history_resume_launches; DELETE FROM worktree_slot_history; " +
      "DELETE FROM worktree_slots; DELETE FROM worktree_pools",
  );
}

/** A directory that exists, under the worker's temp dir. */
function directory(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "mission-history-resume-dir-")), name);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

/** A two-turn transcript recorded in `cwd`, of `kind` (an SDK prompt snapshot for one-shot). */
function writeConversation(
  projects: string,
  id: string,
  cwd: string,
  extra: { oneShot?: boolean; mode?: string; branch?: string } = {},
): string {
  const dir = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const base = {
    sessionId: id,
    cwd,
    entrypoint: extra.oneShot ? "sdk-cli" : "cli",
    version: "2.1.296",
    gitBranch: extra.branch ?? "main",
    isSidechain: false,
  };
  const lines: unknown[] = [];
  if (extra.mode) lines.push({ type: "permission-mode", permissionMode: "default", sessionId: id });
  if (extra.oneShot) {
    lines.push({
      ...base,
      timestamp: "2026-10-20T10:00:00.000Z",
      type: "attachment",
      attachment: { type: "prompt_snapshot", cliPrefix: "You are a Claude agent", tools: [], systemPrompt: [] },
    });
  }
  lines.push({ ...base, timestamp: "2026-10-20T10:00:00.000Z", uuid: `u-${id}`, type: "user", message: { role: "user", content: "hello" } });
  lines.push({
    ...base,
    timestamp: "2026-10-20T10:00:01.000Z",
    uuid: `a-${id}`,
    type: "assistant",
    message: { id: `m-${id}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "hi" }] },
  });
  if (extra.mode) lines.push({ type: "permission-mode", permissionMode: extra.mode, sessionId: id });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

/** A launcher that records what it was asked and answers as scripted. */
function fakeLauncher(script: {
  host?: string | null;
  prepare?: (session: HistoryResumeSession) => Promise<void> | void;
  launch?: () => Promise<TerminalLaunchOutcome> | TerminalLaunchOutcome;
} = {}) {
  const prepared: HistoryResumeSession[] = [];
  const disposed: string[] = [];
  const launched: { backend: string; cwd: string }[] = [];
  const abandoned: string[] = [];
  const launcher: HistoryResumeLauncher = {
    hostUnavailable: () => script.host ?? null,
    async prepare(session) {
      await script.prepare?.(session);
      prepared.push(session);
      return { cwd: session.cwd, dispose: () => { disposed.push(session.id); return true; } } as unknown as PreparedResume;
    },
    async launch(backend, input) {
      launched.push({ backend, cwd: input.prepared.cwd });
      return script.launch ? script.launch() : { ok: true, label: "cmux", status: 200 };
    },
    abandon: (owner) => { abandoned.push(owner); },
  };
  return { launcher, prepared, launched, abandoned, disposed };
}

async function fixture(
  launcher: HistoryResumeLauncher = fakeLauncher().launcher,
  registry = new Registry(),
  pool: { repository?: string | null; slots?: HistoryResumeSlots } = {},
) {
  reset();
  const projects = mkdtempSync(join(tmpdir(), "mission-history-resume-projects-"));
  const history = new HistoryService({
    readers: [{ agent: "claude", spec: createClaudeHistory(projects) }],
    resolveRepository: () => pool.repository ?? null,
  });
  const app = buildApp({
    registry,
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
    history,
    historyResumeLauncher: launcher,
    ...(pool.slots ? { historyResumeSlots: pool.slots } : {}),
  });
  const get = (path: string) => app.request(path, { headers: LOOPBACK });
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: LOOPBACK, body: JSON.stringify(body) });
  const resume = (id: string) => post(`/api/history/sessions/claude/${id}/resume`, { backend: "cmux", target: { kind: "original" } });
  const options = async (id: string) => (await (await get(`/api/history/sessions/claude/${id}/resume-options`)).json()) as HistoryResumeOptions;
  return { projects, history, registry, get, post, resume, options, done: () => rmSync(projects, { recursive: true, force: true }) };
}

function candidate(id: string, agentSessionId: string, cwd: string): HistoryResumeCandidate {
  return { id, agent: "claude", agentSessionId, cwd };
}

// ---- the launch record ----

test("the insert is the claim: a second open launch of one session is refused with the first", () => {
  reset();
  const launches = new HistoryResumeLaunches();
  const id = sessionId();
  const first = launches.claim({ agent: "claude", sourceSessionId: id, expectedAgentSessionId: id, cwd: "/work" }, 1);
  assert.equal(first.ok, true);
  const second = launches.claim({ agent: "claude", sourceSessionId: id, expectedAgentSessionId: id, cwd: "/elsewhere" }, 2);
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.open.launchId, first.ok && first.launch.launchId);
  assert.equal(openDb().prepare("SELECT COUNT(*) AS n FROM history_resume_launches").get()!.n, 1);
  // Once the first closes, the session can be claimed again.
  assert.equal(launches.release(first.ok ? first.launch.launchId : "", 3), true);
  assert.equal(launches.claim({ agent: "claude", sourceSessionId: id, expectedAgentSessionId: id, cwd: "/work" }, 4).ok, true);
});

test("a launch binds only to a session with its expected id in its own directory, through symlinks", () => {
  reset();
  const launches = new HistoryResumeLaunches();
  const id = sessionId();
  const cwd = directory("original");
  const alias = join(directory("links"), "alias");
  symlinkSync(cwd, alias);
  const claimed = launches.claim({ agent: "claude", sourceSessionId: id, expectedAgentSessionId: id, cwd }, 1);
  assert.ok(claimed.ok);

  assert.deepEqual(launches.bind(candidate("other-dir", id, directory("sibling")), 2), [], "the right id in another directory binds nothing");
  assert.deepEqual(launches.bind(candidate("other-id", sessionId(), cwd), 2), [], "another id in the right directory binds nothing");
  assert.equal(launches.get(claimed.launch.launchId)!.state, "pending");

  const [bound] = launches.bind(candidate("term:resumed", id, alias), 3);
  assert.equal(bound?.state, "bound");
  assert.equal(bound?.mcSessionId, "term:resumed");
  assert.equal(launches.open("claude", id), null, "a bound launch is no longer open");

  assert.deepEqual(launches.sessionRemoved("term:resumed", 4).map((launch) => launch.state), ["ended"]);
});

test("a slotless launch is released past its grace window; one with a slot expires and keeps it, and still binds late", () => {
  reset();
  const launches = new HistoryResumeLaunches();
  const slotless = sessionId();
  const slotted = sessionId();
  const a = launches.claim({ agent: "claude", sourceSessionId: slotless, expectedAgentSessionId: slotless, cwd: "/a" }, 1_000);
  const b = launches.claim({ agent: "claude", sourceSessionId: slotted, expectedAgentSessionId: slotted, cwd: "/b", slotId: "slot-1" }, 1_000);
  assert.ok(a.ok && b.ok);

  assert.deepEqual(launches.expire(1_000 + GRACE - 1, GRACE), [], "inside the window nothing closes");
  const closed = launches.expire(1_000 + GRACE, GRACE);
  assert.deepEqual(closed.map((launch) => [launch.launchId, launch.state]).sort(), [
    [a.launch.launchId, "released"],
    [b.launch.launchId, "expired"],
  ].sort());
  assert.equal(launches.inStates(["expired"]).every((launch) => launch.slotId !== null), true, "no slotless launch is ever left expired");
  assert.equal(launches.claim({ agent: "claude", sourceSessionId: slotless, expectedAgentSessionId: slotless, cwd: "/a" }, 20_000).ok, true,
    "a released launch never blocks the next Resume");
  assert.equal(launches.claim({ agent: "claude", sourceSessionId: slotted, expectedAgentSessionId: slotted, cwd: "/b" }, 20_000).ok, false,
    "an expired launch still holds its session");
  assert.equal(launches.bind(candidate("late", slotted, "/b"), 30_000)[0]?.state, "bound", "an agent that appears after expiry still binds");
});

test("Cancel pending resume closes a pending slotless launch at once, and nothing else", () => {
  reset();
  const launches = new HistoryResumeLaunches();
  const id = sessionId();
  const claimed = launches.claim({ agent: "claude", sourceSessionId: id, expectedAgentSessionId: id, cwd: "/a" }, 1);
  assert.ok(claimed.ok);
  const cancelled = launches.cancel(claimed.launch.launchId, 2);
  assert.equal(cancelled.ok && cancelled.launch.state, "released");
  assert.equal(launches.cancel(claimed.launch.launchId, 3).ok, false, "a released launch is no longer pending");
  assert.deepEqual(launches.cancel("00000000-0000-4000-8000-ffffffffffff", 3), { ok: false, reason: "not_found" });

  const slotted = sessionId();
  const withSlot = launches.claim({ agent: "claude", sourceSessionId: slotted, expectedAgentSessionId: slotted, cwd: "/b", slotId: "slot-1" }, 1);
  assert.ok(withSlot.ok);
  const refused = launches.cancel(withSlot.launch.launchId, 2);
  assert.equal(!refused.ok && refused.reason, "has_slot");
  assert.equal(launches.get(withSlot.launch.launchId)!.state, "pending");
});

test("the startup twin binds running agents, ends bound launches that stopped, and closes pending ones by slot", () => {
  reset();
  const launches = new HistoryResumeLaunches();
  const ids = { running: sessionId(), stopped: sessionId(), slotless: sessionId(), slotted: sessionId(), fresh: sessionId() };
  const claim = (id: string, at: number, slotId: string | null = null) => {
    const claimed = launches.claim({ agent: "claude", sourceSessionId: id, expectedAgentSessionId: id, cwd: `/${id}`, slotId }, at);
    assert.ok(claimed.ok);
    return claimed.launch.launchId;
  };
  const running = claim(ids.running, 1);
  const stopped = claim(ids.stopped, 1);
  launches.bind(candidate("term:stopped", ids.stopped, `/${ids.stopped}`), 2);
  const slotless = claim(ids.slotless, 1);
  const slotted = claim(ids.slotted, 1, "slot-1");
  // Made by this daemon while its first sweep ran: not judged.
  const fresh = claim(ids.fresh, 100);

  launches.startup([candidate("term:running", ids.running, `/${ids.running}`)], 200, 50);
  assert.equal(launches.get(running)!.state, "bound");
  assert.equal(launches.get(stopped)!.state, "ended", "a bound launch whose session ended while the daemon was down");
  assert.equal(launches.get(slotless)!.state, "released", "a pending slotless launch is released, never expired");
  assert.equal(launches.get(slotted)!.state, "expired", "a pending launch with a slot expires and keeps it");
  assert.equal(launches.get(fresh)!.state, "pending");
});

test("the tracker binds on session_upsert, ends on session_remove, and runs the startup twin after the first sweep", async () => {
  reset();
  const launches = new HistoryResumeLaunches();
  const listeners: ((event: ServerEvent) => void)[] = [];
  let observed: (() => void) | null = null;
  const live: HistoryResumeCandidate[] = [];
  const registry = {
    subscribe: (fn: (event: ServerEvent) => void) => { listeners.push(fn); return () => {}; },
    onSessionsObserved: (fn: () => void) => { observed = fn; return () => {}; },
    liveSessions: () => live,
  };
  let now = 1_000;
  const before = sessionId();
  const earlier = launches.claim({ agent: "claude", sourceSessionId: before, expectedAgentSessionId: before, cwd: "/before" }, 10);
  assert.ok(earlier.ok);
  const stop = trackHistoryResumeLaunches(launches, registry, { graceMs: GRACE, tickMs: 60_000, now: () => now });
  try {
    const id = sessionId();
    const claimed = launches.claim({ agent: "claude", sourceSessionId: id, expectedAgentSessionId: id, cwd: "/work" }, now);
    assert.ok(claimed.ok);
    const session = { id: "term:1", agent: "claude", agentSessionId: id, cwd: "/work" } as unknown as import("../src/shared/types.ts").Session;
    for (const fn of listeners) fn({ type: "session_upsert", session });
    assert.equal(launches.get(claimed.launch.launchId)!.state, "bound");
    for (const fn of listeners) fn({ type: "session_remove", id: "term:1" });
    assert.equal(launches.get(claimed.launch.launchId)!.state, "ended");

    now = 2_000;
    observed!();
    assert.equal(launches.get(earlier.launch.launchId)!.state, "released", "the previous run's pending launch is closed at the first sweep");
  } finally {
    stop();
  }
});

test("a real Registry session binds its launch through the daemon's own wiring", async () => {
  const registry = new Registry();
  const f = await fixture(undefined, registry);
  try {
    const id = sessionId();
    const cwd = directory("work");
    writeConversation(f.projects, id, cwd);
    await f.history.reconciler.trigger();
    f.history.trackResumes(registry);
    assert.equal((await f.resume(id)).status, 200);
    registry.registerSdkSession({ id: "sdk:resumed", agent: "claude", name: "resumed", cwd, agentSessionId: id });
    const [launch] = f.history.launches.inStates(["bound"]);
    assert.equal(launch?.mcSessionId, "sdk:resumed");
    assert.equal(launch?.sourceSessionId, id);
  } finally {
    f.history.stop();
    f.done();
  }
});

// ---- the routes ----

test("resume-options reports the original directory's status and the open launch", async () => {
  const f = await fixture();
  try {
    const usable = sessionId();
    const cwd = directory("usable");
    writeConversation(f.projects, usable, cwd);
    const missing = sessionId();
    writeConversation(f.projects, missing, join(directory("parent"), "deleted"));
    const pooled = sessionId();
    const pool = directory("pool");
    const slot = join(pool, "1", "repo");
    mkdirSync(slot, { recursive: true });
    openDb().prepare(
      `INSERT INTO worktree_pools (id, git_common_dir, main_checkout_root, pool_path, created_at, updated_at)
       VALUES ('pool-1', '/repo/.git', '/repo', ?, 1, 1)`,
    ).run(pool);
    writeConversation(f.projects, pooled, slot);
    await f.history.reconciler.trigger();

    const ready = await f.options(usable);
    assert.deepEqual(ready.original, { cwd, resolved: cwd, state: "usable", slot: null, refusal: null });
    assert.equal(ready.refusal, null);
    assert.equal(ready.openLaunch, null);
    assert.equal(ready.picker, null, "a usable original needs no picker");

    // A directory that is gone or reused refuses the original only: the picker offers a typed
    // directory, and nothing refuses the session as a whole.
    const gone = await f.options(missing);
    assert.equal(gone.original.state, "missing");
    assert.equal(gone.original.refusal?.code, "directory_missing");
    assert.equal(gone.refusal, null);
    assert.deepEqual(gone.picker, { directory: true, slots: [] });

    // Inside a pool, but no slot the manager knows: reused, and with no repository resolved
    // there is no slot to offer instead.
    const inPool = await f.options(pooled);
    assert.equal(inPool.original.state, "slot_reused");
    assert.equal(inPool.original.refusal?.code, "slot_reused");
    assert.equal(inPool.refusal, null);
    assert.deepEqual(inPool.picker, { directory: true, slots: [] });

    assert.equal((await f.resume(usable)).status, 200);
    const open = await f.options(usable);
    assert.equal(open.openLaunch?.cwd, cwd);
    assert.equal(open.refusal?.code, "open_launch");
    assert.match(open.refusal!.error, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(open.picker, null, "a refusal of the whole session offers no picker");

    assert.equal((await f.get(`/api/history/sessions/claude/${sessionId()}/resume-options`)).status, 404);
  } finally {
    f.done();
  }
});

test("Resume resolves the directory once: the launch, the binding key and the terminal all use the real path", async () => {
  const { launcher, prepared, launched } = fakeLauncher();
  const f = await fixture(launcher);
  try {
    const real = directory("real");
    const alias = join(directory("aliases"), "alias");
    symlinkSync(real, alias);
    const id = sessionId();
    writeConversation(f.projects, id, alias, { mode: "acceptEdits" });
    await f.history.reconciler.trigger();

    const res = await f.resume(id);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: true; launch: { cwd: string; state: string; expectedAgentSessionId: string }; label: string };
    assert.equal(body.launch.cwd, real);
    assert.equal(body.launch.state, "pending");
    assert.equal(body.launch.expectedAgentSessionId, id);
    assert.equal(body.label, "cmux");
    assert.deepEqual(prepared, [{
      id: prepared[0]!.id,
      agent: "claude",
      agentSessionId: id,
      permissionMode: "acceptEdits",
      cwd: real,
      runtime: "terminal",
      forkSessionId: null,
    }], "prepared from the catalog row, carrying the recorded mode, in the resolved directory");
    assert.match(prepared[0]!.id, /^history-resume:/);
    assert.deepEqual(launched, [{ backend: "cmux", cwd: real }]);
  } finally {
    f.done();
  }
});

test("two concurrent Resumes produce one launch row and one refusal, and the loser starts no terminal", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { launcher, prepared, launched } = fakeLauncher({ prepare: () => gate });
  const f = await fixture(launcher);
  try {
    const id = sessionId();
    writeConversation(f.projects, id, directory("work"));
    await f.history.reconciler.trigger();

    // Whichever wins the claim holds it while it prepares, so the one that settles while the
    // gate is shut is the loser, whatever order the two reached the insert in.
    const a = Promise.resolve(f.resume(id));
    const b = Promise.resolve(f.resume(id));
    const loser = await Promise.race([a, b]);
    assert.equal(loser.status, 409);
    release();
    const responses = await Promise.all([a, b]);
    const statuses = responses.map((res) => res.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    const refused = (await responses.find((res) => res.status === 409)!.json()) as { code: string; launch: { launchId: string } };
    assert.equal(refused.code, "open_launch");
    assert.equal(openDb().prepare("SELECT COUNT(*) AS n FROM history_resume_launches").get()!.n, 1);
    assert.equal(prepared.length, 1);
    assert.equal(launched.length, 1);
  } finally {
    f.done();
  }
});

test("a failed later step releases the launch, so the next Resume runs", async () => {
  let attempt = 0;
  const { launcher, launched } = fakeLauncher({
    prepare: () => { attempt += 1; if (attempt === 1) throw new Error("guard is not built"); },
    launch: () => (launched.length === 1 ? { ok: false, label: "cmux", status: 409, error: "cmux refused" } : { ok: true, label: "cmux", status: 200 }),
  });
  const f = await fixture(launcher);
  try {
    const id = sessionId();
    writeConversation(f.projects, id, directory("work"));
    await f.history.reconciler.trigger();

    const failedPrepare = await f.resume(id);
    assert.equal(failedPrepare.status, 409);
    assert.equal(((await failedPrepare.json()) as { code: string }).code, "launch_failed");
    const refusedLaunch = await f.resume(id);
    assert.equal(((await refusedLaunch.json()) as { code: string; error: string }).error, "cmux refused");
    assert.equal(f.history.launches.inStates(["released"]).length, 2);
    assert.equal((await f.resume(id)).status, 200);
  } finally {
    f.done();
  }
});

test("a terminal whose outcome is unknown keeps the launch open", async () => {
  const { launcher } = fakeLauncher({ launch: () => { throw new TerminalLaunchError("no answer", true); } });
  const f = await fixture(launcher);
  try {
    const id = sessionId();
    writeConversation(f.projects, id, directory("work"));
    await f.history.reconciler.trigger();
    const res = await f.resume(id);
    assert.equal(res.status, 504);
    assert.equal(((await res.json()) as { code: string }).code, "launch_unknown");
    assert.equal(f.history.launches.open("claude", id)?.state, "pending");
  } finally {
    f.done();
  }
});

test("refusals are explicit, and none of them claims the session", async () => {
  const registry = new Registry();
  const hostless = fakeLauncher({ host: "cmux cannot host an agent" });
  const f = await fixture(hostless.launcher, registry);
  try {
    const gone = sessionId();
    const goneDir = directory("gone");
    const path = writeConversation(f.projects, gone, goneDir);
    const live = sessionId();
    const liveDir = directory("live");
    writeConversation(f.projects, live, liveDir);
    const oneShot = sessionId();
    writeConversation(f.projects, oneShot, directory("one-shot"), { oneShot: true });
    const missing = sessionId();
    writeConversation(f.projects, missing, join(directory("parent"), "deleted"));
    const ready = sessionId();
    writeConversation(f.projects, ready, directory("ready"));
    await f.history.reconciler.trigger();
    rmSync(path);
    await f.history.reconciler.trigger();
    registry.registerSdkSession({ id: "sdk:live", agent: "claude", name: "running", cwd: liveDir, agentSessionId: live });

    const refusal = async (id: string) => {
      const res = await f.resume(id);
      return { status: res.status, code: ((await res.json()) as { code: string }).code };
    };
    assert.deepEqual(await refusal(gone), { status: 410, code: "transcript_gone" });
    assert.deepEqual(await refusal(live), { status: 409, code: "live" });
    assert.deepEqual(await refusal(oneShot), { status: 409, code: "not_conversation" });
    assert.deepEqual(await refusal(missing), { status: 409, code: "directory_missing" });
    assert.deepEqual(await refusal(ready), { status: 409, code: "host_unavailable" });
    assert.equal((await f.resume(sessionId())).status, 404);
    assert.equal(openDb().prepare("SELECT COUNT(*) AS n FROM history_resume_launches").get()!.n, 0);
    assert.equal(hostless.prepared.length, 0);

    // A slot the options never offered is refused before anything is claimed.
    const slot = await f.post(`/api/history/sessions/claude/${ready}/resume`, { backend: "cmux", target: { kind: "slot", slotId: "s" } });
    assert.equal(slot.status, 409);
    assert.equal(((await slot.json()) as { code: string }).code, "slot_not_offered");
    assert.equal(openDb().prepare("SELECT COUNT(*) AS n FROM history_resume_launches").get()!.n, 0);

    // A backend this build does not know is refused by the schema.
    const backend = await f.post(`/api/history/sessions/claude/${ready}/resume`, { backend: "nope", target: { kind: "original" } });
    assert.equal(backend.status, 400);
  } finally {
    f.done();
  }
});

test("revoking a cancelled launch's environment revokes only its own unclaimed leases", () => {
  const root = managedResumeRoot();
  const lease = (conversation: string, owner: string) => {
    const created = createResumeLease(root, conversation, new Set(), owner);
    beginResumeLaunch(created);
    return created;
  };
  const mine = lease("claude:revoke-mine", "history-resume:mine");
  const claimed = lease("claude:revoke-claimed", "history-resume:claimed");
  assert.equal(claimResumeLease(claimed, process.pid, Date.now()), true);
  const other = lease("claude:revoke-other", "history-resume:other");
  const state = (id: string) => recheckManagedResumes().find((status) => status.lease.id === id)?.state;

  assert.equal(revokeUnclaimedResumes("history-resume:mine"), 1);
  assert.equal(state(mine.id), "revoked");
  assert.equal(state(other.id), "pending", "another launch's environment is untouched");
  assert.equal(revokeUnclaimedResumes("history-resume:claimed"), 0, "a terminal that claimed its environment keeps it");
  assert.equal(state(claimed.id), "claimed");
});

test("Cancel pending resume through the route closes the launch and its environment, and Resume runs again", async () => {
  const { launcher, abandoned, prepared } = fakeLauncher();
  const f = await fixture(launcher);
  try {
    const id = sessionId();
    writeConversation(f.projects, id, directory("work"));
    await f.history.reconciler.trigger();
    const { launch } = (await (await f.resume(id)).json()) as { launch: { launchId: string } };

    const blocked = await f.resume(id);
    assert.equal(blocked.status, 409);
    assert.equal(((await blocked.json()) as { launch: { launchId: string } }).launch.launchId, launch.launchId);

    const other = sessionId();
    writeConversation(f.projects, other, directory("other"));
    await f.history.reconciler.trigger();
    const foreign = await f.post(`/api/history/sessions/claude/${other}/resume/cancel`, { launchId: launch.launchId });
    assert.equal(foreign.status, 404, "a launch is cancelled only through its own session");
    assert.equal(((await foreign.json()) as { code: string }).code, "launch_not_found");

    const cancelled = await f.post(`/api/history/sessions/claude/${id}/resume/cancel`, { launchId: launch.launchId });
    assert.equal(cancelled.status, 200);
    assert.equal(((await cancelled.json()) as { launch: { state: string } }).launch.state, "released");
    assert.deepEqual(abandoned, [`history-resume:${launch.launchId}`], "the prepared environment is revoked with it");
    assert.equal(abandoned[0], prepared[0]!.id, "revoked under the same owner it was prepared under");
    const again = await f.post(`/api/history/sessions/claude/${id}/resume/cancel`, { launchId: launch.launchId });
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { code: string }).code, "launch_not_pending", "a refused cancel says why by code");
    assert.equal((await f.resume(id)).status, 200);
  } finally {
    f.done();
  }
});

test("Cancel pending resume that lands while the Resume is still preparing opens no terminal", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { launcher, launched, disposed } = fakeLauncher({ prepare: () => gate });
  const f = await fixture(launcher);
  try {
    const id = sessionId();
    writeConversation(f.projects, id, directory("work"));
    await f.history.reconciler.trigger();

    const resuming = Promise.resolve(f.resume(id));
    // A second tab reads the open launch and cancels it while the first is still preparing.
    let open = f.history.launches.open("claude", id);
    for (let i = 0; !open && i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      open = f.history.launches.open("claude", id);
    }
    assert.ok(open, "the Resume claimed its launch before preparing");
    assert.equal((await f.post(`/api/history/sessions/claude/${id}/resume/cancel`, { launchId: open.launchId })).status, 200);
    release();

    const res = await resuming;
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code: string; launch: { state: string } };
    assert.equal(body.code, "cancelled");
    assert.equal(body.launch.state, "released");
    assert.deepEqual(launched, [], "no terminal opens for a cancelled launch");
    assert.deepEqual(disposed, [`history-resume:${open.launchId}`], "its prepared environment is revoked");
  } finally {
    f.done();
  }
});

test("Cancel pending resume that lands while the terminal opens is reported as cancelled, not started", async () => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  let id = "";
  const { launcher } = fakeLauncher({
    launch: async () => {
      const open = f.history.launches.open("claude", id)!;
      assert.equal((await f.post(`/api/history/sessions/claude/${id}/resume/cancel`, { launchId: open.launchId })).status, 200);
      return { ok: true, label: "cmux", status: 200 };
    },
  });
  f = await fixture(launcher);
  try {
    id = sessionId();
    writeConversation(f.projects, id, directory("work"));
    await f.history.reconciler.trigger();
    const res = await f.resume(id);
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code: string; error: string; launch: { state: string } };
    assert.equal(body.code, "cancelled");
    assert.equal(body.launch.state, "released");
    assert.match(body.error, /while cmux was opening/);
  } finally {
    f.done();
  }
});

// ---- a typed directory: copy and fork ----

const { claudeProjectDir } = await import("../src/server/harness/claude/project-dir.ts");
const { resumeFor } = await import("../src/server/harness/index.ts");

type Started = { ok: true; launch: { launchId: string; cwd: string; expectedAgentSessionId: string; sourceSessionId: string; copyPath: string | null }; label: string };

function resumeInto(f: Awaited<ReturnType<typeof fixture>>, id: string, path: string) {
  return f.post(`/api/history/sessions/claude/${id}/resume`, { backend: "cmux", target: { kind: "directory", path } });
}

/** A conversation whose original directory is gone, so the picker is what Resume offers. */
async function orphaned(f: Awaited<ReturnType<typeof fixture>>, cwd = join(directory("parent"), "deleted")) {
  const id = sessionId();
  const transcript = writeConversation(f.projects, id, cwd);
  await f.history.reconciler.trigger();
  return { id, transcript };
}

function launchCount(): number {
  return Number(openDb().prepare("SELECT COUNT(*) AS n FROM history_resume_launches").get()!.n);
}

test("Claude forks under a given id: --fork-session with --session-id", () => {
  assert.deepEqual(resumeFor("claude")?.forkArgv?.("11111111-2222-4333-8444-555555555555"), [
    "--fork-session", "--session-id", "11111111-2222-4333-8444-555555555555",
  ]);
});

test("a typed directory: a relative path is refused, and a symlink is resolved once for the copy, the launch and the terminal", async () => {
  const { launcher, prepared, launched } = fakeLauncher();
  const f = await fixture(launcher);
  try {
    const { id, transcript } = await orphaned(f);

    const relative = await resumeInto(f, id, "projects/elsewhere");
    assert.equal(relative.status, 400);
    assert.equal(((await relative.json()) as { code: string }).code, "directory_relative");
    const nowhere = await resumeInto(f, id, join(directory("parent"), "never-made"));
    assert.equal(nowhere.status, 409);
    assert.equal(((await nowhere.json()) as { code: string }).code, "directory_missing");
    assert.equal(launchCount(), 0, "a refused target claims nothing");

    const real = directory("typed-real");
    const alias = join(directory("typed-aliases"), "alias");
    symlinkSync(real, alias);
    const res = await resumeInto(f, id, alias);
    assert.equal(res.status, 200);
    const { launch } = (await res.json()) as Started;
    const copyPath = join(claudeProjectDir(real, f.projects), `${id}.jsonl`);
    assert.equal(launch.cwd, real, "the launch row's directory is the resolved one");
    assert.equal(launch.copyPath, copyPath, "the copy is in the RESOLVED directory's project folder");
    assert.equal(readFileSync(copyPath, "utf8"), readFileSync(transcript, "utf8"));
    assert.equal(existsSync(claudeProjectDir(alias, f.projects)), false, "nothing is written under the alias's encoding");
    assert.equal(prepared[0]!.cwd, real, "the terminal's working directory");
    assert.deepEqual(launched, [{ backend: "cmux", cwd: real }]);

    // The fork's id is minted before launch: it is the launch's expected id, it is what the
    // agent is started under, and it is not the source's.
    assert.equal(launch.sourceSessionId, id);
    assert.match(launch.expectedAgentSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(launch.expectedAgentSessionId, id);
    assert.equal(prepared[0]!.agentSessionId, id, "the fork resumes the source conversation");
    assert.equal(prepared[0]!.forkSessionId, launch.expectedAgentSessionId);
  } finally {
    f.done();
  }
});

test("a destination folder that collides with the original's refuses, and the original stays byte-identical", async () => {
  const { launcher, prepared } = fakeLauncher();
  const f = await fixture(launcher);
  try {
    // `<parent>/a-b` (gone) and `<parent>/a/b` encode to the same project folder.
    const parent = directory("collide");
    const { id, transcript } = await orphaned(f, join(parent, "a-b"));
    const typed = join(parent, "a", "b");
    mkdirSync(typed, { recursive: true });
    assert.equal(claudeProjectDir(typed, f.projects), claudeProjectDir(join(parent, "a-b"), f.projects));
    const before = { bytes: readFileSync(transcript), stat: statSync(transcript) };

    const res = await resumeInto(f, id, typed);
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code: string; error: string };
    assert.equal(body.code, "copy_exists");
    assert.ok(body.error.includes(transcript), "the refusal names the file it would not overwrite");
    assert.deepEqual(readFileSync(transcript), before.bytes);
    assert.equal(statSync(transcript).mtimeMs, before.stat.mtimeMs);
    assert.equal(statSync(transcript).ino, before.stat.ino);
    assert.equal(launchCount(), 0);
    assert.equal(prepared.length, 0);
  } finally {
    f.done();
  }
});

test("the copy is an exclusive create: a file that appears after the check is never overwritten, and the claim is freed", async () => {
  let intruder: string | null = null;
  const { launcher, prepared } = fakeLauncher();
  // The host check runs after the target is checked and before the claim and the copy, which
  // is the window another writer would have to land in.
  launcher.hostUnavailable = () => {
    if (intruder) writeFileSync(intruder, "someone else's file\n");
    return null;
  };
  const f = await fixture(launcher);
  try {
    const { id } = await orphaned(f);
    const typed = directory("raced");
    intruder = join(claudeProjectDir(typed, f.projects), `${id}.jsonl`);
    mkdirSync(claudeProjectDir(typed, f.projects), { recursive: true });

    const res = await resumeInto(f, id, typed);
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, "copy_exists");
    assert.equal(readFileSync(intruder, "utf8"), "someone else's file\n");
    assert.equal(f.history.launches.open("claude", id), null, "the claim is released, so the next Resume can run");
    assert.equal(f.history.launches.inStates(["released"])[0]?.copyPath, null, "a refused copy is never recorded as one");
    assert.equal(prepared.length, 0);
  } finally {
    f.done();
  }
});

test("an existing History copy is reused with no write; any other existing file refuses", async () => {
  const { launcher } = fakeLauncher();
  const f = await fixture(launcher);
  try {
    const { id } = await orphaned(f);
    const typed = directory("reused");
    const first = (await (await resumeInto(f, id, typed)).json()) as Started;
    const copyPath = first.launch.copyPath!;
    const written = { bytes: readFileSync(copyPath), stat: statSync(copyPath) };
    assert.equal((await f.post(`/api/history/sessions/claude/${id}/resume/cancel`, { launchId: first.launch.launchId })).status, 200);

    const again = await resumeInto(f, id, typed);
    assert.equal(again.status, 200);
    const second = (await again.json()) as Started;
    assert.equal(second.launch.copyPath, copyPath, "the second launch records the same copy");
    assert.notEqual(second.launch.expectedAgentSessionId, first.launch.expectedAgentSessionId, "each fork gets its own id");
    assert.deepEqual(readFileSync(copyPath), written.bytes);
    assert.equal(statSync(copyPath).mtimeMs, written.stat.mtimeMs, "reused as it stands: no write");
    assert.equal(statSync(copyPath).ino, written.stat.ino);

    // Another session's file of that name that History did not copy is not reused.
    const { id: other } = await orphaned(f);
    const foreign = join(claudeProjectDir(typed, f.projects), `${other}.jsonl`);
    writeFileSync(foreign, "not a History copy\n");
    const refused = await resumeInto(f, other, typed);
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { code: string }).code, "copy_exists");
    assert.equal(readFileSync(foreign, "utf8"), "not a History copy\n");
  } finally {
    f.done();
  }
});

test("resumed_from is known at launch: the fork's row reads it from the launch, and the copy makes no second row", async () => {
  const registry = new Registry();
  const { launcher } = fakeLauncher();
  const f = await fixture(launcher, registry);
  try {
    const { id, transcript } = await orphaned(f);
    const typed = directory("forked");
    const { launch } = (await (await resumeInto(f, id, typed)).json()) as Started;
    const fork = launch.expectedAgentSessionId;

    // What Claude writes for the fork: a transcript under the minted id beside the copy.
    writeConversation(f.projects, fork, typed);
    await f.history.reconciler.trigger();
    const rows = openDb().prepare("SELECT agent_session_id, transcript_path, resumed_from FROM history_sessions ORDER BY agent_session_id").all() as {
      agent_session_id: string; transcript_path: string; resumed_from: string | null;
    }[];
    assert.deepEqual(rows.find((row) => row.agent_session_id === fork)?.resumed_from, id);
    const source = rows.filter((row) => row.agent_session_id === id);
    assert.equal(source.length, 1, "the copy never creates a second row");
    assert.equal(source[0]!.transcript_path, transcript, "and the original stays canonical");
    assert.equal(source[0]!.resumed_from, null);

    // The fork binds by its minted id in the resolved directory.
    assert.equal(f.history.launches.bind(candidate("fork-session", fork, typed), 5).length, 1);
    assert.equal(f.history.launches.get(launch.launchId)?.state, "bound");
  } finally {
    f.done();
  }
});

test("a typed directory inside a worktree pool is refused", async () => {
  const f = await fixture();
  try {
    const { id } = await orphaned(f);
    const pool = directory("typed-pool");
    const slot = join(pool, "2", "repo");
    mkdirSync(slot, { recursive: true });
    openDb().prepare(
      `INSERT INTO worktree_pools (id, git_common_dir, main_checkout_root, pool_path, created_at, updated_at)
       VALUES ('pool-typed', '/repo/.git', '/repo', ?, 1, 1)`,
    ).run(pool);
    const res = await resumeInto(f, id, slot);
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, "pool_slot");
    assert.equal(launchCount(), 0);
  } finally {
    f.done();
  }
});

/** Append a user turn, so the reconciler rewrites the row from a changed file. */
function bump(path: string, id: string, cwd: string): void {
  appendFileSync(path, JSON.stringify({
    sessionId: id, cwd, entrypoint: "cli", version: "2.1.296", gitBranch: "main", isSidechain: false,
    timestamp: "2026-10-21T10:00:00.000Z", uuid: `u2-${id}-${Date.now()}`, type: "user", message: { role: "user", content: "again" },
  }) + "\n");
}

function resumedFrom(id: string): string | null {
  return (openDb().prepare("SELECT resumed_from FROM history_sessions WHERE agent_session_id = ?").get(id) as { resumed_from: string | null }).resumed_from;
}

test("resumed_from: a Resume in the original directory never stamps its own row, and a fork's value is kept once set", async () => {
  const { launcher } = fakeLauncher();
  const f = await fixture(launcher);
  try {
    // A plain Resume's launch expects the source's own id; it is not a fork of anything.
    const cwd = directory("plain");
    const id = sessionId();
    const path = writeConversation(f.projects, id, cwd);
    await f.history.reconciler.trigger();
    assert.equal((await f.resume(id)).status, 200);
    bump(path, id, cwd);
    const pass = await f.history.reconciler.trigger();
    assert.equal(pass.indexed, 1, "the row was rewritten after the launch was recorded");
    assert.equal(resumedFrom(id), null);

    // A fork's row keeps its source even once no launch row names it any more.
    const { id: source } = await orphaned(f);
    const typed = directory("kept");
    const { launch } = (await (await resumeInto(f, source, typed)).json()) as Started;
    const fork = launch.expectedAgentSessionId;
    const forkPath = writeConversation(f.projects, fork, typed);
    await f.history.reconciler.trigger();
    assert.equal(resumedFrom(fork), source);
    openDb().prepare("DELETE FROM history_resume_launches WHERE launch_id = ?").run(launch.launchId);
    bump(forkPath, fork, typed);
    assert.equal((await f.history.reconciler.trigger()).indexed, 1);
    assert.equal(resumedFrom(fork), source, "kept once set");
  } finally {
    f.done();
  }
});

test("a copy that fails after its exclusive create is removed, answers launch_failed, and frees the claim", async () => {
  const { launcher, prepared } = fakeLauncher();
  const f = await fixture(launcher);
  try {
    const { id, transcript } = await orphaned(f);
    const typed = directory("half-copied");
    const copyPath = join(claudeProjectDir(typed, f.projects), `${id}.jsonl`);
    // The row still reads present, so the Resume gets as far as the copy: the destination is
    // created, then reading the source fails.
    rmSync(transcript);

    const res = await resumeInto(f, id, typed);
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code: string; error: string; launch: { state: string; copyPath: string | null } };
    assert.equal(body.code, "launch_failed");
    assert.ok(body.error.includes(copyPath), "the refusal names the copy it could not make");
    assert.equal(existsSync(copyPath), false, "the partial copy is removed, so it never blocks the next Resume");
    assert.equal(body.launch.state, "released");
    assert.equal(body.launch.copyPath, null, "a failed copy is never recorded as one");
    assert.equal(f.history.launches.open("claude", id), null);
    assert.equal(prepared.length, 0);
  } finally {
    f.done();
  }
});

test("a recorded copy is reused only while nothing has written to it: one resumed in place refuses, one the source outgrew is reused", async () => {
  const { launcher } = fakeLauncher();
  const f = await fixture(launcher);
  try {
    const { id, transcript } = await orphaned(f);
    const typed = directory("written-to");
    const first = (await (await resumeInto(f, id, typed)).json()) as Started;
    const copyPath = first.launch.copyPath!;
    assert.equal((await f.post(`/api/history/sessions/claude/${id}/resume/cancel`, { launchId: first.launch.launchId })).status, 200);

    // The source grew after the copy (the original was continued elsewhere): the copy is still
    // a prefix of it, so it is a faithful earlier state, and it is reused with no write.
    appendFileSync(transcript, JSON.stringify({ type: "permission-mode", permissionMode: "default", sessionId: id }) + "\n");
    const untouched = statSync(copyPath);
    const grown = await resumeInto(f, id, typed);
    assert.equal(grown.status, 200);
    const second = (await grown.json()) as Started;
    assert.equal(statSync(copyPath).mtimeMs, untouched.mtimeMs);
    assert.equal((await f.post(`/api/history/sessions/claude/${id}/resume/cancel`, { launchId: second.launch.launchId })).status, 200);

    // Claude's own resume in that directory appended to the copy: it is no longer this
    // conversation, so it is refused, and left as it is.
    appendFileSync(copyPath, JSON.stringify({ type: "user", sessionId: id, message: { role: "user", content: "typed in place" } }) + "\n");
    const written = readFileSync(copyPath);
    const launchesBefore = launchCount();
    const refused = await resumeInto(f, id, typed);
    assert.equal(refused.status, 409);
    const body = (await refused.json()) as { code: string; error: string };
    assert.equal(body.code, "copy_exists");
    assert.match(body.error, /something has written to it since/);
    assert.deepEqual(readFileSync(copyPath), written, "nothing was written");
    assert.equal(launchCount(), launchesBefore, "refused before any claim");
  } finally {
    f.done();
  }
});

// ---- slot targets: a real worktree manager over a real clone ----

const { WorktreeManager } = await import("../src/server/worktrees/manager.ts");
const { WorktreeOperationsService } = await import("../src/server/worktrees/operations.ts");
const { LegacyTreehouseService } = await import("../src/server/worktrees/legacy-treehouse.ts");
const { CheckLeaseManager } = await import("../src/server/workflows/check-lease.ts");
const { historyResumeSlots } = await import("../src/server/history/resume-slots.ts");
const { historyResumeOwnerKey } = await import("../src/server/worktrees/owners.ts");
const { gitIn, mkOriginAndClone } = await import("./helpers/git-fixture.ts");
type Manager = InstanceType<typeof WorktreeManager>;

/**
 * A clone, its manager, and the pieces a slot Resume and its Return run through. `seed` makes
 * its idle slots; call it after `fixture`, whose reset clears every pool.
 */
function pooled(prefix: string, registry: InstanceType<typeof Registry>) {
  const { clone } = mkOriginAndClone(prefix);
  const sha = gitIn(clone, "rev-parse", "HEAD");
  const m: Manager = new WorktreeManager(openDb(), {
    occupancy: (paths: readonly string[]) => Promise.resolve(new Map(paths.map((path) => [path, { status: "known" as const, occupants: [] }]))),
    fileHolders: async () => [],
    resolvePolicy: () => ({ enabled: true, maxSlots: 8, setupArgv: null }),
    publishChanged: () => registry.emitWorktreesChanged(),
  });
  const slots: { slotId: string; path: string }[] = [];
  const seed = async (count: number) => {
    const leases = [];
    for (let index = 0; index < count; index += 1) {
      const acquired = await m.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "task", key: `seed-${index}` } });
      assert.equal(acquired.outcome, "acquired", JSON.stringify(acquired));
      if (acquired.outcome !== "acquired") throw new Error("not acquired");
      leases.push(acquired.lease);
    }
    for (const lease of leases) assert.equal((await m.release(lease, { ownerAuthorized: true })).outcome, "released");
    slots.push(...leases.map((lease) => ({ slotId: lease.slotId, path: lease.path })));
  };
  const legacy = new LegacyTreehouseService(openDb());
  const operations = new WorktreeOperationsService(m, {
    legacy,
    tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
    checks: new CheckLeaseManager(openDb(), { manager: m, legacy }),
    checkRecovery: async () => "unknown",
    notifyChanged: () => registry.emitWorktreesChanged(),
    diskBytes: async () => 0,
  });
  const card = async (slotId: string) =>
    (await operations.inventory()).repositories.flatMap((repo) => repo.slots).find((slot) => slot.id === slotId)!;
  const returnSlot = async (slotId: string) => {
    const preview = await operations.preview({ action: "return", slotId });
    assert.equal(preview.allowed, true, preview.blockers.join("; "));
    await operations.execute(preview.token, []);
  };
  return { clone, m, slots, seed, card, returnSlot };
}

function symbolicHead(path: string): string | null {
  try {
    return gitIn(path, "symbolic-ref", "--quiet", "HEAD");
  } catch {
    return null;
  }
}

type SlotStarted = { ok: true; launch: { launchId: string; slotId: string | null; cwd: string; state: string }; checkout: unknown };

test("an original directory that is an idle pool slot is leased, its branch checked out, and Return releases the launch", async () => {
  const registry = new Registry();
  const { launcher, launched } = fakeLauncher();
  const p = pooled("mission-history-resume-slot-", registry);
  const f = await fixture(launcher, registry, { repository: p.clone, slots: historyResumeSlots(p.m) });
  await p.seed(1);
  const stop = trackHistoryResumeLaunches(f.history.launches, registry, {
    graceMs: GRACE,
    tickMs: 60_000,
    slotHolds: historyResumeSlots(p.m).holds,
  });
  try {
    const [slot] = p.slots;
    gitIn(p.clone, "branch", "feature/resumed");
    const id = sessionId();
    writeConversation(f.projects, id, slot!.path, { branch: "feature/resumed" });
    await f.history.reconciler.trigger();

    const options = await f.options(id);
    assert.equal(options.original.state, "pool_slot");
    assert.equal(options.original.slot?.slotId, slot!.slotId);
    assert.equal(options.refusal, null);
    assert.equal(options.original.refusal, null);
    assert.equal(options.picker, null, "an idle original needs no picker");

    const res = await f.resume(id);
    assert.equal(res.status, 200);
    const body = (await res.json()) as SlotStarted;
    assert.equal(body.launch.slotId, slot!.slotId);
    assert.equal(body.launch.cwd, slot!.path);
    assert.deepEqual(body.checkout, { state: "branch", branch: "feature/resumed" });
    assert.deepEqual(launched, [{ backend: "cmux", cwd: slot!.path }]);
    assert.equal(symbolicHead(slot!.path), "refs/heads/feature/resumed");

    // The slot card names the owner, and the launch row records the slot and its lease.
    const leasedCard = await p.card(slot!.slotId);
    assert.equal(leasedCard.state, "leased");
    assert.deepEqual(leasedCard.owner, { kind: "manual", key: historyResumeOwnerKey(body.launch.launchId), label: "Resumed History session" });
    const row = openDb().prepare("SELECT slot_id, lease_key, state FROM history_resume_launches WHERE launch_id = ?").get(body.launch.launchId);
    assert.deepEqual({ ...row }, { slot_id: slot!.slotId, lease_key: p.m.store.slot(slot!.slotId)!.activeLeaseId, state: "pending" });

    // Cancel pending resume never closes a slot launch; Returning the slot from its card does.
    const cancel = await f.post(`/api/history/sessions/claude/${id}/resume/cancel`, { launchId: body.launch.launchId });
    assert.equal(((await cancel.json()) as { code: string }).code, "launch_has_slot");
    assert.match((await f.options(id)).refusal!.error, /Return the slot from its card/);
    await p.returnSlot(slot!.slotId);
    assert.equal(f.history.launches.get(body.launch.launchId)?.state, "released");
    assert.equal(symbolicHead(slot!.path), null, "the Return reset the slot detached");

    const again = await f.options(id);
    assert.equal(again.openLaunch, null);
    assert.equal(again.refusal, null);
    assert.equal((await f.resume(id)).status, 200, "a new Resume can start");
  } finally {
    stop();
    f.done();
  }
});

test("an original slot held by another owner opens the picker, which offers only idle, clean slots of the session's repository", async () => {
  const registry = new Registry();
  const { launcher, launched } = fakeLauncher();
  const p = pooled("mission-history-resume-picker-", registry);
  const other = pooled("mission-history-resume-other-", registry);
  const f = await fixture(launcher, registry, { repository: p.clone, slots: historyResumeSlots(p.m) });
  await p.seed(3);
  await other.seed(1);
  try {
    const [held, idle, dirty] = p.slots;
    assert.equal((await p.m.leaseAsIs(held!.slotId, { kind: "manual", key: "terminal-someone" })).outcome, "leased");
    writeFileSync(join(dirty!.path, "scratch.txt"), "uncommitted\n");
    const id = sessionId();
    writeConversation(f.projects, id, held!.path, { branch: "feature/nowhere" });
    await f.history.reconciler.trigger();

    const options = await f.options(id);
    assert.equal(options.original.state, "slot_reused");
    assert.equal(options.original.refusal?.code, "slot_reused");
    assert.equal(options.refusal, null);
    assert.deepEqual(options.picker?.slots.map((slot) => slot.slotId), [idle!.slotId], "not the held slot, the dirty one, or another repository's");
    assert.equal(options.picker?.directory, true, "a typed directory is offered beside the slots");

    // The original is still not leasable: its lease refuses, and the claim is released.
    const original = await f.resume(id);
    assert.equal(original.status, 409);
    assert.equal(((await original.json()) as { code: string }).code, "slot_unavailable");
    assert.equal(f.history.launches.open("claude", id), null);
    assert.equal(p.m.store.slot(held!.slotId)?.activeOwnerKey, "terminal-someone");

    const elsewhere = await f.post(`/api/history/sessions/claude/${id}/resume`, { backend: "cmux", target: { kind: "slot", slotId: other.slots[0]!.slotId } });
    assert.equal(((await elsewhere.json()) as { code: string }).code, "slot_not_offered");

    const res = await f.post(`/api/history/sessions/claude/${id}/resume`, { backend: "cmux", target: { kind: "slot", slotId: idle!.slotId } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as SlotStarted;
    assert.equal(body.launch.cwd, idle!.path);
    assert.deepEqual(body.checkout, { state: "missing", branch: "feature/nowhere" }, "a missing branch leaves the slot detached");
    assert.equal(symbolicHead(idle!.path), null);
    assert.deepEqual(launched, [{ backend: "cmux", cwd: idle!.path }]);
  } finally {
    f.done();
  }
});

test("a branch attached elsewhere is checked out detached in the chosen slot", async () => {
  const registry = new Registry();
  const p = pooled("mission-history-resume-held-branch-", registry);
  const f = await fixture(fakeLauncher().launcher, registry, { repository: p.clone, slots: historyResumeSlots(p.m) });
  await p.seed(1);
  try {
    const id = sessionId();
    // Recorded in a directory since deleted, on the branch the main checkout holds.
    writeConversation(f.projects, id, join(directory("parent"), "deleted"), { branch: "main" });
    await f.history.reconciler.trigger();
    const options = await f.options(id);
    assert.equal(options.original.state, "missing");
    const res = await f.post(`/api/history/sessions/claude/${id}/resume`, { backend: "cmux", target: { kind: "slot", slotId: options.picker!.slots[0]!.slotId } });
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as SlotStarted).checkout, { state: "elsewhere", branch: "main", path: p.clone });
    assert.equal(symbolicHead(p.slots[0]!.path), null);
    assert.equal(symbolicHead(p.clone), "refs/heads/main");
  } finally {
    f.done();
  }
});

test("a session with no resolvable repository is offered no slot", async () => {
  const registry = new Registry();
  const p = pooled("mission-history-resume-norepo-", registry);
  const f = await fixture(fakeLauncher().launcher, registry, { repository: null, slots: historyResumeSlots(p.m) });
  await p.seed(1);
  try {
    const id = sessionId();
    writeConversation(f.projects, id, join(directory("parent"), "deleted"));
    await f.history.reconciler.trigger();
    const options = await f.options(id);
    assert.deepEqual(options.picker, { directory: true, slots: [] });
    assert.equal(options.original.refusal?.code, "directory_missing");
    const res = await f.post(`/api/history/sessions/claude/${id}/resume`, { backend: "cmux", target: { kind: "slot", slotId: p.slots[0]!.slotId } });
    assert.equal(((await res.json()) as { code: string }).code, "slot_not_offered");
  } finally {
    f.done();
  }
});

test("a slot no longer idle at launch is refused, the claim is released, and no terminal opens", async () => {
  const registry = new Registry();
  const { launcher, prepared, launched } = fakeLauncher();
  const p = pooled("mission-history-resume-taken-", registry);
  const f = await fixture(launcher, registry, { repository: p.clone, slots: historyResumeSlots(p.m) });
  await p.seed(1);
  try {
    const id = sessionId();
    writeConversation(f.projects, id, join(directory("parent"), "deleted"));
    await f.history.reconciler.trigger();
    const offered = (await f.options(id)).picker!.slots[0]!;
    // Taken between the dialog's read and the click.
    assert.equal((await p.m.leaseAsIs(offered.slotId, { kind: "manual", key: "terminal-first" })).outcome, "leased");

    const res = await f.post(`/api/history/sessions/claude/${id}/resume`, { backend: "cmux", target: { kind: "slot", slotId: offered.slotId } });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code: string; launch: { state: string } };
    assert.equal(body.code, "slot_unavailable");
    assert.equal(body.launch.state, "released");
    assert.equal(f.history.launches.open("claude", id), null);
    assert.equal(prepared.length, 0);
    assert.equal(launched.length, 0);
  } finally {
    f.done();
  }
});

test("a launcher that refuses after the lease hands the slot back, reset detached", async () => {
  const registry = new Registry();
  const { launcher } = fakeLauncher({ launch: () => ({ ok: false, label: "cmux", status: 409, error: "cmux refused" }) });
  const p = pooled("mission-history-resume-handback-", registry);
  const f = await fixture(launcher, registry, { repository: p.clone, slots: historyResumeSlots(p.m) });
  await p.seed(1);
  try {
    const [slot] = p.slots;
    gitIn(p.clone, "branch", "feature/handback");
    const id = sessionId();
    writeConversation(f.projects, id, slot!.path, { branch: "feature/handback" });
    await f.history.reconciler.trigger();
    const res = await f.resume(id);
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { launch: { state: string } }).launch.state, "released");
    const after = p.m.store.slot(slot!.slotId)!;
    assert.deepEqual([after.state, after.activeLeaseId], ["available", null]);
    assert.equal(symbolicHead(slot!.path), null);
  } finally {
    f.done();
  }
});

test("the checkout warning says the code may not match for a missing branch, and commits will not move a branch held elsewhere", () => {
  assert.equal(historyResumeCheckoutWarning({ state: "branch", branch: "feature/x" }), null);
  assert.equal(
    historyResumeCheckoutWarning({ state: "missing", branch: "feature/x" }),
    "The branch feature/x was not found here or on origin, so the slot stays detached where it was: the code may not match the conversation.",
  );
  assert.equal(
    historyResumeCheckoutWarning({ state: "missing", branch: null }),
    "This conversation recorded no usable branch, so the slot stays detached where it was: the code may not match the conversation.",
  );
  assert.equal(
    historyResumeCheckoutWarning({ state: "elsewhere", branch: "main", path: "/repo" }),
    "The branch main is checked out in /repo, so this slot has its tip detached: commits made here will not move the branch.",
  );
});

test("a slot launch whose lease was never recorded closes after a restart, by its owner key", async () => {
  const registry = new Registry();
  const p = pooled("mission-history-resume-unrecorded-", registry);
  const f = await fixture(fakeLauncher().launcher, registry, { repository: p.clone, slots: historyResumeSlots(p.m) });
  await p.seed(2);
  try {
    const [granted, never] = p.slots;
    const { holds } = historyResumeSlots(p.m);
    const claim = (slotId: string) => {
      const claimed = f.history.launches.claim(
        { agent: "claude", sourceSessionId: sessionId(), expectedAgentSessionId: "x", cwd: "/x", slotId },
        1_000,
      );
      assert.ok(claimed.ok);
      return claimed.launch.launchId;
    };
    // The daemon stopped after the lease was granted, before the row recorded it; and another
    // stopped before any lease was granted at all.
    const held = claim(granted!.slotId);
    assert.equal((await p.m.leaseForResume(granted!.slotId, { kind: "manual", key: historyResumeOwnerKey(held) }, null)).outcome, "leased");
    const lost = claim(never!.slotId);

    // In the daemon that made them, a launch with no lease key may still be taking its lease.
    assert.deepEqual(f.history.launches.slotsReturned(2_000, 1_000, holds), []);
    // After a restart, none can be: the one no slot is owned by closes at once.
    assert.deepEqual(f.history.launches.slotsReturned(2_000, 1_500, holds).map((launch) => launch.launchId), [lost]);
    assert.equal(f.history.launches.get(held)?.state, "pending", "its slot is still leased to it");

    // Returning that slot from its card releases the other.
    await p.returnSlot(granted!.slotId);
    assert.deepEqual(f.history.launches.slotsReturned(3_000, 1_500, holds).map((launch) => launch.launchId), [held]);
  } finally {
    f.done();
  }
});

test("the manager says a slot holds a launch by its lease, or by its owner when no lease was recorded", async () => {
  const registry = new Registry();
  const p = pooled("mission-history-resume-holds-", registry);
  const f = await fixture(fakeLauncher().launcher, registry, { repository: p.clone, slots: historyResumeSlots(p.m) });
  await p.seed(1);
  try {
    const [slot] = p.slots;
    const owner = historyResumeOwnerKey("00000000-0000-4000-8000-0000000000aa");
    assert.equal(p.m.holds(slot!.slotId, null, { kind: "manual", key: owner }), false, "an available slot holds nothing");
    const taken = await p.m.leaseForResume(slot!.slotId, { kind: "manual", key: owner }, null);
    assert.equal(taken.outcome, "leased");
    if (taken.outcome !== "leased") return;
    assert.equal(p.m.holds(slot!.slotId, taken.lease.leaseId, { kind: "manual", key: "someone-else" }), true, "by its lease");
    assert.equal(p.m.holds(slot!.slotId, null, { kind: "manual", key: owner }), true, "by its owner");
    assert.equal(p.m.holds(slot!.slotId, "another-lease", { kind: "manual", key: "someone-else" }), false);
    await p.returnSlot(slot!.slotId);
    assert.equal(p.m.holds(slot!.slotId, taken.lease.leaseId, { kind: "manual", key: owner }), false, "Returned");
  } finally {
    f.done();
  }
});

test("an available slot left on a branch is never offered, and as the original it counts as reused", async () => {
  const registry = new Registry();
  const p = pooled("mission-history-resume-attached-", registry);
  const f = await fixture(fakeLauncher().launcher, registry, { repository: p.clone, slots: historyResumeSlots(p.m) });
  await p.seed(2);
  try {
    const [attached, idle] = p.slots;
    // Available and clean, but standing on a branch: the as-is lease always refuses it.
    gitIn(attached!.path, "checkout", "-qb", "left-behind");
    const id = sessionId();
    writeConversation(f.projects, id, attached!.path);
    await f.history.reconciler.trigger();

    const options = await f.options(id);
    assert.equal(options.original.state, "slot_reused", "not pool_slot: the lease would refuse it");
    assert.equal(options.original.refusal?.code, "slot_reused");
    assert.deepEqual(options.picker?.slots.map((slot) => slot.slotId), [idle!.slotId], "the attached slot is not offered");

    const gone = sessionId();
    writeConversation(f.projects, gone, join(directory("parent"), "deleted"));
    await f.history.reconciler.trigger();
    assert.deepEqual((await f.options(gone)).picker?.slots.map((slot) => slot.slotId), [idle!.slotId]);
  } finally {
    f.done();
  }
});

test("a pool that cannot be read is said so, and logged, rather than calling the original slot reused", async (t) => {
  const registry = new Registry();
  const p = pooled("mission-history-resume-unreadable-", registry);
  const failing: HistoryResumeSlots = { ...historyResumeSlots(p.m), observe: async () => { throw new Error("git worktree list timed out"); } };
  const f = await fixture(fakeLauncher().launcher, registry, { repository: p.clone, slots: failing });
  await p.seed(1);
  const logged: string[] = [];
  t.mock.method(console, "error", (message: unknown) => { logged.push(String(message)); });
  try {
    const id = sessionId();
    writeConversation(f.projects, id, p.slots[0]!.path);
    await f.history.reconciler.trigger();

    const options = await f.options(id);
    assert.equal(options.original.refusal?.code, "pool_unavailable");
    assert.match(options.original.refusal!.error, /could not be read \(git worktree list timed out\)/);
    assert.deepEqual(options.picker?.slots, []);
    assert.ok(logged.some((line) => line.includes("git worktree list timed out")), logged.join("\n"));

    const res = await f.resume(id);
    assert.equal(((await res.json()) as { code: string }).code, "pool_unavailable");
    assert.equal(f.history.launches.open("claude", id), null);
  } finally {
    f.done();
  }
});
