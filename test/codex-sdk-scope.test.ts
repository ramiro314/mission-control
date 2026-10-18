import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionScope, SessionScopeOutcome } from "../src/server/platform/session-scope.ts";

// The Codex seam of the session scope: `spawnAppServer` wraps a session's server, and only a
// session's, and reads its scope's verdict when it exits. Every scope here is a fake; the real
// systemd path is `session-scope-linux.test.ts`.

const root = mkdtempSync(join(tmpdir(), "mission-codex-scope-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

// Stands in for `codex`: records its argv, then serves until its stdin closes, which is
// `spawnAppServer`'s graceful stop.
const codex = join(root, "fake-codex.sh");
writeFileSync(codex, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, "codex-argv")}"\ncat > /dev/null\nexit 0\n`);
chmodSync(codex, 0o755);
// Stands in for systemd-run: records what it was handed, then execs it in place.
const wrapper = join(root, "fake-scope.sh");
writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, "wrapped-argv")}"\nexec "$@"\n`);
chmodSync(wrapper, 0o755);
// `connect` resolves `codex` through the locator, so it is pointed at the fake before any import.
process.env.MISSION_CODEX_BIN = codex;

const { createCodexSdkDeps, spawnAppServer } = await import("../src/server/harness/codex/sdk-deps.ts");

const UNIT = "mission-control-test-codex.scope";

/** A scope that wraps through `wrapper` under `unit`, answers `verdict`, and records each call. */
function fakeScope(unit: string | null, verdict: SessionScopeOutcome | null = { oomKilled: false, peakBytes: null }) {
  let ready = false;
  const calls = {
    ready: 0,
    wraps: [] as { bin: string; args: readonly string[]; label: string; readyFirst: boolean }[],
    outcomes: [] as string[],
  };
  const scope: SessionScope = {
    ready: () =>
      new Promise((resolve) => {
        calls.ready += 1;
        setTimeout(() => {
          ready = true;
          resolve();
        }, 50);
      }),
    wrap(bin, args, _env, label) {
      calls.wraps.push({ bin, args, label, readyFirst: ready });
      return unit ? { bin: wrapper, args: [bin, ...args], unit } : { bin, args: [...args], unit: null };
    },
    async outcome(read) {
      calls.outcomes.push(read);
      return verdict;
    },
  };
  return { scope, calls };
}

function reset(): void {
  rmSync(join(root, "codex-argv"), { force: true });
  rmSync(join(root, "wrapped-argv"), { force: true });
}

const lines = (file: string) => readFileSync(join(root, file), "utf8").trimEnd().split("\n");

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitForArgv(): Promise<void> {
  await until(() => existsSync(join(root, "codex-argv")));
}

test("a session's app-server spawns the scope-wrapped argv and reads its outcome on exit", { timeout: 15_000 }, async (t) => {
  reset();
  const { scope, calls } = fakeScope(UNIT);
  const transport = spawnAppServer(codex, ["-c", "a=1"], root, { PATH: process.env.PATH }, {
    label: "sdk:codex-session",
    scope,
  });
  t.after(() => transport.close());
  await waitForArgv();
  assert.equal(calls.wraps.length, 1);
  assert.equal(calls.wraps[0]!.label, "sdk:codex-session");
  assert.equal(calls.wraps[0]!.bin, codex);
  assert.deepEqual(calls.wraps[0]!.args, ["app-server", "-c", "a=1"]);
  assert.deepEqual(lines("wrapped-argv"), [codex, "app-server", "-c", "a=1"], "it spawned exactly the wrapped argv");
  assert.deepEqual(lines("codex-argv"), ["app-server", "-c", "a=1"]);
  assert.ok(transport.pid, "the transport still carries the server's pid");
  assert.deepEqual(calls.outcomes, [], "nothing is read while the server runs");
  await transport.close();
  await until(() => calls.outcomes.length > 0);
  assert.deepEqual(calls.outcomes, [UNIT], "the server's exit read its scope's outcome");
});

test("an app-server spawned without a session label is never wrapped", { timeout: 15_000 }, async (t) => {
  reset();
  const transport = spawnAppServer(codex, [], root, { PATH: process.env.PATH });
  t.after(() => transport.close());
  await waitForArgv();
  assert.deepEqual(lines("codex-argv"), ["app-server"]);
  assert.equal(existsSync(join(root, "wrapped-argv")), false);
  await transport.close();
});

