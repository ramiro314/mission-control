import { utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import {
  attachUtilityProcessOutput,
  openPrivateUtilityLog,
  utilityProcessStdio,
} from "./utility-log.ts";
import {
  forkAndInitializeUtilityProcess,
  UtilityProcessInitializationError,
} from "./utility-process-start.ts";

export interface UtilityProcessController {
  stop(): void;
}

export interface UtilityProcessOptions {
  entry: string;
  serviceName: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  onSpawn?: (child: UtilityProcess) => void;
  captureChildOutput?: boolean;
  includeFailureDetails?: boolean;
  /**
   * Asked after an unrequested exit. A string is why this process must not be restarted: it is
   * logged and supervision ends. Null, or a rejection, restarts as usual.
   */
  afterExit?: (code: number) => Promise<string | null>;
}

/**
 * Keep one Electron utility process alive until its owner stops it.
 *
 * The daemon and Foreman have different ownership rules, but once either one is ours their
 * restart, logging, and shutdown mechanics are identical. Keeping that loop here prevents a
 * packaging fix in one process from silently leaving the other with different crash behavior.
 */
export function superviseUtilityProcess(opts: UtilityProcessOptions): UtilityProcessController {
  let child: UtilityProcess | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let restarts = 0;

  const scheduleRestart = (): void => {
    if (stopped) return;
    restarts += 1;
    const delay = Math.min(500 * restarts, 5000);
    restartTimer = setTimeout(spawn, delay);
  };

  const spawn = (): void => {
    restartTimer = null;
    if (stopped) return;

    let log: ReturnType<typeof openPrivateUtilityLog>;
    try {
      log = openPrivateUtilityLog(opts.logPath);
    } catch {
      scheduleRestart();
      return;
    }
    try {
      child = forkAndInitializeUtilityProcess(
        () =>
          utilityProcess.fork(opts.entry, [], {
            serviceName: opts.serviceName,
            stdio: utilityProcessStdio(opts.captureChildOutput),
            env: opts.env,
            cwd: opts.cwd,
          }),
        (spawned) => {
          child = spawned;
          attachUtilityProcessOutput(spawned, log, opts.captureChildOutput);
          spawned.once("exit", (code) => {
            child = null;
            const restart = (): void => {
              log.end(
                stopped
                  ? `[mission-control] ${opts.serviceName} stopped\n`
                  : `[mission-control] ${opts.serviceName} exited with code ${code}; restarting\n`,
              );
              scheduleRestart();
            };
            if (stopped || !opts.afterExit) {
              restart();
              return;
            }
            void opts.afterExit(code).catch(() => null).then((release) => {
              if (release === null || stopped) {
                restart();
                return;
              }
              stopped = true;
              log.end(`[mission-control] ${opts.serviceName} exited with code ${code}; ${release}\n`);
            });
          });
          opts.onSpawn?.(spawned);
        },
      );
    } catch (err) {
      if (err instanceof UtilityProcessInitializationError) {
        if (child === err.child) {
          const details =
            opts.includeFailureDetails === false ? "" : `: ${String(err.cause)}`;
          log.write(
            `[mission-control] ${opts.serviceName} initialization failed${details}; stopping\n`,
          );
        }
        return;
      }
      child = null;
      const details = opts.includeFailureDetails === false ? "" : `: ${String(err)}`;
      log.end(`[mission-control] ${opts.serviceName} failed to start${details}\n`);
      scheduleRestart();
      return;
    }
  };

  spawn();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      child?.kill();
    },
  };
}
