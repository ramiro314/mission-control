export function clearDarwinProvenance(
  path: string,
  platform?: NodeJS.Platform,
  execute?: typeof import("node:child_process").execFileSync,
): boolean;

export interface NativeAddonPublishFs {
  rename: typeof import("node:fs/promises").rename;
  readdir: (path: string) => Promise<string[]>;
  rm: typeof import("node:fs/promises").rm;
}

export const RETIRED_ADDON_PREFIX: string;

export const WIN32_PUBLISH_ATTEMPTS: number;

export function publishNativeAddon(
  built: string,
  output: string,
  platform?: NodeJS.Platform,
  fs?: NativeAddonPublishFs,
): Promise<void>;
