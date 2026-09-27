import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { Task } from "../src/shared/types.ts";
import type { TaskSourceRef } from "../src/shared/task-source.ts";
// Pure and browser-safe, so a static import cannot open the DB ahead of the home below.
import { TaskSourcesConfigSchema } from "../src/shared/task-source.ts";

// MCP `push_task` as the shape session calls it: `POST /mcp/push-task`, through the real
// chain - route -> pushTask -> the registry -> the github-issues implementation -> a FAKE
// `gh` on disk (`MISSION_GH_BIN`) - so the argv a ticket's issue is created with is the real
// one. What is at stake is what a mirror promises: each issue is blocked by the issues of the
// tickets that block it and filed under the shape task's issue; the ledger row and the link
// land together; a retry never files a second issue; and a session publishes only the
// tickets it filed.

const home = mkdtempSync(join(tmpdir(), "mission-mcp-push-task-home-"));
const repos = mkdtempSync(join(tmpdir(), "mission-mcp-push-task-repos-"));
process.env.HARNESS_HOME = home;
process.env.HARNESS_WORKSPACE_DIRS = repos;
process.env.HARNESS_REPOS_CACHE_MS = "0";

const { ensureToken } = await import("../src/server/auth.ts");
const { openDb, countTaskSourceSeen, getTask } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { setTaskSourcesConfig } = await import("../src/server/task-sources/config.ts");

const repo = join(repos, "demo");
mkdirSync(repo, { recursive: true });
execFileSync("git", ["-C", repo, "init", "-q"]);
const root = realpathSync(repo);
const bin = mkdtempSync(join(tmpdir(), "mission-mcp-push-task-bin-"));
const record = join(bin, "gh-calls.jsonl");
const counter = join(bin, "gh-counter");

after(() => {
  for (const dir of [home, repos, bin]) rmSync(dir, { recursive: true, force: true });
});

/**
 * A `gh issue create` that numbers its issues from 21 and records every argv as one JSON
 * line. `refused` is the retry-safe failure: a non-zero exit with no URL.
 */
function fakeGh(mode: "created" | "refused"): string {
  const path = join(bin, `gh-${mode}`);
  writeFileSync(path, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.MC_GH_RECORD, JSON.stringify(process.argv.slice(2)) + "\\n");
if (${JSON.stringify(mode)} === "refused") {
  process.stderr.write("could not create issue: HTTP 502\\n");
  process.exit(1);
}
let n = 20;
try { n = Number(fs.readFileSync(process.env.MC_GH_COUNTER, "utf8")); } catch {}
n += 1;
fs.writeFileSync(process.env.MC_GH_COUNTER, String(n));
process.stdout.write("https://github.com/acme/demo/issues/" + n + "\\n");
`);
  chmodSync(path, 0o755);
  return path;
}
const GH = { created: fakeGh("created"), refused: fakeGh("refused") };

const ghCalls = (): string[][] =>
  existsSync(record)
    ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
    : [];

const GITHUB = { id: "src-gh", kind: "github-issues", label: "demo issues", config: {} };
const JIRA = { id: "src-jira", kind: "jira", label: "demo jira", config: {} };

function configure(...sources: Array<Record<string, unknown>>): void {
  setTaskSourcesConfig(
    TaskSourcesConfigSchema.parse({ sources: sources.map((s) => ({ repoRoot: root, ...s })) }),
  );
}

const issue = (n: number): TaskSourceRef => ({
  sourceId: "src-gh",
  externalId: `acme/demo#${n}`,
  url: `https://github.com/acme/demo/issues/${n}`,
});

function taskEdge(taskId: string, sessionId: string | null): Task["dependencies"][number] {
  return {
    type: "task", taskId, title: taskId, sessionId, episodeId: null, agentSessionId: null,
    branch: null, prUrl: null, selectedAt: 1, satisfiedAt: null,
  };
}

