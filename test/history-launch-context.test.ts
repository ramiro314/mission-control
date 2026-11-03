import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Session History's Launch context: what a Claude session was launched with, parsed on demand
 * from its transcript's own snapshot records. Every section a transcript carries is read; a
 * section it does not carry is null ("not recorded"), never an empty list.
 *
 * Every transcript is a fixture in a temp projects directory; nothing reads `~/.claude`.
 */

const home = mkdtempSync(join(tmpdir(), "mission-history-launch-"));
process.env.MISSION_HOME = home;

const { readClaudeLaunchContext } = await import("../src/server/harness/claude/launch-context.ts");
const { createClaudeHistory } = await import("../src/server/harness/claude/history.ts");
const { HistoryService } = await import("../src/server/history/service.ts");
const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
import type { HistoryLaunchContext } from "../src/shared/history.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";

const LOOPBACK = { host: "127.0.0.1:7317" };
const ID = "00000000-0000-4000-8000-000000000001";
const BARE_ID = "00000000-0000-4000-8000-000000000002";
const base = { sessionId: ID, cwd: "/work/app", entrypoint: "cli", version: "2.1.296", gitBranch: "fix-login", isSidechain: false, timestamp: "2026-10-20T10:00:00.000Z" };
const attachment = (body: Record<string, unknown>) => ({ ...base, type: "attachment", attachment: body });

/** A session that recorded every launch-context section, plus records no reader knows. */
function fullTranscript(): unknown[] {
  return [
    { ...base, type: "permission-mode", permissionMode: "auto" },
    attachment({
      type: "instructions",
      reason: "session_start",
      files: [
        { path: "/home/op/.claude/CLAUDE.md", type: "User", content: "# Global\nPrefer bun." },
        { path: "/work/app/CLAUDE.md", type: "Project", content: "# App\nRun the focused test only." },
      ],
    }),
    attachment({ type: "instructions", files: [{ path: "/home/op/.claude/projects/-work-app/memory/MEMORY.md", type: "AutoMem", content: "- [Pinned](pinned.md)" }] }),
    attachment({
      type: "prompt_snapshot",
      cliPrefix: "You are Claude Code, Anthropic's official CLI",
      tools: [{ name: "Read" }, { name: "Bash" }, { name: "mcp__docs__search" }],
      systemPrompt: [
        "Use the ask channel for questions.\n\n## Standing instructions for this repository\n\nNever run the full suite.",
      ],
    }),
    attachment({ type: "skill_listing", names: ["tdd", "code-review", "brief"], skillCount: 3, isInitial: true, content: "…" }),
    attachment({ type: "mcp_instructions_delta", addedNames: ["docs"], addedBlocks: ["Search the docs first."], removedNames: [] }),
    attachment({
      type: "deferred_tools_delta",
      addedNames: ["mcp__docs__read", "mcp__claude_ai_Slack__authenticate", "ArtifactComments"],
      removedNames: [],
      pendingMcpServers: ["claude.ai Gmail"],
      needsAuthMcpServers: ["claude.ai Slack"],
      failedMcpServers: ["broken-server"],
    }),
    attachment({
      type: "environment",
      snapshot: {
        workingDirectory: "/work/app",
        isWorktree: true,
        isGitRepo: true,
        additionalWorkingDirectories: ["/work/shared"],
        platform: "linux",
        shell: "zsh",
        osVersion: "Linux 7.2",
      },
    }),
    attachment({ type: "session_context", context: { userEmail: "op@example.com", gitStatus: "Current branch: fix-login\nStatus:\n(clean)" } }),
    attachment({ type: "model", identity: { modelId: "claude-opus-5-5", marketingName: "Opus 5.5" } }),
    // Types no reader knows, an attachment with no body, and a malformed line: all skipped.
    attachment({ type: "a_future_attachment", payload: { anything: true } }),
    { ...base, type: "attachment" },
    { ...base, type: "a-future-record", data: 1 },
    { ...base, type: "user", message: { role: "user", content: "<command-name>/tdd</command-name>\n<command-args>login</command-args>" } },
    { ...base, type: "user", permissionMode: "default", message: { role: "user", content: "<command-name>/clear</command-name>" } },
    {
      ...base,
      type: "assistant",
      effort: "high",
      attributionSkill: "brief",
      message: {
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: "code-review" } }],
      },
    },
    { ...base, type: "system", subtype: "stop_hook_summary", hookCount: 1, hookInfos: [{ command: "notify.sh", durationMs: 40 }], hookErrors: [] },
    { ...base, type: "system", subtype: "stop_hook_summary", hookCount: 1, hookInfos: [{ command: "notify.sh", durationMs: 60 }], hookErrors: [] },
    attachment({ type: "hook_cancelled", hookName: "Stop", hookEvent: "Stop", command: "notify.sh", durationMs: 600_000, timedOut: true }),
    // A compaction reloads instruction files: the same text for the same reason says nothing new.
    attachment({ type: "instructions", reason: "compaction", files: [{ path: "/work/app/CLAUDE.md", type: "Project", content: "# App\nRun the focused test only." }] }),
    attachment({ type: "instructions", reason: "compaction", files: [{ path: "/work/app/CLAUDE.md", type: "Project", content: "# App\nRun the focused test only." }] }),
  ];
}

