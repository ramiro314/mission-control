import {
  HISTORY_PAGE_LIMITS,
  type HistoryPage,
  type HistorySessionSummary,
  type HistorySessionsQuery,
} from "@shared/history.ts";
import type { HistoryFilters } from "../../workflows/useWorkflowRoute.ts";

/** The list route's filter parameters: everything in a query but the page position. */
export type HistoryFilterQuery = Omit<HistorySessionsQuery, "cursor" | "limit">;

/** Local midnight at the start of a `YYYY-MM-DD` day, `days` later. */
function localDay(day: string, days = 0): number {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return Math.max(0, new Date(year, month - 1, date + days).getTime());
}

/**
 * The route's filters as the list route takes them. The date range is the operator's local
 * calendar days, both inclusive, so `to` becomes the next local midnight, which the route
 * treats as exclusive.
 */
export function historyFilterQuery(filters: HistoryFilters | undefined): HistoryFilterQuery {
  return {
    ...(filters?.q?.trim() ? { q: filters.q.trim() } : {}),
    ...(filters?.repo ? { repo: filters.repo } : {}),
    ...(filters?.from ? { from: localDay(filters.from) } : {}),
    ...(filters?.to ? { to: localDay(filters.to, 1) } : {}),
    ...(filters?.kind ? { kind: filters.kind } : {}),
    ...(filters?.agent ? { agent: filters.agent } : {}),
  };
}

/** What one page read returns: the page, or why it could not be read. */
export type HistoryPageRead =
  | { ok: true; value: HistoryPage }
  | { ok: false; error: string };

/** The window a refresh rebuilt: every row down to the depth asked for, and where to go next. */
export interface HistoryWindow {
  sessions: HistorySessionSummary[];
  nextCursor: string | null;
  progress: HistoryPage["progress"];
  facets: HistoryPage["facets"];
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
 * move the cursor back. Progress and facets are the first page's, the freshest view of both.
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
  return { ok: true, value: { sessions, nextCursor, progress: first.value.progress, facets: first.value.facets } };
}
