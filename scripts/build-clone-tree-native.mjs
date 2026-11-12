#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { arch as processArch, platform as processPlatform } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { publishNativeAddon } from "./native-addon-publish.mjs";
import {
  gypSourcesArgs,
  hasNativeAddonSources,
  nativeAddonSources,
} from "./native-addon-sources.mjs";

const PLATFORM_LABELS = { darwin: "Darwin" };

// The tree clone is optional: without it a seed falls back to `cp`, so a platform with no
// declared sources skips the build instead of failing it.
export function cloneTreeBuildTarget(platform, arch) {
  if (!hasNativeAddonSources("clone-tree", platform)) return { kind: "skip", platform };
  if (arch === "arm64" || arch === "x64") return { kind: "build", arch };
  throw new Error(
    `clone-tree native build does not support ${PLATFORM_LABELS[platform] ?? platform} ${arch}`,
  );
}

async function main() {
  const target = cloneTreeBuildTarget(processPlatform, processArch);
  if (target.kind === "skip") {
    console.log(`[clone-tree-native] skipped on ${target.platform}`);
    return;
  }

  const sourceDir = resolve("native/clone-tree");
  const nodeGyp = resolve("node_modules/node-gyp/bin/node-gyp.js");
  const built = resolve(sourceDir, "build/Release/clone_tree.node");
  const outputDir = resolve("dist/native");
  const output = resolve(outputDir, "clone-tree.node");

  execFileSync(
    process.execPath,
    [
      nodeGyp,
      "rebuild",
      "--directory",
      sourceDir,
      `--arch=${target.arch}`,
      ...gypSourcesArgs(nativeAddonSources("clone-tree", processPlatform)),
    ],
    { stdio: "inherit" },
  );
  await mkdir(outputDir, { recursive: true });
  // Never a copy onto `output`: `publishNativeAddon` holds the account of why.
  await publishNativeAddon(built, output);
  console.log(`[clone-tree-native] built ${target.arch} ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
