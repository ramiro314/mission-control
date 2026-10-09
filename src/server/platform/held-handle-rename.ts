import { renameSync } from "node:fs";
import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// Renaming a directory over handles that are still open.
//
// POSIX renames a directory whatever is open inside it, so it makes one attempt, as every caller
// did before this seam existed. win32 refuses the rename with EPERM, EACCES or EBUSY while any
// handle to the directory or to a file under it is open: a concurrent reader such as the archive
// reconciler's scan, or an antivirus or indexer opening a file that was just written. Those
// handles close on their own within moments, so win32 retries for a bounded time and then
// reports the last error unchanged. A caller that must not yield uses the synchronous form, which
// blocks while it waits and so keeps a far shorter budget. `test/held-handle-rename.test.ts` pins
// both answers for both forms.

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

/**
 * The synchronous form's waits on win32: eight attempts, 635 ms of blocking in all. The managed
 * resume journal publishes a lease synchronously so that concurrent requests cannot interleave
 * before it reserves a conversation, and a scanner holding a file it just wrote is the refusal
 * it meets: on Windows 11 with Defender on, eight processes creating leases at once saw 27 of
 * 3,600 staging-directory renames refused with EPERM before this wait, and none after it.
 */
export const HELD_HANDLE_SYNC_WAITS_MS = [5, 10, 20, 40, 80, 160, 320] as const;

export interface RenameSyncHost {
  rename(from: string, to: string): void;
  sleep(ms: number): void;
}

const syncHost: RenameSyncHost = {
  // Through the live binding, so a test that mocks `fs.renameSync` still reaches this call.
  rename: (from, to) => renameSync(from, to),
  sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
};

/** `renameAllowingHeldHandles` for a synchronous caller, blocking for at most 635 ms on win32. */
export function renameAllowingHeldHandlesSync(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
  using: RenameSyncHost = syncHost,
): void {
  for (const wait of platform === "win32" ? HELD_HANDLE_SYNC_WAITS_MS : []) {
    try {
      return using.rename(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (!code || !HELD_HANDLE_CODES.has(code)) throw error;
    }
    using.sleep(wait);
  }
  using.rename(from, to);
}
