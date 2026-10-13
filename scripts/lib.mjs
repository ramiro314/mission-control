// Shared, dependency-free helpers for the standalone setup scripts
// (init / new-session / worktree-setup). These run under bare `node`, so this
// stays plain JS with no build step and no imports beyond node builtins.

import { execFileSync } from "node:child_process";

/**
 * True when `bin` is on PATH. Asks the POSIX shell's `command -v` rather than `which`, which
 * is not installed everywhere (Arch's `base` lacks it). `bin` is passed as `$1`, never spliced
 * into the script.
 */
export function have(bin) {
  try {
    execFileSync("/bin/sh", ["-c", 'command -v "$1"', "sh", bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
