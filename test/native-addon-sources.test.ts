import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { nativeBuildTarget } from "../scripts/build-keep-awake-native.mjs";
import { stateLockBuildTarget } from "../scripts/build-state-lock-native.mjs";
import {
  gypSourcesArgs,
  NATIVE_ADDON_SOURCES,
  nativeAddonSources,
  type NativeAddon,
} from "../scripts/native-addon-sources.mjs";

const REPO_ROOT = join(import.meta.dirname, "..");
const ADDONS = Object.keys(NATIVE_ADDON_SOURCES) as NativeAddon[];

test("darwin builds IOKit Keep Awake and the POSIX state lock", () => {
  assert.deepEqual(nativeAddonSources("keep-awake", "darwin"), ["keep_awake.mm"]);
  assert.deepEqual(nativeAddonSources("state-lock", "darwin"), ["state_lock.cc"]);
});

test("linux builds the POSIX state lock and still skips Keep Awake", () => {
  assert.deepEqual(nativeAddonSources("state-lock", "linux"), ["state_lock.cc"]);
  assert.throws(
    () => nativeAddonSources("keep-awake", "linux"),
    /keep-awake native addon declares no sources for linux/,
  );
  assert.deepEqual(nativeBuildTarget("linux", "x64"), { kind: "skip", platform: "linux" });
});

test("win32 builds power-request Keep Awake from its own source", () => {
  assert.deepEqual(nativeAddonSources("keep-awake", "win32"), ["keep_awake_win.cc"]);
  assert.throws(() => nativeBuildTarget("win32", "ia32"), /Windows ia32/);
});

test("a platform without its own sources never borrows another platform's", () => {
  for (const platform of ["freebsd"]) {
    for (const addon of ADDONS) {
      assert.throws(
        () => nativeAddonSources(addon, platform),
        new RegExp(`${addon} native addon declares no sources for ${platform}`),
      );
    }
    // The state lock is required, so it refuses; Keep Awake is optional, so it skips.
    assert.throws(
      () => stateLockBuildTarget(platform, "x64"),
      new RegExp(`does not support ${platform} x64`),
    );
    assert.deepEqual(nativeBuildTarget(platform, "x64"), { kind: "skip", platform });
  }
});

test("an inherited object key is not mistaken for a platform", () => {
  assert.throws(() => nativeAddonSources("state-lock", "toString"), /declares no sources/);
  assert.throws(() => stateLockBuildTarget("constructor", "x64"), /does not support/);
});

test("the selected sources reach gyp as one define after the node-gyp options", () => {
  assert.deepEqual(gypSourcesArgs(["state_lock.cc"]), ["--", "-Daddon_sources=state_lock.cc"]);
  assert.deepEqual(gypSourcesArgs(["a.cc", "b.cc"]), ["--", "-Daddon_sources=a.cc b.cc"]);
});

test("every declared source exists and each binding.gyp defers to the table", () => {
  for (const addon of ADDONS) {
    const dir = join(REPO_ROOT, "native", addon);
    for (const sources of Object.values(NATIVE_ADDON_SOURCES[addon])) {
      for (const source of sources ?? []) {
        assert.doesNotMatch(source, /\s/, `${addon}/${source} would be split by gyp`);
        assert.ok(existsSync(join(dir, source)), `${addon} declares missing ${source}`);
      }
    }
    // A literal source list in binding.gyp would be a second, platform-blind source of truth.
    const gyp = JSON.parse(readFileSync(join(dir, "binding.gyp"), "utf8")) as {
      targets: Array<{ sources: string[] }>;
    };
    assert.deepEqual(
      gyp.targets.map((target) => target.sources),
      [["<@(addon_sources)"]],
    );
  }
});
