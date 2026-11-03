import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type {
  HistoryEnvironment,
  HistoryHookRun,
  HistoryInstructionFile,
  HistoryLaunchContext,
  HistoryMcpServer,
} from "@shared/history.ts";
import { STANDING_INSTRUCTIONS_HEADING, STANDING_INSTRUCTIONS_MULTI_HEADING } from "../../instructions/compose.ts";

/**
 * What a Claude session was launched with, read from its transcript's own records.
 *
 * Claude Code records launch context as snapshots: `attachment` records whose content is what
 * that session loaded, so an instruction file's text here is the session's copy, not today's
 * file. Nothing is copied into the catalog; the transcript is read whole each time it is asked.
 *
 * A section the transcript holds no record of comes back null ("not recorded"), never empty:
 * a missing `instructions` record is ambiguous between "no files" and a restricted
 * `--setting-sources`. Unknown records and attachment types are skipped.
 */

const STANDING_HEADINGS = [STANDING_INSTRUCTIONS_HEADING, STANDING_INSTRUCTIONS_MULTI_HEADING];
const COMMAND_NAME = /<command-name>\/?([^<\s]+)<\/command-name>/g;
const MCP_TOOL = /^mcp__(.+?)__/;

type Rec = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function record(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Rec : null;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => str(item) ?? str(record(item)?.name))
    .filter((name): name is string => name !== null);
}

/** Claude's own spelling of a server inside a tool name: anything but `[A-Za-z0-9_-]` becomes `_`. */
function serverKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Split one appended system-prompt value into what came before the standing-instructions block
 * and the block itself. A terminal launch joins every contributor into ONE value with the
 * standing instructions last (`systemPromptAppendArgs`), so the block runs to the end.
 */
function splitStanding(block: string): { before: string; standing: string | null } {
  let at = -1;
  for (const heading of STANDING_HEADINGS) {
    if (block.startsWith(heading)) return { before: "", standing: block };
    const index = block.indexOf(`\n\n${heading}`);
    if (index !== -1 && (at === -1 || index < at)) at = index;
  }
  if (at === -1) return { before: block, standing: null };
  return { before: block.slice(0, at).trim(), standing: block.slice(at + 2) };
}

class LaunchContextReader {
  private instructionFiles: HistoryInstructionFile[] | null = null;
  private systemPrompt: string[] | null = null;
  private skillsAvailable: string[] | null = null;
  private readonly skillsUsed = new Set<string>();
  private readonly commandNames = new Set<string>();
  /** Keyed by `serverKey`, in first-seen order. `explicit` statuses come from the server lists. */
  private readonly servers = new Map<string, HistoryMcpServer & { explicit: boolean }>();
  private readonly tools = new Set<string>();
  private mcpRecorded = false;
  private readonly hooks = new Map<string, HistoryHookRun>();
  private readonly env: HistoryEnvironment = {
    cwd: null,
    branch: null,
    gitStatus: null,
    isWorktree: null,
    isGitRepo: null,
    additionalDirectories: null,
    platform: null,
    shell: null,
    osVersion: null,
    model: null,
    effort: null,
    permissionMode: null,
  };
  private firstCwd: string | null = null;
  private firstModel: string | null = null;

  fold(rec: Rec): void {
    if (rec.isSidechain !== true) {
      this.firstCwd ??= str(rec.cwd);
      this.env.branch ??= str(rec.gitBranch);
      // A `permission-mode` record, or the field a user record carries beside its prompt.
      this.env.permissionMode ??= str(rec.permissionMode);
    }
    switch (rec.type) {
      case "attachment": {
        const attachment = record(rec.attachment);
        if (attachment) this.attachment(attachment);
        return;
      }
      case "system":
        if (rec.subtype === "stop_hook_summary" && Array.isArray(rec.hookInfos)) {
          for (const info of rec.hookInfos) {
            const command = str(record(info)?.command);
            if (command) this.hook(str(rec.hookEvent) ?? "Stop", command, record(info)?.durationMs, false);
          }
        }
        return;
      case "assistant":
        this.assistant(rec);
        return;
      case "user": {
        // The raw content: the message renderer unwraps these tags, and they are the signal here.
        const content = record(rec.message)?.content;
        const text = typeof content === "string"
          ? content
          : Array.isArray(content) ? content.map((block) => str(record(block)?.text) ?? "").join("\n") : "";
        for (const match of text.matchAll(COMMAND_NAME)) this.commandNames.add(match[1]!);
        return;
      }
    }
  }

