import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import type { ServerEvent } from "../src/shared/types.ts";
import {
  backupFailedProblems,
  storageProblem,
  type StorageHealth,
  type StorageView,
} from "../src/shared/storage-health.ts";
import { databaseBackupStatusFrom } from "../src/shared/database-backups.ts";
import type { ActivityFingerprint } from "../src/server/git/worktree-activity.ts";
import type { WorktreeSlotRow } from "../src/server/worktrees/store.ts";

// What is at stake: Settings > Storage and the banner both read one aggregate, and the banner's
// dismissals are keyed by problem id. An id that changed across a daemon restart, or across one
// pass that missed its problem, would bring a dismissed banner back for nothing; one that stayed
// after its failure cleared would hide the next one.

const stateHome = mkdtempSync(join(tmpdir(), "mission-storage-health-"));
// Set the supported test home before importing any server module that can resolve the DB.
process.env.MISSION_HOME = stateHome;
after(() => rmSync(stateHome, { recursive: true, force: true }));

const { openDb, getAppConfig } = await import("../src/server/db.ts");
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { DatabaseBackupService } = await import("../src/server/database-backups/service.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const {
  advanceFirstSeen,
  STORAGE_FIRST_SEEN_GRACE_MS,
  StorageHealthService,
} = await import("../src/server/storage-health.ts");

const { LeaseActivityObserver } = await import("../src/server/worktrees/lease-activity.ts");
const { WorktreesConfigSchema, WorktreesConfigPatchSchema } = await import("../src/shared/protocol.ts");

const backupRoot = join(stateHome, "backups", "database");
const HOUR = 60 * 60 * 1_000;
const ENOSPC = async () => { throw new Error("ENOSPC: no space left on device"); };

beforeEach(() => {
  rmSync(backupRoot, { recursive: true, force: true });
  openDb().prepare("DELETE FROM app_config WHERE key IN (?, ?, ?)").run(
    APP_CONFIG_ENTRIES.backupsStatus.key,
    APP_CONFIG_ENTRIES.storageFirstSeen.key,
    APP_CONFIG_ENTRIES.worktreeLeaseActivity.key,
  );
});

/** A daemon generation: a backup service and a storage service over the same database. */
function daemon(options: { failing?: boolean; now?: () => number } = {}) {
  const published: StorageHealth[] = [];
  const backups = new DatabaseBackupService(openDb(), {
    root: backupRoot,
    ...(options.failing ? { onlineBackup: ENOSPC } : {}),
    ...(options.now ? { now: () => new Date(options.now!()) } : {}),
  });
  const health = new StorageHealthService({
    backups,
    publish: (value) => published.push(value),
    ...(options.now ? { now: options.now } : {}),
  });
  backups.onChange(() => health.recompute());
  return { backups, health, published };
}

function problemIds(health: StorageHealth): string[] {
  return health.problems.map((problem) => problem.id);
}

test("no failure streak raises no backup problem", () => {
  assert.deepEqual(backupFailedProblems(databaseBackupStatusFrom(undefined)), []);
});

test("a failed scheduled capture raises backup-failed with an id from failingSince, stable across a restart", async () => {
  let clock = Date.UTC(2026, 9, 27, 12);
  const first = daemon({ failing: true, now: () => clock });
  await assert.rejects(first.backups.captureScheduled(), /ENOSPC/);

  const failingSince = first.backups.status().scheduled.failingSince;
  assert.equal(failingSince, clock);
  const raised = first.published.at(-1)!;
  assert.deepEqual(raised.problems, [{
    id: `backup-failed:scheduled:${failingSince}`,
    kind: "backup-failed",
    bannered: true,
    message: "Scheduled database backup failed: ENOSPC: no space left on device",
    link: { target: "backups" },
  }], "the capture's own settle published the problem");

  // A second failure later in the same streak keeps the occurrence.
  clock += 10 * 60 * 1_000;
  await assert.rejects(first.backups.captureScheduled(), /ENOSPC/);
  assert.deepEqual(problemIds(first.published.at(-1)!), [`backup-failed:scheduled:${failingSince}`]);

  // A new daemon generation over the same database reports the same id.
  const restarted = daemon({ now: () => clock });
  assert.deepEqual(problemIds(restarted.health.recompute()), [`backup-failed:scheduled:${failingSince}`]);

  // The next success clears it, and a later failure is a new occurrence with a new id.
  clock += HOUR;
  await restarted.backups.captureScheduled();
  assert.deepEqual(restarted.published.at(-1)!.problems, []);
  clock += HOUR;
  const again = daemon({ failing: true, now: () => clock });
  await assert.rejects(again.backups.captureScheduled(), /ENOSPC/);
  assert.deepEqual(problemIds(again.health.current()), [`backup-failed:scheduled:${clock}`]);
});

