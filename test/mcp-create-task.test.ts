import { HARNESS_CAPABILITIES } from "../src/shared/harness-capabilities.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";

const home = mkdtempSync(join(tmpdir(), "mission-mcp-create-task-home-"));
const repos = mkdtempSync(join(tmpdir(), "mission-mcp-create-task-repos-"));
process.env.HARNESS_HOME = home;
process.env.HARNESS_WORKSPACE_DIRS = repos;
process.env.HARNESS_REPOS_CACHE_MS = "0";

const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { setHarnessesConfig } = await import("../src/server/harnesses.ts");
const { openDb } = await import("../src/server/db.ts");

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repos, { recursive: true, force: true });
});

afterEach(() => {
  openDb().exec("DELETE FROM app_config");
});

function gitRepo(name = "repo"): string {
  const dir = join(repos, name);
  execFileSync("mkdir", ["-p", dir]);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  return realpathSync(dir);
}

async function createTaskRequest(
  app: ReturnType<typeof buildApp>,
  path: "/mcp/tasks" | "/mcp/v2/tasks" | "/mcp/v3/tasks",
  repoRoot: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({
      env: {},
      cwd: repoRoot,
      repoRoot,
      title: "Filed by an agent",
      intent: "Do the thing",
      ...body,
    }),
  });
}

test("MCP task creation combines phase prerequisites with the calling session", async () => {
  const repo = gitRepo();
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const prerequisite = tasks.create({
    repoRoot: repo,
    intent: "Implement the prerequisite phase",
    title: "Prerequisite phase",
    kind: "ship",
    agent: "claude",
    backlog: true,
  });

  registry.applyDiscovery([
    {
      syntheticId: "planning-session",
      agent: "claude",
      name: "phase the plan",
      nameSource: "process",
      cwd: repo,
      gitBranch: "plan/phased-plan",
      gitRoot: repo,
      repoRoot: repo,
      pid: 101,
      tty: null,
      terminals: [],
      startedAt: Date.now(),
    },
  ]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "planning-agent-session",
    cwd: repo,
    transcriptPath: null,
    env: {},
  });

  const planningSession = registry.snapshot().sessions.find(
    (session) => session.name === "phase the plan",
  );
  assert.ok(planningSession);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const response = await app.request("/mcp/tasks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": ensureToken(),
    },
    body: JSON.stringify({
      env: {},
      sessionId: "planning-agent-session",
      cwd: repo,
      repoRoot: repo,
      title: "Dependent phase",
      intent: "Implement the dependent phase",
      dependsOnTaskIds: [prerequisite.id],
      dependsOnCurrentSession: true,
    }),
  });

  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.status, "backlog");
  assert.deepEqual(
    created.dependencies.map((dependency: { type: string; taskId?: string; sessionId?: string }) =>
      dependency.type === "task"
        ? `task:${dependency.taskId}`
        : `session:${dependency.sessionId}`,
    ),
    [`task:${prerequisite.id}`, `session:${planningSession.id}`],
  );
});

test("a task filed through MCP takes the kind's agent, not a hardcoded Claude", async () => {
  // An agent filing work through MCP has no opinion about which harness runs it - the tool
  // has no `agent` field at all - so it must take whatever `ship` is configured to run on.
  // The route used to say `agent: "claude"` here, which was an opinion expressed by accident
  // and one no setting could reach.
  openDb().exec("DELETE FROM app_config");
  setHarnessesConfig({ kindDefaults: { ship: { agent: "codex" } } });
  const repo = gitRepo();
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const response = await app.request("/mcp/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({
      env: {},
      cwd: repo,
      repoRoot: repo,
      title: "Filed by an agent",
      intent: "Do the thing",
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).agent, "codex");
});

test("the versioned route resolves an absolute alternate primary and echoes its canonical set", async () => {
  const repoA = gitRepo("absolute-a");
  const repoB = gitRepo("absolute-b");
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const before = registry.snapshot().tasks.length;

  const response = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    targetRepository: repoB,
  });

  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.repoRoot, repoB);
  assert.deepEqual(created.extraRepos, []);
  assert.equal(created.status, "backlog");
  assert.equal(registry.snapshot().tasks.length, before + 1);
});

