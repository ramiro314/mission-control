import type { DatabaseSync } from "node:sqlite";
import {
  encodeHistoryCursor,
  type HistoryFacets,
  type HistoryListCursor,
  type HistoryProgress,
  type HistoryPage,
  type HistorySessionSummary,
  type HistoryTranscriptState,
} from "@shared/history.ts";
import type { AgentType } from "@shared/types.ts";
import { openDb } from "../db.ts";
import type { HistoryFingerprint, HistoryParsePoint, HistorySummary } from "../harness/types.ts";
import { historyFieldsSegment } from "./search.ts";

/**
 * The Session History catalog: `history_sessions` row mechanics only. When to write is the
 * reconciler's policy; this file owns how. The daemon is the only writer.
 */

/** What the reconciler needs to decide whether a file changed, without loading the row. */
export interface HistoryIndexEntry {
  agentSessionId: string;
  transcriptPath: string;
  fingerprint: HistoryFingerprint | null;
  transcriptState: HistoryTranscriptState;
}

/** One row to write: where it came from, how far it was parsed, and what it says. */
export interface HistoryUpsert {
  agent: AgentType;
  agentSessionId: string;
  transcriptPath: string;
  fingerprint: HistoryFingerprint;
  parsedBytes: number;
  readerState: string | null;
  repoRoot: string | null;
  summary: HistorySummary;
  /** Used for `last_activity_at` when no record carried a timestamp: the file's mtime. */
  fallbackActivityAt: number;
  /** What `history_search_segments` holds for this row, already folded. */
  search: HistorySearchWrite;
}

/**
 * One row's search text. `fields` replaces ordinal 0. `prompts` are appended after the
 * row's last prompt segment, or replace every one of them when `resetPrompts` is set.
 */
export interface HistorySearchWrite {
  fields: string;
  prompts: readonly string[];
  resetPrompts: boolean;
}

/** The list's filters, already validated and resolved by the service. */
export interface HistoryListFilter {
  kinds: readonly string[];
  /** A folded search needle, or null. */
  needle: string | null;
  repo: string | null;
  /** Epoch ms bounds on `last_activity_at`: `from` inclusive, `to` exclusive. */
  from: number | null;
  to: number | null;
  agent: AgentType | null;
}

interface Row {
  agent: string;
  agent_session_id: string;
  transcript_path: string;
  fingerprint: string;
  parsed_bytes: number;
  reader_state: string | null;
  transcript_state: string;
  gone_at: number | null;
  cwd: string | null;
  repo_root: string | null;
  branch: string | null;
  entrypoint: string | null;
  version: string | null;
  kind: string;
  custom_title: string | null;
  ai_title: string | null;
  first_prompt: string | null;
  started_at: number | null;
  last_activity_at: number;
  duration_ms: number | null;
  model: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  lines_added: number | null;
  lines_removed: number | null;
  pr_urls: string;
  continued_in: string | null;
  subagent_count: number;
}

function parseFingerprint(raw: string): HistoryFingerprint | null {
  try {
    const value = JSON.parse(raw) as Partial<HistoryFingerprint>;
    return typeof value.size === "number" && typeof value.mtimeMs === "number" && typeof value.ino === "number"
      ? { size: value.size, mtimeMs: value.mtimeMs, ino: value.ino }
      : null;
  } catch {
    return null;
  }
}

function parseUrls(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((url): url is string => typeof url === "string") : [];
  } catch {
    return [];
  }
}

function toSummary(row: Row): HistorySessionSummary {
  return {
    agent: row.agent as AgentType,
    agentSessionId: row.agent_session_id,
    transcriptState: row.transcript_state === "gone" ? "gone" : "present",
    goneAt: row.gone_at,
    cwd: row.cwd,
    repoRoot: row.repo_root,
    branch: row.branch,
    entrypoint: row.entrypoint,
    version: row.version,
    kind: row.kind,
    customTitle: row.custom_title,
    aiTitle: row.ai_title,
    firstPrompt: row.first_prompt,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    durationMs: row.duration_ms,
    model: row.model,
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    linesAdded: row.lines_added,
    linesRemoved: row.lines_removed,
    prUrls: parseUrls(row.pr_urls),
    continuedIn: row.continued_in,
    subagentCount: row.subagent_count,
    liveSessionId: null,
  };
}