test("a Back up now failure raises only backup-failed:manual, and a manual success clears both kinds", async () => {
  let clock = Date.UTC(2026, 9, 27, 12);
  const failing = daemon({ failing: true, now: () => clock });
  await assert.rejects(failing.backups.captureManual(), /ENOSPC/);
  assert.deepEqual(problemIds(failing.published.at(-1)!), [`backup-failed:manual:${clock}`]);
  assert.equal(failing.published.at(-1)!.backups.status.scheduled.lastFailure, null);

  clock += HOUR;
  await assert.rejects(failing.backups.captureScheduled(), /ENOSPC/);
  assert.deepEqual(problemIds(failing.published.at(-1)!), [
    `backup-failed:manual:${clock - HOUR}`,
    `backup-failed:scheduled:${clock}`,
  ]);

  clock += 1_000;
  const working = daemon({ now: () => clock });
  await working.backups.captureManual();
  const cleared = working.published.at(-1)!;
  assert.deepEqual(cleared.problems, []);
  assert.equal(cleared.backups.status.scheduled.failingSince, null);
  assert.deepEqual(cleared.backups.copies.map((copy) => copy.kind), ["manual"]);
});

test("the aggregate lists kept copies newest first with their total size, and publishes only on change", () => {
  mkdirSync(backupRoot, { recursive: true });
  writeFileSync(join(backupRoot, `scheduled-20261027T100000000Z-${"a".repeat(32)}.sqlite3`), "12345");
  writeFileSync(join(backupRoot, `pre-migration-20261027T110000000Z-${"b".repeat(32)}.sqlite3`), "123");
  writeFileSync(join(backupRoot, "notes.txt"), "not a copy");
  const { health, published } = daemon();

  const first = health.recompute();
  assert.deepEqual(first.backups.copies.map(({ kind, at, bytes }) => ({ kind, at, bytes })), [
    { kind: "preMigration", at: Date.UTC(2026, 9, 27, 11), bytes: 3 },
    { kind: "scheduled", at: Date.UTC(2026, 9, 27, 10), bytes: 5 },
  ]);
  assert.equal(first.backups.totalBytes, 8);
  assert.equal(published.length, 1);

  health.recompute();
  assert.equal(published.length, 1, "an unchanged aggregate wakes no browser");

  writeFileSync(join(backupRoot, `manual-20261027T120000000Z-${"c".repeat(32)}.sqlite3`), "1");
  assert.equal(health.recompute().backups.totalBytes, 9);
  assert.equal(published.length, 2);
});

