#!/usr/bin/env node
// Regenerate the macOS app icon (.icns), the menu-bar tray template PNGs and the
// Windows tray icon (.ico) from the source SVGs in build/. The generated binaries are committed so packaging
// never needs an image toolchain; run this only when the SVGs change.
//
// Requires `rsvg-convert` (brew install librsvg) and `iconutil` (ships with macOS).
//
// Usage: node scripts/gen-icons.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(repo, "build");
const appSvg = join(buildDir, "app-icon.svg");
const traySvg = join(buildDir, "tray-icon.svg");

function have(bin) {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** An .ico container: a 6-byte header, one 16-byte entry per image, then the PNGs. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type 1: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width; 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]);
}

function render(svg, size, out) {
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), svg, "-o", out], {
    stdio: "inherit",
  });
}

if (!have("rsvg-convert")) {
  console.error("rsvg-convert not found. Install with: brew install librsvg");
  process.exit(1);
}

// --- app icon: build an .iconset then fold to .icns -------------------------
const iconset = join(buildDir, "icon.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });

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

execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(buildDir, "icon.icns")], {
  stdio: "inherit",
});
rmSync(iconset, { recursive: true, force: true });
console.log("wrote build/icon.icns");

// --- tray template (monochrome; Electron recolors for light/dark) -----------
render(traySvg, 16, join(buildDir, "trayTemplate.png"));
render(traySvg, 32, join(buildDir, "trayTemplate@2x.png"));
console.log("wrote build/trayTemplate.png + @2x");

// --- Windows tray icon (colored; nothing recolors it on the taskbar) ---------
// The app icon at every size the notification area asks for from 100% to 400% display
// scale, each entry a PNG (Windows has read PNG entries in an .ico since Vista).
const icoSizes = [16, 20, 24, 32, 40, 48, 64];
const icoScratch = join(buildDir, "tray.icoset");
rmSync(icoScratch, { recursive: true, force: true });
mkdirSync(icoScratch, { recursive: true });
const icoImages = icoSizes.map((size) => {
  const out = join(icoScratch, `${size}.png`);
  render(appSvg, size, out);
  return { size, png: readFileSync(out) };
});
rmSync(icoScratch, { recursive: true, force: true });
writeFileSync(join(buildDir, "tray.ico"), ico(icoImages));
console.log("wrote build/tray.ico");

if (!existsSync(join(buildDir, "icon.icns"))) {
  console.error("icon.icns missing after generation");
  process.exit(1);
}
