import { createReadStream } from "node:fs";
import { lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { isHistorySubagentId, type HistoryKind } from "@shared/history.ts";
import { PERMISSION_MODES, type PermissionMode, type TranscriptMessage } from "@shared/types.ts";
import type {
  HistoryFile,
  HistoryParse,
  HistoryParsePoint,
  HistoryRecordedToolResult,
  HistorySpec,
  HistorySubagentFile,
  HistorySummary,
} from "../types.ts";
import { claudeCleanupPeriodDays } from "@shared/claude-settings.ts";
import { mapBounded } from "../../util/map-bounded.ts";
import { CLAUDE_PROJECTS_DIR, claudeProjectDir } from "./project-dir.ts";
import { readClaudeLaunchContext } from "./launch-context.ts";
import { claudeHistoryMessages, claudeSubagentMessages, toHistoryMessage, toMessage } from "./transcript.ts";

/**
 * Claude Code's history reader: `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl`.
 *
 * Only top-level transcripts are sessions. Subagent runs live under `<sessionId>/subagents/`
 * and belong to their parent, so they are counted, never listed.
 *
 * Everything is read from records. The project folder name is a lossy encoding of the cwd
 * (every non-alphanumeric character becomes `-`), so it is never decoded back into a path.
 *
 * Only one Claude Code version was available to measure (2.1.296), so every reader here
 * tolerates record and attachment types it does not know: they are skipped, never fatal.
 */

const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** The first prompt is a title fallback and a search seed, not a transcript. */
const FIRST_PROMPT_CAP = 500;
const READ_CHUNK = 1 << 20;
const NEWLINE = 0x0a;
/** The tools a read-only reviewer is allowed, and nothing else. */
const REVIEWER_TOOLS = new Set(["Read", "Glob", "Grep", "StructuredOutput"]);
const READ_TOOLS = ["Read", "Glob", "Grep"];
/** `prompt_snapshot.cliPrefix` for Claude Code's own preset, as opposed to "You are a Claude agent". */
const CLAUDE_CODE_PREFIX = "You are Claude Code";
/** Claude Code's own default for `cleanupPeriodDays`, used while the setting is unset. */
const DEFAULT_CLEANUP_DAYS = 30;
const CLEANUP_SETTING_URL = "https://code.claude.com/docs/en/settings-reference#cleanupperioddays";

/** The tool list and preset a session's `prompt_snapshot` recorded. */
export interface ClaudePromptSnapshot {
  tools: string[];
  cliPrefix: string | null;
}

/**
 * The plan's six rules, in order; the first match wins.
 *
 * `snapshot` is the first `prompt_snapshot` that carried a tool list, or null when none did.
 * A session can record a second snapshot with no `tools` field at all, and that one says
 * nothing about tools - so it is never read as an empty tool set, exactly as a missing
 * snapshot is not.
 */
export function classifyClaudeSession(input: {
  entrypoint: string | null;
  snapshot: ClaudePromptSnapshot | null;
}): HistoryKind {
  if (input.entrypoint === "cli") return "interactive";
  const snapshot = input.snapshot;
  if (!snapshot) return "unclassified";
  const tools = snapshot.tools;
  if (tools.every((name) => name === "StructuredOutput")) return "one_shot";
  if (tools.some((name) => READ_TOOLS.includes(name)) && tools.every((name) => REVIEWER_TOOLS.has(name))) {
    return "reviewer";
  }
  if (snapshot.cliPrefix?.startsWith(CLAUDE_CODE_PREFIX)) return "sdk";
  return "unclassified";
}

/**
 * Everything a parse carries between calls. Serialized as the row's reader state, so an
 * appended transcript folds in only its new lines.
 */
interface Accumulator {
  cwd: string | null;
  entrypoint: string | null;
  version: string | null;
  branch: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  firstPrompt: string | null;
  firstAt: number | null;
  lastAt: number | null;
  model: string | null;
  cost: {
    usd: number | null;
    durationMs: number | null;
    startTime: number | null;
    linesAdded: number | null;
    linesRemoved: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
  } | null;
  prUrls: string[];
  continuedIn: string | null;
  snapshot: ClaudePromptSnapshot | null;
}

function emptyAccumulator(): Accumulator {
  return {
    cwd: null,
    entrypoint: null,
    version: null,
    branch: null,
    customTitle: null,
    aiTitle: null,
    firstPrompt: null,
    firstAt: null,
    lastAt: null,
    model: null,
    cost: null,
    prUrls: [],
    continuedIn: null,
    snapshot: null,
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sumUsage(usage: unknown, keys: readonly string[]): number | null {
  if (!usage || typeof usage !== "object") return null;
  let total = 0;
  let any = false;
  for (const entry of Object.values(usage as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    for (const key of keys) {
      const value = num((entry as Record<string, unknown>)[key]);
      if (value !== null) {
        total += value;
        any = true;
      }
    }
  }
  return any ? total : null;
}

/**
 * Fold one parsed record into the accumulator. Unknown shapes are skipped. A user prompt the
 * record carries is also pushed onto `prompts`, when given, for the search index; prompts are
 * not part of the accumulator, so the reader state stays small.
 */
function foldClaudeRecord(acc: Accumulator, record: unknown, prompts: string[] | null): void {
  if (!record || typeof record !== "object") return;
  const rec = record as Record<string, unknown>;
  // A subagent's records can be inlined into the parent; they are not this session's place.
  const sidechain = rec.isSidechain === true;
  const at = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
  if (Number.isFinite(at)) {
    if (acc.firstAt === null || at < acc.firstAt) acc.firstAt = at;
    if (acc.lastAt === null || at > acc.lastAt) acc.lastAt = at;
  }
  if (!sidechain) {
    // The FIRST cwd: a session that changes directory mid-way still belongs where it began.
    acc.cwd ??= str(rec.cwd);
    acc.entrypoint ??= str(rec.entrypoint);
    acc.version = str(rec.version) ?? acc.version;
    // The newest named branch. A session usually starts detached ("HEAD") in a pool slot and
    // moves onto its branch later, and the branch is the useful answer.
    const branch = str(rec.gitBranch);
    if (branch && branch !== "HEAD") acc.branch = branch;
  }
  switch (rec.type) {
    case "custom-title":
      acc.customTitle = str(rec.customTitle) ?? acc.customTitle;
      return;
    case "ai-title":
      acc.aiTitle = str(rec.aiTitle) ?? acc.aiTitle;
      return;
    case "pr-link": {
      const url = str(rec.prUrl);
      if (url && !acc.prUrls.includes(url)) acc.prUrls.push(url);
      return;
    }
    case "continued-in":
      acc.continuedIn = str(rec.continuedInSessionId) ?? acc.continuedIn;
      return;
    case "cost-state":
      // Cumulative: the newest record is the session's total so far.
      acc.cost = {
        usd: num(rec.totalCostUSD),
        durationMs: num(rec.totalDuration),
        startTime: num(rec.startTime),
        linesAdded: num(rec.totalLinesAdded),
        linesRemoved: num(rec.totalLinesRemoved),
        inputTokens: sumUsage(rec.modelUsage, ["inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]),
        outputTokens: sumUsage(rec.modelUsage, ["outputTokens"]),
      };
      return;
    case "attachment": {
      const attachment = rec.attachment as Record<string, unknown> | undefined;
      if (attachment?.type === "prompt_snapshot" && !acc.snapshot && Array.isArray(attachment.tools)) {
        acc.snapshot = {
          tools: attachment.tools
            .map((tool) => (tool && typeof tool === "object" ? str((tool as Record<string, unknown>).name) : null))
            .filter((name): name is string => name !== null),
          cliPrefix: str(attachment.cliPrefix),
        };
      }
      break;
    }
    case "assistant": {
      if (sidechain) return;
      const model = str((rec.message as Record<string, unknown> | undefined)?.model);
      if (model && model !== "<synthetic>") acc.model = model;
      return;
    }
  }
  // A compaction summary arrives as a `user` record but is Claude's own words, not the
  // operator's, so it is neither a prompt to index nor a title.
  if (sidechain || rec.isCompactSummary === true || (acc.firstPrompt !== null && prompts === null)) return;
  const message = toMessage(rec);
  if (message?.role !== "user" || !message.text) return;
  prompts?.push(message.text);
  if (acc.firstPrompt === null) {
    acc.firstPrompt = message.text.length > FIRST_PROMPT_CAP
      ? `${message.text.slice(0, FIRST_PROMPT_CAP - 1)}…`
      : message.text;
  }
}

function summaryOf(acc: Accumulator, subagentCount: number): HistorySummary {
  const startedAt = acc.cost?.startTime ?? acc.firstAt;
  const durationMs = acc.cost?.durationMs
    ?? (startedAt !== null && acc.lastAt !== null ? Math.max(0, acc.lastAt - startedAt) : null);
  return {
    cwd: acc.cwd,
    branch: acc.branch,
    entrypoint: acc.entrypoint,
    version: acc.version,
    kind: classifyClaudeSession({ entrypoint: acc.entrypoint, snapshot: acc.snapshot }),
    customTitle: acc.customTitle,
    aiTitle: acc.aiTitle,
    firstPrompt: acc.firstPrompt,
    startedAt,
    lastActivityAt: acc.lastAt,
    durationMs,
    model: acc.model,
    costUsd: acc.cost?.usd ?? null,
    inputTokens: acc.cost?.inputTokens ?? null,
    outputTokens: acc.cost?.outputTokens ?? null,
    linesAdded: acc.cost?.linesAdded ?? null,
    linesRemoved: acc.cost?.linesRemoved ?? null,
    prUrls: [...acc.prUrls],
    continuedIn: acc.continuedIn,
    subagentCount,
  };
}

function restore(state: string | null): Accumulator | null {
  if (!state) return null;
  try {
    const parsed = JSON.parse(state) as Accumulator;
    return parsed && typeof parsed === "object" && Array.isArray(parsed.prUrls) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Fold every complete line from `offset` on. Returns the offset just past the last newline,
 * so a line still being written is read whole on the next call rather than half now. Prompts
 * are collected from complete lines only, for the same reason.
 */
async function foldFrom(path: string, offset: number, acc: Accumulator, prompts: string[]): Promise<number> {
  const handle = await open(path, "r");
  try {
    let position = offset;
    let parsedTo = offset;
    let carry: Buffer = Buffer.alloc(0);
    const chunk = Buffer.alloc(READ_CHUNK);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let start = 0;
      for (let i = data.indexOf(NEWLINE); i !== -1; i = data.indexOf(NEWLINE, start)) {
        const line = data.toString("utf8", start, i).trim();
        if (line) {
          try {
            foldClaudeRecord(acc, JSON.parse(line), prompts);
          } catch {
            // A malformed line is skipped, never fatal: one bad record must not hide a session.
          }
        }
        start = i + 1;
      }
      parsedTo = position - (data.length - start);
      carry = Buffer.from(data.subarray(start));
    }
    // A last record with no newline yet is folded but not counted as parsed, so the next call
    // reads it again. Folding is idempotent for every field, so reading it twice is harmless.
    const tail = carry.toString("utf8").trim();
    if (tail) {
      try {
        foldClaudeRecord(acc, JSON.parse(tail), null);
      } catch {
        // Still being written.
      }
    }
    return parsedTo;
  } finally {
    await handle.close();
  }
}

/**
 * How many subagent runs a session's detail will list: the same regular files with an id in
 * the route's format that `subagents` lists, so the row's count and the detail always agree.
 */
async function countSubagents(transcriptPath: string, agentSessionId: string): Promise<number> {
  try {
    const entries = await readdir(join(dirname(transcriptPath), agentSessionId, SUBAGENT_DIR), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && subagentIdOf(entry.name) !== null).length;
  } catch {
    return 0;
  }
}

/** Where Claude Code keeps a session's large tool outputs and its subagent runs, beside the transcript. */
const SIDECAR_DIR = "tool-results";
const SUBAGENT_DIR = "subagents";
const SUBAGENT_ID = /^agent-(.+)\.jsonl$/;

/** The run id a listed file name carries, or null when it is not a subagent run History can address. */
function subagentIdOf(name: string): string | null {
  const agentId = SUBAGENT_ID.exec(name)?.[1];
  return agentId && isHistorySubagentId(agentId) ? agentId : null;
}
/** The bytes of a subagent transcript read for its label and start time. */
const SUBAGENT_HEAD_BYTES = 64 * 1024;
const SUBAGENT_PROMPT_CAP = 200;
/** Subagent runs whose label is read at once: each holds up to two files open. */
const SUBAGENT_LABEL_CONCURRENCY = 8;
/** How Claude Code wraps the preview of an output it saved to a sidecar file, and closes it. */
const PERSISTED_OUTPUT = "<persisted-output>";
const PERSISTED_OUTPUT_END = "</persisted-output>";
/**
 * The preview's "saved to" line, and the file name after `tool-results/` in the path it prints:
 * one segment, never a separator.
 */
const SAVED_TO = /saved to:?[ \t]+\S*tool-results\/([^/\\\s"'<>]{1,255})/i;

/** A tool result's content as text: a string, or its text blocks, with an image as a placeholder. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "image") parts.push("[image]");
    }
  }
  return parts.join("\n");
}

/**
 * The sidecar file a result record names, or null. Claude Code replaces an output too large to
 * keep inline with a `<persisted-output>` preview whose "saved to" line prints the file's path.
 * Only that line of a result that IS such a preview names a file: a result that merely mentions
 * a path into `tool-results/` (a `wc -l` on a saved output, an error naming one) or quotes
 * another record's preview is its own inline result.
 * Only the path's last segment is taken, so the record names a file and never a place.
 */
function sidecarName(text: string): string | null {
  // The preview replaces the whole output, so a result is one only when it opens with the
  // marker. A result that quotes a preview mid-text (a grep over transcripts, a Read of one)
  // is that tool's own output, and names no file of this call's.
  const body = text.trimStart();
  if (!body.startsWith(PERSISTED_OUTPUT)) return null;
  const end = body.indexOf(PERSISTED_OUTPUT_END);
  const block = body.slice(PERSISTED_OUTPUT.length, end === -1 ? undefined : end);
  const name = SAVED_TO.exec(block)?.[1];
  return name && name !== "." && name !== ".." ? name : null;
}

/**
 * The `tool_result` block answering `toolUseId`, and its record, read forward through the
 * whole transcript. A line that does not contain the id is never parsed.
 */
async function findToolResult(
  path: string,
  toolUseId: string,
): Promise<{ record: Record<string, unknown>; block: Record<string, unknown> } | null> {
  const stream = createReadStream(path);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes(toolUseId)) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record || typeof record !== "object") continue;
      const rec = record as Record<string, unknown>;
      const content = (rec.message as Record<string, unknown> | undefined)?.content;
      if (rec.type !== "user" || !Array.isArray(content)) continue;
      for (const block of content) {
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (b.type === "tool_result" && b.tool_use_id === toolUseId) return { record: rec, block: b };
        }
      }
    }
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * The regular files in a session's own `subagents/` folder, or none when the folder is missing,
 * unreadable, or resolves anywhere else (then it is not this session's). A symlink in the
 * listing is never followed, here or by the route.
 */
async function subagentListing(folder: string): Promise<Set<string>> {
  try {
    if ((await realpath(folder)) !== folder) return new Set();
    const entries = await readdir(folder, { withFileTypes: true });
    return new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  } catch {
    return new Set();
  }
}

/** A subagent's metadata file, read leniently: a missing or malformed one labels nothing. */
async function subagentMeta(path: string): Promise<{ agentType: string | null; description: string | null }> {
  try {
    const meta = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    return { agentType: str(meta.agentType), description: str(meta.description) };
  } catch {
    return { agentType: null, description: null };
  }
}

/** A subagent transcript's opening prompt and first timestamp, from its first bytes. */
async function subagentHead(path: string): Promise<{ firstPrompt: string | null; startedAt: number | null }> {
  let text: string;
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(SUBAGENT_HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, SUBAGENT_HEAD_BYTES, 0);
      text = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return { firstPrompt: null, startedAt: null };
  }
  let firstPrompt: string | null = null;
  let startedAt: number | null = null;
  for (const line of text.split("\n")) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const at = typeof (record as Record<string, unknown>)?.timestamp === "string"
      ? Date.parse((record as Record<string, unknown>).timestamp as string)
      : NaN;
    if (startedAt === null && Number.isFinite(at)) startedAt = at;
    const message: TranscriptMessage | null = firstPrompt === null ? toHistoryMessage(record, true) : null;
    if (message?.role === "user" && message.text) {
      firstPrompt = message.text.length > SUBAGENT_PROMPT_CAP ? `${message.text.slice(0, SUBAGENT_PROMPT_CAP - 1)}…` : message.text;
    }
    if (firstPrompt !== null && startedAt !== null) break;
  }
  return { firstPrompt, startedAt };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/**
 * The mode a transcript last recorded, from its `permission-mode` records: Claude writes one
 * when a session starts and again each time the mode changes, so the last one is where the
 * operator left it. Only lines naming the record type are parsed.
 */
async function lastPermissionMode(path: string): Promise<PermissionMode | null> {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let mode: PermissionMode | null = null;
  for await (const line of lines) {
    if (!line.includes('"permission-mode"')) continue;
    try {
      const record = JSON.parse(line) as { type?: unknown; permissionMode?: unknown };
      if (record.type === "permission-mode" && (PERMISSION_MODES as readonly unknown[]).includes(record.permissionMode)) {
        mode = record.permissionMode as PermissionMode;
      }
    } catch {
      // A malformed line is skipped, as everywhere else in this reader.
    }
  }
  return mode;
}

/** Built over a projects directory so a test can point it at a fixture store. */
export function createClaudeHistory(projectsDir: string = CLAUDE_PROJECTS_DIR): HistorySpec {
  return {
    roots: () => [projectsDir],
    messages: claudeHistoryMessages,
    subagentMessages: claudeSubagentMessages,
    launchContext: readClaudeLaunchContext,
    permissionMode: lastPermissionMode,

    async toolResult(transcriptPath, agentSessionId, toolUseId): Promise<HistoryRecordedToolResult | null> {
      const found = await findToolResult(transcriptPath, toolUseId);
      if (!found) return null;
      const text = resultText(found.block.content);
      const name = sidecarName(text);
      return {
        isError: found.block.is_error === true,
        text,
        sidecar: name ? { folder: join(dirname(transcriptPath), agentSessionId, SIDECAR_DIR), name } : null,
      };
    },

    async subagents(transcriptPath, agentSessionId): Promise<HistorySubagentFile[]> {
      const folder = join(dirname(transcriptPath), agentSessionId, SUBAGENT_DIR);
      const files = await subagentListing(folder);
      // Bounded: each label read holds a file open across its awaits, and a session can have
      // hundreds of runs. An unbounded fan-out could exhaust file descriptors, and the readers
      // would then answer EMFILE with blank labels.
      const runs = await mapBounded([...files], SUBAGENT_LABEL_CONCURRENCY, async (name): Promise<HistorySubagentFile | null> => {
        const agentId = subagentIdOf(name);
        if (!agentId) return null;
        const path = join(folder, name);
        const metaName = `agent-${agentId}.meta.json`;
        const meta = files.has(metaName) ? await subagentMeta(join(folder, metaName)) : { agentType: null, description: null };
        return { agentId, path, folder, ...meta, ...(await subagentHead(path)) };
      });
      return runs
        .filter((run): run is HistorySubagentFile => run !== null)
        .sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || (a.agentId < b.agentId ? -1 : 1));
    },

    async subagentFile(transcriptPath, agentSessionId, agentId) {
      // The same listing `subagents` reads, without opening any run to label it: a page read
      // needs only the one file.
      if (!isHistorySubagentId(agentId)) return null;
      const folder = join(dirname(transcriptPath), agentSessionId, SUBAGENT_DIR);
      const name = `agent-${agentId}.jsonl`;
      return (await subagentListing(folder)).has(name) ? { path: join(folder, name), folder } : null;
    },

    async enumerate(root) {
      let projects;
      try {
        projects = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      const files: HistoryFile[] = [];
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        const dir = join(root, project.name);
        let names: string[];
        try {
          names = await readdir(dir);
        } catch (error) {
          // A project folder removed mid-walk is simply not there. Anything else (EACCES, EIO,
          // EMFILE) means the walk did not see it, and an incomplete walk must decide nothing:
          // read as empty, every row in the folder would be marked gone.
          if (isMissing(error)) continue;
          throw error;
        }
        const stats = await Promise.all(names.map(async (name) => {
          const match = SESSION_FILE.exec(name);
          if (!match) return null;
          const path = join(dir, name);
          try {
            const stat = await lstat(path);
            if (!stat.isFile()) return null;
            return {
              path,
              agentSessionId: match[1]!.toLowerCase(),
              fingerprint: { size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), ino: stat.ino },
            } satisfies HistoryFile;
          } catch (error) {
            // Removed between the listing and the stat. Any other failure is a file the walk
            // could not see, so it fails the walk for the reason above.
            if (isMissing(error)) return null;
            throw error;
          }
        }));
        for (const file of stats) if (file) files.push(file);
      }
      return files;
    },

    async summarize(file, previous: HistoryParsePoint | null): Promise<HistoryParse | null> {
      // Claude only appends. A new inode is a different file at the same path, and a file
      // smaller than it was (or than the bytes already folded) was truncated or rewritten:
      // either way the accumulated state describes bytes that are gone, so start over.
      const resumable = previous
        && previous.ino === file.fingerprint.ino
        && file.fingerprint.size >= Math.max(previous.size, previous.parsedBytes)
        ? restore(previous.state)
        : null;
      const acc = resumable ?? emptyAccumulator();
      const from = resumable ? previous!.parsedBytes : 0;
      const prompts: string[] = [];
      const parsedBytes = await foldFrom(file.path, from, acc, prompts);
      if (acc.firstAt === null && acc.cwd === null && acc.entrypoint === null) return null;
      return {
        summary: summaryOf(acc, await countSubagents(file.path, file.agentSessionId)),
        parsedBytes,
        state: JSON.stringify(acc),
        prompts,
        fromStart: !resumable,
      };
    },

    canonical(candidates) {
      // The file in the project folder Claude itself would choose for the session's first
      // cwd; then the earliest start; then the path, so the answer never depends on order.
      const native = candidates.filter(({ path, summary }) =>
        summary.cwd !== null && basename(dirname(path)) === basename(claudeProjectDir(summary.cwd)));
      const pool = native.length > 0 ? native : candidates;
      const sorted = [...pool].sort((a, b) => {
        const left = a.summary.startedAt ?? Number.POSITIVE_INFINITY;
        const right = b.summary.startedAt ?? Number.POSITIVE_INFINITY;
        if (left !== right) return left - right;
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      });
      return sorted[0]!.path;
    },

    retention() {
      // The user settings file only: the header speaks for the whole machine, and a project's
      // own `.claude/settings.json` applies to that project's sessions alone.
      const days = claudeCleanupPeriodDays();
      return {
        days: days ?? DEFAULT_CLEANUP_DAYS,
        configured: days !== null,
        setting: "cleanupPeriodDays",
        settingUrl: CLEANUP_SETTING_URL,
      };
    },
  };
}

export const claudeHistory: HistorySpec = createClaudeHistory();
