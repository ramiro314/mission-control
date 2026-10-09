import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  nativeProcessInspectionAddonPath,
  validateNativeProcessInspectionBinding,
  type NativeProcessInspectionBinding,
} from "../../src/server/process-inspection-native.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Provision and load the win32 process inspection addon.
 *
 * `pretest` builds only the state lock, and a CI unit shard never runs `npm run build:native`, so
 * a spec that exercises the real addon builds it itself rather than inheriting it from whatever
 * else its shard was dealt. The load decides whether to build, as `ensureNativeStateLockAddon`
 * does: a missing addon, a truncated one and one built for another Node release are all repaired
 * by the same rebuild, and a warm checkout compiles nothing.
 */
export function ensureNativeProcessInspectionAddon(): NativeProcessInspectionBinding {
  const addon = nativeProcessInspectionAddonPath();
  try {
    return validateNativeProcessInspectionBinding(require(addon));
  } catch {
    delete require.cache[addon];
    execFileSync(process.execPath, ["scripts/build-process-inspection-native.mjs"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
  }
  return validateNativeProcessInspectionBinding(require(addon));
}
