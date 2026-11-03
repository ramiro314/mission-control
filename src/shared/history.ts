import { z } from "zod";
import { TERMINAL_BACKEND_IDS } from "./terminal.ts";
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
 * status and what Mission Control knows about it, exactly as the list serves it, with the
 * subagent runs its own folder lists (oldest first; empty once the transcript is gone). Or,
 * when the catalog has no row but Mission Control names the id (a transcript deleted before it
 * was ever indexed), Mission Control's record alone, with no conversation or runs to read.
 */
export type HistorySessionDetail =
  | { catalog: HistorySessionSummary; subagents: HistorySubagent[] }
  | { catalog: null; mission: HistoryMissionRecord };

/**
 * A session the catalog never indexed, as Mission Control alone knows it. Always task-bound:
 * a task binding is the only Mission Control record that says which agent a session was.
 */
export interface HistoryMissionRecord extends HistoryMission {
  task: HistoryMissionTask;
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

/**
 * Where History cuts one tool call's serialized input. The live view cuts at 1,800 characters
 * to keep its windows small; History reads one session at a time and shows the call in full
 * up to this.
 */
export const HISTORY_TOOL_INPUT_CAP = 256 * 1024;

/**
 * Where History cuts one tool result's text, in UTF-8 bytes, inline or read from its sidecar
 * file alike. The cut falls on a character boundary, so it can leave up to 3 bytes unused.
 */
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

/**
 * Why an `ended` launch kept its slot leased instead of handing it back, in
 * `history_resume_launches.kept_reason`: the slot had uncommitted changes, or `HEAD` held
 * commits that no branch, tag or remote-tracking ref holds. Persisted: append, never rename or
 * reorder.
 */
export const HISTORY_RESUME_KEPT_REASONS = ["uncommitted", "unbranched_commits"] as const;
export type HistoryResumeKeptReason = (typeof HISTORY_RESUME_KEPT_REASONS)[number];

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
  /**
   * The transcript copy a typed-directory Resume wrote or reused, or null. Recorded only once
   * the copy exists, so a path here is always a History copy and never canonical.
   */
  copyPath: string | null;
  launchedAt: number;
  /** The Mission Control session the launch bound to, once discovery registered it. */
  mcSessionId: string | null;
  /** Read as a string, see `HISTORY_RESUME_LAUNCH_STATES`. */
  state: string;
  /** Why an `ended` launch kept its slot, see `HISTORY_RESUME_KEPT_REASONS`; null otherwise. */
  keptReason: string | null;
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
  "cancelled",
  "launch_not_found",
  "launch_not_pending",
  "launch_has_slot",
  "directory_relative",
  "copy_exists",
  "slot_reused",
  "slot_unavailable",
  "slot_not_offered",
  "pool_unavailable",
] as const;
export type HistoryResumeRefusalCode = (typeof HISTORY_RESUME_REFUSALS)[number];

export interface HistoryResumeRefusal {
  code: HistoryResumeRefusalCode;
  error: string;
}

/**
 * Where the session was recorded running, and whether Resume can use it. `usable` is an
 * existing directory outside every worktree pool; `pool_slot` is an idle pool slot, which the
 * Resume leases and checks the recorded branch out in; `slot_reused` is a pool directory that
 * another owner holds or that is otherwise not idle, so it counts as reused; `missing` no
 * longer resolves to a directory; `unrecorded` means the transcript named no working
 * directory. Append-only: the browser reads these.
 */
export const HISTORY_RESUME_DIRECTORY_STATES = ["usable", "missing", "pool_slot", "unrecorded", "slot_reused"] as const;
export type HistoryResumeDirectoryState = (typeof HISTORY_RESUME_DIRECTORY_STATES)[number];

/** A worktree pool slot a Resume can lease, as the dialog lists it. */
export interface HistoryResumeSlot {
  slotId: string;
  /** The slot's number in its pool, as its card shows it. */
  ordinal: number;
  path: string;
  /** The commit the slot was last observed at, or null when that could not be read. */
  head: string | null;
}

