import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "./config.ts";

/**
 * The cwd every one-shot model run spawns in: headless Claude (print and SDK), both Codex
 * transports, and the Pi model catalog.
 *
 * It is not just where the process runs. Claude derives the directory it writes a run's
 * transcript to from the spawner's cwd, so this value alone decides where they all pile up.
 * The pruner (`goal/prune.ts`) derives that directory from THIS value rather than
 * re-deriving it - the two must never disagree, or the sweep silently cleans an empty
 * directory while the real one grows forever. And every agent reads instruction files
 * (`AGENTS.md`, `CLAUDE.md`) from its cwd, so whoever can write here can steer the run.
 *
 * On Linux that rules out the temp dir. `/tmp` is shared and world-writable, so a planted
 * `/tmp/AGENTS.md` reached every run, and `~/.claude/projects/-tmp/` also holds the
 * transcripts of any session the human started from `/tmp`, which the pruner could not tell
 * apart from ours. A private `headless` dir under the state dir fixes both.
 *
 * On macOS it stays `tmpdir()`, the per-user `$TMPDIR` under `/var/folders`. Moving it would
 * move every macOS transcript to a new encoded project dir and orphan the old ones for no
 * gain. That value is per-process: it follows TMPDIR, so a daemon started from a shell and
 * one started by launchd can write to different directories. Each prunes its own, which is
 * right - neither can know the other's.
 *
 * Pure so both platforms are testable on either.
 */
export function headlessCwdFor(platform: NodeJS.Platform, stateDir: string, tmp = tmpdir()): string {
  return platform === "linux" ? join(stateDir, "headless") : tmp;
}

export const HEADLESS_CWD = headlessCwdFor(process.platform, STATE_DIR);

/**
 * `HEADLESS_CWD`, created on demand. Call this at the spawn rather than reading the constant:
 * the Linux dir does not exist until the first run needs it, and a spawn into a missing cwd
 * fails with an unhelpful `ENOENT`. Owner-only, since its contents steer every run. A no-op
 * on macOS, where the temp dir always exists and is not ours to chmod.
 */
export function ensureHeadlessCwd(cwd = HEADLESS_CWD): string {
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return cwd;
}
