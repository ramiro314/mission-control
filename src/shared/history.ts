import { z } from "zod";
import { AGENT_TYPES, type AgentType, type TranscriptMessage } from "./types.ts";

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
   * The Registry session running this conversation right now, or null. Joined when the row is
   * served, never stored: the catalog records what is on disk, the Registry what is running.
   */
  liveSessionId: string | null;
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

/** The title a row shows: custom title, AI title, then the first prompt. */
export function historyTitle(row: Pick<HistorySessionSummary, "customTitle" | "aiTitle" | "firstPrompt">): string {
  return row.customTitle?.trim() || row.aiTitle?.trim() || row.firstPrompt?.trim() || "Untitled session";
}

/**
 * An agent's own session id as History addresses it: a UUID, nothing else. Checked before the
 * catalog is asked, so a request can never steer a lookup with a path-shaped id.
 */
const HISTORY_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isHistorySessionId(raw: string): boolean {
  return HISTORY_SESSION_ID.test(raw);
}

/** `GET /api/history/sessions/:agent/:id`: one row, whether it is running now, and its subagent runs. */
export interface HistorySessionDetail {
  session: HistorySessionSummary;
  /** The subagent runs the session's own folder lists, oldest first; empty once the transcript is gone. */
  subagents: HistorySubagent[];
}

/** `GET /api/history/sessions/:agent/:id/messages`: one window of turns, read forward. */
export interface HistoryMessagesPage {
  messages: TranscriptMessage[];
  /** Opaque; pass back as `cursor` for the next, later window. Null once the last turn is read. */
  nextCursor: string | null;
}

/**
 * Where History cuts one tool call's serialized input. The live view cuts at 1,800 characters
 * to keep its windows small; History reads one session at a time and shows the call in full
 * up to this.
 */
export const HISTORY_TOOL_INPUT_CAP = 256 * 1024;

/** Where History cuts one tool result's text, inline or read from its sidecar file. */
export const HISTORY_TOOL_RESULT_CAP = 1024 * 1024;

/**
 * A tool call's id as `GET .../tool-results/:toolUseId` accepts it. Checked before anything is
 * read, and never joined into a path: the result is found by this id in the parent transcript.
 */
const HISTORY_TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isHistoryToolUseId(raw: string): boolean {
  return HISTORY_TOOL_USE_ID.test(raw);
}

/**
 * A subagent run's id as `GET .../subagents/:agentId/messages` accepts it. It names a file only
 * when that file is in the session's own `subagents/` listing.
 */
const HISTORY_SUBAGENT_ID = /^[0-9a-f]{8,64}$/;

export function isHistorySubagentId(raw: string): boolean {
  return HISTORY_SUBAGENT_ID.test(raw);
}

/** One subagent run a session started, as its detail lists it. */
export interface HistorySubagent {
  agentId: string;
  /** The subagent's type (`Explore`, `general-purpose`), when its metadata records one. */
  agentType: string | null;
  /** What the parent asked for, when its metadata records a description. */
  description: string | null;
  /** The subagent's opening prompt, capped, as a fallback label. */
  firstPrompt: string | null;
  startedAt: number | null;
}

/**
 * `GET /api/history/sessions/:agent/:id/tool-results/:toolUseId`: one tool call's result.
 * `sidecar` when the transcript recorded a preview and named the file holding the whole output.
 */
export interface HistoryToolResult {
  toolUseId: string;
  source: "inline" | "sidecar";
  isError: boolean;
  text: string;
  /** True when `text` was cut at `HISTORY_TOOL_RESULT_CAP`. */
  truncated: boolean;
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

/**
 * One instruction file as a session loaded it: CLAUDE.md, AGENTS.md or a memory index. The
 * text is the snapshot the transcript recorded, never the file as it reads today.
 */
export interface HistoryInstructionFile {
  path: string;
  /** As the agent names it (Claude: `User`, `Project`, `AutoMem`); a scope a later version adds shows raw. */
  scope: string | null;
  /** Why it loaded (Claude: `session_start`, `compaction`), or null when the record says nothing. */
  reason: string | null;
  content: string;
}

/** What the appended system prompt carried: Mission Control's standing instructions, and the rest. */
export interface HistorySystemPrompt {
  /** The standing-instructions block, or null when none was appended. */
  standingInstructions: string | null;
  /** Every other appended block, in order. */
  appended: string[];
}

export interface HistoryMcpServer {
  name: string;
  /**
   * How the server stood when the transcript last mentioned it: `connected`, `pending`,
   * `needs_auth` or `failed`. A status a later version adds shows raw.
   */
  status: string;
  /** The instruction block the server sent, when it sent one. */
  instructions: string | null;
}

export interface HistoryMcp {
  servers: HistoryMcpServer[];
  /** MCP tools the session was offered, by their full tool name. */
  tools: string[];
}

export interface HistorySkills {
  /** The skills the session was offered, or null when no listing was recorded. */
  available: string[] | null;
  /** The skills it actually used, read from the conversation itself. */
  used: string[];
}

/** Where and how the session ran. Every field is null when its record is absent. */
export interface HistoryEnvironment {
  cwd: string | null;
  branch: string | null;
  /** `git status` as the agent recorded it at launch. */
  gitStatus: string | null;
  isWorktree: boolean | null;
  isGitRepo: boolean | null;
  additionalDirectories: string[] | null;
  platform: string | null;
  shell: string | null;
  osVersion: string | null;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
}

/** One hook command, with every run the transcript recorded for it. */
export interface HistoryHookRun {
  /** The hook event (`Stop`, `PostToolUse`, …). */
  event: string;
  command: string;
  runs: number;
  totalMs: number;
  maxMs: number;
  /** Runs that recorded an error or were cancelled. Shown as "failed". */
  failures: number;
}

/**
 * `GET /api/history/sessions/:agent/:id/launch-context`: what the session was launched with,
 * parsed from its transcript on demand and never copied into the catalog.
 *
 * A section is null when the transcript holds no record of it. That is "not recorded", never
 * "none": an absent record is ambiguous (nothing loaded, or the agent was told not to load
 * it), so the page must never read it as an empty list.
 */
export interface HistoryLaunchContext {
  instructionFiles: HistoryInstructionFile[] | null;
  systemPrompt: HistorySystemPrompt | null;
  skills: HistorySkills;
  mcp: HistoryMcp | null;
  environment: HistoryEnvironment;
  hooks: HistoryHookRun[] | null;
}
