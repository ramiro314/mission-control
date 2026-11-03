import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptMessage } from "@shared/types.ts";
import { readConversationWindow, type HistoryMessagesRead } from "./history-window.ts";

export type ConversationState = "loading" | "ready" | "gone" | "error";

/**
 * A History transcript read forward from the top, a window at a time: a session's own
 * conversation, or one of its subagent runs. `read` fetches one window; `key` names what is
 * being read, so a change of it starts over.
 */
export function useHistoryConversation(
  read: (cursor: string | null, signal: AbortSignal) => Promise<HistoryMessagesRead>,
  key: string,
  enabled: boolean,
) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<ConversationState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const reader = useRef(read);
  reader.current = read;

  const fetchWindow = useCallback((from: string | null, append: boolean) => {
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    if (append) setLoadingMore(true);
    setError(null);
    void readConversationWindow((next) => reader.current(next, controller.signal), from).then((result) => {
      if (controller.signal.aborted) return;
      setLoadingMore(false);
      if (!result.ok) {
        if (result.status === 410) setState("gone");
        else if (append) setError(result.error);
        else {
          setError(result.error);
          setState("error");
        }
        return;
      }
      setMessages((prev) => (append ? [...prev, ...result.value.messages] : result.value.messages));
      setCursor(result.value.nextCursor);
      setState("ready");
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setMessages([]);
    setCursor(null);
    setState("loading");
    fetchWindow(null, false);
    return () => abort.current?.abort();
  }, [enabled, key, fetchWindow]);

  return {
    messages,
    state,
    error,
    loadingMore,
    hasMore: cursor !== null,
    loadMore: () => { if (cursor && !loadingMore) fetchWindow(cursor, true); },
    retry: () => fetchWindow(null, false),
  };
}
