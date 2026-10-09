import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { denyDirectory } from "./helpers/denied-directory.ts";

// The win32 branch of `denyDirectory` is what the Windows CI jobs rely on, so it is pinned
// here on every host by naming the platform, rather than only where it is the default.

const home = mkdtempSync(join(tmpdir(), "mission-denied-dir-"));
const dir = join(home, "denied");
const sibling = join(home, "sibling");
after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(sibling, { recursive: true, force: true });
  mkdirSync(dir);
  mkdirSync(sibling);
  writeFileSync(join(dir, "present"), "");
});

test("a list denial refuses reading the directory through named imports, and nothing else", async () => {
  const restore = denyDirectory(dir, "list", "win32");
  try {
    assert.throws(() => readdirSync(dir), { code: "EACCES", syscall: "scandir" });
    await assert.rejects(readdir(dir), { code: "EACCES", syscall: "scandir" });
    assert.deepEqual(readdirSync(sibling), [], "another directory still lists");
    writeFileSync(join(dir, "created"), "");
    rmSync(join(dir, "created"));
  } finally {
    restore();
  }
  assert.deepEqual(readdirSync(dir), ["present"], "restoring makes it listable again");
});

test("a write denial refuses creating and removing entries inside it, and nothing else", () => {
  const restore = denyDirectory(dir, "write", "win32");
  try {
    assert.throws(() => writeFileSync(join(dir, "created"), ""), { code: "EACCES" });
    assert.throws(() => mkdirSync(join(dir, "nested")), { code: "EACCES" });
    assert.throws(() => rmSync(join(dir, "present")), { code: "EACCES" });
    assert.deepEqual(readdirSync(dir), ["present"], "listing still works and nothing moved");
    writeFileSync(join(sibling, "created"), "");
    assert.deepEqual(readdirSync(sibling), ["created"], "another directory still takes writes");
  } finally {
    restore();
  }
  writeFileSync(join(dir, "created"), "");
  assert.deepEqual(readdirSync(dir).sort(), ["created", "present"], "restoring makes it writable again");
});

test("restoring twice is harmless, so a test can restore early and still register it with after", () => {
  const restore = denyDirectory(dir, "list", "win32");
  restore();
  restore();
  assert.deepEqual(readdirSync(dir), ["present"]);
});
