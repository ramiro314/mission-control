import type { DatabaseSync } from "node:sqlite";
import {
  encodeHistoryCursor,
  type HistoryFacets,
  type HistoryLinkFilter,
  type HistoryMission,
  type HistoryOutcomeFilter,
  type HistoryPrFilter,
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
  /** Whether a task-bound session passes the kind filter whatever its kind: the default list's rule. */
  taskBoundIsConversation: boolean;
  /** A folded search needle, or null. */
  needle: string | null;
  repo: string | null;
  /** Epoch ms bounds on `last_activity_at`: `from` inclusive, `to` exclusive. */
  from: number | null;
  to: number | null;
  agent: AgentType | null;
  link: HistoryLinkFilter | null;
  outcome: HistoryOutcomeFilter | null;
  pr: HistoryPrFilter | null;
}

/**
 * Each agent session's task work episode binding, joined to its task: the current binding when
 * one names the session, else the newest historical one. One row per `(agent, agent_session_id)`,
 * with the agent taken from the task, so a binding is only ever joined to its own agent's row.
 * A binding whose task is gone binds nothing.
 */
const MISSION_TASK_CTE = `
  mission_task AS (
    SELECT * FROM (
      SELECT b.agent_session_id, t.agent, b.task_id, b.pr_url, b.merged_at, b.branch,
             t.title, t.kind AS task_kind, t.status, t.outcome, t.outcome_url, t.workflow_id,
             t.labels, t.repo_root AS task_repo_root, t.branch AS task_branch,
             ROW_NUMBER() OVER (PARTITION BY t.agent, b.agent_session_id
                                ORDER BY b.current DESC, b.updated_at DESC, b.task_id) AS rank
        FROM (SELECT agent_session_id, task_id, pr_url, merged_at, branch, updated_at, 1 AS current
                FROM task_work_episode_bindings
              UNION ALL
              SELECT agent_session_id, task_id, pr_url, merged_at, branch, updated_at, 0 AS current
                FROM historical_task_work_episode_bindings) b
        JOIN tasks t ON t.id = b.task_id
    ) WHERE rank = 1
  )`;

interface MissionRow {
  agent_session_id: string;
  task_id: string | null;
  pr_url: string | null;
  merged_at: number | null;
  branch: string | null;
  title: string | null;
  task_kind: string | null;
  status: string | null;
  outcome: string | null;
  outcome_url: string | null;
  workflow_id: string | null;
  labels: string | null;
  task_repo_root: string | null;
  task_branch: string | null;
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

function parseStrings(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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
    prUrls: parseStrings(row.pr_urls),
    continuedIn: row.continued_in,
    subagentCount: row.subagent_count,
    mission: null,
    costSource: row.cost_usd !== null ? "transcript" : null,
    liveSessionId: null,
  };
}

/**
 * Cost from `usage_ledger`, by note key (a Claude session's note key is its agent session id),
 * on `sessionCostFor`'s rule: session spend only, and null rather than a subtotal when any row
 * is unpriced or the rows disagree on their basis.
 */
