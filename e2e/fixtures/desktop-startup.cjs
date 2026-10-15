// Exercise the production window against the spec's gated, isolated daemon origin.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

// Positional arguments, read by index. Linux appends Chromium's `--no-sandbox` after them, so it
// is dropped first rather than read as an optional trailing argument.
const [origin, windowModule, profile, scenario, menuModule, warning, healthModule] = process.argv
  .slice(2)
  .filter((arg) => arg !== "--no-sandbox");
process.env.MISSION_HOME = path.dirname(profile);
process.env.MISSION_PORT = new URL(origin).port;
delete process.env.MISSION_DEV_SERVER_URL;
app.setPath("userData", profile);
const { createWindow, setStartupNotice, stopWindowStartup } = require(windowModule);

// Inject only the failed or unsettled Electron operation, leaving recovery to window.ts.
const loadURL = BrowserWindow.prototype.loadURL;
let firstLocalPage = true;
globalThis.startupPageFailures = 0;
globalThis.startupPageStopped = false;
BrowserWindow.prototype.loadURL = function (url, ...args) {
  if (firstLocalPage && url.startsWith("data:text/html")) {
    firstLocalPage = false;
    if (scenario === "local page failure") {
      globalThis.startupPageFailures++;
      return Promise.reject(new Error("fixture: first local page failed"));
    }
    if (scenario === "local page cancellation") {
      return new Promise((_resolve, reject) => {
        const stop = this.webContents.stop.bind(this.webContents);
        this.webContents.stop = () => {
          this.webContents.stop = stop;
          globalThis.startupPageStopped = true;
          stop();
          reject(new Error("fixture: pending local page stopped"));
        };
        // Render the page but hold its completion until the native cancellation fires.
        loadURL.call(this, url, ...args).catch(reject);
      });
    }
  }
  return loadURL.call(this, url, ...args);
};
app.on("fixture:stop-startup", stopWindowStartup);
// What index.ts does when startDaemon's wait for a running systemd unit times out.
app.on("fixture:unit-unresponsive", () => setStartupNotice("service"));
// A window destroyed and recreated later, as showWindow does after the first one is gone.
// The app stays up in between, as the tray keeps it in the shell.
let reopening = false;
app.on("fixture:reopen-window", () => {
  const old = BrowserWindow.getAllWindows()[0];
  reopening = true;
  old.once("closed", () => {
    createWindow(path.join(process.cwd(), "dist/preload/index.cjs"));
    reopening = false;
  });
  old.destroy();
});

app.whenReady().then(() => {
  ipcMain.handle("mission:update-get-state", () => ({
    phase: "unmanaged", currentVersion: "1.25.0", reason: "isolated fixture",
    lastCheckedAt: null, lastOutcome: null,
  }));
  ipcMain.handle("mission:card-jump-keys", () => undefined);
  ipcMain.handle("mission:version", () => "1.25.0");
  // The production menu install, as index.ts does it, so the spec reads the menu the shell installs.
  require(menuModule).installAppMenu({ onOpenSettings: () => {}, onCheckForUpdates: () => {} });
  const window = createWindow(path.join(process.cwd(), "dist/preload/index.cjs"), warning || null);
  if (healthModule) require(healthModule).observeUpdateLaunch(window.webContents, "/fixture/Mission Control.app", path.dirname(profile), ["--mission-update-launch", "a".repeat(32)]);
});
app.on("window-all-closed", () => { if (!reopening) app.quit(); });
// The fixture imports window.ts without index.ts, which normally owns before-quit.
app.on("before-quit", () => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); });
