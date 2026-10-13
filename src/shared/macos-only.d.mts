// Hand-written types for macos-only.mjs, so Electron main imports the same refusal the bare-node
// scripts print. Same arrangement as github-sso.d.mts.

export const MACOS_ONLY_MESSAGE: string;

/** The refusal for a packaged-app command on `platform`, or null on macOS. */
export function macOSOnlyRefusal(platform: string): string | null;
