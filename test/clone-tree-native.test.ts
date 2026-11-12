import assert from "node:assert/strict";
import test from "node:test";

import {
  loadNativeCloneTreeBinding,
  nativeCloneTreeAddonPath,
  validateNativeCloneTreeBinding,
} from "../src/server/clone-tree-native.ts";

test("native tree clone loader resolves the same dist artifact from source and bundled module URLs", () => {
  assert.equal(
    nativeCloneTreeAddonPath("file:///repo/dist/server/index.mjs"),
    nativeCloneTreeAddonPath("file:///repo/src/server/clone-tree-native.ts"),
  );
  assert.equal(nativeCloneTreeAddonPath("file:///repo/src/server/clone-tree-native.ts"), "/repo/dist/native/clone-tree.node");
});

test("native tree clone loader refuses a module without a clone function", () => {
  assert.throws(() => validateNativeCloneTreeBinding({}), /must export a clone function/);
  assert.throws(() => validateNativeCloneTreeBinding(null), /must export a clone function/);
  assert.throws(
    () => loadNativeCloneTreeBinding(() => ({ clone: "not a function" })),
    /must export a clone function/,
  );
});

test("native tree clone loader accepts a clone function and asks for the dist artifact", () => {
  const binding = { clone: async () => {} };
  let asked = "";
  assert.equal(
    loadNativeCloneTreeBinding((id) => {
      asked = id;
      return binding;
    }),
    binding,
  );
  assert.equal(asked, nativeCloneTreeAddonPath());
});
