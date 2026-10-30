import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Proc } from "../src/server/discovery/processes.ts";
import {
  knownOwnerLabels,
  sessionProcesses,
  type SessionProcess,
} from "../src/server/worktrees/known-owners.ts";
import {
  inspectWorktreeOccupancy,
  pathContains,
} from "../src/server/worktrees/occupancy.ts";
import { bothAttempts } from "../src/server/worktrees/observation-retry.ts";
import type { Session } from "../src/shared/types.ts";

function process(pid: number, ppid = 1): Proc {
  return {
    pid,
    ppid,
    tty: null,
    startRaw: `start-${pid}`,
    startMs: pid * 1000,
    command: `node worker-${pid}.mjs`,
    agent: null,
    agentNative: false,
  };
}

/** The retry's 2 s wait, skipped. */
const noPause = async () => {};

function fixture(): { root: string; one: string; ten: string; nested: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-worktree-occupancy-")));
  const one = join(root, "1", "repo");
  const ten = join(root, "10", "repo");
  const nested = join(one, "packages", "app");
  mkdirSync(nested, { recursive: true });
  mkdirSync(ten, { recursive: true });
  return { root, one, ten, nested };
}

test("path containment is segment-aware", () => {
  const { one, ten, nested } = fixture();
  assert.equal(pathContains(one, one), true);
  assert.equal(pathContains(one, nested), true);
  assert.equal(pathContains(one, ten), false, "slot 1 must not contain slot 10");
});

test("occupancy batches one process read and one cwd read across every target", async () => {
  const { one, ten, nested } = fixture();
  let processReads = 0;
  let cwdReads = 0;
  const result = await inspectWorktreeOccupancy([one, ten], {
    listProcesses: async () => {
      processReads++;
      return {
        processes: [process(10), process(20)],
        unknownReason: null,
        cwdScopePids: [10, 20],
        completedCollectorPids: [],
      };
    },
    readCwds: async (pids) => {
      cwdReads++;
      assert.deepEqual(pids, [10, 20]);
      return { cwds: new Map([[10, nested], [20, ten]]), unknownReason: null };
    },
    knownOwner: () => (proc) => (proc.pid === 10 ? "terminal:session-1" : null),
  });

  assert.equal(processReads, 1);
  assert.equal(cwdReads, 1);
  const inOne = result.get(one)!;
  assert.equal(inOne.status, "known");
  if (inOne.status === "known") {
    assert.deepEqual(inOne.occupants.map((one) => [one.pid, one.knownOwner]), [
      [10, "terminal:session-1"],
    ]);
  }
  const inTen = result.get(ten)!;
  assert.equal(inTen.status, "known");
  if (inTen.status === "known") assert.deepEqual(inTen.occupants.map((one) => one.pid), [20]);
});

test("a ps-listed PID omitted by a partial cwd result makes occupancy unknown", async () => {
  const { one } = fixture();
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10), process(20)],
      unknownReason: null,
      cwdScopePids: [10, 20],
      completedCollectorPids: [],
    }),
    // The cwd reader cannot prove whether PID 20 vanished or was merely omitted.
    readCwds: async () => ({ cwds: new Map([[10, one]]), unknownReason: null }),
    pause: noPause,
  });
  assert.deepEqual(result.get(one), {
    status: "unknown",
    reason: "cwd listing omitted 1 ps-listed PID: 20, and again on retry",
  });
});

test("a PID whose cwd the system refused is outside the boundary, not an omission", async () => {
  const { one } = fixture();
  let processReads = 0;
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => {
      processReads++;
      return {
        processes: [process(10), process(20)],
        unknownReason: null,
        cwdScopePids: [10, 20],
        completedCollectorPids: [],
      };
    },
    // PID 20 is a same-user process Linux will not let this user inspect.
    readCwds: async () => ({ cwds: new Map([[10, one]]), unreadable: new Set([20]), unknownReason: null }),
  });
  const occupancy = result.get(one);
  assert.equal(occupancy?.status, "known");
  if (occupancy?.status === "known") {
    assert.deepEqual(occupancy.occupants.map((entry) => entry.pid), [10]);
  }
  assert.equal(processReads, 1, "nothing was unresolved, so no disappearance check ran");
});

test("a refused PID still counts as unresolved when the cwd listing itself failed", async () => {
  const { one } = fixture();
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10), process(20)],
      unknownReason: null,
      cwdScopePids: [10, 20],
      completedCollectorPids: [],
    }),
    readCwds: async () => ({
      cwds: new Map(),
      unreadable: new Set([20]),
      unknownReason: "cwd listing failed: exit 1",
    }),
    pause: noPause,
  });
  assert.deepEqual(result.get(one), { status: "unknown", reason: "cwd listing failed: exit 1, and again on retry" });
});

