import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { settledRenameSync } from "../src/server/platform/settled-rename.ts";

const held = (code: string) => Object.assign(new Error(`${code}: held open`), { code });

/** A rename refused `refusals` times with `code`, then performed. */
function renameAfter(refusals: number, code = "EPERM") {
  const calls: string[] = [];
  const waits: number[] = [];
  return {
    calls, waits,
    rename: (from: string, to: string) => {
      calls.push(`${from}->${to}`);
      if (calls.length <= refusals) throw held(code);
    },
    wait: (ms: number) => { waits.push(ms); },
  };
}

// The answers are checked through an injected rename, so they run on any runner.
test("win32 retries a rename a scanner briefly refuses, then publishes it", () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    const fake = renameAfter(2, code);
    settledRenameSync("staging", "published", { platform: "win32", ...fake });
    assert.equal(fake.calls.length, 3, code);
    assert.deepEqual(fake.waits, [5, 10], code);
  }
});

test("win32 reports an entry still held after the bounded retries", () => {
  const fake = renameAfter(Infinity);
  assert.throws(() => settledRenameSync("staging", "published", { platform: "win32", ...fake }), { code: "EPERM" });
  assert.equal(fake.calls.length, 8);
  assert.ok(fake.waits.reduce((sum, ms) => sum + ms, 0) < 1_000, "a synchronous caller waits under a second");
});

test("win32 never retries a refusal that is not a sharing violation", () => {
  const fake = renameAfter(1, "ENOENT");
  assert.throws(() => settledRenameSync("staging", "published", { platform: "win32", ...fake }), { code: "ENOENT" });
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.waits, []);
});

test("POSIX renames once and reports any refusal, as before the seam", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const fake = renameAfter(1);
    assert.throws(() => settledRenameSync("staging", "published", { platform, ...fake }), { code: "EPERM" });
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.waits, []);
  }
});

test("a directory with a freshly written file inside is published on this host", () => {
  const dir = mkdtempSync(join(tmpdir(), "settled-rename-"));
  try {
    const staging = join(dir, ".staging");
    mkdirSync(staging);
    writeFileSync(join(staging, "record.json"), "{}");
    settledRenameSync(staging, join(dir, "published"));
    assert.equal(existsSync(join(dir, "published", "record.json")), true);
    assert.equal(existsSync(staging), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
