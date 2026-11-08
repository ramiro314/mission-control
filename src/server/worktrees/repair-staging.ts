import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where a re-registration keeps a slot's entries while Git registers the folder again:
 * `<pool>/.repair-staging/<id>/`, on the pool's own volume, so every move is a rename and the
 * warm install keeps its inodes. Each holds `repair.json`, written before anything moves, and
 * `entries/`, the folder's top-level entries.
 */
export const REPAIR_STAGING_DIRECTORY = ".repair-staging";
const INTENT_FILE = "repair.json";
const ENTRIES_DIRECTORY = "entries";

/** What a re-registration was doing, so a restart can put the slot's entries back. */
export interface RepairIntent {
  slotId: string;
  path: string;
  commit: string;
  startedAt: number;
}

/** The pool's repair staging root. */
export function repairStagingRoot(poolPath: string): string {
  return join(poolPath, REPAIR_STAGING_DIRECTORY);
}

/**
 * Write the intent, then move every entry of the slot's folder into the staging directory. The
 * intent lands by rename before the first move, so a staging directory without one never holds
 * anything of a slot's. A move that throws leaves what already moved staged, for
 * `restoreStagedEntries`.
 */
export async function stageSlotEntries(stagingDirectory: string, intent: RepairIntent): Promise<void> {
  await mkdir(stagingDirectory, { recursive: true });
  const temporary = join(stagingDirectory, `${INTENT_FILE}.tmp`);
  await writeFile(temporary, `${JSON.stringify(intent)}\n`);
  await rename(temporary, join(stagingDirectory, INTENT_FILE));
  const entries = join(stagingDirectory, ENTRIES_DIRECTORY);
  await mkdir(entries);
  for (const name of await readdir(intent.path)) {
    await rename(join(intent.path, name), join(entries, name));
  }
}

/**
 * Move every staged entry back into the slot's folder. A `.git` the folder already has is the
 * new registration's, so the staged one, which named a registration that is gone, is dropped.
 * Any other name already present is never overwritten: it stays staged and is returned.
 */
export async function restoreStagedEntries(stagingDirectory: string, slotPath: string): Promise<string[]> {
  const entries = join(stagingDirectory, ENTRIES_DIRECTORY);
  let names: string[];
  try {
    names = await readdir(entries);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  await mkdir(slotPath, { recursive: true });
  const left: string[] = [];
  for (const name of names) {
    const staged = join(entries, name);
    if (await lstat(join(slotPath, name)).catch(() => null)) {
      if (name === ".git") await rm(staged, { force: true });
      else left.push(name);
      continue;
    }
    await rename(staged, join(slotPath, name));
  }
  return left;
}

export type StagedRepair =
  | { id: string; directory: string; status: "noIntent" }
  | { id: string; directory: string; status: "unreadable"; reason: string }
  | { id: string; directory: string; status: "intent"; intent: RepairIntent };

function parseIntent(text: string): RepairIntent | null {
  const value = JSON.parse(text) as Partial<RepairIntent>;
  return typeof value.slotId === "string" && typeof value.path === "string" &&
      typeof value.commit === "string" && typeof value.startedAt === "number"
    ? { slotId: value.slotId, path: value.path, commit: value.commit, startedAt: value.startedAt }
    : null;
}

/** Every staging directory under the pool, with the intent it holds. */
export async function stagedRepairs(poolPath: string): Promise<StagedRepair[]> {
  const root = repairStagingRoot(poolPath);
  const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  const found: StagedRepair[] = [];
  for (const id of names) {
    const directory = join(root, id);
    let text: string;
    try {
      text = await readFile(join(directory, INTENT_FILE), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") found.push({ id, directory, status: "noIntent" });
      else found.push({ id, directory, status: "unreadable", reason: String(error) });
      continue;
    }
    let intent: RepairIntent | null;
    try {
      intent = parseIntent(text);
    } catch (error) {
      found.push({ id, directory, status: "unreadable", reason: String(error) });
      continue;
    }
    found.push(intent
      ? { id, directory, status: "intent", intent }
      : { id, directory, status: "unreadable", reason: "repair.json does not name a slot, a path and a commit" });
  }
  return found;
}
