import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_WINDOW_HOPS,
  readConversationWindow,
  readHistoryWindow,
  type HistoryMessagesRead,
  type HistoryPageRead,
} from "../src/web/components/history/history-window.ts";
import { HISTORY_PAGE_LIMITS, HISTORY_SEARCH_LIMITS, type HistorySessionSummary } from "../src/shared/history.ts";
import type { TranscriptMessage } from "../src/shared/types.ts";

/** A catalog of `total` rows, served the way the route serves it: capped pages and a cursor. */
function catalog(total: number): { read: (query: { cursor?: string; limit: number }) => Promise<HistoryPageRead>; asked: { cursor?: string; limit: number }[] } {
  const rows = Array.from({ length: total }, (_, i) => ({ agent: "claude", agentSessionId: `s-${String(i).padStart(4, "0")}` }) as HistorySessionSummary);
  const asked: { cursor?: string; limit: number }[] = [];
  const progress = { indexing: true, indexed: 1, total };
  const facets = { agents: [], repositories: [], retention: [] };
  return {
    asked,
    read: async (query) => {
      asked.push(query);
      assert.ok(query.limit <= HISTORY_PAGE_LIMITS.maxLimit, "no request exceeds the route's cap");
      const start = query.cursor ? Number(query.cursor) : 0;
      const end = Math.min(rows.length, start + query.limit);
      return { ok: true, value: { sessions: rows.slice(start, end), nextCursor: end < rows.length ? String(end) : null, progress, facets } };
    },
  };
}

test("a refresh past the route's cap reads every row down to the depth on screen", async () => {
  const { read, asked } = catalog(400);
  const result = await readHistoryWindow(read, 250);
  assert.ok(result.ok);
  assert.equal(result.value.sessions.length, 250);
  assert.equal(result.value.sessions[249]?.agentSessionId, "s-0249");
  assert.equal(result.value.nextCursor, "250", "the cursor continues below the window, not back at the cap");
  assert.deepEqual(asked, [{ limit: 200 }, { cursor: "200", limit: 50 }]);
});

test("a refresh within the cap is one read, and a short catalog ends the window", async () => {
  const one = catalog(400);
  const result = await readHistoryWindow(one.read, 120);
  assert.ok(result.ok);
  assert.equal(result.value.sessions.length, 120);
  assert.equal(one.asked.length, 1);

  const short = catalog(30);
  const all = await readHistoryWindow(short.read, 250);
  assert.ok(all.ok);
  assert.equal(all.value.sessions.length, 30);
  assert.equal(all.value.nextCursor, null);

  const floor = catalog(400);
  await readHistoryWindow(floor.read, 0);
  assert.deepEqual(floor.asked, [{ limit: HISTORY_PAGE_LIMITS.defaultLimit }], "never asks for less than a page");
});

test("a failed continuation fails the refresh rather than keeping a truncated window", async () => {
  const { read } = catalog(400);
  const result = await readHistoryWindow(async (query) => (query.cursor ? { ok: false, error: "busy" } : read(query)), 250);
  assert.deepEqual(result, { ok: false, error: "busy" });
});

test("the route's filters become the list query: local days, with an exclusive end", async () => {
  const { historyFilterQuery } = await import("../src/web/components/history/history-window.ts");
  assert.deepEqual(historyFilterQuery(undefined), {});
  assert.deepEqual(historyFilterQuery({ q: "  words  ", repo: "/code/app", kind: "all", agent: "claude" }), {
    q: "words", repo: "/code/app", kind: "all", agent: "claude",
  });
  const query = historyFilterQuery({ from: "2026-10-01", to: "2026-10-01" });
  assert.equal(query.from, new Date(2026, 9, 1).getTime(), "from is local midnight that day");
  assert.equal(query.to, new Date(2026, 9, 2).getTime(), "to is local midnight the day after, so the whole day is in");
});

test("a search longer than the route accepts is cut to its limit, not sent to be refused", async () => {
  const { historyFilterQuery } = await import("../src/web/components/history/history-window.ts");
  assert.equal(historyFilterQuery({ q: "x".repeat(250) }).q, "x".repeat(HISTORY_SEARCH_LIMITS.queryChars));
});

/**
 * A transcript served as the messages route serves it: `windows[i]` is the turns in window i,
 * and every window but the last carries a cursor to the next. An empty entry is a window that
 * crossed no complete turn, which the reader returns when one record outgrows its budget.
 */
function transcript(windows: string[][]): { read: (cursor: string | null) => Promise<HistoryMessagesRead>; asked: (string | null)[] } {
  const asked: (string | null)[] = [];
  return {
    asked,
    read: async (cursor) => {
      asked.push(cursor);
      const i = cursor === null ? 0 : Number(cursor);
      const messages = windows[i]!.map((text) => ({ id: text, role: "assistant", text, tools: [], ts: 0 }) as TranscriptMessage);
      return { ok: true, value: { messages, nextCursor: i + 1 < windows.length ? String(i + 1) : null } };
    },
  };
}

test("a conversation read steps over windows that held no turn, to the turns after them", async () => {
  const t = transcript([[], [], ["Question 000", "Answer 000."], ["Question 001"]]);
  const result = await readConversationWindow(t.read, null);
  assert.ok(result.ok);
  assert.deepEqual(result.value.messages.map((m) => m.text), ["Question 000", "Answer 000."]);
  assert.equal(result.value.nextCursor, "3", "and continues from the window after the one it returned");
  assert.deepEqual(t.asked, [null, "1", "2"]);
});

test("a conversation read stops at the hop cap and hands back a cursor, rather than reading for ever", async () => {
  const t = transcript([...Array.from({ length: EMPTY_WINDOW_HOPS + 5 }, () => []), ["Late turn"]]);
  const first = await readConversationWindow(t.read, null);
  assert.ok(first.ok);
  assert.deepEqual(first.value.messages, []);
  assert.equal(t.asked.length, EMPTY_WINDOW_HOPS + 1, "the first window plus the capped number of hops");
  assert.equal(first.value.nextCursor, String(EMPTY_WINDOW_HOPS + 1), "the empty window it stopped on still says there is more");
  const next = await readConversationWindow(t.read, first.value.nextCursor);
  assert.ok(next.ok);
  assert.deepEqual(next.value.messages.map((m) => m.text), ["Late turn"]);
  assert.equal(next.value.nextCursor, null);
});

test("a conversation read returns a refusal as it is, and an empty last window as the end", async () => {
  const refused = await readConversationWindow(async () => ({ ok: false, error: "transcript removed", status: 410 }), null);
  assert.deepEqual(refused, { ok: false, error: "transcript removed", status: 410 });
  const t = transcript([[]]);
  const empty = await readConversationWindow(t.read, null);
  assert.ok(empty.ok);
  assert.equal(empty.value.nextCursor, null);
  assert.equal(t.asked.length, 1);
});
