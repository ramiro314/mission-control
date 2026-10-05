import { test } from "node:test";
import assert from "node:assert/strict";
import { clearStoredDefaultBaseBranches } from "../src/server/base-branch-backfill.ts";
import type { UpdateTask } from "../src/shared/protocol.ts";
import type { Task } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";

// Rows written before a base equal to origin's default was stored as null, or whose origin has
// since moved its default, still carry the name, and the backlog card labels them. The startup
// pass asks origin once per (repository, branch) and clears only the ones that are now the
// default, only on backlog tasks, and never on an uncertain answer.

function store(rows: Task[]) {
  const updates: Array<[string, UpdateTask]> = [];
  return {
    updates,
    list: () => rows,
    update: async (id: string, patch: UpdateTask) => {
      updates.push([id, patch]);
      const row = rows.find((t) => t.id === id)!;
      Object.assign(row, patch);
      return { ok: true };
    },
  };
}

test("a backlog base that origin now calls its default is cleared, and nothing else is touched", async () => {
  const rows = [
    mkTask({ id: "stale", status: "backlog", repoRoot: "/r", baseBranch: "main" }),
    mkTask({ id: "stale-twin", status: "backlog", repoRoot: "/r", baseBranch: "main" }),
    mkTask({ id: "real", status: "backlog", repoRoot: "/r", baseBranch: "release/windows" }),
    mkTask({ id: "gone", status: "backlog", repoRoot: "/r", baseBranch: "release/gone" }),
    mkTask({ id: "offline", status: "backlog", repoRoot: "/offline", baseBranch: "main" }),
    mkTask({ id: "running", status: "running", repoRoot: "/r", baseBranch: "main" }),
    mkTask({ id: "plain", status: "backlog", repoRoot: "/r", baseBranch: null }),
  ];
  const asked: string[] = [];
  const tasks = store(rows);
  const cleared = await clearStoredDefaultBaseBranches(tasks, async (repoRoot, branch) => {
    asked.push(`${repoRoot} ${branch}`);
    if (repoRoot === "/offline") throw new Error("network down");
    if (branch === "release/gone") return { ok: false, error: "does not exist" };
    return { ok: true, baseBranch: branch === "main" ? null : branch };
  });

  assert.deepEqual(cleared, ["stale", "stale-twin"]);
  assert.deepEqual(tasks.updates, [["stale", { baseBranch: null }], ["stale-twin", { baseBranch: null }]]);
  assert.equal(rows.find((t) => t.id === "real")?.baseBranch, "release/windows");
  assert.equal(rows.find((t) => t.id === "gone")?.baseBranch, "release/gone", "a refusal is not a default");
  assert.equal(rows.find((t) => t.id === "offline")?.baseBranch, "main", "an unreachable origin changes nothing");
  assert.equal(rows.find((t) => t.id === "running")?.baseBranch, "main", "only backlog tasks are rewritten");
  assert.deepEqual(
    asked.sort(),
    ["/offline main", "/r main", "/r release/gone", "/r release/windows"],
    "origin is asked once per repository and branch",
  );
});

test("a row edited while origin answered is left to the edit", async () => {
  const rows = [mkTask({ id: "t", status: "backlog", repoRoot: "/r", baseBranch: "main" })];
  const tasks = store(rows);
  const cleared = await clearStoredDefaultBaseBranches(tasks, async () => {
    rows[0]!.baseBranch = "release/windows";
    return { ok: true, baseBranch: null };
  });
  assert.deepEqual(cleared, []);
  assert.equal(rows[0]!.baseBranch, "release/windows");
});
