import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import type { HistoryResumeOptions } from "../src/shared/history.ts";
import type { ServerEvent } from "../src/shared/types.ts";
import type { HistoryResumeLauncher, HistoryResumeSession } from "../src/server/history/resume.ts";
import type { HistoryResumeCandidate } from "../src/server/history/resume-launches.ts";
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
  openDb().exec("DELETE FROM history_sessions; DELETE FROM history_resume_launches; DELETE FROM worktree_pools");
}

/** A directory that exists, under the worker's temp dir. */
function directory(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "mission-history-resume-dir-")), name);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

/** A two-turn transcript recorded in `cwd`, of `kind` (an SDK prompt snapshot for one-shot). */
function writeConversation(projects: string, id: string, cwd: string, extra: { oneShot?: boolean; mode?: string } = {}): string {
  const dir = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const base = { sessionId: id, cwd, entrypoint: extra.oneShot ? "sdk-cli" : "cli", version: "2.1.296", gitBranch: "main", isSidechain: false };
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

async function fixture(launcher: HistoryResumeLauncher = fakeLauncher().launcher, registry = new Registry()) {
  reset();
  const projects = mkdtempSync(join(tmpdir(), "mission-history-resume-projects-"));
  const history = new HistoryService({ readers: [{ agent: "claude", spec: createClaudeHistory(projects) }], resolveRepository: () => null });
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks: {} as TaskManager, queues: {} as QueueManager, history, historyResumeLauncher: launcher });
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
    assert.deepEqual(ready.original, { cwd, resolved: cwd, state: "usable" });
    assert.equal(ready.refusal, null);
    assert.equal(ready.openLaunch, null);

    const gone = await f.options(missing);
    assert.equal(gone.original.state, "missing");
    assert.equal(gone.refusal?.code, "directory_missing");

    const inPool = await f.options(pooled);
    assert.equal(inPool.original.state, "pool_slot");
    assert.equal(inPool.refusal?.code, "pool_slot");

    assert.equal((await f.resume(usable)).status, 200);
    const open = await f.options(usable);
    assert.equal(open.openLaunch?.cwd, cwd);
    assert.equal(open.refusal?.code, "open_launch");
    assert.match(open.refusal!.error, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

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

    // A target this build does not offer, or a backend it does not know, is refused by the schema.
    const slot = await f.post(`/api/history/sessions/claude/${ready}/resume`, { backend: "cmux", target: { kind: "slot", slotId: "s" } });
    assert.equal(slot.status, 400);
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
    assert.equal((await f.post(`/api/history/sessions/claude/${other}/resume/cancel`, { launchId: launch.launchId })).status, 404,
      "a launch is cancelled only through its own session");

    const cancelled = await f.post(`/api/history/sessions/claude/${id}/resume/cancel`, { launchId: launch.launchId });
    assert.equal(cancelled.status, 200);
    assert.equal(((await cancelled.json()) as { launch: { state: string } }).launch.state, "released");
    assert.deepEqual(abandoned, [`history-resume:${launch.launchId}`], "the prepared environment is revoked with it");
    assert.equal(abandoned[0], prepared[0]!.id, "revoked under the same owner it was prepared under");
    assert.equal((await f.post(`/api/history/sessions/claude/${id}/resume/cancel`, { launchId: launch.launchId })).status, 409);
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
