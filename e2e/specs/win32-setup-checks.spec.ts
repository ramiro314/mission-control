import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { SETUP_DEPENDENCY_INFO, type SetupDependencyId } from "../../src/shared/setup-catalog.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import { openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";

/**
 * Settings > Setup checks the Windows prerequisites on win32 (D11, D23, D24, D30 and D33 in
 * `docs/plans/windows-support/plan.md`), each reporting pass or fail with its fix, and shows
 * none of them anywhere else.
 *
 * `MC_E2E_WIN32_HOST` builds the production daemon with only its host-platform answer replaced
 * (`e2e/fixtures/win32-host-build.ts`). The probes still read this runner's machine, so which
 * rows pass depends on the runner: a Linux runner has a git that is not Git for Windows and no
 * `reg`, while a real Windows runner may be ready throughout. Each row is therefore held to
 * the contract for whichever state it reports.
 */

const WINDOWS_ROWS = [
  "git-for-windows",
  "windows-developer-mode",
  "windows-long-paths",
  "npm-script-shell",
  "vs-build-tools",
  "python3",
] as const satisfies readonly SetupDependencyId[];

const EVIDENCE = artifactsDir("win32-setup-checks");

/** Behind `MC_E2E_EVIDENCE` like every other capture in this suite; an ordinary run writes nothing. */
async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled", fullPage: true });
}

const windowsRail = (page: Page) => page.getByRole("button", { name: /^Windows(:|$)/ });

test.describe("on a win32 host", () => {
  test.use({ daemonEnv: { MC_E2E_WIN32_HOST: "1" } });

  test("each Windows prerequisite reports pass or fail, and a failing one shows its fix", async ({ page, daemon }) => {
    await page.goto(`${daemon.baseURL}/#/settings/setup`);
    await openSetupFamily(page, "windows");
    await expect(page.getByRole("heading", { name: "Windows", exact: true })).toBeVisible();
    await expect(windowsRail(page)).toHaveAttribute("aria-label", /^Windows: \d of 6 ready$/);

    for (const id of WINDOWS_ROWS) {
      const info = SETUP_DEPENDENCY_INFO[id];
      if (info.remedy.kind !== "manual-command") throw new Error(`${id} has no command to show`);
      const row = setupRow(page, `dependency-${id}`);
      await expect(row.getByText(info.label, { exact: true })).toBeVisible();

      const status = await row.locator(".setup-dot").getAttribute("aria-label");
      expect(["Ready", "Missing", "Needs setup", "Unknown"], id).toContain(status);
      if (status === "Ready") {
        await expect(row.locator(".setup-evidence"), id).not.toBeEmpty();
        await expect(row.getByRole("button", { name: "Copy" }), id).toHaveCount(0);
      } else {
        await expect(row.getByText(info.enables), id).toBeVisible();
        await expect(row.locator(".setup-command code"), id).toHaveText(info.remedy.command);
        await expect(row.getByText(info.remedy.note), id).toBeVisible();
        await expect(row.getByRole("button", { name: "Copy" }), id).toBeVisible();
        // A command the operator runs: Mission Control offers no terminal to run it in.
        await expect(row.getByRole("button", { name: "Run in a terminal" }), id).toHaveCount(0);
      }
    }
    await shoot(page, "setup-windows");
    // The pane scrolls on its own, so the lower rows need their own capture.
    await setupRow(page, "dependency-python3").scrollIntoViewIfNeeded();
    await shoot(page, "setup-windows-lower");
  });
});

test.describe("on this runner's own host", () => {
  test("the Windows family appears only when the daemon runs on win32", async ({ page, daemon }) => {
    await page.goto(`${daemon.baseURL}/#/settings/setup`);
    // Wait for the snapshot, which the Agent CLIs rail item reports once its rows arrive.
    await expect(page.getByRole("button", { name: /^Agent CLIs: \d+ of \d+ ready$/ })).toBeVisible();

    const onWindows = process.platform === "win32";
    await expect(windowsRail(page)).toHaveCount(onWindows ? 1 : 0);
    const checks = await (await fetch(`${daemon.baseURL}/api/setup/checks`)).json() as {
      rows: Array<{ family: string }>;
    };
    expect(checks.rows.filter((row) => row.family === "windows")).toHaveLength(onWindows ? WINDOWS_ROWS.length : 0);
    await shoot(page, "setup-native-host");
  });
});