test("a throwing change listener is reported and never turns a capture or prune around", async () => {
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (message: unknown) => { warnings.push(message); };
  const throwing = () => { throw new Error("listener exploded"); };
  try {
    const working = new DatabaseBackupService(openDb(), { root: backupRoot });
    working.onChange(throwing);
    const record = await working.captureManual();
    assert.equal(record.kind, "manual", "a successful capture still resolves");
    assert.deepEqual(working.keptCopies().map((copy) => copy.filename), [record.filename]);

    const failing = new DatabaseBackupService(openDb(), { root: backupRoot, onlineBackup: ENOSPC });
    failing.onChange(throwing);
    await assert.rejects(failing.captureScheduled(), /ENOSPC: no space left on device/);

    for (let hour = 10; hour < 15; hour += 1) {
      writeFileSync(join(backupRoot, `scheduled-20261027T${hour}0000000Z-${String(hour).padStart(32, "e")}.sqlite3`), "copy");
    }
    working.prune();
    assert.equal(
      working.keptCopies().filter((copy) => copy.kind === "scheduled").length,
      3,
      "prune still removed the copies above the default count",
    );
    assert.ok(warnings.length >= 3, "each throw is reported");
    assert.ok(warnings.every((warning) => /change listener failed: listener exploded/.test(String(warning))));
  } finally {
    console.warn = originalWarn;
  }
});

test("a source that throws is left out and the rest of the aggregate still lands", () => {
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (message: unknown) => { warnings.push(message); };
  try {
    const { backups } = daemon();
    const health = new StorageHealthService({
      backups,
      publish: () => {},
      sources: [() => { throw new Error("lsof timed out"); }],
    });
    assert.deepEqual(health.recompute().problems, []);
    assert.match(String(warnings[0]), /could not read problem source: lsof timed out/);
  } finally {
    console.warn = originalWarn;
  }
});

test("advanceFirstSeen keeps an absent subject through the grace, and drops a gone one at once", () => {
  const start = 1_000_000;
  let record = advanceFirstSeen({}, ["folder", "task"], [], start);
  assert.deepEqual(record, {
    folder: { firstSeenAt: start, lastSeenAt: start },
    task: { firstSeenAt: start, lastSeenAt: start },
  });
  record = advanceFirstSeen(record, ["folder"], ["task"], start + 5);
  assert.deepEqual(Object.keys(record), ["folder"], "a gone subject is dropped without waiting");
  record = advanceFirstSeen(record, [], [], start + 5 + STORAGE_FIRST_SEEN_GRACE_MS);
  assert.deepEqual(record.folder, { firstSeenAt: start, lastSeenAt: start + 5 }, "absent for exactly the grace");
  record = advanceFirstSeen(record, [], [], start + 6 + STORAGE_FIRST_SEEN_GRACE_MS);
  assert.deepEqual(record, {}, "absent for longer than the grace");
});

test("the first-seen record keeps an id across a pass that misses its problem and a restart, and drops it after 1 hour absent", () => {
  let clock = Date.UTC(2026, 9, 27, 12);
  let present = true;
  // A stand-in for a later problem kind with no timestamp of its own.
  const source = () => ({
    firstSeen: present
      ? [{
          subject: "/state/worktrees/husk",
          problem: (firstSeenAt: number) => storageProblem(
            "dirty-orphan-folder",
            "/state/worktrees/husk",
            firstSeenAt,
            "Unowned tree holds uncommitted work",
            { target: "unowned-tree", path: "/state/worktrees/husk" },
          ),
        }]
      : [],
  });
  const generation = () => new StorageHealthService({
    backups: { status: () => databaseBackupStatusFrom(undefined), keptCopies: () => [] },
    publish: () => {},
    sources: [source],
    now: () => clock,
  });
  const firstSeenAt = clock;
  const id = `dirty-orphan-folder:/state/worktrees/husk:${firstSeenAt}`;

  const first = generation();
  assert.deepEqual(problemIds(first.recompute()), [id]);
  assert.equal(first.recompute().problems[0]!.bannered, true);
  assert.deepEqual(
    getAppConfig(APP_CONFIG_ENTRIES.storageFirstSeen),
    { "/state/worktrees/husk": { firstSeenAt, lastSeenAt: firstSeenAt } },
    "written on first appearance",
  );

  // One pass misses it, then it is back: same id, also in a new daemon generation.
  clock += 5 * 60 * 1_000;
  present = false;
  assert.deepEqual(problemIds(first.recompute()), []);
  clock += 5 * 60 * 1_000;
  present = true;
  assert.deepEqual(problemIds(generation().recompute()), [id]);

  // Absent for more than an hour: the entry goes, and a reappearance is a new occurrence.
  present = false;
  clock += STORAGE_FIRST_SEEN_GRACE_MS + 1;
  const later = generation();
  assert.deepEqual(problemIds(later.recompute()), []);
  assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.storageFirstSeen), {});
  present = true;
  assert.deepEqual(problemIds(later.recompute()), [`dirty-orphan-folder:/state/worktrees/husk:${clock}`]);
});