test("a completed ps collector is excluded from cwd completeness", async () => {
  const { one } = fixture();
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10), process(20)],
      unknownReason: null,
      cwdScopePids: [10, 20],
      completedCollectorPids: [20],
    }),
    readCwds: async (pids) => {
      assert.deepEqual(pids, [10]);
      return { cwds: new Map([[10, one]]), unknownReason: null };
    },
  });
  const occupancy = result.get(one);
  assert.equal(occupancy?.status, "known");
  if (occupancy?.status === "known") {
    assert.deepEqual(occupancy.occupants.map((entry) => entry.pid), [10]);
  }
});

test("a process outside the daemon user scope is not sent to cwd inspection", async () => {
  const { one } = fixture();
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10), process(20)],
      unknownReason: null,
      cwdScopePids: [10],
      completedCollectorPids: [],
    }),
    readCwds: async (pids) => {
      assert.deepEqual(pids, [10]);
      return { cwds: new Map([[10, one]]), unknownReason: null };
    },
  });
  const occupancy = result.get(one);
  assert.equal(occupancy?.status, "known");
  if (occupancy?.status === "known") {
    assert.deepEqual(occupancy.occupants.map((entry) => entry.pid), [10]);
  }
});

test("an omitted PID is ignored only after a fresh snapshot proves it disappeared", async () => {
  const { one } = fixture();
  let processReads = 0;
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => {
      processReads++;
      return processReads === 1
        ? {
            processes: [process(10), process(20)],
            unknownReason: null,
            cwdScopePids: [10, 20],
            completedCollectorPids: [],
          }
        : {
            processes: [process(10)],
            unknownReason: null,
            cwdScopePids: [10],
            completedCollectorPids: [],
          };
    },
    readCwds: async () => ({ cwds: new Map([[10, one]]), unknownReason: null }),
  });
  assert.equal(processReads, 2);
  const occupancy = result.get(one);
  assert.equal(occupancy?.status, "known");
  if (occupancy?.status === "known") {
    assert.deepEqual(occupancy.occupants.map((entry) => entry.pid), [10]);
  }
});

test("a failed or timed-out process read is unknown, never empty", async () => {
  const { one } = fixture();
  const processFailure = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [],
      unknownReason: "ps timed out",
      cwdScopePids: [],
      completedCollectorPids: [],
    }),
    pause: noPause,
  });
  assert.deepEqual(processFailure.get(one), { status: "unknown", reason: "ps timed out, and again on retry" });

  const cwdFailure = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10)],
      unknownReason: null,
      cwdScopePids: [10],
      completedCollectorPids: [],
    }),
    readCwds: async () => ({ cwds: new Map(), unknownReason: "lsof failed" }),
    pause: noPause,
  });
  assert.deepEqual(cwdFailure.get(one), { status: "unknown", reason: "lsof failed, and again on retry" });
});

test("a failed cwd read is empty only after every original process is proven gone", async () => {
  const { one } = fixture();
  let processReads = 0;
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => {
      processReads++;
      return processReads === 1
        ? {
            processes: [process(10)],
            unknownReason: null,
            cwdScopePids: [10],
            completedCollectorPids: [],
          }
        : {
            processes: [],
            unknownReason: null,
            cwdScopePids: [],
            completedCollectorPids: [],
          };
    },
    readCwds: async () => ({ cwds: new Map(), unknownReason: "cwd listing failed: exit 1" }),
  });
  assert.equal(processReads, 2);
  assert.deepEqual(result.get(one), { status: "known", occupants: [] });
});

test("an oversized occupancy request fails closed without spawning system reads", async () => {
  let processReads = 0;
  const paths = Array.from({ length: 257 }, (_, index) => `/tmp/native-slot-${index}`);
  const result = await inspectWorktreeOccupancy(paths, {
    listProcesses: async () => {
      processReads++;
      return {
        processes: [],
        unknownReason: null,
        cwdScopePids: [],
        completedCollectorPids: [],
      };
    },
  });
  assert.equal(processReads, 0);
  assert.equal(result.size, 257);
  assert.deepEqual(result.get(paths[0]!), {
    status: "unknown",
    reason: "occupancy query exceeds 256 paths",
  });
});

