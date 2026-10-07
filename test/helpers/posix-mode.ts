/**
 * The permission bits `stat` reports, masked with `0o777`, for an entry created or chmodded
 * with `posix`.
 *
 * win32 has no POSIX permission bits. Node reports every writable file and directory there as
 * `0o666` whatever mode it was given, so an owner-only mode cannot be read back. Privacy on
 * win32 comes from the ACL of the per-user directory the entry is written under. What win32
 * does report is the read-only attribute, so `0o666` there still asserts the entry is writable
 * by its owner.
 *
 * ```ts
 * assert.equal(statSync(path).mode & 0o777, expectedMode(0o600));
 * ```
 */
export function expectedMode(posix: number, platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? 0o666 : posix;
}
