import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

/**
 * Session History's search and filters: the segments the reconciler writes for conversations
 * and background runs, repository resolution at index time, the list route's filters and
 * facets, and the upgrade that gives rows cataloged before search their text.
 *
 * Every transcript is a fixture in a temp projects directory, and the Claude settings file is
 * a temp file; nothing reads the operator's `~/.claude`.
 */

const home = mkdtempSync(join(tmpdir(), "mission-history-search-"));
process.env.MISSION_HOME = home;
const settingsPath = join(home, "claude-settings.json");
process.env.CLAUDE_SETTINGS_PATH = settingsPath;

const { createClaudeHistory } = await import("../src/server/harness/claude/history.ts");
const { HistoryService } = await import("../src/server/history/service.ts");
const { resolveHistoryRepository } = await import("../src/server/history/repository.ts");
const { historyPromptSegments } = await import("../src/server/history/search.ts");
const { poolContainingPath } = await import("../src/server/worktrees/path.ts");
const { openDb, upgradeDatabaseToCurrentSchema } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
import type { HistoryPage } from "../src/shared/history.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";

const LOOPBACK = { host: "127.0.0.1:7317" };
const AGENT_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
let ordinal = 0;

function sessionId(): string {
  ordinal += 1;
  return `00000000-0000-4000-9000-${String(ordinal).padStart(12, "0")}`;
}

interface Shape {
  cwd: string;
  at: string;
  entrypoint?: string;
  /** A tool list for a `prompt_snapshot`, or none. */
  tools?: string[];
  prompts: string[];
  branch?: string;
  title?: string;
}

/** One session's records: an optional snapshot, then each prompt with an answer. */
function lines(id: string, shape: Shape): Record<string, unknown>[] {
  const base = {
    sessionId: id,
    cwd: shape.cwd,
    entrypoint: shape.entrypoint ?? "cli",
    version: "2.1.296",
    gitBranch: shape.branch ?? "HEAD",
    timestamp: shape.at,
    isSidechain: false,
  };
  const out: Record<string, unknown>[] = [];
  if (shape.tools) {
    out.push({ ...base, type: "attachment", attachment: { type: "prompt_snapshot", cliPrefix: AGENT_PREFIX, tools: shape.tools.map((name) => ({ name })) } });
  }
  for (const prompt of shape.prompts) {
    out.push({ ...base, type: "user", message: { role: "user", content: prompt } });
    out.push({ ...base, type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }] } });
  }
  if (shape.title) out.push({ sessionId: id, type: "ai-title", aiTitle: shape.title });
  return out;
}

function write(projects: string, id: string, records: Record<string, unknown>[], at: string): string {
  const dir = join(projects, "-fixture");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, `${records.map((line) => JSON.stringify(line)).join("\n")}\n`);
  utimesSync(path, new Date(at), new Date(at));
  return path;
}

function reset(): void {
  openDb().exec("DELETE FROM history_sessions; DELETE FROM history_search_segments; DELETE FROM worktree_pools;");
}

function app(history: InstanceType<typeof HistoryService>) {
  return buildApp({ registry: new Registry(), reviews: {} as ReviewManager, tasks: {} as TaskManager, queues: {} as QueueManager, history });
}

async function ids(server: ReturnType<typeof app>, query: string): Promise<string[]> {
  const response = await server.request(`/api/history/sessions${query ? `?${query}` : ""}`, { headers: LOOPBACK });
  assert.equal(response.status, 200, `GET ?${query}`);
  return ((await response.json()) as HistoryPage).sessions.map((row) => row.agentSessionId);
}

function segmentCount(id: string): number {
  return Number((openDb().prepare(
    "SELECT COUNT(*) AS n FROM history_search_segments WHERE agent = 'claude' AND agent_session_id = ?",
  ).get(id) as { n: number }).n);
}

