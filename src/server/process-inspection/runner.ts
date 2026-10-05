import { execFileSync } from "node:child_process";
import type { ExecutableId } from "@shared/executables.ts";
import { locateExecutableSync } from "../executables/locator.ts";
import { run, type RunResult } from "../util/exec.ts";

/**
 * How an inspector reaches its commands. Injected so a test can pin the exact argv
 * and options it issues; production resolves both through the executable catalog.
 */
export interface CommandRunner {
  run(
    bin: ExecutableId,
    args: string[],
    opts: { timeoutMs: number; maxBuffer?: number },
  ): Promise<RunResult>;
  /** stdout of a synchronous read, or null when the command is missing or fails. */
  runSync(bin: ExecutableId, args: string[], opts: { timeoutMs: number; maxBuffer: number }): string | null;
}

export const defaultCommandRunner: CommandRunner = {
  run: (bin, args, opts) => run(bin, args, opts),
  runSync(bin, args, opts) {
    try {
      const executable = locateExecutableSync(bin);
      if (!executable) return null;
      return execFileSync(executable.path, args, {
        encoding: "utf8",
        env: executable.env,
        timeout: opts.timeoutMs,
        maxBuffer: opts.maxBuffer,
        // stderr discarded: a dead pid is an ordinary answer here, not something to print.
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      // A non-zero exit means no such process, which is an unreadable answer, not an error.
      return null;
    }
  },
};