/** A session that recorded nothing but a conversation. */
function bareTranscript(): unknown[] {
  return [
    { ...base, sessionId: BARE_ID, entrypoint: "sdk-ts", type: "user", message: { role: "user", content: "hello" } },
    { ...base, sessionId: BARE_ID, entrypoint: "sdk-ts", type: "assistant", message: { role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "hi" }] } },
  ];
}

function write(dir: string, id: string, records: unknown[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n{not json\n");
  return path;
}

test("every launch-context section is read from a transcript that carries it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-history-launch-full-"));
  const context = await readClaudeLaunchContext(write(dir, ID, fullTranscript()));

  assert.deepEqual(context.instructionFiles, [
    { path: "/home/op/.claude/CLAUDE.md", scope: "User", reason: "session_start", content: "# Global\nPrefer bun." },
    { path: "/work/app/CLAUDE.md", scope: "Project", reason: "session_start", content: "# App\nRun the focused test only." },
    { path: "/home/op/.claude/projects/-work-app/memory/MEMORY.md", scope: "AutoMem", reason: null, content: "- [Pinned](pinned.md)" },
    { path: "/work/app/CLAUDE.md", scope: "Project", reason: "compaction", content: "# App\nRun the focused test only." },
  ]);
  assert.deepEqual(context.systemPrompt, {
    standingInstructions: "## Standing instructions for this repository\n\nNever run the full suite.",
    appended: ["Use the ask channel for questions."],
  });
  assert.deepEqual(context.skills.available, ["tdd", "code-review", "brief"]);
  assert.deepEqual([...context.skills.used].sort(), ["brief", "code-review", "tdd"], "/clear is a command, not a listed skill");
  assert.deepEqual(context.mcp, {
    servers: [
      { name: "docs", status: "connected", instructions: "Search the docs first." },
      { name: "claude.ai Slack", status: "needs_auth", instructions: null },
      { name: "claude.ai Gmail", status: "pending", instructions: null },
      { name: "broken-server", status: "failed", instructions: null },
    ],
    tools: ["mcp__docs__search", "mcp__docs__read", "mcp__claude_ai_Slack__authenticate"],
  });
  assert.deepEqual(context.environment, {
    cwd: "/work/app",
    branch: "fix-login",
    gitStatus: "Current branch: fix-login\nStatus:\n(clean)",
    isWorktree: true,
    isGitRepo: true,
    additionalDirectories: ["/work/shared"],
    platform: "linux",
    shell: "zsh",
    osVersion: "Linux 7.2",
    model: "claude-opus-5-5",
    effort: "high",
    permissionMode: "auto",
  });
  assert.ok(!JSON.stringify(context).includes("op@example.com"), "the account email beside git status is not launch context");
  assert.deepEqual(context.hooks, [{ event: "Stop", command: "notify.sh", runs: 3, totalMs: 600_100, maxMs: 600_000, failures: 1 }]);
  rmSync(dir, { recursive: true, force: true });
});

