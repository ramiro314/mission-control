import { realpathSync } from "node:fs";

/**
 * The synchronous realpath, spelled the way `fs.promises.realpath` spells it.
 *
 * The daemon compares paths it physicalized synchronously with paths it physicalized
 * asynchronously - a pool slot against the canonicalized `git worktree list`, a stored
 * repository key against a scanned root - and the exact-physical-directory guards demand
 * `realpath(p) === resolve(p)` byte for byte. On POSIX the two Node implementations agree.
 * On win32 they do not: `fs.promises.realpath` asks the OS for the final path, which expands
 * 8.3 short names (`C:\Users\RUNNER~1`) and restores on-disk case, while Node's JS
 * `realpathSync` only follows links and keeps whatever spelling it was given. Any short
 * spelling - a `%TEMP%` under a long user name is the common one - then names one directory
 * two ways, and every guard refuses it as "not an exact physical directory".
 *
 * So win32 uses the native call here, and that long spelling is what an exact physical path
 * means on win32. Junctions and symlinks are still resolved, so the guards still refuse a
 * linked path. POSIX keeps the JS call, which leaves macOS byte for byte as it was (the
 * native call would also restore on-disk case there). The JS walk stays as the win32
 * fallback for the volumes the native call cannot open, such as some RAM disks and network
 * shares; it rethrows the walk's own error when the path truly does not resolve.
 */
export function physicalPathSync(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return realpathSync(path);
  try {
    return realpathSync.native(path);
  } catch {
    return realpathSync(path);
  }
}
