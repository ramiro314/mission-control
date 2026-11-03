import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  HISTORY_MESSAGES_PAGE_TURNS,
  HISTORY_PAGE_LIMITS,
  HISTORY_TOOL_RESULT_CAP,
  decodeHistoryCursor,
  historyFilterKinds,
  isHistorySessionId,
  isHistorySubagentId,
  isHistoryToolUseId,
  type HistoryMessagesPage,
  type HistoryMessagesQuery,
  type HistoryPage,
  type HistorySessionDetail,
  type HistorySessionsQuery,
  type HistoryToolResult,
} from "@shared/history.ts";
import { AGENT_TYPES, type AgentType } from "@shared/types.ts";
import { isInside } from "../archives/paths.ts";
import { historyBatchPauseMs, historyBatchSize, historyReconcileMs } from "../config.ts";
import { HistoryReconciler, historyReaders, type HistoryReader, type HistoryReconcilerOptions } from "./reconciler.ts";
import { historySearchNeedle } from "./search.ts";
import { HistoryStore } from "./store.ts";
import type { TranscriptMessages } from "../harness/types.ts";

/** The Registry session running an agent's conversation now, or null. Supplied by the routes. */
export type HistoryLiveLookup = (agent: AgentType, agentSessionId: string) => string | null;

/**
 * A conversation window, or why there is none: unknown to History (404), its transcript gone
 * (410), or a transcript still there that could not be read (500, with the reason).
 */
export type HistoryMessagesRead = HistoryRead<HistoryMessagesPage>;

/** A History read that is either its value, or a refusal with the HTTP status that says why. */
export type HistoryRead<T> =
  | { ok: true; page: T }
  | { ok: false; status: 404 | 410 | 500; error: string };

type HistoryRefusal = { ok: false; status: 404 | 410 | 500; error: string };

const UNKNOWN: HistoryRefusal = { ok: false, status: 404, error: "no such history session" };
const GONE: HistoryRefusal = { ok: false, status: 410, error: "transcript removed by Claude Code's retention" };

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
 * One forward window of a transcript already resolved and confined.
 *
 * `after()` answers an unreadable file with an empty, finished page, which is right for a
 * collector and wrong here: it would read as an empty conversation, or end one early. So the
 * file is opened first, and only a readable regular file reaches it.
 */
