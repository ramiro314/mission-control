import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  EXIT_CAUSE_WAIT_MS,
  OUTCOME_BUDGET_MS,
  PROBE_TIMEOUT_MS,
  RESET_BUDGET_MS,
  SESSIONS_SLICE,
  createSessionScope,
  daemonUnit,
  formatPeak,
  oomStopLine,
  outOfMemoryText,
  productionSessionScopeDeps,
  scopeInstance,
  sessionScope,
  type SessionScope,
  type SessionScopeDeps,
  type SessionScopeRunResult,
  watchScopeExit,
} from "../src/server/platform/session-scope.ts";

const RUNTIME_DIR = "/run/user/1000";
const MANAGER_ENV = { XDG_RUNTIME_DIR: RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };
const DAEMON_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/mission-control.service\n";

interface Call {
  bin: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Deps on a fake clock: `sleep` advances `now` and resolves on the next macrotask, so a
 * pending fake `run` that resolves through microtasks always wins against it.
 */
function fakes(over: Partial<SessionScopeDeps> & {
  answer?: (call: Call) => SessionScopeRunResult | Promise<SessionScopeRunResult>;
} = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  let clock = 0;
  const { answer, ...rest } = over;
  const deps: SessionScopeDeps = {
    platform: "linux",
    env: MANAGER_ENV,
    stateHome: "/home/op/.mission-control",
    uid: 1000,
    systemdRun: () => "/usr/bin/systemd-run",
    systemctl: () => "/usr/bin/systemctl",
    choom: () => "/usr/bin/choom",
    socketExists: (path) => path === `${RUNTIME_DIR}/systemd/private` || path === `${RUNTIME_DIR}/bus`,
    ownCgroup: () => DAEMON_CGROUP,
    probeRuntime: () => ({ command: "/usr/bin/node", env: {} }),
    run: async (bin, args, opts) => {
      const call = { bin, args, env: opts.env };
      calls.push(call);
      return answer ? await answer(call) : { code: 0, stdout: "", stderr: "" };
    },
    log: (line) => logs.push(line),
    sleep: (ms) => new Promise((resolve) => setImmediate(() => {
      clock += ms;
      resolve();
    })),
    now: () => clock,
    nonce: () => "n0nce",
    ...rest,
  };
  return { deps, calls, logs, advance: (ms: number) => (clock += ms) };
}

const show = (fields: Record<string, string>): SessionScopeRunResult => ({
  code: 0,
  stdout: Object.entries(fields).map(([key, value]) => `${key}=${value}\n`).join(""),
  stderr: "",
});

const isProbe = (call: Call) => call.bin === "/usr/bin/systemd-run";
const isShow = (call: Call) => call.args[1] === "show";
const isReset = (call: Call) => call.args[1] === "reset-failed";

test("Linux with a manager and every executable: the exact argv, bound to the daemon's unit, under choom", async () => {
  const { deps, logs } = fakes();
  const scope = createSessionScope(deps);
  await scope.ready();
  const instance = scopeInstance(deps.stateHome);
  const wrapped = scope.wrap("/usr/bin/claude", ["--print", "a b"], MANAGER_ENV, "sdk:abc-123");
  const unit = `mission-control-${instance}-abc-123-n0nce`;
  assert.deepEqual(wrapped, {
    bin: "/usr/bin/systemd-run",
    args: [
      "--user", "--scope", "--quiet",
      `--unit=${unit}`,
      `--slice=${SESSIONS_SLICE}`,
      "-p", "OOMPolicy=stop",
      "-p", "TimeoutStopSec=10s",
      "-p", "BindsTo=mission-control.service",
      "-p", "After=mission-control.service",
      "--", "/usr/bin/choom", "-n", "500", "--", "/usr/bin/claude", "--print", "a b",
    ],
    unit: `${unit}.scope`,
  });
  assert.equal(SESSIONS_SLICE, "app-mission\\x2dcontrol\\x2dsessions.slice");
  assert.match(instance, /^[0-9a-f]{8}$/);
  assert.deepEqual(logs, [], "full isolation logs nothing");
});

test("BindsTo and After are omitted when the daemon's cgroup leaf is not a unit of this user manager", async () => {
  for (const cgroup of [
    "0::/user.slice/user-1000.slice/session-3.scope\n",
    "0::/user.slice/user-1001.slice/user@1001.service/app.slice/other.service\n",
    "0::/user.slice/user-1000.slice/user@1000.service/app.slice\n",
    null,
  ]) {
    const { deps, logs } = fakes({ ownCgroup: () => cgroup });
    const scope = createSessionScope(deps);
    await scope.ready();
    const { args } = scope.wrap("/bin/agent", [], MANAGER_ENV, "s1");
    assert.ok(!args.some((arg) => arg.startsWith("BindsTo=") || arg.startsWith("After=")), String(cgroup));
    assert.ok(args.includes("OOMPolicy=stop"));
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /isolation is partial: the daemon is not in a unit of the user manager/);
  }
  assert.equal(
    daemonUnit("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-ghostty-surface-transient-1.scope", 1000),
    "app-ghostty-surface-transient-1.scope",
  );
});