/** `GET /api/history/sessions/:agent/:id/resume-options`. */
export interface HistoryResumeOptions {
  original: {
    /** The first recorded working directory, as the transcript spelled it. */
    cwd: string | null;
    /** That directory resolved through symlinks, when it still resolves. */
    resolved: string | null;
    state: HistoryResumeDirectoryState;
    /** The pool slot the directory is, when it is one (`pool_slot` or `slot_reused`). */
    slot: HistoryResumeSlot | null;
    /** Why a Resume in this directory would be refused, or null when it is usable. */
    refusal: HistoryResumeRefusal | null;
  };
  /** The session's open (`pending` or `expired`) launch, if any. */
  openLaunch: HistoryResumeLaunch | null;
  /** Why no Resume can run right now, whatever the target, or null. */
  refusal: HistoryResumeRefusal | null;
  /**
   * The other targets the dialog offers when the original directory cannot be used (gone,
   * reused or unrecorded) and nothing else refuses: idle, clean slots of the session's
   * repository (none for a session with no resolvable repository), and a typed directory when
   * the agent can fork. Null when the original is usable or a refusal blocks every target.
   */
  picker: { directory: boolean; slots: HistoryResumeSlot[] } | null;
}

/**
 * Where a Resume runs: the original directory (leased as a slot when it is an idle one), a
 * slot the picker offered, or a directory the operator typed. A typed path must be absolute;
 * the daemon refuses a relative one with `directory_relative`, so the dialog can say why, and
 * resolves the rest once through symlinks.
 */
export const HistoryResumeTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("original") }).strict(),
  z.object({ kind: z.literal("slot"), slotId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("directory"), path: z.string().min(1).max(4096) }).strict(),
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

/**
 * What a slot card says of the History Resume that holds it: why a slot it kept after its
 * session ended is still leased, that its agent has not appeared, or plainly whose it is.
 */
export function historyResumeSlotLabel(launch: Pick<HistoryResumeLaunch, "state" | "keptReason">): string {
  if (launch.state === "expired") return "Held for a resumed session that has not appeared";
  if (launch.state === "ended" && launch.keptReason === "uncommitted") {
    return "Kept: uncommitted changes from a resumed session";
  }
  if (launch.state === "ended" && launch.keptReason === "unbranched_commits") {
    return "Kept: commits on no branch from a resumed session";
  }
  return "Resumed History session";
}

/** `POST /api/history/sessions/:agent/:id/resume/cancel`: close a pending launch with no slot. */
export const HistoryResumeCancelSchema = z
  .object({ launchId: z.string().uuid() })
  .strict();
export type HistoryResumeCancel = z.infer<typeof HistoryResumeCancelSchema>;

/**
 * What a slot target checked out. `branch`: the recorded branch, attached. `missing`: no
 * local or remote-tracking ref of it here, so the slot stays detached as it was; `branch` is
 * null when the transcript recorded nothing the daemon would hand to Git as a branch name (it
 * decides that, so this never re-judges it). `elsewhere`: another worktree (`path`) holds the
 * branch, so its tip is checked out detached.
 */
export type HistoryResumeCheckout =
  | { state: "branch"; branch: string }
  | { state: "missing"; branch: string | null }
  | { state: "elsewhere"; branch: string; path: string };

/** The warning a slot's checkout carries, or null when the recorded branch is checked out. */
export function historyResumeCheckoutWarning(checkout: HistoryResumeCheckout): string | null {
  switch (checkout.state) {
    case "branch":
      return null;
    case "missing":
      return checkout.branch === null
        ? "This conversation recorded no usable branch, so the slot stays detached where it was: the code may not match the conversation."
        : `The branch ${checkout.branch} was not found here or on origin, so the slot stays detached where it was: the code may not match the conversation.`;
    case "elsewhere":
      return `The branch ${checkout.branch} is checked out in ${checkout.path}, so this slot has its tip detached: commits made here will not move the branch.`;
  }
}

/** A launch that started, or whose terminal may have opened (`unknown`). */
export interface HistoryResumeStarted {
  ok: true;
  launch: HistoryResumeLaunch;
  /** The terminal backend that took it, for the confirmation the page shows. */
  label: string;
  /** What a slot target checked out, or null for a directory outside the pool. */
  checkout: HistoryResumeCheckout | null;
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
