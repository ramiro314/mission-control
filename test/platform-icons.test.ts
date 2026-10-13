import assert from "node:assert/strict";
import test from "node:test";

import { trayIcon, windowIcon } from "../src/main/platform-icons.ts";

const build = "/app/build";

test("macOS keeps the template tray image whatever the needs-you count", () => {
  const expected = { path: "/app/build/trayTemplate.png", template: true };
  assert.deepEqual(trayIcon("darwin", build, 0), expected);
  assert.deepEqual(trayIcon("darwin", build, 1), expected);
  assert.deepEqual(trayIcon("darwin", build, 3), expected);
});

test("Linux shows the light tray image, badged while something needs you", () => {
  assert.deepEqual(trayIcon("linux", build, 0), { path: "/app/build/tray-light.png", template: false });
  assert.deepEqual(trayIcon("linux", build, 1), { path: "/app/build/tray-badged.png", template: false });
  assert.deepEqual(trayIcon("linux", build, 3), { path: "/app/build/tray-badged.png", template: false });
});

test("only Linux names a window icon; macOS takes its icon from the bundle", () => {
  assert.equal(windowIcon("linux", build), "/app/build/icon.png");
  assert.equal(windowIcon("darwin", build), undefined);
});
