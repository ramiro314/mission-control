import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

// What is at stake: on win32 the terminal runtime does not exist yet (D9 in
// `docs/plans/windows-support/plan.md`), so a terminal dispatch has to be refused with a reason
// before anything is provisioned, terminal discovery must never walk the machine, and SDK
// sessions must still dispatch and survive every sweep. The platform is passed in rather than
// read from `process.platform`, so every case runs the same on macOS, Linux and Windows.

const home = mkdtempSync(join(tmpdir(), "mission-win32-runtimes-"));
process.env.HARNESS_HOME = home;
// A binary that exists on every platform, so bin resolution is never what fails here.
process.env.MISSION_CLAUDE_BIN = process.execPath;

const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { discover } = await import("../src/server/discovery/correlate.ts");
const { discoveryFor, startPoller } = await import("../src/server/discovery/poller.ts");
const { runtimeUnavailableWhy } = await import("../src/server/platform/session-runtimes.ts");
const { SdkSupervisor } = await import("../src/server/sdk/supervisor.ts");
const { startDiscoveryAfterSdkRestore } = await import("../src/server/sdk/startup.ts");
const { upsertSdkSession } = await import("../src/server/sdk/store.ts");
const { HARNESSES } = await import("../src/server/harness/index.ts");
const { TaskManager } = await import("../src/server/tasks.ts");

type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;
type Session = import("../src/shared/types.ts").Session;
type SdkEvent = import("../src/server/harness/types.ts").SdkEvent;
type SdkHandle = import("../src/server/harness/types.ts").SdkSessionHandle;
type LaunchOptions = import("../src/server/harness/types.ts").SdkLaunchOptions;

after(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.MISSION_CLAUDE_BIN;
});

function seedRepo(name: string): string {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  return repo;
}

function fakeSupervisor(registry: InstanceType<typeof Registry>) {
  const starts: Parameters<SdkSupervisor["start"]>[0][] = [];
  const supervisor = {
    starts,
    async start(input: Parameters<SdkSupervisor["start"]>[0]): Promise<Session> {
      starts.push(input);
      return registry.registerSdkSession({ id: `sdk:${starts.length}`, agent: input.agent, name: input.name, cwd: input.cwd });
    },
    async stop(): Promise<void> {},
    taskLiveness: () => null,
  };
  return supervisor as typeof supervisor & SdkSupervisor;
}

test("win32 has no terminal runtime, and says why; every other platform keeps both", () => {
  assert.match(runtimeUnavailableWhy("terminal", "win32") ?? "", /terminal runtime is not available on Windows/);
  assert.equal(runtimeUnavailableWhy("sdk", "win32"), null);
  for (const platform of ["darwin", "linux"] as const) {
    assert.equal(runtimeUnavailableWhy("terminal", platform), null);
    assert.equal(runtimeUnavailableWhy("sdk", platform), null);
  }
});

test("terminal discovery does not run on win32: each sweep is empty and complete", async () => {
  assert.equal(discoveryFor("darwin"), discover);
  assert.equal(discoveryFor("linux"), discover);
  const win32 = discoveryFor("win32");
  assert.notEqual(win32, discover);
  assert.deepEqual(await win32(), { sessions: [], terminals: [] });
});

/** A stand-in for the real process walk that counts how often the poller asked for it. */
function countingSweep() {
  const counter = { calls: 0 };
  const sweep: typeof discover = async () => {
    counter.calls++;
    return { sessions: [], terminals: [] };
  };
  return { counter, sweep };
}

async function runPollerOnce(registry: InstanceType<typeof Registry>, platform: NodeJS.Platform, sweep: typeof discover) {
  const observed = new Promise<void>((resolve) => registry.onSessionsObserved(resolve));
  const stop = startPoller(registry, platform, sweep);
  try {
    await observed;
  } finally {
    stop();
  }
}

test("on win32 the poller never runs the process walk, and still opens the sessions-observed gate", async () => {
  const registry = new Registry();
  const sdk = registry.registerSdkSession({ id: "sdk:restored", agent: "claude", name: "Restored", cwd: home });
  const { counter, sweep } = countingSweep();
  await runPollerOnce(registry, "win32", sweep);
  assert.equal(counter.calls, 0, "terminal discovery must not run on win32");
  assert.equal(registry.sessionsObserved(), true);
  // The sweep evicts only terminal sessions it did not see, so a restored SDK session survives.
  assert.deepEqual(registry.snapshot().sessions.map((s) => s.id), [sdk.id]);

  // Control: the same poller on darwin does run the walk, so the platform argument is what
  // decides it.
  const control = countingSweep();
  await runPollerOnce(new Registry(), "darwin", control.sweep);
  assert.equal(control.counter.calls, 1);
});

test("a terminal dispatch on win32 is refused with a reason before anything is provisioned", async () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "task-win32-terminal", status: "dispatching", repoRoot: home, agent: "claude" }));
  const supervisor = fakeSupervisor(registry);
  let provisioned = false;
  await new Dispatcher(registry, async () => {}, {
    platform: "win32",
    resolveRuntime: () => "terminal",
    supervisor,
    resolveBases: async () => {
      provisioned = true;
      throw new Error("provisioning was reached");
    },
    spawn: async () => {
      throw new Error("a terminal home was opened");
    },
  }).dispatch("task-win32-terminal");

  const task = registry.getTask("task-win32-terminal");
  assert.equal(task?.status, "failed");
  assert.match(task?.error ?? "", /terminal runtime is not available on Windows/);
  assert.match(task?.error ?? "", /Agent SDK in Settings > Harnesses/);
  assert.equal(provisioned, false);
  assert.equal(supervisor.starts.length, 0);
  assert.equal(task?.worktreePath ?? null, null);
});

