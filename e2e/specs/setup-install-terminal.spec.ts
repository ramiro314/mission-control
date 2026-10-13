import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { shellCommand } from "../../src/server/terminal/shell.ts";
import { setupInstallerShell } from "../../src/server/setup/install.ts";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { recordsIn } from "../fixtures/records.ts";
import { openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";

/**
 * Pi is the row these specs install, because its remedy is the same npm command on every
 * host: Homebrew rows are macOS-only, and CI is Linux. An override naming nothing makes the
 * row read as missing without letting a real Pi resolve.
 */
const PI_MISSING = { MISSION_PI_BIN: "/nonexistent/mission-e2e/pi" };
const PI_INSTALL = ["npm", "install", "-g", "@earendil-works/pi-coding-agent"];

test.use({ daemonEnv: { MC_E2E_CONDUCTOR_STARTS_MISSING: "1", ...PI_MISSING } });

function terminalRecords(recordDir: string): { argv: string[] }[] {
  return recordsIn<{ argv: string[] }>(recordDir, (file) => file.startsWith("cmux-"));
}

test("Setup opens only the daemon-owned install command in the terminal the operator picks", async ({
  page,
  daemon,
}) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto(`${daemon.baseURL}/#/settings/setup`);

  await openSetupFamily(page, "pipelines");
  const conductor = setupRow(page, "dependency-ai-conductor");
  await expect(conductor).toContainText("No verified local installer checkout was found");
  await expect(conductor.getByRole("button", { name: "Run in a terminal" })).toHaveCount(0);
  await expect(conductor.getByRole("link", { name: "Open Conductor settings" })).toBeVisible();

  await openSetupFamily(page, "agents");
  const pi = setupRow(page, "dependency-pi-cli");
  await expect(pi).toContainText(PI_INSTALL.join(" "));
  await expect(pi.getByRole("button", { name: "Copy" })).toBeVisible();
  await pi.getByLabel("Terminal for Pi").selectOption("cmux");

  const requestReady = page.waitForRequest((request) =>
    request.url().endsWith("/api/setup/install") && request.method() === "POST");
  await pi.getByRole("button", { name: "Run in a terminal" }).click();
  const request = await requestReady;
  expect(request.postDataJSON()).toEqual({ id: "pi-cli", backend: "cmux" });

  await expect(pi.getByRole("status")).toContainText(
    "cmux opened the installer. Watch it finish and read its exit code in that window.",
  );
  await expect(pi.getByRole("status")).toContainText(
    "When the installer finishes, press Re-check.",
  );

  await expect.poll(() => terminalRecords(daemon.recordDir).length).toBe(1);
  const argv = terminalRecords(daemon.recordDir)[0]?.argv ?? [];
  expect(argv[0]).toBe("new-workspace");
  expect(argv[argv.indexOf("--cwd") + 1]).toBe(daemon.home);
  const actualCommand = argv[argv.indexOf("--command") + 1] ?? "";
  const expectedCommand = shellCommand([
    "/bin/sh",
    "-c",
    setupInstallerShell(PI_INSTALL),
  ]);
  expect(actualCommand).toBe(expectedCommand);

  await page.setViewportSize({ width: 680, height: 900 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "setup remedy controls must not create horizontal clipping",
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1200 });

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("guided-setup-phase-2");
    mkdirSync(evidence, { recursive: true });
    await page.mouse.move(1, 1);
    await page.screenshot({
      path: join(evidence, "setup-install-terminal.png"),
      fullPage: true,
    });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/guided-setup-phase-2/setup-install-terminal.png");
    await openSetupFamily(page, "pipelines");
    await conductor.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(evidence, "setup-provider-no-candidate.png"),
    });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/guided-setup-phase-2/setup-provider-no-candidate.png");
  }
});