test("a transcript missing every launch record says not recorded, never none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-history-launch-bare-"));
  const context = await readClaudeLaunchContext(write(dir, BARE_ID, bareTranscript()));
  assert.equal(context.instructionFiles, null);
  assert.equal(context.systemPrompt, null);
  assert.equal(context.skills.available, null);
  assert.deepEqual(context.skills.used, []);
  assert.equal(context.mcp, null);
  assert.equal(context.hooks, null);
  assert.equal(context.environment.cwd, "/work/app", "the envelope's cwd stands in for the environment record");
  assert.equal(context.environment.branch, "fix-login");
  assert.equal(context.environment.model, "claude-sonnet-5-5", "the first answer's model stands in for the model record");
  for (const field of ["gitStatus", "isWorktree", "isGitRepo", "additionalDirectories", "platform", "shell", "osVersion", "effort", "permissionMode"] as const) {
    assert.equal(context.environment[field], null, field);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("a recorded system prompt with no standing block is recorded, with none appended", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-history-launch-prompt-"));
  const context = await readClaudeLaunchContext(write(dir, ID, [
    attachment({ type: "prompt_snapshot", systemPrompt: [] }),
    // A second snapshot does not replace the first.
    attachment({ type: "prompt_snapshot", systemPrompt: ["later"] }),
  ]));
  assert.deepEqual(context.systemPrompt, { standingInstructions: null, appended: [] });

  const own = await readClaudeLaunchContext(write(dir, BARE_ID, [
    attachment({ type: "prompt_snapshot", systemPrompt: ["## Standing instructions for these repositories\n\n### /a, /b\n\nShared rule."] }),
  ]));
  assert.deepEqual(own.systemPrompt, { standingInstructions: "## Standing instructions for these repositories\n\n### /a, /b\n\nShared rule.", appended: [] });
  rmSync(dir, { recursive: true, force: true });
});

async function fixture() {
  openDb().exec("DELETE FROM history_sessions");
  const projects = mkdtempSync(join(tmpdir(), "mission-history-launch-projects-"));
  const history = new HistoryService({ readers: [{ agent: "claude", spec: createClaudeHistory(projects) }], resolveRepository: () => null });
  const app = buildApp({ registry: new Registry(), reviews: {} as ReviewManager, tasks: {} as TaskManager, queues: {} as QueueManager, history });
  const get = (path: string) => app.request(path, { headers: LOOPBACK });
  return { projects, history, get, done: () => rmSync(projects, { recursive: true, force: true }) };
}

test("the launch-context route serves the sections, the snapshot rather than today's file, and 404 or 410 otherwise", async () => {
  const f = await fixture();
  const dir = join(f.projects, "-work-app");
  // The session loaded one CLAUDE.md, and the file has been rewritten since.
  const checkout = mkdtempSync(join(tmpdir(), "mission-history-launch-checkout-"));
  const claudeMd = join(checkout, "CLAUDE.md");
  writeFileSync(claudeMd, "# App\nRewritten since.");
  const path = write(dir, ID, [
    ...fullTranscript(),
    attachment({ type: "instructions", reason: "session_start", files: [{ path: claudeMd, type: "Project", content: "# App\nAs loaded." }] }),
  ]);
  write(dir, BARE_ID, bareTranscript());
  await f.history.reconciler.trigger();

  const res = await f.get(`/api/history/sessions/claude/${ID}/launch-context`);
  assert.equal(res.status, 200);
  const context = await res.json() as HistoryLaunchContext;
  assert.equal(context.instructionFiles?.find((file) => file.path === claudeMd)?.content, "# App\nAs loaded.");
  assert.equal(context.environment.permissionMode, "auto");
  assert.equal(context.mcp?.servers.length, 4);

  const bare = await (await f.get(`/api/history/sessions/claude/${BARE_ID}/launch-context`)).json() as HistoryLaunchContext;
  assert.equal(bare.instructionFiles, null);
  assert.equal(bare.hooks, null);

  for (const bad of [
    "/api/history/sessions/claude/not-a-uuid/launch-context",
    `/api/history/sessions/claude/..%2F${ID}/launch-context`,
    "/api/history/sessions/claude/00000000-0000-4000-8000-00000000ffff/launch-context",
    `/api/history/sessions/codex/${ID}/launch-context`,
  ]) {
    assert.equal((await f.get(bad)).status, 404, bad);
  }

  // Removed but not yet walked, and then walked: a 410 either way, never an empty context.
  rmSync(path);
  assert.equal((await f.get(`/api/history/sessions/claude/${ID}/launch-context`)).status, 410);
  await f.history.reconciler.trigger();
  assert.equal((await f.get(`/api/history/sessions/claude/${ID}/launch-context`)).status, 410);
  rmSync(checkout, { recursive: true, force: true });
  f.done();
});
