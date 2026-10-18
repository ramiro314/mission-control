import type { ReactNode } from "react";

import { relativeTime, uptime } from "../lib/format.ts";
import { useClockValue, useNow } from "../useNow.ts";

/**
 * Text that depends on the wall clock, kept current without re-rendering its parent.
 *
 * Renders bare text, no wrapper element, so it drops into an existing `<span>` or a
 * sentence unchanged. It re-renders when `read`'s answer changes and at no other time.
 */
export function ClockText({ read }: { read: (now: number) => string }): ReactNode {
  return useClockValue(read);
}

/** `relativeTime(at)` ("12s ago", "5m ago") that keeps advancing on its own. */
export function RelativeTime({ at }: { at: number | null }): ReactNode {
  return useClockValue((now) => relativeTime(at, now));
}

/** A session's "last seen": how long since its last activity, or its uptime before any. */
export function LastSeen({ lastActivity, startedAt }: {
  lastActivity: number | null;
  startedAt: number | null;
}): ReactNode {
  return useClockValue((now) => (lastActivity ? relativeTime(lastActivity, now) : uptime(startedAt, now)));
}

/**
 * Hands a once-a-second instant to `children`, re-rendering only what they return.
 *
 * For a surface that takes a `now` prop and folds it into more than one label, where moving
 * every label onto `ClockText` would mean rewriting the surface rather than feeding it.
 */
export function WithNow({ children }: { children: (now: number) => ReactNode }): ReactNode {
  return children(useNow(true));
}
