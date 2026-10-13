import { spawn, type ChildProcess } from "node:child_process";
import { XDG_TERMINAL_BIN, terminalVariable } from "./bin.ts";
import { FIXED_OS_EXECUTABLES } from "../executables/catalog.ts";
import {
  locateCommandSync,
  locateExecutableSync,
  type ResolvedExecutable,
} from "../executables/locator.ts";
import { PLAIN_NAMES } from "./names.ts";
import { processLifetime } from "../platform/process-lifetime.ts";
import { prepareGuiSpawn, type PrepareGuiSpawn } from "../graphical-session.ts";
import type { SpawnResult, TabSpec, TerminalEmulator, TerminalResult } from "./types.ts";

/**
 * The Linux desktop's default terminal, whichever one that is.
 *
 * Without WezTerm, Focus and the new-session launcher on Linux had nothing to raise a tmux
 * or Herdr session into, while the desktop already knows which terminal its human uses.
 * Two conventions say which: `xdg-terminal-exec <command>` (the freedesktop proposal, which
 * reads the desktop's preferred terminal list) and the older `$TERMINAL -e <command>`. They
 * are tried in that order, the second only when the first could not start a window.
 *
 * It can open a window and nothing else. There is no portable way to list, address, type
 * into, capture, raise or retitle what an unknown terminal opened, so every one of those
 * capabilities is null and `spawn` returns no target - the multiplexer it attaches to
 * already provides them. That also means Focus cannot find a window this opened: a second
 * Focus on the same session opens a second window, exactly as it does for any terminal the
 * registry cannot list.
 *
 * Linux only, and absent everywhere else rather than greyed out (`hiddenWhereUnsupported`).
 * It never hosts a dispatched agent (`raiseOnly`): an agent in a window nothing can address
 * could be neither messaged, interrupted, nor found again after a restart.
 */

/** How long a launcher has to refuse before the window counts as open. */
export const XDG_TERMINAL_SETTLE_MS = 1_000;

/** A resolved command, plus the arguments that come before the command it should run. */
export interface XdgTerminalLauncher {
  name: string;
  path: string;
  env: NodeJS.ProcessEnv;
  prefix: readonly string[];
}

/**
 * Start a GUI process and let it go. Its exit is awaited only for `settleMs`: a launcher
 * that refuses (no terminal configured, a missing command) does so at once, while a
 * terminal that opened its window keeps running for as long as the window is open.
 */
export type DetachedLaunch = (
  launcher: XdgTerminalLauncher,
  args: readonly string[],
  opts: { cwd: string | null; settleMs: number },
) => Promise<TerminalResult>;

export interface XdgTerminalDeps {
  /** The launchers that resolve right now, in the order they are tried. */
  launchers: () => readonly XdgTerminalLauncher[];
  launch: DetachedLaunch;
  settleMs: number;
  /** The display environment and scope every launcher runs in (`graphical-session.ts`). */
  prepareGui: PrepareGuiSpawn;
}

function launcher(
  name: string,
  resolved: ResolvedExecutable | null,
  prefix: readonly string[],
): XdgTerminalLauncher | null {
  return resolved ? { name, path: resolved.path, env: resolved.env, prefix } : null;
}

/** `xdg-terminal-exec`, then `$TERMINAL -e`, each only when it resolves. */
export function xdgTerminalLaunchers(
  env: NodeJS.ProcessEnv = process.env,
  resolve: {
    xdgTerminalExec: () => ResolvedExecutable | null;
    command: (command: string) => ResolvedExecutable | null;
  } = {
    xdgTerminalExec: () => locateExecutableSync("xdg-terminal-exec"),
    command: locateCommandSync,
  },
): XdgTerminalLauncher[] {
  const terminal = terminalVariable(env);
  return [
    launcher("xdg-terminal-exec", resolve.xdgTerminalExec(), []),
    terminal ? launcher(`$TERMINAL (${terminal})`, resolve.command(terminal), ["-e"]) : null,
  ].filter((entry): entry is XdgTerminalLauncher => entry !== null);
}

