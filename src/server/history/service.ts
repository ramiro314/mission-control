import { realpath } from "node:fs/promises";
import {
  HISTORY_MESSAGES_PAGE_TURNS,
  HISTORY_PAGE_LIMITS,
  decodeHistoryCursor,
  historyFilterKinds,
  isHistorySessionId,
  type HistoryMessagesPage,
  type HistoryMessagesQuery,
  type HistoryPage,
  type HistorySessionDetail,
  type HistorySessionsQuery,
} from "@shared/history.ts";
import { AGENT_TYPES, type AgentType } from "@shared/types.ts";
import { isInside } from "../archives/paths.ts";
import { historyBatchPauseMs, historyBatchSize, historyReconcileMs } from "../config.ts";
import { HistoryReconciler, historyReaders, type HistoryReader, type HistoryReconcilerOptions } from "./reconciler.ts";
import { historySearchNeedle } from "./search.ts";
import { HistoryStore } from "./store.ts";

/** The Registry session running an agent's conversation now, or null. Supplied by the routes. */
export type HistoryLiveLookup = (agent: AgentType, agentSessionId: string) => string | null;

/** A conversation window, or why there is none: unknown to History, or its transcript is gone. */
export type HistoryMessagesRead =
  | { ok: true; page: HistoryMessagesPage }
  | { ok: false; status: 404 | 410; error: string };

/**
 * Session History's one owner in the daemon: the catalog store and the reconciler that fills
 * it. Constructed once in `index.ts` and handed to the routes, so there is never a second
 * walker or a second writer.
 */
export class HistoryService {
  readonly store: HistoryStore;
  readonly reconciler: HistoryReconciler;
  private readonly readers: readonly HistoryReader[];

  constructor(options: Partial<HistoryReconcilerOptions> = {}) {
    this.store = options.store ?? new HistoryStore();
    this.readers = options.readers ?? historyReaders();
    this.reconciler = new HistoryReconciler({
      intervalMs: historyReconcileMs(),
      batchSize: historyBatchSize(),
      batchPauseMs: historyBatchPauseMs(),
      ...options,
      store: this.store,
      readers: this.readers,
    });
  }

  /** Begin indexing in the background. Never awaited: the daemon serves first. */
  start(): void {
    this.reconciler.start();
  }

  stop(): void {
    this.reconciler.stop();
  }

  /**
   * One page of matching sessions, newest activity first, with backfill progress and what the
   * filters and header offer. With no Kind filter, conversations only.
   */
  list(query: HistorySessionsQuery, live: HistoryLiveLookup): HistoryPage {
    const page = this.store.page({
      filter: {
        kinds: historyFilterKinds(query.kind),
        needle: historySearchNeedle(query.q),
        repo: query.repo ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
        agent: query.agent ?? null,
      },
      cursor: query.cursor ? decodeHistoryCursor(query.cursor) : null,
      limit: query.limit ?? HISTORY_PAGE_LIMITS.defaultLimit,
      progress: this.reconciler.progress(),
      facets: {
        agents: this.reconciler.agents(),
        repositories: this.store.repositories(),
        retention: this.reconciler.retention(),
      },
    });
    return {
      ...page,
      sessions: page.sessions.map((row) => ({ ...row, liveSessionId: live(row.agent, row.agentSessionId) })),
    };
  }

  /** One session's row and live status, or null when History does not know it. */
  detail(agent: string, id: string, live: HistoryLiveLookup): HistorySessionDetail | null {
    const found = this.find(agent, id);
    if (!found) return null;
    const { summary } = found.entry;
    return { session: { ...summary, liveSessionId: live(summary.agent, summary.agentSessionId) } };
  }

  /**
   * One window of a session's conversation, read forward from `cursor` (the top when absent).
   * The path is the catalog's, and it is read only when it resolves under one of its harness's
   * roots, so neither a request nor a rewritten row can point a read anywhere else.
   */
  async messages(agent: string, id: string, query: HistoryMessagesQuery): Promise<HistoryMessagesRead> {
    const found = this.find(agent, id);
    if (!found) return { ok: false, status: 404, error: "no such history session" };
    const { reader, entry } = found;
    const gone = { ok: false, status: 410, error: "transcript removed by Claude Code's retention" } as const;
    if (entry.summary.transcriptState === "gone") return gone;
    const real = await realpath(entry.transcriptPath).catch(() => null);
    // Removed since the last walk: the next one marks the row gone.
    if (real === null) return gone;
    const roots = await Promise.all(reader.spec.roots().map((root) => realpath(root).catch(() => null)));
    if (!roots.some((root) => root !== null && isInside(root, real))) {
      return { ok: false, status: 404, error: "no such history session" };
    }
    const page = reader.spec.messages.after(real, Number(query.cursor ?? 0), HISTORY_MESSAGES_PAGE_TURNS);
    return { ok: true, page: { messages: page.messages, nextCursor: page.atEnd ? null : String(page.end) } };
  }

  /** The reader and the row for a request's agent and id, or null for anything History cannot address. */
  private find(agent: string, id: string) {
    if (!(AGENT_TYPES as readonly string[]).includes(agent) || !isHistorySessionId(id)) return null;
    const reader = this.readers.find((candidate) => candidate.agent === agent);
    if (!reader) return null;
    const entry = this.store.entry(reader.agent, id.toLowerCase());
    return entry ? { reader, entry } : null;
  }
}