export class HistoryStore {
  constructor(private readonly db: DatabaseSync = openDb()) {}

  private inTransaction<T>(fn: () => T): T {
    const owns = !this.db.isTransaction;
    if (owns) this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      if (owns) this.db.exec("COMMIT");
      return out;
    } catch (err) {
      if (owns && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Every row of one agent, reduced to what a walk compares against the disk. */
  index(agent: AgentType): Map<string, HistoryIndexEntry> {
    const rows = this.db
      .prepare(
        `SELECT agent_session_id, transcript_path, fingerprint, transcript_state
           FROM history_sessions WHERE agent = ?`,
      )
      .all(agent) as unknown as Pick<Row, "agent_session_id" | "transcript_path" | "fingerprint" | "transcript_state">[];
    const out = new Map<string, HistoryIndexEntry>();
    for (const row of rows) {
      out.set(row.agent_session_id, {
        agentSessionId: row.agent_session_id,
        transcriptPath: row.transcript_path,
        fingerprint: parseFingerprint(row.fingerprint),
        transcriptState: row.transcript_state === "gone" ? "gone" : "present",
      });
    }
    return out;
  }

  /** One row and the transcript path it was built from, or null when the catalog has no such row. */
  entry(agent: AgentType, agentSessionId: string): { summary: HistorySessionSummary; transcriptPath: string } | null {
    const row = this.db
      .prepare("SELECT * FROM history_sessions WHERE agent = ? AND agent_session_id = ?")
      .get(agent, agentSessionId) as unknown as Row | undefined;
    return row ? { summary: toSummary(row), transcriptPath: row.transcript_path } : null;
  }

  /** Where the last parse of a row's file stopped, for an incremental re-summarize. */
  parsePoint(agent: AgentType, agentSessionId: string): HistoryParsePoint | null {
    const row = this.db
      .prepare("SELECT * FROM history_sessions WHERE agent = ? AND agent_session_id = ?")
      .get(agent, agentSessionId) as unknown as Row | undefined;
    if (!row) return null;
    const fingerprint = parseFingerprint(row.fingerprint);
    if (!fingerprint) return null;
    const {
      agent: _agent,
      agentSessionId: _id,
      transcriptState: _state,
      goneAt: _goneAt,
      repoRoot: _repo,
      liveSessionId: _live,
      ...summary
    } = toSummary(row);
    return {
      parsedBytes: row.parsed_bytes,
      ino: fingerprint.ino,
      state: row.reader_state,
      summary: { ...summary, kind: summary.kind as HistorySummary["kind"] },
    };
  }

  /**
   * Write one batch in ONE short transaction. A row that was gone and whose file is back
   * becomes present again; `resumed_from` is never touched here.
   */
  upsertBatch(rows: readonly HistoryUpsert[], indexedAt: number): void {
    if (rows.length === 0) return;
    const statement = this.db.prepare(`
      INSERT INTO history_sessions (
        agent, agent_session_id, transcript_path, fingerprint, parsed_bytes, reader_state,
        transcript_state, gone_at, cwd, repo_root, branch, entrypoint, version, kind,
        custom_title, ai_title, first_prompt, started_at, last_activity_at, duration_ms,
        model, cost_usd, input_tokens, output_tokens, lines_added, lines_removed,
        pr_urls, continued_in, subagent_count, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'present', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (agent, agent_session_id) DO UPDATE SET
        transcript_path = excluded.transcript_path,
        fingerprint = excluded.fingerprint,
        parsed_bytes = excluded.parsed_bytes,
        reader_state = excluded.reader_state,
        transcript_state = 'present',
        gone_at = NULL,
        cwd = excluded.cwd,
        repo_root = excluded.repo_root,
        branch = excluded.branch,
        entrypoint = excluded.entrypoint,
        version = excluded.version,
        kind = excluded.kind,
        custom_title = excluded.custom_title,
        ai_title = excluded.ai_title,
        first_prompt = excluded.first_prompt,
        started_at = excluded.started_at,
        last_activity_at = excluded.last_activity_at,
        duration_ms = excluded.duration_ms,
        model = excluded.model,
        cost_usd = excluded.cost_usd,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        lines_added = excluded.lines_added,
        lines_removed = excluded.lines_removed,
        pr_urls = excluded.pr_urls,
        continued_in = excluded.continued_in,
        subagent_count = excluded.subagent_count,
        indexed_at = excluded.indexed_at
    `);
    const fields = this.db.prepare(
      `INSERT INTO history_search_segments (agent, agent_session_id, ordinal, text_fold) VALUES (?, ?, 0, ?)
       ON CONFLICT (agent, agent_session_id, ordinal) DO UPDATE SET text_fold = excluded.text_fold`,
    );
    const clearPrompts = this.db.prepare(
      "DELETE FROM history_search_segments WHERE agent = ? AND agent_session_id = ? AND ordinal > 0",
    );
    const lastOrdinal = this.db.prepare(
      "SELECT COALESCE(MAX(ordinal), 0) AS n FROM history_search_segments WHERE agent = ? AND agent_session_id = ?",
    );
    const prompt = this.db.prepare(
      "INSERT INTO history_search_segments (agent, agent_session_id, ordinal, text_fold) VALUES (?, ?, ?, ?)",
    );
    this.inTransaction(() => {
      for (const row of rows) {
        fields.run(row.agent, row.agentSessionId, row.search.fields);
        if (row.search.resetPrompts) clearPrompts.run(row.agent, row.agentSessionId);
        let ordinal = Number((lastOrdinal.get(row.agent, row.agentSessionId) as { n: number }).n);
        for (const text of row.search.prompts) prompt.run(row.agent, row.agentSessionId, ++ordinal, text);
        const s = row.summary;
        statement.run(
          row.agent,
          row.agentSessionId,
          row.transcriptPath,
          JSON.stringify(row.fingerprint),
          row.parsedBytes,
          row.readerState,
          s.cwd,
          row.repoRoot,
          s.branch,
          s.entrypoint,
          s.version,
          s.kind,
          s.customTitle,
          s.aiTitle,
          s.firstPrompt,
          s.startedAt,
          s.lastActivityAt ?? row.fallbackActivityAt,
          s.durationMs,
          s.model,
          s.costUsd,
          s.inputTokens,
          s.outputTokens,
          s.linesAdded,
          s.linesRemoved,
          JSON.stringify(s.prUrls),
          s.continuedIn,
          s.subagentCount,
          indexedAt,
        );
      }
    });
  }

  /**
   * Mark every present row of `agent` that a COMPLETE walk did not see as gone. The row and
   * everything it says survive; only its transcript is recorded as removed. Returns how many
   * rows changed.
   */
  markGone(agent: AgentType, seen: ReadonlySet<string>, goneAt: number): number {
    const present = this.db
      .prepare("SELECT agent_session_id FROM history_sessions WHERE agent = ? AND transcript_state = 'present'")
      .all(agent) as unknown as { agent_session_id: string }[];
    const missing = present.map((row) => row.agent_session_id).filter((id) => !seen.has(id));
    if (missing.length === 0) return 0;
    const statement = this.db.prepare(
      `UPDATE history_sessions SET transcript_state = 'gone', gone_at = ?
        WHERE agent = ? AND agent_session_id = ? AND transcript_state = 'present'`,
    );
    this.inTransaction(() => {
      for (const id of missing) statement.run(goneAt, agent, id);
    });
    return missing.length;
  }

  /**
   * Write the fields segment for every row that has none, from the row itself. A row indexed
   * before `history_search_segments` existed gets one here; a present one is also re-read by
   * the reconciler (see `migrateHistorySearchSegments`), but a gone one has no file left to
   * read, and its title, place and branch must stay searchable. Returns how many were written.
   */
  seedFieldSegments(): number {
    const missing = this.db.prepare(
      `SELECT agent, agent_session_id, custom_title, ai_title, first_prompt, cwd, repo_root, branch
         FROM history_sessions h
        WHERE NOT EXISTS (SELECT 1 FROM history_search_segments s
                           WHERE s.agent = h.agent AND s.agent_session_id = h.agent_session_id AND s.ordinal = 0)`,
    ).all() as unknown as Pick<Row, "agent" | "agent_session_id" | "custom_title" | "ai_title" | "first_prompt" | "cwd" | "repo_root" | "branch">[];
    if (missing.length === 0) return 0;
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO history_search_segments (agent, agent_session_id, ordinal, text_fold) VALUES (?, ?, 0, ?)",
    );
    this.inTransaction(() => {
      for (const row of missing) {
        insert.run(row.agent, row.agent_session_id, historyFieldsSegment({
          customTitle: row.custom_title,
          aiTitle: row.ai_title,
          firstPrompt: row.first_prompt,
          cwd: row.cwd,
          repoRoot: row.repo_root,
          branch: row.branch,
        }));
      }
    });
    return missing.length;
  }

  /** Every repository a row resolved to, for the repository filter. */
  repositories(): string[] {
    return (this.db
      .prepare("SELECT DISTINCT repo_root FROM history_sessions WHERE repo_root IS NOT NULL ORDER BY repo_root")
      .all() as unknown as { repo_root: string }[]).map((row) => row.repo_root);
  }

  /** A worktree pool's root to its main checkout, for repository resolution. */
  worktreePools(): { poolPath: string; mainCheckoutRoot: string }[] {
    return (this.db.prepare("SELECT pool_path, main_checkout_root FROM worktree_pools").all() as unknown as {
      pool_path: string;
      main_checkout_root: string;
    }[]).map((row) => ({ poolPath: row.pool_path, mainCheckoutRoot: row.main_checkout_root }));
  }

  /** A task's repository, for a cwd under that task's legacy worktree. */
  taskRepoRoot(taskId: string): string | null {
    const row = this.db.prepare("SELECT repo_root FROM tasks WHERE id = ?").get(taskId) as
      | { repo_root: string | null }
      | undefined;
    return row?.repo_root ?? null;
  }

  /**
   * One page of rows matching every filter, newest activity first.
   *
   * Search is a literal substring of the folded needle in any of the row's segments, with no
   * ranking: the list keeps its activity order, so a search narrows it rather than reorders it.
   */
  page(query: {
    filter: HistoryListFilter;
    cursor: HistoryListCursor | null;
    limit: number;
    progress: HistoryProgress;
    facets: HistoryFacets;
  }): HistoryPage {
    const { filter } = query;
    const where = [`h.kind IN (${filter.kinds.map(() => "?").join(", ")})`];
    const params: (string | number)[] = [...filter.kinds];
    if (filter.needle) {
      where.push(`EXISTS (SELECT 1 FROM history_search_segments s
                           WHERE s.agent = h.agent AND s.agent_session_id = h.agent_session_id
                             AND instr(s.text_fold, ?) > 0)`);
      params.push(filter.needle);
    }
    if (filter.repo !== null) {
      where.push("h.repo_root = ?");
      params.push(filter.repo);
    }
    if (filter.from !== null) {
      where.push("h.last_activity_at >= ?");
      params.push(filter.from);
    }
    if (filter.to !== null) {
      where.push("h.last_activity_at < ?");
      params.push(filter.to);
    }
    if (filter.agent !== null) {
      where.push("h.agent = ?");
      params.push(filter.agent);
    }
    if (query.cursor) {
      const { lastActivityAt, agent, agentSessionId } = query.cursor;
      where.push(`(h.last_activity_at < ? OR (h.last_activity_at = ? AND (h.agent < ? OR (h.agent = ? AND h.agent_session_id < ?))))`);
      params.push(lastActivityAt, lastActivityAt, agent, agent, agentSessionId);
    }
    params.push(query.limit + 1);
    const rows = this.db
      .prepare(
        `SELECT h.* FROM history_sessions h WHERE ${where.join(" AND ")}
          ORDER BY h.last_activity_at DESC, h.agent DESC, h.agent_session_id DESC LIMIT ?`,
      )
      .all(...params) as unknown as Row[];
    const more = rows.length > query.limit;
    const sessions = rows.slice(0, query.limit).map(toSummary);
    const last = sessions[sessions.length - 1];
    return {
      sessions,
      nextCursor: more && last
        ? encodeHistoryCursor({ lastActivityAt: last.lastActivityAt, agent: last.agent, agentSessionId: last.agentSessionId })
        : null,
      progress: query.progress,
      facets: query.facets,
    };
  }
}
