import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { processInspector, flattenProcessText } from "../src/server/process-inspection/index.ts";
import { inspectWorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import {
  finishedTrees,
  OrphanProcessMonitor,
  type FinishedTree,
  type FinishedTreeOwner,
  type OrphanProcessDeps,
} from "../src/server/worktrees/orphan-processes.ts";
import type { WorktreeSlotRow } from "../src/server/worktrees/store.ts";

// Real processes, real `ps` and `lsof`: the monitor's guard is only as good as the
// inspection it trusts, so these tests never fake the process they are asked to kill.

const children = new Set<ChildProcess>();
after(() => {
  for (const child of children) child.kill("SIGKILL");
});

function fixture(): { root: string; tree: string; elsewhere: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-orphan-processes-")));
  const tree = join(root, "worktrees", "task-tree");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(tree, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  return { root, tree, elsewhere };
}

async function occupant(cwd: string, script = "setInterval(() => {}, 1000)"): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", script], { cwd, stdio: "ignore" });
  children.add(child);
  child.once("exit", () => children.delete(child));
  await once(child, "spawn");
  return child;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Harness {
  monitor: OrphanProcessMonitor;
  signals: Array<{ pid: number; signal: string; at: number }>;
  retried: FinishedTreeOwner[];
}

function harness(trees: FinishedTree[], root: string, deps: Partial<OrphanProcessDeps> = {}): Harness {
  const signals: Harness["signals"] = [];
  const retried: FinishedTreeOwner[] = [];
  const monitor = new OrphanProcessMonitor({
    trees: () => trees,
    retryReturn: (owner) => {
      retried.push(owner);
    },
    unpooledRoots: [join(root, "worktrees")],
    signal: (pid, signal) => {
      signals.push({ pid, signal, at: Date.now() });
      process.kill(pid, signal);
    },
    ...deps,
  });
  return { monitor, signals, retried };
}

const taskOwner: FinishedTreeOwner = { kind: "task", taskId: "task-1" };

async function reportedProcess(monitor: OrphanProcessMonitor, pid: number) {
  await monitor.scan();
  const problem = monitor.problems().find((each) => each.process?.pid === pid);
  assert.ok(problem?.process, `process ${pid} should be reported`);
  return { problem, process: problem.process };
}

test("finished trees are pending task returns, returning check leases and quarantined slots", () => {
  const slot = (id: string, path: string, state: string, activeLeaseId: string | null = null) =>
    ({ id, path, state, activeLeaseId }) as WorktreeSlotRow;
  const trees = finishedTrees({
    slots: [
      slot("slot-1", "/pool/1/repo", "leased", "lease-task-1"),
      slot("slot-2", "/pool/2/repo", "quarantined"),
      slot("slot-4", "/pool/4/repo", "available"),
    ],
    taskReturns: [{ taskId: "task-1", trees: [
      { path: "/pool/1/repo", leaseId: "lease-task-1" },
      { path: "/state/worktrees/overflow", leaseId: null },
      // Returned by another path while the obligation stayed, and now free: still ownerless.
      { path: "/pool/4/repo", leaseId: "lease-task-1-b" },
    ] }],
    returningChecks: [{ attemptId: "attempt-1", path: "/state/check-worktrees/check", leaseId: null }],
  });
  assert.deepEqual(trees, [
    { path: "/pool/1/repo", slotId: "slot-1", owner: { kind: "task", taskId: "task-1" } },
    { path: "/state/worktrees/overflow", slotId: null, owner: { kind: "task", taskId: "task-1" } },
    { path: "/pool/4/repo", slotId: "slot-4", owner: { kind: "task", taskId: "task-1" } },
    { path: "/state/check-worktrees/check", slotId: null, owner: { kind: "check", attemptId: "attempt-1" } },
    { path: "/pool/2/repo", slotId: "slot-2", owner: { kind: "slot", slotId: "slot-2" } },
  ]);
});

test("a slot leased to someone else is never a finished tree, so a live owner's processes are not offered for Kill", () => {
  const slot = (id: string, path: string, state: string, activeLeaseId: string | null) =>
    ({ id, path, state, activeLeaseId }) as WorktreeSlotRow;
  // Task T completed owing slot 1, which was then reset and leased to live task U. Check C's
  // returning lease names slot 2, now leased to a manual holder. Slot 3 was quarantined while
  // its live lease stayed in the row.
  const trees = finishedTrees({
    slots: [
      slot("slot-1", "/pool/1/repo", "leased", "lease-task-u"),
      slot("slot-2", "/pool/2/repo", "leased", "lease-manual"),
      slot("slot-3", "/pool/3/repo", "quarantined", "lease-live"),
    ],
    taskReturns: [{ taskId: "task-t", trees: [{ path: "/pool/1/repo", leaseId: "lease-task-t" }] }],
    returningChecks: [{ attemptId: "attempt-c", path: "/pool/2/repo", leaseId: "lease-check-c" }],
  });
  assert.deepEqual(trees, []);
});

test("a process inside a finished owner's tree is reported with its identity and tree", async () => {
  const { root, tree, elsewhere } = fixture();
  const slotTree = join(root, "pool", "3", "repo");
  mkdirSync(slotTree, { recursive: true });
  const inTree = await occupant(join(tree));
  const inSlot = await occupant(slotTree);
  // A finished tree outside every root it may sit in is never inspected or reported.
  const outside = await occupant(elsewhere);
  const { monitor } = harness([
    { path: tree, slotId: null, owner: taskOwner },
    { path: slotTree, slotId: "slot-3", owner: { kind: "slot", slotId: "slot-3" } },
    { path: elsewhere, slotId: null, owner: { kind: "check", attemptId: "attempt-1" } },
  ], root);

  await monitor.scan();
  const problems = monitor.problems();
  assert.deepEqual(problems.map((problem) => problem.process?.pid).sort(), [inTree.pid, inSlot.pid].sort());
  assert.equal(problems.some((problem) => problem.process?.pid === outside.pid), false);

  const reported = problems.find((problem) => problem.process?.pid === inTree.pid)!;
  assert.equal(reported.kind, "orphan-process");
  assert.equal(reported.bannered, true);
  assert.equal(reported.id, `orphan-process:${tree}:${inTree.pid}:${reported.process!.startedAt}`);
  assert.deepEqual(reported.link, { target: "unowned-tree", path: tree });
  assert.equal(reported.process!.tree, tree);
  assert.equal(reported.process!.ppid, process.pid);
  assert.match(reported.process!.command, /setInterval/);
  assert.ok(Math.abs(reported.process!.startedAt - Date.now()) < 60_000);
  assert.deepEqual(problems.find((problem) => problem.process?.pid === inSlot.pid)!.link, { target: "slot", slotId: "slot-3" });
});

test("Kill sends SIGTERM, the process exits, the pending return is retried and the report clears", async () => {
  const { root, tree } = fixture();
  const child = await occupant(tree);
  const check: FinishedTreeOwner = { kind: "check", attemptId: "attempt-1" };
  const { monitor, signals, retried } = harness([
    { path: tree, slotId: null, owner: taskOwner },
    { path: tree, slotId: null, owner: check },
  ], root);
  const { process: listed } = await reportedProcess(monitor, child.pid!);

  const result = await monitor.kill({ path: tree, pid: listed.pid, startedAt: listed.startedAt, command: listed.command });
  assert.deepEqual(result, { ok: true, signal: "SIGTERM" });
  assert.deepEqual(signals.map((each) => each.signal), ["SIGTERM"]);
  assert.equal(alive(child.pid!), false);
  assert.deepEqual(retried, [taskOwner, check]);
  assert.deepEqual(monitor.problems(), []);
});

test("Kill sends SIGKILL 5 s after a SIGTERM the process ignores", async () => {
  const { root, tree } = fixture();
  const child = await occupant(tree, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
  // Let the handler install before the signal can arrive.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const { monitor, signals, retried } = harness([{ path: tree, slotId: null, owner: taskOwner }], root);
  const { process: listed } = await reportedProcess(monitor, child.pid!);

  const result = await monitor.kill({ path: tree, pid: listed.pid, startedAt: listed.startedAt, command: listed.command });
  assert.deepEqual(result, { ok: true, signal: "SIGKILL" });
  assert.deepEqual(signals.map((each) => each.signal), ["SIGTERM", "SIGKILL"]);
  assert.ok(signals[1]!.at - signals[0]!.at >= 5_000, `SIGKILL came ${signals[1]!.at - signals[0]!.at} ms after SIGTERM`);
  assert.equal(alive(child.pid!), false);
  assert.deepEqual(retried, [taskOwner]);
});

test("Kill refuses, signalling nothing, anything Mission Control did not report exactly", async () => {
  const { root, tree, elsewhere } = fixture();
  const child = await occupant(tree);
  const stranger = await occupant(elsewhere);
  const { monitor, signals, retried } = harness([{ path: tree, slotId: null, owner: taskOwner }], root);
  const { process: listed } = await reportedProcess(monitor, child.pid!);
  const exact = { path: tree, pid: listed.pid, startedAt: listed.startedAt, command: listed.command };

  // `$HOME` with a real live process's PID, start time and command: this test runner.
  const self = processInspector().readStartAndCommandSync(process.pid)!;
  const selfStartedAt = Date.parse(self.start);
  const notReported = /not a tree with a reported orphan process/;
  // A symlink beside the reported tree that resolves somewhere else.
  const alias = join(root, "worktrees", "alias");
  symlinkSync(elsewhere, alias);
  const refusals: Array<[typeof exact, RegExp]> = [
    [{ path: homedir(), pid: process.pid, startedAt: selfStartedAt, command: self.command }, notReported],
    [{ path: homedir(), pid: listed.pid, startedAt: listed.startedAt, command: listed.command }, notReported],
    [{ ...exact, path: alias }, notReported],
    // A PID the reported problem does not list, in the reported tree.
    [{ ...exact, pid: stranger.pid! }, /is not reported in that tree/],
    [{ ...exact, pid: process.pid }, /is not reported in that tree/],
    // A changed start time or command.
    [{ ...exact, startedAt: listed.startedAt + 1_000 }, /does not match the reported start time and command/],
    [{ ...exact, command: `${listed.command} --changed` }, /does not match the reported start time and command/],
  ];

  for (const [request, reason] of refusals) {
    const result = await monitor.kill(request);
    assert.equal(result.ok, false, `refused: ${JSON.stringify(request)}`);
    assert.match((result as { error: string }).error, reason);
  }
  assert.deepEqual(signals, []);
  assert.deepEqual(retried, []);
  assert.equal(alive(child.pid!), true);
  assert.equal(alive(stranger.pid!), true);
  assert.equal(alive(process.pid), true);
});

test("Kill refuses when a fresh inspection no longer finds the same process in the tree", async () => {
  const { root, tree } = fixture();
  const child = await occupant(tree);
  let changeStart = false;
  let empty = false;
  const { monitor, signals } = harness([{ path: tree, slotId: null, owner: taskOwner }], root, {
    occupancy: async (paths) => {
      const observed = await inspectWorktreeOccupancy(paths);
      for (const [path, state] of observed) {
        if (state.status !== "known") continue;
        if (empty) observed.set(path, { status: "known", occupants: [] });
        else if (changeStart) {
          observed.set(path, {
            status: "known",
            occupants: state.occupants.map((each) => ({ ...each, startRaw: flattenProcessText(`${each.startRaw} reused`) })),
          });
        }
      }
      return observed;
    },
  });
  const { process: listed } = await reportedProcess(monitor, child.pid!);
  const exact = { path: tree, pid: listed.pid, startedAt: listed.startedAt, command: listed.command };

  changeStart = true;
  assert.match((await monitor.kill(exact) as { error: string }).error, /changed its start time or command/);
  changeStart = false;
  empty = true;
  assert.match((await monitor.kill(exact) as { error: string }).error, /no longer in that tree/);
  assert.deepEqual(signals, []);
  assert.equal(alive(child.pid!), true);
});

test("Kill rescans after itself, so a scan that inspected before the kill cannot put the process back", async () => {
  const { root, tree } = fixture();
  const child = await occupant(tree);
  // The next scan's inspection completes (seeing the process alive) and then waits until a second
  // after the SIGTERM, standing in for a maintenance pass whose `lsof` ran before the kill and is
  // still in flight when Kill finishes signalling.
  let holdNext = false;
  let release: () => void = () => {};
  const signalled = new Promise<void>((resolve) => { release = resolve; });
  let held: () => void = () => {};
  const holding = new Promise<void>((resolve) => { held = resolve; });
  const { monitor } = harness([{ path: tree, slotId: null, owner: taskOwner }], root, {
    occupancy: async (paths) => {
      const observed = await inspectWorktreeOccupancy(paths);
      if (holdNext) {
        holdNext = false;
        held();
        await signalled;
      }
      return observed;
    },
    signal: (pid, signal) => {
      process.kill(pid, signal);
      setTimeout(release, 1_000);
    },
  });
  const { process: listed } = await reportedProcess(monitor, child.pid!);

  holdNext = true;
  const stale = monitor.scan();
  // Kill's own re-inspection must not be the call that is held.
  await holding;
  const result = await monitor.kill({ path: tree, pid: listed.pid, startedAt: listed.startedAt, command: listed.command });
  await stale;
  assert.deepEqual(result, { ok: true, signal: "SIGTERM" });
  assert.equal(alive(child.pid!), false);
  assert.deepEqual(monitor.problems(), [], "the dead process is not reported once Kill answers");
});

test("a scan that cannot inspect a tree keeps the last report for it", async () => {
  const { root, tree } = fixture();
  const child = await occupant(tree);
  let unknown = false;
  const { monitor } = harness([{ path: tree, slotId: null, owner: taskOwner }], root, {
    occupancy: async (paths) => unknown
      ? new Map(paths.map((path) => [path, { status: "unknown", reason: "lsof timed out" }]))
      : await inspectWorktreeOccupancy(paths),
  });
  const { problem } = await reportedProcess(monitor, child.pid!);
  unknown = true;
  await monitor.scan();
  assert.deepEqual(monitor.problems().map((each) => each.id), [problem.id]);
});

test("the routes: Storage scans before it answers, and Kill answers 409 for a refusal and 200 for a kill", async () => {
  // The preload's disposable home; the routes open its database.
  const { buildApp } = await import("../src/server/routes.ts");
  const { Registry } = await import("../src/server/registry.ts");
  const { StorageHealthService } = await import("../src/server/storage-health.ts");
  const { databaseBackupStatusFrom } = await import("../src/shared/database-backups.ts");
  const { root, tree } = fixture();
  const child = await occupant(tree);
  const { monitor, signals } = harness([{ path: tree, slotId: null, owner: taskOwner }], root);
  const storageHealth = new StorageHealthService({
    backups: { status: () => databaseBackupStatusFrom(undefined), keptCopies: () => [] },
    publish: () => {},
    sources: [() => ({ problems: monitor.problems() })],
    readFirstSeen: () => ({}),
    writeFirstSeen: () => {},
  });
  const routes = buildApp({
    registry: new Registry(),
    reviews: {} as never,
    tasks: {} as never,
    queues: {} as never,
    storageHealth,
    orphanProcesses: monitor,
  });
  const headers = { host: "127.0.0.1:7317", "content-type": "application/json" };

  const view = await (await routes.request("/api/storage", { headers })).json() as {
    health: { problems: Array<{ kind: string; process?: { pid: number; startedAt: number; command: string } }> };
  };
  const listed = view.health.problems.find((problem) => problem.process?.pid === child.pid)?.process;
  assert.ok(listed, "GET /api/storage scanned the finished trees before answering");

  const kill = (body: unknown) => routes.request("/api/worktrees/processes/kill", {
    method: "POST", headers, body: JSON.stringify(body),
  });
  assert.equal((await kill({ path: tree, pid: listed.pid })).status, 400);
  const refused = await kill({ path: homedir(), pid: listed.pid, startedAt: listed.startedAt, command: listed.command });
  assert.equal(refused.status, 409);
  assert.deepEqual(signals, []);
  const killed = await kill({ path: tree, pid: listed.pid, startedAt: listed.startedAt, command: listed.command });
  assert.equal(killed.status, 200);
  assert.deepEqual(await killed.json(), { ok: true, signal: "SIGTERM" });
  assert.equal(alive(child.pid!), false);
});