test("Setup renders the terminal launcher's refusal sentence", async ({ page, daemon }) => {
  await page.route("**/api/setup/install", async (route) => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({ id: "pi-cli", backend: "cmux" });
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        id: "pi-cli",
        outcome: "refused",
        label: "cmux",
        detail: "cmux is available but no terminal could raise it.",
      }),
    });
  });
  await page.goto(`${daemon.baseURL}/#/settings/setup`);

  await openSetupFamily(page, "agents");
  const pi = setupRow(page, "dependency-pi-cli");
  await pi.getByLabel("Terminal for Pi").selectOption("cmux");
  await pi.getByRole("button", { name: "Run in a terminal" }).click();
  await expect(pi.getByRole("status")).toHaveText(
    "cmux is available but no terminal could raise it.",
  );
  expect(terminalRecords(daemon.recordDir)).toEqual([]);
});

test.describe("with iTerm2 installed", () => {
  test.use({ daemonEnv: { ITERM_BIN: "/usr/bin/true", ...PI_MISSING } });

  test("Setup offers iTerm2 as a registry-driven launch target", async ({ page, daemon }) => {
    await page.route("**/api/setup/install", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ id: "pi-cli", backend: "iterm" });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          id: "pi-cli",
          outcome: "opened",
          label: "iTerm2",
          detail: "iTerm2 opened the installer.",
        }),
      });
    });
    await page.goto(`${daemon.baseURL}/#/settings/setup`);

    await openSetupFamily(page, "terminals");
    const iterm = setupRow(page, "dependency-iterm");
    await expect(iterm.getByRole("img", { name: "Ready" })).toBeVisible();
    await openSetupFamily(page, "agents");
    const pi = setupRow(page, "dependency-pi-cli");
    await pi.getByLabel("Terminal for Pi").selectOption("iterm");
    await pi.getByRole("button", { name: "Run in a terminal" }).click();
    await expect(pi.getByRole("status")).toContainText("iTerm2 opened the installer.");

    if (process.env.MC_E2E_EVIDENCE === "1") {
      const evidence = artifactsDir("iterm-support");
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, "launch-target.png"), fullPage: true });
      // eslint-disable-next-line no-console
      console.log("CAPTURED e2e/.artifacts/iterm-support/launch-target.png");
    }
  });
});

test.describe("with one verified local provider checkout", () => {
  test.use({
    daemonEnv: {
      MC_E2E_CONDUCTOR_STARTS_MISSING: "1",
      MC_E2E_CONDUCTOR_CHECKOUT: "1",
      MC_E2E_CONDUCTOR_NODE_VERSION: "26.7.0",
    },
  });

  test("Setup sends only provider identity and terminal choice", async ({ page, daemon }) => {
    test.setTimeout(45_000);
    expect(daemon.conductorCheckout).not.toBeNull();
    const checkout = daemon.conductorCheckout!;
    await page.goto(`${daemon.baseURL}/#/settings/setup`);

    await openSetupFamily(page, "pipelines");
    const conductor = setupRow(page, "dependency-ai-conductor");
    await expect(conductor).toContainText("Verified checkout", { timeout: 20_000 });
    await expect(conductor).toContainText(checkout);
    await conductor.getByLabel("Terminal for ai-conductor").selectOption("cmux");

    const requestReady = page.waitForRequest((request) =>
      request.url().endsWith("/api/setup/install") && request.method() === "POST");
    await conductor.getByRole("button", { name: "Run in a terminal" }).click();
    const request = await requestReady;
    expect(request.postDataJSON()).toEqual({ id: "ai-conductor", backend: "cmux" });

    await expect(conductor.getByRole("status")).toContainText(
      "cmux opened the installer. Watch it finish and read its exit code in that window.",
    );
    await expect.poll(() => terminalRecords(daemon.recordDir).length).toBe(1);
    const argv = terminalRecords(daemon.recordDir)[0]?.argv ?? [];
    const actualCommand = argv[argv.indexOf("--command") + 1] ?? "";
    expect(actualCommand).toContain(`${checkout}/bin/install`);

    if (process.env.MC_E2E_EVIDENCE === "1") {
      const evidence = artifactsDir("guided-setup-phase-2");
      mkdirSync(evidence, { recursive: true });
      await page.mouse.move(1, 1);
      await conductor.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(evidence, "setup-provider-terminal.png"),
      });
      // eslint-disable-next-line no-console
      console.log("CAPTURED e2e/.artifacts/guided-setup-phase-2/setup-provider-terminal.png");
    }
  });
});
