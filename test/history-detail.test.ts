import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Session History's detail routes: one session's row and live status, and its conversation
 * read forward through the path-based transcript windows. Sessions are addressed by agent and
 * UUID; the transcript path is the catalog's, and it is read only under a harness root.
 *
 * Every transcript is a fixture in a temp projects directory; nothing reads `~/.claude`.
 */

const home = mkdtempSync(join(tmpdir(), "mission-history-detail-"));
process.env.MISSION_HOME = home;

const { createClaudeHistory } = await import("../src/server/harness/claude/history.ts");
const { HistoryService } = await import("../src/server/history/service.ts");
const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
import type { HistoryMessagesPage, HistoryPage, HistorySessionDetail } from "../src/shared/history.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";

const LOOPBACK = { host: "127.0.0.1:7317" };
let ordinal = 0;

function sessionId(): string {
  ordinal += 1;
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

/** An interactive session of `turns` user/assistant pairs, each answer padded to `pad` bytes. */
function writeConversation(projects: string, id: string, turns: number, pad = 0): string {
  const dir = join(projects, "-work");
  mkdirSync(dir, { recursive: true });
  const base = { sessionId: id, cwd: "/work", entrypoint: "cli", version: "2.1.296", gitBranch: "main", isSidechain: false };
  const lines: unknown[] = [];
  for (let i = 0; i < turns; i++) {
    const timestamp = new Date(Date.UTC(2026, 9, 20, 10, 0, i)).toISOString();
    lines.push({ ...base, timestamp, uuid: `u-${id}-${i}`, type: "user", message: { role: "user", content: `question ${i}` } });
    lines.push({
      ...base,
      timestamp,
      uuid: `a-${id}-${i}`,
      type: "assistant",
      message: { id: `m-${id}-${i}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: `answer ${i}${" ".repeat(pad)}.` }] },
    });
  }
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

async function fixture(registry = new Registry()) {
  openDb().exec("DELETE FROM history_sessions");
  const projects = mkdtempSync(join(tmpdir(), "mission-history-detail-projects-"));
  const history = new HistoryService({ readers: [{ agent: "claude", spec: createClaudeHistory(projects) }], resolveRepository: () => null });
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks: {} as TaskManager, queues: {} as QueueManager, history });
  const get = (path: string) => app.request(path, { headers: LOOPBACK });
  return { projects, history, registry, get, done: () => rmSync(projects, { recursive: true, force: true }) };
}

test("detail returns the catalog row; a non-UUID id, an unknown id or an unknown agent is a 404", async () => {
  const f = await fixture();
  const id = sessionId();
  writeConversation(f.projects, id, 2);
  await f.history.reconciler.trigger();

  const res = await f.get(`/api/history/sessions/claude/${id}`);
  assert.equal(res.status, 200);
  const detail = await res.json() as HistorySessionDetail;
  assert.equal(detail.session.agentSessionId, id);
  assert.equal(detail.session.cwd, "/work");
  assert.equal(detail.session.branch, "main");
  assert.equal(detail.session.transcriptState, "present");
  assert.equal(detail.session.liveSessionId, null);
  assert.equal((await f.get(`/api/history/sessions/claude/${id.toUpperCase()}`)).status, 200, "a UUID's case does not matter");

  for (const path of [
    "/api/history/sessions/claude/not-a-uuid",
    `/api/history/sessions/claude/..%2F..%2F${id}`,
    `/api/history/sessions/claude/${sessionId()}`,
    `/api/history/sessions/nobody/${id}`,
    // Codex declares no reader, so even a well-formed id is unknown to History.
    `/api/history/sessions/codex/${id}`,
    "/api/history/sessions/claude/not-a-uuid/messages",
    `/api/history/sessions/claude/${sessionId()}/messages`,
  ]) {
    assert.equal((await f.get(path)).status, 404, path);
  }
  f.done();
});

test("messages page forward through the transcript, and a bad cursor is refused", async () => {
  const f = await fixture();
  const id = sessionId();
  // A window is at least 100 turns and 512 KB, so 400 turns over about 700 KB span two.
  writeConversation(f.projects, id, 200, 3_000);
  await f.history.reconciler.trigger();

  const first = await (await f.get(`/api/history/sessions/claude/${id}/messages`)).json() as HistoryMessagesPage;
  assert.equal(first.messages[0]?.text, "question 0", "the first window starts at the top");
  assert.ok(first.nextCursor, "and says there is more");
  const second = await (await f.get(`/api/history/sessions/claude/${id}/messages?cursor=${first.nextCursor}`)).json() as HistoryMessagesPage;
  assert.equal(second.nextCursor, null, "the second window reaches the end");
  const texts = [...first.messages, ...second.messages].map((m) => m.text);
  assert.equal(texts.length, 400, "every turn exactly once");
  assert.equal(new Set(texts).size, 400);
  assert.match(texts.at(-1) ?? "", /^answer 199 /);

  assert.equal((await f.get(`/api/history/sessions/claude/${id}/messages?cursor=-1`)).status, 400);
  assert.equal((await f.get(`/api/history/sessions/claude/${id}/messages?cursor=../x`)).status, 400);
  assert.equal((await f.get(`/api/history/sessions/claude/${id}/messages?path=/etc/passwd`)).status, 400);
  f.done();
});

test("a gone transcript keeps its detail, and its conversation answers 410", async () => {
  const f = await fixture();
  const id = sessionId();
  const path = writeConversation(f.projects, id, 1);
  await f.history.reconciler.trigger();
  rmSync(path);

  // Removed but not yet walked: the row still says present, and the read finds nothing.
  assert.equal((await f.get(`/api/history/sessions/claude/${id}/messages`)).status, 410);
  await f.history.reconciler.trigger();
  const detail = await (await f.get(`/api/history/sessions/claude/${id}`)).json() as HistorySessionDetail;
  assert.equal(detail.session.transcriptState, "gone");
  assert.equal(detail.session.cwd, "/work", "the record survives its transcript");
  assert.equal((await f.get(`/api/history/sessions/claude/${id}/messages`)).status, 410);
  f.done();
});

test("a transcript that is there but cannot be read is a 500 naming why, never retention or an empty conversation", async () => {
  const f = await fixture();
  const id = sessionId();
  const path = writeConversation(f.projects, id, 2);
  await f.history.reconciler.trigger();
  const point = (target: string) =>
    openDb().prepare("UPDATE history_sessions SET transcript_path = ? WHERE agent_session_id = ?").run(target, id);
  const read = async (query = "") => {
    const res = await f.get(`/api/history/sessions/claude/${id}/messages${query}`);
    return { status: res.status, error: ((await res.json()) as { error?: string }).error ?? "" };
  };

  // A symlink that resolves to itself: realpath fails with ELOOP, and the file is not gone.
  const loop = join(f.projects, "-work", "loop.jsonl");
  symlinkSync(loop, loop);
  point(loop);
  const looped = await read();
  assert.equal(looped.status, 500);
  assert.match(looped.error, /ELOOP/);
  assert.doesNotMatch(looped.error, /retention/);

  // A directory where the transcript should be.
  const folder = join(f.projects, "-work", "a-folder.jsonl");
  mkdirSync(folder);
  point(folder);
  assert.equal((await read()).status, 500);

  // A transcript the daemon may not read: refused on the first window and on a later one, not
  // answered with an empty page that says the conversation ended.
  point(path);
  if (process.getuid?.() !== 0) {
    chmodSync(path, 0o000);
    try {
      for (const query of ["", "?cursor=100"]) {
        const denied = await read(query);
        assert.equal(denied.status, 500, `messages${query}`);
        assert.match(denied.error, /EACCES/);
      }
    } finally {
      chmodSync(path, 0o644);
    }
  }
  // Readable again, it reads; a file that is really gone is still a 410.
  assert.equal((await read()).status, 200);
  rmSync(path);
  assert.equal((await read()).status, 410);
  f.done();
});

test("a catalog path outside every harness root is never read", async () => {
  const f = await fixture();
  const id = sessionId();
  writeConversation(f.projects, id, 1);
  await f.history.reconciler.trigger();
  const elsewhere = mkdtempSync(join(tmpdir(), "mission-history-elsewhere-"));
  const outside = writeConversation(elsewhere, id, 1);
  openDb().prepare("UPDATE history_sessions SET transcript_path = ? WHERE agent_session_id = ?").run(outside, id);

  assert.equal((await f.get(`/api/history/sessions/claude/${id}/messages`)).status, 404);
  rmSync(elsewhere, { recursive: true, force: true });
  f.done();
});

test("a session the Registry is running is reported live in the list and the detail", async () => {
  const registry = new Registry();
  const f = await fixture(registry);
  const id = sessionId();
  writeConversation(f.projects, id, 1);
  await f.history.reconciler.trigger();
  registry.registerSdkSession({ id: "sdk:history-live", agent: "claude", name: "running", cwd: "/work", agentSessionId: id });

  const detail = await (await f.get(`/api/history/sessions/claude/${id}`)).json() as HistorySessionDetail;
  assert.equal(detail.session.liveSessionId, "sdk:history-live");
  const page = await (await f.get("/api/history/sessions")).json() as HistoryPage;
  assert.equal(page.sessions.find((row) => row.agentSessionId === id)?.liveSessionId, "sdk:history-live");
  f.done();
});

test("no History read is exposed as an MCP tool", () => {
  for (const file of ["src/mcp/server.ts", "src/server/mission-mcp.ts"]) {
    assert.ok(!readFileSync(file, "utf8").includes("/api/history"), `${file} reaches no History route`);
  }
});
