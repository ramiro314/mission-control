import { createRequire } from "node:module";
import { nativeStateLockAddonPath } from "../state-ownership-native.ts";
import { physicalPathSync } from "./physical-path.ts";

interface NativeOpenedPathBinding {
  openedPath(fd: number): string;
}

export function validateNativeOpenedPathBinding(value: unknown): NativeOpenedPathBinding {
  if (typeof value !== "object" || value === null || !("openedPath" in value)
    || typeof value.openedPath !== "function") {
    // Coded so a refusal can name it: an addon built before `openedPath` existed still lets
    // the daemon start, and only evidence notices.
    throw Object.assign(new Error("native filesystem addon must export openedPath"), {
      code: "ERR_OPENED_PATH_EXPORT_MISSING",
    });
  }
  return value as NativeOpenedPathBinding;
}

const require = createRequire(import.meta.url);

/**
 * The physical path of the file an open descriptor refers to, read from the descriptor rather
 * than from any name, so a directory renamed or relinked after the open cannot change it.
 *
 * linux reads `/proc/self/fd`, and win32 asks the descriptor's handle through the state-lock
 * addon (`GetFinalPathNameByHandleW`). Both answer in the spelling `physicalPathSync` gives,
 * so the result compares directly with a root it physicalized. darwin does not need one,
 * because evidence there resolves and opens in one step with `O_NOFOLLOW_ANY`, so every
 * platform but these two refuses.
 */
export function openedPathSync(fd: number, platform: NodeJS.Platform = process.platform): string {
  if (platform === "linux") return physicalPathSync(`/proc/self/fd/${fd}`, platform);
  if (platform === "win32") {
    return validateNativeOpenedPathBinding(require(nativeStateLockAddonPath())).openedPath(fd);
  }
  throw new Error(`descriptor paths cannot be read on ${platform}`);
}
