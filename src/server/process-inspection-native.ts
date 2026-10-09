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
/** A creation time in 100-nanosecond ticks since 1601, in decimal, and the raw command line. */
export type NativeProcessIdentity = { start: string; command: string } | NativeProcessReadFailure;

/**
 * `native/process-inspection`, built on win32 only. `owners` and `cwds` answer one entry per
 * pid, in the order given, and `identity` answers one pid. None of them decides anything:
 * `process-inspection/win32.ts` owns what each failure means.
 */
export interface NativeProcessInspectionBinding {
  owners(pids: readonly number[]): NativeProcessOwner[];
  cwds(pids: readonly number[]): NativeProcessCwd[];
  identity(pid: number): NativeProcessIdentity;
}

/**
 * The same addon's job objects, the win32 stand-in for a workflow Check's process group. Every
 * job is keyed by the pid of the process it was created for and lives only in this process:
 * `workflows/check-group-win32.ts` owns what each answer means.
 */
export interface NativeCheckJobBinding {
  /** Put `pid` in a fresh job that ends with its last handle; `true`, or why not. */
  jobAssign(pid: number): true | NativeProcessReadFailure;
  /** How many processes the job still holds, null when this process holds no job for `pid`. */
  jobActive(pid: number): number | null | NativeProcessReadFailure;
  /** End every process in the job; false when this process holds no job for `pid`. */
  jobTerminate(pid: number): boolean | NativeProcessReadFailure;
  /** Close the job's handle, which also ends anything still in it. */
  jobRelease(pid: number): boolean;
}

/**
 * The addon's third export, which the daemon never calls: the parser `cwds` runs on a live
 * process, run over byte images of an address space instead. `images` are successive snapshots
 * of the region starting at `base` (each re-read takes the next, and the last repeats), `peb` is
 * the PEB's address in it, and `wow64` selects the 32-bit layout. It lets a test drive the layout
 * checks with structures no live process would hand over.
 */
export interface NativeCwdImageReader {
  readCwdFromImages(images: readonly Uint8Array[], base: number, peb: number, wow64: boolean): NativeProcessCwd;
}

type RequireFn = (id: string) => unknown;

/**
 * Both source (`src/server/`) and bundle (`dist/server/`) execution are two
 * directories below the repository's `dist/native` directory.
 */
export function nativeProcessInspectionAddonPath(moduleUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../../dist/native/process-inspection.node");
}

function exportsFunctions(value: unknown, names: readonly string[]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    names.every((name) => typeof (value as Record<string, unknown>)[name] === "function")
  );
}

/**
 * Every export is required, so an addon built before one was added fails here and is rebuilt
 * (`npm run build:native`), rather than loading with a read missing.
 */
export function validateNativeProcessInspectionBinding(value: unknown): NativeProcessInspectionBinding {
  if (!exportsFunctions(value, ["owners", "cwds", "identity"])) {
    throw new Error("native process inspection addon must export owners, cwds and identity functions");
  }
  return value as NativeProcessInspectionBinding;
}

export function validateNativeCheckJobBinding(value: unknown): NativeCheckJobBinding {
  if (!exportsFunctions(value, ["jobAssign", "jobActive", "jobTerminate", "jobRelease"])) {
    throw new Error("native process inspection addon must export jobAssign, jobActive, jobTerminate and jobRelease");
  }
  return value as NativeCheckJobBinding;
}

/** Load and validate the native module. Loading it has no side effects. */
export function loadNativeProcessInspectionBinding(
  requireFn: RequireFn = createRequire(import.meta.url),
): NativeProcessInspectionBinding {
  return validateNativeProcessInspectionBinding(requireFn(nativeProcessInspectionAddonPath()));
}

/** The job half of the same module. Node loads an addon once, so both halves share its jobs. */
export function loadNativeCheckJobBinding(
  requireFn: RequireFn = createRequire(import.meta.url),
): NativeCheckJobBinding {
  return validateNativeCheckJobBinding(requireFn(nativeProcessInspectionAddonPath()));
}
