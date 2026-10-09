/**
 * A path git printed, spelled the way the platform spells it.
 *
 * Git for Windows prints its own paths with `/` (`rev-parse --show-toplevel` answers
 * `C:/work/repo`), while everything else the daemon holds for the same directory - a session's
 * cwd, a realpath, a `path.join` - is native (`C:\work\repo`). Reported as written, one
 * directory has two spellings, and an exact comparison between them fails. On win32 `/` is a
 * separator and never part of a name, so swapping it is exact. Every other platform already
 * matches, so the path is returned unchanged and macOS stays byte for byte as it was.
 */
export function nativeGitPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? path.replaceAll("/", "\\") : path;
}