async function readWindow(reader: TranscriptMessages, path: string, query: HistoryMessagesQuery): Promise<HistoryMessagesRead> {
  try {
    const handle = await open(path, "r");
    try {
      if (!(await handle.stat()).isFile()) return unreadable(new Error("not a regular file"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    return isMissing(error) ? GONE : unreadable(error);
  }
  const page = reader.after(path, Number(query.cursor ?? 0), HISTORY_MESSAGES_PAGE_TURNS);
  return { ok: true, page: { messages: page.messages, nextCursor: page.atEnd ? null : String(page.end) } };
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

  /**
   * One session's row, live status and subagent runs, or null when History does not know it.
   * The subagents are listed only while the transcript is there and readable.
   */
  async detail(agent: string, id: string, live: HistoryLiveLookup): Promise<HistorySessionDetail | null> {
    const found = this.find(agent, id);
    if (!found) return null;
    const { summary } = found.entry;
    const transcript = await this.transcript(agent, id);
    const subagents = transcript.ok
      ? (await found.reader.spec.subagents(transcript.page.path, summary.agentSessionId))
        .map(({ path: _path, folder: _folder, ...run }) => run)
      : [];
    return { session: { ...summary, liveSessionId: live(summary.agent, summary.agentSessionId) }, subagents };
  }

  /**
   * One window of a session's conversation, read forward from `cursor` (the top when absent).
   * The path is the catalog's, and it is read only when it resolves under one of its harness's
   * roots, so neither a request nor a rewritten row can point a read anywhere else.
   */
  async messages(agent: string, id: string, query: HistoryMessagesQuery): Promise<HistoryMessagesRead> {
    const transcript = await this.transcript(agent, id);
    if (!transcript.ok) return transcript;
    return readWindow(transcript.page.reader.spec.messages, transcript.page.path, query);
  }

  /**
   * One tool call's result. `toolUseId` is format-checked and then only looked up in the
   * parent transcript; it never becomes part of a path. A result kept in a sidecar file is
   * read through the file name its own record gives, and only when that file resolves inside
   * the session's own `tool-results/` folder.
   */
  async toolResult(agent: string, id: string, toolUseId: string): Promise<HistoryRead<HistoryToolResult>> {
    if (!isHistoryToolUseId(toolUseId)) return { ok: false, status: 404, error: "no such tool call" };
    const transcript = await this.transcript(agent, id);
    if (!transcript.ok) return transcript;
    const { reader, entry, path } = transcript.page;
    let recorded;
    try {
      recorded = await reader.spec.toolResult(path, entry.summary.agentSessionId, toolUseId);
    } catch (error) {
      return isMissing(error) ? GONE : unreadable(error);
    }
    if (!recorded) return { ok: false, status: 404, error: "no result is recorded for this tool call" };
    if (!recorded.sidecar) {
      const truncated = recorded.text.length > HISTORY_TOOL_RESULT_CAP;
      return {
        ok: true,
        page: {
          toolUseId,
          source: "inline",
          isError: recorded.isError,
          text: truncated ? recorded.text.slice(0, HISTORY_TOOL_RESULT_CAP) : recorded.text,
          truncated,
        },
      };
    }
    const unavailable: HistoryRefusal = { ok: false, status: 404, error: "this result's file is not available" };
    const { folder, name } = recorded.sidecar;
    let real: string;
    try {
      real = await realpath(join(folder, name));
    } catch {
      return unavailable;
    }
    if (real === folder || !isInside(folder, real)) return unavailable;
    try {
      const handle = await open(real, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return unavailable;
        const buffer = Buffer.alloc(Math.min(stat.size, HISTORY_TOOL_RESULT_CAP));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return {
          ok: true,
          page: {
            toolUseId,
            source: "sidecar",
            isError: recorded.isError,
            text: buffer.toString("utf8", 0, bytesRead),
            truncated: stat.size > HISTORY_TOOL_RESULT_CAP,
          },
        };
      } finally {
        await handle.close();
      }
    } catch {
      return unavailable;
    }
  }

  /**
   * One window of a subagent run's transcript. `agentId` is format-checked and names a file
   * only when the session's own `subagents/` listing holds it, and that file is read only when
   * it resolves inside that folder.
   */
  async subagentMessages(agent: string, id: string, agentId: string, query: HistoryMessagesQuery): Promise<HistoryMessagesRead> {
    const unknown: HistoryRefusal = { ok: false, status: 404, error: "no such subagent run" };
    if (!isHistorySubagentId(agentId)) return unknown;
    const transcript = await this.transcript(agent, id);
    if (!transcript.ok) return transcript;
    const { reader, entry, path } = transcript.page;
    const run = await reader.spec.subagentFile(path, entry.summary.agentSessionId, agentId);
    if (!run) return unknown;
    let real: string;
    try {
      real = await realpath(run.path);
    } catch {
      return unknown;
    }
    if (real === run.folder || !isInside(run.folder, real)) return unknown;
    return readWindow(reader.spec.subagentMessages, real, query);
  }

  /**
   * The session's transcript, resolved: its real path, confirmed under one of its harness's
   * roots. A gone row or a missing file is 410; a file there but unreadable is a 500.
   */
  private async transcript(agent: string, id: string): Promise<HistoryRead<{
    reader: HistoryReader;
    entry: NonNullable<ReturnType<HistoryStore["entry"]>>;
    path: string;
  }>> {
    const found = this.find(agent, id);
    if (!found) return UNKNOWN;
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
    if (!roots.some((root) => root !== null && isInside(root, real))) return UNKNOWN;
    return { ok: true, page: { reader, entry, path: real } };
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