  private attachment(a: Rec): void {
    switch (a.type) {
      case "instructions": {
        if (!Array.isArray(a.files)) return;
        const files = (this.instructionFiles ??= []);
        const reason = str(a.reason);
        for (const raw of a.files) {
          const file = record(raw);
          const path = str(file?.path);
          if (!file || !path || typeof file.content !== "string") continue;
          const entry = { path, scope: str(file.type), reason, content: file.content };
          // A file reloaded unchanged for the same reason says nothing new.
          if (!files.some((f) => f.path === path && f.content === entry.content && f.reason === reason)) files.push(entry);
        }
        return;
      }
      case "prompt_snapshot":
        if (this.systemPrompt === null && Array.isArray(a.systemPrompt)) {
          this.systemPrompt = a.systemPrompt.filter((block): block is string => typeof block === "string");
        }
        for (const name of strings(a.tools)) this.mcpTool(name);
        return;
      case "skill_listing": {
        const available = (this.skillsAvailable ??= []);
        for (const name of strings(a.names)) if (!available.includes(name)) available.push(name);
        return;
      }
      case "invoked_skills":
        for (const name of strings(a.skills)) this.skillsUsed.add(name);
        return;
      case "deferred_tools_delta": {
        this.mcpRecorded = true;
        for (const name of strings(a.addedNames)) this.mcpTool(name);
        for (const name of strings(a.removedNames)) this.tools.delete(name);
        for (const name of strings(a.pendingMcpServers)) this.server(name, "pending");
        for (const name of strings(a.needsAuthMcpServers)) this.server(name, "needs_auth");
        for (const name of strings(a.failedMcpServers)) this.server(name, "failed");
        return;
      }
      case "mcp_instructions_delta": {
        this.mcpRecorded = true;
        const names = strings(a.addedNames);
        const blocks = Array.isArray(a.addedBlocks) ? a.addedBlocks : [];
        names.forEach((name, i) => this.server(name, "connected", str(blocks[i])));
        return;
      }
      case "environment": {
        const snapshot = record(a.snapshot);
        if (!snapshot) return;
        this.env.cwd ??= str(snapshot.workingDirectory);
        this.env.isWorktree ??= typeof snapshot.isWorktree === "boolean" ? snapshot.isWorktree : null;
        this.env.isGitRepo ??= typeof snapshot.isGitRepo === "boolean" ? snapshot.isGitRepo : null;
        this.env.additionalDirectories ??= Array.isArray(snapshot.additionalWorkingDirectories)
          ? strings(snapshot.additionalWorkingDirectories)
          : null;
        this.env.platform ??= str(snapshot.platform);
        this.env.shell ??= str(snapshot.shell);
        this.env.osVersion ??= str(snapshot.osVersion);
        return;
      }
      case "session_context":
        // Only the git status: the same record carries the account's email, which is not launch context.
        this.env.gitStatus ??= str(record(a.context)?.gitStatus);
        return;
      case "model":
        this.env.model ??= str(record(a.identity)?.modelId);
        return;
      case "hook_cancelled": {
        const command = str(a.command);
        if (command) this.hook(str(a.hookEvent) ?? str(a.hookName) ?? "unknown", command, a.durationMs, true);
        return;
      }
    }
  }

  private assistant(rec: Rec): void {
    const skill = str(rec.attributionSkill);
    if (skill) this.skillsUsed.add(skill);
    if (rec.isSidechain !== true) {
      const effort = rec.effort;
      this.env.effort ??= str(effort) ?? (typeof effort === "number" ? String(effort) : null);
    }
    const message = record(rec.message);
    const model = str(message?.model);
    if (rec.isSidechain !== true && model && model !== "<synthetic>") this.firstModel ??= model;
    if (!Array.isArray(message?.content)) return;
    for (const block of message.content) {
      const item = record(block);
      if (item?.type === "tool_use" && item.name === "Skill") {
        const name = str(record(item.input)?.skill);
        if (name) this.skillsUsed.add(name);
      }
    }
  }

  private mcpTool(name: string): void {
    const match = MCP_TOOL.exec(name);
    if (!match) return;
    this.mcpRecorded = true;
    this.tools.add(name);
    const key = match[1]!;
    // A tool says its server answered, but never overrides a status the server lists stated:
    // a server awaiting authentication can still offer its own sign-in tool.
    if (!this.servers.has(key)) this.servers.set(key, { name: key, status: "connected", instructions: null, explicit: false });
  }

  private server(name: string, status: string, instructions: string | null = null): void {
    const key = serverKey(name);
    const known = this.servers.get(key);
    // The newest mention wins: a server pending at launch that connected later is connected.
    this.servers.set(key, {
      name: known?.explicit ? known.name : name,
      status,
      instructions: instructions ?? known?.instructions ?? null,
      explicit: true,
    });
  }

  private hook(event: string, command: string, durationMs: unknown, cancelled: boolean): void {
    const ms = typeof durationMs === "number" && Number.isFinite(durationMs) ? durationMs : 0;
    const key = `${event}\u0000${command}`;
    const run = this.hooks.get(key) ?? { event, command, runs: 0, totalMs: 0, maxMs: 0, failures: 0 };
    run.runs += 1;
    run.totalMs += ms;
    run.maxMs = Math.max(run.maxMs, ms);
    if (cancelled) run.failures += 1;
    this.hooks.set(key, run);
  }

  result(): HistoryLaunchContext {
    let systemPrompt: HistoryLaunchContext["systemPrompt"] = null;
    if (this.systemPrompt !== null) {
      const appended: string[] = [];
      let standing: string | null = null;
      for (const block of this.systemPrompt) {
        const split = splitStanding(block);
        if (split.before) appended.push(split.before);
        if (split.standing !== null) standing ??= split.standing;
      }
      systemPrompt = { standingInstructions: standing, appended };
    }
    const available = this.skillsAvailable;
    // A slash command is a skill only when the listing names it; `/clear` and its kin are not.
    for (const name of this.commandNames) if (available?.includes(name)) this.skillsUsed.add(name);
    return {
      instructionFiles: this.instructionFiles,
      systemPrompt,
      skills: { available, used: [...this.skillsUsed] },
      mcp: this.mcpRecorded
        ? {
            servers: [...this.servers.values()].map(({ explicit: _, ...server }) => server),
            tools: [...this.tools],
          }
        : null,
      environment: { ...this.env, cwd: this.env.cwd ?? this.firstCwd, model: this.env.model ?? this.firstModel },
      hooks: this.hooks.size > 0 ? [...this.hooks.values()] : null,
    };
  }
}

/** Read one Claude transcript's launch context. Rejects only when the file cannot be read. */
export async function readClaudeLaunchContext(path: string): Promise<HistoryLaunchContext> {
  const reader = new LaunchContextReader();
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A malformed or half-written line is skipped, never fatal.
      continue;
    }
    const rec = record(parsed);
    if (rec) reader.fold(rec);
  }
  return reader.result();
}
