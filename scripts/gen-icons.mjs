#!/usr/bin/env node
// Regenerate the app icons and tray images from the source SVGs in build/. The
// generated binaries are committed so packaging never needs an image toolchain;
// run this only when the SVGs change.
//
// PNGs render first, on any platform: the 512px app icon (the Linux window icon),
// the macOS menu-bar template, and the Linux tray images (light, and badged for
// "needs you"). The macOS .icns comes last and only on macOS, because `iconutil`
// ships only there.
//
// Requires `rsvg-convert` (librsvg) everywhere and `iconutil` on macOS.
//
// Usage: node scripts/gen-icons.mjs [outDir]   (outDir defaults to build/)

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(repo, "build");
const outDir = resolve(process.argv[2] ?? buildDir);
const appSvg = join(buildDir, "app-icon.svg");
const traySvg = join(buildDir, "tray-icon.svg");
const trayLightSvg = join(buildDir, "tray-icon-light.svg");
const trayBadgedSvg = join(buildDir, "tray-icon-badged.svg");

function have(bin) {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function render(svg, size, out) {
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), svg, "-o", out], {
    stdio: "inherit",
  });
}

if (!have("rsvg-convert")) {
  console.error("rsvg-convert not found. Install librsvg (`brew install librsvg` on macOS, or your distribution's librsvg tools package).");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

// --- app icon PNG (Linux window icon) ---------------------------------------
render(appSvg, 512, join(outDir, "icon.png"));
console.log("wrote icon.png");

// --- tray template (monochrome; Electron recolors for light/dark) -----------
render(traySvg, 16, join(outDir, "trayTemplate.png"));
render(traySvg, 32, join(outDir, "trayTemplate@2x.png"));
console.log("wrote trayTemplate.png + @2x");

// --- Linux tray (no template recoloring there; the badge stands in for setTitle)
render(trayLightSvg, 32, join(outDir, "tray-light.png"));
render(trayLightSvg, 64, join(outDir, "tray-light@2x.png"));
render(trayBadgedSvg, 32, join(outDir, "tray-badged.png"));
render(trayBadgedSvg, 64, join(outDir, "tray-badged@2x.png"));
console.log("wrote tray-light.png + @2x, tray-badged.png + @2x");

// --- macOS .icns: build an .iconset in a temp dir, then fold it -------------
if (process.platform !== "darwin") {
  console.log("skipped icon.icns: iconutil ships only with macOS. Regenerate it on a Mac when app-icon.svg changes.");
  process.exit(0);
}

const iconset = join(mkdtempSync(join(outDir, ".gen-icons-")), "icon.iconset");
try {
  mkdirSync(iconset);
  // macOS expects these named sizes (1x + 2x for each logical size).
  const specs = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];
  for (const [size, name] of specs) render(appSvg, size, join(iconset, name));
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(outDir, "icon.icns")], {
    stdio: "inherit",
  });
} finally {
  rmSync(dirname(iconset), { recursive: true, force: true });
}
console.log("wrote icon.icns");
