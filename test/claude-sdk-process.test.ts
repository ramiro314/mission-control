import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSdkSpec } from "../src/server/harness/claude/sdk.ts";
import { createClaudeSdkQuery, defaultClaudeSdkDeps } from "../src/server/harness/claude/sdk-deps.ts";
import type { SessionScope } from "../src/server/platform/session-scope.ts";

test("the real Claude SDK transport exposes its child lifetime and still drains on stop", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mission-sdk-process-"));
  let childPid: number | null = null;
  t.after(() => {
    if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch { /* Already reaped. */ } }
    rmSync(root, { recursive: true, force: true });
  });
  const executable = join(root, "fake-claude.mjs");
  writeFileSync(executable, `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync("pid", String(process.pid));
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") emit({ type: "control_response", response: {
    subtype: "success", request_id: frame.request_id, response: {}
  } });
  if (frame.type === "user") {
    emit({ type: "system", subtype: "init", session_id: "process-proof", model: "fake" });
    emit({ type: "result", subtype: "success", session_id: "process-proof", is_error: false });
  }
});
lines.on("close", () => { writeFileSync("drained", "stdin closed"); process.exit(0); });
`);
  const handle = await claudeSdkSpec({ ...defaultClaudeSdkDeps, executable: async () => executable,
    env: () => ({ PATH: process.env.PATH }) }).launch({ sessionId: "sdk:process-proof", cwd: root, stateHome: root,
    prompt: "fixture only", model: null, effort: null, permissionMode: null, mcp: null,
    extraDirs: [], standingInstructions: "", standingInstructionsPrompt: "", resume: null });
  childPid = handle.recoveryProcessId ?? null;
  for await (const event of handle.events) {
    if (event.kind === "bound") break;
    assert.notEqual(event.kind, "exited");
  }
  assert.equal(childPid, Number(readFileSync(join(root, "pid"), "utf8")));
  assert.ok(childPid);
  assert.equal(handle.recoveryProcessId, childPid);
  assert.notEqual(childPid, process.pid, "the daemon is not proof of a subprocess lifetime");
  process.kill(childPid, 0);
  await handle.stop();
  for await (const event of handle.events) if (event.kind === "exited") break;
  assert.equal(readFileSync(join(root, "drained"), "utf8"), "stdin closed");
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});

test("the Claude spawn hook runs the scope-wrapped argv, awaits ready first, and reads outcome on exit", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mission-sdk-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "fake-claude.mjs");
  writeFileSync(executable, `
import { createInterface } from "node:readline";
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") emit({ type: "control_response", response: {
    subtype: "success", request_id: frame.request_id, response: {}
  } });
  if (frame.type === "user") {
    emit({ type: "system", subtype: "init", session_id: "scope-proof", model: "fake" });
    emit({ type: "result", subtype: "success", session_id: "scope-proof", is_error: false });
  }
});
lines.on("close", () => process.exit(0));
`);
  // Stands in for systemd-run: records what it was handed, then execs it in place.
  const wrapper = join(root, "fake-scope.sh");
  writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, "wrapped-argv")}"\nexec "$@"\n`);
  chmodSync(wrapper, 0o755);
  let ready = false;
  const wraps: { bin: string; args: readonly string[]; label: string; readyFirst: boolean }[] = [];
  const outcomes: string[] = [];
  const scope: SessionScope = {
    ready: () => new Promise((resolve) => setTimeout(() => { ready = true; resolve(); }, 50)),
    wrap(bin, args, _env, label) {
      wraps.push({ bin, args, label, readyFirst: ready });
      return { bin: wrapper, args: [bin, ...args], unit: "mission-control-test-scope.scope" };
    },
    async outcome(unit) {
      outcomes.push(unit);
      return { oomKilled: false, peakBytes: null };
    },
  };
  const handle = await claudeSdkSpec({ ...defaultClaudeSdkDeps, query: createClaudeSdkQuery(scope),
    executable: async () => executable, env: () => ({ PATH: process.env.PATH }) }).launch({
    sessionId: "sdk:scope-session", cwd: root, stateHome: root, prompt: "fixture only", model: null,
    effort: null, permissionMode: null, mcp: null, extraDirs: [], standingInstructions: "",
    standingInstructionsPrompt: "", resume: null });
  for await (const event of handle.events) if (event.kind === "bound") break;
  assert.equal(wraps.length, 1);
  assert.equal(wraps[0]!.label, "sdk:scope-session");
  assert.ok(wraps[0]!.readyFirst, "startQuery awaited ready() before the vendor spawned");
  const recorded = readFileSync(join(root, "wrapped-argv"), "utf8").trimEnd().split("\n");
  assert.deepEqual(recorded, [wraps[0]!.bin, ...wraps[0]!.args], "the hook spawned exactly the wrapped argv");
  assert.ok(recorded.includes(executable));
  assert.ok(handle.recoveryProcessId, "the vendor got the wrapped child");
  await handle.stop();
  for await (const event of handle.events) if (event.kind === "exited") break;
  for (let i = 0; i < 50 && outcomes.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(outcomes, ["mission-control-test-scope.scope"], "the child's exit read its scope's outcome");
});