test("a unique repository basename resolves through the workspace index", async () => {
  const repoA = gitRepo("short-name-a");
  const repoB = gitRepo("short-name-b");
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });

  const response = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    targetRepository: "short-name-b",
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).repoRoot, repoB);
});

test("missing and ambiguous short names are actionable and create no task", async () => {
  const repoA = gitRepo("selector-a");
  const first = gitRepo("alpha/shared-lib");
  const second = gitRepo("beta/shared-lib");
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const before = registry.snapshot().tasks.length;

  const missing = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    targetRepository: "not-here",
  });
  assert.equal(missing.status, 400);
  assert.match(((await missing.json()) as { error: string }).error, /use an absolute repository path/);

  const ambiguous = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    targetRepository: "shared-lib",
  });
  assert.equal(ambiguous.status, 409);
  const message = ((await ambiguous.json()) as { error: string }).error;
  assert.match(message, /ambiguous/);
  assert.ok(message.indexOf(first) < message.indexOf(second), "canonical candidates are sorted");
  assert.equal(registry.snapshot().tasks.length, before);
});

test("one versioned call stores an ordered canonical attachment set", async () => {
  const repoA = gitRepo("attached-a");
  const repoB = gitRepo("attached-b");
  const repoC = gitRepo("attached-c");
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });

  const response = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    targetRepository: "attached-b",
    additionalRepositories: [repoA, "attached-c"],
  });

  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.repoRoot, repoB);
  assert.deepEqual(
    created.extraRepos.map((entry: { repoRoot: string }) => entry.repoRoot),
    [repoA, repoC],
  );
});

test("the full repository set is refused before storage on collisions, duplicates, and cap", async () => {
  const repoA = gitRepo("policy-a");
  const repoB = gitRepo("policy-b");
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const before = registry.snapshot().tasks.length;

  const primaryCollision = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    targetRepository: repoB,
    additionalRepositories: [repoB],
  });
  assert.equal(primaryCollision.status, 400);
  assert.match(((await primaryCollision.json()) as { error: string }).error, /already this task's primary repo/);

  const duplicate = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    additionalRepositories: [repoB, repoB],
  });
  assert.equal(duplicate.status, 400);
  assert.match(((await duplicate.json()) as { error: string }).error, /attached twice/);

  const overCap = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    additionalRepositories: Array.from({ length: 9 }, (_, i) => `/repo-${i}`),
  });
  assert.equal(overCap.status, 400);
  assert.equal(registry.snapshot().tasks.length, before);
});

test("the default ship harness is capability-checked before a multi-repo task is stored", async () => {
  setHarnessesConfig({ kindDefaults: { ship: { agent: "pi" } } });
  const repoA = gitRepo("pi-a");
  const repoB = gitRepo("pi-b");
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const before = registry.snapshot().tasks.length;

  const original = HARNESS_CAPABILITIES.pi.multiRepoDispatch;
  HARNESS_CAPABILITIES.pi.multiRepoDispatch = null;
  try {
    const response = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
      additionalRepositories: [repoB],
    });

    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /pi cannot be given write access/);
    assert.equal(registry.snapshot().tasks.length, before);
  } finally {
    HARNESS_CAPABILITIES.pi.multiRepoDispatch = original;
  }
  const supported = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    additionalRepositories: [repoB],
  });
  assert.equal(supported.status, 200);
  assert.equal(registry.snapshot().tasks.length, before + 1);
});

