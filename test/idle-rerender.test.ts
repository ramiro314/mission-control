import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LastSeen, RelativeTime } from "../src/web/components/ClockText.tsx";
import { relativeTime, untilReset, uptime } from "../src/web/lib/format.ts";
import { keepIfUnchanged } from "../src/web/lib/unchanged.ts";
import { secondClock } from "../src/web/useNow.ts";

// An idle dashboard re-rendered its whole tree several times every few seconds because the
// App-level polls replaced equal data with fresh references, and those re-renders were also,
// by accident, the only clock the "6s ago" labels had. These cases pin both halves of the fix.

test("a poll that read the same value keeps the reference it already had", () => {
  const prev = { enabled: true, roles: [{ id: "a", spend: 1 }], note: null };
  const same = JSON.parse(JSON.stringify(prev)) as typeof prev;
  assert.equal(keepIfUnchanged(prev, same), prev);
  assert.equal(keepIfUnchanged(null, null), null);
  assert.equal(keepIfUnchanged(prev, prev), prev);
});

test("a poll that read anything new hands the new value through", () => {
  const prev = { enabled: true, roles: [{ id: "a", spend: 1 }] };
  const moved = { enabled: true, roles: [{ id: "a", spend: 2 }] };
  assert.equal(keepIfUnchanged(prev, moved), moved);
  assert.equal(keepIfUnchanged<typeof prev | null>(null, moved), moved);
  assert.equal(keepIfUnchanged<typeof prev | null>(prev, null), null);
});

test("the shared clock runs one interval for every subscriber and stops with the last", (t) => {
  const start = Date.now() + 60_000;
  mock.timers.enable({ apis: ["setInterval", "Date"], now: start });
  t.after(() => mock.timers.reset());

  let a = 0;
  let b = 0;
  const offA = secondClock.subscribe(() => a++);
  const offB = secondClock.subscribe(() => b++);
  assert.equal(secondClock.read(), start, "subscribing starts the clock at the current instant");

  mock.timers.tick(3_000);
  assert.deepEqual([a, b], [3, 3], "both labels heard the same three ticks");
  assert.equal(secondClock.read(), start + 3_000);

  offA();
  mock.timers.tick(1_000);
  assert.deepEqual([a, b], [3, 4], "an unsubscribed label hears nothing more");

  offB();
  mock.timers.tick(5_000);
  assert.equal(b, 4, "no subscriber, no interval");
  assert.equal(
    secondClock.read(),
    start + 9_000,
    "a first read after a quiet spell is the current instant, not the last tick",
  );
});

test("clock labels render the same text the render-time helpers did", () => {
  const now = Date.now();
  assert.equal(
    renderToStaticMarkup(createElement(RelativeTime, { at: now - 90_000 })),
    relativeTime(now - 90_000, now),
  );
  assert.equal(renderToStaticMarkup(createElement(RelativeTime, { at: null })), "");
  assert.equal(
    renderToStaticMarkup(createElement(LastSeen, { lastActivity: now - 20 * 60_000, startedAt: now - 3_600_000 })),
    "20m ago",
  );
  assert.equal(
    renderToStaticMarkup(createElement(LastSeen, { lastActivity: null, startedAt: now - 2 * 3_600_000 })),
    "up 2h",
  );
});

test("uptime and untilReset measure against an injected instant", () => {
  const now = 1_700_000_000_000;
  assert.equal(uptime(now - 42_000, now), "up 42s");
  assert.equal(uptime(null, now), "");
  assert.equal(untilReset((now + 2 * 3_600_000 + 40 * 60_000) / 1000, now), "in 2h 40m");
  assert.equal(untilReset(now / 1000 - 1, now), "now");
});
