import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { MissionSchedule } from "../src/shared/schedules.ts";
// Pure and browser-safe, so a static import cannot open the DB ahead of the home below.
import { CreateScheduleSchema } from "../src/shared/protocol.ts";

// A recurring mission's task template can name a base branch. It is checked against the
// repository's real origin when the mission is saved, carried by every task a run files, and
// absent from every template saved before the field existed. The fixture repository has a
// bare origin carrying `main` and `release/windows`, and the default origin check runs for
// real against it, so a refusal here is git's answer and not a stub's.

const home = mkdtempSync(join(tmpdir(), "mission-schedule-base-home-"));
const repos = mkdtempSync(join(tmpdir(), "mission-schedule-base-repos-"));
process.env.HARNESS_HOME = home;
process.env.HARNESS_WORKSPACE_DIRS = repos;
process.env.HARNESS_REPOS_CACHE_MS = "0";

const { openDb, getTask, listTasks } = await import("../src/server/db.ts");
const store = await import("../src/server/schedules/store.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { ScheduleManager } = await import("../src/server/schedules/manager.ts");
const { buildApp } = await import("../src/server/routes.ts");

after(() => {
  for (const dir of [home, repos]) rmSync(dir, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]): void => {
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
};

function mkRepo(name: string): string {
  const repo = join(repos, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@test");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), "main\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "main");
  const origin = join(repos, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-qu", "origin", "main", "main:release/windows");
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  return realpathSync(repo);
}

const REPO = mkRepo("mission-repo");
const T0 = Date.parse("2026-10-05T08:00:00Z");
const NINE = Date.parse("2026-10-05T09:00:00Z");

openDb();
const registry = new Registry();
const tasks = new TaskManager(registry);
const clock = { now: T0 };
let uuidN = 0;
const manager = new ScheduleManager({
  tasks,
  now: () => clock.now,
  uuid: () => `base-${++uuidN}`,
  log: () => {},
});
const app = buildApp({
  registry,
  reviews: {} as ReviewManager,
  tasks,
  queues: {} as QueueManager,
  schedules: manager,
});

beforeEach(() => {
  clock.now = T0;
  for (const s of store.listSchedules()) store.archiveSchedule(s.id, T0 - 1);
  openDb().exec("DELETE FROM tasks");
});

function definition(template: Record<string, unknown> = {}, name = "Windows sync"): Record<string, unknown> {
  return {
    name,
    expression: "0 9 * * *",
    timezone: "UTC",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    template: {
      title: "Sync release/windows",
      intent: "Merge main into release/windows.",
      repoRoot: REPO,
      kind: "ship",
      agent: "claude",
      ...template,
    },
  };
}

async function post(path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function created(body: Record<string, unknown>): Promise<MissionSchedule> {
  const res = await post("/api/schedules", body);
  if (res.status !== 201) assert.fail(`create failed ${res.status}: ${await res.text()}`);
  return (await res.json()) as MissionSchedule;
}

test("the template schema takes a base branch, defaults it to none, and refuses a malformed one", () => {
  assert.equal(CreateScheduleSchema.parse(definition()).template.baseBranch, null);
  assert.equal(
    CreateScheduleSchema.parse(definition({ baseBranch: " release/windows " })).template.baseBranch,
    "release/windows",
  );
  for (const bad of ["-x", "refs/heads/main", "a..b", "has space", ""]) {
    assert.equal(CreateScheduleSchema.safeParse(definition({ baseBranch: bad })).success, false, bad);
  }
});

test("saving a mission checks its base branch against origin and refuses one origin lacks", async () => {
  const saved = await created(definition({ baseBranch: "release/windows" }));
  assert.equal(saved.template?.baseBranch, "release/windows");

  const missing = await post("/api/schedules", definition({ baseBranch: "release/nope" }, "Doomed"));
  assert.equal(missing.status, 400);
  const body = (await missing.json()) as { error: string; field: string };
  assert.equal(body.field, "baseBranch", "the editor puts the refusal under the Base branch field");
  assert.match(body.error, /base branch release\/nope does not exist on .*origin/);
  assert.equal(store.listSchedules().some((s) => s.name === "Doomed"), false, "nothing was stored");

  // An edit is a save too: the refusal leaves the active revision exactly as it was.
  const edit = await post(`/api/schedules/${saved.id}/update`, definition({ baseBranch: "release/nope" }));
  assert.equal(edit.status, 400);
  assert.equal(((await edit.json()) as { field: string }).field, "baseBranch");
  assert.equal(manager.get(saved.id)?.template?.baseBranch, "release/windows");

  const cleared = await post(`/api/schedules/${saved.id}/update`, definition({ baseBranch: null }));
  assert.equal(cleared.status, 200);
  assert.equal(manager.get(saved.id)?.template?.baseBranch, null);
});

test("preview leaves the origin question to save", async () => {
  // The detail view previews a SAVED mission every time it opens; a network check there
  // would put a since-deleted branch in the way of reading the cadence.
  const res = await post("/api/schedules/preview", definition({ baseBranch: "release/nope" }));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { ok: boolean }).ok, true);
});

test("every task a mission files carries the template's base branch, scheduled or Run now", async () => {
  const mission = await created(definition({ baseBranch: "release/windows" }));

  const run = await post(`/api/schedules/${mission.id}/run-now`, {});
  assert.equal(run.status, 200);
  const { occurrence } = (await run.json()) as { occurrence: { taskId: string } };
  assert.equal(getTask(occurrence.taskId)?.baseBranch, "release/windows", "Run now");
  // Out of the way, so `skip-active` lets the scheduled instant file its own task.
  openDb().exec("DELETE FROM tasks");

  clock.now = NINE + 5_000;
  const summary = await manager.tick();
  assert.equal(summary.created, 1);
  const scheduled = listTasks().filter((t) => t.scheduleId === mission.id);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]!.baseBranch, "release/windows", "scheduled instant");
});

test("a mission with no base branch files tasks on origin's default branch, as it always has", async () => {
  const mission = await created(definition());
  const run = await post(`/api/schedules/${mission.id}/run-now`, {});
  const { occurrence } = (await run.json()) as { occurrence: { taskId: string } };
  assert.equal(getTask(occurrence.taskId)?.baseBranch, null);

  // A template stored before the field existed has no key at all, and still reads and runs.
  const legacy = await created(definition({}, "Legacy"));
  const stored = JSON.parse(
    (openDb()
      .prepare("SELECT template_json FROM mission_schedule_revisions WHERE schedule_id = ?")
      .get(legacy.id) as { template_json: string }).template_json,
  ) as Record<string, unknown>;
  delete stored.baseBranch;
  openDb()
    .prepare("UPDATE mission_schedule_revisions SET template_json = ? WHERE schedule_id = ?")
    .run(JSON.stringify(stored), legacy.id);
  const reread = manager.get(legacy.id);
  assert.ok(reread?.template, "the legacy template still parses");
  assert.equal(reread.template.baseBranch, null);
  const legacyRun = await post(`/api/schedules/${legacy.id}/run-now`, {});
  assert.equal(legacyRun.status, 200);
});