test("a planning session in repo A can gate a task whose primary is repo B", async () => {
  const repoA = gitRepo("dependency-a");
  const repoB = gitRepo("dependency-b");
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.applyDiscovery([{
    syntheticId: "cross-repo-plan",
    agent: "claude",
    name: "plan across repos",
    nameSource: "process",
    cwd: repoA,
    gitBranch: "plan/cross-repo",
    gitRoot: repoA,
    repoRoot: repoA,
    pid: 202,
    tty: null,
    terminals: [],
    startedAt: Date.now(),
  }]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "cross-repo-agent",
    cwd: repoA,
    transcriptPath: null,
    env: {},
  });
  const planningSession = registry.snapshot().sessions.find((session) => session.name === "plan across repos");
  assert.ok(planningSession);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });

  const response = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    sessionId: "cross-repo-agent",
    targetRepository: repoB,
    dependsOnCurrentSession: true,
  });

  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.repoRoot, repoB);
  assert.equal(created.dependencies[0]?.sessionId, planningSession.id);
  assert.equal(created.dependencies[0]?.satisfiedAt, null);
});

test("MCP create_task never files a shape task, on either route", async () => {
  // The selector-free and v2 routes predate `kind`: a caller that sends one anyway gets
  // `ship`. Only the v3 route files another kind.
  const repo = gitRepo("shape-refused");
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  for (const path of ["/mcp/tasks", "/mcp/v2/tasks"] as const) {
    const response = await createTaskRequest(app, path, repo, { kind: "shape" });
    assert.equal(response.status, 200);
    const body = await response.json();
    const created = body.task ?? body;
    assert.equal(created.kind, "ship", `${path} must not create a shape task`);
  }
  assert.ok(tasks.list().every((task) => task.kind !== "shape"));
});

// ---------------------------------------------------------------------------
// Ticket sets: a shape task's breakdown filed through create_task (the v3 route)
// ---------------------------------------------------------------------------

/** A live planning session in `repo` whose agent session id MCP calls can name. */
function planningSession(
  registry: InstanceType<typeof Registry>,
  repo: string,
  name: string,
  agentSessionId: string,
): string {
  registry.applyDiscovery([{
    syntheticId: `${name}-synthetic`,
    agent: "claude",
    name,
    nameSource: "process",
    cwd: repo,
    gitBranch: "plan/tickets",
    gitRoot: repo,
    repoRoot: repo,
    pid: 303,
    tty: null,
    terminals: [],
    startedAt: Date.now(),
  }]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: agentSessionId,
    cwd: repo,
    transcriptPath: null,
    env: {},
  });
  const session = registry.snapshot().sessions.find((candidate) => candidate.name === name);
  assert.ok(session);
  return session.id;
}

function ticketHarness(name: string) {
  const repo = gitRepo(name);
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const sessionId = planningSession(registry, repo, `shape ${name}`, `${name}-agent`);
  const file = async (body: Record<string, unknown>) => {
    const response = await createTaskRequest(app, "/mcp/v3/tasks", repo, {
      sessionId: `${name}-agent`,
      dependsOnCurrentSession: true,
      ...body,
    });
    return { status: response.status, body: await response.json() };
  };
  // An adoption carries only its edges: no title, no intent.
  const adopt = async (adoptTaskId: string, body: Record<string, unknown> = {}) => {
    const response = await app.request("/mcp/v3/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
      body: JSON.stringify({
        env: {},
        cwd: repo,
        repoRoot: repo,
        sessionId: `${name}-agent`,
        dependsOnCurrentSession: true,
        adoptTaskId,
        ...body,
      }),
    });
    return { status: response.status, body: await response.json() };
  };
  const count = () => tasks.list().filter((task) => task.repoRoot === repo).length;
  return { repo, registry, tasks, app, sessionId, file, adopt, count };
}

const edgesOf = (task: { dependencies: ReadonlyArray<{ type: string; taskId?: string; sessionId?: string | null }> }) =>
  task.dependencies.map((dependency) =>
    dependency.type === "task" ? `task:${dependency.taskId}` : `${dependency.type}:${dependency.sessionId}`);

