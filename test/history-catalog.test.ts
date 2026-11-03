import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

/**
 * Session History's catalog: the Claude reader's summaries and classification, the
 * reconciler's batched backfill and gone marking, and the list route's paging.
 *
 * Every transcript here is a fixture written into a temp projects directory; nothing reads the
 * operator's `~/.claude`.
 */

const home = mkdtempSync(join(tmpdir(), "mission-history-"));
process.env.MISSION_HOME = home;

const { classifyClaudeSession, createClaudeHistory } = await import("../src/server/harness/claude/history.ts");
const { claudeProjectDir } = await import("../src/server/harness/claude/project-dir.ts");
const { HARNESSES } = await import("../src/server/harness/index.ts");
const { HistoryStore } = await import("../src/server/history/store.ts");
const { HistoryReconciler } = await import("../src/server/history/reconciler.ts");
const { HistoryService } = await import("../src/server/history/service.ts");
const { resolveHistoryRepository } = await import("../src/server/history/repository.ts");
const { openDb, upgradeDatabaseToCurrentSchema } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
import type { HistoryFile } from "../src/server/harness/types.ts";
import type { HistoryPage } from "../src/shared/history.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";

const LOOPBACK = { host: "127.0.0.1:7317" };
let ordinal = 0;

/** A fresh UUID-shaped id, readable in a failure message. */
function sessionId(): string {
  ordinal += 1;
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

function envelope(id: string, cwd: string, entrypoint: string, at: string): Record<string, unknown> {
  return { sessionId: id, cwd, entrypoint, version: "2.1.296", gitBranch: "HEAD", timestamp: at, isSidechain: false };
}

function snapshot(tools: string[], cliPrefix: string): Record<string, unknown> {
  return {
    type: "attachment",
    attachment: { type: "prompt_snapshot", cliPrefix, tools: tools.map((name) => ({ name, description: "", schema: {} })), systemPrompt: [] },
  };
}

const CODE_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
const AGENT_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/** The records of one session of a given shape. */
function records(id: string, shape: {
  cwd: string;
  entrypoint?: string;
  snapshot?: Record<string, unknown> | null;
  prompt?: string;
  at?: string;
}): unknown[] {
  const at = shape.at ?? "2026-10-20T10:00:00.000Z";
  const base = envelope(id, shape.cwd, shape.entrypoint ?? "sdk-ts", at);
  return [
    ...(shape.snapshot ? [{ ...base, ...shape.snapshot }] : []),
    { ...base, type: "user", message: { role: "user", content: shape.prompt ?? `prompt for ${id}` } },
    { ...base, type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }] } },
  ];
}