/**
 * A live shape session whose task came from issue #1, and three tickets it filed: 1 with no
 * blocker, 2 blocked by 1, and 3 blocked by 2. Every ticket is gated on the shape session,
 * exactly as `create_task` with `dependsOnCurrentSession` stores it: a task edge on the
 * shape task that carries the session id. Plus one backlog task this session never touched.
 */
function setup() {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.applyDiscovery([{
    syntheticId: "shape-session",
    agent: "claude",
    name: "shape archive exports",
    nameSource: "process",
    cwd: root,
    gitBranch: "shape/archive-exports",
    gitRoot: root,
    repoRoot: root,
    pid: 101,
    tty: null,
    terminals: [],
    startedAt: Date.now(),
  }]);
  registry.applyHook({
    agent: "claude", event: "Stop", sessionId: "shape-agent-session", cwd: root, transcriptPath: null, env: {},
  });
  const session = registry.snapshot().sessions.find((s) => s.name === "shape archive exports")!;
  const shape = mkTask({ id: "shape", kind: "shape", status: "running", repoRoot: root, sessionId: session.id, source: issue(1) });
  const ticket = (n: number, blockers: string[]) => mkTask({
    id: `ticket-${n}`,
    title: `Ticket ${n}`,
    intent: `**What to build:** ticket ${n}.`,
    status: "backlog",
    repoRoot: root,
    dependencies: [...blockers.map((id) => taskEdge(id, null)), taskEdge("shape", session.id)],
  });
  for (const t of [
    shape,
    ticket(1, []),
    ticket(2, ["ticket-1"]),
    ticket(3, ["ticket-2"]),
    mkTask({ id: "someone-else", title: "Not this session's", status: "backlog", repoRoot: root }),
  ]) registry.upsertTask(t);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const post = (path: string, body: Record<string, unknown>) => app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({ env: {}, sessionId: "shape-agent-session", cwd: root, ...body }),
  });
  return {
    pushTask: (taskId: string, sourceId?: string) => post("/mcp/push-task", { taskId, ...(sourceId ? { sourceId } : {}) }),
    backlog: () => post("/mcp/backlog", { repoRoot: root }),
  };
}

beforeEach(() => {
  openDb().exec("DELETE FROM tasks; DELETE FROM task_source_seen; DELETE FROM app_config;");
  rmSync(record, { force: true });
  rmSync(counter, { force: true });
  process.env.MISSION_GH_BIN = GH.created;
  process.env.MC_GH_RECORD = record;
  process.env.MC_GH_COUNTER = counter;
});

test("each ticket is created blocked by its pushed blockers and under the shape task's issue", async () => {
  configure(GITHUB);
  const { pushTask } = setup();

  const first = await pushTask("ticket-1");
  assert.equal(first.status, 200, await first.clone().text());
  assert.deepEqual(await first.json().then((b: { source: TaskSourceRef; alreadyPushed: boolean }) =>
    [b.source, b.alreadyPushed]), [issue(21), false]);
  const second = await pushTask("ticket-2", "src-gh");
  assert.equal(second.status, 200);
  const body = await second.json() as { source: TaskSourceRef; blockedBy: TaskSourceRef[]; parent: TaskSourceRef };
  assert.deepEqual(body.source, issue(22));
  assert.deepEqual(body.blockedBy, [issue(21)]);
  assert.deepEqual(body.parent, issue(1));

  const [argv1, argv2] = ghCalls();
  // Ticket 1 has no blockers, so no `--blocked-by`; both land under the shape task's issue.
  assert.ok(!argv1!.includes("--blocked-by"));
  assert.deepEqual(argv1!.slice(argv1!.indexOf("--parent")), ["--parent", issue(1).url]);
  assert.deepEqual(argv2!.slice(argv2!.indexOf("--blocked-by")), [
    "--blocked-by", issue(21).url, "--parent", issue(1).url,
  ]);

  // The link and the ledger row, together: a sweep never re-files either issue.
  assert.deepEqual(getTask("ticket-1")!.source, issue(21));
  assert.deepEqual(getTask("ticket-2")!.source, issue(22));
  assert.equal(countTaskSourceSeen("src-gh"), 2);
});

