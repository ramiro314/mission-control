#!/usr/bin/env node
// Install the Linux desktop entry (see desktop-entry.mjs). `make desktop-entry` runs this.
//
//   node scripts/install-desktop-entry.mjs              install (or refresh) the entry
//   node scripts/install-desktop-entry.mjs --uninstall  remove the entry and its autostart copy
//   node scripts/install-desktop-entry.mjs --check      only refuse a platform without one

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopEntry, desktopEntryPaths, LINUX_ONLY_MESSAGE } from "./desktop-entry.mjs";

const checkout = join(dirname(fileURLToPath(import.meta.url)), "..");

function install() {
  const paths = desktopEntryPaths();
  if (process.argv.includes("--uninstall")) {
    rmSync(paths.entry, { force: true });
    rmSync(paths.autostart, { force: true });
    console.log(`Removed ${paths.entry} and its autostart copy`);
    return;
  }
  const main = join(checkout, "dist", "main", "index.cjs");
  if (!existsSync(main)) throw new Error(`${main} is missing: run \`make build\` first.`);
  // The `electron` package exports the path of the binary it downloaded.
  const electron = createRequire(join(checkout, "package.json"))("electron");
  const text = desktopEntry({ electron, checkout });
  mkdirSync(dirname(paths.entry), { recursive: true });
  writeFileSync(paths.entry, text);
  // Keep an enabled "Start at login" a copy of what the app menu now runs.
  if (existsSync(paths.autostart)) writeFileSync(paths.autostart, text);
  console.log(`Installed ${paths.entry}`);
  console.log("Mission Control is in the app menu. Update it with `git pull && make build`.");
}

if (process.platform !== "linux") {
  console.error(LINUX_ONLY_MESSAGE);
  process.exitCode = 1;
} else if (!process.argv.includes("--check")) {
  try {
    install();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
