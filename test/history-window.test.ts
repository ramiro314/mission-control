import assert from "node:assert/strict";
import test from "node:test";
import { readHistoryWindow, type HistoryPageRead } from "../src/web/components/history/history-window.ts";
import { HISTORY_PAGE_LIMITS, HISTORY_SEARCH_LIMITS, encodeHistoryCursor, type HistorySessionSummary } from "../src/shared/history.ts";

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

/**
 * A catalog that pages by the route's real cursor (the last row's key), so rows can be added
 * above a window between reads, as a session that starts while the page is open is.
 */
function liveCatalog(total: number): {
  rows: HistorySessionSummary[];
  add: (count: number) => void;
  read: (query: { cursor?: string; limit: number }) => Promise<HistoryPageRead>;
  asked: { cursor?: string; limit: number }[];
} {
  const row = (at: number, id: string) => ({ agent: "claude", agentSessionId: id, lastActivityAt: at }) as HistorySessionSummary;
  const rows = Array.from({ length: total }, (_, i) => row(1_000_000 - i, `s-${String(i).padStart(4, "0")}`));
  let added = 0;
  const asked: { cursor?: string; limit: number }[] = [];
  return {
    rows,
    asked,
    add: (count) => {
      for (let i = 0; i < count; i++) {
        added += 1;
        rows.unshift(row(2_000_000 + added, `new-${added}`));
      }
    },
    read: async (query) => {
      asked.push(query);
      assert.ok(query.limit <= HISTORY_PAGE_LIMITS.maxLimit, "no request exceeds the route's cap");
      const start = query.cursor ? rows.findIndex((entry) => encodeHistoryCursor(entry) === query.cursor) + 1 : 0;
      const end = Math.min(rows.length, start + query.limit);
      const last = rows[end - 1];
      return {
        ok: true,
        value: { sessions: rows.slice(start, end), nextCursor: end < rows.length && last ? encodeHistoryCursor(last) : null, progress: { indexing: false, indexed: total, total }, facets: { agents: [], repositories: [], retention: [] } },
      };
    },
  };
}

test("sessions added above the window push the re-read down to the last row on screen, and no further", async () => {
  const live = liveCatalog(300);
  const shown = await readHistoryWindow(live.read, 120);
  assert.ok(shown.ok);
  const lastOnScreen = shown.value.sessions.at(-1)!;
  live.add(3);
  live.asked.length = 0;
  const result = await readHistoryWindow(live.read, 120, lastOnScreen);
  assert.ok(result.ok);
  assert.equal(result.value.sessions.length, 123, "the three new rows are added; none of the loaded ones drop off");
  assert.equal(result.value.sessions[0]?.agentSessionId, "new-3");
  assert.equal(result.value.sessions.at(-1)?.agentSessionId, lastOnScreen.agentSessionId);
  assert.equal(result.value.nextCursor, encodeHistoryCursor(lastOnScreen), "the cursor continues right below it");
  // Load more from there returns exactly the rows that were below the window before.
  const next = await live.read({ cursor: result.value.nextCursor!, limit: 2 });
  assert.ok(next.ok);
  assert.deepEqual(next.value.sessions.map((entry) => entry.agentSessionId), ["s-0120", "s-0121"]);
});

test("a fully loaded window stays fully loaded when a session is added above it", async () => {
  const live = liveCatalog(57);
  const shown = await readHistoryWindow(live.read, 57);
  assert.ok(shown.ok);
  assert.equal(shown.value.nextCursor, null);
  live.add(1);
  const result = await readHistoryWindow(live.read, 57, shown.value.sessions.at(-1)!);
  assert.ok(result.ok);
  assert.equal(result.value.sessions.length, 58);
  assert.equal(result.value.nextCursor, null, "Load more does not come back");
});

test("a last row that left the list stops the search one capped page past the depth", async () => {
  const live = liveCatalog(1000);
  const gone = { agent: "claude", agentSessionId: "not-listed", lastActivityAt: 1 } as HistorySessionSummary;
  const result = await readHistoryWindow(live.read, 50, gone);
  assert.ok(result.ok);
  assert.equal(result.value.sessions.length, 50, "the window falls back to the depth");
  assert.deepEqual(live.asked, [{ limit: 50 }, { cursor: encodeHistoryCursor(live.rows[49]!), limit: HISTORY_PAGE_LIMITS.maxLimit }]);
  assert.equal(result.value.nextCursor, encodeHistoryCursor(live.rows[49]!));
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
