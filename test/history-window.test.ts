import assert from "node:assert/strict";
import test from "node:test";
import { readHistoryWindow, type HistoryPageRead } from "../src/web/components/history/history-window.ts";
import { HISTORY_PAGE_LIMITS, type HistorySessionSummary } from "../src/shared/history.ts";

/** A catalog of `total` rows, served the way the route serves it: capped pages and a cursor. */
function catalog(total: number): { read: (query: { cursor?: string; limit: number }) => Promise<HistoryPageRead>; asked: { cursor?: string; limit: number }[] } {
  const rows = Array.from({ length: total }, (_, i) => ({ agent: "claude", agentSessionId: `s-${String(i).padStart(4, "0")}` }) as HistorySessionSummary);
  const asked: { cursor?: string; limit: number }[] = [];
  const progress = { indexing: true, indexed: 1, total };
  return {
    asked,
    read: async (query) => {
      asked.push(query);
      assert.ok(query.limit <= HISTORY_PAGE_LIMITS.maxLimit, "no request exceeds the route's cap");
      const start = query.cursor ? Number(query.cursor) : 0;
      const end = Math.min(rows.length, start + query.limit);
      return { ok: true, value: { sessions: rows.slice(start, end), nextCursor: end < rows.length ? String(end) : null, progress } };
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
