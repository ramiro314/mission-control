/**
 * Run `fn` as if the dashboard were open on `platform`, through the same preload field the
 * Electron shell sets (`missionDesktop.platform`), so `src/web/lib/platform.ts` is exercised
 * rather than bypassed. Synchronous on purpose: the stub is removed before anything else in
 * the file can observe it.
 */
export function onClientPlatform<T>(platform: "darwin" | "linux", fn: () => T): T {
  const holder = globalThis as { window?: unknown };
  const had = Object.hasOwn(holder, "window");
  const previous = holder.window;
  holder.window = { missionDesktop: { platform } };
  try {
    return fn();
  } finally {
    if (had) holder.window = previous;
    else delete holder.window;
  }
}
