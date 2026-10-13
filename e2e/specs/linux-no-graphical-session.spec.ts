import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * Linux, a daemon with no reachable desktop: what a unit left running after logout with
 * linger on looks like. Neither the daemon's own environment nor the systemd user manager's
 * names a display, so a GUI launch must refuse with the one sentence that says so, in the
 * place an "Open in" failure already appears, and must not start the launcher at all.
 *
 * The daemon's display variables are blanked, and `systemctl` is a fake that cannot read the
 * manager, so the developer's own desktop cannot answer for it. `xdg-open` is a fake that
 * leaves a marker if it ever runs; the exact-browser route is pointed at nothing so the
 * launcher is `xdg-open` on every machine.
 */
const bin = mkdtempSync(join(tmpdir(), "mc-e2e-no-display-"));
const opened = join(bin, "xdg-open-ran");
writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\ntouch '${opened}'\n`);
writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "xdg-open"), 0o755);
chmodSync(join(bin, "systemctl"), 0o755);

test.use({
  daemonEnv: {
    DISPLAY: "",
    WAYLAND_DISPLAY: "",
    INVOCATION_ID: "",
    MISSION_SYSTEMCTL_BIN: join(bin, "systemctl"),
    MISSION_XDG_OPEN_BIN: join(bin, "xdg-open"),
    MISSION_GTK_LAUNCH_BIN: join(bin, "missing-gtk-launch"),
    MISSION_XDG_SETTINGS_BIN: join(bin, "missing-xdg-settings"),
  },
});

const TASK = "open a mockup without a desktop";
const MOCKUP = "mockup.html";

async function openMockupInFiles(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let cwd: string | null = null;
  await expect
    .poll(async () => {
      const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as { cwd: string | null }[];
      cwd = sessions[0]?.cwd ?? null;
      return cwd;
    }, { message: "the dispatched session never reported a working directory" })
    .not.toBeNull();
  writeFileSync(join(cwd!, MOCKUP), "<!doctype html><h1>Mockup</h1>\n");

  // The Files tab lives in the Console layout.
  await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  await page.reload();
  await page
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Open a Mockup/i })
    .click();
  await page.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Files$/ }).click();
  await page.getByRole("listbox", { name: "Session files" }).getByRole("option", { name: MOCKUP }).click();
}

test("on Linux with no reachable display, Open in Browser names the missing graphical session", async ({
  dashboard,
  daemon,
}) => {
  test.skip(process.platform !== "linux", "the graphical-session check is Linux-only; macOS launches unchanged");

  await openMockupInFiles(dashboard, daemon);
  await dashboard.getByRole("button", { name: /^Open in/ }).click();
  await dashboard.getByRole("menu", { name: "Open this file in" }).getByRole("menuitem", { name: /Browser/ }).click();

  await expect(
    dashboard.getByText(
      "No graphical session is reachable from the Mission Control daemon: neither the daemon nor " +
        "the systemd user manager has a WAYLAND_DISPLAY or DISPLAY whose socket exists. Log in to a " +
        "desktop session, or start the daemon from one.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(existsSync(opened), "the launcher never ran without a display").toBe(false);

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("linux-no-graphical-session");
    mkdirSync(evidence, { recursive: true });
    await dashboard.screenshot({ path: join(evidence, "open-in-no-display.png"), fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/linux-no-graphical-session/open-in-no-display.png");
  }
});