test("a ticket set files in dependency order with kind, labels, edges and the planning-session gate", async () => {
  const { sessionId, file, count } = ticketHarness("ticket-set");

  const first = await file({
    title: "Refactor the export seam",
    intent: "**What to build:** the seam.",
    kind: "ship",
    labels: ["shape-exports", " Shape-Exports ", "refactor"],
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.kind, "ship");
  assert.deepEqual(first.body.labels, ["shape-exports", "refactor"], "labels are normalized");
  assert.deepEqual(edgesOf(first.body), [`session:${sessionId}`]);

  const second = await file({
    title: "Export a crash report",
    intent: "**What to build:** the fix.",
    kind: "bugfix",
    labels: ["shape-exports"],
    dependsOnTaskIds: [first.body.id],
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.kind, "bugfix");
  assert.equal(second.body.status, "backlog");
  assert.deepEqual(edgesOf(second.body), [`task:${first.body.id}`, `session:${sessionId}`]);
  // The human's approval of the breakdown is the consent: ticket tasks are autopilot-eligible.
  assert.equal(second.body.enabled, true);
  assert.equal(count(), 2);
});

test("a new ticket needs its title and intent, and nothing unknown rides along", async () => {
  const { app, repo, count } = ticketHarness("ticket-required");
  for (const body of [{ title: undefined }, { intent: undefined }, { priority: "high" }]) {
    const response = await createTaskRequest(app, "/mcp/v3/tasks", repo, body);
    assert.equal(response.status, 400, `${JSON.stringify(body)} is refused`);
  }
  assert.equal(count(), 0);
});

test("create_task files the backlog kinds an operator can ask for, and refuses the rest", async () => {
  const { file, count } = ticketHarness("ticket-kind");
  for (const kind of ["chat", "pipeline"]) {
    const refused = await file({ title: `A ${kind} ticket`, intent: "No.", kind });
    assert.equal(refused.status, 400, `${kind} is refused`);
  }
  assert.equal(count(), 0);
  const defaulted = await file({ title: "Default kind", intent: "Yes.", labels: ["x"] });
  assert.equal(defaulted.body.kind, "ship");
  for (const kind of ["scout", "plan", "shape"]) {
    const filed = await file({ title: `A ${kind} task`, intent: "Yes.", kind });
    assert.equal(filed.status, 200, `${kind} is filed`);
    assert.equal(filed.body.kind, kind);
    assert.equal(filed.body.status, "backlog");
  }
});

test("adopting a backlog task only adds the ticket's edges to it", async () => {
  const { repo, tasks, sessionId, file, adopt, count } = ticketHarness("ticket-adopt");
  const existing = tasks.create({
    repoRoot: repo,
    intent: "The operator's own brief, which the ticket must not overwrite.",
    title: "Existing export work",
    kind: "bugfix",
    agent: "claude",
    labels: ["operator"],
    backlog: true,
  });
  const blocker = await file({ title: "Refactor the export seam", intent: "The seam." });

  // A ticket's own title, intent, kind, labels or repository beside adoptTaskId describe a task
  // this call would not create, so the body is refused rather than half-applied.
  for (const extra of [
    { title: "Ticket title that must not land" },
    { intent: "Ticket body that must not land" },
    { kind: "ship" },
    { labels: ["ticket"] },
    { additionalRepositories: [] },
  ]) {
    const mixed = await adopt(existing.id, { dependsOnTaskIds: [blocker.body.id], ...extra });
    assert.equal(mixed.status, 400, `adoptTaskId with ${Object.keys(extra)[0]} is refused`);
  }
  assert.deepEqual(tasks.list().find((task) => task.id === existing.id)!.dependencies, []);
  assert.equal(count(), 2, "a refused adoption never falls back to creating");

  const adopted = await adopt(existing.id, { dependsOnTaskIds: [blocker.body.id] });
  assert.equal(adopted.status, 200);
  assert.equal(adopted.body.id, existing.id);
  assert.equal(adopted.body.adopted, true);
  const stored = tasks.list().find((task) => task.id === existing.id)!;
  assert.equal(stored.title, "Existing export work");
  assert.equal(stored.intent, "The operator's own brief, which the ticket must not overwrite.");
  assert.equal(stored.kind, "bugfix");
  assert.deepEqual(stored.labels, ["operator"]);
  assert.deepEqual(edgesOf(stored), [`task:${blocker.body.id}`, `session:${sessionId}`]);
  assert.equal(count(), 2, "adopting creates nothing");

  // A ticket blocked by the adopted one waits on the adopted task.
  const dependent = await file({ title: "Export UI", intent: "UI.", dependsOnTaskIds: [existing.id] });
  assert.deepEqual(edgesOf(dependent.body), [`task:${existing.id}`, `session:${sessionId}`]);

  // Adopting again with the same edges is a no-op, not a duplicate edge.
  const again = await adopt(existing.id, { dependsOnTaskIds: [blocker.body.id] });
  assert.equal(again.status, 200);
  assert.equal(tasks.list().find((task) => task.id === existing.id)!.dependencies.length, 2);
});

test("an adoption that would close a dependency cycle is refused and changes nothing", async () => {
  const { repo, tasks, file, adopt } = ticketHarness("ticket-cycle");
  const adoptable = tasks.create({
    repoRoot: repo, intent: "A", title: "A", kind: "ship", agent: "claude", backlog: true,
  });
  // B already waits on A, so making A wait on B would deadlock both.
  const waiting = await file({ title: "B", intent: "B", dependsOnTaskIds: [adoptable.id] });
  assert.equal(waiting.status, 200);

  const cycle = await adopt(adoptable.id, { dependsOnTaskIds: [waiting.body.id] });
  assert.equal(cycle.status, 409);
  assert.match(cycle.body.error, /cycle/);
  assert.deepEqual(tasks.list().find((task) => task.id === adoptable.id)!.dependencies, []);
});

test("only an existing backlog task can be adopted", async () => {
  const { adopt, count } = ticketHarness("ticket-adopt-missing");
  const missing = await adopt("no-such-task");
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /no such task to adopt/);
  assert.equal(count(), 0, "a failed adoption never falls back to creating");
});

test("a task that has left the backlog cannot be adopted, and gains no edges", async () => {
  const { repo, registry, tasks, file, adopt, count } = ticketHarness("ticket-adopt-running");
  const blocker = await file({ title: "Blocker", intent: "b" });
  const created = tasks.create({
    repoRoot: repo, intent: "Already started", title: "Running work", kind: "ship", agent: "claude", backlog: true,
  });
  for (const status of ["running", "done"] as const) {
    registry.upsertTask({ ...tasks.list().find((task) => task.id === created.id)!, status });
    const refused = await adopt(created.id, { dependsOnTaskIds: [blocker.body.id] });
    assert.equal(refused.status, 409, `a ${status} task is refused`);
    assert.equal(refused.body.error, `the task to adopt is ${status}, not in the backlog`);
    assert.deepEqual(tasks.list().find((task) => task.id === created.id)!.dependencies, []);
  }
  assert.equal(count(), 2, "a refused adoption never falls back to creating");
});

test("list_backlog_tasks returns the calling repository's open backlog only", async () => {
  const { repo, tasks, app, file } = ticketHarness("ticket-list");
  const other = gitRepo("ticket-list-other");
  const mine = await file({ title: "Mine", intent: "m", labels: ["a"] });
  const dependent = await file({ title: "Dependent", intent: "d", dependsOnTaskIds: [mine.body.id] });
  tasks.create({ repoRoot: other, intent: "o", title: "Other repo", kind: "ship", agent: "claude", backlog: true });

  const response = await app.request("/mcp/backlog", {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({ env: {}, cwd: repo, repoRoot: repo }),
  });
  assert.equal(response.status, 200);
  const listed = await response.json();
  assert.equal(listed.repository, repo);
  assert.deepEqual(
    listed.tasks.map((task: { title: string }) => task.title).sort(),
    ["Dependent", "Mine"],
  );
  const row = listed.tasks.find((task: { id: string }) => task.id === dependent.body.id);
  assert.deepEqual(row, {
    id: dependent.body.id,
    title: "Dependent",
    kind: "ship",
    labels: [],
    dependsOnTaskIds: [mine.body.id],
  });
});

const listBacklog = async (
  app: ReturnType<typeof buildApp>,
  repoRoot: string,
  repository?: string,
) => {
  const response = await app.request("/mcp/v2/backlog", {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({ env: {}, cwd: repoRoot, repoRoot, ...(repository ? { repository } : {}) }),
  });
  return { status: response.status, body: await response.json() };
};

test("list_backlog_tasks lists a named repository's backlog, by path or unique name", async () => {
  const { repo, tasks, app, file } = ticketHarness("cross-list");
  const other = gitRepo("cross-list-other");
  await file({ title: "Mine", intent: "m" });
  tasks.create({ repoRoot: other, intent: "o", title: "Theirs", kind: "bugfix", agent: "claude", backlog: true });

  const own = await listBacklog(app, repo);
  assert.equal(own.status, 200);
  assert.equal(own.body.repository, repo);
  assert.deepEqual(own.body.tasks.map((task: { title: string }) => task.title), ["Mine"]);

  for (const selector of [other, "cross-list-other"]) {
    const named = await listBacklog(app, repo, selector);
    assert.equal(named.status, 200, JSON.stringify(named.body));
    assert.equal(named.body.repository, other);
    assert.deepEqual(named.body.tasks.map((task: { title: string }) => task.title), ["Theirs"]);
  }
});

test("list_backlog_tasks refuses a missing or ambiguous repository name", async () => {
  const { repo, app } = ticketHarness("cross-list-errors");
  const first = gitRepo("gamma/dup-lib");
  const second = gitRepo("delta/dup-lib");

  const missing = await listBacklog(app, repo, "not-here");
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /no local repository named "not-here"/);

  const ambiguous = await listBacklog(app, repo, "dup-lib");
  assert.equal(ambiguous.status, 409);
  assert.match(ambiguous.body.error, /ambiguous/);
  assert.ok(ambiguous.body.error.includes(first) && ambiguous.body.error.includes(second));

  // A field this route does not know is refused, never stripped.
  const response = await app.request("/mcp/v2/backlog", {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({ env: {}, cwd: repo, repoRoot: repo, repositories: ["x"] }),
  });
  assert.equal(response.status, 400);
});