test("the instance prefix: two state homes name their scopes apart, and the startup reset names only its own", async () => {
  const a = fakes({ stateHome: "/tmp/home-a" });
  const b = fakes({ stateHome: "/tmp/home-b" });
  const scopeA = createSessionScope(a.deps);
  const scopeB = createSessionScope(b.deps);
  await Promise.all([scopeA.ready(), scopeB.ready()]);
  const ia = scopeInstance("/tmp/home-a");
  const ib = scopeInstance("/tmp/home-b");
  assert.notEqual(ia, ib);
  assert.match(scopeA.wrap("/bin/agent", [], MANAGER_ENV, "s").unit!, new RegExp(`^mission-control-${ia}-s-`));
  assert.match(scopeB.wrap("/bin/agent", [], MANAGER_ENV, "s").unit!, new RegExp(`^mission-control-${ib}-s-`));
  assert.deepEqual(a.calls.filter(isReset).map((call) => call.args), [
    ["--user", "reset-failed", `mission-control-${ia}-*.scope`],
  ]);
  assert.deepEqual(b.calls.filter(isReset).map((call) => call.args), [
    ["--user", "reset-failed", `mission-control-${ib}-*.scope`],
  ]);
});

test("under the test runner, production deps wrap nothing, and injected deps still wrap", async () => {
  await sessionScope.ready();
  assert.deepEqual(sessionScope.wrap("/bin/agent", ["x"], process.env, "sdk:s"), {
    bin: "/bin/agent",
    args: ["x"],
    unit: null,
  });
  assert.equal(await sessionScope.outcome("anything.scope"), null);
  const { deps } = fakes();
  const injected = createSessionScope(deps);
  await injected.ready();
  assert.equal(injected.wrap("/bin/agent", [], MANAGER_ENV, "s").bin, "/usr/bin/systemd-run");
  assert.equal(productionSessionScopeDeps.platform, process.platform);
});

test("darwin and win32: argv unchanged, no unit, nothing run or logged", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    const { deps, calls, logs } = fakes({ platform });
    const scope = createSessionScope(deps);
    await scope.ready();
    assert.deepEqual(scope.wrap("/bin/agent", ["a"], MANAGER_ENV, "s"), { bin: "/bin/agent", args: ["a"], unit: null });
    assert.deepEqual(calls, []);
    assert.deepEqual(logs, []);
  }
});

test("Linux without systemd-run or a manager: no scope, choom applied, exactly one log line across two wraps", async () => {
  const cases: [Partial<SessionScopeDeps>, RegExp][] = [
    [{ systemdRun: () => null }, /systemd-run was not found/],
    [{ socketExists: () => false }, /no systemd user manager is reachable/],
  ];
  for (const [over, why] of cases) {
    const { deps, calls, logs } = fakes(over);
    const scope = createSessionScope(deps);
    await scope.ready();
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(scope.wrap("/bin/agent", ["a"], MANAGER_ENV, "s"), {
        bin: "/usr/bin/choom",
        args: ["-n", "500", "--", "/bin/agent", "a"],
        unit: null,
      });
    }
    assert.equal(calls.filter(isProbe).length, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /session isolation is off/);
    assert.match(logs[0]!, why);
    assert.match(logs[0]!, /oom_score_adj 500 through choom/);
  }
});

test("Linux without systemd-run and without choom: argv unchanged, and the one off line says choom was not found", async () => {
  const { deps, calls, logs } = fakes({ systemdRun: () => null, choom: () => null });
  const scope = createSessionScope(deps);
  await scope.ready();
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(scope.wrap("/bin/agent", ["a"], MANAGER_ENV, "s"), { bin: "/bin/agent", args: ["a"], unit: null });
  }
  assert.equal(calls.filter(isProbe).length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /session isolation is off: systemd-run was not found/);
  assert.match(logs[0]!, /choom was not found, so oom_score_adj is unchanged/);
  assert.doesNotMatch(logs[0]!, /through choom/);
});