test("an omitted PID that the fresh snapshot shows exiting as a zombie is not left unresolved", async () => {
  // Caught mid-exit: ps lists it, its cwd is already gone so the cwd reader omits it, and the
  // confirming ps lists it again - same start time, now a zombie and therefore out of scope.
  const { one } = fixture();
  let processReads = 0;
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => {
      processReads++;
      return {
        processes: [process(10), process(20)],
        unknownReason: null,
        cwdScopePids: processReads === 1 ? [10, 20] : [10],
        completedCollectorPids: [],
      };
    },
    readCwds: async () => ({ cwds: new Map([[10, one]]), unknownReason: null }),
  });
  assert.equal(processReads, 2);
  const occupancy = result.get(one);
  assert.equal(occupancy?.status, "known");
  if (occupancy?.status === "known") {
    assert.deepEqual(occupancy.occupants.map((entry) => entry.pid), [10]);
  }
});

test("an omitted PID that is still live and in scope keeps occupancy unknown", async () => {
  const { one } = fixture();
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10), process(20)],
      unknownReason: null,
      cwdScopePids: [10, 20],
      completedCollectorPids: [],
    }),
    readCwds: async () => ({ cwds: new Map([[10, one]]), unknownReason: null }),
    pause: noPause,
  });
  assert.deepEqual(result.get(one), {
    status: "unknown",
    reason: "cwd listing omitted 1 ps-listed PID: 20, and again on retry",
  });
});

test("this daemon's running worktree Git and its helpers are never occupants, and are not cwd-read", async () => {
  const { one } = fixture();
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10), process(20), process(30, 20)],
      unknownReason: null,
      cwdScopePids: [10, 20, 30],
      completedCollectorPids: [],
    }),
    ownProcesses: () => new Set([20]),
    readCwds: async (pids) => {
      assert.deepEqual(pids, [10], "our Git (20) and its helper (30) are excluded before the cwd read");
      return { cwds: new Map([[10, one]]), unknownReason: null };
    },
  });
  const occupancy = result.get(one);
  assert.equal(occupancy?.status, "known");
  if (occupancy?.status === "known") {
    assert.deepEqual(occupancy.occupants.map((entry) => entry.pid), [10], "a foreign process in the slot still counts");
  }
});

// AC3: under load a batched `lsof` drops a PID it answers for when asked alone, and one such
// omission used to make the whole pass unknown for every slot.
test("a PID omitted by the cwd listing is re-read alone, and resolving it keeps occupancy known", async () => {
  const { one, ten, nested } = fixture();
  const cwdReads: number[][] = [];
  let processReads = 0;
  const result = await inspectWorktreeOccupancy([one, ten], {
    listProcesses: async () => {
      processReads++;
      return {
        processes: [process(10), process(20), process(30)],
        unknownReason: null,
        cwdScopePids: [10, 20, 30],
        completedCollectorPids: [],
      };
    },
    readCwds: async (pids) => {
      cwdReads.push(pids);
      // The batch omits 20; asked alone, it answers.
      if (pids.length > 1) return { cwds: new Map([[10, nested], [30, ten]]), unknownReason: null };
      return { cwds: new Map(pids.includes(20) ? [[20, one]] : []), unknownReason: null };
    },
    pause: async () => assert.fail("a resolved PID needs no retry"),
  });
  assert.deepEqual(cwdReads, [[10, 20, 30], [20]], "only the omitted PID is re-read, on its own");
  assert.equal(processReads, 1, "nothing stayed unresolved, so no disappearance check ran");
  assert.deepEqual(
    [...result].map(([target, occupancy]) => [
      target,
      occupancy.status === "known" ? occupancy.occupants.map((entry) => entry.pid) : occupancy.reason,
    ]),
    [[one, [10, 20]], [ten, [30]]],
  );
});

test("a re-read PID that is still unresolved and alive with the same start time is unknown", async () => {
  const { one } = fixture();
  const cwdReads: number[][] = [];
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10), process(20)],
      unknownReason: null,
      cwdScopePids: [10, 20],
      completedCollectorPids: [],
    }),
    readCwds: async (pids) => {
      cwdReads.push(pids);
      return { cwds: new Map(pids.includes(10) ? [[10, one]] : []), unknownReason: null };
    },
    pause: noPause,
  });
  assert.deepEqual(cwdReads, [[10, 20], [20], [10, 20], [20]], "each attempt re-reads 20 alone");
  assert.deepEqual(result.get(one), {
    status: "unknown",
    reason: "cwd listing omitted 1 ps-listed PID: 20, and again on retry",
  });
});

