import { HISTORY_PAGE_LIMITS, type HistoryPage, type HistorySessionSummary } from "@shared/history.ts";

/** What one page read returns: the page, or why it could not be read. */
export type HistoryPageRead =
  | { ok: true; value: HistoryPage }
  | { ok: false; error: string };

/** The window a refresh rebuilt: every row down to the depth asked for, and where to go next. */
export interface HistoryWindow {
  sessions: HistorySessionSummary[];
  nextCursor: string | null;
  progress: HistoryPage["progress"];
}

function rowKey(row: HistorySessionSummary): string {
  return `${row.agent}:${row.agentSessionId}`;
}

/** Append a continuation, dropping rows the window already holds. */
export function appendHistoryRows(
  prev: readonly HistorySessionSummary[],
  incoming: readonly HistorySessionSummary[],
): HistorySessionSummary[] {
  const seen = new Set(prev.map(rowKey));
  return [...prev, ...incoming.filter((row) => !seen.has(rowKey(row)))];
}

/**
 * Re-read the window from the top down to `depth` rows, a page at a time.
 *
 * One request caps at `maxLimit` rows, so a window the operator paged past that must be read
 * in several. Replacing it with only its first page would drop every row below the cap and
 * move the cursor back. Progress is the first page's, the freshest view of the backfill.
 */
export async function readHistoryWindow(
  read: (query: { cursor?: string; limit: number }) => Promise<HistoryPageRead>,
  depth: number,
): Promise<{ ok: true; value: HistoryWindow } | { ok: false; error: string }> {
  const wanted = Math.max(HISTORY_PAGE_LIMITS.defaultLimit, depth);
  const first = await read({ limit: Math.min(HISTORY_PAGE_LIMITS.maxLimit, wanted) });
  if (!first.ok) return first;
  let sessions = first.value.sessions;
  let nextCursor = first.value.nextCursor;
  while (nextCursor && sessions.length < wanted) {
    const page = await read({ cursor: nextCursor, limit: Math.min(HISTORY_PAGE_LIMITS.maxLimit, wanted - sessions.length) });
    if (!page.ok) return page;
    const before = sessions.length;
    sessions = appendHistoryRows(sessions, page.value.sessions);
    nextCursor = page.value.nextCursor;
    // A page that added nothing cannot advance the window; stop rather than loop.
    if (sessions.length === before) break;
  }
  return { ok: true, value: { sessions, nextCursor, progress: first.value.progress } };
}
