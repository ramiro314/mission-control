import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncDirectory, syncFile } from "../src/server/platform/durable-sync.ts";
import { skipOnWin32 } from "./helpers/win32-skip.ts";

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "durable-sync-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("POSIX flushes a file and its directory through read-only descriptors, as before the seam", {
  skip: skipOnWin32("pins the POSIX implementation, which opens a directory as a file"),
}, () => {
  withDir((dir) => {
    const file = join(dir, "record");
    writeFileSync(file, "bytes");
    chmodSync(file, 0o400);
    syncFile(file, "darwin");
    syncDirectory(dir, "darwin");
    syncFile(file, "linux");
    syncDirectory(dir, "linux");
  });
});

// The win32 answers are checked by what they ask of the host, so they run on any runner: write
// access for a file (a read-only file refuses it), and nothing at all for a directory.
test("win32 opens a file for writing, because FlushFileBuffers refuses a read-only handle", {
  skip: process.getuid?.() === 0 && "root opens a read-only file for writing",
}, () => {
  withDir((dir) => {
    const file = join(dir, "record");
    writeFileSync(file, "bytes");
    syncFile(file, "win32");
    chmodSync(file, 0o400);
    assert.throws(() => syncFile(file, "win32"), { code: /^(EACCES|EPERM)$/ });
  });
});

test("win32 makes no directory flush, so it never opens the directory", () => {
  syncDirectory(join(tmpdir(), "durable-sync-never-created"), "win32");
});
