/**
 * The host platform the daemon answers harness availability for.
 *
 * One function in its own module rather than `process.platform` at each call site, so the
 * e2e suite can build the production daemon with only this answer replaced
 * (`e2e/fixtures/win32-host-build.ts`) and drive the win32 refusals through a browser on any
 * runner.
 */
export function hostPlatform(): NodeJS.Platform {
  return process.platform;
}
