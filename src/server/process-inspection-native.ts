import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A pid the addon could not read: the step that failed, and its Win32 error (0 for `exited`). */
export interface NativeProcessReadFailure {
  failed: string;
  code: number;
}

export type NativeProcessOwner = { sameUser: boolean } | NativeProcessReadFailure;
export type NativeProcessCwd = { cwd: string } | NativeProcessReadFailure;

/**
 * `native/process-inspection`, built on win32 only. Each function answers one entry per pid, in
 * the order given, and decides nothing: `process-inspection/win32.ts` owns what each failure
 * means.
 */
export interface NativeProcessInspectionBinding {
  owners(pids: readonly number[]): NativeProcessOwner[];
  cwds(pids: readonly number[]): NativeProcessCwd[];
}

type RequireFn = (id: string) => unknown;

/**
 * Both source (`src/server/`) and bundle (`dist/server/`) execution are two
 * directories below the repository's `dist/native` directory.
 */
export function nativeProcessInspectionAddonPath(moduleUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../../dist/native/process-inspection.node");
}

export function validateNativeProcessInspectionBinding(value: unknown): NativeProcessInspectionBinding {
  if (
    typeof value !== "object" ||
    value === null ||
    !("owners" in value) ||
    typeof value.owners !== "function" ||
    !("cwds" in value) ||
    typeof value.cwds !== "function"
  ) {
    throw new Error("native process inspection addon must export owners and cwds functions");
  }
  return value as NativeProcessInspectionBinding;
}

/** Load and validate the side-effect-free native module. */
export function loadNativeProcessInspectionBinding(
  requireFn: RequireFn = createRequire(import.meta.url),
): NativeProcessInspectionBinding {
  return validateNativeProcessInspectionBinding(requireFn(nativeProcessInspectionAddonPath()));
}
