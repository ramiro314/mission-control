// "A poll that read nothing new changes nothing."
//
// Every poller parses a fresh object out of each response, so handing that straight to a
// state setter is a new reference every tick even when the daemon said exactly what it said
// last time - and a new reference re-renders the hook's owner and everything beneath it.
// For the hooks App owns, that was the whole dashboard, several times every few seconds,
// on a screen where nothing had moved.

/**
 * `prev` when `next` serializes the same, otherwise `next`.
 *
 * Compared through `JSON.stringify`, the same shortcut the daemon's `recomputeFleetCost`
 * takes and for the same reason: these values are parsed JSON from one serializer, so key
 * order is stable and string equality is structural equality. A false "changed" (an
 * optimistic copy whose keys were spread in another order) costs one render, never a stale
 * value.
 */
export function keepIfUnchanged<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev;
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}