test("a retry of a pushed ticket is idempotent: its link comes back and gh is not run again", async () => {
  configure(GITHUB);
  const { pushTask } = setup();
  assert.equal((await pushTask("ticket-1")).status, 200);
  const again = await pushTask("ticket-1");
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json().then((b: { source: TaskSourceRef; alreadyPushed: boolean }) =>
    [b.source, b.alreadyPushed]), [issue(21), true]);
  assert.equal(ghCalls().length, 1, "a retry must never file a second issue");
  assert.equal(countTaskSourceSeen("src-gh"), 1);
});

test("a refused push keeps the task, links nothing, says a retry is safe, and the retry works", async () => {
  configure(GITHUB);
  const { pushTask } = setup();
  process.env.MISSION_GH_BIN = GH.refused;
  const failed = await pushTask("ticket-1");
  assert.equal(failed.status, 502);
  assert.equal((await failed.json() as { outcomeUnknown?: boolean }).outcomeUnknown, undefined);
  assert.equal(getTask("ticket-1")!.status, "backlog", "the Mission Control task is kept");
  assert.equal(getTask("ticket-1")!.source, null);
  assert.equal(countTaskSourceSeen("src-gh"), 0);

  process.env.MISSION_GH_BIN = GH.created;
  const retried = await pushTask("ticket-1");
  assert.equal(retried.status, 200);
  assert.deepEqual(getTask("ticket-1")!.source, issue(21));
});

test("a session may push only a task that waits on it", async () => {
  configure(GITHUB);
  const res = await setup().pushTask("someone-else");
  assert.equal(res.status, 403);
  assert.match((await res.json() as { error: string }).error, /only a task that waits on this session/);
  assert.equal(ghCalls().length, 0, "nothing was spawned");
});

test("a source that cannot push is never offered, and never pushed to", async () => {
  configure(JIRA);
  const { pushTask, backlog } = setup();
  const omitted = await pushTask("ticket-1");
  assert.equal(omitted.status, 409);
  assert.match((await omitted.json() as { error: string }).error, /no configured task source can receive this task/);
  const named = await pushTask("ticket-1", "src-jira");
  assert.equal(named.status, 400);
  assert.equal(ghCalls().length, 0);

  const { mirror } = await (await backlog()).json() as { mirror: { sources: unknown[]; unavailable: string | null } };
  assert.deepEqual(mirror.sources, []);
  assert.equal(mirror.unavailable, "This repository's task sources (demo jira) cannot receive pushed tasks.");
});

test("with two sources that can receive the task, an omitted sourceId is refused, naming both", async () => {
  configure(GITHUB, { ...GITHUB, id: "src-gh-2", label: "second issues" });
  const { pushTask } = setup();
  const res = await pushTask("ticket-1");
  assert.equal(res.status, 409);
  assert.equal(
    (await res.json() as { error: string }).error,
    "more than one task source can receive this task; name one as sourceId (src-gh, src-gh-2)",
  );
  assert.equal(ghCalls().length, 0, "neither source was picked for it");
  assert.equal(getTask("ticket-1")!.source, null);

  // Naming one resolves it, and files into that source only.
  const named = await pushTask("ticket-1", "src-gh-2");
  assert.equal(named.status, 200);
  assert.equal(getTask("ticket-1")!.source?.sourceId, "src-gh-2");
  assert.equal(ghCalls().length, 1);
});

test("list_backlog_tasks reports the mirror choice from the registry", async () => {
  const { backlog } = setup();
  const none = await (await backlog()).json() as { mirror: { sources: unknown[]; unavailable: string | null } };
  assert.deepEqual(none.mirror, {
    sources: [],
    unavailable: "No task source is configured for this repository, so there is nowhere to mirror the tickets.",
  });

  configure(GITHUB, JIRA);
  const some = await (await backlog()).json() as { mirror: unknown };
  assert.deepEqual(some.mirror, {
    sources: [{ id: "src-gh", label: "demo issues", kind: "GitHub issues", relates: true }],
    unavailable: null,
  });
});
