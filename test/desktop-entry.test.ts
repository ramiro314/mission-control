import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  desktopEntry,
  desktopEntryPaths,
  linuxAutostart,
} from "../scripts/desktop-entry.mjs";
import { DESKTOP_ENTRY_HINT, startAtLogin, type LoginItemPort } from "../src/main/login-item.ts";

test("the desktop entry runs the checkout's Electron against the checkout, with the app icon and no dev server", () => {
  assert.equal(
    desktopEntry({
      electron: "/home/op/mission-control/node_modules/electron/dist/electron",
      checkout: "/home/op/mission-control",
    }),
    `[Desktop Entry]
Type=Application
Name=Mission Control
Comment=Local control plane for Claude Code, Codex and Pi sessions
Exec="/home/op/mission-control/node_modules/electron/dist/electron" "/home/op/mission-control"
Icon=/home/op/mission-control/build/icon.png
Terminal=false
Categories=Development;
StartupNotify=true
`,
  );
});

test("Exec quotes each path as one argument under the Desktop Entry escaping rules", () => {
  const entry = desktopEntry({ electron: "/opt/my apps/electron", checkout: '/home/op/100% "mc" $x`y`\\z' });
  const exec = entry.split("\n").find((line) => line.startsWith("Exec="));
  // Inside quotes `"`, `` ` ``, `$` and `\` take a backslash; the string escaping then doubles
  // every backslash, and `%` is doubled so it is not a field code.
  assert.equal(exec, 'Exec="/opt/my apps/electron" "/home/op/100%% \\\\"mc\\\\" \\\\$x\\\\`y\\\\`\\\\\\\\z"');
  assert.doesNotMatch(entry, /MISSION_DEV_SERVER_URL/);
});

test("the entry and its autostart copy follow XDG_DATA_HOME and XDG_CONFIG_HOME, defaulting under home", () => {
  assert.deepEqual(desktopEntryPaths({ env: {}, home: "/home/op" }), {
    entry: "/home/op/.local/share/applications/mission-control.desktop",
    autostart: "/home/op/.config/autostart/mission-control.desktop",
  });
  assert.deepEqual(desktopEntryPaths({ env: { XDG_DATA_HOME: "/d", XDG_CONFIG_HOME: "/c" }, home: "/home/op" }), {
    entry: "/d/applications/mission-control.desktop",
    autostart: "/c/autostart/mission-control.desktop",
  });
});

function sandbox(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mission-desktop-entry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = desktopEntryPaths({ env: { XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config") }, home: root });
  const installEntry = () => {
    mkdirSync(dirname(paths.entry), { recursive: true });
    writeFileSync(paths.entry, desktopEntry({ electron: "/c/node_modules/electron/dist/electron", checkout: "/c" }));
  };
  return { paths, installEntry, autostart: linuxAutostart(paths) };
}

test("turning autostart on writes an exact copy of the installed entry, and off removes it", (t) => {
  const { paths, installEntry, autostart } = sandbox(t);
  installEntry();
  assert.equal(autostart.enabled(), false);
  autostart.set(true);
  assert.equal(autostart.enabled(), true);
  assert.equal(readFileSync(paths.autostart, "utf8"), readFileSync(paths.entry, "utf8"));
  autostart.set(false);
  assert.equal(existsSync(paths.autostart), false);
  autostart.set(false);
  assert.equal(autostart.enabled(), false, "turning off twice is harmless");
});

test("autostart cannot be turned on without the entry it copies", (t) => {
  const { paths, autostart } = sandbox(t);
  assert.equal(autostart.installed(), false);
  assert.throws(() => autostart.set(true), /desktop entry is not installed/);
  assert.equal(existsSync(paths.autostart), false);
});

function electronLoginItem(initial: boolean) {
  const sets: boolean[] = [];
  const port: LoginItemPort = { get: () => initial, set: (on) => sets.push(on) };
  return { port, sets };
}

test("macOS keeps Electron's login item and never reads the XDG files", () => {
  const electron = electronLoginItem(true);
  const untouched = { installed: () => assert.fail("read"), enabled: () => assert.fail("read"), set: () => assert.fail("set") };
  const item = startAtLogin("darwin", electron.port, untouched);
  assert.deepEqual({ checked: item.checked, enabled: item.enabled, hint: item.hint }, { checked: true, enabled: true, hint: null });
  item.set(false);
  assert.deepEqual(electron.sets, [false]);
});

test("Linux reads and toggles the autostart copy, never Electron's login item", (t) => {
  const { paths, installEntry, autostart } = sandbox(t);
  installEntry();
  const electron = electronLoginItem(true);
  const off = startAtLogin("linux", electron.port, autostart);
  assert.deepEqual({ checked: off.checked, enabled: off.enabled, hint: off.hint }, { checked: false, enabled: true, hint: null });
  off.set(true);
  assert.equal(existsSync(paths.autostart), true);
  const on = startAtLogin("linux", electron.port, autostart);
  assert.equal(on.checked, true);
  on.set(false);
  assert.equal(existsSync(paths.autostart), false);
  assert.deepEqual(electron.sets, []);
});

test("Linux disables Start at login with a hint until the desktop entry is installed", (t) => {
  const { paths, autostart } = sandbox(t);
  const item = startAtLogin("linux", electronLoginItem(false).port, autostart);
  assert.deepEqual({ checked: item.checked, enabled: item.enabled, hint: item.hint }, { checked: false, enabled: false, hint: DESKTOP_ENTRY_HINT });
  assert.match(DESKTOP_ENTRY_HINT, /make desktop-entry/);
  // A copy left behind by a removed entry stays visible, and can still be turned off.
  mkdirSync(dirname(paths.autostart), { recursive: true });
  writeFileSync(paths.autostart, "[Desktop Entry]\n");
  const stale = startAtLogin("linux", electronLoginItem(false).port, autostart);
  assert.deepEqual({ checked: stale.checked, enabled: stale.enabled }, { checked: true, enabled: true });
});
