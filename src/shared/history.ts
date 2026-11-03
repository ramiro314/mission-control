import { z } from "zod";
import { AGENT_TYPES, TASK_STATUSES, type AgentType, type TaskStatus, type TranscriptMessage } from "./types.ts";

/**
 * Session History: the catalog of every agent session this machine holds on disk, whether or
 * not Mission Control ever saw it. See `docs/history.md`.
 *
 * Browser-safe wire shapes only. What a kind MEANS for a given agent is decided by that
 * harness's history reader (`src/server/harness/<agent>/history.ts`), never here.
 */

/**
 * How a session was run. Persisted as `history_sessions.kind` and read back as a string, so a
 * value a later build appends stays readable after a downgrade. Append; never rename or reorder.
 */
export const HISTORY_KINDS = ["interactive", "sdk", "one_shot", "reviewer", "unclassified"] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

/**
 * The kinds the default list shows: conversations, not background runs. `unclassified` is
 * here on purpose - a session the reader could not place is shown rather than hidden.
 */
export const HISTORY_CONVERSATION_KINDS: readonly HistoryKind[] = ["interactive", "sdk", "unclassified"];

export function isHistoryConversationKind(kind: string): boolean {
  return (HISTORY_CONVERSATION_KINDS as readonly string[]).includes(kind);
}

/** Whether the transcript file a row was built from is still on disk. */
export const HISTORY_TRANSCRIPT_STATES = ["present", "gone"] as const;
export type HistoryTranscriptState = (typeof HISTORY_TRANSCRIPT_STATES)[number];

export const HISTORY_PAGE_LIMITS = { defaultLimit: 50, maxLimit: 200 } as const;

/** The longest search query and repository filter the list route accepts. */
export const HISTORY_SEARCH_LIMITS = { queryChars: 200, repoChars: 4096 } as const;

/**
 * What the Kind filter can ask for. Absent means conversations (`HISTORY_CONVERSATION_KINDS`);
 * `all` adds the background runs to them; a kind narrows the list to that kind. These strings
 * reach the address bar, so they are append-only like `HISTORY_KINDS`.
 */
export const HISTORY_KIND_FILTERS = ["all", ...HISTORY_KINDS] as const;
export type HistoryKindFilter = (typeof HISTORY_KIND_FILTERS)[number];

/** The kinds a Kind filter value lists. */
export function historyFilterKinds(kind: HistoryKindFilter | undefined): readonly string[] {
  if (kind === undefined) return HISTORY_CONVERSATION_KINDS;
  return kind === "all" ? HISTORY_KINDS : [kind];
}

/**
 * The Mission Control link filter: sessions a task manages, or every other one. Reaches the
 * address bar, so append-only.
 */
export const HISTORY_LINK_FILTERS = ["task", "external"] as const;
export type HistoryLinkFilter = (typeof HISTORY_LINK_FILTERS)[number];

/**
 * The PR filter: a session with a pull request (Mission Control's, else one its transcript
 * recorded), one whose Mission Control pull request merged, or one with none. Append-only.
 */
export const HISTORY_PR_FILTERS = ["any", "merged", "none"] as const;
export type HistoryPrFilter = (typeof HISTORY_PR_FILTERS)[number];

/**
 * The task outcome filter takes a task status: `done`, `failed`, `cancelled`, or a task still
 * running. It names only task-bound sessions.
 */
export const HISTORY_OUTCOME_FILTERS = TASK_STATUSES;
export type HistoryOutcomeFilter = TaskStatus;

/**
 * The one fold History's search uses, on both sides: the text written into
 * `history_search_segments.text_fold` and the query matched against it. Lowercased in
 * JavaScript rather than by SQLite's `lower()`, which folds ASCII only, and with whitespace
 * collapsed so a prompt's line breaks never stop a phrase from matching.
 */