test("choom missing: a scope without choom, and the log line says so", async () => {
  const { deps, logs } = fakes({ choom: () => null });
  const scope = createSessionScope(deps);
  await scope.ready();
  const { args } = scope.wrap("/bin/agent", ["a"], MANAGER_ENV, "s");
  assert.deepEqual(args.slice(args.indexOf("--")), ["--", "/bin/agent", "a"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /isolation is partial: choom was not found, so oom_score_adj is unchanged/);
});

test("the probe refuses OOMPolicy: it retries without it; refusing entirely leaves sessions unwrapped", async () => {
  const partial = fakes({
    answer: (call) => ({ code: isProbe(call) && call.args.includes("OOMPolicy=stop") ? 1 : 0, stdout: "", stderr: "" }),
  });
  const scope = createSessionScope(partial.deps);
  await scope.ready();
  const probes = partial.calls.filter(isProbe);
  assert.equal(probes.length, 2);
  assert.ok(probes[0]!.args.includes("--collect"));
  assert.deepEqual(probes[0]!.args.slice(probes[0]!.args.indexOf("--")), ["--", "/usr/bin/node", "-e", ""]);
  assert.ok(!probes[1]!.args.includes("OOMPolicy=stop"));
  const wrapped = scope.wrap("/bin/agent", [], MANAGER_ENV, "s");
  assert.equal(wrapped.bin, "/usr/bin/systemd-run");
  assert.ok(!wrapped.args.includes("OOMPolicy=stop"));
  assert.ok(wrapped.args.includes("TimeoutStopSec=10s"));
  assert.ok(!wrapped.args.includes("--collect"), "a session scope keeps its Result for outcome");
  assert.equal(partial.logs.length, 1);
  assert.match(partial.logs[0]!, /isolation is partial: this systemd refused OOMPolicy=stop/);

  const refused = fakes({ answer: (call) => ({ code: isProbe(call) ? 1 : 0, stdout: "", stderr: "" }) });
  const off = createSessionScope(refused.deps);
  await off.ready();
  assert.equal(refused.calls.filter(isProbe).length, 2);
  assert.deepEqual(off.wrap("/bin/agent", [], MANAGER_ENV, "s"), {
    bin: "/usr/bin/choom",
    args: ["-n", "500", "--", "/bin/agent"],
    unit: null,
  });
  assert.equal(refused.logs.length, 1);
  assert.match(refused.logs[0]!, /isolation is off: this systemd refused the session scope's properties/);
});

test("the probe runtime: an Electron app binary runs with ELECTRON_RUN_AS_NODE=1, node adds nothing", async () => {
  const { resolveMissionMcpRuntime } = await import("../src/server/mission-mcp.ts");
  for (const [execPath, expected] of [
    ["/opt/Mission Control/mission-control", "1"],
    ["/usr/bin/node", undefined],
  ] as const) {
    const { deps, calls } = fakes({ probeRuntime: () => resolveMissionMcpRuntime(execPath) });
    await createSessionScope(deps).ready();
    const probe = calls.find(isProbe)!;
    assert.deepEqual(probe.args.slice(probe.args.indexOf("--")), ["--", execPath, "-e", ""]);
    assert.equal(probe.env?.ELECTRON_RUN_AS_NODE, expected);
  }
});

test("the probe timeout: a hung probe leaves every session unwrapped, says so, and ready still settles", async () => {
  const { deps, logs } = fakes({
    answer: (call) => (isProbe(call) ? new Promise<SessionScopeRunResult>(() => {}) : { code: 0, stdout: "", stderr: "" }),
  });
  const scope = createSessionScope(deps);
  await scope.ready();
  assert.ok(deps.now() >= PROBE_TIMEOUT_MS);
  assert.equal(scope.wrap("/bin/agent", [], MANAGER_ENV, "s").unit, null);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /isolation is off: the systemd-run probe timed out/);

  // The probe's own run timing out reads the same.
  const timedOut = fakes();
  timedOut.deps.run = async (bin, args, opts) => {
    if (bin !== "/usr/bin/systemd-run") return { code: 0, stdout: "", stderr: "" };
    timedOut.advance(opts.timeoutMs);
    return { code: null, stdout: "", stderr: "" };
  };
  const other = createSessionScope(timedOut.deps);
  await other.ready();
  assert.equal(other.wrap("/bin/agent", [], MANAGER_ENV, "s").unit, null);
  assert.match(timedOut.logs[0]!, /the systemd-run probe timed out/);
});

test("before ready, and for a child env with no manager, a wrap makes no scope", async () => {
  const { deps } = fakes();
  const scope = createSessionScope(deps);
  assert.equal(scope.wrap("/bin/agent", [], MANAGER_ENV, "s").unit, null, "not decided yet");
  await scope.ready();
  assert.equal(scope.wrap("/bin/agent", [], {}, "s").unit, null);
  assert.equal(scope.wrap("/bin/agent", [], {}, "s").bin, "/usr/bin/choom");
});

/** A `systemctl show` that answers each read with the next entry, holding at the last. */
function scripted(reads: Record<string, string>[]) {
  let at = 0;
  return fakes({
    answer: (call) => {
      if (!isShow(call)) return { code: 0, stdout: "", stderr: "" };
      const read = reads[Math.min(at, reads.length - 1)]!;
      at += 1;
      return show(read);
    },
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("outcome: oom-kill with a peak, and success", async () => {
  const oom = scripted([{ ActiveState: "failed", Result: "oom-kill", MemoryPeak: "16320875315" }]);
  assert.deepEqual(await createSessionScope(oom.deps).outcome("u.scope"), { oomKilled: true, peakBytes: 16320875315 });
  assert.deepEqual(oom.calls.filter(isShow)[0]!.args, [
    "--user", "show", "u.scope", "-p", "ActiveState", "-p", "Result", "-p", "MemoryPeak",
  ]);
  const clean = scripted([{ ActiveState: "inactive", Result: "success", MemoryPeak: "[not set]" }]);
  assert.deepEqual(await createSessionScope(clean.deps).outcome("u.scope"), { oomKilled: false, peakBytes: null });
});

test("outcome: the agent killed directly reads active first, then oom-kill on a later poll", async () => {
  const { deps } = scripted([
    { ActiveState: "active", Result: "success" },
    { ActiveState: "active", Result: "success" },
    { ActiveState: "failed", Result: "oom-kill", MemoryPeak: "1610612736" },
  ]);
  assert.deepEqual(await createSessionScope(deps).outcome("u.scope"), { oomKilled: true, peakBytes: 1610612736 });
  assert.ok(deps.now() < OUTCOME_BUDGET_MS);
});

test("outcome: a unit still active when the 2 s budget runs out reads as not OOM-killed", async () => {
  const { deps, calls } = scripted([{ ActiveState: "active", Result: "success" }]);
  assert.deepEqual(await createSessionScope(deps).outcome("u.scope"), { oomKilled: false, peakBytes: null });
  assert.ok(deps.now() >= OUTCOME_BUDGET_MS);
  assert.ok(calls.filter(isShow).length > 2, "it polled");
});

test("outcome: a systemctl failure, a timeout, or no systemctl gives null", async () => {
  for (const code of [1, null]) {
    const { deps } = fakes({ answer: () => ({ code, stdout: "", stderr: "" }) });
    assert.equal(await createSessionScope(deps).outcome("u.scope"), null);
  }
  const { deps } = fakes({ systemctl: () => null });
  assert.equal(await createSessionScope(deps).outcome("u.scope"), null);
  const thrown = fakes({ answer: () => { throw new Error("boom"); } });
  assert.equal(await createSessionScope(thrown.deps).outcome("u.scope"), null);
});

test("reset-failed runs once the unit has settled, after a deactivating oom-kill has returned its verdict", async () => {
  const { deps, calls } = scripted([
    { ActiveState: "deactivating", Result: "oom-kill", MemoryPeak: "100" },
    { ActiveState: "deactivating", Result: "oom-kill", MemoryPeak: "100" },
    { ActiveState: "failed", Result: "oom-kill", MemoryPeak: "100" },
  ]);
  const verdict = await createSessionScope(deps).outcome("u.scope");
  assert.deepEqual(verdict, { oomKilled: true, peakBytes: 100 });
  assert.equal(calls.filter(isShow).length, 1, "the verdict did not wait for the unit to settle");
  assert.equal(calls.filter(isReset).length, 0);
  await settle();
  assert.equal(calls.filter(isShow).length, 3);
  assert.deepEqual(calls.filter(isReset).map((call) => call.args), [["--user", "reset-failed", "u.scope"]]);
});

test("a unit that never settles within 15 s is left to the startup reset", async () => {
  const { deps, calls } = scripted([{ ActiveState: "deactivating", Result: "oom-kill" }]);
  assert.equal((await createSessionScope(deps).outcome("u.scope"))?.oomKilled, true);
  await settle();
  assert.ok(deps.now() >= RESET_BUDGET_MS);
  assert.equal(calls.filter(isReset).length, 0);
});

test("the OOM log line names the session, the unit and the peak in base-1024 units", () => {
  assert.equal(formatPeak(1610612736), "1.5 GB");
  assert.equal(formatPeak(16320875315), "15.2 GB");
  assert.equal(
    oomStopLine("sdk:abc", "mission-control-1234abcd-abc-n0nce.scope", 1610612736),
    "[session-scope] session sdk:abc ran out of memory: systemd stopped mission-control-1234abcd-abc-n0nce.scope (peak 1.5 GB)",
  );
  assert.doesNotMatch(oomStopLine("s", "u.scope", null), /peak/);
});

test("the production deps read the state home when asked, not when the module loaded", () => {
  // A test file sets its home after its static imports, and this module is in the harness
  // registry's graph, so freezing the home at import refused every such file's database.
  const before = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = "/tmp/mission-session-scope-late-home";
  try {
    assert.equal(productionSessionScopeDeps.stateHome, "/tmp/mission-session-scope-late-home");
  } finally {
    process.env.HARNESS_HOME = before;
  }
});

/** A child that only emits, and a scope whose `outcome` answers when `answer` is called. */
function watched(started = true) {
  const child = Object.assign(new EventEmitter(), { pid: started ? 4242 : undefined }) as unknown as ChildProcess;
  let answer!: (verdict: { oomKilled: boolean; peakBytes: number | null } | null) => void;
  const reads: string[] = [];
  const scope: SessionScope = {
    ready: async () => {},
    wrap: (bin, args) => ({ bin, args: [...args], unit: null }),
    outcome: (unit) => {
      reads.push(unit);
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
  };
  return { child, scope, reads, answer: (v: Parameters<typeof answer>[0]) => answer(v) };
}

test("watchScopeExit hands the driver an OOM stop as an out_of_memory cause and logs it once", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const w = watched();
  const exitCause = watchScopeExit(w.child, w.scope, "mission-control-x.scope", "sdk:watched");
  assert.deepEqual(w.reads, [], "nothing is read before the child exits");
  w.child.emit("exit", null, "SIGKILL");
  w.answer({ oomKilled: true, peakBytes: 1610612736 });
  assert.deepEqual(await exitCause(), { kind: "out_of_memory", peakBytes: 1610612736 });
  assert.deepEqual(await exitCause(), { kind: "out_of_memory", peakBytes: 1610612736 }, "a second ask gets the same answer");
  assert.deepEqual(w.reads, ["mission-control-x.scope"], "one read per exit");
  assert.equal(warn.mock.callCount(), 1);
});

test("watchScopeExit gives null for a clean stop, an unknown verdict, no unit, or a child that never started", async () => {
  for (const verdict of [{ oomKilled: false, peakBytes: 5 }, null]) {
    const w = watched();
    const exitCause = watchScopeExit(w.child, w.scope, "mission-control-x.scope", "sdk:watched");
    w.child.emit("exit", 0, null);
    w.answer(verdict);
    assert.equal(await exitCause(), null, JSON.stringify(verdict));
  }
  const unscoped = watched();
  assert.equal(await watchScopeExit(unscoped.child, unscoped.scope, null, "sdk:watched")(), null);
  unscoped.child.emit("exit", 0, null);
  assert.deepEqual(unscoped.reads, [], "no unit, no read");

  const neverStarted = watched(false);
  const exitCause = watchScopeExit(neverStarted.child, neverStarted.scope, "mission-control-x.scope", "sdk:watched");
  neverStarted.child.emit("error", new Error("spawn ENOENT"));
  assert.equal(await exitCause(), null);
});

test("watchScopeExit stops waiting for a verdict after EXIT_CAUSE_WAIT_MS", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = watched();
  const exitCause = watchScopeExit(w.child, w.scope, "mission-control-x.scope", "sdk:watched");
  w.child.emit("exit", null, "SIGKILL");
  const answer = exitCause();
  t.mock.timers.tick(EXIT_CAUSE_WAIT_MS);
  assert.equal(await answer, null, "a verdict that never arrives never holds the exit");
});

test("the task failure text prints the peak in base-1024 units, and drops it when unknown", () => {
  assert.equal(outOfMemoryText(1610612736), "stopped: the session ran out of memory (peak 1.5 GB)");
  assert.equal(outOfMemoryText(16320875724), "stopped: the session ran out of memory (peak 15.2 GB)");
  assert.equal(outOfMemoryText(null), "stopped: the session ran out of memory");
});
