/**
 * The environment that moves `os.homedir()` to `home` on every platform.
 *
 * `os.homedir()` reads `HOME` on macOS and Linux and `USERPROFILE` on win32, and a win32
 * process with no `USERPROFILE` falls back to the account's real profile. A fixture that sets
 * `HOME` alone therefore isolates nothing on Windows: the daemon, a child, or the code under
 * test still resolves the operator's profile, which is where Claude transcripts, the state dir
 * and every per-user tool location hang. Spread this wherever a test redirects the home, so
 * both names always move together. `test/os-home-isolation.test.ts` refuses a test that sets
 * `HOME` without it.
 */
export function osHomeEnv(home: string): { HOME: string; USERPROFILE: string } {
  return { HOME: home, USERPROFILE: home };
}
