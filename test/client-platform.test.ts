import assert from "node:assert/strict";
import test from "node:test";

import { clientPlatform, isMacClient } from "../src/web/lib/platform.ts";

/** Stand up a `window` for one assertion and take it down again. */
function withWindow<T>(win: unknown, fn: () => T): T {
  const holder = globalThis as { window?: unknown };
  holder.window = win;
  try {
    return fn();
  } finally {
    delete holder.window;
  }
}

test("the Electron preload's platform wins over the browser's", () => {
  const win = {
    missionDesktop: { platform: "linux" },
    navigator: { userAgentData: { platform: "macOS" }, platform: "MacIntel" },
  };
  withWindow(win, () => {
    assert.equal(clientPlatform(), "linux");
    assert.equal(isMacClient(), false);
  });
  withWindow({ missionDesktop: { platform: "darwin" } }, () => assert.equal(isMacClient(), true));
});

test("a browser falls back to userAgentData.platform, then navigator.platform", () => {
  withWindow({ navigator: { userAgentData: { platform: "Linux" }, platform: "MacIntel" } }, () => {
    assert.equal(clientPlatform(), "Linux");
    assert.equal(isMacClient(), false);
  });
  withWindow({ navigator: { userAgentData: { platform: "macOS" } } }, () => {
    assert.equal(isMacClient(), true);
  });
  withWindow({ navigator: { platform: "Linux x86_64" } }, () => assert.equal(isMacClient(), false));
  withWindow({ navigator: { platform: "Win32" } }, () => assert.equal(isMacClient(), false));
  withWindow({ navigator: { platform: "MacIntel" } }, () => assert.equal(isMacClient(), true));
  // An older preload has no platform field and must not hide the browser's answer.
  withWindow({ missionDesktop: {}, navigator: { platform: "Linux x86_64" } }, () => {
    assert.equal(isMacClient(), false);
  });
});

test("outside a browser nothing is known, and the keyboard keeps its macOS meaning", () => {
  // Node has a `navigator` of its own; it must not stand in for a client that is not there.
  assert.equal(clientPlatform(), null);
  assert.equal(isMacClient(), true);
});
