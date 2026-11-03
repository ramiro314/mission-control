import {
  HISTORY_PAGE_LIMITS,
  HISTORY_SEARCH_LIMITS,
  encodeHistoryCursor,
  type HistoryMessagesPage,
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
 * treats as exclusive. A search longer than the route accepts, from a pasted link, is cut to
 * that length rather than sent to be refused.
 */
export function historyFilterQuery(filters: HistoryFilters | undefined): HistoryFilterQuery {
  return {
    ...(filters?.q?.trim() ? { q: filters.q.trim().slice(0, HISTORY_SEARCH_LIMITS.queryChars) } : {}),
    ...(filters?.repo ? { repo: filters.repo } : {}),
    ...(filters?.from ? { from: localDay(filters.from) } : {}),
    ...(filters?.to ? { to: localDay(filters.to, 1) } : {}),
    ...(filters?.kind ? { kind: filters.kind } : {}),
    ...(filters?.agent ? { agent: filters.agent } : {}),
    ...(filters?.link ? { link: filters.link } : {}),
    ...(filters?.outcome ? { outcome: filters.outcome } : {}),
    ...(filters?.pr ? { pr: filters.pr } : {}),
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
 * Re-read the window from the top down to `depth` rows, a page at a time, and on down to
 * `through`, the last row on screen, when sessions that started since push it further down.
 *
 * One request caps at `maxLimit` rows, so a window the operator paged past that must be read
 * in several. Replacing it with only its first page would drop every row below the cap and
 * move the cursor back. Reading only `depth` rows would do the same on a smaller scale once a
 * new session lands above them: the oldest row would fall off and Load more come back. The
 * search for `through` reaches at most one capped page past the depth (a row whose kind
 * changed can leave the list), and the window is cut right after it, with the cursor the
 * route itself would give for that row. Progress and facets are the first page's, the freshest
 * view of both.
 */
export async function readHistoryWindow(
  read: (query: { cursor?: string; limit: number }) => Promise<HistoryPageRead>,
  depth: number,
  through: HistorySessionSummary | null = null,
): Promise<{ ok: true; value: HistoryWindow } | { ok: false; error: string }> {
  const wanted = Math.max(HISTORY_PAGE_LIMITS.defaultLimit, depth);
  const reach = wanted + HISTORY_PAGE_LIMITS.maxLimit;
  const throughKey = through ? rowKey(through) : null;
  const throughAt = (): number => (throughKey === null ? -1 : sessions.findIndex((row) => rowKey(row) === throughKey));
  const first = await read({ limit: Math.min(HISTORY_PAGE_LIMITS.maxLimit, wanted) });
  if (!first.ok) return first;
  let sessions = first.value.sessions;
  let nextCursor = first.value.nextCursor;
  while (nextCursor && (sessions.length < wanted || (throughKey !== null && sessions.length < reach && throughAt() === -1))) {
    const limit = Math.min(HISTORY_PAGE_LIMITS.maxLimit, (sessions.length < wanted ? wanted : reach) - sessions.length);
    const page = await read({ cursor: nextCursor, limit });
    if (!page.ok) return page;
    const before = sessions.length;
    sessions = appendHistoryRows(sessions, page.value.sessions);
    nextCursor = page.value.nextCursor;
    // A page that added nothing cannot advance the window; stop rather than loop.
    if (sessions.length === before) break;
  }
  const keep = Math.max(wanted, throughAt() + 1);
  if (keep < sessions.length) {
    const last = sessions[keep - 1]!;
    sessions = sessions.slice(0, keep);
    nextCursor = encodeHistoryCursor({ lastActivityAt: last.lastActivityAt, agent: last.agent, agentSessionId: last.agentSessionId });
  }
  return { ok: true, value: { sessions, nextCursor, progress: first.value.progress, facets: first.value.facets } };
}

/**
 * How many empty windows one conversation read steps over before handing control back. A window
 * can hold no turn at all (one tool result fatter than the read budget), and that is not the end
 * of the conversation.
 */
export const EMPTY_WINDOW_HOPS = 20;

/** What one conversation window read returns, with the HTTP status of a refusal. */
export type HistoryMessagesRead =
  | { ok: true; value: HistoryMessagesPage }
  | { ok: false; error: string; status?: number };

/**
 * Read a session's conversation forward from `cursor`, stepping over windows that held no turn,
 * at most `EMPTY_WINDOW_HOPS` of them. Returns the first window with a turn, the last window, a
 * failure, or the empty window the cap stopped on (whose cursor the next read continues from).
 */
export async function readConversationWindow(
  read: (cursor: string | null) => Promise<HistoryMessagesRead>,
  cursor: string | null,
): Promise<HistoryMessagesRead> {
  let next = cursor;
  for (let hop = 0; ; hop++) {
    const result = await read(next);
    if (!result.ok || result.value.messages.length > 0 || !result.value.nextCursor || hop >= EMPTY_WINDOW_HOPS) {
      return result;
    }
    next = result.value.nextCursor;
  }
}
