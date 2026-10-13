// The platform of the machine the dashboard is USED on, which is not the daemon's: a browser
// on a Linux laptop can reach a daemon on a Mac. Keyboard handling is the reason this exists,
// because the primary modifier is Command on macOS and Ctrl everywhere else (see
// `keybindings.ts`), and every keyboard site asks this one helper.
//
// The Electron preload exposes `process.platform` as `missionDesktop.platform`. A browser
// falls back to `navigator.userAgentData.platform` (Chromium), then the older
// `navigator.platform`.

interface NavigatorWithUserAgentData {
  userAgentData?: { platform?: string };
  platform?: string;
}

/**
 * The client's platform as its source spells it (`"darwin"`, `"linux"`, `"macOS"`,
 * `"Linux x86_64"`, ...), or null when nothing reports one.
 *
 * Read through `globalThis.window` rather than the bare `navigator` global, because Node has
 * a `navigator` of its own and a unit test that never stood up a window must not quietly
 * answer with the test runner's OS.
 */
export function clientPlatform(): string | null {
  const win = (globalThis as { window?: Window }).window;
  if (!win) return null;
  const nav = win.navigator as NavigatorWithUserAgentData | undefined;
  return win.missionDesktop?.platform || nav?.userAgentData?.platform || nav?.platform || null;
}

/**
 * Whether the client is a Mac, so `cmd` means Command rather than Ctrl.
 *
 * True when no platform is known at all, which is outside a browser: that is the behavior
 * this keyboard code had before it knew platforms existed, and every Linux branch is pinned by
 * a test that names its platform.
 */
export function isMacClient(): boolean {
  const platform = clientPlatform();
  if (platform === null) return true;
  return platform === "darwin" || /^(mac|iphone|ipad|ipod)/i.test(platform);
}
