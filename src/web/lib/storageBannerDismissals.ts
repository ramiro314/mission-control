import { z } from "zod";
import type { StorageHealth, StorageProblem } from "@shared/storage-health.ts";

/**
 * Which storage problems this viewer dismissed from the banner, and when each was last seen.
 *
 * Problem ids name one occurrence (`src/shared/storage-health.ts`), so a dismissal keyed by id
 * hides that occurrence and nothing after it: a new problem, or one that clears and recurs,
 * carries a new id and brings the banner back.
 *
 * Every aggregate first refreshes `lastSeenAt` for each dismissed id it still lists, and only
 * then drops entries unseen for longer than the grace. So a dismissal lasts as long as its
 * problem does, survives a recompute that briefly omits it (an `lsof` that timed out, an
 * occupied tree skipped), and goes once the problem has really gone. The grace matches the
 * daemon's first-seen record, `STORAGE_FIRST_SEEN_GRACE_MS`.
 *
 * In localStorage, like `lastRepo.ts` and for its reason: losing it to a new origin costs one
 * more Dismiss click, and a write per aggregate is no traffic for the daemon to carry. The
 * stored record is the truth for every tab on the origin: each change re-reads it before
 * writing, so one tab never writes back a copy that lacks another tab's dismissal.
 */

export const STORAGE_DISMISSAL_GRACE_MS = 60 * 60 * 1_000;
/** A size bound only. The oldest `lastSeenAt` goes first, so live problems are the last. */
export const STORAGE_DISMISSAL_LIMIT = 500;

const KEY = "mission-control.storage-banner.dismissed";

const DismissalsSchema = z.record(z.string(), z.object({ lastSeenAt: z.number() }));

export type StorageDismissals = z.output<typeof DismissalsSchema>;

function capped(entries: StorageDismissals): StorageDismissals {
  const ids = Object.keys(entries);
  if (ids.length <= STORAGE_DISMISSAL_LIMIT) return entries;
  const kept = ids
    .sort((left, right) => entries[right]!.lastSeenAt - entries[left]!.lastSeenAt)
    .slice(0, STORAGE_DISMISSAL_LIMIT);
  return Object.fromEntries(kept.map((id) => [id, entries[id]!]));
}

/** Dismiss every id given, as seen now. */
export function dismissStorageProblems(
  entries: StorageDismissals,
  ids: Iterable<string>,
  now: number,
): StorageDismissals {
  const next = { ...entries };
  for (const id of ids) next[id] = { lastSeenAt: now };
  return capped(next);
}

/** Advance the dismissals by one aggregate: refresh what it lists, then drop the long-gone. */
export function observeStorageProblems(
  entries: StorageDismissals,
  present: Iterable<string>,
  now: number,
): StorageDismissals {
  const seen = new Set(present);
  const next: StorageDismissals = {};
  for (const [id, entry] of Object.entries(entries)) {
    if (seen.has(id)) next[id] = { lastSeenAt: now };
    else if (now - entry.lastSeenAt <= STORAGE_DISMISSAL_GRACE_MS) next[id] = entry;
  }
  return capped(next);
}

/** The bannered problems this viewer has not dismissed. Empty means no banner. */
export function undismissedStorageProblems(
  health: StorageHealth | null,
  entries: StorageDismissals,
): StorageProblem[] {
  return health?.problems.filter((problem) => problem.bannered && !Object.hasOwn(entries, problem.id)) ?? [];
}

/** The last record this tab read or wrote, standing in when storage is unavailable. */
let memory: StorageDismissals = {};

export function readStorageDismissals(): StorageDismissals {
  try {
    const parsed = DismissalsSchema.safeParse(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
    memory = parsed.success ? parsed.data : {};
  } catch {
    /* storage unavailable - dismissals last for this tab only */
  }
  return memory;
}

/** Apply one change to the stored record, as it stands now, and return what was written. */
export function updateStorageDismissals(
  change: (entries: StorageDismissals) => StorageDismissals,
): StorageDismissals {
  memory = change(readStorageDismissals());
  try {
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    /* storage unavailable - dismissals last for this tab only */
  }
  return memory;
}

/** Call `changed` whenever another tab on this origin writes the record. Returns the unsubscribe. */
export function subscribeStorageDismissals(changed: () => void): () => void {
  const listener = (event: StorageEvent): void => {
    if (event.key === KEY || event.key === null) changed();
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
