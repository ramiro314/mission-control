import type { Stats } from "node:fs";

// Whether storage Mission Control created for itself is still private to the user running it.
//
// POSIX answers with the inode: this user owns it, and neither group nor others hold any
// permission bit. That is what every caller checked before this seam existed, and it still
// fails closed on a POSIX host without `process.getuid`.
//
// win32 cannot answer with the inode. Node synthesizes `uid` 0 there and derives `mode` from the
// read-only attribute alone, so a private directory reads as `0o40666` owned by nobody, and the
// POSIX test refuses every one of them. Access on win32 is the DACL, and nothing here sets one:
// what Mission Control creates inherits the DACL of the per-user directory it creates it in, the
// user's temp directory (`%LOCALAPPDATA%\Temp`) or a path inside the user's profile, which grant
// only that user, SYSTEM and Administrators. So win32 answers yes, the same rule
// `src/mcp/pipeline-credential.ts` already applies to its credential file. Callers keep every
// check Node can answer on win32 - the entry's type, that it is not a link or junction, and for
// the resume journal its exact physical path - and those still refuse a planted entry.
// `test/private-storage.test.ts` pins both answers.

/** Whether the user running this process owns the entry. Always true on win32 (see above). */
export function ownedByCurrentUser(info: Pick<Stats, "uid">, platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.()): boolean {
  return platform === "win32" || (uid !== undefined && info.uid === uid);
}

/** Whether only the user running this process can reach the entry. Always true on win32. */
export function privateToCurrentUser(info: Pick<Stats, "uid" | "mode">, platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.()): boolean {
  return ownedByCurrentUser(info, platform, uid) && (platform === "win32" || (info.mode & 0o077) === 0);
}
