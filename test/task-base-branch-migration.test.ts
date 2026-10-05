import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The base-branch upgrade path: a `tasks` table from before the column (the same pre-feature
// shape `multi-repo-migration.test.ts` seeds), holding a real row, opened by db.ts on the path
// production takes. The row must still load, and load as a task on origin's default branch -
// which is what NULL means to every reader.

const home = mkdtempSync(join(tmpdir(), "mission-base-branch-migrate-"));
process.env.HARNESS_HOME = home;

function seedPreFeatureDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      intent        TEXT NOT NULL,
      kind          TEXT NOT NULL,
      agent         TEXT NOT NULL,
      priority      TEXT,
      labels        TEXT,
      dependencies  TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      model         TEXT,
      effort        TEXT,
      workflow_id   TEXT,
      source_id     TEXT,
      external_id   TEXT,
      source_url    TEXT,
      repo_root     TEXT NOT NULL,
      worktree_path TEXT,
      branch        TEXT,
      provider      TEXT,
      home_name     TEXT,
      terminal_resource_id TEXT,
      session_id    TEXT,
      schedule_id            TEXT,
      schedule_occurrence_id TEXT,
      scheduled_for          INTEGER,
      status        TEXT NOT NULL,
      outcome       TEXT,
      outcome_url   TEXT,
      error         TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      dispatched_at INTEGER,
      completed_at  INTEGER
    );
  `);
  raw
    .prepare(
      `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("before-base-branch", "Filed before base branches", "do the thing", "ship", "claude", "/repo", "backlog", 1, 1);
  raw.close();
}

seedPreFeatureDb();

const { openDb, getTask, upsertTask } = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("a database from before base branches opens, gains the column, and reads its rows as the default branch", () => {
  const columns = (
    openDb().prepare(`PRAGMA table_info(tasks)`).all() as unknown as Array<{ name: string }>
  ).map((c) => c.name);
  assert.ok(columns.includes("base_branch"));

  const existing = getTask("before-base-branch");
  assert.ok(existing, "the pre-feature row is still readable");
  assert.equal(existing.baseBranch, null);
});

test("a base branch written to an upgraded database reads back, and clears back to null", () => {
  const existing = getTask("before-base-branch")!;
  upsertTask({ ...existing, baseBranch: "release/windows" });
  assert.equal(getTask("before-base-branch")?.baseBranch, "release/windows");
  upsertTask({ ...existing, baseBranch: null });
  assert.equal(getTask("before-base-branch")?.baseBranch, null);
});
