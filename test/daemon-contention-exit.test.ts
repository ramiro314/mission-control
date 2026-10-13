import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import test from "node:test";

import type { superviseUtilityProcess } from "../src/main/utility-supervisor.ts";
import type { startDaemon } from "../src/main/daemon.ts";
import { DAEMON_PROTOCOL_CAPABILITIES } from "../src/shared/daemon-protocol.ts";

const require = createRequire(import.meta.url);

/** The real supervisor over a fake `utilityProcess` whose children exit when told to. */
async function loadSupervisor(root: string) {
  const outfile = join(root, "supervisor.cjs");
  await build({
    stdin: {
      contents: 'export {superviseUtilityProcess} from "./src/main/utility-supervisor.ts"; export {children} from "electron";',
      resolveDir: resolve("."),
    },
    outfile, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    plugins: [{ name: "fake-electron", setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        import { EventEmitter } from "node:events";
        export const children = [];
        export const utilityProcess = { fork() {
          const child = new EventEmitter();
          child.kill = () => true;
          children.push(child);
          return child;
        } };` }));
    } }],
  });
  return require(outfile) as {
    superviseUtilityProcess: typeof superviseUtilityProcess;
    children: { emit(event: "exit", code: number): void }[];
  };
}

function scratch(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mission-contention-exit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("the supervisor stops restarting when afterExit names a reason, and logs it", async (t) => {
  const root = scratch(t);
  const { superviseUtilityProcess, children } = await loadSupervisor(root);
  const logPath = join(root, "daemon.log");
  const codes: number[] = [];
  const controller = superviseUtilityProcess({
    entry: "/fixture/server.mjs", serviceName: "mission-control-daemon", logPath, env: {},
    afterExit: async (code) => {
      codes.push(code);
      return code === 75 ? "another daemon owns this state; adopting it" : null;
    },
  });
  t.after(() => controller.stop());
  assert.equal(children.length, 1);
  children[0]!.emit("exit", 1);
  await delay(700);
  assert.equal(children.length, 2, "an ordinary crash restarts");
  children[1]!.emit("exit", 75);
  await delay(1_200);
  assert.equal(children.length, 2, "a released exit is never restarted");
  assert.deepEqual(codes, [1, 75]);
  assert.match(readFileSync(logPath, "utf8"), /exited with code 75; another daemon owns this state; adopting it/);
});

test("without afterExit the supervisor restarts on 75 as on any exit", async (t) => {
  const root = scratch(t);
  const { superviseUtilityProcess, children } = await loadSupervisor(root);
  const controller = superviseUtilityProcess({
    entry: "/fixture/server.mjs", serviceName: "mission-control-daemon", logPath: join(root, "daemon.log"), env: {},
  });
  t.after(() => controller.stop());
  children[0]!.emit("exit", 75);
  await delay(700);
  assert.equal(children.length, 2);
});

test("a rejecting afterExit restarts as usual", async (t) => {
  const root = scratch(t);
  const { superviseUtilityProcess, children } = await loadSupervisor(root);
  const logPath = join(root, "daemon.log");
  const controller = superviseUtilityProcess({
    entry: "/fixture/server.mjs", serviceName: "mission-control-daemon", logPath, env: {},
    afterExit: async () => { throw new Error("re-probe failed"); },
  });
  t.after(() => controller.stop());
  children[0]!.emit("exit", 75);
  await delay(700);
  assert.equal(children.length, 2, "a failed decision never leaves the daemon dead");
  assert.match(readFileSync(logPath, "utf8"), /exited with code 75; restarting/);
});

test("stop() while afterExit is pending ends supervision without a respawn", async (t) => {
  const root = scratch(t);
  const { superviseUtilityProcess, children } = await loadSupervisor(root);
  const logPath = join(root, "daemon.log");
  let answer!: (reason: string | null) => void;
  const controller = superviseUtilityProcess({
    entry: "/fixture/server.mjs", serviceName: "mission-control-daemon", logPath, env: {},
    afterExit: () => new Promise((resolve) => { answer = resolve; }),
  });
  children[0]!.emit("exit", 75);
  await delay(10);
  controller.stop();
  // A late answer, release or not, cannot outrank the stop the owner already asked for.
  answer("another daemon owns this state; adopting it");
  await delay(700);
  assert.equal(children.length, 1);
  const log = readFileSync(logPath, "utf8");
  assert.match(log, /mission-control-daemon stopped/);
  assert.doesNotMatch(log, /adopting it/);
});

type Health = "absent" | "compatible" | "incompatible";

/**
 * The real startDaemon over a stub supervisor, a health endpoint whose answer the test sets,
 * a fake `systemctl` whose `is-active` state the test sets, and a fake clock: daemon.ts's
 * `node:timers/promises` sleep advances `Date.now` instead of waiting, so the 30 s wait for a
 * unit runs at once.
 */
async function daemonFixture(t: test.TestContext) {
  const root = scratch(t);
  const state = { health: "absent" as Health };
  const server = createServer((_request, response) => {
    if (state.health === "absent") {
      response.destroy();
      return;
    }
    const capabilities = state.health === "compatible" ? Object.values(DAEMON_PROTOCOL_CAPABILITIES) : [];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ service: "mission-control", capabilities }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const outfile = join(root, "daemon.cjs");
  await build({
    stdin: { contents: 'export {startDaemon} from "./src/main/daemon.ts"; export {calls} from "./src/main/utility-supervisor.ts";', resolveDir: resolve(".") },
    outfile, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    plugins: [{ name: "daemon-boundaries", setup(b) {
      b.onResolve({ filter: /utility-supervisor\.ts$/ }, () => ({ path: "supervisor", namespace: "fixture" }));
      b.onResolve({ filter: /harness-runtime\.mjs$/ }, (args) => args.importer.endsWith("/daemon.ts") ? { path: "runtime", namespace: "fixture" } : undefined);
      b.onResolve({ filter: /^node:timers\/promises$/ }, (args) => args.importer.endsWith("/daemon.ts") ? { path: "timers", namespace: "fixture" } : undefined);
      b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: args.path === "runtime"
        ? `export const PORT=${address.port}; export const BASE_URL="http://127.0.0.1:${address.port}";`
        : args.path === "timers"
          ? "export const setTimeout = async (ms) => { globalThis.__missionFakeSleep(ms); };"
          : "export const calls=[]; export function superviseUtilityProcess(opts) {calls.push(opts);return {stop(){}};}" }));
    } }],
  });
  const unitState = join(root, "unit-state");
  writeFileSync(unitState, "inactive\n");
  const systemctl = join(root, "systemctl");
  writeFileSync(systemctl, `#!/bin/sh\ncat "${unitState}"\nexit 3\n`, { mode: 0o755 });
  process.env.MISSION_SYSTEMCTL_BIN = systemctl;
  t.after(() => { delete process.env.MISSION_SYSTEMCTL_BIN; });
  const realNow = Date.now;
  let now = realNow();
  let slept = 0;
  Date.now = () => now;
  Reflect.set(globalThis, "__missionFakeSleep", (ms: number) => { now += ms; slept += ms; });
  t.after(() => { Date.now = realNow; Reflect.deleteProperty(globalThis, "__missionFakeSleep"); });
  const loaded = require(outfile) as {
    startDaemon: typeof startDaemon;
    calls: { afterExit?: (code: number) => Promise<string | null> }[];
  };
  let unresponsive = 0;
  return {
    state,
    unit: (value: string) => writeFileSync(unitState, `${value}\n`),
    slept: () => slept,
    unresponsive: () => unresponsive,
    calls: loaded.calls,
    start: () => loaded.startDaemon({
      serverEntry: "/fixture/server.mjs", webDir: "/fixture/web", logPath: join(root, "daemon.log"),
      onUnitUnresponsive: () => { unresponsive++; },
    }),
  };
}

test("startDaemon hands its supervisor the contention re-probe only on Linux, and it adopts the owner", async (t) => {
  const f = await daemonFixture(t);
  const started = await f.start();
  assert.equal(started.adopted, false);
  const afterExit = f.calls[0]?.afterExit;
  if (process.platform !== "linux") {
    assert.equal(afterExit, undefined, "macOS restarts on every exit, 75 included");
    return;
  }
  assert.ok(afterExit);
  assert.equal(await afterExit(1), null, "a crash restarts");
  assert.equal(await afterExit(75), null, "the owner is gone and no unit runs: restart");
  f.state.health = "compatible";
  assert.equal(await afterExit(1), null, "only contention re-probes");
  assert.equal(await afterExit(75), "another daemon owns this state; adopting it");
  f.state.health = "incompatible";
  assert.equal(await afterExit(75), "another daemon from an older build owns this state; not restarting");
  assert.equal(f.unresponsive(), 0);
});

test("a running unit that never answers is adopted after 30 s and reported to the startup page", async (t) => {
  if (process.platform !== "linux") return t.skip("only Linux asks systemd");
  const f = await daemonFixture(t);
  f.unit("active");
  const started = await f.start();
  assert.equal(started.adopted, true, "the shell never races the unit for the state lock");
  assert.equal(f.calls.length, 0, "no supervisor is started");
  assert.equal(f.unresponsive(), 1);
  assert.equal(f.slept(), 30_000);
});

test("a 75 re-probe that finds a silent running unit reports it to the startup page", async (t) => {
  if (process.platform !== "linux") return t.skip("only Linux asks systemd");
  const f = await daemonFixture(t);
  await f.start();
  const afterExit = f.calls[0]?.afterExit;
  assert.ok(afterExit);
  f.unit("activating");
  assert.equal(await afterExit(75), "another daemon owns this state; adopting it");
  assert.equal(f.unresponsive(), 1);
});
