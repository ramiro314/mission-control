// Run the production tray against the spec's daemon, with XDG dirs the spec owns.
const { app, Tray } = require("electron");

const [trayModule, buildDir, profile] = process.argv.slice(2);
app.setPath("userData", profile);

// Electron offers no way to read a tray's context menu back, so keep the one tray.ts installs.
const setContextMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function (menu) {
  globalThis.trayMenu = menu;
  return setContextMenu.call(this, menu);
};

app.whenReady().then(() => {
  const noop = () => {};
  require(trayModule).createTray(buildDir, {
    onOpen: noop, onCheckForUpdates: noop, onInstallIntegrations: noop, onRemoveIntegrations: noop, onQuit: noop,
  });
});
app.on("window-all-closed", () => {});
