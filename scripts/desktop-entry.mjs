// The Linux desktop entry: how the operator launches the built desktop shell from the app menu,
// and the XDG autostart copy behind the tray's "Start at login".
//
// On Linux the checkout is the install (docs/setup.md), so the entry runs this checkout's own
// Electron against the bundles `make build` wrote, with no dev server. Updating is
// `git pull && make build`; the entry never needs rewriting. `scripts/install-desktop-entry.mjs`
// installs it, and the shell imports the paths and the autostart toggle from here, so this
// module stays free of `import.meta`, which the shell's CommonJS bundle cannot evaluate.

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DESKTOP_ENTRY_FILE = "mission-control.desktop";

export const LINUX_ONLY_MESSAGE =
  "The desktop entry is for Linux; on macOS install the app with `make install`.";

/** Where the entry and its autostart copy live, honoring XDG_DATA_HOME and XDG_CONFIG_HOME. */
export function desktopEntryPaths({ env = process.env, home = homedir() } = {}) {
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  return {
    entry: join(dataHome, "applications", DESKTOP_ENTRY_FILE),
    autostart: join(configHome, "autostart", DESKTOP_ENTRY_FILE),
  };
}

// Desktop Entry Specification: a string value escapes its backslashes. An Exec argument is
// double-quoted, and inside the quotes `"`, `` ` ``, `$` and `\` take a backslash before that
// string escaping applies; `%` starts a field code unless doubled.
const stringValue = (value) => value.replaceAll("\\", "\\\\");
const execArg = (value) =>
  stringValue(`"${value.replace(/["`$\\]/g, "\\$&")}"`).replaceAll("%", "%%");

/** The entry's text: the checkout's Electron, given the checkout as its app, with the app icon. */
export function desktopEntry({ electron, checkout }) {
  return `[Desktop Entry]
Type=Application
Name=Mission Control
Comment=Local control plane for Claude Code, Codex and Pi sessions
Exec=${execArg(electron)} ${execArg(checkout)}
Icon=${stringValue(join(checkout, "build", "icon.png"))}
Terminal=false
Categories=Development;
StartupNotify=true
`;
}

const realFs = {
  exists: existsSync,
  copy: copyFileSync,
  remove: (path) => rmSync(path, { force: true }),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
};

/**
 * The tray's "Start at login" on Linux. It is on when the autostart copy exists, and can be
 * turned on only while the entry it copies is installed. Turning it on copies the entry as it
 * is, so login starts exactly what the app menu starts.
 */
export function linuxAutostart(paths = desktopEntryPaths(), fs = realFs) {
  return {
    installed: () => fs.exists(paths.entry),
    enabled: () => fs.exists(paths.autostart),
    set(enabled) {
      if (!enabled) {
        fs.remove(paths.autostart);
        return;
      }
      if (!fs.exists(paths.entry)) throw new Error(`The desktop entry is not installed: ${paths.entry}`);
      fs.mkdir(dirname(paths.autostart));
      fs.copy(paths.entry, paths.autostart);
    },
  };
}
