import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// Seed a database that predates both native pool tables and the check provider column,
// before importing db.ts and allowing the production open path to migrate it.
const home = process.env.HARNESS_HOME;
assert.ok(home, "test/setup-state.mjs must provide an isolated HARNESS_HOME");
mkdirSync(home, { recursive: true });
const path = join(home, "harness.db");
const legacy = new DatabaseSync(path);
legacy.exec(`
  CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO app_config (key, value) VALUES ('legacy-setting', '{"kept":true}');

  CREATE TABLE workflow_check_leases (
    attempt_id             TEXT    NOT NULL PRIMARY KEY,
    submission_id          TEXT    NOT NULL,
    node_id                TEXT    NOT NULL,
    repo_root              TEXT    NOT NULL,
    lease_path             TEXT    NOT NULL,
    holder_token           TEXT    NOT NULL,
    cleanup_state          TEXT    NOT NULL,
    supervisor_pid         INTEGER NOT NULL,
    supervisor_start_ticks TEXT    NOT NULL,
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL
  );
  INSERT INTO workflow_check_leases VALUES
    ('attempt-old', 'submission-old', 'node-old', '/repo', '/pool/1/repo',
     'mission-control-check-attempt-old', 'held', 0, '', 1, 1);
  PRAGMA user_version = 10;
`);
legacy.close();

const { closeDb, CURRENT_DATABASE_SCHEMA_VERSION, openDb } = await import("../src/server/db.ts");
const db = openDb();

test("a pre-native database gains empty operational tables without rewriting old rows", () => {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name IN ('worktree_pools', 'worktree_slots') ORDER BY name`,
    )
    .all() as unknown as Array<{ name: string }>;
  assert.deepEqual(tables.map((row) => row.name), ["worktree_pools", "worktree_slots"]);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM worktree_pools`).get() as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM worktree_slots`).get() as { n: number }).n, 0);
  assert.equal(
    (db.prepare(`SELECT value FROM app_config WHERE key = 'legacy-setting'`).get() as { value: string }).value,
    '{"kept":true}',
  );
  assert.equal(
    (db.prepare(`SELECT provider FROM workflow_check_leases WHERE attempt_id = 'attempt-old'`).get() as {
      provider: string;
    }).provider,
    "treehouse",
  );
  assert.equal(
    (db.prepare(`SELECT lease_id FROM workflow_check_leases WHERE attempt_id = 'attempt-old'`).get() as {
      lease_id: string | null;
    }).lease_id,
    null,
    "a historical Treehouse row gains no invented native lease identity",
  );
});

test("a database stamped 10 takes its recovery point, gains slot history, and is stamped 11", () => {
  assert.equal(CURRENT_DATABASE_SCHEMA_VERSION, 11);
  const backups = join(home, "backups", "database");
  const recoveryPoints = () => readdirSync(backups).filter((name) => name.startsWith("pre-migration-"));
  assert.ok(existsSync(backups), "the open captured a recovery point before it upgraded");
  assert.equal(recoveryPoints().length, 1);

  const schema = (connection: DatabaseSync) => ({
    version: (connection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    objects: (connection
      .prepare(
        `SELECT name FROM sqlite_master WHERE tbl_name = 'worktree_slot_history'
         AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>).map((row) => row.name),
    columns: (connection.prepare("PRAGMA table_info(worktree_slot_history)").all() as Array<{ name: string }>)
      .map((row) => row.name),
    poolIndex: (connection.prepare("PRAGMA index_info(idx_worktree_slot_history_pool_at)").all() as Array<{ name: string }>)
      .map((row) => row.name),
  });
  const expected = {
    version: 11,
    objects: ["idx_worktree_slot_history_pool_at", "idx_worktree_slot_history_slot", "worktree_slot_history"],
    columns: [
      "id", "pool_id", "slot_id", "ordinal", "at", "kind", "from_state", "to_state", "reason", "detail",
      "operation", "outcome", "actor", "duration_ms", "meta",
    ],
    poolIndex: ["pool_id", "at"],
  };
  assert.deepEqual(schema(db), expected);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM worktree_slot_history").get() as { n: number }).n,
    0,
    "history starts when this ships: nothing is invented for what came before",
  );

  const kept = db.prepare(
    `INSERT INTO worktree_slot_history (pool_id, slot_id, ordinal, at, kind) VALUES ('p', 's', 1, 1, 'transition')`,
  ).run();
  closeDb();
  const reopened = openDb();
  try {
    assert.deepEqual(schema(reopened), expected);
    assert.equal(recoveryPoints().length, 1, "opening it again takes no second recovery point");
    assert.equal(
      (reopened.prepare("SELECT COUNT(*) AS n FROM worktree_slot_history WHERE id = ?").get(kept.lastInsertRowid) as { n: number }).n,
      1,
      "and keeps what the table holds",
    );
  } finally {
    reopened.prepare("DELETE FROM worktree_slot_history").run();
  }
});
