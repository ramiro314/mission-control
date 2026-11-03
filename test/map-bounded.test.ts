import assert from "node:assert/strict";
import test from "node:test";
import { mapBounded } from "../src/server/util/map-bounded.ts";

test("mapBounded keeps at most `limit` callbacks in flight and the output in input order", async () => {
  let inFlight = 0;
  let most = 0;
  const items = Array.from({ length: 50 }, (_, i) => i);
  const out = await mapBounded(items, 4, async (i) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    // Later items finish first, so the output order cannot come from completion order.
    await new Promise((resolve) => setTimeout(resolve, 50 - i));
    inFlight -= 1;
    return i * 2;
  });
  assert.equal(most, 4);
  assert.deepEqual(out, items.map((i) => i * 2));
});

test("mapBounded handles an empty input and a limit above the input size", async () => {
  assert.deepEqual(await mapBounded([], 8, async (i: number) => i), []);
  assert.deepEqual(await mapBounded([1, 2], 8, async (i) => i + 1), [2, 3]);
});
