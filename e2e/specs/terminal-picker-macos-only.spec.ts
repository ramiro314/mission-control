import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";

const EVIDENCE = artifactsDir("terminal-picker-macos-only");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/terminal-picker-macos-only/${name}.png`);
}

// Unmocked: the rows come from the fixture daemon's own `/api/terminal-targets`. iTerm2 is
// pinned to a missing path there, so off macOS the row says what no install could fix, and
// on macOS it keeps the ordinary "not installed". Ghostty is supported on both platforms.
test("the terminal picker shows iTerm2 disabled with requires macOS off macOS", async ({
  dashboard,
  daemon,
}) => {
  const itermReason = process.platform === "darwin" ? "iTerm2 is not installed" : "requires macOS";

  await dashboard.goto(`${daemon.baseURL}/#/settings`);
  await dashboard.getByRole("tab", { name: /Harnesses/ }).click();
  await dashboard
    .getByRole("combobox", { name: "Session runtime for dispatched Claude Code sessions" })
    .selectOption("terminal");
  await dashboard.getByRole("button", { name: /Terminal preference for Claude Code/ }).click();

  const menu = dashboard.getByRole("menu", {
    name: "Choose a terminal for dispatched Claude Code sessions",
  });
  await expect(menu).toBeVisible();

  // The fixed list stays: iTerm2 is present and disabled rather than hidden.
  const iterm = menu.getByRole("menuitemradio", { name: /iTerm2/ });
  await expect(iterm).toBeDisabled();
  await expect(iterm).toContainText(itermReason);

  const ghostty = menu.getByRole("menuitemradio", { name: /Ghostty/ });
  await expect(ghostty).toBeDisabled();
  await expect(ghostty).toContainText("Ghostty is not installed");
  await expect(ghostty).not.toContainText("requires macOS");
  await shoot(dashboard, "01-iterm-requires-macos");
});
