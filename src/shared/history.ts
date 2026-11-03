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

/** Whether the transcript file a row was built from is still on disk. */
export const HISTORY_TRANSCRIPT_STATES = ["present", "gone"] as const;
export type HistoryTranscriptState = (typeof HISTORY_TRANSCRIPT_STATES)[number];

export const HISTORY_PAGE_LIMITS = { defaultLimit: 50, maxLimit: 200 } as const;

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

export interface HistoryPage {
  sessions: HistorySessionSummary[];
  /** Opaque; pass back as `cursor` for the next, older page. Null on the last page. */
  nextCursor: string | null;
  progress: HistoryProgress;
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
