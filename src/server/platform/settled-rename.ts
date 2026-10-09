import { renameSync } from "node:fs";

// A rename that publishes something Mission Control just wrote.
//
// POSIX renames whatever is open, so this is `renameSync` there, byte for byte. win32 refuses to
// rename a file that another process holds open without delete sharing, and refuses a directory
// while any file inside it is held that way. Antivirus and the search indexer open a freshly
// written file for a few milliseconds to scan it, so the rename right after a write can fail with
// EPERM, EACCES or EBUSY although nothing is wrong: eight processes creating managed resume leases
// at once on Windows 11 with Defender on saw about one staging-directory rename in seventy refused.
// A refused rename did not happen, so retrying it is safe. The retries stay short and few, because
// the callers are synchronous by design; anything still holding the entry after that is reported
// as the error it is. `test/settled-rename.test.ts` pins both answers.

const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const DELAYS_MS = [5, 10, 20, 40, 80, 160, 320];

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface SettledRenameOptions {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => void;
  wait?: (ms: number) => void;
}

/** `renameSync`, retried briefly on win32 while a scanner still holds the entry open. */
export function settledRenameSync(from: string, to: string, options: SettledRenameOptions = {}): void {
  const { platform = process.platform, rename = renameSync, wait = sleepSync } = options;
  for (const delay of platform === "win32" ? DELAYS_MS : []) {
    try { return rename(from, to); } catch (error) {
      if (!RETRY_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    wait(delay);
  }
  rename(from, to);
}