test("a session server that got no scope never reads an outcome on exit", { timeout: 15_000 }, async (t) => {
  reset();
  const { scope, calls } = fakeScope(null);
  const transport = spawnAppServer(codex, [], root, { PATH: process.env.PATH }, { label: "sdk:no-scope", scope });
  t.after(() => transport.close());
  await waitForArgv();
  assert.equal(calls.wraps.length, 1, "it still asked the scope, which made no unit");
  await transport.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(calls.outcomes, []);
});

/** What the seam logged through `console.warn` across one wrapped server's life. */
async function scopeLinesAcrossOneServer(
  t: import("node:test").TestContext,
  verdict: SessionScopeOutcome | null,
): Promise<{ lines: string[]; outcomes: string[] }> {
  reset();
  const warn = t.mock.method(console, "warn", () => {});
  const { scope, calls } = fakeScope(UNIT, verdict);
  const transport = spawnAppServer(codex, [], root, { PATH: process.env.PATH }, { label: "sdk:oom-line", scope });
  t.after(() => transport.close());
  await waitForArgv();
  await transport.close();
  await until(() => calls.outcomes.length > 0);
  // A few more turns for the `.then` that would log.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const logged = warn.mock.calls.map((call) => String(call.arguments[0]));
  warn.mock.restore();
  return { lines: logged.filter((line) => line.startsWith("[session-scope]")), outcomes: calls.outcomes };
}

test("an OOM-stopped app-server's exit logs exactly one line naming the session, the unit and the peak", { timeout: 15_000 }, async (t) => {
  const { lines: logged, outcomes } = await scopeLinesAcrossOneServer(t, { oomKilled: true, peakBytes: 1610612736 });
  assert.deepEqual(outcomes, [UNIT]);
  assert.deepEqual(logged, [
    `[session-scope] session sdk:oom-line ran out of memory: systemd stopped ${UNIT} (peak 1.5 GB)`,
  ]);
});

test("an app-server whose scope was not OOM-stopped, or whose verdict is unknown, logs nothing", { timeout: 15_000 }, async (t) => {
  for (const verdict of [{ oomKilled: false, peakBytes: 100 }, null]) {
    const { lines: logged, outcomes } = await scopeLinesAcrossOneServer(t, verdict);
    assert.deepEqual(outcomes, [UNIT], "the exit still read the scope's outcome");
    assert.deepEqual(logged, [], JSON.stringify(verdict));
  }
});

test("connect awaits the session scope's ready() before it spawns, and wraps under the session's label", { timeout: 15_000 }, async (t) => {
  reset();
  const { scope, calls } = fakeScope(UNIT);
  const transport = await createCodexSdkDeps(scope).connect(["-c", "b=2"], root, root, "sdk:connected");
  t.after(() => transport.close());
  await waitForArgv();
  assert.equal(calls.ready, 1);
  assert.equal(calls.wraps.length, 1);
  assert.ok(calls.wraps[0]!.readyFirst, "ready() had settled before wrap ran");
  assert.equal(calls.wraps[0]!.label, "sdk:connected");
  assert.deepEqual(lines("codex-argv"), ["app-server", "-c", "b=2"]);
  assert.deepEqual(lines("wrapped-argv").slice(1), ["app-server", "-c", "b=2"]);
  await transport.close();
  await until(() => calls.outcomes.length > 0);
  assert.deepEqual(calls.outcomes, [UNIT]);
});

test("a session server's exitCause carries an OOM stop's peak, and is null otherwise", { timeout: 15_000 }, async (t) => {
  t.mock.method(console, "warn", () => {});
  const cases = [
    [UNIT, { oomKilled: true, peakBytes: 1610612736 }, { kind: "out_of_memory", peakBytes: 1610612736 }],
    [UNIT, { oomKilled: true, peakBytes: null }, { kind: "out_of_memory", peakBytes: null }],
    [UNIT, { oomKilled: false, peakBytes: 100 }, null],
    [UNIT, null, null],
    [null, { oomKilled: true, peakBytes: 1 }, null],
  ] as const;
  for (const [unit, verdict, cause] of cases) {
    reset();
    const { scope } = fakeScope(unit, verdict);
    const transport = spawnAppServer(codex, [], root, { PATH: process.env.PATH }, { label: "sdk:cause", scope });
    t.after(() => transport.close());
    await waitForArgv();
    await transport.close();
    assert.deepEqual(await transport.exitCause!(), cause, JSON.stringify({ unit, verdict }));
  }
});

test("an app-server spawned without a session has no exitCause to wait on", { timeout: 15_000 }, async (t) => {
  reset();
  const transport = spawnAppServer(codex, [], root, { PATH: process.env.PATH });
  t.after(() => transport.close());
  await waitForArgv();
  assert.equal(transport.exitCause, undefined);
  await transport.close();
});
