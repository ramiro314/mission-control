// The main window's frame, per platform. Pure, and electron is imported as a type only, so
// both platforms are testable from either one.
//
// macOS: the app's own dark topbar IS the title bar - no native strip, traffic lights inset
// over the topbar's left padding (see .is-mac .topbar in styles.css). "hiddenInset" would
// park them at the standard y for a 38px bar, ~15px above the centre of our taller topbar
// row; position them explicitly so they line up with the brand instead.
//
// Elsewhere "hidden" without `titleBarOverlay` is a frameless window with no close,
// minimize or maximize, so the window manager draws its own frame. The menu bar hides until
// Alt reveals it, which keeps the topbar the first thing under the frame.

import type { BrowserWindowConstructorOptions } from "electron";

export type WindowChrome = Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "trafficLightPosition" | "autoHideMenuBar"
>;

export function windowChrome(platform: NodeJS.Platform): WindowChrome {
  if (platform === "darwin") return { titleBarStyle: "hidden", trafficLightPosition: { x: 20, y: 28 } };
  return { titleBarStyle: "default", autoHideMenuBar: true };
}
