import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  DATABASE_BACKUP_RETENTION,
  DatabaseBackupService,
  validateDatabaseBackupForRestore,
} from "../src/server/database-backups/service.ts";
import { startDatabaseBackupLoop } from "../src/server/database-backups/loop.ts";
import { verifyDatabaseBackupForRestore } from "../src/server/database-backups/restore.ts";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../src/server/db.ts";

function fixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return root;
}

function openWalDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE recovery_probe (value TEXT NOT NULL);
    PRAGMA wal_checkpoint(TRUNCATE);
    INSERT INTO recovery_probe VALUES ('committed-in-wal');
  `);
  return db;
}

test("online snapshots include committed WAL pages that a main-file copy loses", async (t) => {
  const root = fixture("mission-database-backup-wal-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourcePath = join(root, "harness.db");
  const source = openWalDatabase(sourcePath);
  t.after(() => source.close());
  assert.equal(existsSync(`${sourcePath}-wal`), true);
  const sourceBefore = statSync(sourcePath);

  const unsafeCopy = join(root, "unsafe-copy.db");
  copyFileSync(sourcePath, unsafeCopy);
  const copied = new DatabaseSync(unsafeCopy, { readOnly: true });
  assert.deepEqual(copied.prepare("SELECT value FROM recovery_probe").all(), []);
  copied.close();

  const service = new DatabaseBackupService(source, { root: join(root, "backups") });
  const snapshot = await service.captureScheduled();
  const backup = new DatabaseSync(snapshot.path, { readOnly: true });
  assert.deepEqual(
    backup
      .prepare("SELECT value FROM recovery_probe")
      .all()
      .map((row) => (row as { value: string }).value),
    ["committed-in-wal"],
  );
  backup.close();
  assert.equal(validateDatabaseBackupForRestore(snapshot.path).integrity, "ok");
  const sourceAfter = statSync(sourcePath);
  assert.equal(sourceAfter.uid, sourceBefore.uid);
  assert.equal(sourceAfter.mode & 0o777, sourceBefore.mode & 0o777);
  assert.equal(statSync(snapshot.path).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "backups")).mode & 0o777, 0o700);
});

test("scheduled and pre-migration generations have independent bounded retention", async (t) => {
  const root = fixture("mission-database-backup-retention-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new DatabaseSync(join(root, "harness.db"));
  t.after(() => source.close());
  source.exec("CREATE TABLE recovery_probe (value TEXT NOT NULL)");
  let now = Date.UTC(2026, 7, 30, 12, 0, 0);
  const service = new DatabaseBackupService(source, {
    root: join(root, "backups"),
    retention: { scheduled: 2, preMigration: 1 },
    now: () => new Date(now++),
  });

  await service.captureScheduled();
  await service.captureScheduled();
  await service.captureScheduled();
  service.capturePreMigration();
  service.capturePreMigration();

  const names = readdirSync(join(root, "backups"));
  assert.equal(names.filter((name) => name.startsWith("scheduled-")).length, 2);
  assert.equal(names.filter((name) => name.startsWith("pre-migration-")).length, 1);
  assert.equal(names.some((name) => name.includes(".tmp")), false);
});

const SEED_PREFIX = { scheduled: "scheduled", preMigration: "pre-migration", manual: "manual" };

/**
 * Plant `count` hourly copies of a kind dated in 2020, oldest first, so every real capture
 * sorts newer.
 * The content is never opened: prune decides by name alone.
 */
function seedCopies(
  backupRoot: string,
  kind: keyof typeof SEED_PREFIX,
  count: number,
): string[] {
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const stamp = new Date(Date.UTC(2020, 0, 1) + index * 3_600_000).toISOString().replace(/[-:.]/g, "");
    const name = `${SEED_PREFIX[kind]}-${stamp}-${String(index).padStart(32, "a")}.sqlite3`;
    writeFileSync(join(backupRoot, name), "seeded copy");
    names.push(name);
  }
  return names;
}

function kept(backupRoot: string, prefix: string): string[] {
  return readdirSync(backupRoot).filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".sqlite3")).sort();
}

function storeBackupsConfig(db: DatabaseSync, value: string): void {
  db.exec("CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare(
    "INSERT INTO app_config (key, value) VALUES ('backups', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(value);
}

test("the default retention is the shared schema default: 3 hourly and 2 pre-migration", () => {
  assert.deepEqual({ ...DATABASE_BACKUP_RETENTION }, { scheduled: 3, preMigration: 2 });
});

test("with default config a capture leaves 3 hourly, 2 pre-migration and the newest manual copy", async (t) => {
  const root = fixture("mission-database-backup-defaults-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backupRoot = join(root, "backups");
  const source = new DatabaseSync(join(root, "harness.db"));
  t.after(() => source.close());
  source.exec("CREATE TABLE recovery_probe (value TEXT NOT NULL)");
  // The audited machine: 24 hourly copies under the old fixed limit.
  const scheduled = seedCopies(backupRoot, "scheduled", 9);
  const preMigration = seedCopies(backupRoot, "preMigration", 5);
  const manual = seedCopies(backupRoot, "manual", 3);
  const service = new DatabaseBackupService(source, { root: backupRoot });

  const capture = await service.captureScheduled();

  assert.deepEqual(kept(backupRoot, "scheduled"), [...scheduled.slice(-2), capture.filename].sort());
  assert.deepEqual(kept(backupRoot, "pre-migration"), preMigration.slice(-2));
  assert.deepEqual(kept(backupRoot, "manual"), manual.slice(-1), "manual copies are outside the hourly limit");
});

test("saved counts change what prune keeps, and a malformed value reads as the default", async (t) => {
  const root = fixture("mission-database-backup-saved-counts-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backupRoot = join(root, "backups");
  const source = new DatabaseSync(join(root, "harness.db"));
  t.after(() => source.close());
  const service = new DatabaseBackupService(source, { root: backupRoot });

  seedCopies(backupRoot, "scheduled", 9);
  seedCopies(backupRoot, "preMigration", 9);
  storeBackupsConfig(source, JSON.stringify({ scheduledCount: 6, preMigrationCount: 4, intervalHours: 6 }));
  await service.captureScheduled();
  assert.equal(kept(backupRoot, "scheduled").length, 6);
  assert.equal(kept(backupRoot, "pre-migration").length, 4);

  storeBackupsConfig(source, JSON.stringify({ scheduledCount: 0 }));
  service.prune();
  assert.equal(kept(backupRoot, "scheduled").length, 3, "an out-of-range stored count falls back");
  assert.equal(kept(backupRoot, "pre-migration").length, 2);
});

test("prune deletes copies above a lowered limit with their sidecars", (t) => {
  const root = fixture("mission-database-backup-startup-prune-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backupRoot = join(root, "backups");
  const source = new DatabaseSync(join(root, "harness.db"));
  t.after(() => source.close());
  const scheduled = seedCopies(backupRoot, "scheduled", 4);
  const expired = join(backupRoot, scheduled[0]!);
  const survivor = join(backupRoot, scheduled[3]!);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    writeFileSync(`${expired}${suffix}`, "sidecar");
    writeFileSync(`${survivor}${suffix}`, "sidecar");
  }
  writeFileSync(join(backupRoot, "unrelated.sqlite3"), "not owned");
  storeBackupsConfig(source, JSON.stringify({ scheduledCount: 1 }));

  new DatabaseBackupService(source, { root: backupRoot }).prune();

  assert.deepEqual(readdirSync(backupRoot).sort(), [
    scheduled[3]!,
    `${scheduled[3]!}-journal`,
    `${scheduled[3]!}-shm`,
    `${scheduled[3]!}-wal`,
    "unrelated.sqlite3",
  ].sort());
});

test("prune on a fresh home with no backup directory does nothing", (t) => {
  const root = fixture("mission-database-backup-no-root-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new DatabaseSync(":memory:");
  t.after(() => source.close());
  new DatabaseBackupService(source, { root: join(root, "backups") }).prune();
  assert.equal(existsSync(join(root, "backups")), false);
});

test("restore validation rejects corruption without changing healthy live state", async (t) => {
  const root = fixture("mission-database-backup-corrupt-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new DatabaseSync(join(root, "harness.db"));
  t.after(() => source.close());
  source.exec("CREATE TABLE recovery_probe (value TEXT NOT NULL); INSERT INTO recovery_probe VALUES ('before')");
  const service = new DatabaseBackupService(source, { root: join(root, "backups") });
  const snapshot = await service.captureScheduled();
  source.exec("UPDATE recovery_probe SET value = 'healthy-live'");
  writeFileSync(snapshot.path, Buffer.from("not a sqlite database", "utf8"));

  assert.throws(
    () => validateDatabaseBackupForRestore(snapshot.path),
    /not a valid SQLite database backup|integrity/i,
  );
  assert.equal(
    (source.prepare("SELECT value FROM recovery_probe").get() as { value: string }).value,
    "healthy-live",
  );
});

test("restore validation forward-migrates a disposable copy and leaves the candidate read-only", async (t) => {
  const root = fixture("mission-database-backup-restore-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new DatabaseSync(join(root, "harness.db"));
  t.after(() => source.close());
  source.exec("CREATE TABLE recovery_probe (value TEXT NOT NULL); INSERT INTO recovery_probe VALUES ('recoverable')");
  const service = new DatabaseBackupService(source, { root: join(root, "backups") });
  const snapshot = await service.captureScheduled();

  const before = readFileSync(snapshot.path);
  const result = await verifyDatabaseBackupForRestore(snapshot.path);
  assert.equal(result.integrity, "ok");
  assert.equal(result.tableCount, 1);
  assert.equal(result.currentBuildIntegrity, "ok");
  assert.ok(result.currentBuildTableCount > result.tableCount);
  assert.deepEqual(readFileSync(snapshot.path), before, "validation must not mutate the candidate");
});

test("startup captures the WAL-consistent database before schema creation and migration", (t) => {
  const home = fixture("mission-database-backup-startup-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sourcePath = join(home, "harness.db");
  const source = openWalDatabase(sourcePath);
  t.after(() => source.close());

  const openArgs = [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    "const { openDb } = await import('./src/server/db.ts'); const db = openDb(); db.close();",
  ];
  const child = spawnSync(process.execPath, openArgs, {
      cwd: process.cwd(),
      env: { ...process.env, MISSION_HOME: home },
      encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);

  const backupRoot = join(home, "backups", "database");
  const names = readdirSync(backupRoot).filter((name) => name.startsWith("pre-migration-"));
  assert.equal(names.length, 1);
  const recovery = new DatabaseSync(join(backupRoot, names[0]!), { readOnly: true });
  assert.deepEqual(
    recovery
      .prepare("SELECT value FROM recovery_probe")
      .all()
      .map((row) => (row as { value: string }).value),
    ["committed-in-wal"],
  );
  assert.equal(
    (recovery.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'reviews'").get() as { count: number }).count,
    0,
    "the recovery point must precede current schema creation",
  );
  recovery.close();

  const migrated = new DatabaseSync(sourcePath, { readOnly: true });
  assert.equal(
    (migrated.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'reviews'").get() as { count: number }).count,
    1,
  );
  assert.equal(
    (migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    CURRENT_DATABASE_SCHEMA_VERSION,
  );
  migrated.close();

  const restarted = spawnSync(process.execPath, openArgs, {
    cwd: process.cwd(),
    env: { ...process.env, MISSION_HOME: home },
    encoding: "utf8",
  });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(
    readdirSync(backupRoot).filter((name) => name.startsWith("pre-migration-")),
    names,
    "an ordinary restart must not consume another pre-migration retention slot",
  );
});

test("startup stops before migrations when it cannot create a recovery point", (t) => {
  const home = fixture("mission-database-backup-startup-failure-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sourcePath = join(home, "harness.db");
  const source = new DatabaseSync(sourcePath);
  source.exec("CREATE TABLE legacy_only (value TEXT NOT NULL)");
  source.close();
  writeFileSync(join(home, "backups"), "blocks the backup directory");

  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "const { openDb } = await import('./src/server/db.ts'); try { openDb(); } catch (error) { console.error(String(error)); process.exit(42); }",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, MISSION_HOME: home },
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 42, child.stderr);
  assert.match(child.stderr, /stopped before migrations.*recovery backup failed/i);
  const untouched = new DatabaseSync(sourcePath, { readOnly: true });
  assert.equal(
    (untouched.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'reviews'").get() as { count: number }).count,
    0,
  );
  assert.equal(
    (untouched.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    0,
    "a failed recovery boundary must leave the migration pending",
  );
  untouched.close();
});

function openDbAt(home: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "const { openDb } = await import('./src/server/db.ts'); openDb().close();",
    ],
    { cwd: process.cwd(), env: { ...process.env, MISSION_HOME: home }, encoding: "utf8" },
  );
}

for (const [label, storedValue, expected] of [
  ["keeps the stored preMigrationCount", JSON.stringify({ preMigrationCount: 4 }), 4],
  ["falls back to the default when app_config is missing", null, 2],
  ["falls back to the default when the stored value is not JSON", "{not json", 2],
  ["falls back to the default when the stored count is out of range", JSON.stringify({ preMigrationCount: 0 }), 2],
] as const) {
  test(`openDb's pre-migration copy ${label}`, (t) => {
    const home = fixture("mission-database-backup-open-retention-");
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const legacy = new DatabaseSync(join(home, "harness.db"));
    legacy.exec("CREATE TABLE legacy_only (value TEXT NOT NULL)");
    if (storedValue !== null) storeBackupsConfig(legacy, storedValue);
    legacy.close();
    const backupRoot = join(home, "backups", "database");
    const seeded = seedCopies(backupRoot, "preMigration", 6);

    const child = openDbAt(home);
    assert.equal(child.status, 0, String(child.stderr));

    const names = kept(backupRoot, "pre-migration");
    assert.equal(names.length, expected);
    assert.deepEqual(names.slice(0, -1), seeded.slice(-(expected - 1)), "the newest copies are the ones kept");
  });
}

