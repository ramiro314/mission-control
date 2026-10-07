import assert from "node:assert/strict";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import { physicalPathSync } from "../src/server/util/physical-path.ts";
import {
  openedPathSync,
  validateNativeOpenedPathBinding,
} from "../src/server/util/opened-path.ts";

// win32 reads the path through the state-lock addon, which a single-file run must provision.
if (process.platform === "win32") ensureNativeStateLockAddon();

const READS_DESCRIPTORS = process.platform === "linux" || process.platform === "win32";
const skipWithoutDescriptorPaths = !READS_DESCRIPTORS
  && "only linux and win32 read a path from a descriptor; darwin opens with O_NOFOLLOW_ANY";

function withOpenFile(action: (input: { root: string; file: string; fd: number }) => void): void {
  const root = physicalPathSync(mkdtempSync(join(tmpdir(), "mission-opened-path-")));
  const file = join(root, "inside", "evidence.log");
  mkdirSync(join(root, "inside"));
  writeFileSync(file, "evidence\n");
  const fd = openSync(file, "r");
  try {
    action({ root, file, fd });
  } finally {
    closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
}

test("a platform with no descriptor path refuses rather than guessing from a name", () => {
  for (const platform of ["darwin", "freebsd"] as const) {
    assert.throws(() => openedPathSync(0, platform), new RegExp(`cannot be read on ${platform}`));
  }
});

test("an addon without openedPath is refused", () => {
  assert.throws(() => validateNativeOpenedPathBinding({}), /must export openedPath/);
  assert.throws(() => validateNativeOpenedPathBinding(null), /must export openedPath/);
  const binding = { openedPath: () => "C:\\checkout\\evidence.log" };
  assert.equal(validateNativeOpenedPathBinding(binding), binding);
});

test("an open descriptor reports its file in the physical spelling", { skip: skipWithoutDescriptorPaths }, () => {
  withOpenFile(({ file, fd }) => {
    assert.equal(openedPathSync(fd), physicalPathSync(file));
  });
});

test("the path comes from the descriptor, so a rename after the open is seen", { skip: skipWithoutDescriptorPaths }, () => {
  withOpenFile(({ root, file, fd }) => {
    const moved = join(root, "moved.log");
    renameSync(file, moved);
    assert.equal(openedPathSync(fd), physicalPathSync(moved));
  });
});

test("a file opened through a linked directory reports where it really is", { skip: skipWithoutDescriptorPaths }, () => {
  withOpenFile(({ root, file }) => {
    const link = join(root, "linked");
    // A junction on win32, which needs no symlink privilege; POSIX ignores the type.
    symlinkSync(join(root, "inside"), link, "junction");
    const fd = openSync(join(link, "evidence.log"), "r");
    try {
      assert.equal(openedPathSync(fd), physicalPathSync(file));
    } finally {
      closeSync(fd);
    }
  });
});

test("a closed descriptor has no path", { skip: skipWithoutDescriptorPaths }, () => {
  withOpenFile(({ file }) => {
    const closed = openSync(file, "r");
    closeSync(closed);
    assert.throws(() => openedPathSync(closed));
  });
});
