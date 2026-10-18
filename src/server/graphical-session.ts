import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { locateExecutableSync } from "./executables/locator.ts";
import { run } from "./util/exec.ts";

// How the daemon starts a program that has to outlive it, on Linux.
//
// Two problems, one per half of this file, and both are invisible from a terminal:
//
//   - **A display.** A daemon started by the systemd user manager (the unit) carries no display
//     variables, and one started from a desktop session keeps the ones it was born with, which go
//     stale after a re-login. Every GUI program the daemon spawns takes its display from
//     `graphicalSessionEnv` instead of from whatever the daemon inherited.
//   - **A cgroup of its own.** Whatever the daemon spawns lands in the daemon's cgroup: the unit's
//     under systemd, the terminal's scope under `make start`. Stopping either kills every process
//     in it, so a daemon restart would take the tmux and Herdr servers, their agents, and every
//     window Focus opened down with it. `inUserScope` moves each into its own transient scope in
//     `app.slice`, where desktop launchers put applications.
//
// Both are Linux-only and leave every other platform's spawn exactly as it was. They are not a
// platform seam with a per-platform row: there is one platform that needs them and no second
// answer to select between.
//
// WezTerm goes through both at its one call that opens something, `wezterm cli spawn`. That CLI
// asks an already-running GUI over its socket and exits, so the tab itself belongs to the GUI's
// process tree. It takes the display set and the scope when there is a display, and is the one
// spawn that does not refuse without one: the GUI that answered the socket is the display.

/** The display variables a GUI program needs, always taken together from one source. */
export const GRAPHICAL_SESSION_VARIABLES = [
  "WAYLAND_DISPLAY",
  "DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
] as const;

export const NO_GRAPHICAL_SESSION =
  "No graphical session is reachable from the Mission Control daemon: neither the daemon nor " +
  "the systemd user manager has a WAYLAND_DISPLAY or DISPLAY whose socket exists. Log in to a " +
  "desktop session, or start the daemon from one.";

/** How long the user manager has to print its environment. It answers locally, at once. */
const MANAGER_ENVIRONMENT_TIMEOUT_MS = 2000;

export interface GraphicalSessionDeps {
  platform: NodeJS.Platform;
  /** The daemon's own environment. */
  env: NodeJS.ProcessEnv;
  /** The systemd user manager's current environment, or null when it cannot be read. */
  managerEnvironment(): Promise<NodeJS.ProcessEnv | null>;
  /** Whether a socket exists at `path`. */
  socketExists(path: string): boolean;
}

export type GraphicalSession =
  | { ok: true; env: NodeJS.ProcessEnv }
  | { ok: false; error: string };

