import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { stateLockBuildTarget } from "../scripts/build-state-lock-native.mjs";
import { clearDarwinProvenance } from "../scripts/native-addon-publish.mjs";
import {
  nativeStateLockAddonPath,
  validateNativeStateLockBinding,
} from "../src/server/state-ownership-native.ts";

test("the state ownership addon builds for the shipped daemon platforms", () => {
  assert.deepEqual(stateLockBuildTarget("darwin", "arm64"), {
    platform: "darwin",
    arch: "arm64",
  });
  assert.deepEqual(stateLockBuildTarget("darwin", "x64"), {
    platform: "darwin",
    arch: "x64",
  });
  assert.deepEqual(stateLockBuildTarget("linux", "x64"), {
    platform: "linux",
    arch: "x64",
  });
  assert.deepEqual(stateLockBuildTarget("win32", "x64"), {
    platform: "win32",
    arch: "x64",
  });
});

test("unsupported state ownership addon targets fail at build time", () => {
  assert.throws(() => stateLockBuildTarget("freebsd", "x64"), /does not support freebsd x64/);
  assert.throws(() => stateLockBuildTarget("darwin", "riscv64"), /does not support darwin riscv64/);
});

test("the Darwin build removes inherited provenance from the copied addon", () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const execute = ((bin: string, args: string[]) => {
    calls.push({ bin, args });
    return args.length === 1 ? "com.apple.provenance\n" : "";
  }) as typeof import("node:child_process").execFileSync;

  assert.equal(clearDarwinProvenance("/dist/state-lock.node", "darwin", execute), true);
  assert.deepEqual(calls, [
    {
      bin: "/usr/bin/xattr",
      args: ["/dist/state-lock.node"],
    },
    {
      bin: "/usr/bin/xattr",
      args: ["-d", "com.apple.provenance", "/dist/state-lock.node"],
    },
  ]);
  assert.equal(clearDarwinProvenance("/dist/state-lock.node", "linux", execute), false);
  assert.equal(calls.length, 2);
});

test("an already-clean Darwin addon is success, but another xattr failure is fatal", () => {
  const missing = ((_bin: string, _args: string[]) =>
    "com.apple.FinderInfo\n") as unknown as typeof import("node:child_process").execFileSync;
  const denied = (() => {
    throw Object.assign(new Error("permission denied"), {
      status: 1,
      stderr: "xattr: /dist/state-lock.node: Permission denied\n",
    });
  }) as typeof import("node:child_process").execFileSync;

  assert.equal(clearDarwinProvenance("/dist/state-lock.node", "darwin", missing), false);
  assert.throws(
    () => clearDarwinProvenance("/dist/state-lock.node", "darwin", denied),
    /permission denied/,
  );

  const deleteDenied = ((_bin: string, args: string[]) => {
    if (args.length === 1) return "com.apple.provenance\n";
    throw Object.assign(new Error("read-only filesystem"), { status: 1 });
  }) as typeof import("node:child_process").execFileSync;
  assert.throws(
    () => clearDarwinProvenance("/dist/state-lock.node", "darwin", deleteDenied),
    /read-only filesystem/,
  );
});

test("the native state lock resolves identically from source and bundle locations", () => {
  // `file:///repo` on POSIX; win32 needs a drive letter, so derive the URL from an absolute path.
  const repo = pathToFileURL(resolve("/repo")).href;
  assert.equal(
    nativeStateLockAddonPath(`${repo}/src/server/state-ownership-native.ts`),
    nativeStateLockAddonPath(`${repo}/dist/server/index.mjs`),
  );
});

test("the native state lock requires both lifecycle functions", () => {
  assert.throws(
    () => validateNativeStateLockBinding({ acquire: () => ({}) }),
    /must export acquire and release functions/,
  );
  const binding = { acquire: () => ({}), release: () => {} };
  assert.equal(validateNativeStateLockBinding(binding), binding);
});
