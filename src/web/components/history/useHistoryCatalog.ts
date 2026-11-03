import { useCallback, useEffect, useRef, useState } from "react";
import { HISTORY_PAGE_LIMITS, type HistoryProgress, type HistorySessionSummary } from "@shared/history.ts";
import { api } from "../../lib/api.ts";

/**
 * The History page's data, and the only place that talks to `/api/history/sessions`.
 *
 * Two rules, both taken from the Scouts catalog (`useScoutsCatalog.ts`):
 *
 * 1. **A failed read is not an empty history.** The page says "could not ask" differently
 *    from "nothing recorded".
 * 2. **A refresh keeps the depth on screen.** It refetches as many rows as the operator has
 *    paged to, so a "Load more" is never silently undone.
 *
 * While the catalog reports a backfill in progress, the window is refetched a second after each
 * answer lands, so sessions appear as they are indexed. That poll stops the moment indexing does. Live updates
 * after the first run belong to the `history_changed` event, which is a later change.
 */

/** How often an indexing catalog is re-read. */
const INDEXING_REFRESH_MS = 1000;

export type HistoryListState = "first" | "ready" | "error";

export interface HistoryCatalog {
  sessions: HistorySessionSummary[];
  progress: HistoryProgress | null;
  listState: HistoryListState;
  listError: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  /** Why the last Load more failed, shown beside the button; cleared by the next attempt. */
  moreError: string | null;
  loadMore: () => void;
  refresh: () => void;
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

export function useHistoryCatalog(): HistoryCatalog {
  const [sessions, setSessions] = useState<HistorySessionSummary[]>([]);
  const [progress, setProgress] = useState<HistoryProgress | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listState, setListState] = useState<HistoryListState>("first");
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  /** Bumped when a window lands. The indexing poll waits on this, never on a timer alone. */
  const [landed, setLanded] = useState(0);
  /** Rows the operator has paged to; a refresh asks for at least this many. */
  const depth = useRef<number>(HISTORY_PAGE_LIMITS.defaultLimit);
  const listAbort = useRef<AbortController | null>(null);
  const moreAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listAbort.current?.abort();
    listAbort.current = controller;
    moreAbort.current?.abort();
    moreAbort.current = null;
    setLoadingMore(false);
    const limit = Math.min(HISTORY_PAGE_LIMITS.maxLimit, Math.max(HISTORY_PAGE_LIMITS.defaultLimit, depth.current));
    void api.historySessions({ limit }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setListError(result.error);
        setListState("error");
        return;
      }
      setSessions(result.value.sessions);
      setCursor(result.value.nextCursor);
      setProgress(result.value.progress);
      setListError(null);
      setListState("ready");
      setLanded((n) => n + 1);
    });
    return () => controller.abort();
  }, [tick]);

  // Re-read while the first backfill runs, so rows appear as they are indexed. The next read is
  // scheduled only after the previous one landed: keyed on the request instead, a read slower
  // than the interval would be aborted by the next one every time, and the list would freeze
  // on its first answer while the poll ran on for ever. It also holds off while a Load more is
  // in flight, because a re-read starts a new window and aborts the continuation: on a daemon
  // slowed by the backfill, Load more would otherwise never land until indexing finished.
  const indexing = progress?.indexing === true;
  useEffect(() => {
    if (!indexing || loadingMore) return;
    const timer = setTimeout(() => setTick((n) => n + 1), INDEXING_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [indexing, landed, loadingMore]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    const controller = new AbortController();
    moreAbort.current?.abort();
    moreAbort.current = controller;
    setLoadingMore(true);
    setMoreError(null);
    void api.historySessions({ cursor, limit: HISTORY_PAGE_LIMITS.defaultLimit }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setLoadingMore(false);
      if (!result.ok) {
        setMoreError(result.error);
        return;
      }
      setSessions((prev) => {
        const next = appendHistoryRows(prev, result.value.sessions);
        depth.current = next.length;
        return next;
      });
      setCursor(result.value.nextCursor);
      setProgress(result.value.progress);
    });
  }, [cursor, loadingMore]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  return {
    sessions,
    progress,
    listState,
    listError,
    hasMore: cursor !== null,
    loadingMore,
    moreError,
    loadMore,
    refresh,
  };
}
