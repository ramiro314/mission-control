// The desktop shell's per-platform choices that are not the application menu (that one is
// `menu-template.ts`): which tray image to load, and what window chrome to ask for.
//
// Like `menu-template.ts`, nothing here imports `electron` at runtime, so `test/` can pin
// both answers for every platform in milliseconds. macOS is the shape the shell was built
// for and every other platform but win32 keeps it unchanged; win32 differs where the macOS
// answer does not work there.

import type { BrowserWindowConstructorOptions } from "electron";
import { join } from "node:path";

export interface TrayIcon {
  path: string;
  /**
   * Whether to mark the image as a macOS template. A template is drawn as a black mask that
   * the menu bar recolors for light and dark; nothing recolors it on the Windows taskbar, so
   * there it would be a black shape on a dark bar.
   */
  template: boolean;
}

/**
 * The tray image under `buildDir` (the repository's `build/`), both generated from its SVGs
 * by `scripts/gen-icons.mjs`.
 *
 * win32 gets `tray.ico`, the colored app icon at every size the notification area asks for
 * across display scales. Everywhere else gets the monochrome template PNG, whose `@2x`
 * sibling Electron picks up on its own.
 */
export function trayIcon(platform: NodeJS.Platform, buildDir: string): TrayIcon {
  return platform === "win32"
    ? { path: join(buildDir, "tray.ico"), template: false }
    : { path: join(buildDir, "trayTemplate.png"), template: true };
}

/** The two calls `trayImageFor` makes on an image, so a test can stand in for `nativeImage`. */
export interface TrayImage {
  isEmpty(): boolean;
  setTemplateImage(option: boolean): void;
}

/**
 * Load `icon` through `load` and mark it a template only when `icon` says so, falling back to
 * `empty()` when the file is missing or unreadable. `tray.ts` passes `nativeImage`; this is
 * where the win32 icon stays colored rather than becoming a black mask.
 */
export function trayImageFor<I extends TrayImage>(
  icon: TrayIcon,
  load: (path: string) => I | null,
  empty: () => I,
): I {
  const img = icon.path ? load(icon.path) : null;
  if (!img || img.isEmpty()) return empty();
  if (icon.template) img.setTemplateImage(true); // recolors for light/dark menu bars
  return img;
}

/**
 * The window's title-bar options.
 *
 * On macOS the dashboard's own topbar is the title bar: no native strip, and the traffic
 * lights inset over the topbar's left padding (see `.is-desktop .topbar` in styles.css).
 * "hiddenInset" would park them at the standard y for a 38px bar, ~15px above the centre of
 * the taller topbar row, so they are positioned explicitly to line up with the brand.
 *
 * On win32 `titleBarStyle: "hidden"` removes the window controls along with the title bar,
 * leaving a window that cannot be minimized, maximized or closed from its own frame. It keeps
 * the native frame instead, and hides the menu bar until Alt is pressed so the dashboard is
 * not pushed down by a strip of menus; the menu's accelerators work either way.
 */
export function windowChrome(
  platform: NodeJS.Platform,
): Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "trafficLightPosition" | "autoHideMenuBar"> {
  return platform === "win32"
    ? { autoHideMenuBar: true }
    : { titleBarStyle: "hidden", trafficLightPosition: { x: 20, y: 28 } };
}
