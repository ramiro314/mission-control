import type { ProcessInspector } from "./contract.ts";
import { posixProcessInspector } from "./posix.ts";
import { win32ProcessInspector } from "./win32.ts";

export { flattenProcessText, type ProcessInspector, type ProcessRow, type ProcessTable } from "./contract.ts";

/**
 * The platform-selection point. A platform without `ps` and `lsof` registers its own
 * inspector here; every other platform, macOS and Linux included, gets the POSIX one.
 */
const PLATFORM_INSPECTORS: Partial<Record<NodeJS.Platform, ProcessInspector>> = {
  win32: win32ProcessInspector,
};

export function processInspectorFor(platform: NodeJS.Platform): ProcessInspector {
  return PLATFORM_INSPECTORS[platform] ?? posixProcessInspector;
}

/** The inspector for the platform this process runs on. */
export function processInspector(): ProcessInspector {
  return processInspectorFor(process.platform);
}
