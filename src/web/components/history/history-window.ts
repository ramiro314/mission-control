import {
  HISTORY_PAGE_LIMITS,
  type HistoryMessagesPage,
  type HistoryPage,
  type HistorySessionSummary,
} from "@shared/history.ts";

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
