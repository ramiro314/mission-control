// Daemon supervisor.
//
// The daemon is the same Node server the web app has always used. Here it runs
// as an Electron `utilityProcess` (a real Node runtime outside the renderer
// sandbox) executing the esbuild bundle at dist/server/index.mjs. `node:sqlite`
// works under Electron's bundled Node (verified on Electron 43 / Node 24), so
// nothing about the daemon changes.
//
// Adopt-or-spawn: if a daemon already answers on the port (a LaunchAgent, a systemd
// unit or `make up`), we adopt it and never spawn a second one that would fight over
// the port. On Linux a unit that is still starting is waited for rather than raced
// (see daemon-start.ts). We only supervise/stop a daemon we started. Development does
// not call this supervisor; `dev:server` owns that daemon lifecycle.

import { setTimeout as delay } from "node:timers/promises";
import { BASE_URL, PORT } from "@shared/harness-runtime.mjs";
import { migrationPortOccupied } from "../../scripts/migration-runtime.mjs";
import {
  DAEMON_PROTOCOL_CAPABILITIES,
  daemonHealthCompatibility,
  type DaemonCompatibility,
} from "@shared/daemon-protocol.ts";
import { executableChildEnv } from "../server/executables/locator.ts";
import { serveProductIssueAuthorization } from "./product-issue-authorization.ts";
import { serveSessionControlAuthorization } from "./session-control-authorization.ts";
import { superviseUtilityProcess } from "./utility-supervisor.ts";
import {
  afterDaemonExit,
  decideDaemonStart,
  unitStateProbe,
  type DaemonStartDeps,
} from "./daemon-start.ts";

export interface DaemonController {
  /** True when an existing daemon was reused rather than spawned by us. */
  adopted: boolean;
  stop: () => void;
}

const HEALTH_URL = `${BASE_URL}/api/health`;
const REQUIRED_DAEMON_CAPABILITY =
  DAEMON_PROTOCOL_CAPABILITIES.daemonExecutableEnvironment;

/**
 * One health probe that distinguishes an absent daemon from an older running daemon.
 * Treating both as merely unhealthy would make Electron spawn into an occupied port.
 */
export async function daemonCompatibility(timeoutMs = 800, signal?: AbortSignal): Promise<DaemonCompatibility> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(HEALTH_URL, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) return "unreachable";
    return daemonHealthCompatibility(await res.json() as unknown, REQUIRED_DAEMON_CAPABILITY);
  } catch {
    return "unreachable";
  }
}

/** True only when the daemon is healthy and speaks this desktop build's wire contract. */
export async function daemonHealthy(timeoutMs = 800, signal?: AbortSignal): Promise<boolean> {
  return await daemonCompatibility(timeoutMs, signal) === "compatible";
}

export interface StartDaemonOptions {
  /** Absolute path to the bundled server entry (dist/server/index.mjs). */
  serverEntry: string;
  /** A committed relocation must start its own assets, never adopt the old daemon. */
  requireFresh?: boolean;
  /** Absolute path to the built web UI the daemon should serve. */
  webDir: string;
  /** Where to append the daemon's stdout/stderr. */
  logPath: string;
  /** Linux: the systemd unit is running but did not answer health within the wait. */
  onUnitUnresponsive?: () => void;
}

const INCOMPATIBLE_DAEMON =
  "A running Mission Control daemon is from an older build. Stop it before opening this version.";

/**
 * Adopt a running daemon, or spawn + supervise our own. The spawned daemon is
 * restarted with capped backoff if it exits unexpectedly, and torn down on
 * `stop()`. Its env carries the resolved login-shell PATH (so it can find
 * tmux/wezterm/git) and MISSION_WEB_DIR.
 */
export async function startDaemon(opts: StartDaemonOptions): Promise<DaemonController> {
  const compatibility = await daemonCompatibility();
  if (opts.requireFresh && (compatibility !== "unreachable" || await migrationPortOccupied(PORT))) throw new Error("A previous daemon is still running. Stop it, then reopen the personal app.");
  const deps: DaemonStartDeps = {
    platform: process.platform,
    probe: () => daemonCompatibility(),
    unitState: unitStateProbe(),
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
  };
  const start = await decideDaemonStart(compatibility, deps);
  if (start === "incompatible") throw new Error(INCOMPATIBLE_DAEMON);
  if (start === "unit-unresponsive") opts.onUnitUnresponsive?.();
  if (start !== "supervise") return { adopted: true, stop: () => {} };

  const controller = superviseUtilityProcess({
    entry: opts.serverEntry,
    serviceName: "mission-control-daemon",
    logPath: opts.logPath,
    env: executableChildEnv({ ...process.env, MISSION_WEB_DIR: opts.webDir }),
    // A Report click is armed in the shell over IPC and consumed here over the private
    // utility-process port. A loopback caller has access to neither side of that handoff.
    onSpawn: (child) => {
      serveProductIssueAuthorization(child);
      serveSessionControlAuthorization(child);
    },
    // Linux: a daemon that lost the state lock to another one (a unit, `make up`) is not
    // restarted into the same contention; the shell decides again and adopts the owner.
    afterExit: process.platform === "linux"
      ? async (code) => {
        const next = await afterDaemonExit(process.platform, code, async () =>
          decideDaemonStart(await deps.probe(), deps));
        if (next === "restart") return null;
        if (next === "unit-unresponsive") opts.onUnitUnresponsive?.();
        return next === "incompatible"
          ? "another daemon from an older build owns this state; not restarting"
          : "another daemon owns this state; adopting it";
      }
      : undefined,
  });
  return {
    adopted: false,
    stop: () => controller.stop(),
  };
}
