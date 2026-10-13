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

test("startDaemon hands its supervisor the contention re-probe only on Linux, and it adopts the owner", async (t) => {
  const root = scratch(t);
  let healthy = false;
  const server = createServer((_request, response) => {
    if (!healthy) {
      response.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ service: "mission-control", capabilities: Object.values(DAEMON_PROTOCOL_CAPABILITIES) }));
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
      b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: args.path === "runtime"
        ? `export const PORT=${address.port}; export const BASE_URL="http://127.0.0.1:${address.port}";`
        : "export const calls=[]; export function superviseUtilityProcess(opts) {calls.push(opts);return {stop(){}};}" }));
    } }],
  });
  // A unit that is not running, so a developer's own unit cannot turn this into a 30 s wait.
  const systemctl = join(root, "systemctl");
  writeFileSync(systemctl, "#!/bin/sh\necho inactive\nexit 3\n", { mode: 0o755 });
  process.env.MISSION_SYSTEMCTL_BIN = systemctl;
  t.after(() => { delete process.env.MISSION_SYSTEMCTL_BIN; });
  const loaded = require(outfile) as {
    startDaemon: typeof startDaemon;
    calls: { afterExit?: (code: number) => Promise<string | null> }[];
  };

  const started = await loaded.startDaemon({ serverEntry: "/fixture/server.mjs", webDir: "/fixture/web", logPath: join(root, "daemon.log") });
  assert.equal(started.adopted, false);
  const afterExit = loaded.calls[0]?.afterExit;
  if (process.platform !== "linux") {
    assert.equal(afterExit, undefined, "macOS restarts on every exit, 75 included");
    return;
  }
  assert.ok(afterExit);
  assert.equal(await afterExit(1), null, "a crash restarts");
  assert.equal(await afterExit(75), null, "the owner is gone and no unit runs: restart");
  healthy = true;
  assert.equal(await afterExit(1), null, "only contention re-probes");
  assert.equal(await afterExit(75), "another daemon owns this state; adopting it");
});
