import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Session History's live updates: the Claude reader's incremental summarize, the reconciler's
 * one coalesced change signal per pass, and the `fs.watch` hint that brings a new session in
 * without waiting for the recurring scan.
 *
 * Every transcript here is a fixture written into a temp projects directory; nothing reads the
 * operator's `~/.claude`.
 */

const home = mkdtempSync(join(tmpdir(), "mission-history-live-"));
process.env.MISSION_HOME = home;

const { createClaudeHistory } = await import("../src/server/harness/claude/history.ts");
const { HistoryStore } = await import("../src/server/history/store.ts");
const { HistoryReconciler } = await import("../src/server/history/reconciler.ts");
const { openDb } = await import("../src/server/db.ts");
import type { HistoryFile, HistoryParse, HistoryParsePoint, HistorySpec } from "../src/server/harness/types.ts";

let ordinal = 0;

function sessionId(): string {
  ordinal += 1;
  return `00000000-0000-4000-9000-${String(ordinal).padStart(12, "0")}`;
}

function envelope(id: string, cwd: string, at: string): Record<string, unknown> {
  return { sessionId: id, cwd, entrypoint: "cli", version: "2.1.296", gitBranch: "HEAD", timestamp: at, isSidechain: false };
}

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function opening(id: string, cwd: string, prompt: string): string {
  const base = envelope(id, cwd, "2026-10-20T10:00:00.000Z");
  return line({ ...base, type: "user", message: { role: "user", content: prompt } })
    + line({ ...base, type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }] } });
}

function freshProjects(): string {
  return mkdtempSync(join(tmpdir(), "mission-history-live-projects-"));
}

function writeSession(projects: string, id: string, body: string, folder = "-w"): string {
  mkdirSync(join(projects, folder), { recursive: true });
  const path = join(projects, folder, `${id}.jsonl`);
  writeFileSync(path, body);
  return path;
}

async function fileFor(projects: string, id: string): Promise<HistoryFile> {
  const file = (await createClaudeHistory(projects).enumerate(projects)).find((entry) => entry.agentSessionId === id);
  assert.ok(file, `the walk finds ${id}`);
  return file;
}

/** The parse point a catalog row would hand back after indexing `file` as `parse`. */
function pointAfter(file: HistoryFile, parse: HistoryParse): HistoryParsePoint {
  return { summary: parse.summary, parsedBytes: parse.parsedBytes, ino: file.fingerprint.ino, size: file.fingerprint.size, state: parse.state };
}

/** Moves a file's mtime forward, as a later write by Claude Code would. */
function touch(path: string, secondsLater: number): void {
  const at = new Date(statSync(path).mtimeMs + secondsLater * 1000);
  utimesSync(path, at, at);
}

/** A reader that records every summarize call and the parse point it was handed. */
function counting(spec: HistorySpec): { spec: HistorySpec; calls: (HistoryParsePoint | null)[] } {
  const calls: (HistoryParsePoint | null)[] = [];
  return { calls, spec: { ...spec, summarize: (file, point) => { calls.push(point); return spec.summarize(file, point); } } };
}