function writeTranscript(projects: string, folder: string, id: string, lines: unknown[]): string {
  const dir = join(projects, folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
  return path;
}

function freshProjects(): string {
  return mkdtempSync(join(tmpdir(), "mission-history-projects-"));
}

async function enumerateOne(projects: string, id: string): Promise<HistoryFile> {
  const files = await createClaudeHistory(projects).enumerate(projects);
  const file = files.find((entry) => entry.agentSessionId === id);
  assert.ok(file, `the walk finds ${id}`);
  return file;
}

function clearCatalog(): void {
  openDb().exec("DELETE FROM history_sessions");
}

test("Codex and Pi declare a null history slot; Claude has the reader", () => {
  assert.equal(HARNESSES.codex.history, null);
  assert.equal(HARNESSES.pi.history, null);
  assert.ok(HARNESSES.claude.history);
});

test("classification follows the six ordered rules", () => {
  const cases: [string, Parameters<typeof classifyClaudeSession>[0], string][] = [
    ["cli is interactive whatever the snapshot", { entrypoint: "cli", snapshot: { tools: [], cliPrefix: AGENT_PREFIX } }, "interactive"],
    ["no prompt_snapshot is unclassified, never an empty tool set", { entrypoint: "sdk-ts", snapshot: null }, "unclassified"],
    ["no tools is one_shot", { entrypoint: "sdk-ts", snapshot: { tools: [], cliPrefix: AGENT_PREFIX } }, "one_shot"],
    ["StructuredOutput only is one_shot, not reviewer", { entrypoint: "sdk-ts", snapshot: { tools: ["StructuredOutput"], cliPrefix: AGENT_PREFIX } }, "one_shot"],
    ["Read plus StructuredOutput is reviewer", { entrypoint: "sdk-ts", snapshot: { tools: ["Read", "StructuredOutput"], cliPrefix: AGENT_PREFIX } }, "reviewer"],
    ["Glob and Grep only is reviewer", { entrypoint: "sdk-ts", snapshot: { tools: ["Glob", "Grep"], cliPrefix: CODE_PREFIX } }, "reviewer"],
    ["the Claude Code preset with write tools is sdk", { entrypoint: "sdk-ts", snapshot: { tools: ["Read", "Edit", "Bash"], cliPrefix: CODE_PREFIX } }, "sdk"],
    ["write tools under another preset is unclassified", { entrypoint: "sdk-ts", snapshot: { tools: ["Read", "Edit"], cliPrefix: AGENT_PREFIX } }, "unclassified"],
  ];
  for (const [label, input, expected] of cases) assert.equal(classifyClaudeSession(input), expected, label);
});

test("the Claude reader summarizes each kind from fixture transcripts", async () => {
  const projects = freshProjects();
  const cwd = "/work/repo_with.dots";
  // A folder name that is NOT the encoding of the cwd: the reader must take cwd from records.
  const folder = "-not-the-real-cwd";
  const kinds: [string, Record<string, unknown> | null, string, string][] = [
    ["interactive", null, "cli", "interactive"],
    ["sdk", snapshot(["Read", "Edit", "Bash"], CODE_PREFIX), "sdk-ts", "sdk"],
    ["one_shot", snapshot([], AGENT_PREFIX), "sdk-ts", "one_shot"],
    ["structured", snapshot(["StructuredOutput"], AGENT_PREFIX), "sdk-ts", "one_shot"],
    ["reviewer", snapshot(["Read", "Grep", "StructuredOutput"], AGENT_PREFIX), "sdk-ts", "reviewer"],
    ["no snapshot", null, "sdk-ts", "unclassified"],
  ];
  const reader = createClaudeHistory(projects);
  for (const [label, snap, entrypoint, expected] of kinds) {
    const id = sessionId();
    writeTranscript(projects, folder, id, records(id, { cwd, entrypoint, snapshot: snap }));
    const parse = await reader.summarize(await enumerateOne(projects, id), null);
    assert.equal(parse?.summary.kind, expected, label);
    assert.equal(parse?.summary.cwd, cwd, `${label}: cwd read from records`);
  }
  rmSync(projects, { recursive: true, force: true });
});

test("the reader tolerates unknown records, reads titles, cost and the first cwd", async () => {
  const projects = freshProjects();
  const id = sessionId();
  const base = envelope(id, "/work/first", "cli", "2026-10-20T10:00:00.000Z");
  writeTranscript(projects, "-work-first", id, [
    { type: "mystery-record-from-a-later-version", sessionId: id, payload: { nested: true } },
    { ...base, type: "attachment", attachment: { type: "brand-new-attachment", whatever: 1 } },
    "{ this line is not json",
    { ...base, type: "user", isMeta: true, message: { role: "user", content: "Continue from where you left off." } },
    { ...base, type: "user", message: { role: "user", content: "Fix the login bug" } },
    { ...base, cwd: "/work/second", gitBranch: "fix-login", timestamp: "2026-10-20T10:05:00.000Z", type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "on it" }] } },
    { type: "ai-title", aiTitle: "Login bug fix", sessionId: id },
    { type: "custom-title", customTitle: "My login fix", sessionId: id },
    { type: "pr-link", sessionId: id, prUrl: "https://github.com/o/r/pull/1", timestamp: "2026-10-20T10:06:00.000Z" },
    { type: "cost-state", sessionId: id, totalCostUSD: 1.5, totalDuration: 360000, startTime: Date.parse("2026-10-20T09:59:00.000Z"), totalLinesAdded: 10, totalLinesRemoved: 2, modelUsage: { "claude-opus-5-5": { inputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 10, outputTokens: 40 } } },
  ]);
  const parse = await createClaudeHistory(projects).summarize(await enumerateOne(projects, id), null);
  assert.ok(parse);
  const s = parse.summary;
  assert.equal(s.kind, "interactive");
  assert.equal(s.cwd, "/work/first", "a cwd change mid-session keeps the first directory");
  assert.equal(s.branch, "fix-login");
  assert.equal(s.firstPrompt, "Fix the login bug", "meta records are not the operator's prompt");
  assert.equal(s.aiTitle, "Login bug fix");
  assert.equal(s.customTitle, "My login fix");
  assert.equal(s.model, "claude-opus-5-5");
  assert.equal(s.costUsd, 1.5);
  assert.equal(s.durationMs, 360000);
  assert.equal(s.startedAt, Date.parse("2026-10-20T09:59:00.000Z"));
  assert.equal(s.lastActivityAt, Date.parse("2026-10-20T10:06:00.000Z"));
  assert.equal(s.inputTokens, 115);
  assert.equal(s.outputTokens, 40);
  assert.deepEqual(s.prUrls, ["https://github.com/o/r/pull/1"]);
  rmSync(projects, { recursive: true, force: true });
});

