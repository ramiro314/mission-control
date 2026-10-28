import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// Seed a database whose slot table predates `quarantined_at`, holding slot 5 from the audit
// (quarantined by a stale index.lock) and an available slot, before db.ts opens it.
const home = process.env.HARNESS_HOME;
assert.ok(home, "test/setup-state.mjs must provide an isolated HARNESS_HOME");
mkdirSync(home, { recursive: true });
const legacy = new DatabaseSync(join(home, "harness.db"));
legacy.exec(`
  CREATE TABLE worktree_slots (
    id                        TEXT    NOT NULL PRIMARY KEY,
    pool_id                   TEXT    NOT NULL,
    ordinal                   INTEGER NOT NULL,
    path                      TEXT    NOT NULL,
    state                     TEXT    NOT NULL,
    version                   INTEGER NOT NULL,
    requested_head_sha        TEXT,
    current_head_sha          TEXT,
    active_lease_id           TEXT,
    active_owner_kind         TEXT,
    active_owner_key          TEXT,
    leased_at                 INTEGER,
    last_released_lease_id    TEXT,
    last_released_owner_kind  TEXT,
    last_released_owner_key   TEXT,
    last_used_at              INTEGER,
    quarantine_reason         TEXT,
    last_error                TEXT,
    created_at                INTEGER NOT NULL,
    updated_at                INTEGER NOT NULL
  );
  INSERT INTO worktree_slots (id, pool_id, ordinal, path, state, version, quarantine_reason, last_error, created_at, updated_at)
    VALUES ('slot-5', 'pool-old', 5, '/pool/5/repo', 'quarantined', 9, 'return reset failed',
      'git checkout failed: fatal: Unable to create ''/repo/.git/worktrees/repo4/index.lock'': File exists.', 1, 1);
  INSERT INTO worktree_slots (id, pool_id, ordinal, path, state, version, created_at, updated_at)
    VALUES ('slot-1', 'pool-old', 1, '/pool/1/repo', 'available', 3, 1, 1);
`);
legacy.close();

const { closeDb, openDb } = await import("../src/server/db.ts");
const { WorktreeStore } = await import("../src/server/worktrees/store.ts");
const { quarantinedSlotProblems } = await import("../src/server/worktrees/storage-problems.ts");

function problemIds(): string[] {
  return quarantinedSlotProblems(new WorktreeStore(openDb()).slots()).map((problem) => problem.id);
}

test("an existing quarantined slot is stamped once, so its problem id survives a restart", () => {
  const before = Date.now();
  const store = new WorktreeStore(openDb());
  const quarantined = store.slot("slot-5")!;
  assert.ok(quarantined.quarantinedAt !== null, "stamped by the first open that found it");
  assert.ok(quarantined.quarantinedAt >= before && quarantined.quarantinedAt <= Date.now());
  assert.equal(store.slot("slot-1")?.quarantinedAt, null, "only a quarantined row is stamped");
  assert.equal(quarantined.version, 9, "the stamp is not a slot transition");
  const ids = problemIds();
  assert.deepEqual(ids, [`quarantined-slot:slot-5:${quarantined.quarantinedAt}`]);

  // A restart runs the migration again; the stamp, and so the id, stays where it was.
  closeDb();
  assert.deepEqual(problemIds(), ids);
  closeDb();
  assert.deepEqual(problemIds(), ids);
});
