import assert from "node:assert/strict";
import test from "node:test";

import { usableProcessSnapshot, type ProcessSnapshot } from "../src/server/discovery/processes.ts";

// win32 has no effective uid, so every system-wide listing there is reported unusable after the
// fact - and on win32 one listing is a PowerShell CIM query over every process.
test("a host with no effective uid answers unusable without listing anything", async () => {
  let listed = 0;
  const snapshot = await usableProcessSnapshot(async () => {
    listed += 1;
    throw new Error("the listing should not run");
  }, null);
  assert.equal(listed, 0);
  assert.deepEqual(snapshot, {
    processes: [],
    unknownReason: "process listing failed: effective user identity is unavailable",
    cwdScopePids: [],
    completedCollectorPids: [],
  });
});

test("a host with an effective uid gets the real listing", async () => {
  const listing: ProcessSnapshot = { processes: [], unknownReason: null, cwdScopePids: [7], completedCollectorPids: [] };
  assert.equal(await usableProcessSnapshot(async () => listing, () => 501), listing);
});
