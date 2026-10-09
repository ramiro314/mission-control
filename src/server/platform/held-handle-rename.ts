import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// Renaming a directory over handles that are still open.
//
// POSIX renames a directory whatever is open inside it, so it makes one attempt, as every caller
// did before this seam existed. win32 refuses the rename with EPERM, EACCES or EBUSY while any
// handle to the directory or to a file under it is open: a concurrent reader such as the archive
// reconciler's scan, or an antivirus or indexer opening a file that was just written. Those
// handles close on their own within moments, so win32 retries for a bounded time and then
// reports the last error unchanged. `test/held-handle-rename.test.ts` pins both answers.

/** The errors win32 reports for a rename blocked by another handle. */
const HELD_HANDLE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** How long win32 waits for a held handle before reporting the rename's last error. */
export const HELD_HANDLE_BUDGET_MS = 5_000;

const FIRST_WAIT_MS = 10;
const LONGEST_WAIT_MS = 250;

export interface RenameHost {
  rename(from: string, to: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const host: RenameHost = {
  rename: (from, to) => rename(from, to),
  sleep: async (ms) => { await delay(ms); },
  now: () => Date.now(),
};

/** Rename `from` to `to`, waiting on win32 for another process's handle under `from` to close. */
export async function renameAllowingHeldHandles(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
  using: RenameHost = host,
): Promise<void> {
  if (platform !== "win32") return using.rename(from, to);
  const deadline = using.now() + HELD_HANDLE_BUDGET_MS;
  for (let wait = FIRST_WAIT_MS; ; wait = Math.min(wait * 2, LONGEST_WAIT_MS)) {
    try {
      return await using.rename(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (!code || !HELD_HANDLE_CODES.has(code) || using.now() + wait > deadline) throw error;
    }
    await using.sleep(wait);
  }
}
