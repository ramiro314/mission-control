import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";

// The desktop shell's preload is faked here, as `alpha-updates.spec.ts` does, so the spec
// observes exactly which bridge member each button calls without touching the operator's
// `~/.claude/settings.json`. The bridge members themselves are `ipcRenderer.invoke` one-liners.

const capture = async (page: import("@playwright/test").Page, name: string): Promise<void> => {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  const dir = join(process.cwd(), "e2e/.artifacts/settings-integrations");
  await mkdir(dir, { recursive: true });
  await page.mouse.move(1, 1);
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
};

test("desktop Settings installs and removes the Claude integrations through the preload bridge", async ({ dashboard }) => {
  const calls: string[] = [];
  // The first install is held open so the in-flight state can be observed, and the second
  // throws, which is what `ipcRenderer.invoke` does when the main-process handler throws.
  let releaseInstall: () => void = () => {};
  const installHeld = new Promise<void>((resolve) => { releaseInstall = resolve; });
  await dashboard.exposeFunction("integrationsBridge", async (command: string) => {
    calls.push(command);
    if (command === "install" && calls.length === 1) {
      await installHeld;
      return { ok: true, message: "Claude integrations installed via node. Claude: MCP registered." };
    }
    if (command === "install") throw new Error("Error invoking remote method 'mission:install-integrations': boom");
    return { ok: false, message: "Could not write ~/.claude/settings.json." };
  });
  await dashboard.addInitScript(() => {
    const bridge = (command: string) =>
      (window as unknown as { integrationsBridge(c: string): Promise<{ ok: boolean; message: string }> }).integrationsBridge(command);
    Object.defineProperty(window, "missionDesktop", { value: {
      isDesktop: true, version: async () => "1.2.3", onOpenSettings: () => () => {},
      installIntegrations: () => bridge("install"),
      removeIntegrations: () => bridge("remove"),
      updates: { getState: () => new Promise(() => {}), check: () => new Promise(() => {}), apply: async () => false, install: async () => false,
        defer: async () => {}, onState: () => () => {} },
    } });
  });
  await dashboard.reload();
  await dashboard.getByRole("button", { name: "Settings" }).click();
  await dashboard.getByRole("tab", { name: "Setup" }).click();

  const panel = dashboard.getByRole("region", { name: "Integrations" });
  await expect(panel.getByRole("heading", { name: "Integrations" })).toBeVisible();
  const install = panel.getByRole("button", { name: "Install Claude integrations" });
  const remove = panel.getByRole("button", { name: "Remove Claude integrations" });
  await install.click();
  // While a call is in flight neither button can start a second one.
  await expect(install).toBeDisabled();
  await expect(remove).toBeDisabled();
  releaseInstall();
  await expect(install).toBeEnabled();
  await expect(remove).toBeEnabled();
  await expect(panel.getByRole("status")).toHaveText("Claude integrations installed via node. Claude: MCP registered.");
  expect(calls).toEqual(["install"]);
  await capture(dashboard, "installed");

  await remove.click();
  await expect(panel.getByRole("alert")).toHaveText("Could not write ~/.claude/settings.json.");
  await expect(panel.getByRole("status")).toHaveCount(0);
  expect(calls).toEqual(["install", "remove"]);
  await capture(dashboard, "remove-failed");

  // A rejected bridge call is reported, not swallowed, and leaves the buttons usable.
  await install.click();
  await expect(panel.getByRole("alert")).toContainText("mission:install-integrations': boom");
  await expect(install).toBeEnabled();
  expect(calls).toEqual(["install", "remove", "install"]);
  await capture(dashboard, "install-rejected");
});

test("browser Settings shows no Integrations section", async ({ dashboard }) => {
  await dashboard.getByRole("button", { name: "Settings" }).click();
  await dashboard.getByRole("tab", { name: "Setup" }).click();
  await expect(dashboard.getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.getByRole("tabpanel")).toContainText("This installation");
  await expect(dashboard.getByRole("region", { name: "Integrations" })).toHaveCount(0);
  await expect(dashboard.getByRole("button", { name: "Install Claude integrations" })).toHaveCount(0);
  await capture(dashboard, "browser");
});