test("adoption refuses a task from neither the caller's nor the named repository", async () => {
  const { tasks, adopt, file } = ticketHarness("cross-adopt");
  const other = gitRepo("cross-adopt-other");
  const blocker = await file({ title: "Blocker", intent: "b" });
  const foreign = tasks.create({
    repoRoot: other, intent: "o", title: "Theirs", kind: "ship", agent: "claude", backlog: true,
  });

  const refused = await adopt(foreign.id, { dependsOnTaskIds: [blocker.body.id] });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /belongs to .*cross-adopt-other.*neither this session's repository nor the named repository/);
  assert.deepEqual(tasks.list().find((task) => task.id === foreign.id)!.dependencies, []);

  // Naming some third repository does not widen it to this one.
  gitRepo("cross-adopt-third");
  const wrongName = await adopt(foreign.id, { targetRepository: "cross-adopt-third", dependsOnTaskIds: [blocker.body.id] });
  assert.equal(wrongName.status, 409);

  const badName = await adopt(foreign.id, { targetRepository: "not-here" });
  assert.equal(badName.status, 400);

  // Naming the task's own repository - the one it was listed from - allows it.
  const adopted = await adopt(foreign.id, { targetRepository: "cross-adopt-other", dependsOnTaskIds: [blocker.body.id] });
  assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
  assert.equal(adopted.body.adopted, true);
  assert.deepEqual(edgesOf(adopted.body).slice(0, 1), [`task:${blocker.body.id}`]);
});