// AC2, first half: a failed listing that answers on its retry changes nothing.
test("a listing that fails once and then succeeds is known, after one 2 s pause and doubled timeouts", async () => {
  const { one } = fixture();
  const pauses: number[] = [];
  const listings: Array<number | undefined> = [];
  const cwdReads: Array<number | undefined> = [];
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async (options) => {
      listings.push(options?.timeoutScale);
      return listings.length === 1
        ? {
            processes: [],
            unknownReason: "process listing failed: the process listing timed out after 4 s",
            cwdScopePids: [],
            completedCollectorPids: [],
          }
        : {
            processes: [process(10)],
            unknownReason: null,
            cwdScopePids: [10],
            completedCollectorPids: [],
          };
    },
    readCwds: async (_pids, options) => {
      cwdReads.push(options?.timeoutScale);
      return { cwds: new Map([[10, one]]), unknownReason: null };
    },
    pause: async (ms) => {
      pauses.push(ms);
    },
  });
  assert.deepEqual(pauses, [2_000]);
  assert.deepEqual(listings, [undefined, 2], "the retry runs with double the timeout");
  assert.deepEqual(cwdReads, [2]);
  const occupancy = result.get(one);
  assert.equal(occupancy?.status, "known");
  if (occupancy?.status === "known") assert.deepEqual(occupancy.occupants.map((entry) => entry.pid), [10]);
});

test("a listing that times out twice names both attempts", async () => {
  const { one } = fixture();
  let attempt = 0;
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [],
      unknownReason: `process listing failed: the process listing timed out after ${++attempt === 1 ? 4 : 8} s`,
      cwdScopePids: [],
      completedCollectorPids: [],
    }),
    pause: noPause,
  });
  assert.deepEqual(result.get(one), {
    status: "unknown",
    reason: "process listing failed: the process listing timed out after 4 s, and after 8 s on retry",
  });
});

test("a re-read that the system refuses puts the PID outside the boundary, and occupancy stays known", async () => {
  const { one } = fixture();
  const cwdReads: number[][] = [];
  let processReads = 0;
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => {
      processReads++;
      return {
        processes: [process(10), process(20)],
        unknownReason: null,
        cwdScopePids: [10, 20],
        completedCollectorPids: [],
      };
    },
    readCwds: async (pids) => {
      cwdReads.push(pids);
      return pids.length > 1
        ? { cwds: new Map([[10, one]]), unknownReason: null }
        : { cwds: new Map(), unreadable: new Set([20]), unknownReason: null };
    },
    pause: async () => assert.fail("a refused PID is resolved, so nothing is retried"),
  });
  assert.deepEqual(cwdReads, [[10, 20], [20]]);
  assert.equal(processReads, 1, "nothing stayed unresolved, so no disappearance check ran");
  const occupancy = result.get(one);
  assert.equal(occupancy?.status, "known");
  if (occupancy?.status === "known") assert.deepEqual(occupancy.occupants.map((entry) => entry.pid), [10]);
});

test("a re-read that throws leaves the PID to the disappearance check, not a failed pass", async () => {
  const { one } = fixture();
  const cwdReads: number[][] = [];
  let processReads = 0;
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => {
      processReads++;
      // The confirmation snapshot shows 20 gone.
      return processReads === 1
        ? { processes: [process(10), process(20)], unknownReason: null, cwdScopePids: [10, 20], completedCollectorPids: [] }
        : { processes: [process(10)], unknownReason: null, cwdScopePids: [10], completedCollectorPids: [] };
    },
    readCwds: async (pids) => {
      cwdReads.push(pids);
      if (pids.length === 1) throw new Error("lsof could not be spawned");
      return { cwds: new Map([[10, one]]), unknownReason: null };
    },
    pause: async () => assert.fail("the disappearance check resolved it, so nothing is retried"),
  });
  assert.deepEqual(cwdReads, [[10, 20], [20]]);
  assert.equal(processReads, 2);
  const occupancy = result.get(one);
  assert.equal(occupancy?.status, "known");
  if (occupancy?.status === "known") assert.deepEqual(occupancy.occupants.map((entry) => entry.pid), [10]);
});

