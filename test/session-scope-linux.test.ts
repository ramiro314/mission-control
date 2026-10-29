import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { locateExecutableSync } from "../src/server/executables/locator.ts";
import { spawnAppServer } from "../src/server/harness/codex/sdk-deps.ts";
import { socketExists, userManagerReachable } from "../src/server/graphical-session.ts";
import {
  SESSIONS_SLICE,
  createSessionScope,
  productionSessionScopeDeps,
  scopeInstance,
  type SessionScope,
  type SessionScopeDeps,
} from "../src/server/platform/session-scope.ts";

// Real scopes in the operator's user manager, on purpose. Every one is named under the
// `<instance>` of this file's own temp home, so they never collide with the operator's daemon's
// scopes, and this file's resets never touch them.

const uid = process.getuid?.() ?? -1;

function memoryDelegated(): boolean {
  try {
    const path = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`;
    return readFileSync(path, "utf8").split(/\s+/).includes("memory");
  } catch {
    return false;
  }
}

const systemdRun = process.platform === "linux" ? locateExecutableSync("systemd-run")?.path : undefined;
const systemctl = process.platform === "linux" ? locateExecutableSync("systemctl")?.path : undefined;
const skip =
  process.platform !== "linux" ? "Linux only"
  : !userManagerReachable(process.env, socketExists) ? "no systemd user manager is reachable"
  : !systemdRun || !locateExecutableSync("choom") || !systemctl ? "systemd-run, choom or systemctl does not resolve"
  : !memoryDelegated() ? "the user manager does not delegate the memory controller"
  : false;

const home = mkdtempSync(join(tmpdir(), "mission-session-scope-linux-"));
const instance = scopeInstance(home);
// A 512 MB ceiling on what any hog here can ask for, so it cannot press on the machine even if
// the cap were not applied.
const HOG = "head -c 536870912 /dev/zero | tail > /dev/null";
/**
 * The same 512 MB ceiling as `HOG`, from one process that does all the allocating, so once the
 * kernel kills it nothing else in the scope keeps charging memory. With `HOG`'s `head | tail`,
 * `head` went on filling the pipe after `tail` was killed; when the OOM reaper was slow to free
 * `tail`, that second allocation made the kernel pick the shell itself, a SIGKILL that beat
 * systemd's SIGTERM. A test that pins the SIGTERM path uses this one.
 */
const LONE_HOG = `'${process.execPath}' -e 'const a = []; for (let i = 0; i < 64; i++) a.push(Buffer.alloc(8 << 20, 1));'`;

function scopeFor(over: Partial<SessionScopeDeps> = {}) {
  return createSessionScope({
    ...productionSessionScopeDeps,
    stateHome: home,
    extraProperties: ["MemoryMax=64M", "MemorySwapMax=0"],
    log: () => {},
    ...over,
  });
}

function systemctlUser(...args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(systemctl!, ["--user", ...args], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("close", () => resolve(out));
  });
}

/** The user manager's systemd version, from `systemctl --version`'s first line. */
async function systemdVersion(): Promise<number> {
  return Number(/systemd (\d+)/.exec(await systemctlUser("--version"))?.[1] ?? 0);
}

async function loadState(unit: string): Promise<string> {
  return (await systemctlUser("show", unit, "-p", "LoadState")).trim().replace(/^LoadState=/, "");
}

async function waitFor(what: string, check: () => Promise<boolean> | boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.after(async () => {
  if (!skip) {
    await systemctlUser("stop", `mission-control-${instance}-*.scope`);
    await systemctlUser("reset-failed", `mission-control-${instance}-*.scope`);
  }
  rmSync(home, { recursive: true, force: true });
});

test("a wrapped process runs in its own scope in the sessions slice at oom_score_adj 500", { skip, timeout: 30_000 }, async () => {
  const scope = scopeFor();
  await scope.ready();
  const own = readFileSync("/proc/self/cgroup", "utf8");
  const wrapped = scope.wrap("/bin/sh", ["-c", "cat /proc/self/cgroup /proc/self/oom_score_adj"], process.env, "sdk:placement");
  assert.ok(wrapped.unit);
  const child = spawn(wrapped.bin, wrapped.args, { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout!.on("data", (chunk) => (out += chunk));
  assert.deepEqual(await exited(child), { code: 0, signal: null });
  const [cgroup, adj] = out.trim().split("\n");
  const escaped = SESSIONS_SLICE.replace(/\\/g, "\\\\").replace(/\./g, "\\.");
  assert.match(cgroup!, new RegExp(`${escaped}/mission-control-${instance}-placement-[0-9a-f]{8}\\.scope$`));
  assert.equal(adj, "500");
  assert.equal(readFileSync("/proc/self/cgroup", "utf8"), own, "the test process, standing in for the daemon, stayed put");
  assert.equal((await scope.outcome(wrapped.unit))?.oomKilled, false);
});

test("an OOM kill of a child stops that scope only, and outcome reads it before the unit is reset", { skip, timeout: 40_000 }, async () => {
  const scope = scopeFor();
  await scope.ready();
  const wrapped = scope.wrap("/bin/sh", ["-c", `sleep 60 & echo $!; ${LONE_HOG}; wait`], process.env, "sdk:child-oom");
  const child = spawn(wrapped.bin, wrapped.args, { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout!.on("data", (chunk) => (out += chunk));
  const exit = await exited(child);
  assert.ok(exit.signal === "SIGTERM" || exit.code === 143, `the wrapped process exited from systemd's SIGTERM, not ${JSON.stringify(exit)}`);
  const sibling = Number(out.trim().split("\n")[0]);
  assert.ok(sibling > 0);
  // Stopped by the same SIGTERM, but it can outlive the shell by a beat: orphaned when the
  // shell exits, it is reaped by whoever adopts it, and `kill(pid, 0)` still answers for an
  // unreaped zombie. Gone well inside the scope's own stop timeout either way.
  await waitFor("its sleeping sibling to be gone", () => !alive(sibling), 5_000);
  const verdict = await scope.outcome(wrapped.unit!);
  assert.equal(verdict?.oomKilled, true);
  // `MemoryPeak` arrived in systemd 256. An older one (Ubuntu 24.04's 255, which GitHub's
  // runners carry) reports none, and `outcome` says so rather than inventing a number.
  if ((await systemdVersion()) >= 256) assert.ok((verdict?.peakBytes ?? 0) > 0, `peak ${verdict?.peakBytes}`);
  else assert.equal(verdict?.peakBytes, null);
  await waitFor("the unit to be reset", async () => (await loadState(wrapped.unit!)) === "not-found", 20_000);
  assert.ok(alive(process.pid));
});

