import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { openDb } from "../src/server/db.ts";
import { WorktreeManager } from "../src/server/worktrees/manager.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";

// What is at stake: storage health recomputes after every worktree maintenance pass through the
// `afterPass` hook. A hook that never ran would leave Settings > Storage stale until the next
// capture; one that threw out of the pass would stop maintenance rescheduling at all.

const SWEEP_MS = 300_000;

function emptyOccupancy(paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> {
  return Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants: [] }])));
}

const managers: WorktreeManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
  mock.timers.reset();
});

/** A manager on fake timers, and a way to run one maintenance pass to completion. */
function maintained(afterPass: () => void) {
  mock.timers.enable({ apis: ["setTimeout"] });
  const manager = new WorktreeManager(openDb(), { occupancy: emptyOccupancy });
  managers.push(manager);
  const reclaims: number[] = [];
  manager.startMaintenance(async () => { reclaims.push(reclaims.length + 1); }, afterPass);
  return {
    reclaims,
    /**
     * Fire the sweep timer and let the pass settle and reschedule. With no native pool the pass
     * does no I/O, so draining the microtask queue (`setImmediate` is not faked) finishes it.
     */
    async pass(): Promise<void> {
      mock.timers.tick(SWEEP_MS);
      for (let turn = 0; turn < 3; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
  };
}

test("each maintenance pass calls the afterPass hook once, after the domain lease reclamation", async () => {
  const calls: number[] = [];
  const { reclaims, pass } = maintained(() => {
    calls.push(reclaims.length);
  });
  await pass();
  assert.deepEqual(calls, [1], "one hook call, after the pass's reclamation ran");
  await pass();
  assert.deepEqual(calls, [1, 2], "and once more on the next pass");
});

test("a throwing afterPass hook is logged and never stops later passes", async () => {
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    let calls = 0;
    const { reclaims, pass } = maintained(() => {
      calls += 1;
      throw new Error("storage health recompute failed");
    });
    await pass();
    assert.equal(calls, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]![0], "[worktrees] after-maintenance hook failed:");
    assert.match(String(errors[0]![1]), /storage health recompute failed/);

    await pass();
    assert.equal(calls, 2, "the pass rescheduled despite the throw");
    assert.equal(reclaims.length, 2, "and the next pass ran its reclamation too");
  } finally {
    console.error = originalError;
  }
});
