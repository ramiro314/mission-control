import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { processInspector } from "../process-inspection/index.ts";
import { pathContains, type WorktreeOccupancy, type WorktreeOccupant } from "./occupancy.ts";

/** How old a lock must be before the automatic pass treats it as abandoned. */
export const INDEX_LOCK_STALE_MS = 10 * 60_000;

/**
 * Git's own refusal text when another index writer's lock is in place. It has read the same
 * since Git 1.x, so a quarantine recorded by any earlier build qualifies with no migration.
 */
const INDEX_LOCK_REFUSAL = /Unable to create '[^']*index\.lock': File exists/;

/** Whether a quarantined slot's recorded error is Git refusing over an existing `index.lock`. */
export function lockCausedQuarantine(lastError: string | null): boolean {
  return lastError !== null && INDEX_LOCK_REFUSAL.test(lastError);
}

/** The command line of a Git process: `git` itself, by name or path, or one of its helpers. */
export function isGitProcess(command: string): boolean {
  const program = command.trim().split(/\s+/, 1)[0] ?? "";
  return /(^|\/)git(-[\w-]+)?$/.test(program);
}

/** Every pid holding one file open, or null when that could not be read. */
export type FileHolders = (path: string) => Promise<number[] | null>;

export const defaultFileHolders: FileHolders = async (path) =>
  (await processInspector().findFileHolders(path)).pids;

/**
 * The linked worktree's own Git directory, read from its `.git` file, or null when that file is
 * not one or names a directory outside `<common>/worktrees/`. Only a path this proves is ever a
 * lock Recover may remove.
 */
export async function slotGitDirectory(slotPath: string, commonDirectory: string): Promise<string | null> {
  try {
    const dotGit = join(slotPath, ".git");
    const stat = await lstat(dotGit);
    if (!stat.isFile()) return null;
    const match = /^gitdir: (.+)$/m.exec(await readFile(dotGit, "utf8"));
    if (!match) return null;
    const gitDirectory = resolve(slotPath, match[1]!.trim());
    const worktrees = join(commonDirectory, "worktrees");
    return pathContains(worktrees, gitDirectory) && gitDirectory !== worktrees ? gitDirectory : null;
  } catch {
    return null;
  }
}

/** What Recover needs to know about a slot's `index.lock` before it may remove it. */
export interface SlotIndexLock {
  /** Null when the slot's Git directory could not be proven. */
  path: string | null;
  exists: boolean;
  /** Since the lock was last modified; null when there is none. */
  ageMs: number | null;
  /** Git processes whose working directory is in the slot; null when occupancy is unknown. */
  gitProcesses: WorktreeOccupant[] | null;
  /** Pids holding the lock open; empty when there is no lock, null when `lsof` could not tell. */
  holders: number[] | null;
}

export async function inspectSlotIndexLock(input: {
  slotPath: string;
  commonDirectory: string;
  occupancy: WorktreeOccupancy | undefined;
  now: number;
  fileHolders: FileHolders;
}): Promise<SlotIndexLock> {
  const gitProcesses = input.occupancy?.status === "known"
    ? input.occupancy.occupants.filter((occupant) => isGitProcess(occupant.command))
    : null;
  const gitDirectory = await slotGitDirectory(input.slotPath, input.commonDirectory);
  if (!gitDirectory) return { path: null, exists: false, ageMs: null, gitProcesses, holders: null };
  const path = join(gitDirectory, "index.lock");
  const stat = await lstat(path).catch(() => null);
  if (!stat) return { path, exists: false, ageMs: null, gitProcesses, holders: [] };
  let holders: number[] | null;
  try {
    holders = await input.fileHolders(path);
  } catch {
    holders = null;
  }
  return { path, exists: true, ageMs: Math.max(0, input.now - stat.mtimeMs), gitProcesses, holders };
}

/**
 * Why `index.lock` may not be removed now, or null when it may (or there is none). The
 * automatic pass also waits until the lock is `INDEX_LOCK_STALE_MS` old; Recover does not,
 * because the operator has read the preview that names the lock.
 */
export function indexLockBlocker(lock: SlotIndexLock, automatic: boolean): string | null {
  if (lock.path === null) return "the slot's Git directory could not be proven, so its index.lock cannot be located";
  if (!lock.exists) return null;
  if (lock.gitProcesses === null) return "process occupancy is unknown, so a Git process may still be using the worktree";
  if (lock.gitProcesses.length > 0) {
    const [first] = lock.gitProcesses;
    return `a Git process is using the worktree (pid ${first!.pid}: ${first!.command})`;
  }
  if (lock.holders === null) return "lsof could not tell whether a process holds index.lock";
  if (lock.holders.length > 0) return `index.lock is held open by pid ${lock.holders.join(", ")}`;
  if (automatic && (lock.ageMs ?? 0) < INDEX_LOCK_STALE_MS) return "index.lock is younger than 10 minutes";
  return null;
}
