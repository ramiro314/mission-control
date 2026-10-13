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
  await dashboard.exposeFunction("integrationsBridge", (command: string) => {
    calls.push(command);
    if (command === "install") return { ok: true, message: "Claude integrations installed via node. Claude: MCP registered." };
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
  await panel.getByRole("button", { name: "Install Claude integrations" }).click();
  await expect(panel.getByRole("status")).toHaveText("Claude integrations installed via node. Claude: MCP registered.");
  expect(calls).toEqual(["install"]);
  await capture(dashboard, "installed");

  await panel.getByRole("button", { name: "Remove Claude integrations" }).click();
  await expect(panel.getByRole("alert")).toHaveText("Could not write ~/.claude/settings.json.");
  await expect(panel.getByRole("status")).toHaveCount(0);
  expect(calls).toEqual(["install", "remove"]);
  await capture(dashboard, "remove-failed");
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