/** `KEY=VALUE` lines, as `systemctl --user show-environment` prints them. */
export function parseManagerEnvironment(stdout: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    // systemd quotes a value only when it holds characters a display variable never does, so
    // the values read here are literal.
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

async function readManagerEnvironment(): Promise<NodeJS.ProcessEnv | null> {
  const systemctl = locateExecutableSync("systemctl")?.path;
  if (!systemctl) return null;
  const result = await run(systemctl, ["--user", "show-environment"], {
    timeoutMs: MANAGER_ENVIRONMENT_TIMEOUT_MS,
  });
  return result.code === 0 ? parseManagerEnvironment(result.stdout) : null;
}

/** Whether a socket exists at `path`. Exported for `platform/session-scope.ts`. */
export function socketExists(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

const defaultDeps: GraphicalSessionDeps = {
  platform: process.platform,
  env: process.env,
  managerEnvironment: readManagerEnvironment,
  socketExists,
};

/**
 * Whether `source` names a display that is still there. A dead display counts as absent, so a
 * source left over from an ended session is skipped instead of handing a client a socket that
 * refuses it.
 */
function hasLiveDisplay(
  source: NodeJS.ProcessEnv,
  runtimeDir: string | undefined,
  exists: (path: string) => boolean,
): boolean {
  const wayland = source.WAYLAND_DISPLAY?.trim();
  if (wayland) {
    const path = isAbsolute(wayland) ? wayland : runtimeDir ? join(runtimeDir, wayland) : null;
    if (path && exists(path)) return true;
  }
  const display = source.DISPLAY?.trim();
  if (display) {
    const local = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display);
    if (local) return exists(`/tmp/.X11-unix/X${local[1]}`);
    // A remote `host:N` display has no local socket to check, so it is taken as present.
    if (/^[^:\s]+:\d+(?:\.\d+)?$/.test(display)) return true;
  }
  return false;
}

/**
 * `base` with its display variables replaced by one live source's, or the named refusal.
 *
 * The two sources are the user manager's current environment and the daemon's own. Under the
 * manager (systemd sets `INVOCATION_ID` for the unit) the manager's comes first: the unit
 * inherited the manager's values when it started, and only the manager learns about a later
 * login. Outside it (`make start`) the daemon's own comes first. The six variables always come
 * from the one source chosen, never mixed, so a stale `XAUTHORITY` cannot pair with a live
 * `DISPLAY`.
 *
 * Read at every spawn rather than once, which also covers a unit that started before the
 * desktop imported its environment into the manager.
 */
export async function graphicalSessionEnv(
  base: NodeJS.ProcessEnv,
  deps: GraphicalSessionDeps = defaultDeps,
): Promise<GraphicalSession> {
  if (deps.platform !== "linux") return { ok: true, env: base };
  const own = async () => deps.env;
  const manager = () => deps.managerEnvironment();
  const sources = deps.env.INVOCATION_ID ? [manager, own] : [own, manager];
  for (const read of sources) {
    const source = await read();
    if (!source) continue;
    const runtimeDir = source.XDG_RUNTIME_DIR ?? deps.env.XDG_RUNTIME_DIR;
    if (!hasLiveDisplay(source, runtimeDir, deps.socketExists)) continue;
    const env = { ...base };
    for (const key of GRAPHICAL_SESSION_VARIABLES) {
      if (source[key] === undefined) delete env[key];
      else env[key] = source[key];
    }
    return { ok: true, env };
  }
  return { ok: false, error: NO_GRAPHICAL_SESSION };
}

export interface ScopedCommand {
  bin: string;
  args: string[];
}

/** Wrap a command so the process it starts runs in a transient scope of its own. */
export type ScopeCommand = (bin: string, args: readonly string[], env: NodeJS.ProcessEnv) => ScopedCommand;

export interface UserScopeDeps {
  platform: NodeJS.Platform;
  /** The absolute `systemd-run`, or null when it does not resolve. */
  systemdRun(): string | null;
  socketExists(path: string): boolean;
}

/**
 * Whether a systemd user manager is there to create a scope for `env`. `systemd-run --scope`
 * refuses, and runs nothing, when it is not, so wrapping anyway would turn a spawn that works
 * into one that fails.
 *
 * A session bus alone does not prove it: a container's `dbus-launch` bus, or a shell that
 * inherited another user's address, has one with no manager behind it. The manager's own
 * socket does: `systemd --user` listens on `$XDG_RUNTIME_DIR/systemd/private` for as long as
 * it runs, and another user's runtime directory is mode 0700, so it cannot be seen from here.
 * `--scope` then reaches the manager over the session bus, which has to be there too.
 *
 * Exported for `platform/session-scope.ts`, which asks the same question before it puts an
 * agent session in a scope of its own.
 */
export function userManagerReachable(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): boolean {
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (!runtimeDir || !exists(join(runtimeDir, "systemd", "private"))) return false;
  return Boolean(env.DBUS_SESSION_BUS_ADDRESS?.trim()) || exists(join(runtimeDir, "bus"));
}

/**
 * A `ScopeCommand` that runs `bin` under `systemd-run --user --scope` in `app.slice`, so the
 * process and everything it forks (a tmux server, a terminal window, a browser) leave the
 * daemon's cgroup and survive the daemon's restart. `--scope` runs the command in this process
 * rather than handing it to the manager, so its stdout, exit status and environment reach the
 * caller exactly as an unwrapped spawn's would. Each call gets its own auto-named scope.
 *
 * Without `systemd-run`, or a user manager to create the scope, the command is returned as it
 * was, and starts as it always did.
 */
export function userScope(deps: UserScopeDeps): ScopeCommand {
  return (bin, args, env) => {
    if (deps.platform !== "linux") return { bin, args: [...args] };
    const systemdRun = deps.systemdRun();
    if (!systemdRun || !userManagerReachable(env, deps.socketExists)) return { bin, args: [...args] };
    return {
      bin: systemdRun,
      args: ["--user", "--scope", "--quiet", "--collect", "--slice=app.slice", "--", bin, ...args],
    };
  };
}

/** The production scope wrapper. */
export const inUserScope: ScopeCommand = userScope({
  platform: process.platform,
  systemdRun: () => locateExecutableSync("systemd-run")?.path ?? null,
  socketExists,
});

/** A scope wrapper that wraps nothing: every non-Linux spawn, and tests that assert raw argv. */
export const unscoped: ScopeCommand = (bin, args) => ({ bin, args: [...args] });

export type PreparedGuiSpawn = ({ ok: true; env: NodeJS.ProcessEnv } & ScopedCommand) | { ok: false; error: string };

/**
 * Everything a GUI spawn needs before it starts: the display environment, then the scope.
 * Every GUI program the daemon starts goes through one of these.
 */
export type PrepareGuiSpawn = (
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<PreparedGuiSpawn>;

export function guiSpawn(
  graphical: GraphicalSessionDeps,
  scope: ScopeCommand,
): PrepareGuiSpawn {
  return async (bin, args, env) => {
    const session = await graphicalSessionEnv(env, graphical);
    if (!session.ok) return session;
    return { ok: true, env: session.env, ...scope(bin, args, session.env) };
  };
}

/** The production GUI spawn preparation. */
export const prepareGuiSpawn: PrepareGuiSpawn = guiSpawn(defaultDeps, inUserScope);

/** A preparation that changes nothing: tests that assert the raw argv and environment. */
export const unpreparedGuiSpawn: PrepareGuiSpawn = async (bin, args, env) => ({
  ok: true,
  env,
  bin,
  args: [...args],
});