test("a conversation is found by any of its user prompts; a background run only by its first", async () => {
  reset();
  const projects = mkdtempSync(join(tmpdir(), "mission-history-search-projects-"));
  const conversation = sessionId();
  write(projects, conversation, lines(conversation, {
    cwd: "/w/app", at: "2026-10-20T10:00:00.000Z",
    prompts: ["Fix the login retry", "Now also handle the Ünïcode username", "And the third prompt mentions zebras"],
  }), "2026-10-20T10:00:00.000Z");
  const oneShot = sessionId();
  write(projects, oneShot, lines(oneShot, {
    cwd: "/w/app", at: "2026-10-20T11:00:00.000Z", entrypoint: "sdk-ts", tools: [],
    prompts: ["Generate a commit message for this diff", "A follow-up that mentions zebras too"],
  }), "2026-10-20T11:00:00.000Z");
  const reviewer = sessionId();
  write(projects, reviewer, lines(reviewer, {
    cwd: "/w/app", at: "2026-10-20T12:00:00.000Z", entrypoint: "sdk-ts", tools: ["Read", "StructuredOutput"],
    prompts: ["Review this pull request carefully", "A reviewer follow-up about zebras"],
  }), "2026-10-20T12:00:00.000Z");
  const history = new HistoryService({ readers: [{ agent: "claude", spec: createClaudeHistory(projects) }], resolveRepository: () => null });
  await history.reconciler.trigger();
  const server = app(history);

  assert.deepEqual(await ids(server, "q=zebras&kind=all"), [conversation], "a later prompt finds the conversation, never a background run");
  assert.deepEqual(await ids(server, "q=%C3%BCn%C3%AFCODE&kind=all"), [conversation], "matching folds case beyond ASCII");
  assert.deepEqual(await ids(server, "q=login%20retry"), [conversation]);
  assert.deepEqual(await ids(server, "q=commit%20message"), [], "the default list hides a background run even when it matches");
  assert.deepEqual(await ids(server, "q=commit%20message&kind=all"), [oneShot], "a background run's first prompt is searchable");
  assert.deepEqual(await ids(server, "q=review%20this&kind=reviewer"), [reviewer]);
  assert.equal(segmentCount(oneShot), 1, "a background run keeps only its fields segment");
  assert.equal(segmentCount(conversation), 4, "fields plus one segment per prompt");
  rmSync(projects, { recursive: true, force: true });
});

test("search also matches titles, paths and branches", async () => {
  reset();
  const projects = mkdtempSync(join(tmpdir(), "mission-history-search-projects-"));
  const id = sessionId();
  write(projects, id, lines(id, {
    cwd: "/srv/checkouts/orchard", at: "2026-10-21T10:00:00.000Z", branch: "feature/pear-picker",
    title: "Tune the harvest scheduler", prompts: ["hello"],
  }), "2026-10-21T10:00:00.000Z");
  const other = sessionId();
  write(projects, other, lines(other, { cwd: "/elsewhere", at: "2026-10-21T09:00:00.000Z", prompts: ["unrelated"] }), "2026-10-21T09:00:00.000Z");
  const history = new HistoryService({ readers: [{ agent: "claude", spec: createClaudeHistory(projects) }], resolveRepository: () => "/srv/repos/fruit" });
  await history.reconciler.trigger();
  const server = app(history);
  assert.deepEqual(await ids(server, "q=harvest%20SCHEDULER"), [id], "AI title");
  assert.deepEqual(await ids(server, "q=checkouts%2Forchard"), [id], "cwd");
  assert.deepEqual(await ids(server, "q=pear-picker"), [id], "branch");
  assert.deepEqual(await ids(server, "q=repos%2Ffruit"), [id, other], "repository");
  assert.deepEqual(await ids(server, "q=%20%20"), [id, other], "a blank query asks for nothing");
  rmSync(projects, { recursive: true, force: true });
});

test("an appended prompt is indexed once; a rewritten file replaces its prompts", async () => {
  reset();
  const projects = mkdtempSync(join(tmpdir(), "mission-history-search-projects-"));
  const id = sessionId();
  const shape: Shape = { cwd: "/w", at: "2026-10-22T10:00:00.000Z", prompts: ["first words"] };
  const path = write(projects, id, lines(id, shape), "2026-10-22T10:00:00.000Z");
  const history = new HistoryService({ readers: [{ agent: "claude", spec: createClaudeHistory(projects) }], resolveRepository: () => null });
  await history.reconciler.trigger();
  const server = app(history);
  assert.equal(segmentCount(id), 2);

  // A half-written last line is folded into the summary but not counted as parsed, so its
  // prompt must not be indexed until the line is complete - or it would be indexed twice.
  appendFileSync(path, JSON.stringify({ ...lines(id, { ...shape, prompts: ["appended aardvark"] })[0] }));
  utimesSync(path, new Date("2026-10-22T10:01:00.000Z"), new Date("2026-10-22T10:01:00.000Z"));
  await history.reconciler.trigger();
  assert.equal(segmentCount(id), 2, "a partial line indexes nothing yet");
  appendFileSync(path, "\n");
  utimesSync(path, new Date("2026-10-22T10:02:00.000Z"), new Date("2026-10-22T10:02:00.000Z"));
  await history.reconciler.trigger();
  assert.equal(segmentCount(id), 3, "the completed line's prompt is indexed exactly once");
  assert.deepEqual(await ids(server, "q=aardvark"), [id]);
  assert.deepEqual(await ids(server, "q=first%20words"), [id]);

  // A shrunk file is read from the top, and its prompts replace the old ones.
  truncateSync(path, 0);
  writeFileSync(path, `${lines(id, { ...shape, prompts: ["only this now"] }).map((line) => JSON.stringify(line)).join("\n")}\n`);
  utimesSync(path, new Date("2026-10-22T10:03:00.000Z"), new Date("2026-10-22T10:03:00.000Z"));
  await history.reconciler.trigger();
  assert.deepEqual(await ids(server, "q=aardvark"), []);
  assert.deepEqual(await ids(server, "q=only%20this"), [id]);
  rmSync(projects, { recursive: true, force: true });
});