test("only the first eight omitted PIDs are re-read alone; the rest stay unresolved", async () => {
  const { one } = fixture();
  const omitted = [21, 22, 23, 24, 25, 26, 27, 28, 29];
  const all = [10, ...omitted];
  const cwdReads: number[][] = [];
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: all.map((pid) => process(pid)),
      unknownReason: null,
      cwdScopePids: all,
      completedCollectorPids: [],
    }),
    readCwds: async (pids) => {
      cwdReads.push(pids);
      // The batch omits every PID but 10; asked alone, each would answer.
      return pids.length > 1
        ? { cwds: new Map([[10, one]]), unknownReason: null }
        : { cwds: new Map([[pids[0]!, one]]), unknownReason: null };
    },
    pause: noPause,
  });
  assert.deepEqual(
    cwdReads.slice(0, 9),
    [all, ...omitted.slice(0, 8).map((pid) => [pid])],
    "the ninth omitted PID is never read alone",
  );
  assert.deepEqual(result.get(one), {
    status: "unknown",
    reason: "cwd listing omitted 1 ps-listed PID: 29, and again on retry",
  });
});

test("a read that fails twice names both attempts", () => {
  assert.equal(
    bothAttempts("git status timed out after 15 s", "git status timed out after 30 s"),
    "git status timed out after 15 s, and after 30 s on retry",
  );
  assert.equal(bothAttempts("lsof failed", "lsof failed"), "lsof failed, and again on retry");
  assert.equal(
    bothAttempts("git status timed out after 15 s", "git status failed: fatal: index file corrupt"),
    "git status timed out after 15 s, and on retry git status failed: fatal: index file corrupt",
  );
  // Two different steps that both timed out are not folded into one.
  assert.equal(
    bothAttempts("git status timed out after 15 s", "git rev-parse HEAD timed out after 30 s"),
    "git status timed out after 15 s, and on retry git rev-parse HEAD timed out after 30 s",
  );
});

test("the re-reads stop at the first one that did not answer, so an attempt spends one timeout on them", async () => {
  const { one } = fixture();
  const cwdReads: number[][] = [];
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10), process(20), process(30)],
      unknownReason: null,
      cwdScopePids: [10, 20, 30],
      completedCollectorPids: [],
    }),
    readCwds: async (pids) => {
      cwdReads.push(pids);
      return pids.length > 1
        ? { cwds: new Map([[10, one]]), unknownReason: null }
        : {
            cwds: new Map(),
            unknownReason: "cwd listing failed: the cwd listing timed out after 30 s",
            unanswered: true,
          };
    },
    pause: noPause,
  });
  assert.deepEqual(cwdReads, [[10, 20, 30], [20], [10, 20, 30], [20]], "30 is never re-read after 20 timed out");
  assert.deepEqual(result.get(one), {
    status: "unknown",
    reason: "cwd listing omitted 2 ps-listed PIDs: 20, 30, and again on retry",
  });
});

test("a listing too large to buffer is not retried, because asking again cannot shrink it", async () => {
  const { one } = fixture();
  const ps = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [],
      unknownReason: "process listing failed: the process listing was too large to buffer",
      overflowed: true,
      cwdScopePids: [],
      completedCollectorPids: [],
    }),
    pause: async () => assert.fail("an overflow is not retried"),
  });
  assert.deepEqual(ps.get(one), {
    status: "unknown",
    reason: "process listing failed: the process listing was too large to buffer",
  });

  let cwdReads = 0;
  const lsof = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(10)],
      unknownReason: null,
      cwdScopePids: [10],
      completedCollectorPids: [],
    }),
    readCwds: async () => {
      cwdReads++;
      return { cwds: new Map(), unknownReason: "cwd listing failed: the cwd listing was too large to buffer", overflowed: true };
    },
    pause: async () => assert.fail("an overflow is not retried"),
  });
  assert.equal(cwdReads, 1);
  assert.deepEqual(lsof.get(one), {
    status: "unknown",
    reason: "cwd listing failed: the cwd listing was too large to buffer",
  });
});

/** The occupants of one slot, labelled as the daemon labels them, keyed by PID. */
async function labels(
  table: Proc[],
  sessions: SessionProcess[],
  options: { outOfScope?: number[] } = {},
): Promise<Map<number, string | null>> {
  const { one } = fixture();
  const scoped = table.filter((row) => !options.outOfScope?.includes(row.pid));
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: table,
      unknownReason: null,
      cwdScopePids: scoped.map((row) => row.pid),
      completedCollectorPids: [],
    }),
    readCwds: async (pids) => ({ cwds: new Map(pids.map((pid) => [pid, one])), unknownReason: null }),
    knownOwner: knownOwnerLabels(() => sessions),
  });
  const state = result.get(one)!;
  assert.equal(state.status, "known");
  return new Map(state.status === "known" ? state.occupants.map((row) => [row.pid, row.knownOwner]) : []);
}

