// Not dead code. React 19.2's development build records a `performance.measure()` entry for
// component renders to feed DevTools "Performance Tracks", each carrying a structured-clone
// `detail` payload, and nothing ever clears them. In a long-lived dev dashboard that timeline
// grew by about 300 entries a second, to over a million an hour and gigabytes of renderer
// memory, until the kernel OOM-killed the Electron renderer. Production builds use React's
// production bundle, which records none, so `main.tsx` installs this only under
// `import.meta.env.DEV`. React records no marks, so only measures are cleared.

export const PERFORMANCE_TIMELINE_CLEAR_INTERVAL_MS = 60_000;

interface TimelineHost {
  performance?: Pick<Performance, "clearMeasures">;
  setInterval(handler: () => void, ms: number): unknown;
}

/**
 * Clear the page's performance measures every `intervalMs`, so React's development
 * Performance Tracks entries cannot accumulate without limit. Returns false, and schedules
 * nothing, when the host has no `performance.clearMeasures`.
 */
export function boundPerformanceTimeline(
  host: TimelineHost = globalThis,
  intervalMs: number = PERFORMANCE_TIMELINE_CLEAR_INTERVAL_MS,
): boolean {
  const performance = host.performance;
  if (typeof performance?.clearMeasures !== "function") return false;
  host.setInterval(() => performance.clearMeasures(), intervalMs);
  return true;
}
