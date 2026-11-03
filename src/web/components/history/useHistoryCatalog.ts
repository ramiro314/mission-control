import { useCallback, useEffect, useRef, useState } from "react";
import { HISTORY_PAGE_LIMITS, type HistoryProgress, type HistorySessionSummary } from "@shared/history.ts";
import { api } from "../../lib/api.ts";
import { appendHistoryRows, readHistoryWindow } from "./history-window.ts";

/**
 * The History page's data, and the only place that talks to `/api/history/sessions`.
 *
 * Two rules, both taken from the Scouts catalog (`useScoutsCatalog.ts`):
 *
 * 1. **A failed read is not an empty history.** The page says "could not ask" differently
 *    from "nothing recorded".
 * 2. **A refresh keeps the depth on screen.** It refetches as many rows as the operator has
 *    paged to, a page at a time past the route's cap, and on down to the last row on screen
 *    when new sessions land above it, so a "Load more" is never undone.
 *
 * While the catalog reports a backfill in progress, the window is refetched a second after each
 * answer lands, so sessions appear as they are indexed. That poll stops the moment indexing does.
 * After that the browser never polls: `revision` (the event stream's `historyRevision`, bumped by
 * each `history_changed` and each reconnect) refetches the window when a session starts or grows.
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

export function useHistoryCatalog(revision: number): HistoryCatalog {
  const [sessions, setSessions] = useState<HistorySessionSummary[]>([]);
  /** The rows on screen as of the last render, so a refresh can keep down to the last of them. */
  const onScreen = useRef(sessions);
  onScreen.current = sessions;
  /** The newest `history_changed` revision, as of the last render. */
  const latestRevision = useRef(revision);
  latestRevision.current = revision;
  /**
   * The revision the last window that LANDED was read for. Set when an answer arrives, never
   * when a read starts: a read that Load more cancels has shown nothing, so the change it was
   * asked for is still unread.
   */
  const readRevision = useRef(revision);
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
  /** Whether a window has ever landed. Only a read with nothing on screen yet can fail the page. */
  const hasWindow = useRef(false);
  const listAbort = useRef<AbortController | null>(null);
  const moreAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const askedRevision = latestRevision.current;
    listAbort.current?.abort();
    listAbort.current = controller;
    moreAbort.current?.abort();
    moreAbort.current = null;
    setLoadingMore(false);
    void readHistoryWindow(
      (query) => api.historySessions(query, controller.signal),
      depth.current,
      onScreen.current.at(-1) ?? null,
    ).then((result) => {
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
      readRevision.current = askedRevision;
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

  // A changed catalog re-reads the window at its current depth. Held while a Load more is in
  // flight, for the poll's reason above, and taken as soon as it lands: the revision it waited
  // on is still newer than the one last read. That holds from the other side too: a re-read
  // already in flight when Load more is clicked is cancelled by it, never lands, and so leaves
  // its revision unread for this effect to take when Load more lands.
  useEffect(() => {
    if (revision === readRevision.current || loadingMore) return;
    setTick((n) => n + 1);
  }, [revision, loadingMore]);

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
