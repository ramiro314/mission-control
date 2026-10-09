import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, openSync, closeSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { settlingRename } from "../src/server/platform/settling-rename.ts";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: rename`), { code });
}

/** A rename refused `refusals` times with `code`, then performed. */
function refusingRename(code: string, refusals: number) {
  const calls: string[] = [];
  return {
    calls,
    rename: async (from: string, to: string): Promise<void> => {
      calls.push(`${from}->${to}`);
      if (calls.length <= refusals) throw errno(code);
    },
  };
}

const missing = async (): Promise<never> => { throw errno("ENOENT"); };

test("win32 waits out a handle that closes, for each transient refusal", async () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    const slept: number[] = [];
    const { calls, rename } = refusingRename(code, 3);
    await settlingRename("bundle", "grave", {
      platform: "win32", rename, stat: missing, sleep: async (ms) => { slept.push(ms); },
    });
    assert.equal(calls.length, 4, code);
    assert.deepEqual(slept, [10, 20, 40], code);
  }
});

test("win32 reports a refusal that outlasts the budget, without sleeping past it", async () => {
  let clock = 0;
  const { calls, rename } = refusingRename("EPERM", Number.POSITIVE_INFINITY);
  await assert.rejects(
    settlingRename("bundle", "grave", {
      platform: "win32", rename, stat: missing, budgetMs: 1_000,
      now: () => clock, sleep: async (ms) => { clock += ms; },
    }),
    { code: "EPERM" },
  );
  assert.ok(clock <= 1_000, `slept ${clock}ms past a 1000ms budget`);
  assert.ok(calls.length > 3);
});

test("win32 reports at once when the destination exists, because waiting cannot cure that", async () => {
  const { calls, rename } = refusingRename("EPERM", Number.POSITIVE_INFINITY);
  await assert.rejects(
    settlingRename("bundle", "grave", {
      platform: "win32", rename, stat: async () => ({}), sleep: async () => assert.fail("slept"),
    }),
    { code: "EPERM" },
  );
  assert.equal(calls.length, 1);
});

test("a refusal that is not about a held handle is never retried", async () => {
  const { calls, rename } = refusingRename("ENOENT", Number.POSITIVE_INFINITY);
  await assert.rejects(
    settlingRename("bundle", "grave", {
      platform: "win32", rename, stat: missing, sleep: async () => assert.fail("slept"),
    }),
    { code: "ENOENT" },
  );
  assert.equal(calls.length, 1);
});

test("POSIX renames once, since an open handle never blocks a rename there", async () => {
  const { calls, rename } = refusingRename("EPERM", Number.POSITIVE_INFINITY);
  await assert.rejects(
    settlingRename("bundle", "grave", {
      platform: "darwin", rename, stat: missing, sleep: async () => assert.fail("slept"),
    }),
    { code: "EPERM" },
  );
  assert.equal(calls.length, 1);
});

test("a directory renames once a handle inside it closes", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "settling-rename-"));
  try {
    const from = join(root, "bundle");
    const to = join(root, "grave");
    mkdirSync(from);
    writeFileSync(join(from, "report.html"), "report");
    const held = openSync(join(from, "report.html"), "r");
    setTimeout(() => closeSync(held), 100);
    await settlingRename(from, to);
    assert.equal(existsSync(join(to, "report.html")), true);
    assert.equal(existsSync(from), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
