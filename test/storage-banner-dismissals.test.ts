import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { storageProblem, type StorageHealth, type StorageProblem } from "../src/shared/storage-health.ts";
import { databaseBackupStatusFrom } from "../src/shared/database-backups.ts";
import { StorageBanner } from "../src/web/components/StorageBanner.tsx";
import {
  dismissStorageProblems,
  observeStorageProblems,
  STORAGE_DISMISSAL_GRACE_MS,
  STORAGE_DISMISSAL_LIMIT,
  undismissedStorageProblems,
} from "../src/web/lib/storageBannerDismissals.ts";

const DAY = 24 * 60 * 60 * 1_000;
const quarantined = storageProblem("quarantined-slot", "slot-1", 100, "Slot 1 is quarantined", { target: "slot", slotId: "slot-1" });
const orphan = storageProblem("orphan-process", "/tree", "1:200", "A process outlived its tree", { target: "unowned-tree", path: "/tree" });
const staleLease = storageProblem("stale-lease", "slot-2", "lease-1", "Slot 2's lease is stale", { target: "slot", slotId: "slot-2" });

function health(...problems: StorageProblem[]): StorageHealth {
  return { backups: { status: databaseBackupStatusFrom(undefined), copies: [], totalBytes: 0 }, problems };
}

test("a dismissed problem stays hidden while a new one shows", () => {
  const dismissed = dismissStorageProblems({}, [quarantined.id], 0);
  assert.deepEqual(undismissedStorageProblems(health(quarantined), dismissed), []);
  assert.deepEqual(undismissedStorageProblems(health(quarantined, orphan), dismissed), [orphan]);
});

test("a problem that is not bannered never counts", () => {
  assert.deepEqual(undismissedStorageProblems(health(staleLease), {}), []);
  assert.deepEqual(undismissedStorageProblems(null, {}), []);
});

test("an aggregate refreshes what it lists before dropping what has been gone over the grace", () => {
  let entries = dismissStorageProblems({}, [quarantined.id, orphan.id], 0);
  // One aggregate omits the orphan; the next, inside the grace, lists it again.
  entries = observeStorageProblems(entries, [quarantined.id], STORAGE_DISMISSAL_GRACE_MS);
  assert.deepEqual(Object.keys(entries).sort(), [orphan.id, quarantined.id].sort());
  entries = observeStorageProblems(entries, [quarantined.id, orphan.id], STORAGE_DISMISSAL_GRACE_MS);
  assert.equal(entries[orphan.id]!.lastSeenAt, STORAGE_DISMISSAL_GRACE_MS);

  // A dashboard reopened 30 days later still holds a problem that is still present.
  entries = observeStorageProblems(entries, [quarantined.id], 31 * DAY);
  assert.deepEqual(Object.keys(entries), [quarantined.id]);
  assert.equal(entries[quarantined.id]!.lastSeenAt, 31 * DAY);
});

test("an entry absent for exactly the grace is kept, and one absent for longer is dropped", () => {
  const entries = dismissStorageProblems({}, [orphan.id], 0);
  assert.ok(observeStorageProblems(entries, [], STORAGE_DISMISSAL_GRACE_MS)[orphan.id]);
  assert.equal(observeStorageProblems(entries, [], STORAGE_DISMISSAL_GRACE_MS + 1)[orphan.id], undefined);
});

test("at most the limit is kept, evicting the oldest lastSeenAt first", () => {
  let entries = {};
  for (let index = 0; index < STORAGE_DISMISSAL_LIMIT; index += 1) {
    entries = dismissStorageProblems(entries, [`old-${index}`], index);
  }
  entries = dismissStorageProblems(entries, ["new-a", "new-b"], STORAGE_DISMISSAL_LIMIT);
  const kept = Object.keys(entries);
  assert.equal(kept.length, STORAGE_DISMISSAL_LIMIT);
  assert.ok(!kept.includes("old-0") && !kept.includes("old-1"));
  assert.ok(kept.includes("old-2") && kept.includes("new-a") && kept.includes("new-b"));
});

test("the cap evicts by lastSeenAt, not insertion order, so an early dismissal still present survives", () => {
  let entries = {};
  for (let index = 0; index < STORAGE_DISMISSAL_LIMIT; index += 1) {
    entries = dismissStorageProblems(entries, [`old-${index}`], index);
  }
  // The first dismissal is still present, so an aggregate refreshes it while it keeps its
  // place at the front of the record's key order.
  entries = observeStorageProblems(entries, ["old-0"], 1_000);
  assert.equal(Object.keys(entries)[0], "old-0");
  entries = dismissStorageProblems(entries, ["new-a"], 1_001);
  assert.equal(Object.keys(entries).length, STORAGE_DISMISSAL_LIMIT);
  assert.deepEqual(entries["old-0" as keyof typeof entries], { lastSeenAt: 1_000 });
  assert.equal(entries["old-1" as keyof typeof entries], undefined);
  assert.ok("old-2" in entries && "new-a" in entries);
});

test("the banner names a single problem, counts several, and links to Settings > Storage", () => {
  const one = renderToStaticMarkup(createElement(StorageBanner, { health: health(quarantined, staleLease) }));
  assert.match(one, /Slot 1 is quarantined/);
  assert.match(one, /href="#\/settings\/storage"/);
  const two = renderToStaticMarkup(createElement(StorageBanner, { health: health(quarantined, orphan) }));
  assert.match(two, /2 storage problems need attention\./);
  assert.equal(renderToStaticMarkup(createElement(StorageBanner, { health: health(staleLease) })), "");
});