test("a run that turns out to be a conversation is re-read from the top for its earlier prompts", async () => {
  reset();
  const projects = mkdtempSync(join(tmpdir(), "mission-history-search-projects-"));
  const id = sessionId();
  // The first records carry no entrypoint, so the snapshot's empty tool list makes it a
  // one-shot. The appended records are the first to name one (`cli`), which makes it
  // interactive.
  const head = lines(id, { cwd: "/w", at: "2026-10-23T10:00:00.000Z", tools: [], prompts: ["an early prompt about walruses"] })
    .map(({ entrypoint: _drop, ...record }) => record);
  const path = write(projects, id, head, "2026-10-23T10:00:00.000Z");
  const history = new HistoryService({ readers: [{ agent: "claude", spec: createClaudeHistory(projects) }], resolveRepository: () => null });
  await history.reconciler.trigger();
  const server = app(history);
  assert.deepEqual(await ids(server, "kind=one_shot"), [id]);

  appendFileSync(path, `${lines(id, { cwd: "/w", at: "2026-10-23T10:05:00.000Z", prompts: ["a later prompt about otters"] }).map((line) => JSON.stringify(line)).join("\n")}\n`);
  utimesSync(path, new Date("2026-10-23T10:05:00.000Z"), new Date("2026-10-23T10:05:00.000Z"));
  await history.reconciler.trigger();
  assert.deepEqual(await ids(server, "kind=interactive"), [id]);
  assert.deepEqual(await ids(server, "q=walruses"), [id], "the prompt read while it was a one-shot is indexed now");
  assert.deepEqual(await ids(server, "q=otters"), [id]);
  rmSync(projects, { recursive: true, force: true });
});