test("the registry carries the aggregate in the snapshot and emits it as storage_health", () => {
  const registry = new Registry();
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  assert.equal(
    registry.snapshot().storageHealth,
    null,
    "unseeded: unknown, never an empty aggregate that reads as no copies and no problems",
  );

  const health = new StorageHealthService({
    backups: {
      status: () => databaseBackupStatusFrom({ scheduled: { failingSince: 5, consecutiveFailures: 1 } }),
      keptCopies: () => [],
    },
    publish: (value) => registry.setStorageHealth(value),
  });
  health.recompute();
  health.recompute();
  const frames = events.filter((event) => event.type === "storage_health");
  assert.equal(frames.length, 1);
  assert.deepEqual(problemIds(registry.snapshot().storageHealth!), ["backup-failed:scheduled:5"]);
});

function app(deps: Partial<Parameters<typeof buildApp>[0]> = {}) {
  return buildApp({
    registry: new Registry(),
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
    ...deps,
  });
}
const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

test("GET /api/storage returns the aggregate and config, and a saved count prunes what it lists", async () => {
  mkdirSync(backupRoot, { recursive: true });
  for (let hour = 10; hour < 15; hour += 1) {
    writeFileSync(join(backupRoot, `scheduled-20261027T${hour}0000000Z-${String(hour).padStart(32, "d")}.sqlite3`), "copy");
  }
  const { backups, health, published } = daemon();
  const routes = app({ databaseBackups: backups, storageHealth: health });

  const read = await routes.request("/api/storage", { headers: HEADERS });
  assert.equal(read.status, 200);
  const view = await read.json() as StorageView;
  assert.equal(view.health.backups.copies.length, 5, "seeded copies above the default count are listed until a prune");
  assert.deepEqual(view.config, { scheduledCount: 3, preMigrationCount: 2, intervalHours: 1 });

  const saved = await routes.request("/api/storage/backups/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ scheduledCount: 2 }),
  });
  assert.equal(saved.status, 200);
  assert.equal(published.at(-1)!.backups.copies.length, 2, "the save's prune published the smaller list");

  const refused = await routes.request("/api/storage/backups/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ scheduledCount: 49 }),
  });
  assert.equal(refused.status, 400);

  const reread = await (await routes.request("/api/storage", { headers: HEADERS })).json() as StorageView;
  assert.equal(reread.config.scheduledCount, 2);
  assert.deepEqual(
    reread.health.backups.copies.map((copy) => new Date(copy.at).getUTCHours()),
    [14, 13],
    "the newest copies are the ones kept",
  );
  // The config is per database; leave it at the default for any test after this one.
  await routes.request("/api/storage/backups/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ scheduledCount: 3 }),
  });
});

test("GET /api/storage answers 503 without a storage service", async () => {
  const response = await app().request("/api/storage", { headers: HEADERS });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "service_unavailable",
    message: "Storage health service is unavailable",
  });
});

// Stale live leases (AC11). The fixture stands in for the slot rows, the owner's domain row and
// the Git-visible probe; the clock itself is the real `worktrees.leaseActivity` record.

const DAY = 24 * HOUR;