test("summarize folds in only appended bytes, and restarts on a shrunk file", async () => {
  const projects = freshProjects();
  const id = sessionId();
  const reader = createClaudeHistory(projects);
  const path = writeTranscript(projects, "-w", id, records(id, { cwd: "/w", entrypoint: "cli" }));
  // A half-written last line is not counted as parsed.
  appendFileSync(path, '{"type":"ai-title","aiTi');
  const first = await reader.summarize(await enumerateOne(projects, id), null);
  assert.ok(first);
  assert.equal(first.summary.aiTitle, null);

  appendFileSync(path, 'tle":"Appended title","sessionId":"x"}\n');
  const file = await enumerateOne(projects, id);
  const second = await reader.summarize(file, {
    summary: first.summary,
    parsedBytes: first.parsedBytes,
    ino: file.fingerprint.ino,
    state: first.state,
  });
  assert.ok(second);
  assert.equal(second.summary.aiTitle, "Appended title");
  assert.equal(second.summary.firstPrompt, first.summary.firstPrompt, "state carried across the append");
  assert.equal(second.parsedBytes, file.fingerprint.size);

  // Shrunk below the last offset: a cleared transcript is re-read from the top, not resumed.
  truncateSync(path, 0);
  writeFileSync(path, JSON.stringify({ ...envelope(id, "/elsewhere", "sdk-ts", "2026-10-21T00:00:00.000Z"), type: "user", message: { role: "user", content: "fresh" } }) + "\n");
  const shrunk = await enumerateOne(projects, id);
  const third = await reader.summarize(shrunk, { summary: second.summary, parsedBytes: second.parsedBytes, ino: shrunk.fingerprint.ino, state: second.state });
  assert.equal(third?.summary.cwd, "/elsewhere");
  assert.equal(third?.summary.aiTitle, null);
  rmSync(projects, { recursive: true, force: true });
});

test("the walk yields top-level sessions only: subagent transcripts are counted, not listed", async () => {
  const projects = freshProjects();
  const id = sessionId();
  writeTranscript(projects, "-w", id, records(id, { cwd: "/w", entrypoint: "cli" }));
  mkdirSync(join(projects, "-w", id, "subagents"), { recursive: true });
  writeFileSync(join(projects, "-w", id, "subagents", "agent-abc123.jsonl"), "{}\n");
  writeFileSync(join(projects, "-w", "notes.txt"), "not a session");
  const reader = createClaudeHistory(projects);
  const files = await reader.enumerate(projects);
  assert.deepEqual(files.map((file) => file.agentSessionId), [id]);
  assert.equal((await reader.summarize(files[0]!, null))?.summary.subagentCount, 1);
  assert.deepEqual(await reader.enumerate(join(projects, "absent")), [], "an absent root is an empty one");
  rmSync(projects, { recursive: true, force: true });
});

