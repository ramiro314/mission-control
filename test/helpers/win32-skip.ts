/**
 * The one way a unit test or e2e spec may skip on win32 (D37 in
 * `docs/plans/windows-support/plan.md`).
 *
 * The Windows merge gate counts a test as green only when it passed or skipped through this
 * helper, and the merge pull request lists every call with its reason for review. A skip that
 * compares `process.platform` to `"win32"` directly would leave that list incomplete, so
 * `test/win32-skip-guard.test.ts` refuses one anywhere under `test/` or `e2e/`.
 *
 * A skip that fires on win32 for another reason calls the helper too, ahead of its own
 * condition, so on win32 the stated reason is the one reported: a platform exclusion
 * (`skipOnWin32("…") || process.platform !== "darwin"`, which the guard enforces) and a probe
 * for a tool that does not exist on win32, such as `tmux -V` (by convention; no syntax tells
 * that probe apart from any other).
 *
 * It is for surfaces that are unavailable on win32 (Codex, Pi, the terminal runtime and its
 * backends, terminal discovery, the macOS updater and install migration) and for tests that
 * pin a POSIX-only implementation. Every other test has to pass on Windows.
 *
 * The reason is required on every platform, so a call without one fails on macOS and Linux
 * too, not only on the Windows runner.
 */

/** Every win32 skip message starts with this, so a reporter's skip lines are easy to find. */
export const WIN32_SKIP_PREFIX = "win32: ";

/**
 * The value for node:test's `skip` option: the stated reason on win32, `false` elsewhere.
 *
 * ```ts
 * test("attaches to tmux", { skip: skipOnWin32("tmux does not run on win32") }, async () => {});
 * ```
 */
export function skipOnWin32(
  reason: string,
  platform: NodeJS.Platform = process.platform,
): string | false {
  const stated = reason.trim();
  if (!stated) throw new Error("skipOnWin32 needs a stated reason");
  return platform === "win32" ? `${WIN32_SKIP_PREFIX}${stated}` : false;
}

/**
 * The Playwright form: skips the spec file, describe group or test it is called in.
 *
 * ```ts
 * import { skipSpecOnWin32 } from "../../test/helpers/win32-skip.ts";
 * skipSpecOnWin32(test, "the terminal runtime is unavailable on win32");
 * ```
 */
export function skipSpecOnWin32(
  test: { skip(condition: boolean, description?: string): void },
  reason: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const skip = skipOnWin32(reason, platform);
  test.skip(skip !== false, skip || undefined);
}
