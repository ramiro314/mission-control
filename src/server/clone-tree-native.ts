import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The macOS tree clone: one clonefile(2) call for a whole seed path, run as Node-API async work
 * off the event loop. The promise settles only after the syscall returned, and a refusal rejects
 * with an Error carrying the positive `errno`. It never falls back to a byte copy.
 */
export interface NativeCloneTreeBinding {
  clone(source: string, destination: string): Promise<void>;
}

type RequireFn = (id: string) => unknown;

/**
 * Both source (`src/server/`) and bundle (`dist/server/`) execution are two
 * directories below the repository's `dist/native` directory.
 */
export function nativeCloneTreeAddonPath(moduleUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../../dist/native/clone-tree.node");
}

export function validateNativeCloneTreeBinding(value: unknown): NativeCloneTreeBinding {
  if (typeof value !== "object" || value === null || !("clone" in value) || typeof value.clone !== "function") {
    throw new Error("native clone-tree addon must export a clone function");
  }
  return value as NativeCloneTreeBinding;
}

/** Load and validate the side-effect-free native module without cloning anything. */
export function loadNativeCloneTreeBinding(
  requireFn: RequireFn = createRequire(import.meta.url),
): NativeCloneTreeBinding {
  return validateNativeCloneTreeBinding(requireFn(nativeCloneTreeAddonPath()));
}