test("a wrapped process that is itself the hog is SIGKILLed, and outcome still reads oom-kill", { skip, timeout: 40_000 }, async () => {
  const scope = scopeFor();
  await scope.ready();
  const hog = "const a = []; for (let i = 0; i < 64; i++) a.push(Buffer.alloc(8 << 20, 1));";
  const wrapped = scope.wrap(process.execPath, ["-e", hog], process.env, "sdk:self-oom");
  const child = spawn(wrapped.bin, wrapped.args, { stdio: "ignore" });
  assert.deepEqual(await exited(child), { code: null, signal: "SIGKILL" });
  assert.equal((await scope.outcome(wrapped.unit!))?.oomKilled, true);
});

test("a straggler that ignores SIGTERM: outcome answers at once, and the unit is reset once it has stopped", { skip, timeout: 60_000 }, async () => {
  const scope = scopeFor();
  await scope.ready();
  const straggler = `sh -c 'trap "" TERM; while :; do sleep 0.2 || :; done' &`;
  const wrapped = scope.wrap("/bin/sh", ["-c", `${straggler} ${HOG}; wait`], process.env, "sdk:straggler");
  const child = spawn(wrapped.bin, wrapped.args, { stdio: "ignore" });
  await exited(child);
  const started = Date.now();
  assert.equal((await scope.outcome(wrapped.unit!))?.oomKilled, true);
  assert.ok(Date.now() - started < 2500, "the verdict did not wait for the straggler");
  assert.equal(
    (await systemctlUser("show", wrapped.unit!, "-p", "ActiveState")).trim(),
    "ActiveState=deactivating",
    "the straggler still holds the scope",
  );
  await waitFor("the unit to be reset", async () => (await loadState(wrapped.unit!)) === "not-found", 20_000);
});

