import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Session History's tool-result and subagent routes, and the fuller reading History gives a
 * transcript: tool call ids, input past the live cap, and compaction boundaries.
 *
 * Neither `:toolUseId` nor `:agentId` may ever steer a read. Each is format-checked; a result is
 * found through the parent transcript's own record, which names any sidecar file; a subagent is
 * read only when the session's own `subagents/` listing holds it; and whatever resolves outside
 * the session's own folder, through a symlink for instance, is a 404.
 *
 * Every transcript is a fixture in a temp projects directory; nothing reads `~/.claude`.
 */

const home = mkdtempSync(join(tmpdir(), "mission-history-tool-results-"));
process.env.MISSION_HOME = home;

const { createClaudeHistory } = await import("../src/server/harness/claude/history.ts");
const { toMessage } = await import("../src/server/harness/claude/transcript.ts");
const { HistoryService } = await import("../src/server/history/service.ts");
const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
import { HISTORY_TOOL_INPUT_CAP, HISTORY_TOOL_RESULT_CAP, type HistoryMessagesPage, type HistorySessionDetail, type HistoryToolResult } from "../src/shared/history.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";

const LOOPBACK = { host: "127.0.0.1:7317" };
let ordinal = 0;

function sessionId(): string {
  ordinal += 1;
  return `00000000-0000-4000-9000-${String(ordinal).padStart(12, "0")}`;
}

const base = (id: string) => ({ sessionId: id, cwd: "/work", entrypoint: "cli", version: "2.1.296", gitBranch: "main", isSidechain: false });
const at = (i: number) => new Date(Date.UTC(2026, 9, 20, 10, 0, i)).toISOString();

