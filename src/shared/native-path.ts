// Absolute-path and containment rules for code that may not import `node:path`.
//
// `src/shared/` is browser-safe, so its path checks are written on strings. They were written
// for POSIX alone - a leading "/" for "absolute", "/" for every component boundary - and on
// win32 a native path is `C:\Users\...` or `\\server\share\...`, which those checks refuse or
// never match.
//
// A path's own spelling decides its separators, not the host: one spelled as a win32 path
// (a drive root or a UNC share) treats both "\" and "/" as boundaries, and every other path
// keeps "/" alone. That keeps macOS byte-for-byte unchanged, including the case where "\" is
// an ordinary filename character inside a POSIX path.

/** Whether `p` is spelled as an absolute win32 path: `C:\`, `C:/`, or a `\\server` share. */
function isWin32Spelled(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p);
}

function hostPlatform(): string | undefined {
  return (globalThis as { process?: { platform?: string } }).process?.platform;
}

/**
 * Whether `p` is absolute on the machine that will use it. A leading "/" everywhere, and on
 * win32 also a drive root or a UNC share. A drive path on macOS stays relative, because that
 * is what the OS would make of it there.
 */
export function isAbsoluteNativePath(p: string, platform = hostPlatform()): boolean {
  return p.startsWith("/") || (platform === "win32" && isWin32Spelled(p));
}

function separatorsOf(p: string): readonly string[] {
  return isWin32Spelled(p) ? ["\\", "/"] : ["/"];
}

/**
 * Drop a single trailing separator so `/repo/` and `/repo` compare equal, keeping a bare root
 * (`/` or `C:\`) as it is.
 */
export function stripTrailingSeparator(p: string): string {
  if (p.length <= 1 || /^[A-Za-z]:[\\/]$/.test(p)) return p;
  return separatorsOf(p).includes(p.slice(-1)) ? p.slice(0, -1) : p;
}

/**
 * The part of `inner` beneath `outer`, with "/" between its components, as git spells a
 * repository-relative path. `""` when they are the same path, null when `inner` is not inside.
 *
 * Matched on the component BOUNDARY, not `startsWith` alone: `/repo-backup` is not inside
 * `/repo`.
 */
export function subpathWithin(inner: string, outer: string): string | null {
  const dir = stripTrailingSeparator(inner);
  const root = stripTrailingSeparator(outer);
  if (dir === root) return "";
  const separators = separatorsOf(root);
  if (!separators.some((sep) => dir.startsWith(`${root}${sep}`))) return null;
  const rest = dir.slice(root.length + 1);
  return separators.length > 1 ? rest.replaceAll("\\", "/") : rest;
}

/** Whether `inner` is `outer` or sits beneath it, compared by whole path components. */
export function pathWithin(inner: string, outer: string): boolean {
  return subpathWithin(inner, outer) !== null;
}
