import { lstat, open, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { HistoryKind } from "@shared/history.ts";
import type {
  HistoryFile,
  HistoryParse,
  HistoryParsePoint,
  HistorySpec,
  HistorySummary,
} from "../types.ts";
import { CLAUDE_PROJECTS_DIR, claudeProjectDir } from "./project-dir.ts";
import { toMessage } from "./transcript.ts";

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
const SUBAGENT_FILE = /^agent-[^/]+\.jsonl$/;
/** The first prompt is a title fallback and a search seed, not a transcript. */
const FIRST_PROMPT_CAP = 500;
const READ_CHUNK = 1 << 20;
const NEWLINE = 0x0a;
/** The tools a read-only reviewer is allowed, and nothing else. */
const REVIEWER_TOOLS = new Set(["Read", "Glob", "Grep", "StructuredOutput"]);
const READ_TOOLS = ["Read", "Glob", "Grep"];
/** `prompt_snapshot.cliPrefix` for Claude Code's own preset, as opposed to "You are a Claude agent". */
const CLAUDE_CODE_PREFIX = "You are Claude Code";

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

/** Fold one parsed record into the accumulator. Unknown shapes are skipped. */
function foldClaudeRecord(acc: Accumulator, record: unknown): void {
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
  if (acc.firstPrompt === null && !sidechain) {
    const message = toMessage(rec);
    if (message?.role === "user" && message.text) {
      acc.firstPrompt = message.text.length > FIRST_PROMPT_CAP
        ? `${message.text.slice(0, FIRST_PROMPT_CAP - 1)}…`
        : message.text;
    }
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
 * so a line still being written is read whole on the next call rather than half now.
 */
async function foldFrom(path: string, offset: number, acc: Accumulator): Promise<number> {
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
            foldClaudeRecord(acc, JSON.parse(line));
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
        foldClaudeRecord(acc, JSON.parse(tail));
      } catch {
        // Still being written.
      }
    }
    return parsedTo;
  } finally {
    await handle.close();
  }
}

async function countSubagents(transcriptPath: string, agentSessionId: string): Promise<number> {
  try {
    const names = await readdir(join(dirname(transcriptPath), agentSessionId, "subagents"));
    return names.filter((name) => SUBAGENT_FILE.test(name)).length;
  } catch {
    return 0;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** Built over a projects directory so a test can point it at a fixture store. */
export function createClaudeHistory(projectsDir: string = CLAUDE_PROJECTS_DIR): HistorySpec {
  return {
    roots: () => [projectsDir],

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
      const parsedBytes = await foldFrom(file.path, from, acc);
      if (acc.firstAt === null && acc.cwd === null && acc.entrypoint === null) return null;
      return {
        summary: summaryOf(acc, await countSubagents(file.path, file.agentSessionId)),
        parsedBytes,
        state: JSON.stringify(acc),
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
  };
}

export const claudeHistory: HistorySpec = createClaudeHistory();
