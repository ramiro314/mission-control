// The environment of whatever launched the suite, which no daemon this suite starts may see.
//
// A Mission Control agent runs `npm run test:e2e` from inside its own Claude Code session, and
// that session exports its identity: `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT=sdk-cli`,
// `CLAUDE_CODE_SESSION_ID`, and the `MISSION_HOME`, `MISSION_PORT` and `MISSION_API_TOKEN_FILE`
// Mission Control handed it. Every one of those reached the fixture daemon through
// `...process.env`, and from there the agents it launched: the Agent SDK keeps an inherited
// `CLAUDE_CODE_ENTRYPOINT` rather than stamping its own, so the dispatch spec read `sdk-cli`
// where CI, which exports none of this, reads `sdk-ts`. The same run from a plain shell passed.
//
// The unit suite closed the same class of leak in `test/setup-state.mjs`. This is the
// browser suite's equivalent, applied once in `global-setup.ts` before Playwright starts a
// worker, so the workers, every daemon and Foreman they boot, the dev dashboard and anything a
// spec spawns all inherit an environment with none of it.
//
// Whole families rather than the names one incident produced. The agent CLIs add variables
// between releases, and a daemon reads dozens of `MISSION_*` settings, any of which an
// operator's shell can carry. Everything the suite needs from these families is set
// explicitly by `fixtures/daemon.ts` or passed through a spec's `daemonEnv`.

/** Variable families an agent session or an operator's Mission Control setup exports. */
export const LAUNCHER_SESSION_ENV: readonly RegExp[] = [
  // Claude Code and its Agent SDK: `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_CONFIG_DIR`,
  // `CLAUDE_AGENT_SDK_VERSION` and the rest. `CLAUDE_CONFIG_DIR` alone would point the
  // daemon's settings reads at the operator's real configuration.
  /^CLAUDE/,
  // Credentials and endpoints. The fixture blanks `ANTHROPIC_API_KEY` itself; the others
  // (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, ...) have no business in a fake run either.
  /^ANTHROPIC_/,
  // A Codex session's identity and home: `CODEX_HOME`, `CODEX_SANDBOX`, `CODEX_THREAD_ID`.
  /^CODEX_/,
  // Pi's configuration directory. The fixture sets `PI_CODING_AGENT_DIR` to a disposable one.
  /^PI_CODING_AGENT_/,
  // Mission Control's own settings under all three names `envVar` reads, including the
  // `*_BIN` overrides the unit preload clears for the same reason.
  /^(?:MISSION|FLEET|HARNESS)_/,
];

/**
 * The suite's own settings, which the scrub leaves alone although a family above matches
 * them: `playwright.config.ts` reads `MISSION_PLAYWRIGHT_JSON` and its siblings to choose
 * reporters, and a launching session never exports them.
 */
const SUITE_SETTINGS = /^MISSION_PLAYWRIGHT_/;

/** Whether `name` belongs to the launching session rather than to the suite. */
export function isLauncherSessionVariable(name: string): boolean {
  return !SUITE_SETTINGS.test(name) && LAUNCHER_SESSION_ENV.some((family) => family.test(name));
}

/**
 * Delete every launching-session variable from `env`, in place, and return the names removed.
 *
 * In place because the caller is `process.env` in the Playwright runner: Playwright forks its
 * workers from that environment after global setup, which is the only point every later
 * process in the suite descends from.
 */
export function scrubLauncherSession(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = Object.keys(env).filter(isLauncherSessionVariable).sort();
  for (const name of removed) delete env[name];
  return removed;
}
