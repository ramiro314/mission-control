import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { hasNativeAddonSources } from "../../scripts/native-addon-sources.mjs";
import {
  nativeProcessInspectionAddonPath,
  validateNativeCheckJobBinding,
  validateNativeProcessInspectionBinding,
  type NativeCheckJobBinding,
  type NativeCwdImageReader,
  type NativeProcessInspectionBinding,
} from "../../src/server/process-inspection-native.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);

type TestBinding = NativeProcessInspectionBinding & NativeCheckJobBinding & NativeCwdImageReader;

/**
 * Provision and load the win32 process inspection addon.
 *
 * `pretest` builds only the state lock, and a CI unit shard never runs `npm run build:native`, so
 * a spec that exercises the real addon builds it itself rather than inheriting it from whatever
 * else its shard was dealt. The load decides whether to build, as `ensureNativeStateLockAddon`
 * does: a missing addon, a truncated one, one built for another Node release and one built
 * before `readCwdFromImages`, `identity` or the job functions existed are all repaired by the
 * same rebuild, and a warm checkout compiles nothing.
 */
export function ensureNativeProcessInspectionAddon(): TestBinding {
  const addon = nativeProcessInspectionAddonPath();
  try {
    return validate(require(addon));
  } catch {
    delete require.cache[addon];
    execFileSync(process.execPath, ["scripts/build-process-inspection-native.mjs"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
  }
  return validate(require(addon));
}

/**
 * For a spec that runs real check commands or reads real worktree occupancy: the addon where
 * this platform builds one (win32, whose check identities, check jobs, process owners and cwds
 * come from it), and nothing where `ps` and `lsof` answer instead. Called at module scope, before
 * anything loads the addon.
 */
export function provisionNativeProcessInspection(): void {
  if (hasNativeAddonSources("process-inspection", process.platform)) ensureNativeProcessInspectionAddon();
}

function validate(value: unknown): TestBinding {
  validateNativeCheckJobBinding(value);
  const binding = validateNativeProcessInspectionBinding(value);
  if (typeof (binding as Partial<NativeCwdImageReader>).readCwdFromImages !== "function") {
    throw new Error("native process inspection addon predates readCwdFromImages");
  }
  return binding as TestBinding;
}