test("BindsTo: stopping the daemon's unit stops the session scopes bound to it", { skip, timeout: 30_000 }, async () => {
  const standIn = `mission-control-${instance}-standin-daemon`;
  const daemon = spawn(systemdRun!, [
    "--user", "--scope", "--quiet", "--collect", `--unit=${standIn}`, `--slice=${SESSIONS_SLICE}`, "--", "sleep", "60",
  ], { stdio: "ignore" });
  const daemonExit = exited(daemon);
  await waitFor("the stand-in daemon", async () => (await systemctlUser("is-active", `${standIn}.scope`)).trim() === "active", 10_000);
  const scope = scopeFor({
    ownCgroup: () => `0::/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${SESSIONS_SLICE}/${standIn}.scope\n`,
  });
  await scope.ready();
  const wrapped = scope.wrap("/bin/sleep", ["60"], process.env, "sdk:bound");
  assert.ok(wrapped.args.includes(`BindsTo=${standIn}.scope`));
  const sleeper = spawn(wrapped.bin, wrapped.args, { stdio: "ignore" });
  await waitFor("the bound scope", async () => (await systemctlUser("is-active", wrapped.unit!)).trim() === "active", 10_000);
  const sleeperExit = exited(sleeper);
  await systemctlUser("stop", `${standIn}.scope`);
  const exit = await sleeperExit;
  assert.notEqual(exit.code, 0, "the sleeper was stopped, not finished");
  await daemonExit;
});

test("Pi bash commands: each in its own collected scope at 500, an OOM stops that command only", { skip, timeout: 60_000 }, async () => {
  // Pi's real bash tool and shell, so the 143 is what Pi itself reports to the agent.
  process.env.PI_CODING_AGENT_DIR = join(home, "pi-agent");
  const pi = await import("@earendil-works/pi-coding-agent");
  const { bashSpawnHook } = await import("../src/server/harness/pi/sdk-deps.ts");
  const scope = scopeFor();
  await scope.ready();
  const units: string[] = [];
  const commands = scope.commands("sdk:pi-commands");
  const hook = bashSpawnHook(() => pi.getShellConfig(undefined), (bin, args, env) => {
    const wrapped = commands(bin, args, env);
    if (wrapped.unit) units.push(wrapped.unit);
    return wrapped;
  }, {
    PATH: process.env.PATH ?? "",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "",
    ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
  });
  const tool = pi.createBashToolDefinition(home, { spawnHook: hook });
  const bash = async (command: string) => ((await (tool.execute as unknown as (
    id: string, params: { command: string }) => Promise<unknown>)("call", { command })) as {
    structuredContent: { output: string; exit_code: number };
  }).structuredContent;

  const placed = await bash("cat /proc/self/cgroup /proc/self/oom_score_adj");
  assert.equal(placed.exit_code, 0, placed.output);
  const [cgroup, adj] = placed.output.trim().split("\n");
  const escaped = SESSIONS_SLICE.replace(/\\/g, "\\\\").replace(/\./g, "\\.");
  assert.match(cgroup!, new RegExp(`${escaped}/mission-control-${instance}-pi-commands-[0-9a-f]{8}-1\\.scope$`));
  assert.equal(adj, "500");

  // `LONE_HOG`, for the reason it gives: the kernel picking the shell itself is a SIGKILL (137).
  // 137 is an accepted production outcome, as is a lone hog bash runs in its own place (see
  // "Pi command scopes" in docs/harnesses-and-terminals.md). This pins the other path: the
  // kernel kills a child, and systemd's SIGTERM stops the shell with 143.
  const oom = await bash(`sleep 60 & ${LONE_HOG}; wait`);
  assert.equal(oom.exit_code, 143, `the command was stopped by systemd's SIGTERM: ${JSON.stringify(oom)}`);
  // `--collect`: systemd unloads the failed scope itself, and the daemon never reads it back.
  await waitFor("the OOM-stopped command scope to be collected", async () => (await loadState(units[1]!)) === "not-found", 20_000);

  const after = await bash("echo still here");
  assert.deepEqual(after, { ...after, exit_code: 0, output: "still here\n" }, "the session's next command runs");
  assert.match(units[2]!, /-pi-commands-[0-9a-f]{8}-3\.scope$/);
  assert.ok(alive(process.pid));
});

