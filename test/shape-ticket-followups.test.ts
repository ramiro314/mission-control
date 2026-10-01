import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-shape-ticket-followups-"));
const migrationHome = mkdtempSync(join(tmpdir(), "mission-shape-ticket-followups-migration-"));
process.env.HARNESS_HOME = home;

const { reserveShapeTicketFollowup, shapeTicketFollowupForTask } = await import("../src/server/db.ts");

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(migrationHome, { recursive: true, force: true });
});

const source = {
  sourceTaskId: "shape-1",
  sourceEpisodeId: "merged-episode",
  sourceSessionId: "shape-session",
  sourcePrUrl: "https://github.com/acme/demo/pull/7",
};

test("a shape task can take another tickets follow-up, and a follow-up id is recorded once", () => {
  const first = reserveShapeTicketFollowup({ ...source, followupTaskId: "followup-a", now: 100 });
  assert.equal(first.created, true);
  assert.deepEqual(first.relation, {
    ...source, followupTaskId: "followup-a", createdAt: 100, updatedAt: 100,
  });

  // A retry after a cancelled or failed follow-up is a second row for the same source.
  const retry = reserveShapeTicketFollowup({ ...source, followupTaskId: "followup-b", now: 200 });
  assert.equal(retry.created, true);
  assert.equal(shapeTicketFollowupForTask("followup-b")?.sourceTaskId, "shape-1");
  assert.equal(shapeTicketFollowupForTask("followup-a")?.sourceTaskId, "shape-1", "the first is kept");

  // Replaying a follow-up id - even against another source - keeps the row it already has.
  const replay = reserveShapeTicketFollowup({
    ...source, sourceTaskId: "shape-2", followupTaskId: "followup-a", now: 300,
  });
  assert.equal(replay.created, false);
  assert.deepEqual(replay.relation, first.relation);
  assert.deepEqual(shapeTicketFollowupForTask("followup-a"), first.relation);
  assert.equal(shapeTicketFollowupForTask("shape-1"), null, "the source is not a follow-up");
});

function run(script: string): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, SHAPE_TICKETS_MIGRATION_HOME: migrationHome },
      encoding: "utf8",
    },
  ).trim();
}

test("opening a pre-feature database adds the tickets follow-up relation idempotently", () => {
  run(`
    process.env.HARNESS_HOME = process.env.SHAPE_TICKETS_MIGRATION_HOME;
    const { openDb } = await import("./src/server/db.ts");
    const db = openDb();
    db.exec("DROP TABLE shape_ticket_followups");
    db.close();
  `);

  const inspect = `
    process.env.HARNESS_HOME = process.env.SHAPE_TICKETS_MIGRATION_HOME;
    const { openDb, reserveShapeTicketFollowup } = await import("./src/server/db.ts");
    const db = openDb();
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shape_ticket_followups'"
    ).get();
    reserveShapeTicketFollowup({
      followupTaskId: "f-" + Math.random(), sourceTaskId: "s", sourceEpisodeId: "e",
      sourceSessionId: "x", sourcePrUrl: "https://github.com/acme/demo/pull/1", now: 1,
    });
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM shape_ticket_followups").get();
    process.stdout.write((table?.name ?? "missing") + ":" + n);
    db.close();
  `;
  assert.equal(run(inspect), "shape_ticket_followups:1");
  assert.equal(run(inspect), "shape_ticket_followups:2", "a second open keeps the table and its rows");
});