const session: SessionProcess = { pid: 100, startMs: 100_000, name: "fix the login" };

test("a session's own process and its descendants are named as that session", async () => {
  const named = await labels([process(100), process(101, 100), process(102, 101)], [session]);
  assert.deepEqual([...named.values()], Array(3).fill("Session fix the login"));
});

test("a descendant is named through an ancestor outside the cwd scope", async () => {
  // A `sudo` between the session and its child belongs to another user, so no cwd is read for
  // it, but the parent links still run through it.
  const named = await labels([process(100), process(101, 100), process(102, 101)], [session], { outOfScope: [101] });
  assert.equal(named.get(102), "Session fix the login");
  assert.equal(named.has(101), false);
});

test("a process that only shares a session's cwd is not named as that session", async () => {
  const named = await labels([process(100), process(200, 1)], [session]);
  assert.equal(named.get(100), "Session fix the login");
  assert.equal(named.get(200), null);
});

test("a reused PID is not the session, and neither are its children", async () => {
  const reused = { ...process(100), startMs: 999_000 };
  const named = await labels([reused, process(101, 100)], [session]);
  assert.deepEqual([...named.values()], [null, null]);
});

test("a Claude Code background process and its MCP children are named", async () => {
  const daemon = { ...process(300), command: "/home/me/.local/share/claude/versions/2.1.195 daemon run" };
  const mcp = { ...process(301, 300), command: "node /srv/mcp/server.js" };
  const named = await labels([daemon, mcp], []);
  assert.deepEqual([...named.values()], Array(2).fill("Claude Code background process"));
});

test("a background role a session spawned belongs to that session", async () => {
  const mcp = { ...process(101, 100), command: "claude mcp serve" };
  assert.equal((await labels([process(100), mcp], [session])).get(101), "Session fix the login");
});

test("an IDE helper is named by its executable, and its children are not", async () => {
  const plugin = "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility";
  const named = await labels([
    { ...process(400), command: "/home/me/go/bin/gopls serve" },
    { ...process(401), command: plugin },
    { ...process(402), command: "/opt/idea/bin/fsnotifier" },
    { ...process(403, 400), command: "go list ./..." },
    { ...process(404), command: "vim gopls" },
  ], []);
  assert.deepEqual([...named.values()], [
    "IDE language server", "VS Code helper", "JetBrains IDE helper", null, null,
  ]);
});

test("a named process stays an occupant", async () => {
  const { one } = fixture();
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(100)],
      unknownReason: null,
      cwdScopePids: [100],
      completedCollectorPids: [],
    }),
    readCwds: async () => ({ cwds: new Map([[100, one]]), unknownReason: null }),
    knownOwner: knownOwnerLabels(() => [session]),
  });
  const state = result.get(one)!;
  assert.equal(state.status === "known" && state.occupants.length, 1);
});

test("names that cannot be read leave the occupant counted and unnamed", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { one } = fixture();
  const result = await inspectWorktreeOccupancy([one], {
    listProcesses: async () => ({
      processes: [process(100)],
      unknownReason: null,
      cwdScopePids: [100],
      completedCollectorPids: [],
    }),
    readCwds: async () => ({ cwds: new Map([[100, one]]), unknownReason: null }),
    knownOwner: knownOwnerLabels(() => {
      throw new Error("database is closed");
    }),
  });
  const state = result.get(one)!;
  assert.equal(state.status, "known");
  if (state.status === "known") assert.deepEqual(state.occupants.map((row) => [row.pid, row.knownOwner]), [[100, null]]);
});

test("a session's process is its process start, or its recorded SDK lifetime", () => {
  const live = (over: Partial<Session>) => ({ id: "s", name: "n", runtime: "terminal", pid: 7, startedAt: 7_000, ...over }) as Session;
  const lifetimes = new Map([["sdk:a", { pid: 8, startMs: 8_000 }]]);
  assert.deepEqual(
    sessionProcesses([
      live({ id: "terminal" }),
      // An SDK session's `startedAt` is when it registered, which matches no process.
      live({ id: "sdk:a", runtime: "sdk", pid: 8, startedAt: 1 }),
      live({ id: "sdk:unbound", runtime: "sdk", pid: 0 }),
      live({ id: "no-start", startedAt: null }),
    ], (id) => lifetimes.get(id) ?? null),
    [{ pid: 7, startMs: 7_000, name: "n" }, { pid: 8, startMs: 8_000, name: "n" }],
  );
});
