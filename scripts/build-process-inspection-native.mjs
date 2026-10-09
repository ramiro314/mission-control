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

// Process inspection is optional: only win32 declares sources, because every other platform
// reads process owners and cwds through `ps` and `lsof`. A daemon without the addon answers
// those reads as unknown, which is what it did before the addon existed.
export function processInspectionBuildTarget(platform, arch) {
  if (!hasNativeAddonSources("process-inspection", platform)) return { kind: "skip", platform };
  if (arch === "arm64" || arch === "x64") return { kind: "build", arch };
  throw new Error(`process-inspection native build does not support ${platform} ${arch}`);
}

async function main() {
  const target = processInspectionBuildTarget(processPlatform, processArch);
  if (target.kind === "skip") {
    console.log(`[process-inspection-native] skipped on ${target.platform}`);
    return;
  }

  const sourceDir = resolve("native/process-inspection");
  const nodeGyp = resolve("node_modules/node-gyp/bin/node-gyp.js");
  const built = resolve(sourceDir, "build/Release/process_inspection.node");
  const outputDir = resolve("dist/native");
  const output = resolve(outputDir, "process-inspection.node");

  execFileSync(
    process.execPath,
    [
      nodeGyp,
      "rebuild",
      "--directory",
      sourceDir,
      `--arch=${target.arch}`,
      ...gypSourcesArgs(nativeAddonSources("process-inspection", processPlatform)),
    ],
    { stdio: "inherit" },
  );
  await mkdir(outputDir, { recursive: true });
  // A running daemon has the previous addon loaded; `publishNativeAddon` replaces it by
  // rename instead of writing through it.
  await publishNativeAddon(built, output);
  console.log(`[process-inspection-native] built ${target.arch} ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
