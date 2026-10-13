import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import { openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";

/**
 * Linux with tmux and Ghostty installed and no WezTerm: the machine the spawn-only Linux
 * Ghostty adapter exists for. Nothing is routed - the daemon's own executable resolution and
 * terminal registry decide every row.
 *
 * Ghostty is found the way an installed one is, as a bare `ghostty` in a directory the
 * daemon searches, with `GHOSTTY_BIN` cleared. The fake never runs: the spec stops short of
 * opening a window. WezTerm stays at the fixture's missing path.
 */
const bin = mkdtempSync(join(tmpdir(), "mc-e2e-ghostty-"));
writeFileSync(join(bin, "ghostty"), "#!/bin/sh\nexit 0\n");
chmodSync(join(bin, "ghostty"), 0o755);

test.use({
  daemonEnv: {
    MISSION_TMUX_BIN: process.execPath,
    GHOSTTY_BIN: "",
    MISSION_EXECUTABLE_PATHS: bin,
  },
});

test("on Linux an installed Ghostty raises tmux sessions when WezTerm is absent", async ({
  page,
  daemon,
}) => {
  test.skip(process.platform !== "linux", "macOS detects Ghostty from its app bundle, not PATH");

  const response = await page.request.get(`${daemon.baseURL}/api/terminal-targets`);
  const { targets } = await response.json();
  const tmuxTarget = targets.find((t: { id: string }) => t.id === "tmux");
  expect(tmuxTarget.unavailable).toBeNull();
  expect(tmuxTarget.blurb).toBe("New session, raised in Ghostty.");

  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "terminals");
  const tmux = setupRow(page, "dependency-tmux");
  await tmux.getByRole("button", { name: /^Terminal app for tmux sessions/ }).click();

  const menu = page.getByRole("menu", { name: "Choose a terminal app for tmux sessions" });
  await expect(menu).toBeVisible();
  const ghostty = menu.getByRole("menuitemradio", { name: /Ghostty/ });
  await expect(ghostty).toBeEnabled();
  await expect(ghostty).toContainText("Focus opens a new Ghostty window.");
  const wezterm = menu.getByRole("menuitemradio", { name: /WezTerm/ });
  await expect(wezterm).toBeDisabled();
  await expect(wezterm).toContainText("WezTerm is not installed");

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("linux-ghostty-terminal");
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, "tmux-chooser-linux-ghostty.png"), fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/linux-ghostty-terminal/tmux-chooser-linux-ghostty.png");
  }
});
