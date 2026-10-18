import type { ReactNode } from "react";

import { relativeTime, uptime } from "../lib/format.ts";
import { useClockValue } from "../useNow.ts";

/**
 * Text that depends on the wall clock, kept current without re-rendering its parent.
 *
 * Renders bare text, no wrapper element, so it drops into an existing `<span>` or a
 * sentence unchanged. It re-renders when `read`'s answer changes and at no other time.
 *
 * `now` pins the instant instead, for a surface whose own `now` prop is injected - a render
 * test, a Settings preview - so the text is a pure function of props and never ticks.
 */
export function ClockText({ read, now }: { read: (now: number) => string; now?: number }): ReactNode {
  return useClockValue((tick) => read(now ?? tick));
}

/** `relativeTime(at)` ("12s ago", "5m ago") that keeps advancing on its own. */
export function RelativeTime({ at, now }: { at: number | null; now?: number }): ReactNode {
  return useClockValue((tick) => relativeTime(at, now ?? tick));
}

/** A session's "last seen": how long since its last activity, or its uptime before any. */
export function LastSeen({ lastActivity, startedAt }: {
  lastActivity: number | null;
  startedAt: number | null;
}): ReactNode {
  return useClockValue((now) => (lastActivity ? relativeTime(lastActivity, now) : uptime(startedAt, now)));
}
