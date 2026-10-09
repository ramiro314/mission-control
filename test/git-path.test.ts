import assert from "node:assert/strict";
import test from "node:test";

import { nativeGitPath } from "../src/server/util/git-path.ts";

test("a path git printed with `/` is spelled natively on win32", () => {
  assert.equal(nativeGitPath("C:/Users/me/work/repo", "win32"), "C:\\Users\\me\\work\\repo");
  assert.equal(nativeGitPath("//server/share/repo", "win32"), "\\\\server\\share\\repo");
  assert.equal(nativeGitPath("C:\\Users\\me\\repo", "win32"), "C:\\Users\\me\\repo");
});

test("every other platform keeps git's spelling byte for byte", () => {
  for (const platform of ["darwin", "linux"] as const) {
    assert.equal(nativeGitPath("/Users/me/work/repo", platform), "/Users/me/work/repo");
    assert.equal(nativeGitPath("/Users/me/odd\\name", platform), "/Users/me/odd\\name");
  }
});
