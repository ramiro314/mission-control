import {
  HISTORY_PAGE_LIMITS,
  decodeHistoryCursor,
  historyFilterKinds,
  type HistoryPage,
  type HistorySessionsQuery,
} from "@shared/history.ts";
import { historyBatchPauseMs, historyBatchSize, historyReconcileMs } from "../config.ts";
import { HistoryReconciler, type HistoryReconcilerOptions } from "./reconciler.ts";
import { historySearchNeedle } from "./search.ts";
import { HistoryStore } from "./store.ts";

/**
 * Session History's one owner in the daemon: the catalog store and the reconciler that fills
 * it. Constructed once in `index.ts` and handed to the routes, so there is never a second
 * walker or a second writer.
 */
export class HistoryService {
  readonly store: HistoryStore;
  readonly reconciler: HistoryReconciler;

  constructor(options: Partial<HistoryReconcilerOptions> = {}) {
    this.store = options.store ?? new HistoryStore();
    this.reconciler = new HistoryReconciler({
      intervalMs: historyReconcileMs(),
      batchSize: historyBatchSize(),
      batchPauseMs: historyBatchPauseMs(),
      ...options,
      store: this.store,
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
  list(query: HistorySessionsQuery): HistoryPage {
    return this.store.page({
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
  }
}