const idleTimers = {
  setTimer: () => ({ unref() {} }),
  clearTimer: () => undefined,
};

test("starting the backup loop prunes 24 hourly copies to 3 before any capture", async (t) => {
  const root = fixture("mission-database-backup-loop-start-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backupRoot = join(root, "backups");
  const source = new DatabaseSync(join(root, "harness.db"));
  t.after(() => source.close());
  const scheduled = seedCopies(backupRoot, "scheduled", 24);
  const service = new DatabaseBackupService(source, { root: backupRoot });
  let captures = 0;

  const stop = startDatabaseBackupLoop(
    {
      captureScheduled: () => {
        captures += 1;
        return service.captureScheduled();
      },
      prune: () => service.prune(),
    },
    idleTimers,
  );
  t.after(stop);

  assert.equal(captures, 0);
  assert.deepEqual(kept(backupRoot, "scheduled"), scheduled.slice(-3));
});

test("a prune that throws at loop start only warns, and the loop still schedules", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  let armed = 0;
  try {
    const stop = startDatabaseBackupLoop(
      {
        captureScheduled: () => Promise.reject(new Error("not reached")),
        prune: () => { throw new Error("backup root is a symlink"); },
      },
      { ...idleTimers, setTimer: () => { armed += 1; return { unref() {} }; } },
    );
    assert.equal(armed, 1, "the first capture is still scheduled");
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]![0]), /database backup prune failed: backup root is a symlink/);
    await stop();
  } finally {
    console.warn = originalWarn;
  }
});

test("the recurring loop waits one interval, contains failures, and never overlaps", async () => {
  let calls = 0;
  let reject: (error: Error) => void = () => { throw new Error("capture did not start"); };
  let scheduled: (() => void) | undefined;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const stop = startDatabaseBackupLoop(
      {
        captureScheduled: () => {
          calls += 1;
          return new Promise((_, rejectCapture) => { reject = rejectCapture; }) as never;
        },
        prune: () => undefined,
      },
      {
        intervalMs: 123,
        setTimer: (callback, delayMs) => {
          assert.equal(delayMs, 123);
          scheduled = callback;
          return { unref() {} };
        },
        clearTimer: () => undefined,
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 0, "startup must not compete with scheduled backup I/O");
    assert.ok(scheduled, "the first capture must be scheduled");
    const firstTick = scheduled;
    scheduled = undefined;
    firstTick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(scheduled, undefined, "no timer is armed while capture is in flight");
    reject(new Error("disk unavailable"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(warnings.length, 1);
    assert.ok(scheduled);
    await stop();
  } finally {
    console.warn = originalWarn;
  }
});
