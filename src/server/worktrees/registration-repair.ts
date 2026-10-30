import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { canonical, type WorktreeRegistration } from "./git.ts";
import { slotGitDirectory } from "./index-lock.ts";
import { interruptedPruneQuarantine, REGISTRATION_OR_IDENTITY } from "./quarantine-reasons.ts";

/**
 * Git's own fixes for a slot's registration, the only ones that run without an operator:
 * - `repairGitFile`: `git worktree repair`, for a `.git` file that is missing or wrong while an
 *   administrative directory still names this path;
 * - `repairPath`: `git worktree repair <path>`, for a `.git` file that names an administrative
 *   directory whose `gitdir` names a folder that is gone;
 * - `unlock`: `git worktree unlock`, for the `initializing` lock of an interrupted `worktree add`.
 */
export type RegistrationFix = "repairGitFile" | "repairPath" | "unlock";

export type RegistrationDiagnosis =
  | { status: "healthy" }
  | { status: "fixable"; fixes: RegistrationFix[] }
  /** `elsewhere`: the slot's `.git` names a registration that belongs to another checkout. */
  | { status: "refused"; reason: string; elsewhere?: boolean };

/**
 * What `git worktree add` writes to `locked` while it runs, under the `LANGUAGE=C` this daemon
 * adds with. Git translates it otherwise, and a translated lock cannot be told from an operator's
 * reason, so anything else is left alone.
 */
const INTERRUPTED_ADD_LOCK = "initializing";

/** The `.git` path an administrative directory's `gitdir` file names, or null when it names none. */
async function recordedDotGit(administrative: string): Promise<string | null> {
  try {
    const recorded = (await readFile(join(administrative, "gitdir"), "utf8")).trim();
    if (!recorded) return null;
    // Relative under `worktree.useRelativePaths`, and spelled as written, so a symlinked parent
    // is resolved before it is compared.
    const path = resolve(administrative, recorded);
    return join(await canonical(dirname(path)), basename(path));
  } catch {
    return null;
  }
}

async function administrativeDirectories(commonDirectory: string): Promise<string[]> {
  const worktrees = join(commonDirectory, "worktrees");
  return (await readdir(worktrees).catch(() => [] as string[])).map((name) => join(worktrees, name));
}

/** The contents of a registration's `locked` file, or null when it is not locked. */
async function lockReason(administrative: string): Promise<string | null> {
  try {
    return (await readFile(join(administrative, "locked"), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Which of Git's fixes this slot needs, read from the same files Git reads and changing nothing.
 * Everything else refuses: a bare or operator-locked registration, a folder that is gone, a
 * `.git` that is not a file, and a registration no administrative directory can be traced to,
 * which only re-registering the folder could answer.
 */
export async function diagnoseRegistration(input: {
  slotPath: string;
  commonDirectory: string;
  registration: WorktreeRegistration | null;
}): Promise<RegistrationDiagnosis> {
  const { slotPath, commonDirectory, registration } = input;
  const refused = (reason: string): RegistrationDiagnosis => ({ status: "refused", reason });
  if (registration?.bare) return refused("Git lists this path as a bare repository");
  const folder = await lstat(slotPath).catch(() => null);
  if (!folder?.isDirectory()) return refused("the slot's folder is gone, so Git has nothing to repair");
  const dotGitPath = join(slotPath, ".git");
  const dotGit = await lstat(dotGitPath).catch(() => null);
  if (dotGit && !dotGit.isFile()) return refused("the slot's .git is not a file, and Git repairs only a .git file");

  const directories = await administrativeDirectories(commonDirectory);
  const recorded = await Promise.all(directories.map(recordedDotGit));
  const naming = directories.filter((_, index) => recorded[index] === dotGitPath);
  if (naming.length > 1) return refused("more than one Git registration names this path");

  const pointed = await slotGitDirectory(slotPath, commonDirectory);
  const fixes: RegistrationFix[] = [];
  let administrative: string;
  if (naming.length === 1) {
    administrative = naming[0]!;
    if (pointed !== administrative) fixes.push("repairGitFile");
  } else {
    if (!pointed || !directories.includes(pointed)) {
      return refused("no Git registration names this path, so it has to be registered again");
    }
    // The folder, not its `.git`: a checkout that lost only that file is still the one registered.
    const elsewhere = recorded[directories.indexOf(pointed)];
    if (elsewhere && (await lstat(dirname(elsewhere)).catch(() => null))) {
      return { status: "refused", reason: `the slot's Git registration names ${dirname(elsewhere)}, which still exists`, elsewhere: true };
    }
    administrative = pointed;
    fixes.push("repairPath");
  }

  let locked: string | null;
  try {
    locked = await lockReason(administrative);
  } catch (error) {
    return refused(`the registration's lock could not be read: ${String(error)}`);
  }
  if (locked === INTERRUPTED_ADD_LOCK) fixes.push("unlock");
  else if (locked !== null) {
    return refused(`the registration is locked${locked ? ` (${locked})` : ""}, and only Git's own initializing lock is cleared here`);
  }
  if (fixes.length > 0) return { status: "fixable", fixes };
  return registration && !registration.prunable && !registration.locked
    ? { status: "healthy" }
    : refused("Git lists the registration as unsafe, and none of its own fixes applies");
}

/**
 * Why Forget is this slot's way out, or null when it is not: the cases Repair refuses or cannot
 * prove a result for. A registration that is gone while its folder remains is not one of them,
 * because registering it again keeps the install. These are read from the slot as it stands, not
 * only from its reason: a quarantine keeps its first reason, whatever happens to the folder later.
 * `registration` is undefined when Git's listing could not be read, which proves nothing about it.
 */
export async function forgetCause(input: {
  slotPath: string;
  quarantineReason: string | null;
  commonDirectory: string;
  registration: WorktreeRegistration | null | undefined;
  inspection: { path: string; commonDirectory: string } | null;
}): Promise<string | null> {
  const { slotPath, quarantineReason, commonDirectory, registration, inspection } = input;
  // Only the repository itself is listed as bare, and that is never Forget's to delete.
  if (registration?.bare) return null;
  const folder = await lstat(slotPath).catch(() => null);
  if (!folder?.isDirectory()) return "the slot's folder is gone";
  if (interruptedPruneQuarantine(quarantineReason)) return "a prune was interrupted with files still present";
  if (
    quarantineReason === REGISTRATION_OR_IDENTITY.commonDirectory ||
    (inspection && (inspection.path !== slotPath || inspection.commonDirectory !== commonDirectory))
  ) {
    return REGISTRATION_OR_IDENTITY.commonDirectory;
  }
  if (registration === undefined) return null;
  const diagnosis = await diagnoseRegistration({ slotPath, commonDirectory, registration });
  return diagnosis.status === "refused" && diagnosis.elsewhere ? diagnosis.reason : null;
}

/** One fix in words, for a preview and the log. */
export function describeRegistrationFix(fix: RegistrationFix): string {
  switch (fix) {
    case "repairGitFile": return "Rewrites the slot's .git file with git worktree repair";
    case "repairPath": return "Points the registration back at this path with git worktree repair <path>";
    case "unlock": return "Removes the initializing lock an interrupted git worktree add left, with git worktree unlock";
  }
}
