import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ownedByCurrentUser, privateToCurrentUser } from "../src/server/platform/private-storage.ts";

const uid = 501;

// The answers are checked by what each platform reads off a stat, so they run on any runner.
test("POSIX requires this user's ownership and no group or other permission bit, as before the seam", () => {
  for (const platform of ["darwin", "linux"] as const) {
    assert.equal(privateToCurrentUser({ uid, mode: 0o40700 }, platform, uid), true);
    assert.equal(privateToCurrentUser({ uid, mode: 0o100600 }, platform, uid), true);
    assert.equal(privateToCurrentUser({ uid, mode: 0o40750 }, platform, uid), false, "group access");
    assert.equal(privateToCurrentUser({ uid, mode: 0o40701 }, platform, uid), false, "other access");
    assert.equal(privateToCurrentUser({ uid: uid + 1, mode: 0o40700 }, platform, uid), false, "another owner");
    assert.equal(ownedByCurrentUser({ uid }, platform, uid), true);
    assert.equal(ownedByCurrentUser({ uid: uid + 1 }, platform, uid), false);
  }
});

test("POSIX fails closed when the process cannot name its own uid", () => {
  assert.equal(privateToCurrentUser({ uid: 0, mode: 0o40700 }, "linux", undefined), false);
  assert.equal(ownedByCurrentUser({ uid: 0 }, "darwin", undefined), false);
});

test("win32 trusts the per-user ACL, because Node reports uid 0 and mode 0o666 for every entry", () => {
  // What Node's win32 stat synthesizes for a private directory and a private file.
  assert.equal(privateToCurrentUser({ uid: 0, mode: 0o40666 }, "win32", undefined), true);
  assert.equal(privateToCurrentUser({ uid: 0, mode: 0o100666 }, "win32", undefined), true);
  assert.equal(ownedByCurrentUser({ uid: 0 }, "win32", undefined), true);
});

test("a directory this process creates owner-only is private on this host", () => {
  const dir = mkdtempSync(join(tmpdir(), "private-storage-"));
  try {
    const path = join(dir, "private");
    mkdirSync(path, { mode: 0o700 });
    assert.equal(privateToCurrentUser(lstatSync(path)), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
