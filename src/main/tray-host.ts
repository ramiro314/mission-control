// Whether closing the window may hide it. A hidden window is only reachable again through the
// tray, so on Linux it hides only when a StatusNotifier host is there to draw one: KDE has a
// host, stock GNOME does not, and a window hidden there could only be brought back by launching
// a second instance. Anything short of a positive answer quits instead. macOS always has its
// menu bar, so it always hides.

import { execFile } from "node:child_process";
import { locateExecutableSync } from "../server/executables/locator.ts";

export type CloseBehavior = "hide" | "quit";

/** True only when D-Bus says a StatusNotifier host owns its well-known name. */
export type TrayHostProbe = () => Promise<boolean>;

export const TRAY_HOST_PROBE_TIMEOUT_MS = 1_000;

/** `busctl --user call` asking the session bus whether the StatusNotifier watcher has an owner. */
export const TRAY_HOST_PROBE_ARGS = [
  "--user",
  "call",
  "org.freedesktop.DBus",
  "/org/freedesktop/DBus",
  "org.freedesktop.DBus",
  "NameHasOwner",
  "s",
  "org.kde.StatusNotifierWatcher",
] as const;

export interface TrayHostProbeDeps {
  /**
   * The shell's locator snapshot, read without refreshing it: a miss is answered at once
   * instead of waiting on a login-shell probe, so a close never waits longer than the timeout.
   */
  locate: () => { path: string; env: NodeJS.ProcessEnv } | null;
  run: (
    executable: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv; timeout: number },
  ) => Promise<string>;
}

const defaultDeps: TrayHostProbeDeps = {
  locate: () => locateExecutableSync("busctl"),
  run: (executable, args, { env, timeout }) =>
    new Promise((resolve, reject) => {
      execFile(executable, args, { encoding: "utf8", env, timeout, killSignal: "SIGKILL" }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    }),
};

/**
 * Ask D-Bus whether a tray host exists. `b true` is the only yes: `b false`, a `busctl` the
 * locator cannot find, a failed call and one killed at the timeout all answer no.
 */
export function trayHostProbe(overrides: Partial<TrayHostProbeDeps> = {}): TrayHostProbe {
  const deps = { ...defaultDeps, ...overrides };
  return async () => {
    try {
      const busctl = deps.locate();
      if (!busctl) return false;
      const stdout = await deps.run(busctl.path, TRAY_HOST_PROBE_ARGS, {
        env: busctl.env,
        timeout: TRAY_HOST_PROBE_TIMEOUT_MS,
      });
      return stdout.trim() === "b true";
    } catch {
      return false;
    }
  };
}

/** What closing the window does. Only Linux asks, and asks on every close. */
export async function closeBehavior(
  platform: NodeJS.Platform,
  probe: TrayHostProbe,
): Promise<CloseBehavior> {
  if (platform !== "linux") return "hide";
  return (await probe()) ? "hide" : "quit";
}

/** The production probe, through the executable locator's `busctl`. */
export const probeTrayHost = trayHostProbe();
