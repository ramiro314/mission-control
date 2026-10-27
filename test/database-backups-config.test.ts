import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { QueueManager } from "../src/server/queue.ts";
import type { Registry } from "../src/server/registry.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import {
  DatabaseBackupsConfigPatchSchema,
  DatabaseBackupsConfigSchema,
  DEFAULT_DATABASE_BACKUPS_CONFIG,
} from "../src/shared/database-backups.ts";

const stateHome = mkdtempSync(join(tmpdir(), "mission-database-backups-config-"));
// Set the supported test home before importing any server module that can resolve the DB.
process.env.MISSION_HOME = stateHome;
after(() => rmSync(stateHome, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { DatabaseBackupService } = await import("../src/server/database-backups/service.ts");
const { getDatabaseBackupsConfig } = await import("../src/server/database-backups/config.ts");

const backupRoot = join(stateHome, "backups", "database");
const databaseBackups = new DatabaseBackupService(openDb(), { root: backupRoot });
const app = buildApp({
  registry: {} as Registry,
  reviews: {} as ReviewManager,
  tasks: {} as TaskManager,
  queues: {} as QueueManager,
  databaseBackups,
});
const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

function putConfig(body: unknown): Promise<Response> {
  return Promise.resolve(app.request("/api/storage/backups/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  }));
}

function seedScheduled(count: number): void {
  mkdirSync(backupRoot, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const name = `scheduled-2020010${index + 1}T000000000Z-${String(index).padStart(32, "b")}.sqlite3`;
    writeFileSync(join(backupRoot, name), "seeded copy");
  }
}

function scheduledCopies(): string[] {
  return readdirSync(backupRoot).filter((name) => name.startsWith("scheduled-"));
}

test("the shared schema defaults to 3 hourly, 2 pre-migration, every hour", () => {
  assert.deepEqual(DEFAULT_DATABASE_BACKUPS_CONFIG, {
    scheduledCount: 3,
    preMigrationCount: 2,
    intervalHours: 1,
  });
});

test("the shared schema refuses out-of-range counts and intervals, and never accepts 0", () => {
  for (const scheduledCount of [0, -1, 49, 2.5]) {
    assert.equal(DatabaseBackupsConfigSchema.safeParse({ scheduledCount }).success, false);
  }
  for (const preMigrationCount of [0, 11, 1.5]) {
    assert.equal(DatabaseBackupsConfigSchema.safeParse({ preMigrationCount }).success, false);
  }
  for (const intervalHours of [0, 2, 4, 48]) {
    assert.equal(DatabaseBackupsConfigSchema.safeParse({ intervalHours }).success, false);
  }
  for (const valid of [
    { scheduledCount: 1, preMigrationCount: 1, intervalHours: 24 },
    { scheduledCount: 48, preMigrationCount: 10, intervalHours: 12 },
  ]) {
    assert.deepEqual(DatabaseBackupsConfigSchema.parse(valid), valid);
  }
  assert.equal(DatabaseBackupsConfigPatchSchema.safeParse({ manualCount: 2 }).success, false);
});

test("saving lowered counts prunes at once, and a refused save changes nothing", async () => {
  seedScheduled(5);
  const saved = await putConfig({ scheduledCount: 2 });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), {
    scheduledCount: 2,
    preMigrationCount: 2,
    intervalHours: 1,
  });
  assert.equal(scheduledCopies().length, 2);

  for (const body of [{ scheduledCount: 0 }, { preMigrationCount: 11 }, { intervalHours: 2 }]) {
    const refused = await putConfig(body);
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.equal(getDatabaseBackupsConfig().scheduledCount, 2);
  assert.equal(scheduledCopies().length, 2);

  const raised = await putConfig({ scheduledCount: 1, intervalHours: 6 });
  assert.equal(raised.status, 200);
  assert.deepEqual(getDatabaseBackupsConfig(), {
    scheduledCount: 1,
    preMigrationCount: 2,
    intervalHours: 6,
  });
  assert.equal(scheduledCopies().length, 1);
});
