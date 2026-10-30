import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { correlate } from "../src/server/discovery/correlate.ts";
import { listProcessesSnapshot, type Proc } from "../src/server/discovery/processes.ts";
import { Registry } from "../src/server/registry.ts";
import { recordSdkSessionProcess, upsertSdkSession } from "../src/server/sdk/store.ts";
import { knownOwnerLabels, sessionProcesses } from "../src/server/worktrees/known-owners.ts";
import { inspectWorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";

/**
 * The start times here are `ps`'s and the session identities are the ones discovery, the
 * Registry and the SDK store really record, so the exact match `knownOwnerLabels` makes is
 * tested against what production feeds it rather than against two numbers a fixture wrote.
 */

const IDLE = "setInterval(() => {}, 1000)";
/** Starts a child, which inherits its cwd. */
const PARENT = `
  require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(IDLE)}], { stdio: "ignore" });
  ${IDLE};
`;

function slot(t: TestContext): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "mission-session-owners-")));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}

/** A real parent and child inside `cwd`, and a real process that only shares that cwd. */
async function processes(t: TestContext, cwd: string): Promise<{ parent: number; child: number; bystander: number }> {
  const parent = spawn(process.execPath, ["-e", PARENT], { cwd, stdio: "ignore" });
  const bystander = spawn(process.execPath, ["-e", IDLE], { cwd, stdio: "ignore" });
  t.after(async () => {
    await exited(parent);
    await exited(bystander);
  });
  await Promise.all([once(parent, "spawn"), once(bystander, "spawn")]);
  const child = await childOf(parent.pid!);
  // The child first, so its parent is still there to reap it.
  t.after(() => process.kill(child, "SIGKILL"));
  return { parent: parent.pid!, child, bystander: bystander.pid! };
}

/** The process table is the only record of it: a test worker's own stdout framing reaches a child's. */
async function childOf(parent: number): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const child = (await listProcessesSnapshot()).processes.find((one) => one.ppid === parent);
    if (child) return child.pid;
    await delay(50);
  }
  throw new Error(`process ${parent} never started its child`);
}

async function listed(pid: number): Promise<Proc> {
  const row = (await listProcessesSnapshot()).processes.find((one) => one.pid === pid);
  assert.ok(row && row.startMs > 0, `ps should list ${pid} with a start time`);
  return row;
}

async function names(registry: Registry, path: string): Promise<Map<number, string | null>> {
  const state = (await inspectWorktreeOccupancy([path], {
    knownOwner: knownOwnerLabels(() => sessionProcesses(registry.liveSessions())),
  })).get(path)!;
  assert.equal(state.status, "known");
  return new Map(state.status === "known" ? state.occupants.map((one) => [one.pid, one.knownOwner]) : []);
}

test("a terminal session, as discovery and the Registry record it, names its real process and child", async (t) => {
  const path = slot(t);
  const { parent, child, bystander } = await processes(t, path);
  const row = await listed(parent);

  // All a spawned test process cannot have is a tty. It is also this worker's own child, which
  // discovery reads as the daemon's, so it is shown to discovery alone, as a process of nobody's.
  const registry = new Registry();
  registry.applyDiscovery(correlate({
    procs: [{ ...row, ppid: 1, tty: "pts/mission-test", agent: "claude", agentNative: true }],
    terminals: [],
  }, new Map([[parent, path]])));
  const [session] = registry.liveSessions();
  assert.equal(session?.runtime, "terminal");
  assert.equal(session.pid, parent);
  assert.equal(session.startedAt, row.startMs, "discovery's start is the one ps reports for this PID");

  const named = await names(registry, path);
  assert.equal(named.get(parent), `Session ${session.name}`);
  assert.equal(named.get(child), `Session ${session.name}`);
  assert.equal(named.get(bystander), null, "sharing the cwd names nothing");
});

test("an SDK session names its real child from the lifetime the store recorded, not its registration time", async (t) => {
  const path = slot(t);
  const { parent, child, bystander } = await processes(t, path);
  const row = await listed(parent);

  const id = `sdk:${randomUUID()}`;
  upsertSdkSession({
    id, agent: "claude", cwd: path, status: "running", agentSessionId: null, taskId: null,
    model: null, effort: null, permissionMode: null, turnInProgress: false,
  });
  const registry = new Registry();
  const session = registry.registerSdkSession({
    id, agent: "claude", name: "driven session", cwd: path, pid: parent, now: row.startMs + 1,
  });
  assert.notEqual(session.startedAt, row.startMs, "an SDK session's startedAt is when it registered");
  assert.equal((await names(registry, path)).get(parent), null, "no recorded lifetime, no name");

  recordSdkSessionProcess(id, { pid: parent, startMs: row.startMs });
  const named = await names(registry, path);
  assert.equal(named.get(parent), "Session driven session");
  assert.equal(named.get(child), "Session driven session");
  assert.equal(named.get(bystander), null, "sharing the cwd names nothing");
});