test("the reconciler backfills newest first in small batches, with progress", async () => {
  clearCatalog();
  const projects = freshProjects();
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = sessionId();
    ids.push(id);
    const path = writeTranscript(projects, "-w", id, records(id, { cwd: "/w", entrypoint: "cli" }));
    // Older index, older mtime: ids[4] is the newest file.
    const at = new Date(Date.UTC(2026, 9, 1 + i));
    utimesSync(path, at, at);
  }
  const store = new HistoryStore();
  const batches: { ids: string[]; progress: ReturnType<InstanceType<typeof HistoryReconciler>["progress"]> }[] = [];
  const reconciler = new HistoryReconciler({
    store,
    readers: [{ agent: "claude", spec: createClaudeHistory(projects) }],
    batchSize: 2,
    resolveRepository: () => null,
  });
  const write = store.upsertBatch.bind(store);
  store.upsertBatch = (rows, at) => {
    batches.push({ ids: rows.map((row) => row.agentSessionId), progress: reconciler.progress() });
    write(rows, at);
    assert.equal(openDb().isTransaction, false, "each batch's transaction is closed before the next");
  };
  const pass = await reconciler.trigger();
  assert.equal(pass.indexed, 5);
  assert.deepEqual(batches.map((batch) => batch.ids), [[ids[4], ids[3]], [ids[2], ids[1]], [ids[0]]]);
  assert.deepEqual(batches.map((batch) => batch.progress), [
    { indexing: true, indexed: 0, total: 5 },
    { indexing: true, indexed: 2, total: 5 },
    { indexing: true, indexed: 4, total: 5 },
  ]);
  assert.deepEqual(reconciler.progress(), { indexing: false, indexed: 5, total: 5 });

  // An unchanged second pass opens nothing and writes nothing.
  batches.length = 0;
  const again = await reconciler.trigger();
  assert.equal(again.indexed, 0);
  assert.deepEqual(batches, []);
  rmSync(projects, { recursive: true, force: true });
});

test("a removed transcript keeps its row, marked gone, only after a complete walk", async () => {
  clearCatalog();
  const projects = freshProjects();
  const kept = sessionId();
  const removed = sessionId();
  writeTranscript(projects, "-w", kept, records(kept, { cwd: "/w", entrypoint: "cli" }));
  const removedPath = writeTranscript(projects, "-w", removed, records(removed, { cwd: "/w", entrypoint: "cli", prompt: "remember me" }));
  const store = new HistoryStore();
  const spec = createClaudeHistory(projects);
  let failWalk = false;
  const reconciler = new HistoryReconciler({
    store,
    readers: [{
      agent: "claude",
      spec: { ...spec, enumerate: async (root) => { if (failWalk) throw new Error("EIO"); return spec.enumerate(root); } },
    }],
    resolveRepository: () => null,
    now: () => 1_000,
  });
  await reconciler.trigger();
  rmSync(removedPath);

  failWalk = true;
  const incomplete = await reconciler.trigger();
  assert.equal(incomplete.complete, false);
  assert.equal(store.index("claude").get(removed)?.transcriptState, "present", "a walk that failed decides nothing");

  failWalk = false;
  const complete = await reconciler.trigger();
  assert.equal(complete.gone, 1);
  const page = store.page({ kinds: ["interactive"], cursor: null, limit: 10, progress: reconciler.progress() });
  const gone = page.sessions.find((row) => row.agentSessionId === removed);
  assert.equal(gone?.transcriptState, "gone");
  assert.equal(gone?.goneAt, 1_000);
  assert.equal(gone?.firstPrompt, "remember me", "the row and what it says survive");
  assert.equal(page.sessions.find((row) => row.agentSessionId === kept)?.transcriptState, "present");

  // The file comes back: the row is present again.
  writeTranscript(projects, "-w", removed, records(removed, { cwd: "/w", entrypoint: "cli" }));
  await reconciler.trigger();
  assert.equal(store.index("claude").get(removed)?.transcriptState, "present");
  rmSync(projects, { recursive: true, force: true });
});

test("two files with one session id: the canonical file does not depend on scan order", async () => {
  clearCatalog();
  const projects = freshProjects();
  const id = sessionId();
  const cwd = "/work/original";
  const native = writeTranscript(projects, "aaa-copy-sorts-first", id, records(id, { cwd, entrypoint: "cli" }));
  const original = writeTranscript(projects, claudeProjectDir(cwd, projects).slice(projects.length + 1), id, records(id, { cwd, entrypoint: "cli" }));
  assert.notEqual(native, original);
  const reader = createClaudeHistory(projects);
  for (const order of [false, true]) {
    clearCatalog();
    const store = new HistoryStore();
    const reconciler = new HistoryReconciler({
      store,
      readers: [{ agent: "claude", spec: { ...reader, enumerate: async (root) => {
        const files = await reader.enumerate(root);
        return order ? files.reverse() : files;
      } } }],
      resolveRepository: () => null,
    });
    await reconciler.trigger();
    assert.equal(store.index("claude").get(id)?.transcriptPath, original);
  }
  rmSync(projects, { recursive: true, force: true });
});

