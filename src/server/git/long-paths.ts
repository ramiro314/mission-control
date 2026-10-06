import { setTimeout as delay } from "node:timers/promises";

import { hostPlatform } from "../platform/host.ts";
import { run, type RunResult } from "../util/exec.ts";

/** Writes attempted while another add holds `config.lock`, with a linear backoff between them. */
const LOCK_ATTEMPTS = 5;
const LOCK_BACKOFF_MS = 50;

/** Whether a repository is ready for long-path worktrees, decided once for every caller. */
export type LongPathsOutcome = { ok: true } | { ok: false; reason: string; outcomeUnknown: boolean };

/**
 * On win32, make sure a repository has `core.longpaths=true` before Mission Control adds a
 * worktree to it (D24 in `docs/plans/windows-support/plan.md`).
 *
 * Set in the repository's shared config rather than per worktree: the checkout that
 * `git worktree add` performs needs it already, and so does every git command a session later
 * runs in that worktree. Without it, Git for Windows refuses paths over 260 characters even
 * when the `LongPathsEnabled` registry value is on.
 *
 * Mission Control adds several worktrees to one repository at once (ensemble members, pool
 * slots, check attempts), and `git config` rewrites the file under `config.lock` without
 * waiting for a lock someone else holds. So the value is read first and never rewritten once
 * it is true, and a write that loses the lock re-reads the value - the winner may have just
 * set it - and retries briefly before it is reported as failed.
 *
 * Returns null without running anything on any other host. Otherwise it returns the verdict, so
 * every caller agrees on what failed: a failure carries the reason to report and whether the
 * write's outcome is unknown.
 */
export async function enableWorktreeLongPaths(
  repoRoot: string,
  execute: typeof run = run,
  platform: NodeJS.Platform = hostPlatform(),
): Promise<LongPathsOutcome | null> {
  if (platform !== "win32") return null;
  const read = () => execute("git", ["-C", repoRoot, "config", "--bool", "--get", "core.longpaths"], { timeoutMs: 10_000 });
  const enabled = (result: RunResult) => !failed(result) && result.stdout.trim() === "true";

  if (enabled(await read())) return { ok: true };
  for (let attempt = 1; ; attempt++) {
    const written = await execute("git", ["-C", repoRoot, "config", "core.longpaths", "true"], { timeoutMs: 10_000 });
    if (!failed(written)) return { ok: true };
    if (enabled(await read())) return { ok: true };
    if (attempt >= LOCK_ATTEMPTS || !/could not lock config file/i.test(written.stderr)) {
      return {
        ok: false,
        reason: `git config core.longpaths failed: ${written.stderr.trim() || `exit ${written.code}`}`,
        outcomeUnknown: written.outcomeUnknown,
      };
    }
    await delay(attempt * LOCK_BACKOFF_MS);
  }
}

function failed(result: RunResult): boolean {
  return result.code !== 0 || result.outcomeUnknown || result.overflowed;
}
