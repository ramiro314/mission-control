import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  HISTORY_PAGE_LIMITS,
  type HistoryFacets,
  type HistoryProgress,
  type HistorySessionSummary,
} from "@shared/history.ts";
import { api } from "../../lib/api.ts";
import type { HistoryFilters } from "../../workflows/useWorkflowRoute.ts";
import { appendHistoryRows, historyFilterQuery, readHistoryWindow } from "./history-window.ts";

/**
 * The History page's data, and the only place that talks to `/api/history/sessions`.
 *
 * Two rules, both taken from the Scouts catalog (`useScoutsCatalog.ts`):
 *
 * 1. **A failed read is not an empty history.** The page says "could not ask" differently
 *    from "nothing recorded".
 * 2. **A refresh keeps the depth on screen.** It refetches as many rows as the operator has
 *    paged to, a page at a time past the route's cap, so a "Load more" is never undone. A
 *    change of filters is a different list, so it starts again from one page.
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
  /** What the filters and header offer, from the latest answer; null before the first. */
  facets: HistoryFacets | null;
  listState: HistoryListState;
  listError: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  /** Why the last Load more failed, shown beside the button; cleared by the next attempt. */
  moreError: string | null;
  loadMore: () => void;
  refresh: () => void;
}

export function useHistoryCatalog(filters: HistoryFilters | undefined): HistoryCatalog {
  const [sessions, setSessions] = useState<HistorySessionSummary[]>([]);
  const [progress, setProgress] = useState<HistoryProgress | null>(null);
  const [facets, setFacets] = useState<HistoryFacets | null>(null);
  // Keyed by value, so a route object rebuilt with the same filters is not a new list.
  const filterKey = JSON.stringify(historyFilterQuery(filters));
  const query = useMemo(() => JSON.parse(filterKey) as ReturnType<typeof historyFilterQuery>, [filterKey]);
  /** The filters the depth below was paged under; another set starts again from one page. */
  const depthKey = useRef(filterKey);
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
  /** Whether a window has ever landed. Only a read with nothing on screen yet can fail the page. */
  const hasWindow = useRef(false);
  const listAbort = useRef<AbortController | null>(null);
  const moreAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listAbort.current?.abort();
    listAbort.current = controller;
    moreAbort.current?.abort();
    moreAbort.current = null;
    setLoadingMore(false);
    setMoreError(null);
    if (depthKey.current !== filterKey) {
      depthKey.current = filterKey;
      depth.current = HISTORY_PAGE_LIMITS.defaultLimit;
    }
    void readHistoryWindow((page) => api.historySessions({ ...query, ...page }, controller.signal), depth.current).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) {
        if (!hasWindow.current) {
          setListError(result.error);
          setListState("error");
          return;
        }
        // A background re-read failed (a daemon restart, a busy backfill). The rows on screen
        // are still the last good answer, so they stay, and the poll tries again on schedule.
        setLanded((n) => n + 1);
        return;
      }
      hasWindow.current = true;
      setSessions(result.value.sessions);
      setCursor(result.value.nextCursor);
      setProgress(result.value.progress);
      setFacets(result.value.facets);
      setListError(null);
      setListState("ready");
      setLanded((n) => n + 1);
    });
    return () => controller.abort();
  }, [tick, filterKey, query]);

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
    // A window re-read already in flight was started for the depth before this page. Landing
    // after it, it would replace the appended rows with the shorter window and the older
    // cursor, and if it was the read reporting the backfill done, no poll would follow to put
    // them back. Cancel it: the poll resumes a second after this page lands.
    listAbort.current?.abort();
    setLoadingMore(true);
    setMoreError(null);
    void api.historySessions({ ...query, cursor, limit: HISTORY_PAGE_LIMITS.defaultLimit }, controller.signal).then((result) => {
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
      setFacets(result.value.facets);
    });
  }, [cursor, loadingMore, query]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  return {
    sessions,
    progress,
    facets,
    listState,
    listError,
    hasMore: cursor !== null,
    loadingMore,
    moreError,
    loadMore,
    refresh,
  };
}