test("repository resolution: pool slots, task worktrees, git checkouts and unknown paths", () => {
  const sources = {
    pools: [{ poolPath: "/state/worktree-pools/app-1234", mainCheckoutRoot: "/code/app" }],
    taskRepoRoot: (taskId: string) => (taskId === "task-1" ? "/code/tasked" : null),
    worktreesDir: "/state/worktrees",
    gitRoot: (cwd: string) => (cwd.startsWith("/code/plain") ? "/code/plain" : null),
  };
  assert.equal(resolveHistoryRepository("/state/worktree-pools/app-1234/3/app", sources), "/code/app", "a deleted slot still maps through its pool");
  assert.equal(resolveHistoryRepository("/state/worktree-pools/app-12345/1/app", sources), null, "a sibling pool prefix is not inside");
  assert.equal(resolveHistoryRepository("/state/worktrees/task-1/sub", sources), "/code/tasked");
  assert.equal(resolveHistoryRepository("/code/plain/src", sources), "/code/plain");
  assert.equal(resolveHistoryRepository("/nowhere", sources), null);
  assert.equal(resolveHistoryRepository(null, sources), null);
});

test("GET /api/history/sessions pages conversations newest first and refuses a bad cursor", async () => {
  clearCatalog();
  const projects = freshProjects();
  const conversations: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = sessionId();
    conversations.push(id);
    writeTranscript(projects, "-w", id, records(id, { cwd: "/w", entrypoint: "cli", at: `2026-10-0${i + 1}T10:00:00.000Z` }));
  }
  const background = sessionId();
  writeTranscript(projects, "-w", background, records(background, { cwd: "/w", snapshot: snapshot([], AGENT_PREFIX), at: "2026-10-09T10:00:00.000Z" }));
  const unclassified = sessionId();
  writeTranscript(projects, "-w", unclassified, records(unclassified, { cwd: "/w", at: "2026-10-08T10:00:00.000Z" }));
  const history = new HistoryService({ readers: [{ agent: "claude", spec: createClaudeHistory(projects) }], resolveRepository: () => null });
  await history.reconciler.trigger();
  const app = buildApp({
    registry: new Registry(),
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
    history,
  });

  const first = await app.request("/api/history/sessions?limit=2", { headers: LOOPBACK });
  assert.equal(first.status, 200);
  const page1 = await first.json() as HistoryPage;
  assert.deepEqual(page1.sessions.map((row) => row.agentSessionId), [unclassified, conversations[2]], "background runs are hidden; unclassified is shown");
  assert.deepEqual(page1.progress, { indexing: false, indexed: 5, total: 5 });
  assert.ok(page1.nextCursor);
  const second = await app.request(`/api/history/sessions?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`, { headers: LOOPBACK });
  const page2 = await second.json() as HistoryPage;
  assert.deepEqual(page2.sessions.map((row) => row.agentSessionId), [conversations[1], conversations[0]]);
  assert.equal(page2.nextCursor, null);

  assert.equal((await app.request("/api/history/sessions?cursor=../../etc", { headers: LOOPBACK })).status, 400);
  assert.equal((await app.request("/api/history/sessions?limit=0", { headers: LOOPBACK })).status, 400);
  const bare = buildApp({ registry: new Registry(), reviews: {} as ReviewManager, tasks: {} as TaskManager, queues: {} as QueueManager });
  assert.equal((await bare.request("/api/history/sessions", { headers: LOOPBACK })).status, 503);
  rmSync(projects, { recursive: true, force: true });
});

test("a database stamped 11 gains the history catalog through migrate()", () => {
  const stamped = new DatabaseSync(join(home, "stamped-11.db"));
  try {
    stamped.exec("PRAGMA user_version = 11;");
    upgradeDatabaseToCurrentSchema(stamped);
    const columns = (stamped.prepare("PRAGMA table_info(history_sessions)").all() as { name: string }[]).map((row) => row.name);
    assert.ok(columns.includes("transcript_state") && columns.includes("parsed_bytes") && columns.includes("kind"));
    assert.equal((stamped.prepare("SELECT COUNT(*) AS n FROM history_sessions").get() as { n: number }).n, 0);
  } finally {
    stamped.close();
  }
});

