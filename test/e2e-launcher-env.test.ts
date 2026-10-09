import assert from "node:assert/strict";
import test from "node:test";

import globalSetup from "../e2e/global-setup.ts";
import { isLauncherSessionVariable, scrubLauncherSession } from "../e2e/launcher-env.ts";

// What a Claude Code session launched by Mission Control exports, as recorded from one that
// ran `npm run test:e2e` and saw the dispatch spec read `sdk-cli` instead of `sdk-ts`.
const LAUNCHING_SESSION = {
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "sdk-cli",
  CLAUDE_CODE_SESSION_ID: "launcher-session",
  CLAUDE_CODE_CHILD_SESSION: "1",
  CLAUDE_CODE_EXECPATH: "/launcher/claude",
  CLAUDE_AGENT_SDK_VERSION: "0.0.0-launcher",
  CLAUDE_CONFIG_DIR: "/launcher/.claude",
  ANTHROPIC_BASE_URL: "https://launcher.invalid",
  CODEX_HOME: "/launcher/.codex",
  PI_CODING_AGENT_DIR: "/launcher/.pi",
  MISSION_HOME: "/launcher/.mission-control",
  MISSION_PORT: "7317",
  MISSION_API_TOKEN_FILE: "/launcher/.mission-control/token",
  MISSION_SCOUT_SUBMISSION_CREDENTIAL_FILE: "/launcher/.mission-control/scout",
  MISSION_GH_BIN: "/launcher/bin/gh",
  FLEET_HOME: "/launcher/.fleet",
  HARNESS_HOME: "/launcher/.harness",
} as const;

// What the suite needs from the shell that launched it.
const SUITE_ENVIRONMENT = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/operator",
  CI: "true",
  MC_COVERAGE: "1",
  MC_E2E_REAL_HERDR_BIN: "/opt/herdr",
  MISSION_PLAYWRIGHT_JSON: "/tmp/flake/playwright.json",
  MISSION_PLAYWRIGHT_JUNIT: "/tmp/e2e-junit.xml",
  TMUX_PANE: "%1",
  NODE_OPTIONS: "--max-old-space-size=4096",
} as const;

test("the scrub removes the launching session's identity and keeps what the suite needs", () => {
  const env: NodeJS.ProcessEnv = { ...LAUNCHING_SESSION, ...SUITE_ENVIRONMENT };

  const removed = scrubLauncherSession(env);

  assert.deepEqual(removed, Object.keys(LAUNCHING_SESSION).sort());
  assert.deepEqual(env, SUITE_ENVIRONMENT);
});

test("the classification covers whole families, not only the names one incident produced", () => {
  for (const name of ["CLAUDE_CODE_SOME_FUTURE_FLAG", "CODEX_SANDBOX", "MISSION_POLL_MS", "HARNESS_WORKSPACE_DIRS"]) {
    assert.equal(isLauncherSessionVariable(name), true, name);
  }
  for (const name of ["MC_E2E_RECORD_DIR", "MISSIONARY", "PIPELINE", "XDG_CONFIG_HOME"]) {
    assert.equal(isLauncherSessionVariable(name), false, name);
  }
});

// The wiring: Playwright forks its workers from the runner's `process.env` after global
// setup, so the scrub only protects the daemons if global setup applies it there, and applies
// it before anything in setup can stop. An over-limit worker count is refused before the host
// lease is taken, which lets this run without contending for the machine-wide lease.
test("global setup scrubs the runner's environment before it can refuse to start", async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, LAUNCHING_SESSION);

    await assert.rejects(
      globalSetup({ workers: 99 } as Parameters<typeof globalSetup>[0]),
      /limited to 4 workers per host/,
    );

    for (const name of Object.keys(LAUNCHING_SESSION)) {
      assert.equal(process.env[name], undefined, `${name} survived global setup`);
    }
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});
