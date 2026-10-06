import { hostPlatform } from "../platform/host.ts";
import { run, type RunResult } from "../util/exec.ts";

/**
 * On win32, set `core.longpaths=true` in a repository before Mission Control adds a worktree
 * to it (D24 in `docs/plans/windows-support/plan.md`).
 *
 * Set in the repository's shared config rather than per worktree: the checkout that
 * `git worktree add` performs needs it already, and so does every git command a session later
 * runs in that worktree. Without it, Git for Windows refuses paths over 260 characters even
 * when the `LongPathsEnabled` registry value is on. Idempotent, so every add repeats it.
 *
 * Returns null without running anything on any other host.
 */
export async function enableWorktreeLongPaths(
  repoRoot: string,
  execute: typeof run = run,
  platform: NodeJS.Platform = hostPlatform(),
): Promise<RunResult | null> {
  if (platform !== "win32") return null;
  return execute("git", ["-C", repoRoot, "config", "core.longpaths", "true"], { timeoutMs: 10_000 });
}