// ---------------------------------------------------------------------------
// Tickets follow-ups: a shape task in tickets-only mode slicing a merged plan
// ---------------------------------------------------------------------------

/**
 * A live session running a tickets follow-up of a merged shape task, as the relation records
 * it: the follow-up is the session's task, and the shape task it slices is done.
 */
async function followupHarness(name: string) {
  const { reserveShapeTicketFollowup } = await import("../src/server/db.ts");
  const { mkTask } = await import("./helpers/session-fixture.ts");
  const harness = ticketHarness(name);
  const sourceId = `${name}-shape`;
  const followupId = `${name}-followup`;
  harness.registry.upsertTask(mkTask({
    id: sourceId, title: "Shape archive exports", kind: "shape", status: "done", repoRoot: harness.repo,
  }));
  harness.registry.upsertTask(mkTask({
    id: followupId, title: "Tickets: Shape archive exports", kind: "shape", status: "running",
    repoRoot: harness.repo, sessionId: harness.sessionId,
  }));
  const relation = reserveShapeTicketFollowup({
    followupTaskId: followupId,
    sourceTaskId: sourceId,
    sourceEpisodeId: `${name}-merged-episode`,
    sourceSessionId: `${name}-shape-session`,
    sourcePrUrl: `https://github.com/acme/${name}/pull/7`,
    now: Date.now(),
  }).relation;
  assert.equal(harness.registry.getSession(harness.sessionId)?.task?.id, followupId);
  return { ...harness, sourceId, followupId, relation };
}

