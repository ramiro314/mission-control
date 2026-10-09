import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  nativeKeepAwakeAddonPath,
  validateNativeKeepAwakeBinding,
} from "../src/server/keep-awake-native.ts";

test("native loader resolves the same dist artifact from source and bundled module URLs", () => {
  // Module URLs built from a native absolute path: `file:///repo/...` names no drive, which
  // win32 refuses as a file URL path.
  const moduleUrl = (path: string) => pathToFileURL(resolve("/repo", path)).href;
  assert.equal(
    nativeKeepAwakeAddonPath(moduleUrl("dist/server/index.mjs")),
    nativeKeepAwakeAddonPath(moduleUrl("src/server/keep-awake-native.ts")),
  );
  assert.equal(
    nativeKeepAwakeAddonPath(moduleUrl("dist/server/index.mjs")),
    resolve("/repo", "dist/native/keep-awake.node"),
  );
});

test("native loader rejects a module without both lifecycle functions", () => {
  assert.throws(
    () => validateNativeKeepAwakeBinding({ create: () => ({}) }),
    /must export create and release functions/,
  );
});

test("native loader accepts a side-effect-free create and release surface", () => {
  const binding = { create: () => ({}), release: () => {} };
  assert.equal(validateNativeKeepAwakeBinding(binding), binding);
});