test("a catalog probe installs no spawn hook, so it is never wrapped", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mission-sdk-probe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "fake-claude.mjs");
  writeFileSync(executable, `
import { createInterface } from "node:readline";
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") emit({ type: "control_response", response: {
    subtype: "success", request_id: frame.request_id, response: { models: [] }
  } });
}).on("close", () => process.exit(0));
`);
  const used: string[] = [];
  const scope: SessionScope = {
    ready: async () => { used.push("ready"); },
    wrap: (bin, args) => { used.push("wrap"); return { bin, args: [...args], unit: null }; },
    outcome: async () => { used.push("outcome"); return null; },
  };
  const abortController = new AbortController();
  const query = createClaudeSdkQuery(scope);
  const started = await query({
    prompt: (async function* () {})(),
    options: { cwd: root, pathToClaudeCodeExecutable: executable, env: { PATH: process.env.PATH },
      settingSources: [], tools: [], abortController },
  });
  await (started as unknown as { supportedModels(): Promise<unknown> }).supportedModels().catch(() => {});
  abortController.abort();
  assert.deepEqual(used, []);
});

/**
 * Run one fixture session through `scope` to its exit, and return what the daemon logged
 * through `console.warn` meanwhile. Waits for the outcome the seam reads, or, when the scope
 * made no unit, long enough after the exit that one would have been read.
 */
