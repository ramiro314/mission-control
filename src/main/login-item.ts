// The tray's "Start at login", per platform. macOS (and Windows) use Electron's login item.
// Electron has none on Linux, so there it is the XDG autostart copy of the desktop entry that
// `make desktop-entry` installs, and it is disabled with a hint until that entry exists.

import { linuxAutostart, type LinuxAutostart } from "../../scripts/desktop-entry.mjs";

export const DESKTOP_ENTRY_HINT = "Needs the desktop entry: run make desktop-entry";

export interface LoginItemPort {
  get(): boolean;
  set(enabled: boolean): void;
}

export interface StartAtLogin {
  checked: boolean;
  enabled: boolean;
  /** A disabled line under the checkbox saying why it cannot be turned on. */
  hint: string | null;
  set(enabled: boolean): void;
}

export function startAtLogin(
  platform: NodeJS.Platform,
  electron: LoginItemPort,
  autostart: LinuxAutostart = linuxAutostart(),
): StartAtLogin {
  if (platform !== "linux") {
    return { checked: electron.get(), enabled: true, hint: null, set: (on) => electron.set(on) };
  }
  const installed = autostart.installed();
  const checked = autostart.enabled();
  // A copy left behind by a removed entry can still be turned off.
  return {
    checked,
    enabled: installed || checked,
    hint: installed ? null : DESKTOP_ENTRY_HINT,
    set: (on) => autostart.set(on),
  };
}
