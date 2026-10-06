import { execFileSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { win32 } from "node:path";

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
  readonly treeRootOptions: Readonly<Pick<SpawnOptions, "detached" | "windowsHide">>;
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
    killTree: killTreeThrough(signalTree),
  };
}

/** `SIGKILL` the tree through `signalTree`, falling back to the child alone. Never throws. */
function killTreeThrough(
  signalTree: ProcessLifetime["signalTree"],
): ProcessLifetime["killTree"] {
  return (child) => {
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
  };
}

export interface Win32ProcessLifetimeDeps extends ProcessLifetimeDeps {
  /** Run `taskkill.exe` with these arguments to completion. Throws as `execFileSync` does. */
  taskkill(args: readonly string[]): void;
}

/** taskkill's exit status when no process has the pid it was given. */
const TASKKILL_NOT_FOUND = 128;

const win32NodeDeps: Win32ProcessLifetimeDeps = {
  ...nodeDeps,
  taskkill(args) {
    const systemRoot = process.env.SystemRoot?.trim() || "C:\\Windows";
    const executable = win32.join(systemRoot, "System32", "taskkill.exe");
    execFileSync(executable, [...args], { stdio: "ignore", timeout: 10_000, windowsHide: true });
  },
};

/** An error shaped like the one `process.kill` throws, so callers read one `code` everywhere. */
function killError(code: "ESRCH" | "EPERM", cause: unknown): Error {
  return Object.assign(new Error(`kill ${code}`, { cause }), { code, syscall: "kill" });
}

/**
 * win32: there are no process groups and no signals, so the tree is the parent-pid tree that
 * `taskkill /T` walks, and every signal that is not `0` ends it with `/F`.
 *
 * - **Starting a tree root.** Nothing has to make a child a group leader for `taskkill /T` to
 *   find its descendants, and `detached` would move it out of the job Node uses to end its
 *   direct children with the daemon, and give it no console, so a console grandchild it starts
 *   would open a window of its own. So the child is started attached, with its console window
 *   hidden.
 * - **Signals.** A console program has no handler `taskkill` can reach without `/F`, so
 *   `SIGTERM` and `SIGINT` are as forceful as `SIGKILL` here. Callers with a grace period
 *   (`workflows/check-group.ts`) run only where process groups exist.
 * - **Probing.** Signal `0` asks whether the ROOT still exists. Windows keeps no record of a
 *   tree once its root has exited, so a descendant that outlives the root is not seen by it.
 * - **Errors.** `taskkill` exits 128 when the pid does not exist, which throws `ESRCH` exactly
 *   as `process.kill` would. Any other failure (access denied, a timeout) throws `EPERM`: the
 *   tree may still be there, and nothing here may claim otherwise.
 */
export function createWin32ProcessLifetime(deps: Win32ProcessLifetimeDeps = win32NodeDeps): ProcessLifetime {
  const signalTree = (pid: number, signal: NodeJS.Signals | 0): void => {
    if (signal === 0) {
      deps.kill(pid, 0);
      return;
    }
    try {
      deps.taskkill(["/PID", String(pid), "/T", "/F"]);
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      throw killError(status === TASKKILL_NOT_FOUND ? "ESRCH" : "EPERM", error);
    }
  };
  return {
    treeRootOptions: Object.freeze({ windowsHide: true }),
    signalTree,
    killTree: killTreeThrough(signalTree),
  };
}

const posix = createPosixProcessLifetime();

/**
 * The platform-selection point. `win32` gets its own implementation; every other platform,
 * macOS and Linux included, resolves to the POSIX one.
 */
const byPlatform: Partial<Record<NodeJS.Platform, ProcessLifetime>> = {
  win32: createWin32ProcessLifetime(),
};

export function processLifetimeFor(platform: NodeJS.Platform): ProcessLifetime {
  return byPlatform[platform] ?? posix;
}

export const processLifetime: ProcessLifetime = processLifetimeFor(process.platform);
