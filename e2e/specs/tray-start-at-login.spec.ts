import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, test } from "../fixtures/test.ts";
import { assertElectronGuiLaunchAllowed } from "../../test/helpers/electron-gui.ts";
import { desktopEntry, desktopEntryPaths } from "../../scripts/desktop-entry.mjs";
import { DESKTOP_ENTRY_HINT } from "../../src/main/login-item.ts";

interface ShownItem { label: string; type: string; enabled: boolean; checked: boolean }

/** The tray menu as the shell last installed it: what a person sees when they open it. */
function trayMenu(application: ElectronApplication): Promise<ShownItem[]> {
  return application.evaluate(() => {
    const menu = Reflect.get(globalThis, "trayMenu") as Electron.Menu | undefined;
    return (menu?.items ?? []).map((item) => ({ label: item.label, type: item.type, enabled: item.enabled, checked: item.checked }));
  });
}

/** The "Start at login" row and the row under it. */
async function startAtLogin(application: ElectronApplication) {
  const items = await trayMenu(application);
  const at = items.findIndex((item) => item.label === "Start at login");
  return { item: items[at], next: items[at + 1], items };
}

/** A real click on the installed menu item, through Electron's own MenuItem.click. */
function clickStartAtLogin(application: ElectronApplication): Promise<void> {
  return application.evaluate(() => {
    const menu = Reflect.get(globalThis, "trayMenu") as Electron.Menu;
    menu.items.find((item) => item.label === "Start at login")!.click();
  });
}

async function evidence(name: string, value: unknown) {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  const dir = "e2e/.artifacts/tray-start-at-login";
  await mkdir(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

test("Linux Start at login is disabled with a hint until the desktop entry exists, then toggles its autostart copy", async ({ daemon }) => {
  test.skip(process.platform !== "linux", "macOS keeps Electron's login item; the XDG autostart copy is Linux only");
  assertElectronGuiLaunchAllowed();
  const xdg = { XDG_DATA_HOME: join(daemon.home, "xdg-data"), XDG_CONFIG_HOME: join(daemon.home, "xdg-config") };
  const paths = desktopEntryPaths({ env: xdg });
  const trayModule = join(daemon.home, "tray.cjs");
  buildSync({
    entryPoints: ["src/main/tray.ts"], outfile: trayModule,
    bundle: true, platform: "node", format: "cjs", external: ["electron"],
    alias: { "@shared": join(process.cwd(), "src/shared") },
  });
  const application = await electron.launch({
    args: [
      fileURLToPath(new URL("../fixtures/tray-start-at-login.cjs", import.meta.url)),
      trayModule, join(process.cwd(), "build"), join(daemon.home, "electron-profile"),
      "--no-sandbox",
    ],
    // The tray polls this daemon's report, and every poll redraws the menu from disk.
    env: { ...process.env, ...xdg, MISSION_PORT: new URL(daemon.baseURL).port },
  });
  try {
    await expect.poll(async () => (await startAtLogin(application)).item, { message: "the tray installed no menu" }).toBeTruthy();
    const missing = await startAtLogin(application);
    await evidence("1-entry-missing", missing.items);
    expect(missing.item).toMatchObject({ type: "checkbox", enabled: false, checked: false });
    expect(missing.next).toMatchObject({ label: DESKTOP_ENTRY_HINT, enabled: false });
    expect(DESKTOP_ENTRY_HINT).toContain("make desktop-entry");

    // What `make desktop-entry` writes; the next redraw finds it.
    const entry = desktopEntry({ electron: join(process.cwd(), "node_modules/electron/dist/electron"), checkout: process.cwd() });
    mkdirSync(dirname(paths.entry), { recursive: true });
    writeFileSync(paths.entry, entry);
    await expect.poll(async () => (await startAtLogin(application)).item?.enabled, { timeout: 10_000 }).toBe(true);
    const installed = await startAtLogin(application);
    await evidence("2-entry-installed", installed.items);
    expect(installed.item).toMatchObject({ enabled: true, checked: false });
    expect(installed.items.map((item) => item.label)).not.toContain(DESKTOP_ENTRY_HINT);
    expect(existsSync(paths.autostart)).toBe(false);

    await clickStartAtLogin(application);
    expect(readFileSync(paths.autostart, "utf8"), "the autostart copy is the entry itself").toBe(entry);
    const on = await startAtLogin(application);
    await evidence("3-turned-on", { autostart: paths.autostart, contents: readFileSync(paths.autostart, "utf8"), items: on.items });
    expect(on.item).toMatchObject({ enabled: true, checked: true });

    await clickStartAtLogin(application);
    expect(existsSync(paths.autostart)).toBe(false);
    const off = await startAtLogin(application);
    await evidence("4-turned-off", { autostartExists: existsSync(paths.autostart), items: off.items });
    expect(off.item).toMatchObject({ enabled: true, checked: false });
  } finally {
    await application.close();
  }
});
