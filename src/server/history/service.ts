import { open, realpath } from "node:fs/promises";
import {
  HISTORY_MESSAGES_PAGE_TURNS,
  HISTORY_PAGE_LIMITS,
  decodeHistoryCursor,
  historyFilterKinds,
  isHistorySessionId,
  type HistoryLaunchContext,
  type HistoryMessagesPage,
  type HistoryMessagesQuery,
  type HistoryPage,
  type HistorySessionDetail,
  type HistorySessionsQuery,
} from "@shared/history.ts";
import { AGENT_TYPES, type AgentType } from "@shared/types.ts";
import { isInside } from "../archives/paths.ts";
import { historyBatchPauseMs, historyBatchSize, historyReconcileMs, pollIntervalMs } from "../config.ts";
import { RESUME_START_MS } from "../terminal/resume-lease.ts";
import { HistoryReconciler, historyReaders, type HistoryReader, type HistoryReconcilerOptions } from "./reconciler.ts";
import { HistoryResume } from "./resume.ts";
import { HistoryResumeLaunches, trackHistoryResumeLaunches, type HistoryResumeRegistry } from "./resume-launches.ts";
import { historySearchNeedle } from "./search.ts";
import { HistoryStore } from "./store.ts";

/** Discovery's cadence when the poller is switched off: expiry still has to run. */
const RESUME_TICK_FALLBACK_MS = 1_500;

/**
 * How long a Resume waits for its agent before an unbound launch closes: the launch timeout
 * (a managed resume's start deadline), plus two discovery sweeps to see the agent it started.
 */
export function historyResumeGraceMs(): number {
  return RESUME_START_MS + 2 * (pollIntervalMs() ?? RESUME_TICK_FALLBACK_MS);
}

/** The Registry session running an agent's conversation now, or null. Supplied by the routes. */
export type HistoryLiveLookup = (agent: AgentType, agentSessionId: string) => string | null;

/**
 * A conversation window, or why there is none: unknown to History (404), its transcript gone
 * (410), or a transcript still there that could not be read (500, with the reason).
 */
export type HistoryMessagesRead =
  | { ok: true; page: HistoryMessagesPage }
  | { ok: false; status: 404 | 410 | 500; error: string };

/** A session's launch context, or why there is none, on the same terms as `HistoryMessagesRead`. */
export type HistoryLaunchContextRead =
  | { ok: true; context: HistoryLaunchContext }
  | { ok: false; status: 404 | 410 | 500; error: string };

/** Only a missing file is a removed transcript; anything else is a read that failed. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

const GONE = { ok: false, status: 410, error: "transcript removed by Claude Code's retention" } as const;

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
  /** History Resume's launch records. */
  readonly launches: HistoryResumeLaunches;
  /** Resume: options, launch and cancel, over the same catalog. */
  readonly resume: HistoryResume;
  private readonly readers: readonly HistoryReader[];
  private stopResumeTracking: (() => void) | null = null;

  constructor(options: Partial<HistoryReconcilerOptions> & { launches?: HistoryResumeLaunches } = {}) {
    this.store = options.store ?? new HistoryStore();
    this.launches = options.launches ?? new HistoryResumeLaunches();
    this.readers = options.readers ?? historyReaders();
    this.reconciler = new HistoryReconciler({
      intervalMs: historyReconcileMs(),
      batchSize: historyBatchSize(),
      batchPauseMs: historyBatchPauseMs(),
      ...options,
      store: this.store,
      readers: this.readers,
    });
    this.resume = new HistoryResume({
      store: this.store,
      launches: this.launches,
      find: (agent, id) => this.find(agent, id),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  /** Begin indexing in the background. Never awaited: the daemon serves first. */
  start(): void {
    this.reconciler.start();
  }

  stop(): void {
    this.reconciler.stop();
    this.stopResumeTracking?.();
    this.stopResumeTracking = null;
  }

  /**
   * Keep Resume's launch records in step with the Registry: binding, ending, the startup twin
   * after the first discovery sweep, and the grace-window expiry. Idempotent.
   */
  trackResumes(registry: HistoryResumeRegistry): void {
    if (this.stopResumeTracking) return;
    this.stopResumeTracking = trackHistoryResumeLaunches(this.launches, registry, {
      graceMs: historyResumeGraceMs(),
      tickMs: pollIntervalMs() ?? RESUME_TICK_FALLBACK_MS,
    });
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
   */
  async messages(agent: string, id: string, query: HistoryMessagesQuery): Promise<HistoryMessagesRead> {
    const resolved = await this.transcript(agent, id);
    if (!resolved.ok) return resolved;
    const page = resolved.reader.spec.messages.after(resolved.path, Number(query.cursor ?? 0), HISTORY_MESSAGES_PAGE_TURNS);
    return { ok: true, page: { messages: page.messages, nextCursor: page.atEnd ? null : String(page.end) } };
  }

  /**
   * What a session was launched with, parsed from its transcript now. Never cached: the
   * transcript is the only copy, and reading it again is what keeps it the only copy.
   */
  async launchContext(agent: string, id: string): Promise<HistoryLaunchContextRead> {
    const resolved = await this.transcript(agent, id);
    if (!resolved.ok) return resolved;
    try {
      return { ok: true, context: await resolved.reader.spec.launchContext(resolved.path) };
    } catch (error) {
      return isMissing(error) ? GONE : unreadable(error);
    }
  }

  /**
   * The transcript a session's reads open, or why there is none. The path is the catalog's,
   * and it is read only when it resolves under one of its harness's roots, so neither a
   * request nor a rewritten row can point a read anywhere else.
   */
  private async transcript(agent: string, id: string): Promise<
    | { ok: true; reader: HistoryReader; path: string }
    | { ok: false; status: 404 | 410 | 500; error: string }
  > {
    const found = this.find(agent, id);
    if (!found) return { ok: false, status: 404, error: "no such history session" };
    const { reader, entry } = found;
    if (entry.summary.transcriptState === "gone") return GONE;
    let real: string;
    try {
      real = await realpath(entry.transcriptPath);
    } catch (error) {
      // Removed since the last walk: the next one marks the row gone. Any other failure (EACCES,
      // ELOOP) is a transcript still there that cannot be read, and says so rather than
      // blaming retention.
      return isMissing(error) ? GONE : unreadable(error);
    }
    const roots = await Promise.all(reader.spec.roots().map((root) => realpath(root).catch(() => null)));
    if (!roots.some((root) => root !== null && isInside(root, real))) {
      return { ok: false, status: 404, error: "no such history session" };
    }
    // `after()` answers an unreadable file with an empty, finished page, which is right for a
    // collector and wrong here: it would read as an empty conversation, or end one early. So
    // the file is opened first, and only a readable regular file reaches a reader.
    try {
      const handle = await open(real, "r");
      try {
        if (!(await handle.stat()).isFile()) return unreadable(new Error("not a regular file"));
      } finally {
        await handle.close();
      }
    } catch (error) {
      return isMissing(error) ? GONE : unreadable(error);
    }
    return { ok: true, reader, path: real };
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
