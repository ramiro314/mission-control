import assert from "node:assert/strict";
import test from "node:test";
import { boundPerformanceTimeline, PERFORMANCE_TIMELINE_CLEAR_INTERVAL_MS } from "../src/web/lib/performanceTimeline.ts";

type TimelineHost = NonNullable<Parameters<typeof boundPerformanceTimeline>[0]>;

// `performance` is loosely typed so a test can hand over an object without a callable
// `clearMeasures`, which is what the helper's guard exists for.
function fakeHost(performance?: object) {
  const timers: { handler: () => void; ms: number }[] = [];
  const host = { performance, setInterval: (handler: () => void, ms: number) => timers.push({ handler, ms }) };
  return { timers, host: host as TimelineHost };
}

test("clears performance measures on every interval tick", () => {
  let clears = 0;
  const { host, timers } = fakeHost({ clearMeasures: () => clears++ });

  assert.equal(boundPerformanceTimeline(host), true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.ms, PERFORMANCE_TIMELINE_CLEAR_INTERVAL_MS);
  assert.equal(clears, 0, "nothing is cleared before the first tick");

  const [timer] = timers;
  timer!.handler();
  timer!.handler();
  assert.equal(clears, 2);
});

test("honors a custom interval", () => {
  const { host, timers } = fakeHost({ clearMeasures: () => {} });
  boundPerformanceTimeline(host, 5);
  assert.equal(timers[0]?.ms, 5);
});

test("schedules nothing when the host has no performance object", () => {
  const { host, timers } = fakeHost(undefined);
  assert.equal(boundPerformanceTimeline(host), false);
  assert.equal(timers.length, 0);
});

test("schedules nothing when performance has no callable clearMeasures", () => {
  for (const performance of [{}, { clearMeasures: "not a function" }]) {
    const { host, timers } = fakeHost(performance);
    assert.equal(boundPerformanceTimeline(host), false);
    assert.equal(timers.length, 0);
  }
});
