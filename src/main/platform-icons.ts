// Which generated image (see scripts/gen-icons.mjs) the window and tray use on each
// platform. Pure, so both platforms are testable from either one.
//
// macOS takes its app icon from the .app bundle and draws the tray as a template
// image, which it recolors for the menu bar and pairs with a count from setTitle.
// Elsewhere setTitle and template images do nothing, so the window needs an explicit
// icon, the tray a light glyph for a dark panel, and "needs you" a badged image.

import { join } from "node:path";

export interface TrayIcon {
  path: string;
  template: boolean;
}

export function trayIcon(platform: NodeJS.Platform, buildDir: string, needsYou: number): TrayIcon {
  if (platform === "darwin") return { path: join(buildDir, "trayTemplate.png"), template: true };
  return { path: join(buildDir, needsYou > 0 ? "tray-badged.png" : "tray-light.png"), template: false };
}

export function windowIcon(platform: NodeJS.Platform, buildDir: string): string | undefined {
  return platform === "darwin" ? undefined : join(buildDir, "icon.png");
}
