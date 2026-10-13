import assert from "node:assert/strict";
import test from "node:test";

import { desktopPlatformClass } from "../src/web/lib/platform.ts";

test("the desktop shell's platform class follows the preload", () => {
  assert.equal(desktopPlatformClass({ platform: "darwin" }), "is-mac");
  assert.equal(desktopPlatformClass({ platform: "linux" }), "is-linux");
});

test("a preload that predates the platform field is a macOS one", () => {
  // Only the macOS shell shipped before the field, so the traffic-light inset stays put for
  // an older preload beside a newer bundle.
  assert.equal(desktopPlatformClass({}), "is-mac");
});
