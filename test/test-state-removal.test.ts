// Removing a test home must not fail on win32 because this process still holds it open.
//
// win32 refuses to delete an open file, and `openDb` keeps its connection open for the life of
// the process. On Windows CI that turned about 160 files red in their `after` hook, and crashed
// thirteen more workers in the preload's exit cleanup, after every test in them had passed.
// The preload wraps `rmSync` on win32 only, so these cases install the same wrapper by hand
// and prove the chain on any platform: the removal announces its path, and `db.ts` closes the
// connection that path holds.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "test-state-removal-"));
process.env.MISSION_HOME = home;
const sibling = `${home}-sibling`;
after(() => rmSync(sibling, { recursive: true, force: true }));

const { openDb, TEST_STATE_REMOVAL_EVENT } = await import("../src/server/db.ts");
// A non-literal specifier, because the preload is plain `.mjs` with no declaration file.
const preloadPath = "./setup-state.mjs";
const preload = (await import(preloadPath)) as {
  TEST_STATE_REMOVAL_EVENT: string;
  releaseBeforeRemoval(target?: { rmSync(path: unknown, options?: unknown): unknown }): void;
};

test("the preload and db.ts name the same removal event", () => {
  assert.equal(preload.TEST_STATE_REMOVAL_EVENT, TEST_STATE_REMOVAL_EVENT);
});

test("the wrapped rmSync announces the absolute path before it removes anything", () => {
  const order: string[] = [];
  const fake = {
    rmSync(path: unknown, options: unknown) {
      order.push(`remove ${String(path)} ${JSON.stringify(options)}`);
      return "removed";
    },
  };
  const listener = (target: string) => order.push(`announce ${target}`);
  process.on(TEST_STATE_REMOVAL_EVENT, listener);
  try {
    preload.releaseBeforeRemoval(fake);
    const target = join(home, "nested");
    assert.equal(fake.rmSync(pathToFileURL(target), { force: true }), "removed");
    assert.deepEqual(order, [
      `announce ${target}`,
      `remove ${pathToFileURL(target).href} {"force":true}`,
    ]);
  } finally {
    process.off(TEST_STATE_REMOVAL_EVENT, listener);
  }
});

test("removing an unrelated directory, even one sharing the home's prefix, keeps the connection", () => {
  const db = openDb();
  preload.releaseBeforeRemoval();
  mkdirSync(sibling);
  mkdirSync(join(home, "unrelated"));
  rmSync(sibling, { recursive: true, force: true });
  rmSync(join(home, "unrelated"), { recursive: true, force: true });
  assert.equal(db.isOpen, true);
  assert.equal(openDb(), db);
});

test("removing the home through node:fs closes the database it holds first", () => {
  const db = openDb();
  rmSync(home, { recursive: true, force: true });
  assert.equal(db.isOpen, false);
  assert.equal(existsSync(home), false);
});

test("a worker whose exit cleanup cannot remove its state dir still exits cleanly", (t) => {
  if (process.getuid?.() === 0) return t.skip("root removes read-only directories");
  // Something the removal cannot get past: an open file on win32, as the database was, and a
  // read-only directory elsewhere, because POSIX removes an open file without complaint.
  const hold = process.platform === "win32"
    ? 'openSync(locked + "/held", "w");'
    : 'writeFileSync(locked + "/held", ""); chmodSync(locked, 0o555);';
  const script = [
    'import { chmodSync, mkdirSync, openSync, writeFileSync } from "node:fs";',
    'const locked = process.env.HARNESS_HOME + "/locked";',
    "mkdirSync(locked);",
    hold,
    "console.log(process.env.HARNESS_HOME);",
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--import", "./test/setup-state.mjs", "--input-type=module", "-e", script],
    { env: { ...process.env, NODE_TEST_CONTEXT: "child-v8" }, encoding: "utf8" },
  );
  const root = child.stdout.trim();
  try {
    assert.equal(child.status, 0, child.stderr);
    assert.ok(root && existsSync(join(root, "locked", "held")), "the child removed its state dir");
    assert.match(child.stderr, /test\/setup-state\.mjs: left .* behind/);
  } finally {
    if (root) {
      chmodSync(join(root, "locked"), 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