test("a changed transcript is re-indexed, resuming from where its last parse stopped", async () => {
  clearCatalog();
  const projects = freshProjects();
  const id = sessionId();
  const path = writeTranscript(projects, "-w", id, records(id, { cwd: "/w", entrypoint: "cli", prompt: "the first prompt" }));
  const spec = createClaudeHistory(projects);
  const previous: (import("../src/server/harness/types.ts").HistoryParsePoint | null)[] = [];
  const store = new HistoryStore();
  const reconciler = new HistoryReconciler({
    store,
    readers: [{ agent: "claude", spec: { ...spec, summarize: (file, point) => { previous.push(point); return spec.summarize(file, point); } } }],
    resolveRepository: () => null,
  });
  await reconciler.trigger();
  assert.equal(previous.length, 1);
  assert.equal(previous[0], null, "a new file is parsed from the top");
  const firstParsed = store.parsePoint("claude", id)?.parsedBytes;
  assert.ok(firstParsed && firstParsed > 0);

  // Claude appends to a live session: its size and mtime move, its inode does not.
  appendFileSync(path, `${JSON.stringify({ type: "ai-title", aiTitle: "Appended later", sessionId: id })}\n`);
  appendFileSync(path, `${JSON.stringify({ type: "cost-state", sessionId: id, totalCostUSD: 3.25 })}\n`);
  const later = new Date(Date.now() + 5_000);
  utimesSync(path, later, later);
  const pass = await reconciler.trigger();
  assert.equal(pass.indexed, 1, "the changed file is re-summarized");
  assert.equal(previous.length, 2);
  assert.equal(previous[1]?.parsedBytes, firstParsed, "it resumes from the stored parse point");

  const row = store.page({ kinds: ["interactive"], cursor: null, limit: 10, progress: reconciler.progress() }).sessions
    .find((entry) => entry.agentSessionId === id);
  assert.equal(row?.aiTitle, "Appended later");
  assert.equal(row?.costUsd, 3.25);
  assert.equal(row?.firstPrompt, "the first prompt", "what the earlier bytes said is kept");

  // Once re-indexed, the unchanged file is skipped again.
  assert.equal((await reconciler.trigger()).indexed, 0);
  rmSync(projects, { recursive: true, force: true });
});

