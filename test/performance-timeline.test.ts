import assert from "node:assert/strict";
import test from "node:test";
import { boundPerformanceTimeline, PERFORMANCE_TIMELINE_CLEAR_INTERVAL_MS } from "../src/web/lib/performanceTimeline.ts";

function fakeHost(performance?: { clearMeasures(): void }) {
  const timers: { handler: () => void; ms: number }[] = [];
  return {
    timers,
    host: { performance, setInterval: (handler: () => void, ms: number) => timers.push({ handler, ms }) },
  };
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

test("schedules nothing when the host has no clearMeasures", () => {
  const { host, timers } = fakeHost(undefined);
  assert.equal(boundPerformanceTimeline(host), false);
  assert.equal(timers.length, 0);
});