async function until(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("an append is folded in from the stored offset and updates last activity, cost and title", async () => {
  const projects = freshProjects();
  const id = sessionId();
  const reader = createClaudeHistory(projects);
  const path = writeSession(projects, id, opening(id, "/w", "the first prompt"));
  const file = await fileFor(projects, id);
  const first = await reader.summarize(file, null);
  assert.ok(first);

  // Rewrite the already-parsed bytes in place, same length and inode. A reader that re-read
  // them would now see "the other prompt"; one that resumes from its offset never looks.
  writeFileSync(path, opening(id, "/w", "the other prompt"), { flag: "r+" });
  appendFileSync(path, line({ ...envelope(id, "/w", "2026-10-20T11:30:00.000Z"), type: "ai-title", aiTitle: "Named later" }));
  appendFileSync(path, line({ ...envelope(id, "/w", "2026-10-20T11:30:00.000Z"), type: "cost-state", totalCostUSD: 4.5 }));
  const grown = await fileFor(projects, id);
  assert.equal(grown.fingerprint.ino, file.fingerprint.ino);
  const second = await reader.summarize(grown, pointAfter(file, first));
  assert.ok(second);
  assert.equal(second.summary.firstPrompt, "the first prompt", "the earlier bytes were not read again");
  assert.equal(second.summary.aiTitle, "Named later");
  assert.equal(second.summary.costUsd, 4.5);
  assert.equal(second.summary.lastActivityAt, Date.parse("2026-10-20T11:30:00.000Z"));
  assert.equal(second.parsedBytes, grown.fingerprint.size);
  rmSync(projects, { recursive: true, force: true });
});

test("a session that changes directory mid-way keeps its first cwd across an incremental parse", async () => {
  const projects = freshProjects();
  const id = sessionId();
  const reader = createClaudeHistory(projects);
  const path = writeSession(projects, id, opening(id, "/repo", "start here"));
  const file = await fileFor(projects, id);
  const first = await reader.summarize(file, null);
  assert.ok(first);
  appendFileSync(path, line({ ...envelope(id, "/repo/packages/api", "2026-10-20T12:00:00.000Z"), type: "user", message: { role: "user", content: "now in a subfolder" } }));
  const second = await reader.summarize(await fileFor(projects, id), pointAfter(file, first));
  assert.equal(second?.summary.cwd, "/repo");
  assert.equal(second?.summary.lastActivityAt, Date.parse("2026-10-20T12:00:00.000Z"));
  rmSync(projects, { recursive: true, force: true });
});

test("a file smaller than it was restarts from the top, even when still past the parsed offset", async () => {
  const projects = freshProjects();
  const id = sessionId();
  const reader = createClaudeHistory(projects);
  // A long last line still being written: parsed up to just before it, sized well past it.
  const head = opening(id, "/before", "before the rewrite");
  const path = writeSession(projects, id, `${head}{"type":"ai-title","aiTitle":"${"x".repeat(400)}`);
  const file = await fileFor(projects, id);
  const first = await reader.summarize(file, null);
  assert.ok(first);
  assert.equal(first.parsedBytes, Buffer.byteLength(head));

  // Rewritten in place, same inode: shorter than before, longer than the parsed offset.
  writeFileSync(path, `${opening(id, "/after", "after the rewrite")}${line({ type: "ai-title", aiTitle: "pad" })}`);
  const rewritten = await fileFor(projects, id);
  assert.equal(rewritten.fingerprint.ino, file.fingerprint.ino);
  assert.ok(rewritten.fingerprint.size < file.fingerprint.size && rewritten.fingerprint.size > first.parsedBytes);
  const second = await reader.summarize(rewritten, pointAfter(file, first));
  assert.equal(second?.summary.cwd, "/after");
  assert.equal(second?.summary.firstPrompt, "after the rewrite");
  rmSync(projects, { recursive: true, force: true });
});

test("a new inode at the same path restarts from the top", async () => {
  const projects = freshProjects();
  const id = sessionId();
  const reader = createClaudeHistory(projects);
  const path = writeSession(projects, id, opening(id, "/old", "the old file"));
  const file = await fileFor(projects, id);
  const first = await reader.summarize(file, null);
  assert.ok(first);

  // A different, larger file renamed over the old one.
  const replacement = join(projects, "replacement.tmp");
  writeFileSync(replacement, opening(id, "/new", "the new file") + line({ ...envelope(id, "/new", "2026-10-21T00:00:00.000Z"), type: "ai-title", aiTitle: "Replaced" }));
  renameSync(replacement, path);
  const replaced = await fileFor(projects, id);
  assert.notEqual(replaced.fingerprint.ino, file.fingerprint.ino);
  assert.ok(replaced.fingerprint.size >= file.fingerprint.size);
  const second = await reader.summarize(replaced, pointAfter(file, first));
  assert.equal(second?.summary.cwd, "/new");
  assert.equal(second?.summary.firstPrompt, "the new file");
  assert.equal(second?.summary.aiTitle, "Replaced");
  rmSync(projects, { recursive: true, force: true });
});

test("each pass that changed rows signals once; a pass that changed nothing does not", async () => {
  openDb().exec("DELETE FROM history_sessions");
  const projects = freshProjects();
  const ids = [sessionId(), sessionId(), sessionId()];
  const paths = ids.map((id) => writeSession(projects, id, opening(id, "/w", `prompt ${id}`)));
  const reader = counting(createClaudeHistory(projects));
  let signals = 0;
  const store = new HistoryStore();
  const reconciler = new HistoryReconciler({
    store,
    readers: [{ agent: "claude", spec: reader.spec }],
    // One file per batch, so a per-batch signal would show up as three.
    batchSize: 1,
    resolveRepository: () => null,
    onChanged: () => { signals += 1; },
  });

  assert.equal((await reconciler.trigger()).indexed, 3);
  assert.equal(signals, 1, "three new rows in three batches are one signal");

  reader.calls.length = 0;
  assert.equal((await reconciler.trigger()).indexed, 0);
  assert.equal(signals, 1, "an unchanged pass is silent");
  assert.equal(reader.calls.length, 0, "and opens no transcript: unchanged files cost their lstat only");

  appendFileSync(paths[0]!, line({ ...envelope(ids[0]!, "/w", "2026-10-20T13:00:00.000Z"), type: "ai-title", aiTitle: "Grew" }));
  appendFileSync(paths[1]!, line({ ...envelope(ids[1]!, "/w", "2026-10-20T13:00:00.000Z"), type: "ai-title", aiTitle: "Grew too" }));
  touch(paths[0]!, 5);
  touch(paths[1]!, 5);
  assert.equal((await reconciler.trigger()).indexed, 2);
  assert.equal(signals, 2, "two grown transcripts are one signal");
  assert.ok(reader.calls.every((point) => point !== null && point.parsedBytes > 0), "both resumed from their stored offsets");

  rmSync(paths[2]!);
  assert.equal((await reconciler.trigger()).gone, 1);
  assert.equal(signals, 3, "a row marked gone is a change");
  assert.equal((await reconciler.trigger()).indexed, 0);
  assert.equal(signals, 3);
  rmSync(projects, { recursive: true, force: true });
});

test("concurrent triggers coalesce into one more pass, and each changing pass signals once", async () => {
  openDb().exec("DELETE FROM history_sessions");
  const projects = freshProjects();
  const id = sessionId();
  writeSession(projects, id, opening(id, "/w", "coalesced"));
  let signals = 0;
  const reconciler = new HistoryReconciler({
    store: new HistoryStore(),
    readers: [{ agent: "claude", spec: createClaudeHistory(projects) }],
    resolveRepository: () => null,
    onChanged: () => { signals += 1; },
  });
  await Promise.all([reconciler.trigger(), reconciler.trigger(), reconciler.trigger()]);
  assert.equal(reconciler.passCount, 2, "the first pass plus one coalesced follow-up");
  assert.equal(signals, 1, "the follow-up found nothing new and stayed silent");
  rmSync(projects, { recursive: true, force: true });
});

test("a watched root brings a new session in without waiting for the recurring scan", async () => {
  openDb().exec("DELETE FROM history_sessions");
  const projects = freshProjects();
  const store = new HistoryStore();
  let signals = 0;
  const reconciler = new HistoryReconciler({
    store,
    readers: [{ agent: "claude", spec: createClaudeHistory(projects) }],
    // No recurring scan at all: only the watcher can bring the new file in.
    intervalMs: null,
    watch: true,
    resolveRepository: () => null,
    onChanged: () => { signals += 1; },
  });
  try {
    reconciler.start();
    await until(() => reconciler.passCount === 1 && !reconciler.progress().indexing, 2_000, "the first pass");
    const id = sessionId();
    // A project folder created after the watch began, as Claude Code does for a new cwd.
    writeSession(projects, id, opening(id, "/brand/new", "written while watched"), "-brand-new");
    await until(() => store.index("claude").has(id), 8_000, "the watched session to be indexed");
    assert.equal(signals, 1);
  } finally {
    reconciler.stop();
  }
  rmSync(projects, { recursive: true, force: true });
});

test("without a watch event, the recurring scan still brings the session in", async () => {
  openDb().exec("DELETE FROM history_sessions");
  const projects = freshProjects();
  const store = new HistoryStore();
  const reconciler = new HistoryReconciler({
    store,
    readers: [{ agent: "claude", spec: createClaudeHistory(projects) }],
    intervalMs: 100,
    watch: false,
    resolveRepository: () => null,
  });
  try {
    reconciler.start();
    const id = sessionId();
    writeSession(projects, id, opening(id, "/w", "missed by the watcher"));
    await until(() => store.index("claude").has(id), 5_000, "the next periodic scan");
  } finally {
    reconciler.stop();
  }
  rmSync(projects, { recursive: true, force: true });
});