test("repository, date range, kind and agent filters work together; facets list repositories and agents", async () => {
  reset();
  const db = openDb();
  db.prepare(
    `INSERT INTO worktree_pools (id, git_common_dir, main_checkout_root, pool_path, created_at, updated_at)
     VALUES ('pool-a', '/code/app/.git', '/code/app', '/state/worktree-pools/app-1f2e', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO worktree_pools (id, git_common_dir, main_checkout_root, pool_path, created_at, updated_at)
     VALUES ('pool-b', '/code/app2/.git', '/code/app2', '/state/worktree-pools/app-1f2e3d', 0, 0)`,
  ).run();
  const projects = mkdtempSync(join(tmpdir(), "mission-history-search-projects-"));
  const write2 = (shape: Shape): string => {
    const id = sessionId();
    write(projects, id, lines(id, shape), shape.at);
    return id;
  };
  // Two slots of one pool, neither of which exists on disk: they still collapse to the repo.
  const slotOld = write2({ cwd: "/state/worktree-pools/app-1f2e/1/app", at: "2026-10-01T10:00:00.000Z", prompts: ["old slot work"] });
  const slotNew = write2({ cwd: "/state/worktree-pools/app-1f2e/7/app/src", at: "2026-10-15T10:00:00.000Z", prompts: ["new slot work"] });
  const sibling = write2({ cwd: "/state/worktree-pools/app-1f2e3d/2/app2", at: "2026-10-15T11:00:00.000Z", prompts: ["sibling pool"] });
  const run = write2({ cwd: "/state/worktree-pools/app-1f2e/3/app", at: "2026-10-15T12:00:00.000Z", entrypoint: "sdk-ts", tools: ["Read"], prompts: ["slot review"] });
  const loose = write2({ cwd: "/nowhere/at/all", at: "2026-10-16T10:00:00.000Z", prompts: ["loose"] });
  const history = new HistoryService({ readers: [{ agent: "claude", spec: createClaudeHistory(projects) }] });
  await history.reconciler.trigger();
  const server = app(history);

  const page = await (await server.request("/api/history/sessions", { headers: LOOPBACK })).json() as HistoryPage;
  assert.deepEqual(page.facets.repositories, ["/code/app", "/code/app2"], "pool slots collapse to their repository; an unknown path has none");
  assert.deepEqual(page.facets.agents, ["claude"], "one reader, so the page hides the agent filter");
  assert.equal(page.sessions.find((row) => row.agentSessionId === slotNew)?.repoRoot, "/code/app");
  assert.equal(page.sessions.find((row) => row.agentSessionId === loose)?.repoRoot, null);

  const repo = `repo=${encodeURIComponent("/code/app")}`;
  assert.deepEqual(await ids(server, repo), [slotNew, slotOld]);
  assert.deepEqual(await ids(server, `${repo}&kind=all`), [run, slotNew, slotOld], "Kind adds background runs to the conversations");
  assert.deepEqual(await ids(server, `${repo}&kind=reviewer`), [run]);
  const from = Date.parse("2026-10-10T00:00:00.000Z");
  const to = Date.parse("2026-10-16T00:00:00.000Z");
  assert.deepEqual(await ids(server, `${repo}&kind=all&from=${from}&to=${to}`), [run, slotNew], "from is inclusive");
  assert.deepEqual(await ids(server, `from=${from}&to=${to}`), [sibling, slotNew], "to is exclusive");
  assert.deepEqual(await ids(server, `${repo}&from=${from}&q=slot`), [slotNew]);
  assert.deepEqual(await ids(server, "agent=claude&repo=%2Fcode%2Fapp2"), [sibling]);
  assert.deepEqual(await ids(server, "agent=codex"), []);

  for (const bad of ["kind=everything", "agent=gpt", "from=-1", "to=soon", `q=${"x".repeat(201)}`, "repo=", "colour=red"]) {
    assert.equal((await server.request(`/api/history/sessions?${bad}`, { headers: LOOPBACK })).status, 400, bad);
  }
  rmSync(projects, { recursive: true, force: true });
});

test("the retention header reads cleanupPeriodDays from Claude's settings, 30 when unset", async () => {
  reset();
  const projects = mkdtempSync(join(tmpdir(), "mission-history-search-projects-"));
  const history = new HistoryService({ readers: [{ agent: "claude", spec: createClaudeHistory(projects) }], resolveRepository: () => null });
  const server = app(history);
  const retention = async () => ((await (await server.request("/api/history/sessions", { headers: LOOPBACK })).json()) as HistoryPage).facets.retention;
  rmSync(settingsPath, { force: true });
  const url = "https://code.claude.com/docs/en/settings-reference#cleanupperioddays";
  assert.deepEqual(await retention(), [{ agent: "claude", days: 30, configured: false, setting: "cleanupPeriodDays", settingUrl: url }]);
  writeFileSync(settingsPath, '{\n  // JSONC, as Claude Code allows\n  "cleanupPeriodDays": 90,\n}\n');
  assert.deepEqual(await retention(), [{ agent: "claude", days: 90, configured: true, setting: "cleanupPeriodDays", settingUrl: url }]);
  writeFileSync(settingsPath, '{"cleanupPeriodDays": 0}');
  assert.equal((await retention())[0]?.days, 30, "a value Claude Code refuses reads as its default");
  rmSync(settingsPath, { force: true });
  rmSync(projects, { recursive: true, force: true });
});

test("repository resolution: a deleted pool slot, a task worktree, a real checkout, an unknown path", () => {
  const pools = [
    { poolPath: "/state/worktree-pools/app-1f2e", mainCheckoutRoot: "/code/app" },
    { poolPath: "/state/worktree-pools/app-1f2e3d", mainCheckoutRoot: "/code/app2" },
  ];
  assert.equal(poolContainingPath(pools, "/state/worktree-pools/app-1f2e3d/1/app2")?.mainCheckoutRoot, "/code/app2", "a sibling with a longer digest is not the shorter pool");
  assert.equal(poolContainingPath(pools, "/state/worktree-pools/app-1f2e/9/app")?.mainCheckoutRoot, "/code/app");
  assert.equal(poolContainingPath(pools, "/state/worktree-pools/app-1f"), null);

  // The default Git lookup, on a real repository: a subdirectory resolves to its main root.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "mission-history-repo-")));
  execFileSync("git", ["init", "-q", repo]);
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  const sources = { pools, taskRepoRoot: (task: string) => (task === "task-7" ? "/code/tasked" : null), worktreesDir: "/state/worktrees" };
  assert.equal(resolveHistoryRepository("/state/worktree-pools/app-1f2e/4/app", sources), "/code/app", "a slot that no longer exists");
  assert.equal(resolveHistoryRepository("/state/worktrees/task-7/app", sources), "/code/tasked", "a task worktree maps through its task");
  assert.equal(resolveHistoryRepository(join(repo, "src", "deep"), sources), repo, "a plain checkout resolves through Git");
  assert.equal(resolveHistoryRepository(join(tmpdir(), "mission-history-never-made"), sources), null, "an unknown path has no repository");
  rmSync(repo, { recursive: true, force: true });
});

