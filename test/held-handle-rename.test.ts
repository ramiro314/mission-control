import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HELD_HANDLE_BUDGET_MS,
  HELD_HANDLE_SYNC_WAITS_MS,
  renameAllowingHeldHandles,
  renameAllowingHeldHandlesSync,
  type RenameHost,
  type RenameSyncHost,
} from "../src/server/platform/held-handle-rename.ts";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: rename`), { code });
}

/** A host whose renames fail with `failures` in order, then succeed, on a clock only `sleep` moves. */
function scripted(failures: Array<Error | null>) {
  let clock = 0;
  const attempts: number[] = [];
  const waits: number[] = [];
  const host: RenameHost = {
    rename: async () => {
      attempts.push(clock);
      const failure = failures.shift();
      if (failure) throw failure;
    },
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  return { host, attempts, waits };
}

test("POSIX renames once and reports a refusal unchanged, as before the seam", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    const refused = errno("EPERM");
    const { host, attempts, waits } = scripted([refused]);
    await assert.rejects(renameAllowingHeldHandles("from", "to", platform, host), (error) => error === refused);
    assert.equal(attempts.length, 1);
    assert.deepEqual(waits, []);
  }
});

test("win32 waits out a handle that closes, whichever error reports it", async () => {
  const { host, attempts, waits } = scripted([errno("EPERM"), errno("EACCES"), errno("EBUSY"), null]);
  await renameAllowingHeldHandles("from", "to", "win32", host);
  assert.equal(attempts.length, 4);
  assert.deepEqual(waits, [10, 20, 40]);
});

test("win32 reports any other failure at once", async () => {
  for (const failure of [errno("ENOENT"), errno("EXDEV"), new Error("no code")]) {
    const { host, attempts } = scripted([failure]);
    await assert.rejects(renameAllowingHeldHandles("from", "to", "win32", host), (error) => error === failure);
    assert.equal(attempts.length, 1);
  }
});

test("win32 gives up within its budget with the last refusal", async () => {
  const refusals = Array.from({ length: 1_000 }, () => errno("EPERM"));
  const { host, attempts, waits } = scripted([...refusals]);
  await assert.rejects(
    renameAllowingHeldHandles("from", "to", "win32", host),
    (error) => error === refusals[attempts.length - 1],
  );
  assert.ok(attempts.length > 10, "a held handle gets more than a moment to close");
  assert.ok(attempts.at(-1)! <= HELD_HANDLE_BUDGET_MS, "no attempt starts after the budget");
  assert.ok(Math.max(...waits) <= 250, "the wait between attempts stays short");
});

// The real host: on win32 the open file refuses the directory's rename until it closes, and on
// POSIX the rename does not wait for it at all. Either way the directory ends up moved.
test("a directory with a briefly open file is renamed once the handle closes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "held-handle-rename-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const from = join(root, "bundle");
  const to = join(root, "grave");
  mkdirSync(from);
  writeFileSync(join(from, "manifest.json"), "{}");
  const fd = openSync(join(from, "manifest.json"), "r");
  let open = true;
  const release = () => {
    if (open) closeSync(fd);
    open = false;
  };
  const closing = setTimeout(release, 50);
  try {
    await renameAllowingHeldHandles(from, to);
  } finally {
    clearTimeout(closing);
    release();
  }
  assert.equal(existsSync(from), false);
  assert.equal(existsSync(join(to, "manifest.json")), true);
});

/** A synchronous host whose renames fail with `failures` in order, then succeed. */
function scriptedSync(failures: Array<Error | null>) {
  const attempts: string[] = [];
  const waits: number[] = [];
  const host: RenameSyncHost = {
    rename: (from, to) => {
      attempts.push(`${from}->${to}`);
      const failure = failures.shift();
      if (failure) throw failure;
    },
    sleep: (ms) => { waits.push(ms); },
  };
  return { host, attempts, waits };
}

test("the synchronous form on POSIX renames once and reports a refusal unchanged", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const refused = errno("EPERM");
    const { host, attempts, waits } = scriptedSync([refused]);
    assert.throws(() => renameAllowingHeldHandlesSync("from", "to", platform, host), (error) => error === refused);
    assert.equal(attempts.length, 1);
    assert.deepEqual(waits, []);
  }
});

test("the synchronous form on win32 waits out a handle that closes, whichever error reports it", () => {
  const { host, attempts, waits } = scriptedSync([errno("EPERM"), errno("EACCES"), errno("EBUSY"), null]);
  renameAllowingHeldHandlesSync("from", "to", "win32", host);
  assert.equal(attempts.length, 4);
  assert.deepEqual(waits, [5, 10, 20]);
});

test("the synchronous form on win32 reports any other failure at once", () => {
  for (const failure of [errno("ENOENT"), errno("EXDEV"), new Error("no code")]) {
    const { host, attempts, waits } = scriptedSync([failure]);
    assert.throws(() => renameAllowingHeldHandlesSync("from", "to", "win32", host), (error) => error === failure);
    assert.equal(attempts.length, 1);
    assert.deepEqual(waits, []);
  }
});

test("the synchronous form on win32 blocks under a second, then reports the last refusal", () => {
  const refusals = Array.from({ length: 20 }, () => errno("EPERM"));
  const { host, attempts, waits } = scriptedSync([...refusals]);
  assert.throws(
    () => renameAllowingHeldHandlesSync("from", "to", "win32", host),
    (error) => error === refusals[attempts.length - 1],
  );
  assert.equal(attempts.length, HELD_HANDLE_SYNC_WAITS_MS.length + 1);
  assert.ok(waits.reduce((sum, ms) => sum + ms, 0) < 1_000, "a synchronous caller blocks under a second");
});

test("the synchronous form publishes a directory with a freshly written file inside", (t) => {
  const root = mkdtempSync(join(tmpdir(), "held-handle-rename-sync-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const from = join(root, ".staging");
  mkdirSync(from);
  writeFileSync(join(from, "record.json"), "{}");
  renameAllowingHeldHandlesSync(from, join(root, "published"));
  assert.equal(existsSync(from), false);
  assert.equal(existsSync(join(root, "published", "record.json")), true);
});