export const launchDetached: DetachedLaunch = (launcher, args, opts) =>
  new Promise((resolve) => {
    let child: ChildProcess;
    // Resolved through the shared locator before it gets here: the launcher itself, or the
    // `systemd-run` that scopes it.
    const executable = launcher.path;
    try {
      // The root of its own process tree, so the window outlives a daemon restart, and no
      // pipes the daemon would have to keep draining. The tree options come from the
      // platform seam, which owns how a platform expresses one.
      child = spawn(executable, [...launcher.prefix, ...args], {
        ...processLifetime.treeRootOptions,
        stdio: "ignore",
        env: launcher.env,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      });
    } catch (error) {
      resolve({ ok: false, error: `${launcher.name}: ${(error as Error).message}`, outcomeUnknown: false });
      return;
    }
    const settle = (result: TerminalResult): void => {
      clearTimeout(timer);
      child.removeAllListeners();
      // A late error from a process we already let go has nobody left to tell.
      child.on("error", () => {});
      child.unref();
      resolve(result);
    };
    const timer = setTimeout(() => settle({ ok: true, outcomeUnknown: false }), opts.settleMs);
    child.on("error", (error) => {
      settle({ ok: false, error: `${launcher.name}: ${error.message}`, outcomeUnknown: false });
    });
    child.on("exit", (code, signal) => {
      // A launcher handing the window to a running terminal server exits 0 at once.
      if (code === 0) settle({ ok: true, outcomeUnknown: false });
      else if (signal) settle({ ok: false, error: `${launcher.name} was killed by ${signal}`, outcomeUnknown: true });
      else settle({ ok: false, error: `${launcher.name} exited with status ${code}`, outcomeUnknown: false });
    });
  });

/**
 * The argv a terminal runs, rooted in `cwd` when one is asked for.
 *
 * Through `sh` rather than the spawn's own `cwd` alone, because a terminal that hands the
 * window to a running server (gnome-terminal, `kitty --single-instance`) starts the command
 * in the SERVER's directory. `TabSpec.cwd` says an emulator must not open a launch anywhere
 * else, and `cd` failing ends the command rather than running it in the wrong place.
 */
export function rootedArgv(argv: readonly string[], cwd: string | null): readonly string[] {
  if (!cwd) return argv;
  return [FIXED_OS_EXECUTABLES.sh, "-c", 'cd -- "$1" && shift && exec "$@"', "sh", cwd, ...argv];
}

const defaultDeps: XdgTerminalDeps = {
  launchers: () => xdgTerminalLaunchers(),
  launch: launchDetached,
  settleMs: XDG_TERMINAL_SETTLE_MS,
  prepareGui: prepareGuiSpawn,
};

export function xdgTerminalEmulator(deps: XdgTerminalDeps = defaultDeps): TerminalEmulator {
  return {
    id: "xdg-terminal",
    label: "Default terminal",
    // A plain window outline: whatever terminal the desktop chose, not a particular one.
    glyph: "□",
    bin: XDG_TERMINAL_BIN,
    hiddenWhereUnsupported: true,
    // Focus and the new-session launcher only: it raises tmux and Herdr sessions, which keep
    // the agent reachable, and never becomes a dispatched agent's home on its own.
    raiseOnly: true,
    list: null,
    hostProcess: null,
    write: null,
    capture: null,
    focus: null,
    restoreTarget: null,
    retitle: null,
    spawn: {
      async tab(spec: TabSpec): Promise<SpawnResult> {
        const argv = rootedArgv(spec.argv, spec.cwd);
        const refusals: string[] = [];
        for (const entry of deps.launchers()) {
          // No display is the same answer for every launcher, so it ends the attempt here.
          const prepared = await deps.prepareGui(entry.path, [...entry.prefix, ...argv], entry.env);
          if (!prepared.ok) return { ok: false, error: prepared.error, outcomeUnknown: false, target: null };
          const result = await deps.launch(
            { ...entry, path: prepared.bin, env: prepared.env, prefix: [] },
            prepared.args,
            { cwd: spec.cwd, settleMs: deps.settleMs },
          );
          // An unknown outcome may be an open window; trying the next launcher could open a
          // second one, so it is reported rather than retried.
          if (result.ok || result.outcomeUnknown) return { ...result, target: null };
          refusals.push(result.error ?? `${entry.name} could not open a window`);
        }
        return {
          ok: false,
          error: refusals.length
            ? refusals.join("; ")
            : (XDG_TERMINAL_BIN.missingReason ?? "No default terminal found"),
          outcomeUnknown: false,
          target: null,
        };
      },
    },
    // `spawn` is handed a title; nothing here can show it, and nothing reads it back.
    names: PLAIN_NAMES,
  };
}
