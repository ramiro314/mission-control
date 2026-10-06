#!/usr/bin/env node

/**
 * The source files each native addon compiles, per platform. This table is the only place
 * that says so: each `binding.gyp` lists its sources as `<@(addon_sources)`, and the builder
 * fills that variable from here through `gypSourcesArgs`.
 *
 * A platform missing from an addon's entry has no sources, never a fallback to another
 * platform's. Whether that platform is then refused or skipped is the builder's decision: the
 * state lock is required, so `stateLockBuildTarget` refuses it, while Keep Awake is optional,
 * so `nativeBuildTarget` skips it.
 *
 * File names are relative to the addon's `native/<addon>` directory and must not contain
 * spaces, because gyp splits the variable the way sh splits arguments.
 */
export const NATIVE_ADDON_SOURCES = {
  "state-lock": {
    darwin: ["state_lock.cc"],
    linux: ["state_lock.cc"],
    win32: ["state_lock_win.cc"],
  },
  "keep-awake": {
    darwin: ["keep_awake.mm"],
    win32: ["keep_awake_win.cc"],
  },
};

export function hasNativeAddonSources(addon, platform) {
  return Object.hasOwn(NATIVE_ADDON_SOURCES[addon] ?? {}, platform);
}

export function nativeAddonSources(addon, platform) {
  if (!Object.hasOwn(NATIVE_ADDON_SOURCES, addon)) {
    throw new Error(`unknown native addon ${addon}`);
  }
  if (!hasNativeAddonSources(addon, platform)) {
    throw new Error(`${addon} native addon declares no sources for ${platform}`);
  }
  return NATIVE_ADDON_SOURCES[addon][platform];
}

/** The trailing `node-gyp rebuild` arguments that hand the selected sources to gyp. */
export function gypSourcesArgs(sources) {
  return ["--", `-Daddon_sources=${sources.join(" ")}`];
}
