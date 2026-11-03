import { open, realpath } from "node:fs/promises";
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

/**
 * A conversation window, or why there is none: unknown to History (404), its transcript gone
 * (410), or a transcript still there that could not be read (500, with the reason).
 */
export type HistoryMessagesRead =
  | { ok: true; page: HistoryMessagesPage }
  | { ok: false; status: 404 | 410 | 500; error: string };

/** Only a missing file is a removed transcript; anything else is a read that failed. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function unreadable(error: unknown): { ok: false; status: 500; error: string } {
  const reason = (error as NodeJS.ErrnoException | null)?.code ?? (error instanceof Error ? error.message : String(error));
  return { ok: false, status: 500, error: `could not read this transcript (${reason})` };
}

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
        // The default list is conversations, and a session a task ran is one whatever its kind.
        taskBoundIsConversation: query.kind === undefined,
        needle: historySearchNeedle(query.q),
        repo: query.repo ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
        agent: query.agent ?? null,
        link: query.link ?? null,
        outcome: query.outcome ?? null,
        pr: query.pr ?? null,
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

  /**
   * One session's row, live status and what Mission Control knows about it. With no catalog
   * row, a record built from Mission Control's data alone when a task binding or a Mission
   * Control session names the id: its transcript was deleted before it was ever indexed. Null
   * only when neither knows it. Nothing is written for such a record.
   */
  detail(agent: string, id: string, live: HistoryLiveLookup): HistorySessionDetail | null {
    const reader = this.readerFor(agent, id);
    if (!reader) return null;
    const agentSessionId = id.toLowerCase();
    const entry = this.store.entry(reader.agent, agentSessionId);
    const liveSessionId = live(reader.agent, agentSessionId);
    if (entry) return { catalog: this.store.withMissions([{ ...entry.summary, liveSessionId }])[0]! };
    const mission = this.store.missions(reader.agent, [agentSessionId]).get(agentSessionId) ?? null;
    // A ledger row alone does not name a session: its note key is not always an agent session id.
    if (!mission || (mission.task === null && mission.missionSessionId === null)) return null;
    return { catalog: null, mission: { ...mission, agent: reader.agent, agentSessionId, liveSessionId } };
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
    let real: string;
    try {
      real = await realpath(entry.transcriptPath);
    } catch (error) {
      // Removed since the last walk: the next one marks the row gone. Any other failure (EACCES,
      // ELOOP) is a transcript still there that cannot be read, and says so rather than
      // blaming retention.
      return isMissing(error) ? gone : unreadable(error);
    }
    const roots = await Promise.all(reader.spec.roots().map((root) => realpath(root).catch(() => null)));
    if (!roots.some((root) => root !== null && isInside(root, real))) {
      return { ok: false, status: 404, error: "no such history session" };
    }
    // `after()` answers an unreadable file with an empty, finished page, which is right for a
    // collector and wrong here: it would read as an empty conversation, or end one early. So
    // the file is opened first, and only a readable regular file reaches it.
    try {
      const handle = await open(real, "r");
      try {
        if (!(await handle.stat()).isFile()) return unreadable(new Error("not a regular file"));
      } finally {
        await handle.close();
      }
    } catch (error) {
      return isMissing(error) ? gone : unreadable(error);
    }
    const page = reader.spec.messages.after(real, Number(query.cursor ?? 0), HISTORY_MESSAGES_PAGE_TURNS);
    return { ok: true, page: { messages: page.messages, nextCursor: page.atEnd ? null : String(page.end) } };
  }

  /** The reader for a request's agent and id, or null for anything History cannot address. */
  private readerFor(agent: string, id: string): HistoryReader | null {
    if (!(AGENT_TYPES as readonly string[]).includes(agent) || !isHistorySessionId(id)) return null;
    return this.readers.find((candidate) => candidate.agent === agent) ?? null;
  }

  /** The reader and the row for a request's agent and id, or null for anything History cannot address. */
  private find(agent: string, id: string) {
    const reader = this.readerFor(agent, id);
    if (!reader) return null;
    const entry = this.store.entry(reader.agent, id.toLowerCase());
    return entry ? { reader, entry } : null;
  }
}
