import assert from "node:assert/strict";
import test from "node:test";

import { startupPage } from "../src/main/startup-page.ts";
import { windowChrome } from "../src/main/window-chrome.ts";

// On Linux, "hidden" without `titleBarOverlay` is a frameless window with no close,
// minimize or maximize, so the window manager has to draw the frame there.

test("macOS keeps the hidden title bar with the traffic lights over the topbar", () => {
  assert.deepEqual(windowChrome("darwin"), {
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 20, y: 28 },
  });
});

test("Linux gets the window manager's frame and a menu bar that Alt reveals", () => {
  const chrome = windowChrome("linux");
  assert.deepEqual(chrome, { titleBarStyle: "default", autoHideMenuBar: true });
  assert.equal("trafficLightPosition" in chrome, false);
});

test("the startup page is the title bar only on macOS", () => {
  const mac = startupPage("starting", "darwin");
  assert.match(mac, /header\{-webkit-app-region:drag\}/);
  assert.match(mac, /header span\{margin-left:108px\}/);

  const linux = startupPage("starting", "linux");
  assert.doesNotMatch(linux, /-webkit-app-region:drag/);
  assert.doesNotMatch(linux, /108px/);
  assert.match(linux, /header span\{margin-left:32px\}/);
});
