import assert from "node:assert/strict";
import test from "node:test";

import { usableProcessSnapshot, type ProcessSnapshot } from "../src/server/discovery/processes.ts";

// An inspector that cannot tell which processes the daemon's user owns makes every system-wide
// listing unusable after the fact - and on win32 one listing is a PowerShell CIM query over every
// process.
test("a host that cannot scope processes by user answers unusable without listing anything", async () => {
  let listed = 0;
  const snapshot = await usableProcessSnapshot(async () => {
    listed += 1;
    throw new Error("the listing should not run");
  }, () => "process owners are unreadable without the native process inspection addon (missing)");
  assert.equal(listed, 0);
  assert.deepEqual(snapshot, {
    processes: [],
    unknownReason: "process listing failed: process owners are unreadable without the native process inspection addon (missing)",
    cwdScopePids: [],
    completedCollectorPids: [],
  });
});

test("a host that can scope processes by user gets the real listing", async () => {
  const listing: ProcessSnapshot = { processes: [], unknownReason: null, cwdScopePids: [7], completedCollectorPids: [] };
  assert.equal(await usableProcessSnapshot(async () => listing, () => null), listing);
});