/** A fake `codex` in this file's home: `body` runs as the app-server, and it serves until stdin closes. */
function fakeCodex(name: string, body: string): string {
  const path = join(home, name);
  writeFileSync(path, `#!/bin/sh\n${body}\ncat > /dev/null\n`);
  chmodSync(path, 0o755);
  return path;
}

/** `scope`, recording the unit each wrap made. */
function recordingScope(scope: SessionScope): { scope: SessionScope; units: string[] } {
  const units: string[] = [];
  return {
    units,
    scope: {
      ready: () => scope.ready(),
      wrap(...args) {
        const wrapped = scope.wrap(...args);
        if (wrapped.unit) units.push(wrapped.unit);
        return wrapped;
      },
      outcome: (unit) => scope.outcome(unit),
      commands: (label) => scope.commands(label),
    },
  };
}

test("a Codex session's app-server and its children run in its own scope at oom_score_adj 500", { skip, timeout: 30_000 }, async () => {
  const { scope, units } = recordingScope(scopeFor());
  await scope.ready();
  const own = readFileSync("/proc/self/cgroup", "utf8");
  const server = join(home, "codex-server");
  const child = join(home, "codex-child");
  const codex = fakeCodex("fake-codex-placement", [
    `cat /proc/$$/cgroup /proc/$$/oom_score_adj > "${server}"`,
    `sh -c 'cat /proc/$$/cgroup /proc/$$/oom_score_adj' > "${child}"`,
  ].join("\n"));
  const transport = spawnAppServer(codex, [], home, process.env, { label: "sdk:codex-placement", scope });
  await waitFor("the fake app-server's report", () => existsSync(child) && readFileSync(child, "utf8").includes("\n"), 10_000);
  await transport.close();
  assert.equal(units.length, 1);
  const escaped = SESSIONS_SLICE.replace(/\\/g, "\\\\").replace(/\./g, "\\.");
  const inScope = new RegExp(`${escaped}/mission-control-${instance}-codex-placement-[0-9a-f]{8}\\.scope$`);
  for (const report of [server, child]) {
    const [cgroup, adj] = readFileSync(report, "utf8").trim().split("\n");
    assert.match(cgroup!, inScope, report);
    assert.ok(cgroup!.endsWith(`/${units[0]}`), report);
    assert.equal(adj, "500", report);
  }
  assert.equal(readFileSync("/proc/self/cgroup", "utf8"), own, "the test process, standing in for the daemon, stayed put");
  // A model-catalog probe passes no session, so it is spawned as given.
  const probeReport = join(home, "codex-probe");
  const probe = spawnAppServer(fakeCodex("fake-codex-probe", `cat /proc/$$/cgroup > "${probeReport}"`), [], home, process.env);
  await waitFor("the probe's report", () => existsSync(probeReport) && readFileSync(probeReport, "utf8").includes("\n"), 10_000);
  await probe.close();
  assert.equal(readFileSync(probeReport, "utf8"), own, "the probe stayed in the test process's cgroup");
});

test("an OOM kill under a Codex app-server stops its scope, and the server's exit logs it and resets the unit", { skip, timeout: 40_000 }, async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const { scope, units } = recordingScope(scopeFor());
  await scope.ready();
  const transport = spawnAppServer(fakeCodex("fake-codex-oom", HOG), [], home, process.env, { label: "sdk:codex-oom", scope });
  t.after(() => transport.close());
  assert.equal(units.length, 1);
  const logged = () => warn.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.startsWith("[session-scope]"));
  // Nothing here calls `outcome`: the server's own exit listener does.
  await waitFor("the OOM stop's log line", () => logged().length > 0, 20_000);
  assert.equal(logged().length, 1);
  assert.match(logged()[0]!, new RegExp(`^\\[session-scope\\] session sdk:codex-oom ran out of memory: systemd stopped ${units[0]!.replace(/\./g, "\\.")}`));
  await waitFor("the unit to be reset", async () => (await loadState(units[0]!)) === "not-found", 20_000);
  assert.ok(alive(process.pid));
});
