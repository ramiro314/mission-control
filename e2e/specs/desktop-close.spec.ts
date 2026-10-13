import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, test } from "../fixtures/test.ts";
import { assertElectronGuiLaunchAllowed } from "../../test/helpers/electron-gui.ts";

const PROBE = "--user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus NameHasOwner s org.kde.StatusNotifierWatcher";

/** Close the window the way the window manager's close button does: a cancellable `close`. */
async function closeWindow(application: ElectronApplication) {
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close(); });
}

async function windowState(application: ElectronApplication) {
  return await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return window ? (window.isVisible() ? "visible" : "hidden") : "gone";
  });
}

// The production window's close handler against a fake `busctl`, selected through the
// executable catalog's MISSION_BUSCTL_BIN. Each close asks again, so a tray host that goes away
// while the shell runs turns the next close into a quit.
test("closing the window hides it while a tray host answers, and quits once none does", async ({ daemon }) => {
  assertElectronGuiLaunchAllowed();
  const linux = process.platform === "linux";
  const answer = join(daemon.home, "busctl-answer");
  const calls = join(daemon.home, "busctl-calls");
  const busctl = join(daemon.home, "busctl");
  writeFileSync(answer, "b true\n");
  writeFileSync(calls, "");
  writeFileSync(busctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncat '${answer}'\n`);
  chmodSync(busctl, 0o755);

  const windowModule = join(daemon.home, "window.cjs");
  buildSync({
    entryPoints: ["src/main/window.ts"], outfile: windowModule,
    bundle: true, platform: "node", format: "cjs", external: ["electron"],
    alias: { "@shared": join(process.cwd(), "src/shared") },
  });
  const menuModule = join(daemon.home, "menu.cjs");
  buildSync({ entryPoints: ["src/main/menu.ts"], outfile: menuModule, bundle: true, platform: "node", format: "cjs", external: ["electron"] });
  const application = await electron.launch({
    args: [
      fileURLToPath(new URL("../fixtures/desktop-startup.cjs", import.meta.url)),
      daemon.baseURL, windowModule, join(daemon.home, "electron-profile"), "close", menuModule,
      ...(linux ? ["--no-sandbox"] : []),
    ],
    env: { ...process.env, MISSION_BUSCTL_BIN: busctl },
  });
  const exited = new Promise<void>((resolve) => application.process().once("exit", () => resolve()));
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("button", { name: "Dispatch" }).first()).toBeVisible();

    await closeWindow(application);
    await expect.poll(() => windowState(application), { message: "a tray host is there, so close hides" }).toBe("hidden");

    // The tray host goes away while the shell keeps running.
    writeFileSync(answer, "b false\n");
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.show(); });
    await expect.poll(() => windowState(application)).toBe("visible");
    await closeWindow(application);

    if (linux) {
      await exited;
      expect(readFileSync(calls, "utf8").trim().split("\n"), "one probe per close").toEqual([PROBE, PROBE]);
    } else {
      // macOS keeps today's behavior: it hides on every close and never asks D-Bus.
      await expect.poll(() => windowState(application)).toBe("hidden");
      expect(readFileSync(calls, "utf8")).toBe("");
    }
  } finally {
    await application.close().catch(() => {});
  }
});