test("a tickets follow-up's own gate links the ticket to the merged shape task, already satisfied", async () => {
  const { tasks, sourceId, followupId, relation, file } = await followupHarness("followup-gate");

  const first = await file({ title: "Refactor the export seam", intent: "The seam." });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(edgesOf(first.body), [`task:${sourceId}`], "no edge to the follow-up");
  const [edge] = first.body.dependencies;
  assert.equal(edge.episodeId, relation.sourceEpisodeId, "pinned to the merged episode");
  assert.equal(edge.sessionId, relation.sourceSessionId);
  assert.equal(edge.prUrl, relation.sourcePrUrl);
  assert.equal(typeof edge.satisfiedAt, "number", "already satisfied");
  assert.equal(first.body.status, "backlog");
  assert.deepEqual(tasks.dependencyBlockers(tasks.get(first.body.id)!), [], "eligible at once");

  // Its own blockers still hold it back, and nothing else does.
  const second = await file({ title: "Export UI", intent: "UI.", dependsOnTaskIds: [first.body.id] });
  assert.deepEqual(edgesOf(second.body), [`task:${first.body.id}`, `task:${sourceId}`]);
  assert.deepEqual(
    tasks.dependencyBlockers(tasks.get(second.body.id)!).map((blocker) => blocker.taskId),
    [first.body.id],
  );
  assert.ok(tasks.list().every((task) =>
    task.dependencies.every((dependency) => dependency.type !== "task" || dependency.taskId !== followupId)));
});

test("adopting from a tickets follow-up adds the satisfied edge to the merged shape task", async () => {
  const { repo, tasks, sourceId, adopt } = await followupHarness("followup-adopt");
  const existing = tasks.create({
    repoRoot: repo, intent: "Existing work.", title: "Existing", kind: "ship", agent: "claude", backlog: true,
  });
  const adopted = await adopt(existing.id);
  assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
  assert.deepEqual(edgesOf(adopted.body), [`task:${sourceId}`]);
  assert.equal(typeof adopted.body.dependencies[0].satisfiedAt, "number");

  // Adopting again keeps the one edge, and when it was first linked.
  const again = await adopt(existing.id);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.dependencies, adopted.body.dependencies);
});

test("a follow-up session without dependsOnCurrentSession files a ticket with no edge", async () => {
  const { file } = await followupHarness("followup-ungated");
  const ticket = await file({ title: "Free", intent: "f", dependsOnCurrentSession: false });
  assert.equal(ticket.status, 200);
  assert.deepEqual(ticket.body.dependencies, []);
});