function toolUse(id: string, i: number, toolUseId: string, input: Record<string, unknown>) {
  return {
    ...base(id),
    timestamp: at(i),
    uuid: `a-${id}-${i}`,
    type: "assistant",
    message: { id: `m-${id}-${i}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: toolUseId, name: "Bash", input }] },
  };
}

function toolResult(id: string, i: number, toolUseId: string, content: unknown, isError = false) {
  return {
    ...base(id),
    timestamp: at(i),
    uuid: `r-${id}-${i}`,
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
  };
}

function writeLines(path: string, lines: unknown[]): void {
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

/** A session folder beside the transcript, as Claude Code lays it out. */
function sessionDir(projects: string, id: string): string {
  return join(projects, "-work", id);
}

function writeSession(projects: string, id: string, lines: unknown[]): string {
  const dir = join(projects, "-work");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeLines(path, [{ ...base(id), timestamp: at(0), uuid: `u-${id}`, type: "user", message: { role: "user", content: "run the checks" } }, ...lines]);
  return path;
}

function persisted(projects: string, id: string, name: string): string {
  return [
    "<persisted-output>",
    `Output too large (40.1KB). Full output saved to: ${join(sessionDir(projects, id), "tool-results", name)}`,
    "",
    "Preview (first 2KB):",
    "line 1",
    "</persisted-output>",
  ].join("\n");
}

async function fixture() {
  openDb().exec("DELETE FROM history_sessions");
  const projects = mkdtempSync(join(tmpdir(), "mission-history-tool-results-projects-"));
  const outside = mkdtempSync(join(tmpdir(), "mission-history-tool-results-outside-"));
  const history = new HistoryService({ readers: [{ agent: "claude", spec: createClaudeHistory(projects) }], resolveRepository: () => null });
  const app = buildApp({ registry: new Registry(), reviews: {} as ReviewManager, tasks: {} as TaskManager, queues: {} as QueueManager, history });
  const get = (path: string) => app.request(path, { headers: LOOPBACK });
  return {
    projects,
    outside,
    history,
    get,
    done: () => {
      rmSync(projects, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    },
  };
}

test("a tool call's result is read inline, or from the sidecar file its own record names", async () => {
  const f = await fixture();
  const id = sessionId();
  writeSession(f.projects, id, [
    toolUse(id, 1, "toolu_inline", { command: "git status" }),
    toolResult(id, 2, "toolu_inline", [{ type: "text", text: "nothing to commit" }]),
    toolUse(id, 3, "toolu_saved", { command: "npm test" }),
    toolResult(id, 4, "toolu_saved", persisted(f.projects, id, "toolu_saved.txt")),
    toolUse(id, 5, "toolu_failed", { command: "false" }),
    toolResult(id, 6, "toolu_failed", "exit 1", true),
  ]);
  mkdirSync(join(sessionDir(f.projects, id), "tool-results"), { recursive: true });
  writeFileSync(join(sessionDir(f.projects, id), "tool-results", "toolu_saved.txt"), "the whole output\n".repeat(3));
  await f.history.reconciler.trigger();

  const inline = await (await f.get(`/api/history/sessions/claude/${id}/tool-results/toolu_inline`)).json() as HistoryToolResult;
  assert.deepEqual(inline, { toolUseId: "toolu_inline", source: "inline", isError: false, text: "nothing to commit", truncated: false });

  const saved = await (await f.get(`/api/history/sessions/claude/${id}/tool-results/toolu_saved`)).json() as HistoryToolResult;
  assert.equal(saved.source, "sidecar");
  assert.equal(saved.text, "the whole output\n".repeat(3), "the whole output, not the preview");

  const failed = await (await f.get(`/api/history/sessions/claude/${id}/tool-results/toolu_failed`)).json() as HistoryToolResult;
  assert.equal(failed.isError, true);
  assert.equal(failed.text, "exit 1");
  f.done();
});

test("a result that only mentions a sidecar path, or quotes another record's preview, is its own inline result; only a preview's saved-to line names a file", async () => {
  const f = await fixture();
  const id = sessionId();
  const saved = join(sessionDir(f.projects, id), "tool-results", "toolu_saved.txt");
  const counted = `412 ${saved}`;
  const missing = `cat: ${join(sessionDir(f.projects, id), "tool-results", "toolu_x.txt")}: No such file or directory`;
  const noSavedTo = "<persisted-output>\nOutput too large. Preview mentions tool-results/toolu_saved.txt\n</persisted-output>";
  // A grep over transcripts: another record's preview, JSON-escaped, naming a file that exists here.
  const quoted = `${id}.jsonl:{"type":"user","content":${JSON.stringify(persisted(f.projects, id, "toolu_saved.txt"))}}`;
  // A Read of a transcript: the quoted preview arrives unescaped, mid-text.
  const read2 = `1\tsome line\n2\t${persisted(f.projects, id, "toolu_saved.txt")}`;
  writeSession(f.projects, id, [
    toolUse(id, 1, "toolu_saved", { command: "npm test" }),
    toolResult(id, 2, "toolu_saved", persisted(f.projects, id, "toolu_saved.txt")),
    toolUse(id, 3, "toolu_count", { command: `wc -l ${saved}` }),
    toolResult(id, 4, "toolu_count", counted),
    toolUse(id, 5, "toolu_missing", { command: "cat toolu_x.txt" }),
    toolResult(id, 6, "toolu_missing", missing, true),
    toolUse(id, 7, "toolu_preview", { command: "npm test" }),
    toolResult(id, 8, "toolu_preview", noSavedTo),
    toolUse(id, 9, "toolu_grep", { command: "grep persisted-output *.jsonl" }),
    toolResult(id, 10, "toolu_grep", quoted),
    toolUse(id, 11, "toolu_read", { command: "cat -n transcript.jsonl" }),
    toolResult(id, 12, "toolu_read", read2),
  ]);
  mkdirSync(join(sessionDir(f.projects, id), "tool-results"), { recursive: true });
  writeFileSync(saved, "the whole npm test output");
  await f.history.reconciler.trigger();

  const read = async (toolUseId: string) => {
    const res = await f.get(`/api/history/sessions/claude/${id}/tool-results/${toolUseId}`);
    assert.equal(res.status, 200, toolUseId);
    return await res.json() as HistoryToolResult;
  };
  assert.equal((await read("toolu_saved")).source, "sidecar", "the persisted output itself still reads its file");
  for (const [toolUseId, text] of [
    ["toolu_count", counted],
    ["toolu_missing", missing],
    ["toolu_preview", noSavedTo],
    ["toolu_grep", quoted],
    ["toolu_read", read2],
  ] as const) {
    const result = await read(toolUseId);
    assert.equal(result.source, "inline", toolUseId);
    assert.equal(result.text, text, `${toolUseId} keeps its own recorded result`);
  }
  f.done();
});

test("a result past the 1 MB cap is cut at the cap and says so, inline and from a sidecar; one at the cap is whole", async () => {
  const f = await fixture();
  const id = sessionId();
  const over = "a".repeat(HISTORY_TOOL_RESULT_CAP + 1);
  const exact = "b".repeat(HISTORY_TOOL_RESULT_CAP);
  writeSession(f.projects, id, [
    toolUse(id, 1, "toolu_inline_over", { command: "cat big" }),
    toolResult(id, 2, "toolu_inline_over", over),
    toolUse(id, 3, "toolu_inline_exact", { command: "cat cap" }),
    toolResult(id, 4, "toolu_inline_exact", exact),
    toolUse(id, 5, "toolu_saved_over", { command: "cat big" }),
    toolResult(id, 6, "toolu_saved_over", persisted(f.projects, id, "toolu_saved_over.txt")),
    toolUse(id, 7, "toolu_saved_exact", { command: "cat cap" }),
    toolResult(id, 8, "toolu_saved_exact", persisted(f.projects, id, "toolu_saved_exact.txt")),
  ]);
  const sidecars = join(sessionDir(f.projects, id), "tool-results");
  mkdirSync(sidecars, { recursive: true });
  writeFileSync(join(sidecars, "toolu_saved_over.txt"), over);
  writeFileSync(join(sidecars, "toolu_saved_exact.txt"), exact);
  await f.history.reconciler.trigger();

  const read = async (toolUseId: string) =>
    await (await f.get(`/api/history/sessions/claude/${id}/tool-results/${toolUseId}`)).json() as HistoryToolResult;
  for (const [toolUseId, source] of [["toolu_inline_over", "inline"], ["toolu_saved_over", "sidecar"]] as const) {
    const result = await read(toolUseId);
    assert.equal(result.source, source, toolUseId);
    assert.equal(result.truncated, true, toolUseId);
    assert.equal(result.text.length, HISTORY_TOOL_RESULT_CAP, `${toolUseId} is cut at exactly the cap`);
  }
  for (const [toolUseId, source] of [["toolu_inline_exact", "inline"], ["toolu_saved_exact", "sidecar"]] as const) {
    const result = await read(toolUseId);
    assert.equal(result.source, source, toolUseId);
    assert.equal(result.truncated, false, toolUseId);
    assert.equal(result.text, exact, `${toolUseId} is whole`);
  }
  f.done();
});

test("a sidecar no transcript record names is not reachable, and a named one that is missing is unavailable", async () => {
  const f = await fixture();
  const id = sessionId();
  writeSession(f.projects, id, [
    toolUse(id, 1, "toolu_pending", { command: "sleep 100" }),
    toolUse(id, 2, "toolu_lost", { command: "npm test" }),
    toolResult(id, 3, "toolu_lost", persisted(f.projects, id, "toolu_lost.txt")),
  ]);
  const sidecars = join(sessionDir(f.projects, id), "tool-results");
  mkdirSync(sidecars, { recursive: true });
  // On disk, but no record points at it: neither its own name nor any other id reaches it.
  writeFileSync(join(sidecars, "orphan.txt"), "secret");
  writeFileSync(join(sidecars, "toolu_pending.txt"), "secret");
  await f.history.reconciler.trigger();

  for (const toolUseId of ["orphan", "orphan.txt", "toolu_pending", "toolu_unknown"]) {
    const res = await f.get(`/api/history/sessions/claude/${id}/tool-results/${toolUseId}`);
    assert.equal(res.status, 404, toolUseId);
    assert.doesNotMatch(await res.text(), /secret/);
  }
  const lost = await f.get(`/api/history/sessions/claude/${id}/tool-results/toolu_lost`);
  assert.equal(lost.status, 404, "the named file is gone");
  assert.match(((await lost.json()) as { error: string }).error, /not available/);
  f.done();
});

test("an id outside its format, or carrying .. or an encoded separator, is a 404", async () => {
  const f = await fixture();
  const id = sessionId();
  const longest = "t".repeat(128);
  const tooLong = "t".repeat(129);
  writeSession(f.projects, id, [
    toolUse(id, 1, "toolu_ok", { command: "ls" }),
    toolResult(id, 2, "toolu_ok", "ok"),
    // Recorded with a result, so only the format check can refuse these ids.
    toolUse(id, 3, "toolu.ok", { command: "ls" }),
    toolResult(id, 4, "toolu.ok", "recorded but out of format"),
    toolUse(id, 5, tooLong, { command: "ls" }),
    toolResult(id, 6, tooLong, "recorded but out of format"),
    toolUse(id, 7, longest, { command: "ls" }),
    toolResult(id, 8, longest, "the longest accepted id"),
  ]);
  const subagents = join(sessionDir(f.projects, id), "subagents");
  mkdirSync(subagents, { recursive: true });
  writeLines(join(subagents, "agent-0123abcd.jsonl"), [{ ...base(id), isSidechain: true, timestamp: at(1), uuid: "s-1", type: "user", message: { role: "user", content: "look" } }]);
  await f.history.reconciler.trigger();
  assert.equal((await f.get(`/api/history/sessions/claude/${id}/tool-results/toolu_ok`)).status, 200);
  assert.equal((await f.get(`/api/history/sessions/claude/${id}/subagents/0123abcd/messages`)).status, 200);
  const accepted = await f.get(`/api/history/sessions/claude/${id}/tool-results/${longest}`);
  assert.equal(accepted.status, 200, "128 characters is inside the format");
  assert.equal(((await accepted.json()) as HistoryToolResult).text, "the longest accepted id");
  for (const recorded of ["toolu.ok", tooLong]) {
    const res = await f.get(`/api/history/sessions/claude/${id}/tool-results/${recorded}`);
    assert.equal(res.status, 404, `${recorded.slice(0, 12)}: recorded, but refused by its format`);
    assert.doesNotMatch(await res.text(), /recorded but out of format/);
  }

  // A bare `..` (or `%2e%2e`) segment in a URL is resolved away before any route sees it, so it
  // is asked of the service directly; every other form reaches the route as the parameter.
  for (const bad of ["toolu..ok", "toolu_ok%2F..", "..%2F..%2Fetc%2Fpasswd", "toolu.ok", "a%5Cb", "x".repeat(129)]) {
    assert.equal((await f.get(`/api/history/sessions/claude/${id}/tool-results/${bad}`)).status, 404, `tool result ${bad}`);
  }
  for (const bad of ["0123..cd", "0123abc", "0123ABCD", "0123abcd%2F..", "..%2Fagent-0123abcd", "agent-0123abcd", "f".repeat(65)]) {
    assert.equal((await f.get(`/api/history/sessions/claude/${id}/subagents/${bad}/messages`)).status, 404, `subagent ${bad}`);
  }
  for (const bad of ["..", "../toolu_ok", "toolu_ok/..", "toolu_ok\\x"]) {
    assert.equal((await f.history.toolResult("claude", id, bad)).ok, false, `tool result ${bad}`);
  }
  for (const bad of ["..", "../0123abcd", "0123abcd/..", "0123abcd/../0123abcd"]) {
    const read = await f.history.subagentMessages("claude", id, bad, {});
    assert.equal(read.ok ? 200 : read.status, 404, `subagent ${bad}`);
  }
  // Well formed but not in the session's own listing.
  assert.equal((await f.get(`/api/history/sessions/claude/${id}/subagents/deadbeef/messages`)).status, 404);
  f.done();
});

test("a sidecar name from the record is one segment, and a path that resolves outside the session's folder is a 404", async () => {
  const f = await fixture();
  const id = sessionId();
  const other = sessionId();
  writeFileSync(join(f.outside, "secret.txt"), "secret");
  writeSession(f.projects, id, [
    toolUse(id, 1, "toolu_link", { command: "cat" }),
    toolResult(id, 2, "toolu_link", persisted(f.projects, id, "toolu_link.txt")),
    // A record that tries to walk out: only the last segment is ever a name, and `..` is none.
    toolUse(id, 3, "toolu_walk", { command: "cat" }),
    toolResult(id, 4, "toolu_walk", `<persisted-output>\nFull output saved to: /x/tool-results/../../secret.txt\n</persisted-output>`),
    // A record naming another session's sidecar folder: the name is read, the folder is this session's.
    toolUse(id, 5, "toolu_other", { command: "cat" }),
    toolResult(id, 6, "toolu_other", persisted(f.projects, other, "toolu_other.txt")),
  ]);
  const sidecars = join(sessionDir(f.projects, id), "tool-results");
  mkdirSync(sidecars, { recursive: true });
  symlinkSync(join(f.outside, "secret.txt"), join(sidecars, "toolu_link.txt"));
  mkdirSync(join(sessionDir(f.projects, other), "tool-results"), { recursive: true });
  writeFileSync(join(sessionDir(f.projects, other), "tool-results", "toolu_other.txt"), "secret");
  await f.history.reconciler.trigger();

  assert.equal((await f.get(`/api/history/sessions/claude/${id}/tool-results/toolu_link`)).status, 404, "a symlink out of the folder");
  const walk = await (await f.get(`/api/history/sessions/claude/${id}/tool-results/toolu_walk`)).json() as HistoryToolResult;
  assert.equal(walk.source, "inline", "no file is named, so the recorded preview is the result");
  assert.doesNotMatch(walk.text, /^secret$/);
  assert.equal((await f.get(`/api/history/sessions/claude/${id}/tool-results/toolu_other`)).status, 404, "never another session's folder");

  // The session's whole `tool-results` folder a symlink to somewhere else.
  const second = sessionId();
  writeSession(f.projects, second, [toolUse(second, 1, "toolu_dir", { command: "cat" }), toolResult(second, 2, "toolu_dir", persisted(f.projects, second, "secret.txt"))]);
  mkdirSync(sessionDir(f.projects, second), { recursive: true });
  symlinkSync(f.outside, join(sessionDir(f.projects, second), "tool-results"));
  await f.history.reconciler.trigger();
  assert.equal((await f.get(`/api/history/sessions/claude/${second}/tool-results/toolu_dir`)).status, 404, "a symlinked folder");
  f.done();
});

test("the detail lists subagent runs from the session's own listing, and each pages its own transcript", async () => {
  const f = await fixture();
  const id = sessionId();
  writeSession(f.projects, id, [{ ...base(id), timestamp: at(1), uuid: `a-${id}`, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "delegating" }] } }]);
  const subagents = join(sessionDir(f.projects, id), "subagents");
  mkdirSync(subagents, { recursive: true });
  const sub = (i: number, role: "user" | "assistant", text: string) => ({
    ...base(id),
    isSidechain: true,
    agentId: "0123abcd",
    timestamp: at(10 + i),
    uuid: `s-${i}`,
    type: role,
    message: { role, content: role === "user" ? text : [{ type: "text", text }] },
  });
  // 400 turns over about 700 KB: two windows.
  const turns = [];
  for (let i = 0; i < 200; i++) {
    turns.push(sub(i * 2, "user", `subagent question ${i}`), sub(i * 2 + 1, "assistant", `subagent answer ${i}${" ".repeat(3_000)}`));
  }
  writeLines(join(subagents, "agent-0123abcd.jsonl"), turns);
  writeFileSync(join(subagents, "agent-0123abcd.meta.json"), JSON.stringify({ agentType: "Explore", description: "Find the retry loop" }));
  writeLines(join(subagents, "agent-89abcdef.jsonl"), [{ ...sub(0, "user", "second run"), timestamp: at(500), agentId: "89abcdef" }]);
  // Not addressable: outside the id format, or a symlink out of the folder.
  writeLines(join(subagents, "agent-NOTHEX.jsonl"), [sub(0, "user", "hidden")]);
  writeLines(join(f.outside, "agent-feedface.jsonl"), [sub(0, "user", "secret")]);
  symlinkSync(join(f.outside, "agent-feedface.jsonl"), join(subagents, "agent-feedface.jsonl"));
  await f.history.reconciler.trigger();

  const detail = await (await f.get(`/api/history/sessions/claude/${id}`)).json() as HistorySessionDetail;
  assert.deepEqual(detail.subagents.map((run) => run.agentId), ["0123abcd", "89abcdef"], "oldest first, listed files only");
  assert.equal(detail.session.subagentCount, detail.subagents.length, "the row counts exactly the runs the detail lists");
  assert.deepEqual(
    { agentType: detail.subagents[0]!.agentType, description: detail.subagents[0]!.description, firstPrompt: detail.subagents[0]!.firstPrompt },
    { agentType: "Explore", description: "Find the retry loop", firstPrompt: "subagent question 0" },
  );
  assert.equal(detail.subagents[1]!.agentType, null, "no metadata file labels nothing");
  assert.ok(!JSON.stringify(detail).includes(f.projects), "no path reaches the wire");

  const first = await (await f.get(`/api/history/sessions/claude/${id}/subagents/0123abcd/messages`)).json() as HistoryMessagesPage;
  assert.equal(first.messages[0]?.text, "subagent question 0", "sidechain records are the subagent's own turns");
  assert.ok(first.nextCursor);
  const second = await (await f.get(`/api/history/sessions/claude/${id}/subagents/0123abcd/messages?cursor=${first.nextCursor}`)).json() as HistoryMessagesPage;
  assert.equal(second.nextCursor, null);
  assert.equal(first.messages.length + second.messages.length, 400, "every turn exactly once");

  assert.equal((await f.get(`/api/history/sessions/claude/${id}/subagents/feedface/messages`)).status, 404, "a symlink out of the folder");
  assert.equal((await f.get(`/api/history/sessions/claude/${id}/subagents/0123abcd/messages?cursor=x`)).status, 400);

  // The session's whole `subagents` folder a symlink to somewhere else lists nothing and reads nothing.
  const linked = sessionId();
  writeSession(f.projects, linked, []);
  mkdirSync(sessionDir(f.projects, linked), { recursive: true });
  rmSync(join(f.outside, "agent-feedface.jsonl"));
  writeLines(join(f.outside, "agent-0123abcd.jsonl"), [sub(0, "user", "secret")]);
  symlinkSync(f.outside, join(sessionDir(f.projects, linked), "subagents"));
  await f.history.reconciler.trigger();
  const linkedDetail = await (await f.get(`/api/history/sessions/claude/${linked}`)).json() as HistorySessionDetail;
  assert.deepEqual(linkedDetail.subagents, []);
  assert.equal((await f.get(`/api/history/sessions/claude/${linked}/subagents/0123abcd/messages`)).status, 404);
  f.done();
});

test("paging a subagent run looks up its one file, without reading every run to label it", async () => {
  openDb().exec("DELETE FROM history_sessions");
  const projects = mkdtempSync(join(tmpdir(), "mission-history-tool-results-projects-"));
  const claude = createClaudeHistory(projects);
  let labelled = 0;
  const spec = { ...claude, subagents: (...args: Parameters<typeof claude.subagents>) => { labelled += 1; return claude.subagents(...args); } };
  const history = new HistoryService({ readers: [{ agent: "claude", spec }], resolveRepository: () => null });
  const id = sessionId();
  writeSession(projects, id, []);
  const subagents = join(sessionDir(projects, id), "subagents");
  mkdirSync(subagents, { recursive: true });
  for (const agentId of ["0123abcd", "89abcdef", "feedface"]) {
    writeLines(join(subagents, `agent-${agentId}.jsonl`), [{ ...base(id), isSidechain: true, timestamp: at(1), uuid: `s-${agentId}`, type: "user", message: { role: "user", content: `run ${agentId}` } }]);
  }
  await history.reconciler.trigger();

  const detail = await history.detail("claude", id, () => null);
  assert.equal(detail?.subagents.length, 3);
  assert.equal(labelled, 1, "the detail labels every run once");
  const page = await history.subagentMessages("claude", id, "89abcdef", {});
  assert.equal(page.ok && page.page.messages[0]?.text, "run 89abcdef");
  const missing = await history.subagentMessages("claude", id, "deadbeef", {});
  assert.equal(missing.ok ? 200 : missing.status, 404);
  assert.equal(labelled, 1, "a page read never labels the runs");
  rmSync(projects, { recursive: true, force: true });
});

test("a gone transcript answers 410 for its results and runs, and lists no subagents", async () => {
  const f = await fixture();
  const id = sessionId();
  const path = writeSession(f.projects, id, [toolUse(id, 1, "toolu_ok", { command: "ls" }), toolResult(id, 2, "toolu_ok", "ok")]);
  mkdirSync(join(sessionDir(f.projects, id), "subagents"), { recursive: true });
  writeLines(join(sessionDir(f.projects, id), "subagents", "agent-0123abcd.jsonl"), []);
  await f.history.reconciler.trigger();
  rmSync(path);
  await f.history.reconciler.trigger();

  assert.equal((await f.get(`/api/history/sessions/claude/${id}/tool-results/toolu_ok`)).status, 410);
  assert.equal((await f.get(`/api/history/sessions/claude/${id}/subagents/0123abcd/messages`)).status, 410);
  const detail = await (await f.get(`/api/history/sessions/claude/${id}`)).json() as HistorySessionDetail;
  assert.deepEqual(detail.subagents, []);
  f.done();
});

test("History reads tool input past the live cap, with each call's id, and marks compaction; the live reading is unchanged", async () => {
  const f = await fixture();
  const id = sessionId();
  const long = "x".repeat(5_000);
  const records = [
    toolUse(id, 1, "toolu_long", { command: long }),
    { ...base(id), timestamp: at(2), uuid: `c-${id}`, type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 167_000 } },
    { ...base(id), timestamp: at(3), uuid: `s-${id}`, type: "user", isCompactSummary: true, message: { role: "user", content: "Summary of the earlier work." } },
    toolUse(id, 4, "toolu_huge", { command: "y".repeat(HISTORY_TOOL_INPUT_CAP + 1_000) }),
  ];
  writeSession(f.projects, id, records);
  await f.history.reconciler.trigger();

  const page = await (await f.get(`/api/history/sessions/claude/${id}/messages`)).json() as HistoryMessagesPage;
  const call = page.messages.find((m) => m.tools.length > 0)!.tools[0]!;
  assert.equal(call.id, "toolu_long");
  assert.equal(JSON.parse(call.input!).command, long, "the whole input");
  const huge = page.messages.find((m) => m.tools[0]?.id === "toolu_huge")!.tools[0]!;
  assert.equal(huge.input!.length, HISTORY_TOOL_INPUT_CAP + 1, "input past 256 KB is cut at the cap");
  assert.ok(huge.input!.endsWith("…"));
  assert.ok(huge.input!.startsWith('{"command":"yyy'));
  const boundary = page.messages.find((m) => m.presentation?.kind === "compaction");
  assert.deepEqual(boundary?.presentation, { kind: "compaction", trigger: "auto", preTokens: 167_000 });
  const summary = page.messages.find((m) => m.presentation?.kind === "compaction_summary");
  assert.equal(summary?.text, "Summary of the earlier work.");

  // The live view reads the same records exactly as it did.
  const live = toMessage(records[0]);
  assert.equal(live?.tools[0]?.id, undefined);
  assert.ok((live?.tools[0]?.input?.length ?? 0) <= 1_801);
  assert.equal(toMessage(records[1]), null, "no boundary in the live view");
  assert.equal(toMessage(records[2])?.presentation, undefined);
  f.done();
});