test("prompt segments overlap at a boundary and stop at the per-prompt cap", () => {
  const long = `${"a".repeat(3_900)} boundary phrase ${"b".repeat(20_000)}`;
  const segments = historyPromptSegments([long]);
  assert.ok(segments.some((segment) => segment.includes("boundary phrase")), "a phrase across a chunk edge is whole in one chunk");
  assert.ok(segments.every((segment) => segment.length <= 4_000));
  assert.equal(segments.length, 5, "16,000 characters in chunks of 4,000 that overlap by 200");
  assert.ok(!segments.join("").includes("b".repeat(13_000)), "nothing past the cap is indexed");
  assert.deepEqual(historyPromptSegments(["  Line one\n\nLine   TWO  "]), ["line one line two"]);
});

test("a database stamped 12 with cataloged rows gains search text through migrate()", () => {
  const stamped = new DatabaseSync(join(home, "stamped-12.db"));
  try {
    stamped.exec("PRAGMA user_version = 11;");
    upgradeDatabaseToCurrentSchema(stamped);
    // What ticket 1's build left behind: rows, and no segments table yet.
    stamped.exec("DROP TABLE history_search_segments; PRAGMA user_version = 12;");
    stamped.prepare(
      `INSERT INTO history_sessions (agent, agent_session_id, transcript_path, fingerprint, kind, last_activity_at, indexed_at, ai_title, transcript_state)
       VALUES ('claude', 'kept', '/p/kept.jsonl', '{"size":1,"mtimeMs":1,"ino":1}', 'interactive', 1, 1, 'Kept title', 'present'),
              ('claude', 'gone', '/p/gone.jsonl', '{"size":1,"mtimeMs":1,"ino":2}', 'interactive', 1, 1, 'Gone title', 'gone')`,
    ).run();
    upgradeDatabaseToCurrentSchema(stamped);
    const fingerprints = stamped.prepare("SELECT fingerprint FROM history_sessions ORDER BY agent_session_id").all() as { fingerprint: string }[];
    assert.deepEqual(fingerprints.map((row) => row.fingerprint), ["{}", "{}"], "every row is queued for a re-read");
    assert.equal((stamped.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 13);
    // A second open does not queue them again.
    stamped.exec(`UPDATE history_sessions SET fingerprint = '{"size":1,"mtimeMs":1,"ino":1}'`);
    upgradeDatabaseToCurrentSchema(stamped);
    assert.equal((stamped.prepare("SELECT fingerprint FROM history_sessions WHERE agent_session_id = 'kept'").get() as { fingerprint: string }).fingerprint, '{"size":1,"mtimeMs":1,"ino":1}');
  } finally {
    stamped.close();
  }
});

test("a gone row with no search text is seeded from its row, and stays searchable", async () => {
  reset();
  openDb().prepare(
    `INSERT INTO history_sessions (agent, agent_session_id, transcript_path, fingerprint, kind, last_activity_at, indexed_at, ai_title, cwd, transcript_state)
     VALUES ('claude', ?, '/p/x.jsonl', '{}', 'interactive', 5, 1, 'Archived penguin study', '/w/zoo', 'gone')`,
  ).run(sessionId());
  const projects = mkdtempSync(join(tmpdir(), "mission-history-search-projects-"));
  const history = new HistoryService({ readers: [{ agent: "claude", spec: createClaudeHistory(projects) }], resolveRepository: () => null });
  await history.reconciler.trigger();
  const server = app(history);
  assert.equal((await ids(server, "q=penguin")).length, 1);
  assert.equal((await ids(server, "q=w%2Fzoo")).length, 1);
  rmSync(projects, { recursive: true, force: true });
});
