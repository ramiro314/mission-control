import { z } from "zod";
import { TERMINAL_BACKEND_IDS } from "./terminal.ts";
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

/** `GET /api/history/sessions/:agent/:id`: one row and whether it is running now. */
export interface HistorySessionDetail {
  session: HistorySessionSummary;
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

/**
 * A History Resume's launch record, `history_resume_launches.state`. `pending` until the
 * resumed agent is discovered (`bound`), `ended` when that session leaves, and `released`
 * once nothing holds the launch open. `expired` is a launch WITH a worktree slot whose agent
 * has not appeared within its grace window; it keeps the slot. `pending` and `expired` are
 * the open states, and a session has at most one open launch. Persisted and read back as a
 * string: append, never rename or reorder.
 */
export const HISTORY_RESUME_LAUNCH_STATES = ["pending", "expired", "bound", "ended", "released"] as const;
export type HistoryResumeLaunchState = (typeof HISTORY_RESUME_LAUNCH_STATES)[number];

/** One launch record as the routes serve it. */
export interface HistoryResumeLaunch {
  launchId: string;
  agent: AgentType;
  sourceSessionId: string;
  /** The agent session id the launch waits for: the source's own id for a plain resume. */
  expectedAgentSessionId: string;
  /** The launch directory, resolved once through symlinks. */
  cwd: string;
  /** The worktree slot the launch holds, or null for a directory outside the pool. */
  slotId: string | null;
  launchedAt: number;
  /** The Mission Control session the launch bound to, once discovery registered it. */
  mcSessionId: string | null;
  /** Read as a string, see `HISTORY_RESUME_LAUNCH_STATES`. */
  state: string;
}

/**
 * Why a Resume cannot run, as a stable code beside the sentence the page shows. These reach
 * the browser, so they are append-only like the states above.
 */
export const HISTORY_RESUME_REFUSALS = [
  "not_conversation",
  "transcript_gone",
  "live",
  "open_launch",
  "no_directory",
  "directory_missing",
  "pool_slot",
  "not_resumable",
  "host_unavailable",
  "launch_failed",
  "launch_unknown",
] as const;
export type HistoryResumeRefusalCode = (typeof HISTORY_RESUME_REFUSALS)[number];

export interface HistoryResumeRefusal {
  code: HistoryResumeRefusalCode;
  error: string;
}

/**
 * Where the session was recorded running, and whether Resume can use it. `usable` is an
 * existing directory outside every worktree pool; `pool_slot` is one inside a pool, which the
 * slot-target Resume handles; `missing` no longer resolves to a directory; `unrecorded` means
 * the transcript named no working directory.
 */
export const HISTORY_RESUME_DIRECTORY_STATES = ["usable", "missing", "pool_slot", "unrecorded"] as const;
export type HistoryResumeDirectoryState = (typeof HISTORY_RESUME_DIRECTORY_STATES)[number];

/** `GET /api/history/sessions/:agent/:id/resume-options`. */
export interface HistoryResumeOptions {
  original: {
    /** The first recorded working directory, as the transcript spelled it. */
    cwd: string | null;
    /** That directory resolved through symlinks, when it still resolves. */
    resolved: string | null;
    state: HistoryResumeDirectoryState;
  };
  /** The session's open (`pending` or `expired`) launch, if any. */
  openLaunch: HistoryResumeLaunch | null;
  /** Why Resume would be refused right now, or null when it would launch. */
  refusal: HistoryResumeRefusal | null;
}

/**
 * Where a Resume runs. Only the original directory is offered today; a worktree slot and a
 * typed directory join this union, so a body naming one is refused until then.
 */
export const HistoryResumeTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("original") }).strict(),
]);
export type HistoryResumeTarget = z.infer<typeof HistoryResumeTargetSchema>;

/** `POST /api/history/sessions/:agent/:id/resume`. */
export const HistoryResumeBodySchema = z
  .object({
    backend: z.enum(TERMINAL_BACKEND_IDS),
    target: HistoryResumeTargetSchema,
  })
  .strict();
export type HistoryResumeBody = z.infer<typeof HistoryResumeBodySchema>;

/**
 * Whether Cancel pending resume can close a launch: it is still `pending` and holds no worktree
 * slot. A launch with a slot closes when that slot is Returned, so the pool never resets it
 * under an agent that may still appear. The store refuses on this rule and the dialog offers
 * Cancel on it.
 */
export function historyResumeCancellable(launch: Pick<HistoryResumeLaunch, "state" | "slotId">): boolean {
  return launch.state === "pending" && launch.slotId === null;
}

/** `POST /api/history/sessions/:agent/:id/resume/cancel`: close a pending launch with no slot. */
export const HistoryResumeCancelSchema = z
  .object({ launchId: z.string().uuid() })
  .strict();
export type HistoryResumeCancel = z.infer<typeof HistoryResumeCancelSchema>;

/** A launch that started, or whose terminal may have opened (`unknown`). */
export interface HistoryResumeStarted {
  ok: true;
  launch: HistoryResumeLaunch;
  /** The terminal backend that took it, for the confirmation the page shows. */
  label: string;
}

/** A refused Resume, with the open launch it collided with when that is the reason. */
export interface HistoryResumeRefused extends HistoryResumeRefusal {
  ok: false;
  launch?: HistoryResumeLaunch;
}

/**
 * Whether a row offers Resume at all: a conversation whose transcript is on disk and which no
 * Registry session is running. Live sessions offer Open in Fleet instead. A row that offers
 * it can still be refused for its directory or an open launch; `resume-options` says why.
 */
export function historyResumeOffered(
  row: Pick<HistorySessionSummary, "kind" | "transcriptState" | "liveSessionId">,
): boolean {
  return isHistoryConversationKind(row.kind) && row.transcriptState === "present" && row.liveSessionId === null;
}
