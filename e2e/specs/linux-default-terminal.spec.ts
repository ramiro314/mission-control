import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import { openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";

/**
 * The Linux desktop's default terminal in the terminal picker, read from the daemon's real
 * registry rather than a routed answer: whether the row exists is the platform gate this spec
 * is about, and a routed list would decide it for the daemon.
 *
 * `$TERMINAL` names a file that certainly exists, so on Linux the row is selectable and on
 * macOS it would be too, were it not gated - the absence there is then the gate's doing and
 * not an empty environment's. Nothing here presses Focus, so nothing runs it. tmux points at
 * the Node binary for the reason `setup-multiplexer-terminal.spec.ts` gives: its row must
 * read Ready on any machine for its picker to open.
 */
test.use({ daemonEnv: { MISSION_TMUX_BIN: process.execPath, TERMINAL: "/bin/sh" } });

async function openTmuxPicker(page: import("@playwright/test").Page, baseURL: string) {
  await page.goto(`${baseURL}/#/settings/setup`);
  await openSetupFamily(page, "terminals");
  const tmux = setupRow(page, "dependency-tmux");
  await tmux.getByRole("button", { name: /^Terminal app for tmux sessions/ }).click();
  const menu = page.getByRole("menu", { name: "Choose a terminal app for tmux sessions" });
  await expect(menu).toBeVisible();
  return menu;
}

test("on Linux the default terminal is offered last among the terminal apps", async ({
  page,
  daemon,
}) => {
  test.skip(process.platform !== "linux", "the default terminal exists on Linux only");

  const menu = await openTmuxPicker(page, daemon.baseURL);
  const rows = menu.getByRole("menuitemradio");
  const row = menu.getByRole("menuitemradio", { name: /Default terminal/ });
  await expect(row).toBeEnabled();
  await expect(menu.getByText("Focus opens a new Default terminal window.", { exact: true })).toBeVisible();
  // After WezTerm, Ghostty and iTerm2, which is the order Automatic tries them in.
  await expect(rows.last()).toContainText("Default terminal");

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("linux-default-terminal");
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, "tmux-picker-linux.png"), fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/linux-default-terminal/tmux-picker-linux.png");
  }

  await row.click();
  await expect(
    setupRow(page, "dependency-tmux").getByRole("button", { name: /^Terminal app for tmux sessions/ }),
  ).toContainText("Default terminal");
  await expect
    .poll(async () => {
      const response = await page.request.get(`${daemon.baseURL}/api/terminals/config`);
      return (await response.json()).multiplexerTerminal.tmux;
    })
    .toBe("xdg-terminal");
});

test("on Linux the dispatch chooser shows the default terminal disabled, with why", async ({
  page,
  daemon,
}) => {
  test.skip(process.platform !== "linux", "the default terminal exists on Linux only");

  await page.goto(`${daemon.baseURL}/#/settings`);
  await page.getByRole("tab", { name: /Harnesses/ }).click();
  await page
    .getByRole("combobox", { name: "Session runtime for dispatched Claude Code sessions" })
    .selectOption("terminal");
  await page.getByRole("button", { name: /Terminal preference for Claude Code/ }).click();
  const menu = page.getByRole("menu", { name: "Choose a terminal for dispatched Claude Code sessions" });
  await expect(menu).toBeVisible();

  // Installed and able to open a window (the Setup picker above enables it), yet it can
  // never be a dispatched agent's home, so a dispatch preference cannot choose it.
  const row = menu.getByRole("menuitemradio", { name: /Default terminal/ });
  await expect(row).toBeDisabled();
  await expect(row).toContainText(
    "Default terminal only shows multiplexer sessions - it cannot host a dispatched agent",
  );

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("linux-default-terminal");
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, "dispatch-picker-linux.png"), fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/linux-default-terminal/dispatch-picker-linux.png");
  }
});

test("on macOS the picker has no default terminal row at all", async ({ page, daemon }) => {
  test.skip(process.platform !== "darwin", "the macOS gate is observable on macOS only");

  const menu = await openTmuxPicker(page, daemon.baseURL);
  await expect(menu.getByRole("menuitemradio", { name: /WezTerm/ })).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: /Default terminal/ })).toHaveCount(0);
});