test("an SDK dispatch on win32 starts an embedded session", async () => {
  const registry = new Registry();
  registry.upsertTask(
    mkTask({ id: "task-win32-sdk", status: "dispatching", repoRoot: seedRepo("win32-sdk-repo"), agent: "claude" }),
  );
  const supervisor = fakeSupervisor(registry);
  await new Dispatcher(registry, async () => {}, {
    platform: "win32",
    resolveRuntime: () => "sdk",
    supervisor,
    missionMcpDescriptor: async () => null,
  }).dispatch("task-win32-sdk");

  const task = registry.getTask("task-win32-sdk");
  assert.equal(task?.error ?? null, null);
  assert.equal(task?.status, "running");
  assert.equal(supervisor.starts.length, 1);
  assert.match(task?.sessionId ?? "", /^sdk:/);
});

test("a terminal-hosted Pipeline dispatch on win32 is refused with a reason before a home opens", async () => {
  const registry = new Registry();
  registry.upsertTask(
    mkTask({ id: "pipeline-win32-terminal", kind: "pipeline", agent: "claude", repoRoot: home, title: "Run conductor" }),
  );
  let spawned = false;
  await new Dispatcher(registry, async () => {}, {
    platform: "win32",
    pipelineLaunch: async () => ({
      ok: true,
      launchRuntime: "terminal",
      cwd: home,
      argv: ["/bin/conduct-ts", "engineer", "--idea", "Run conductor"],
      pipelineRun: { provider: "ai-conductor", repoRoot: home, slug: "run-conductor" },
    }),
    spawn: async () => {
      spawned = true;
      return { homeName: "unreachable terminal", homeBackend: "tmux", terminalResourceId: null };
    },
  }).dispatch("pipeline-win32-terminal");

  const task = registry.getTask("pipeline-win32-terminal");
  assert.equal(task?.status, "failed");
  assert.match(task?.error ?? "", /terminal runtime is not available on Windows/);
  assert.match(task?.error ?? "", /Switch the Pipelines launch runtime to Agent SDK/);
  assert.equal(spawned, false);
  assert.equal(task?.homeName ?? null, null);
});

/** An embedded driver that stays open until `end`, so a restored session stays live. */
function idleDriver() {
  let finish: () => void = () => {};
  const ended = new Promise<void>((resolve) => (finish = resolve));
  const handle = {
    events: {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<SdkEvent>> => {
          await ended;
          return { value: undefined, done: true };
        },
      }),
    },
    async send() {
      return "started" as const;
    },
    async sendIfIdle() {
      return "started" as const;
    },
    async interrupt() {},
    async answer() {},
    setPermissionMode: null,
    setEffort: null,
    setModel: null,
    clearContext: null,
    async stop() {
      finish();
    },
  };
  return { handle: handle as unknown as SdkHandle, end: finish };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition never held");
}

test("on win32 a restarted daemon restores its SDK session, rebinds the task, and completes it", async (t) => {
  // The previous daemon's state: a running SDK conversation bound to a running task.
  upsertSdkSession({
    id: "sdk:win32-restart",
    agent: "claude",
    agentSessionId: "agent-win32",
    cwd: home,
    taskId: "task-win32-restart",
    model: null,
    effort: null,
    permissionMode: null,
    status: "running",
    turnInProgress: false,
  });
  const driver = idleDriver();
  const launches: LaunchOptions[] = [];
  const real = HARNESSES.claude.sdk;
  HARNESSES.claude.sdk = { answersRequests: true, launch: async (opts) => (launches.push(opts), driver.handle) };
  t.after(() => (HARNESSES.claude.sdk = real));

  // The new daemon, wired in the order `src/server/index.ts` uses: SDK restore first, then
  // discovery, here on win32 where the poller never walks processes.
  const registry = new Registry();
  registry.upsertTask(
    mkTask({ id: "task-win32-restart", status: "running", agent: "claude", repoRoot: home, sessionId: "sdk:win32-restart" }),
  );
  const supervisor = new SdkSupervisor(registry);
  const tasks = new TaskManager(registry, undefined, supervisor);
  t.after(() => tasks.stopMissionSessionClosures());
  t.after(() => supervisor.stopAll());
  const { counter, sweep } = countingSweep();
  const observed = new Promise<void>((resolve) => registry.onSessionsObserved(resolve));
  const stop = await startDiscoveryAfterSdkRestore(
    supervisor.restore(),
    () => startPoller(registry, "win32", sweep),
    () => false,
    (error) => assert.fail(`restore failed: ${String(error)}`),
  );
  t.after(() => stop?.());
  await observed;

  // Restored as a continuation of the same conversation, not a new one.
  assert.equal(launches.length, 1);
  assert.equal(launches[0]!.resume, "agent-win32");
  assert.equal(launches[0]!.prompt, "");
  const session = registry.getSession("sdk:win32-restart");
  assert.equal(session?.runtime, "sdk");
  assert.notEqual(session?.state, "exited", "the empty win32 sweep must not evict a restored SDK session");
  assert.equal(counter.calls, 0, "terminal discovery stays off through the restart");
  // The task is still bound to the restored session after first-sweep reconciliation.
  const task = registry.getTask("task-win32-restart");
  assert.equal(task?.status, "running");
  assert.equal(task?.sessionId, "sdk:win32-restart");

  // And it completes.
  await tasks.complete("task-win32-restart", "done");
  await waitFor(() => registry.getTask("task-win32-restart")?.status === "done");
  driver.end();
});
