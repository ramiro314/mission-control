import { ghosttyEmulator } from "../../src/server/terminal/ghostty.ts";
import { EMULATORS } from "../../src/server/terminal/registry.ts";

/**
 * Pin this test process's registry to the AppleScript Ghostty, whatever host runs it.
 *
 * For files that use Ghostty as the representative agent-hosting emulator with stable pane
 * UUIDs (`restoreTarget`). Ghostty is picked by platform, and on a Linux runner the
 * spawn-only adapter has neither those UUIDs nor an agent home. Every test file runs in its
 * own process, so the swap stays inside the file that asks for it.
 */
export function pinAppleScriptGhostty(): void {
  EMULATORS.ghostty = ghosttyEmulator(undefined, "darwin");
}
