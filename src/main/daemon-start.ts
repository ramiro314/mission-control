// Whether the shell adopts a daemon, waits for one, or supervises its own.
//
// On Linux a systemd user unit (`npm run install-service`) and an autostarted shell both start
// at login. When nothing answers on the port yet, the shell asks systemd before it spawns: a
// unit that is active or still activating owns the daemon, so the shell waits for its health
// and adopts it rather than racing it for the state lock. A daemon that loses that race exits
// with STATE_CONTENTION_EXIT_STATUS, and on Linux the supervisor answers that by deciding again
// instead of restarting. macOS asks no unit and restarts on every exit, as it always has.
//
// Pure apart from the default `systemctl` runner, so the decision is testable on both
// platforms with the health probe and `systemctl` injected.

import { execFile } from "node:child_process";
import type { DaemonCompatibility } from "@shared/daemon-protocol.ts";
import { locateExecutableSync } from "../server/executables/locator.ts";

/** The unit `scripts/install-service.mjs` installs on Linux. */
export const DAEMON_UNIT = "mission-control.service";

/**
 * `src/server/state-ownership.ts` exits with this when another daemon owns the state home.
 * Restated rather than imported so the shell bundle does not pull in the daemon's state code;
 * `test/daemon-start.test.ts` holds the two equal.
 */
export const STATE_CONTENTION_EXIT_STATUS = 75;

export const UNIT_STATE_TIMEOUT_MS = 1_000;
export const UNIT_ADOPT_POLL_MS = 500;
export const UNIT_ADOPT_TIMEOUT_MS = 30_000;

/** `systemctl is-active` states in which the unit owns, or is about to own, the daemon. */
const UNIT_OWNS_DAEMON = new Set(["active", "activating", "reloading"]);

/**
 * - `adopt`: a compatible daemon answers; use it and never stop it.
 * - `incompatible`: a daemon from another build answers.
 * - `supervise`: nothing answers and nothing else will start one; spawn our own.
 * - `unit-unresponsive`: the unit is running but did not answer within the wait.
 */
export type DaemonStart = "adopt" | "incompatible" | "supervise" | "unit-unresponsive";

export interface DaemonStartDeps {
  platform: NodeJS.Platform;
  probe: () => Promise<DaemonCompatibility>;
  /** `systemctl --user is-active` for the unit, trimmed; "" when it cannot be asked. */
  unitState: () => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** Decide from a health probe already taken, asking systemd only on Linux and only when nothing answered. */
export async function decideDaemonStart(
  first: DaemonCompatibility,
  deps: DaemonStartDeps,
): Promise<DaemonStart> {
  if (first === "compatible") return "adopt";
  if (first === "incompatible") return "incompatible";
  if (deps.platform !== "linux") return "supervise";
  if (!UNIT_OWNS_DAEMON.has(await deps.unitState())) return "supervise";
  const deadline = deps.now() + UNIT_ADOPT_TIMEOUT_MS;
  while (deps.now() < deadline) {
    await deps.sleep(UNIT_ADOPT_POLL_MS);
    const compatibility = await deps.probe();
    if (compatibility === "compatible") return "adopt";
    if (compatibility === "incompatible") return "incompatible";
  }
  return "unit-unresponsive";
}

/**
 * What the supervisor does when the daemon it spawned exits. Only a Linux daemon that lost the
 * state lock decides again; anything that decision does not hand back to the shell restarts.
 */
export async function afterDaemonExit(
  platform: NodeJS.Platform,
  code: number,
  decide: () => Promise<DaemonStart>,
): Promise<"restart" | DaemonStart> {
  if (platform !== "linux" || code !== STATE_CONTENTION_EXIT_STATUS) return "restart";
  const start = await decide();
  return start === "supervise" ? "restart" : start;
}

export interface UnitStateDeps {
  locate: () => { path: string; env: NodeJS.ProcessEnv } | null;
  run: (
    executable: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv; timeout: number },
  ) => Promise<string>;
}

const defaultUnitStateDeps: UnitStateDeps = {
  locate: () => locateExecutableSync("systemctl"),
  // `is-active` exits non-zero for every state but active and still prints it, so stdout is
  // read whatever the exit status.
  run: (executable, args, { env, timeout }) =>
    new Promise((resolve) => {
      execFile(executable, args, { encoding: "utf8", env, timeout, killSignal: "SIGKILL" }, (_error, stdout) => {
        resolve(stdout ?? "");
      });
    }),
};

/** `systemctl --user is-active mission-control.service`, bounded at 1 s. A missing `systemctl` or any failure reads as "". */
export function unitStateProbe(overrides: Partial<UnitStateDeps> = {}): () => Promise<string> {
  const deps = { ...defaultUnitStateDeps, ...overrides };
  return async () => {
    try {
      const systemctl = deps.locate();
      if (!systemctl) return "";
      const stdout = await deps.run(systemctl.path, ["--user", "is-active", DAEMON_UNIT], {
        env: systemctl.env,
        timeout: UNIT_STATE_TIMEOUT_MS,
      });
      return stdout.trim().split("\n")[0] ?? "";
    } catch {
      return "";
    }
  };
}