test("paging across rows with one last_activity_at returns each row exactly once", async () => {
  clearCatalog();
  const projects = freshProjects();
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = sessionId();
    ids.push(id);
    writeTranscript(projects, "-w", id, records(id, { cwd: "/w", entrypoint: "cli", at: "2026-10-05T10:00:00.000Z" }));
  }
  const history = new HistoryService({ readers: [{ agent: "claude", spec: createClaudeHistory(projects) }], resolveRepository: () => null });
  await history.reconciler.trigger();
  const app = buildApp({ registry: new Registry(), reviews: {} as ReviewManager, tasks: {} as TaskManager, queues: {} as QueueManager, history });

  for (const limit of [1, 2]) {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query = `limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await app.request(`/api/history/sessions?${query}`, { headers: LOOPBACK });
      assert.equal(res.status, 200);
      const page = await res.json() as HistoryPage;
      assert.ok(page.sessions.length <= limit);
      seen.push(...page.sessions.map((row) => row.agentSessionId));
      cursor = page.nextCursor;
      // A cursor that does not advance would page for ever; fail instead of hanging.
      assert.ok(seen.length <= ids.length, `limit ${limit}: paging repeated a row`);
    } while (cursor);
    assert.deepEqual(seen, [...ids].sort().reverse(), `limit ${limit}: every tied row once, in descending id order`);
  }

  assert.equal((await app.request("/api/history/sessions?limit=200", { headers: LOOPBACK })).status, 200);
  assert.equal((await app.request("/api/history/sessions?limit=201", { headers: LOOPBACK })).status, 400);
  rmSync(projects, { recursive: true, force: true });
});

test("a prompt_snapshot with no tools array counts as no snapshot, never as an empty tool set", async () => {
  const projects = freshProjects();
  const reader = createClaudeHistory(projects);
  const toolless = { type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: [], contextRendering: "announced" } };

  const alone = sessionId();
  writeTranscript(projects, "-w", alone, records(alone, { cwd: "/w", snapshot: toolless }));
  assert.equal((await reader.summarize(await enumerateOne(projects, alone), null))?.summary.kind, "unclassified",
    "an empty tool set would have read as one_shot");

  // Claude records a second, tool-less snapshot beside the real one; the one with tools decides.
  const paired = sessionId();
  const base = envelope(paired, "/w", "sdk-ts", "2026-10-20T10:00:00.000Z");
  writeTranscript(projects, "-w", paired, [
    { ...base, ...toolless },
    { ...base, ...snapshot(["Read", "StructuredOutput"], AGENT_PREFIX) },
    ...records(paired, { cwd: "/w" }),
  ]);
  assert.equal((await reader.summarize(await enumerateOne(projects, paired), null))?.summary.kind, "reviewer");
  rmSync(projects, { recursive: true, force: true });
});

/** A reader whose summarize calls are counted, by file name. */
function countingReader(projects: string): { spec: import("../src/server/harness/types.ts").HistorySpec; calls: string[] } {
  const base = createClaudeHistory(projects);
  const calls: string[] = [];
  return { calls, spec: { ...base, summarize: (file, point) => { calls.push(file.path); return base.summarize(file, point); } } };
}

test("a transcript that summarizes to nothing is not re-read until it changes", async () => {
  clearCatalog();
  const projects = freshProjects();
  const emptyId = sessionId();
  const summaryOnly = sessionId();
  const emptyPath = writeTranscript(projects, "-w", emptyId, []);
  writeFileSync(emptyPath, "");
  const summaryPath = writeTranscript(projects, "-w", summaryOnly, [{ type: "summary", summary: "no timestamp, cwd or entrypoint", leafUuid: "x" }]);
  const { spec, calls } = countingReader(projects);
  const reconciler = new HistoryReconciler({ store: new HistoryStore(), readers: [{ agent: "claude", spec }], resolveRepository: () => null });

  const first = await reconciler.trigger();
  assert.equal(first.indexed, 0);
  assert.equal(calls.length, 2, "each is read once");
  assert.deepEqual(reconciler.progress(), { indexing: false, indexed: 2, total: 2 });

  calls.length = 0;
  const again = await reconciler.trigger();
  assert.equal(again.indexed, 0);
  assert.deepEqual(calls, [], "an unchanged file that yielded nothing is not read again");
  assert.deepEqual(reconciler.progress(), { indexing: false, indexed: 2, total: 2 });

  // It changes: now it carries a real record, so it is read once more and gains a row.
  appendFileSync(summaryPath, `${JSON.stringify({ ...envelope(summaryOnly, "/w", "cli", "2026-10-20T10:00:00.000Z"), type: "user", message: { role: "user", content: "now it has a prompt" } })}\n`);
  const later = new Date(Date.now() + 5_000);
  utimesSync(summaryPath, later, later);
  const third = await reconciler.trigger();
  assert.deepEqual(calls, [summaryPath]);
  assert.equal(third.indexed, 1);
  rmSync(projects, { recursive: true, force: true });
});

test("an unchanged duplicate-id group is not re-parsed; a change in it re-runs the choice", async () => {
  clearCatalog();
  const projects = freshProjects();
  const id = sessionId();
  const cwd = "/work/dup";
  const copy = writeTranscript(projects, "aaa-copy", id, records(id, { cwd, entrypoint: "cli" }));
  const original = writeTranscript(projects, claudeProjectDir(cwd, projects).slice(projects.length + 1), id, records(id, { cwd, entrypoint: "cli" }));
  const { spec, calls } = countingReader(projects);
  const store = new HistoryStore();
  const reconciler = new HistoryReconciler({ store, readers: [{ agent: "claude", spec }], resolveRepository: () => null });

  await reconciler.trigger();
  assert.equal(calls.length, 2, "the first choice reads both candidates");
  assert.equal(store.index("claude").get(id)?.transcriptPath, original);

  calls.length = 0;
  assert.equal((await reconciler.trigger()).indexed, 0);
  assert.deepEqual(calls, [], "nothing in the group changed, so nothing is read");

  // The copy changes: the choice runs again, and still lands on the original.
  appendFileSync(copy, `${JSON.stringify({ type: "ai-title", aiTitle: "copy only", sessionId: id })}\n`);
  const later = new Date(Date.now() + 5_000);
  utimesSync(copy, later, later);
  await reconciler.trigger();
  assert.deepEqual([...calls].sort(), [copy, original].sort());
  assert.equal(store.index("claude").get(id)?.transcriptPath, original);
  rmSync(projects, { recursive: true, force: true });
});