function ledgerCosts(db: DatabaseSync, ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT note_key, SUM(cost_usd) AS cost, MIN(cost_known) AS known, COUNT(DISTINCT cost_basis) AS bases
         FROM usage_ledger WHERE spend_kind = 'session' AND note_key IN (${ids.map(() => "?").join(", ")})
        GROUP BY note_key`,
    )
    .all(...ids) as unknown as { note_key: string; cost: number; known: number; bases: number }[];
  for (const row of rows) if (row.known === 1 && row.bases === 1) out.set(row.note_key, row.cost);
  return out;
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

  /**
   * What Mission Control knows about each of `ids`, keyed by id. An id with no task binding, no
   * Mission Control session and no ledger cost is absent.
   */
  missions(agent: AgentType, ids: readonly string[]): Map<string, HistoryMission> {
    const out = new Map<string, HistoryMission>();
    if (ids.length === 0) return out;
    const marks = ids.map(() => "?").join(", ");
    const tasks = this.db
      .prepare(`WITH ${MISSION_TASK_CTE} SELECT * FROM mission_task WHERE agent = ? AND agent_session_id IN (${marks})`)
      .all(agent, ...ids) as unknown as MissionRow[];
    const byTask = new Map(tasks.map((row) => [row.agent_session_id, row]));
    // `session_agent_bindings` records no agent, but its key is the agent's own UUID.
    const sessions = this.db
      .prepare(
        `SELECT agent_session_id, session_id FROM session_agent_bindings
          WHERE agent_session_id IN (${marks}) ORDER BY updated_at DESC`,
      )
      .all(...ids) as unknown as { agent_session_id: string; session_id: string }[];
    const bySession = new Map<string, string>();
    for (const row of sessions) if (!bySession.has(row.agent_session_id)) bySession.set(row.agent_session_id, row.session_id);
    const costs = ledgerCosts(this.db, ids);
    for (const id of ids) {
      const task = byTask.get(id);
      const missionSessionId = bySession.get(id) ?? null;
      const ledgerCostUsd = costs.get(id) ?? null;
      if (!task && missionSessionId === null && ledgerCostUsd === null) continue;
      out.set(id, {
        task: task?.task_id
          ? {
              id: task.task_id,
              title: task.title ?? "",
              kind: task.task_kind ?? "",
              status: task.status ?? "",
              outcome: task.outcome,
              outcomeUrl: task.outcome_url,
              workflowId: task.workflow_id,
              labels: task.labels ? parseStrings(task.labels) : [],
            }
          : null,
        prUrl: task?.pr_url ?? null,
        mergedAt: task?.merged_at ?? null,
        branch: task?.branch ?? task?.task_branch ?? null,
        repoRoot: task?.task_repo_root ?? null,
        missionSessionId,
        ledgerCostUsd,
      });
    }
    return out;
  }

  /**
   * Rows with what Mission Control knows joined in, and the ledger's cost where the transcript
   * recorded none.
   */
  withMissions(rows: readonly HistorySessionSummary[]): HistorySessionSummary[] {
    const byAgent = new Map<AgentType, string[]>();
    for (const row of rows) byAgent.set(row.agent, [...(byAgent.get(row.agent) ?? []), row.agentSessionId]);
    const missions = new Map<string, HistoryMission>();
    for (const [agent, ids] of byAgent) {
      for (const [id, mission] of this.missions(agent, ids)) missions.set(`${agent}:${id}`, mission);
    }
    return rows.map((row) => {
      const mission = missions.get(`${row.agent}:${row.agentSessionId}`) ?? null;
      if (!mission) return row;
      const fallback = row.costUsd === null && mission.ledgerCostUsd !== null;
      return {
        ...row,
        mission,
        ...(fallback ? { costUsd: mission.ledgerCostUsd, costSource: "ledger" as const } : {}),
      };
    });
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
      mission: _mission,
      costSource: _costSource,
      ...summary
    } = toSummary(row);
    return {
      parsedBytes: row.parsed_bytes,
      ino: fingerprint.ino,
      size: fingerprint.size,
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
    const kinds = `h.kind IN (${filter.kinds.map(() => "?").join(", ")})`;
    const where = [filter.taskBoundIsConversation ? `(${kinds} OR m.task_id IS NOT NULL)` : kinds];
    const params: (string | number)[] = [...filter.kinds];
    if (filter.needle) {
      // A bound row's title is its task's, so the task title is searched too. SQLite's lower()
      // folds ASCII only, which the needle's own fold matches for every ASCII title.
      where.push(`(EXISTS (SELECT 1 FROM history_search_segments s
                            WHERE s.agent = h.agent AND s.agent_session_id = h.agent_session_id
                              AND instr(s.text_fold, ?) > 0)
                   OR instr(lower(m.title), ?) > 0)`);
      params.push(filter.needle, filter.needle);
    }
    if (filter.link === "task") where.push("m.task_id IS NOT NULL");
    if (filter.link === "external") where.push("m.task_id IS NULL");
    if (filter.outcome !== null) {
      where.push("m.status = ?");
      params.push(filter.outcome);
    }
    if (filter.pr === "merged") where.push("m.merged_at IS NOT NULL");
    if (filter.pr === "any") where.push("(m.pr_url IS NOT NULL OR h.pr_urls <> '[]')");
    if (filter.pr === "none") where.push("(m.pr_url IS NULL AND h.pr_urls = '[]')");
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
        `WITH ${MISSION_TASK_CTE}
         SELECT h.* FROM history_sessions h
           LEFT JOIN mission_task m ON m.agent = h.agent AND m.agent_session_id = h.agent_session_id
          WHERE ${where.join(" AND ")}
          ORDER BY h.last_activity_at DESC, h.agent DESC, h.agent_session_id DESC LIMIT ?`,
      )
      .all(...params) as unknown as Row[];
    const more = rows.length > query.limit;
    const sessions = this.withMissions(rows.slice(0, query.limit).map(toSummary));
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
