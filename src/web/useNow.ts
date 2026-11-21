import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * The wall clock, advancing every `everyMs` (a second by default) while `ticking` - and not at
 * all otherwise.
 *
 * A caller that renders several clocks holds ONE of these and passes the instant down, so a
 * stage of three running members re-renders once a second rather than three times, and every
 * clock on screen reads the same second. A clock that only reads minutes or hours asks for a
 * slower tick rather than stopping, so it never freezes at the last value it showed.
 */
export function useNow(ticking: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [ticking, everyMs]);
  return now;
}

/**
 * One shared one-second clock for every `useClockValue` on screen.
 *
 * Module scope rather than a hook's state, so a board of fifty "6s ago" labels runs one
 * interval rather than fifty, and every label reads the same second. It runs only while
 * something subscribes. Exported for its tests; components reach it through `useClockValue`.
 */
export const secondClock = (() => {
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (timer === null) {
        now = Date.now();
        timer = setInterval(() => {
          now = Date.now();
          for (const notify of listeners) notify();
        }, 1000);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    read(): number {
      // Nothing subscribed means nothing has been advancing the stored instant, so a first
      // render after a quiet spell would print a stale age. Refreshed only when it is over a
      // second old, so the two reads React makes of one render still agree.
      if (timer === null && Date.now() - now >= 1000) now = Date.now();
      return now;
    },
  };
})();

/**
 * Something derived from the wall clock, re-rendering its caller only when it CHANGES.
 *
 * A render that reads `Date.now()` is only as current as the last unrelated re-render, which
 * is how the dashboard's "6s ago" labels came to be advanced by whatever poll happened to
 * land. This gives a label its own clock instead, and because React compares what `read`
 * returns, "5m ago" re-renders once a minute, not once a second. Return a primitive (a
 * string, usually): a fresh object or array would compare unequal on every tick.
 */
export function useClockValue<T extends string | number | boolean | null | undefined>(
  read: (now: number) => T,
): T {
  return useSyncExternalStore(secondClock.subscribe, () => read(secondClock.read()), () => read(Date.now()));
}