async function warnsAcrossOneSession(
  t: import("node:test").TestContext,
  scope: SessionScope,
  outcomeRead: () => boolean,
): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "mission-sdk-oom-line-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "fake-claude.mjs");
  writeFileSync(executable, `
import { createInterface } from "node:readline";
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") emit({ type: "control_response", response: {
    subtype: "success", request_id: frame.request_id, response: {}
  } });
  if (frame.type === "user") {
    emit({ type: "system", subtype: "init", session_id: "oom-line", model: "fake" });
    emit({ type: "result", subtype: "success", session_id: "oom-line", is_error: false });
  }
});
lines.on("close", () => process.exit(0));
`);
  const warn = t.mock.method(console, "warn", () => {});
  const handle = await claudeSdkSpec({ ...defaultClaudeSdkDeps, query: createClaudeSdkQuery(scope),
    executable: async () => executable, env: () => ({ PATH: process.env.PATH }) }).launch({
    sessionId: "sdk:oom-line", cwd: root, stateHome: root, prompt: "fixture only", model: null,
    effort: null, permissionMode: null, mcp: null, extraDirs: [], standingInstructions: "",
    standingInstructionsPrompt: "", resume: null });
  for await (const event of handle.events) if (event.kind === "bound") break;
  await handle.stop();
  for await (const event of handle.events) if (event.kind === "exited") break;
  for (let i = 0; i < 50 && !outcomeRead(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  // A few more turns for the `.then` that would log, or for a stray read on a unit-less exit.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const lines = warn.mock.calls.map((call) => String(call.arguments[0]));
  warn.mock.restore();
  return lines.filter((line) => line.startsWith("[session-scope]"));
}

/** A scope that spawns the command as given, under `unit`, and answers `verdict`. */
function verdictScope(unit: string | null, verdict: { oomKilled: boolean; peakBytes: number | null } | null) {
  const outcomes: string[] = [];
  const scope: SessionScope = {
    ready: async () => {},
    wrap: (bin, args) => ({ bin, args: [...args], unit }),
    async outcome(read) {
      outcomes.push(read);
      return verdict;
    },
  };
  return { scope, outcomes };
}

test("an OOM-stopped session's exit logs exactly one line naming the session, the unit and the peak", { timeout: 15_000 }, async (t) => {
  const { scope, outcomes } = verdictScope("mission-control-test-oom.scope", { oomKilled: true, peakBytes: 1610612736 });
  const lines = await warnsAcrossOneSession(t, scope, () => outcomes.length > 0);
  assert.deepEqual(outcomes, ["mission-control-test-oom.scope"]);
  assert.deepEqual(lines, [
    "[session-scope] session sdk:oom-line ran out of memory: systemd stopped mission-control-test-oom.scope (peak 1.5 GB)",
  ]);
});

test("a session whose scope was not OOM-stopped, or whose verdict is unknown, logs nothing", { timeout: 15_000 }, async (t) => {
  for (const verdict of [{ oomKilled: false, peakBytes: 100 }, null]) {
    const { scope, outcomes } = verdictScope("mission-control-test-clean.scope", verdict);
    const lines = await warnsAcrossOneSession(t, scope, () => outcomes.length > 0);
    assert.deepEqual(outcomes, ["mission-control-test-clean.scope"], "the exit still read the scope's outcome");
    assert.deepEqual(lines, [], JSON.stringify(verdict));
  }
});

test("a session that got no scope never reads an outcome on exit", { timeout: 15_000 }, async (t) => {
  const { scope, outcomes } = verdictScope(null, { oomKilled: true, peakBytes: 1 });
  const lines = await warnsAcrossOneSession(t, scope, () => outcomes.length > 0);
  assert.deepEqual(outcomes, []);
  assert.deepEqual(lines, []);
});

/**
 * Launch one fixture session through `scope`, SIGKILL its CLI the way the kernel's OOM killer
 * would, and return the driver's `exited` event.
 */
async function exitAfterKill(t: import("node:test").TestContext, scope: SessionScope) {
  const root = mkdtempSync(join(tmpdir(), "mission-sdk-oom-cause-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "fake-claude.mjs");
  writeFileSync(executable, `
import { createInterface } from "node:readline";
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") emit({ type: "control_response", response: {
    subtype: "success", request_id: frame.request_id, response: {}
  } });
  if (frame.type === "user") emit({ type: "system", subtype: "init", session_id: "oom-cause", model: "fake" });
});
`);
  t.mock.method(console, "warn", () => {});
  const handle = await claudeSdkSpec({ ...defaultClaudeSdkDeps, query: createClaudeSdkQuery(scope),
    executable: async () => executable, env: () => ({ PATH: process.env.PATH }) }).launch({
    sessionId: "sdk:oom-cause", cwd: root, stateHome: root, prompt: "fixture only", model: null,
    effort: null, permissionMode: null, mcp: null, extraDirs: [], standingInstructions: "",
    standingInstructionsPrompt: "", resume: null });
  for await (const event of handle.events) if (event.kind === "bound") break;
  process.kill(handle.recoveryProcessId!, "SIGKILL");
  for await (const event of handle.events) if (event.kind === "exited") return event;
  throw new Error("the driver ended without an exited event");
}

test("a session whose scope was stopped for an OOM kill reports the cause on exited", { timeout: 15_000 }, async (t) => {
  const { scope, outcomes } = verdictScope("mission-control-test-cause.scope", { oomKilled: true, peakBytes: 1610612736 });
  const exited = await exitAfterKill(t, scope);
  assert.deepEqual(outcomes, ["mission-control-test-cause.scope"], "the driver waited for the verdict");
  assert.deepEqual(exited.cause, { kind: "out_of_memory", peakBytes: 1610612736 });
});

test("a killed session whose scope was not OOM-stopped, or that got no scope, reports no cause", { timeout: 15_000 }, async (t) => {
  for (const [unit, verdict] of [
    ["mission-control-test-clean.scope", { oomKilled: false, peakBytes: 100 }],
    ["mission-control-test-unknown.scope", null],
    [null, { oomKilled: true, peakBytes: 1 }],
  ] as const) {
    const { scope } = verdictScope(unit, verdict);
    const exited = await exitAfterKill(t, scope);
    assert.equal("cause" in exited, false, JSON.stringify({ unit, verdict }));
  }
});
