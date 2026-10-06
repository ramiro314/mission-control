import { closeSync, fsyncSync, openSync } from "node:fs";

// Durable writes: flush a file's bytes, and a directory's entries after a rename into it.
//
// POSIX flushes both through a read-only descriptor, which is what every caller did before this
// seam existed. win32 does neither that way: `FlushFileBuffers` needs a handle with write access,
// so a read-only one is refused with EPERM, and Node cannot open a directory as a file there at
// all. A rename on NTFS is recorded by its metadata journal, so win32 has no directory flush to
// make. `test/durable-sync.test.ts` pins both answers.

/** Flush a regular file's contents to disk. */
export function syncFile(path: string, platform: NodeJS.Platform = process.platform): void {
  const fd = openSync(path, platform === "win32" ? "r+" : "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Flush a directory's entries after a file was renamed into it. Nothing to do on win32. */
export function syncDirectory(path: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  syncFile(path, platform);
}