function leasedSlot(overrides: Partial<WorktreeSlotRow> = {}): WorktreeSlotRow {
  return {
    id: "slot-1",
    poolId: "pool-1",
    ordinal: 1,
    path: "/state/worktrees/pool-1/1/demo",
    state: "leased",
    version: 4,
    requestedHeadSha: null,
    currentHeadSha: null,
    activeLeaseId: "lease-1",
    activeOwnerKind: "manual",
    activeOwnerKey: "manual-1",
    leasedAt: 0,
    lastReleasedLeaseId: null,
    lastReleasedOwnerKind: null,
    lastReleasedOwnerKey: null,
    lastUsedAt: null,
    quarantineReason: null,
    lastError: null,
    depsState: null,
    depsFingerprint: null,
    depsFingerprintSha: null,
    depsClaimedAt: null,
    depsLastError: null,
    depsLogPath: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** A daemon generation's lease clock over fixture slots, owners and Git-visible activity. */
function leaseClock(fixture: {
  slots: WorktreeSlotRow[];
  live?: (leaseId: string) => boolean;
  digest: (path: string) => ActivityFingerprint;
  days?: () => number;
  now: () => number;
}) {
  const passes: boolean[] = [];
  const observer = new LeaseActivityObserver({
    slots: () => fixture.slots,
    ownerLive: (reference) => fixture.live?.(reference.leaseId) ?? true,
    probe: async (path) => fixture.digest(path),
    staleLeaseDays: fixture.days ?? (() => 7),
    now: fixture.now,
    schedule: () => () => {},
  }, (staleChanged) => passes.push(staleChanged));
  const health = new StorageHealthService({
    backups: { status: () => databaseBackupStatusFrom(undefined), keptCopies: () => [] },
    publish: () => {},
    sources: [() => observer.problems()],
    now: fixture.now,
  });
  return { observer, health, passes };
}

test("staleLeaseDays defaults to 7, accepts 1 to 90, and refuses anything else", () => {
  assert.equal(WorktreesConfigSchema.parse({}).staleLeaseDays, 7);
  for (const days of [1, 90]) {
    assert.equal(WorktreesConfigSchema.parse({ staleLeaseDays: days }).staleLeaseDays, days);
    assert.equal(WorktreesConfigPatchSchema.parse({ staleLeaseDays: days }).staleLeaseDays, days);
  }
  for (const days of [0, 91, 2.5]) {
    assert.equal(WorktreesConfigSchema.safeParse({ staleLeaseDays: days }).success, false);
    assert.equal(WorktreesConfigPatchSchema.safeParse({ staleLeaseDays: days }).success, false);
  }
});

test("a live lease with no Git-visible change for staleLeaseDays is listed in Storage only, and a change clears it", async () => {
  let clock = Date.UTC(2026, 9, 1);
  let digest = "a";
  const slot = leasedSlot();
  const fixture = {
    slots: [slot],
    digest: (): ActivityFingerprint => ({ kind: "known", digest }),
    now: () => clock,
  };
  const first = leaseClock(fixture);
  // The first probe starts the clock now: it is never backdated to when the lease began.
  await first.observer.pass();
  assert.deepEqual(first.health.recompute().problems, []);

  clock += 7 * DAY - 1;
  await first.observer.pass();
  assert.deepEqual(first.health.recompute().problems, [], "one millisecond short of the threshold");

  clock += 1;
  await first.observer.pass();
  const flagged = first.health.recompute().problems;
  assert.deepEqual(flagged, [{
    id: "stale-lease:slot-1:lease-1",
    kind: "stale-lease",
    bannered: false,
    message: "/state/worktrees/pool-1/1/demo is still leased but has had no Git-visible change since 2026-10-01",
    link: { target: "slot", slotId: "slot-1" },
  }]);
  assert.deepEqual([...first.observer.staleSinceBySlot()], [["slot-1", Date.UTC(2026, 9, 1)]]);
  assert.deepEqual(first.passes, [true, false, true], "a pass reports when the stale set moved");

  // Listed, never reclaimed: the lease and its slot are exactly as they were.
  assert.deepEqual(fixture.slots, [leasedSlot()]);

  // The clock is durable, so a restarted daemon lists the same occurrence.
  const restarted = leaseClock(fixture);
  assert.deepEqual(problemIds(restarted.health.recompute()), ["stale-lease:slot-1:lease-1"]);

  // Any Git-visible change restarts the clock and clears the problem.
  digest = "b";
  await restarted.observer.pass();
  assert.deepEqual(restarted.health.recompute().problems, []);
  assert.deepEqual(stored(), { "lease-1": { slotId: "slot-1", digest: "b", changedAt: clock } });
});

test("the threshold is read on every recompute, so raising it above a lease's age clears the problem", async () => {
  let clock = Date.UTC(2026, 9, 1);
  let days = 3;
  const { observer, health } = leaseClock({
    slots: [leasedSlot()],
    digest: () => ({ kind: "known", digest: "a" }),
    days: () => days,
    now: () => clock,
  });
  await observer.pass();
  clock += 5 * DAY;
  assert.deepEqual(problemIds(health.recompute()), ["stale-lease:slot-1:lease-1"]);
  days = 10;
  assert.deepEqual(health.recompute().problems, []);
  assert.equal(observer.staleSinceBySlot().size, 0);
});

test("an unreadable probe or owner keeps the clock, a gone owner or a new lease drops it, and a warm owner has none", async () => {
  let clock = Date.UTC(2026, 9, 1);
  let probe: ActivityFingerprint = { kind: "known", digest: "a" };
  let live: boolean | "unknown" = true;
  const slots = [
    leasedSlot(),
    leasedSlot({ id: "slot-2", path: "/w/2", activeLeaseId: "lease-2", activeOwnerKind: "warm", activeOwnerKey: "op-1" }),
    leasedSlot({ id: "slot-3", path: "/w/3", state: "available", activeLeaseId: null, activeOwnerKind: null, activeOwnerKey: null }),
  ];
  const { observer, health } = leaseClock({
    slots,
    live: (leaseId) => {
      if (leaseId !== "lease-1") return true;
      if (live === "unknown") throw new Error("database is locked");
      return live;
    },
    digest: () => probe,
    now: () => clock,
  });
  await observer.pass();
  const started = { "lease-1": { slotId: "slot-1", digest: "a", changedAt: clock } };
  assert.deepEqual(stored(), started, "only the task, check or manual lease has a clock");

  clock += 8 * DAY;
  probe = { kind: "unknown", reason: "index listing did not complete" };
  await observer.pass();
  assert.deepEqual(stored(), started, "a probe that cannot answer moves nothing");
  assert.deepEqual(problemIds(health.recompute()), ["stale-lease:slot-1:lease-1"]);

  live = "unknown";
  probe = { kind: "known", digest: "z" };
  await observer.pass();
  assert.deepEqual(stored(), started, "an owner that cannot be read keeps its clock");
  assert.deepEqual(health.recompute().problems, [], "but is not listed as live");

  // A finished owner's lease is not live: no clock and no problem, even before it is returned.
  live = false;
  await observer.pass();
  assert.deepEqual(stored(), {});

  // The same slot under a new lease starts a new clock.
  live = true;
  slots[0] = leasedSlot({ activeLeaseId: "lease-9" });
  await observer.pass();
  assert.deepEqual(stored(), { "lease-9": { slotId: "slot-1", digest: "z", changedAt: clock } });
});

test("a request made while a pass runs gets exactly one more pass after it", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let probes = 0;
  const observer = new LeaseActivityObserver({
    slots: () => [leasedSlot()],
    ownerLive: () => true,
    probe: async () => {
      probes += 1;
      await gate;
      return { kind: "known", digest: "a" };
    },
    schedule: () => () => {},
  });
  observer.start();
  const running = observer.request();
  void observer.request();
  release();
  await running;
  assert.equal(probes, 2);
  await observer.stop();
});

function stored(): unknown {
  return getAppConfig(APP_CONFIG_ENTRIES.worktreeLeaseActivity) ?? {};
}