export function foldHistorySearch(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** One catalog row as the list route serves it. */
export interface HistorySessionSummary {
  agent: AgentType;
  agentSessionId: string;
  transcriptState: HistoryTranscriptState;
  goneAt: number | null;
  /** The first recorded working directory, read from records - never from a folder name. */
  cwd: string | null;
  /** The repository `cwd` belonged to, resolved when the row was indexed. */
  repoRoot: string | null;
  branch: string | null;
  entrypoint: string | null;
  version: string | null;
  /** Read as a string, see `HISTORY_KINDS`. */
  kind: string;
  customTitle: string | null;
  aiTitle: string | null;
  firstPrompt: string | null;
  startedAt: number | null;
  lastActivityAt: number;
  durationMs: number | null;
  model: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  prUrls: string[];
  continuedIn: string | null;
  subagentCount: number;
  /**
   * What Mission Control knows about this session, joined when the row is served, or null when
   * nothing does. Never stored: it augments the record without being part of it.
   */
  mission: HistoryMission | null;
  /**
   * Where `costUsd` came from: the transcript's own `cost-state`, Mission Control's
   * `usage_ledger` when the transcript recorded none, or null when neither did.
   */
  costSource: HistoryCostSource | null;
  /**
   * The Registry session running this conversation right now, or null. Joined when the row is
   * served, never stored: the catalog records what is on disk, the Registry what is running.
   */
  liveSessionId: string | null;
}

export type HistoryCostSource = "transcript" | "ledger";

/** The task a session worked for, from `tasks`. */
export interface HistoryMissionTask {
  id: string;
  title: string;
  /** A `TaskKind`, read as a string so a later build's kind stays readable. */
  kind: string;
  /** A `TaskStatus`, read as a string for the same reason. */
  status: string;
  /** Free text set on completion, such as "opened PR #123". */
  outcome: string | null;
  outcomeUrl: string | null;
  workflowId: string | null;
  labels: string[];
}

/**
 * What Mission Control knows about one agent session, joined at read time: its task work
 * episode binding (current, else the newest historical one) and that binding's task, the
 * Mission Control session that ran it, and its `usage_ledger` cost.
 */
export interface HistoryMission {
  /** Null for a session Mission Control ran but no task bound. */
  task: HistoryMissionTask | null;
  prUrl: string | null;
  mergedAt: number | null;
  /** The binding's branch, else the task's. */
  branch: string | null;
  /** The task's repository. */
  repoRoot: string | null;
  /** Mission Control's own id for the session that ran this conversation, from `session_agent_bindings`. */
  missionSessionId: string | null;
  /** The session's spend in `usage_ledger`, or null when the ledger has none or any of it is unpriced. */
  ledgerCostUsd: number | null;
}

/** First-run progress: how much of what the last walk found is already in the catalog. */
export interface HistoryProgress {
  /** True while a pass is indexing files it found new or changed. */
  indexing: boolean;
  indexed: number;
  total: number;
}

/**
 * How long an agent keeps its transcripts before deleting them itself. Mission Control only
 * reads the setting; it never edits it.
 */
export interface HistoryRetention {
  agent: AgentType;
  days: number;
  /** False when the setting is unset and `days` is the agent's own default. */
  configured: boolean;
  /** The setting's name, as the agent's documentation spells it. */
  setting: string;
  /** Where the agent documents the setting. */
  settingUrl: string;
}

/** What the page's filters and header offer, read beside every page. */
export interface HistoryFacets {
  /** Agents with a history reader. The agent filter shows only when there are two or more. */
  agents: AgentType[];
  /** Every repository a cataloged session resolved to, sorted. */
  repositories: string[];
  retention: HistoryRetention[];
}

export interface HistoryPage {
  sessions: HistorySessionSummary[];
  /** Opaque; pass back as `cursor` for the next, older page. Null on the last page. */
  nextCursor: string | null;
  progress: HistoryProgress;
  facets: HistoryFacets;
}

/** The list's cursor: the last row's activity time and identity, in that sort order. */
export interface HistoryListCursor {
  lastActivityAt: number;
  agent: AgentType;
  agentSessionId: string;
}

export function encodeHistoryCursor(cursor: HistoryListCursor): string {
  return `${cursor.lastActivityAt}.${cursor.agent}.${cursor.agentSessionId}`;
}

export function decodeHistoryCursor(raw: string): HistoryListCursor | null {
  const match = /^(-?\d+)\.([a-z]+)\.([0-9A-Za-z-]{1,128})$/.exec(raw);
  if (!match) return null;
  const lastActivityAt = Number(match[1]);
  const agent = match[2] as AgentType;
  if (!Number.isSafeInteger(lastActivityAt) || !(AGENT_TYPES as readonly string[]).includes(agent)) return null;
  return { lastActivityAt, agent, agentSessionId: match[3]! };
}

/**
 * `GET /api/history/sessions`. A malformed cursor or an out-of-range limit is REFUSED rather
 * than clamped, on `ArchiveSearchQuerySchema`'s rule: a page route that silently reinterpreted
 * a bad cursor would answer a different window than the one asked for.
 */
export const HistorySessionsQuerySchema = z
  .object({
    cursor: z
      .string()
      .refine((raw) => decodeHistoryCursor(raw) !== null, "invalid history cursor")
      .optional(),
    limit: z.coerce.number().int().min(1).max(HISTORY_PAGE_LIMITS.maxLimit).optional(),
    /** Literal, case-folded search over titles, paths, branches and indexed prompts. */
    q: z.string().max(HISTORY_SEARCH_LIMITS.queryChars).optional(),
    /** A repository exactly as `facets.repositories` lists it. */
    repo: z.string().min(1).max(HISTORY_SEARCH_LIMITS.repoChars).optional(),
    /** Epoch ms bounds on last activity: `from` inclusive, `to` exclusive. */
    from: z.coerce.number().int().nonnegative().optional(),
    to: z.coerce.number().int().nonnegative().optional(),
    kind: z.enum(HISTORY_KIND_FILTERS).optional(),
    agent: z.enum(AGENT_TYPES).optional(),
    link: z.enum(HISTORY_LINK_FILTERS).optional(),
    outcome: z.enum(HISTORY_OUTCOME_FILTERS).optional(),
    pr: z.enum(HISTORY_PR_FILTERS).optional(),
  })
  .strict();
export type HistorySessionsQuery = z.infer<typeof HistorySessionsQuerySchema>;

/** How the page names a kind. A kind a later build appends shows as its raw value. */
export const HISTORY_KIND_LABELS: Readonly<Record<string, string>> = {
  interactive: "Interactive",
  sdk: "SDK",
  one_shot: "One-shot",
  reviewer: "Reviewer",
  unclassified: "Unclassified",
};

/** How the page names the Mission Control link and PR filter values. */
export const HISTORY_LINK_LABELS: Readonly<Record<HistoryLinkFilter, string>> = {
  task: "Managed by a task",
  external: "External",
};
export const HISTORY_PR_LABELS: Readonly<Record<HistoryPrFilter, string>> = {
  any: "With a PR",
  merged: "PR merged",
  none: "No PR",
};

/**
 * The title a row shows: its task's title when a task is bound, else the custom title, the AI
 * title, then the first prompt.
 */
export function historyTitle(
  row: Pick<HistorySessionSummary, "customTitle" | "aiTitle" | "firstPrompt"> & { mission?: HistoryMission | null },
): string {
  return row.mission?.task?.title.trim() || row.customTitle?.trim() || row.aiTitle?.trim() || row.firstPrompt?.trim()
    || "Untitled session";
}

/** "PR #123" for a GitHub pull request URL, else "Pull request". */
export function historyPrLabel(url: string): string {
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return number ? `PR #${number}` : "Pull request";
}

/**
 * A session's cost: the transcript's own, else Mission Control's ledger. The one place the
 * fallback is decided, for a catalog row and for a record the catalog never indexed.
 */
export function historyCost(
  transcriptCostUsd: number | null,
  mission: Pick<HistoryMission, "ledgerCostUsd"> | null,
): { costUsd: number | null; costSource: HistoryCostSource | null } {
  if (transcriptCostUsd !== null) return { costUsd: transcriptCostUsd, costSource: "transcript" };
  const ledger = mission?.ledgerCostUsd ?? null;
  return ledger !== null ? { costUsd: ledger, costSource: "ledger" } : { costUsd: null, costSource: null };
}

/** The pull request a row shows: Mission Control's, else the last one its transcript recorded. */
export function historyPrUrl(row: Pick<HistorySessionSummary, "prUrls" | "mission">): string | null {
  return row.mission?.prUrl ?? row.prUrls.at(-1) ?? null;
}

/**
 * An agent's own session id as History addresses it: a UUID, nothing else. Checked before the
 * catalog is asked, so a request can never steer a lookup with a path-shaped id.
 */
const HISTORY_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isHistorySessionId(raw: string): boolean {
  return HISTORY_SESSION_ID.test(raw);
}

/**
 * `GET /api/history/sessions/:agent/:id`: one session. The catalog row, which carries its live
 * status and what Mission Control knows about it, exactly as the list serves it. Or, when the
 * catalog has no row but Mission Control names the id (a transcript deleted before it was ever
 * indexed), Mission Control's record alone, with no conversation to read.
 */
export type HistorySessionDetail =
  | { catalog: HistorySessionSummary }
  | { catalog: null; mission: HistoryMissionRecord };

/** A session the catalog never indexed, as Mission Control alone knows it. */
export interface HistoryMissionRecord extends HistoryMission {
  agent: AgentType;
  agentSessionId: string;
  liveSessionId: string | null;
}

/** `GET /api/history/sessions/:agent/:id/messages`: one window of turns, read forward. */
export interface HistoryMessagesPage {
  messages: TranscriptMessage[];
  /** Opaque; pass back as `cursor` for the next, later window. Null once the last turn is read. */
  nextCursor: string | null;
}

/** Turns per conversation window. */
export const HISTORY_MESSAGES_PAGE_TURNS = 100;

/**
 * `GET /api/history/sessions/:agent/:id/messages`. The cursor is the byte offset the previous
 * window ended at; anything else is refused rather than read from the top.
 */
export const HistoryMessagesQuerySchema = z
  .object({
    cursor: z
      .string()
      .regex(/^\d{1,15}$/, "invalid history messages cursor")
      .optional(),
  })
  .strict();
export type HistoryMessagesQuery = z.infer<typeof HistoryMessagesQuerySchema>;
