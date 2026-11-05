import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { processInspector, flattenProcessText } from "../src/server/process-inspection/index.ts";
import { inspectWorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import {
  finishedTrees,
  OrphanProcessMonitor,
  type FinishedTree,
  type FinishedTreeOwner,
  type OrphanKillRecord,
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

/** Fixture rows in the shape `finishedTrees` reads. `test/worktree-warm.test.ts` passes the real manager. */
function poolOf(rows: readonly WorktreeSlotRow[], claimRunning: (slotId: string) => boolean = () => false) {
  return { store: { slots: () => rows }, claims: { has: claimRunning } };
}

async function reportedProcess(monitor: OrphanProcessMonitor, pid: number) {
  await monitor.scan();
  const problem = monitor.problems().find((each) => each.process?.pid === pid);
  assert.ok(problem?.process, `process ${pid} should be reported`);
  return { problem, process: problem.process };
}

test("a named process is still reported, and the report carries its name", async () => {
  const { root, tree } = fixture();
  const reported = { pid: 4242, ppid: 1, startRaw: "s", startMs: 1, command: "gopls", cwd: tree, knownOwner: "IDE language server" };
  const monitor = new OrphanProcessMonitor({
    trees: () => [{ path: tree, slotId: null, owner: taskOwner }],
    retryReturn: () => {},
    unpooledRoots: [root],
    occupancy: async (paths) => new Map(paths.map((path) => [path, { status: "known", occupants: [reported] }])),
  });
  const { problem, process } = await reportedProcess(monitor, 4242);
  assert.equal(problem.kind, "orphan-process");
  assert.equal(process.knownOwner, "IDE language server");
});

test("a live session's process is still reported, and the report carries that session", async () => {
  const { root, tree } = fixture();
  const owner = { id: "session-1", name: "fix the login" };
  const reported = { pid: 4242, ppid: 1, startRaw: "s", startMs: 1, command: "claude", cwd: tree, knownOwner: "Session fix the login", session: owner };
  const monitor = new OrphanProcessMonitor({
    trees: () => [{ path: tree, slotId: null, owner: taskOwner }],
    retryReturn: () => {},
    unpooledRoots: [root],
    occupancy: async (paths) => new Map(paths.map((path) => [path, { status: "known", occupants: [reported] }])),
  });
  const { problem, process } = await reportedProcess(monitor, 4242);
  assert.equal(problem.kind, "orphan-process");
  assert.deepEqual(process.session, owner);
});

test("finished trees are pending task returns, returning check leases, quarantined slots and available slots", () => {
  const slot = (id: string, path: string, state: string, activeLeaseId: string | null = null) =>
    ({ id, path, state, activeLeaseId }) as WorktreeSlotRow;
  const trees = finishedTrees({
    pool: poolOf([
      slot("slot-1", "/pool/1/repo", "leased", "lease-task-1"),
      slot("slot-2", "/pool/2/repo", "quarantined"),
      slot("slot-5", "/pool/5/repo", "quarantined"),
      slot("slot-6", "/pool/6/repo", "available"),
    ]),
    taskReturns: [{ taskId: "task-1", trees: [
      { path: "/pool/1/repo", leaseId: "lease-task-1" },
      { path: "/state/worktrees/overflow", leaseId: null },
      // Quarantined after its lease was withdrawn while the obligation stayed: still ownerless.
      { path: "/pool/5/repo", leaseId: "lease-task-1-b" },
    ] }],
    returningChecks: [{ attemptId: "attempt-1", path: "/state/check-worktrees/check", leaseId: null }],
  });
  assert.deepEqual(trees, [
    { path: "/pool/1/repo", slotId: "slot-1", owner: { kind: "task", taskId: "task-1" } },
    { path: "/state/worktrees/overflow", slotId: null, owner: { kind: "task", taskId: "task-1" } },
    { path: "/pool/5/repo", slotId: "slot-5", owner: { kind: "task", taskId: "task-1" } },
    { path: "/state/check-worktrees/check", slotId: null, owner: { kind: "check", attemptId: "attempt-1" } },
    { path: "/pool/2/repo", slotId: "slot-2", owner: { kind: "slot", slotId: "slot-2" } },
    { path: "/pool/5/repo", slotId: "slot-5", owner: { kind: "slot", slotId: "slot-5" } },
    { path: "/pool/6/repo", slotId: "slot-6", owner: { kind: "available-slot", slotId: "slot-6" } },
  ]);
});

test("a slot leased to someone else, holding a lease while available, or running a claim, is never a finished tree, so a live owner's processes are not offered for Kill", () => {
  const slot = (id: string, path: string, state: string, activeLeaseId: string | null) =>
    ({ id, path, state, activeLeaseId }) as WorktreeSlotRow;
  // Task T completed owing slot 1, which was then reset and leased to live task U. Check C's
  // returning lease names slot 2, now leased to a manual holder. Slot 3 was quarantined while
  // its live lease stayed in the row. Task V's return names slot 4, now back in the pool with
  // no lease, where a dependency claim is still finishing. Slot 5 carries a lease in a row that
  // reads available, and task W's return names slot 6, which is back in the pool: it is an
  // available slot, not W's tree.
  const trees = finishedTrees({
    pool: poolOf([
      slot("slot-1", "/pool/1/repo", "leased", "lease-task-u"),
      slot("slot-2", "/pool/2/repo", "leased", "lease-manual"),
      slot("slot-3", "/pool/3/repo", "quarantined", "lease-live"),
      slot("slot-4", "/pool/4/repo", "available", null),
      slot("slot-5", "/pool/5/repo", "available", "lease-stale"),
      slot("slot-6", "/pool/6/repo", "available", null),
    ], (slotId) => slotId === "slot-4"),
    taskReturns: [
      { taskId: "task-t", trees: [{ path: "/pool/1/repo", leaseId: "lease-task-t" }] },
      { taskId: "task-v", trees: [{ path: "/pool/4/repo", leaseId: "lease-task-v" }] },
      { taskId: "task-w", trees: [{ path: "/pool/6/repo", leaseId: "lease-task-w" }] },
    ],
    returningChecks: [{ attemptId: "attempt-c", path: "/pool/2/repo", leaseId: "lease-check-c" }],
  });
  assert.deepEqual(trees, [
    { path: "/pool/6/repo", slotId: "slot-6", owner: { kind: "available-slot", slotId: "slot-6" } },
  ]);
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

/** Pool slots at real paths, listed through `finishedTrees` as the daemon lists them. */
function poolSlots(root: string, rows: Array<Pick<WorktreeSlotRow, "id" | "state" | "activeLeaseId">>) {
  return rows.map((row) => {
    const path = join(root, "pool", row.id, "repo");
    mkdirSync(path, { recursive: true });
    return { ...row, path } as WorktreeSlotRow;
  });
}

test("a process in an available slot with no lease is reported as an orphan process and Kill stops it", async () => {
  const { root } = fixture();
  const [slot] = poolSlots(root, [{ id: "slot-1", state: "available", activeLeaseId: null }]);
  const child = await occupant(slot!.path);
  const { monitor, signals, retried } = harness([], root, {
    trees: () => finishedTrees({ pool: poolOf([slot!]), taskReturns: [], returningChecks: [] }),
  });

  const { problem, process: listed } = await reportedProcess(monitor, child.pid!);
  assert.equal(problem.kind, "orphan-process");
  assert.equal(problem.bannered, true);
  assert.deepEqual(problem.link, { target: "slot", slotId: "slot-1" });
  assert.match(problem.message, /which no task or check owns/);

  const result = await monitor.kill({ path: slot!.path, pid: listed.pid, startedAt: listed.startedAt, command: listed.command });
  assert.deepEqual(result, { ok: true, signal: "SIGTERM" });
  assert.deepEqual(signals.map((each) => each.signal), ["SIGTERM"]);
  assert.equal(alive(child.pid!), false);
  assert.deepEqual(retried, [{ kind: "available-slot", slotId: "slot-1" }]);
  assert.deepEqual(monitor.problems(), []);
});

test("a process in an available row that still carries a lease is not reported", async () => {
  const { root } = fixture();
  const [held, empty] = poolSlots(root, [
    { id: "slot-1", state: "available", activeLeaseId: "lease-stale" },
    { id: "slot-2", state: "available", activeLeaseId: null },
  ]);
  await occupant(held!.path);
  const control = await occupant(empty!.path);
  const { monitor } = harness([], root, {
    trees: () => finishedTrees({ pool: poolOf([held!, empty!]), taskReturns: [], returningChecks: [] }),
  });

  await monitor.scan();
  assert.deepEqual(monitor.problems().map((problem) => problem.process?.pid), [control.pid]);
});

test("a slot reserved while the inspection runs is not reported, so a claim that just started is not offered for Kill", async () => {
  const { root } = fixture();
  const [available] = poolSlots(root, [{ id: "slot-1", state: "available", activeLeaseId: null }]);
  const child = await occupant(available!.path);
  let row = available!;
  const { monitor } = harness([], root, {
    trees: () => finishedTrees({ pool: poolOf([row]), taskReturns: [], returningChecks: [] }),
    occupancy: async (paths) => {
      const observed = await inspectWorktreeOccupancy(paths);
      // The claim's step is in the slot by the time the listing answers, and the slot now holds
      // the lease it was reserved under.
      row = { ...row, state: "provisioning", activeLeaseId: "lease-task" };
      return observed;
    },
  });

  await monitor.scan();
  assert.deepEqual(monitor.problems(), []);
  assert.equal(alive(child.pid!), true);
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

test("every finished Kill is reported, refused or not, naming the slot the report held", async () => {
  const { root, tree } = fixture();
  const child = await occupant(tree);
  const finished: OrphanKillRecord[] = [];
  const { monitor } = harness([{ path: tree, slotId: "slot-1", owner: taskOwner }], root, {
    killFinished: (kill) => { finished.push(kill); },
  });
  const { process: reported } = await reportedProcess(monitor, child.pid!);
  const request = { path: reported.tree, pid: reported.pid, startedAt: reported.startedAt, command: reported.command };

  const refused = await monitor.kill({ ...request, command: "something else" });
  assert.equal(refused.ok, false);
  assert.deepEqual((await monitor.kill(request)).ok, true);

  assert.deepEqual(finished.map((kill) => [kill.slotId, kill.path, kill.pid, kill.result.ok]), [
    ["slot-1", reported.tree, reported.pid, false],
    ["slot-1", reported.tree, reported.pid, true],
  ]);
  assert.ok(!JSON.stringify(finished).includes(reported.command), "the record never carries the command");
});

test("a signal that fails is a failed Kill, and a listener that throws does not change its answer", async () => {
  const { root, tree } = fixture();
  const child = await occupant(tree);
  const { monitor } = harness([{ path: tree, slotId: "slot-1", owner: taskOwner }], root, {
    signal: () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); },
    killFinished: () => { throw new Error("database is busy"); },
  });
  const { process: reported } = await reportedProcess(monitor, child.pid!);
  const warned = mock.method(console, "warn", () => {});
  try {
    const result = await monitor.kill({ path: reported.tree, pid: reported.pid, startedAt: reported.startedAt, command: reported.command });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.failed, true);
    assert.match(String(warned.mock.calls[0]?.arguments[0]), /could not be recorded/);
  } finally {
    warned.mock.restore();
    child.kill("SIGKILL");
  }
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

test("Kill refuses a live session's process from the fresh inspection, so a stale list cannot reach it", async () => {
  const { root, tree } = fixture();
  const child = await occupant(tree);
  const owner = { id: "session-1", name: "fix the login" };
  let session: typeof owner | null = null;
  let namesUnread = false;
  const retried: FinishedTreeOwner[] = [];
  const { monitor, signals } = harness([{ path: tree, slotId: null, owner: taskOwner }], root, {
    retryReturn: (finished) => {
      retried.push(finished);
    },
    occupancy: async (paths) => {
      const observed = await inspectWorktreeOccupancy(paths);
      for (const [path, state] of observed) {
        if (state.status !== "known") continue;
        observed.set(path, {
          status: "known",
          occupants: state.occupants.map((each) => ({ ...each, session })),
          ...(namesUnread ? { namesUnread: true as const } : {}),
        });
      }
      return observed;
    },
  });
  // Reported as nobody's, so this list is exactly what a stale card would act on.
  const { process: listed } = await reportedProcess(monitor, child.pid!);
  assert.equal(listed.session, null);
  const exact = { path: tree, pid: listed.pid, startedAt: listed.startedAt, command: listed.command };

  session = owner;
  assert.deepEqual(await monitor.kill(exact), {
    ok: false,
    error: `process ${child.pid} belongs to live session fix the login; end it from the session`,
  });
  session = null;
  namesUnread = true;
  assert.deepEqual(await monitor.kill(exact), {
    ok: false,
    error: `process ${child.pid} could not be checked against the live sessions`,
  });
  assert.deepEqual(signals, []);
  assert.deepEqual(retried, [], "a refusal retries no return");
  assert.equal(alive(child.pid!), true);

  // The session is gone, so a card that still called it one no longer protects it.
  namesUnread = false;
  assert.deepEqual(await monitor.kill(exact), { ok: true, signal: "SIGTERM" });
  assert.equal(alive(child.pid!), false);
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
  let session: { id: string; name: string } | null = null;
  const { monitor, signals } = harness([{ path: tree, slotId: null, owner: taskOwner }], root, {
    occupancy: async (paths) => {
      const observed = await inspectWorktreeOccupancy(paths);
      for (const [path, state] of observed) {
        if (state.status === "known") {
          observed.set(path, { status: "known", occupants: state.occupants.map((each) => ({ ...each, session })) });
        }
      }
      return observed;
    },
  });
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
  session = { id: "session-1", name: "fix the login" };
  const sessions = await kill({ path: tree, pid: listed.pid, startedAt: listed.startedAt, command: listed.command });
  assert.equal(sessions.status, 409);
  assert.deepEqual(await sessions.json(), {
    ok: false,
    error: `process ${listed.pid} belongs to live session fix the login; end it from the session`,
  });
  session = null;
  assert.deepEqual(signals, []);
  const killed = await kill({ path: tree, pid: listed.pid, startedAt: listed.startedAt, command: listed.command });
  assert.equal(killed.status, 200);
  assert.deepEqual(await killed.json(), { ok: true, signal: "SIGTERM" });
  assert.equal(alive(child.pid!), false);
});
