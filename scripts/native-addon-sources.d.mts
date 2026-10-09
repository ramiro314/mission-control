export type NativeAddon = "state-lock" | "keep-awake" | "process-inspection";

export const NATIVE_ADDON_SOURCES: Record<NativeAddon, Partial<Record<string, readonly string[]>>>;

export function hasNativeAddonSources(addon: NativeAddon, platform: string): boolean;
export function nativeAddonSources(addon: NativeAddon, platform: string): readonly string[];
export function gypSourcesArgs(sources: readonly string[]): string[];
