import { afterEach } from "node:test";
import type { Registry } from "../../src/server/registry.ts";
import type { TaskManager, TaskManagerStartupDeps } from "../../src/server/tasks.ts";

/**
 * Background worktree-return seams that answer at once: no checkout is occupied and every
 * return succeeds.
 *
 * A task completed while holding a worktree owes a return, and the real seams scan the whole
 * machine (`ps` and `lsof`) and run `git worktree remove` on it. Against a fixture's made-up
 * path that remove always fails, so the return was retried forever, and the scans kept the
 * test file's event loop alive long after its last test passed.
 */
export const instantWorktreeReturns: TaskManagerStartupDeps = {
  occupancy: async (paths) =>
    new Map(paths.map((path) => [path, { status: "known" as const, occupants: [] }])),
  returnBlocker: async () => null,
  teardown: async () => {},
};

/**
 * A factory for TaskManagers that use `instantWorktreeReturns` and are stopped and drained
 * after each test. Takes the class because test files import it only after seeding their home.
 */
export function trackedTaskManagers(
  TaskManagerClass: typeof TaskManager,
): (registry: Registry) => TaskManager {
  const managers: TaskManager[] = [];
  afterEach(async () => {
    for (const manager of managers.splice(0)) {
      manager.stopMissionSessionClosures();
      await manager.settleWorktreeReturns();
    }
  });
  return (registry) => {
    const manager = new TaskManagerClass(
      registry, undefined, undefined, undefined, undefined, instantWorktreeReturns,
    );
    managers.push(manager);
    return manager;
  };
}
