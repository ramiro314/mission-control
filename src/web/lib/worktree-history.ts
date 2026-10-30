import type { WorktreeSlotHistoryPage } from "@shared/protocol.ts";

/**
 * What an open list holds once a refresh of its newest page lands. Rows are append-only, so a
 * page that reaches what is shown adds only what is newer, and the older rows and their cursor
 * stay: replacing them would lose the row at the cursor to a Show older still in flight, which
 * the refreshed page has pushed past its end and the older page starts below. A page that does
 * not reach what is shown has an unknown gap under it, so it starts the list again.
 */
export function refreshedSlotHistory(
  shown: WorktreeSlotHistoryPage | null,
  page: WorktreeSlotHistoryPage,
): WorktreeSlotHistoryPage {
  const newest = shown?.entries[0]?.id;
  const oldest = page.entries.at(-1)?.id;
  if (!shown || newest === undefined || oldest === undefined || oldest > newest) return page;
  return {
    entries: [...page.entries.filter((entry) => entry.id > newest), ...shown.entries],
    nextBefore: page.nextBefore === null ? null : shown.nextBefore,
  };
}
