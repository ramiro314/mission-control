import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { locateExecutableSync } from "../src/server/executables/locator.ts";
import { socketExists, userManagerReachable } from "../src/server/graphical-session.ts";
import {
  SESSIONS_SLICE,
  createSessionScope,
  productionSessionScopeDeps,
  scopeInstance,
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
  const wrapped = scope.wrap("/bin/sh", ["-c", `sleep 60 & echo $!; ${HOG}; wait`], process.env, "sdk:child-oom");
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

  // One process does all the allocating, so once the kernel kills it nothing else in the scope
  // keeps charging memory. With `HOG`'s `head | tail`, `head` went on filling the pipe after
  // `tail` was killed. When the OOM reaper was slow to free `tail`, that second allocation
  // made the kernel pick the shell itself, a SIGKILL (137) that beat systemd's SIGTERM.
  // The same 512 MB ceiling as `HOG`.
  const hog = `'${process.execPath}' -e 'const a = []; for (let i = 0; i < 64; i++) a.push(Buffer.alloc(8 << 20, 1));'`;
  const oom = await bash(`sleep 60 & ${hog}; wait`);
  assert.equal(oom.exit_code, 143, `the command was stopped by systemd's SIGTERM: ${JSON.stringify(oom)}`);
  // `--collect`: systemd unloads the failed scope itself, and the daemon never reads it back.
  await waitFor("the OOM-stopped command scope to be collected", async () => (await loadState(units[1]!)) === "not-found", 20_000);

  const after = await bash("echo still here");
  assert.deepEqual(after, { ...after, exit_code: 0, output: "still here\n" }, "the session's next command runs");
  assert.match(units[2]!, /-pi-commands-[0-9a-f]{8}-3\.scope$/);
  assert.ok(alive(process.pid));
});
