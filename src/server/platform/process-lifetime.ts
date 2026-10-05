import type { ChildProcess, SpawnOptions } from "node:child_process";

// Process lifetime: start a child as the root of a process tree, and end that whole tree.
//
// Every caller that needs a child's descendants to die with it goes through here, so a platform
// that cannot express "the tree" as a POSIX process group has one place to say how it does.
//
// The seam owns the spawn OPTIONS, not the `spawn` call. Each caller keeps its own direct call,
// so `test/executable-contracts.test.ts` still sees which executable every call site runs and
// where that executable came from; a shared `spawn(command)` here would hide all of them.
//
// The Electron main process and the daemon both import this file, so it stays a leaf: Node
// builtins only, nothing from the rest of `src/server`. `test/process-lifetime.test.ts` holds
// that line.

export interface ProcessLifetime {
  /**
   * Spread into a `spawn` call's options to start the child as the root of its own tree, which
   * `signalTree` and `killTree` can reach. Spread first; the caller never sets these keys.
   */
  readonly treeRootOptions: Readonly<Pick<SpawnOptions, "detached">>;
  /**
   * Signal every process in the tree rooted at `pid`. Throws exactly as `process.kill` does,
   * and signal `0` sends nothing: it asks whether the tree still exists.
   */
  signalTree(pid: number, signal: NodeJS.Signals | 0): void;
  /** `SIGKILL` the child's tree, falling back to the child alone. Never throws. */
  killTree(child: Pick<ChildProcess, "pid" | "kill">): void;
}

export interface ProcessLifetimeDeps {
  kill(pid: number, signal: NodeJS.Signals | 0): void;
}

const nodeDeps: ProcessLifetimeDeps = {
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
};

/**
 * POSIX: `detached: true` makes the child its own process-group (and session) leader, and a
 * negative pid signals that whole group, grandchildren included.
 *
 * A descendant that calls `setsid()` leaves the group, and nothing signalled at the group can
 * reach it afterwards. Callers that care state it where they rely on it.
 */
export function createPosixProcessLifetime(deps: ProcessLifetimeDeps = nodeDeps): ProcessLifetime {
  const signalTree = (pid: number, signal: NodeJS.Signals | 0): void => deps.kill(-pid, signal);
  return {
    treeRootOptions: Object.freeze({ detached: true }),
    signalTree,
    killTree(child) {
      try {
        if (child.pid) signalTree(child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child is already gone, which is the state this wanted.
        }
      }
    },
  };
}

const posix = createPosixProcessLifetime();

/**
 * The platform-selection point. `release/windows` registers `win32` here; `main` registers
 * nothing, so every platform, Windows included, resolves to the POSIX implementation.
 */
const byPlatform: Partial<Record<NodeJS.Platform, ProcessLifetime>> = {};

export function processLifetimeFor(platform: NodeJS.Platform): ProcessLifetime {
  return byPlatform[platform] ?? posix;
}

export const processLifetime: ProcessLifetime = processLifetimeFor(process.platform);
