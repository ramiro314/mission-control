import type { SessionRuntime } from "@shared/types.ts";

// Session runtimes per platform: which ones this platform can run, and why not when it cannot.
//
// Every door that would open a session on a runtime asks here first and refuses with the
// sentence below, so a platform without a runtime gets a stated reason rather than a backend
// failing somewhere further in. Terminal discovery asks too, because it exists only to find the
// terminal runtime's sessions.
//
// win32 runs the Agent SDK runtime only, for now (D9 in `docs/plans/windows-support/plan.md`).
// The terminal runtime, its backends and terminal discovery wait for the WezTerm milestone.

const unavailableOn: Partial<Record<NodeJS.Platform, Partial<Record<SessionRuntime, string>>>> = {
  win32: {
    terminal:
      "The terminal runtime is not available on Windows yet, so Mission Control runs sessions there through the Agent SDK.",
  },
};

/** Why `runtime` cannot run on `platform`, or null when it can. */
export function runtimeUnavailableWhy(
  runtime: SessionRuntime,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return unavailableOn[platform]?.[runtime] ?? null;
}
