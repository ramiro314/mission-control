import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import {
  createPosixProcessLifetime,
  processLifetimeFor,
  type ProcessLifetimeDeps,
} from "../src/server/platform/process-lifetime.ts";

const SEAM = "src/server/platform/process-lifetime.ts";

function recorder(killError?: () => Error) {
  const kills: Array<[number, NodeJS.Signals | 0]> = [];
  const deps: ProcessLifetimeDeps = {
    kill: (pid, signal) => {
      kills.push([pid, signal]);
      if (killError) throw killError();
    },
  };
  return { deps, kills };
}

function fakeChild(pid: number | undefined, throws = false) {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const child = {
    pid,
    kill: (signal?: NodeJS.Signals | number) => {
      signals.push(signal);
      if (throws) throw new Error("gone");
      return true;
    },
  };
  return { child, signals };
}

const esrch = (): Error => Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });

test("POSIX tree-root spawn options are exactly detached: true, and cannot be edited", () => {
  const { treeRootOptions } = createPosixProcessLifetime(recorder().deps);

  assert.deepEqual(treeRootOptions, { detached: true });
  assert.ok(Object.isFrozen(treeRootOptions));
  assert.deepEqual(
    { ...treeRootOptions, cwd: "/repo", stdio: ["ignore", "pipe", "pipe"] },
    { detached: true, cwd: "/repo", stdio: ["ignore", "pipe", "pipe"] },
    "spread into a call site, it adds detached and leaves every other option alone",
  );
});

test("POSIX signalTree signals the negative pid with the signal it was given", () => {
  const { deps, kills } = recorder();
  const lifetime = createPosixProcessLifetime(deps);

  lifetime.signalTree(4242, "SIGTERM");
  lifetime.signalTree(4242, "SIGKILL");
  lifetime.signalTree(4242, 0);

  assert.deepEqual(kills, [[-4242, "SIGTERM"], [-4242, "SIGKILL"], [-4242, 0]]);
});

test("POSIX signalTree throws what process.kill throws, so a probe can read ESRCH", () => {
  const { deps } = recorder(esrch);
  const lifetime = createPosixProcessLifetime(deps);

  assert.throws(() => lifetime.signalTree(4242, 0), { code: "ESRCH" });
});

test("POSIX killTree SIGKILLs the group and leaves the child handle alone", () => {
  const { deps, kills } = recorder();
  const { child, signals } = fakeChild(4242);

  createPosixProcessLifetime(deps).killTree(child);

  assert.deepEqual(kills, [[-4242, "SIGKILL"]]);
  assert.deepEqual(signals, []);
});

test("POSIX killTree falls back to SIGKILL on the child when the group signal fails", () => {
  const { deps, kills } = recorder(esrch);
  const { child, signals } = fakeChild(4242);

  createPosixProcessLifetime(deps).killTree(child);

  assert.deepEqual(kills, [[-4242, "SIGKILL"]]);
  assert.deepEqual(signals, ["SIGKILL"]);
});

test("POSIX killTree with no pid signals the child directly and sends no group signal", () => {
  const { deps, kills } = recorder();
  const { child, signals } = fakeChild(undefined);

  createPosixProcessLifetime(deps).killTree(child);

  assert.deepEqual(kills, []);
  assert.deepEqual(signals, ["SIGKILL"]);
});

test("POSIX killTree never throws, even when the group and the child both refuse", () => {
  const { deps } = recorder(esrch);
  const { child } = fakeChild(4242, true);

  assert.doesNotThrow(() => createPosixProcessLifetime(deps).killTree(child));
});

test("nothing is registered for win32 on main: every platform resolves to POSIX", () => {
  assert.equal(processLifetimeFor("win32"), processLifetimeFor("darwin"));
  assert.equal(processLifetimeFor("linux"), processLifetimeFor("darwin"));
});

test("the seam imports only Node builtins, so the Electron and daemon bundles can both take it", () => {
  const source = readFileSync(SEAM, "utf8");
  const specifiers = [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.match(specifier, /^node:/);
});

test("no process-group spawn or signal is written outside the seam", () => {
  // Code lines only: comments are allowed to name the mechanism they explain.
  const groupSignal = /^(?!\s*(\/\/|\*))[^\n]*process\.kill\(\s*-/m;
  const groupSpawn = /^\s*detached:\s*(true|process\.platform)/m;
  // Herdr's server is launched to outlive the daemon and is never signalled, so it is not a
  // supervised tree; its injected spawn's `detached` option is pinned by its own tests.
  const daemonised = new Set(["src/server/terminal/herdr-client.ts"]);
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mts)$/.test(entry.name)) {
        const file = relative(".", path);
        if (file === SEAM) continue;
        const source = readFileSync(path, "utf8");
        if (groupSignal.test(source)) offenders.push(`${file}: process.kill(-pid)`);
        if (!daemonised.has(file) && groupSpawn.test(source)) offenders.push(`${file}: detached`);
      }
    }
  };
  walk("src/server");
  walk("src/main");
  assert.deepEqual(offenders, []);
});
