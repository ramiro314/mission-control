import { mkdirSync } from "node:fs";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";

// An override naming a path that does not exist reads as a missing lsof, whatever the runner
// has installed.
test.use({ daemonEnv: { MISSION_LSOF_BIN: "/nonexistent/lsof" } });

test("Setup on Linux asks for lsof as a required runtime tool", async ({ page, daemon }) => {
  test.skip(process.platform !== "linux", "the lsof row is offered on Linux only");
  await page.goto(`${daemon.baseURL}/#/settings/setup`);

  await openSetupFamily(page, "runtime");
  const row = setupRow(page, "dependency-lsof");
  await expect(row).toContainText("lsof");
  await expect(row).toContainText("Missing");
  await expect(row).toContainText("worktree release and cleanup are refused");
  await expect(row).toContainText("Install lsof with your distribution's package manager.");
  await expect(row.getByRole("link", { name: "Open lsof project page" })).toHaveAttribute("href", /^https:\/\//);
  await expect(row.getByRole("button", { name: "Run in a terminal" })).toHaveCount(0);

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("linux-lsof-setup");
    mkdirSync(evidence, { recursive: true });
    await page.mouse.move(1, 1);
    await page.screenshot({ path: `${evidence}/runtime.png`, fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/linux-lsof-setup/runtime.png");
  }
});

test("Setup on macOS does not list lsof, which the base system ships", async ({ page, daemon }) => {
  test.skip(process.platform !== "darwin", "macOS leaves the lsof row out");
  await page.goto(`${daemon.baseURL}/#/settings/setup`);

  await openSetupFamily(page, "runtime");
  await expect(setupRow(page, "dependency-node-runtime")).toBeVisible();
  await expect(setupRow(page, "dependency-lsof")).toHaveCount(0);
});
