import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { Session, Task } from "../src/shared/types.ts";
// Pure and browser-safe, so static imports cannot open the DB ahead of the home below.
import {
  DispatchSchema,
  McpCreateTaskV3Schema,
  McpPushTaskSchema,
  UpdateTaskSchema,
} from "../src/shared/protocol.ts";
import { TaskSourcesConfigSchema } from "../src/shared/task-source.ts";

// A task's optional base branch: stored on the row, accepted by the task API and MCP, checked
// against origin, followed by the worktree start point at dispatch and at reset, and named to
// the agent wherever it is asked to open a pull request. Every fixture repository has a
// second branch on its origin, `release/windows`, one commit apart from `main`, so a start
// point on the wrong branch is a different commit rather than an accident of equal tips.

const home = mkdtempSync(join(tmpdir(), "mission-base-branch-home-"));
const repos = mkdtempSync(join(tmpdir(), "mission-base-branch-repos-"));
process.env.HARNESS_HOME = home;
process.env.HARNESS_WORKSPACE_DIRS = repos;
process.env.HARNESS_REPOS_CACHE_MS = "0";
// A binary that exists, so bin resolution is not what a dispatch below fails on.
process.env.MISSION_PI_BIN = "/bin/echo";

const { ensureToken } = await import("../src/server/auth.ts");
const { openDb, getTask } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { Dispatcher, resolveTaskBases } = await import("../src/server/dispatcher.ts");
const { baseBranchRefusal, freshRemoteBranchSha, parseLsRemoteBranchSha } =
  await import("../src/server/git/remote-default.ts");
const { resetPreview, resetToOrigin } = await import("../src/server/actions.ts");
const { withTaskKindContract } = await import("../src/server/task-contract.ts");
const { renderPrHandoff, renderSessionAction } = await import("../src/server/workflows/feedback.ts");
const { prBaseBranchFor } = await import("../src/server/workflows/manager.ts");
const { setTaskSourcesConfig } = await import("../src/server/task-sources/config.ts");

const bin = mkdtempSync(join(tmpdir(), "mission-base-branch-bin-"));

after(() => {
  for (const dir of [home, repos, bin]) rmSync(dir, { recursive: true, force: true });
  delete process.env.MISSION_PI_BIN;
});

beforeEach(() => {
  openDb().exec("DELETE FROM tasks; DELETE FROM task_source_seen; DELETE FROM app_config;");
});

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString().trim();

interface Fixture {
  repo: string;
  mainTip: string;
  releaseTip: string;
}

/**
 * A checkout with a bare origin carrying `main` and `release/windows`, the checkout itself
 * on `main`. Lives under the workspace dir so the task routes accept it as a repository.
 * `release: false` leaves `release/windows` off origin, for a repository that lacks the base.
 */
function mkRepo(name: string, { release = true }: { release?: boolean } = {}): Fixture {
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
  git(repo, "push", "-qu", "origin", "main");
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  if (release) {
    git(repo, "checkout", "-qb", "release/windows");
    writeFileSync(join(repo, "file.txt"), "windows\n");
    git(repo, "commit", "-qam", "windows");
    git(repo, "push", "-q", "origin", "release/windows");
    git(repo, "checkout", "-q", "main");
  }
  return {
    repo: realpathSync(repo),
    mainTip: git(repo, "rev-parse", "main"),
    releaseTip: release ? git(repo, "rev-parse", "release/windows") : "",
  };
}

// --- schemas ---

test("the task API and MCP schemas accept a base branch and refuse a malformed one", () => {
  const dispatch = { repoRoot: "/r", intent: "do it" };
  assert.equal(DispatchSchema.parse({ ...dispatch, baseBranch: " release/windows " }).baseBranch, "release/windows");
  assert.equal(DispatchSchema.parse(dispatch).baseBranch, undefined, "omitted stays omitted");
  assert.equal(UpdateTaskSchema.parse({ baseBranch: null }).baseBranch, null, "null clears it");
  for (const bad of ["-delete", "refs/heads/main", "a..b", "has space", "x.lock", "a/", "feat:x", ""]) {
    assert.equal(DispatchSchema.safeParse({ ...dispatch, baseBranch: bad }).success, false, bad);
    assert.equal(UpdateTaskSchema.safeParse({ baseBranch: bad }).success, false, bad);
  }

  const mcp = { env: {}, cwd: "/r", repoRoot: "/r" };
  const ticket = McpCreateTaskV3Schema.parse({ ...mcp, title: "T", intent: "I", baseBranch: "release/windows" });
  assert.equal("baseBranch" in ticket && ticket.baseBranch, "release/windows");
  // The adoption half is strict and creates nothing, so a base branch beside it is refused.
  assert.equal(McpCreateTaskV3Schema.safeParse({ ...mcp, adoptTaskId: "t", baseBranch: "release/windows" }).success, false);
  const push = { env: {}, cwd: "/r", taskId: "t" };
  assert.equal(McpPushTaskSchema.parse({ ...push, baseBranch: "release/windows" }).baseBranch, "release/windows");
});

// --- origin probes ---

test("a base branch is accepted only when it exists on the repository's origin", async () => {
  const { repo, releaseTip } = mkRepo("probe");
  assert.equal(await baseBranchRefusal(repo, "release/windows"), null);
  assert.match(
    (await baseBranchRefusal(repo, "release/gone")) ?? "",
    /base branch release\/gone does not exist on .*'s origin/,
  );
  const local = join(repos, "local-only");
  execFileSync("git", ["init", "-q", local]);
  assert.match((await baseBranchRefusal(local, "main")) ?? "", /needs an origin remote/);

  const fresh = await freshRemoteBranchSha(repo, "release/windows");
  assert.deepEqual(fresh, { ok: true, value: releaseTip });
  const gone = await freshRemoteBranchSha(repo, "release/gone");
  assert.equal(gone.ok, false);
});

test("ls-remote parsing takes the exact branch, not one that merely ends with its name", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const out = `${a}\trefs/heads/x/refs/heads/next\n${b}\trefs/heads/next\n`;
  assert.equal(parseLsRemoteBranchSha(out, "next"), b);
  assert.equal(parseLsRemoteBranchSha(out, "other"), null);
});

test("resolveTaskBases starts the primary from its base branch and leaves attached repos on their default", async () => {
  const branchCalls: Array<[string, string]> = [];
  const bases = await resolveTaskBases(
    { primary: "/a", primaryBranch: "release/windows", extras: ["/b"] },
    null,
    async (root) => `default:${root}`,
    async (root, branch) => {
      branchCalls.push([root, branch]);
      return `branch:${root}:${branch}`;
    },
  );
  assert.deepEqual(bases, { primary: "branch:/a:release/windows", extras: ["default:/b"] });
  assert.deepEqual(branchCalls, [["/a", "release/windows"]]);
  // No base branch: exactly the default, as before.
  const plain = await resolveTaskBases({ primary: "/a", extras: [] }, null, async (root) => `default:${root}`);
  assert.deepEqual(plain, { primary: "default:/a", extras: [] });
});

test("a pinned base commit outranks the task's base branch, which is then never resolved", async () => {
  const resolved: string[] = [];
  const bases = await resolveTaskBases(
    { primary: "/a", primaryBranch: "release/windows", extras: [] },
    "f".repeat(40),
    async (root) => {
      resolved.push(`default:${root}`);
      return `default:${root}`;
    },
    async (root, branch) => {
      resolved.push(`branch:${root}:${branch}`);
      return `branch:${root}:${branch}`;
    },
  );
  assert.deepEqual(bases, { primary: "f".repeat(40), extras: [] });
  assert.deepEqual(resolved, [], "neither the branch nor the default is consulted for a pinned primary");
});

// --- dispatch ---

function dispatchingTask(id: string, repoRoot: string, baseBranch: string | null): Task {
  return mkTask({
    id, status: "dispatching", agent: "pi", kind: "ship", repoRoot, baseBranch,
    title: id, intent: "Build it",
  });
}

function piDispatcher(registry: InstanceType<typeof Registry>, launched: { cwd: string; argv: string[] }[]) {
  return new Dispatcher(registry, undefined, {
    resolveRuntime: () => "terminal",
    missionMcpDescriptor: async () => null,
    spawn: async (label, _short, cwd, _bin, args) => {
      launched.push({ cwd, argv: [...(args ?? [])] });
      registry.applyDiscovery([{
        syntheticId: `${label}-session`, agent: "pi", name: label, nameSource: "process",
        cwd, gitBranch: null, gitRoot: cwd, repoRoot: cwd, pid: 4000 + launched.length,
        tty: `tty-${label}`, startedAt: Date.now(),
        terminals: [mkMuxHandle({ session: label, paneId: `%${4000 + launched.length}` })],
      }]);
      return { homeName: label, homeBackend: "tmux", terminalResourceId: null };
    },
  });
}

test("dispatch starts a task with a base branch from origin/<base>, and tells the agent where to open its PR", async () => {
  const { repo, mainTip, releaseTip } = mkRepo("dispatch-base");
  const registry = new Registry();
  registry.upsertTask(dispatchingTask("based", repo, "release/windows"));
  const launched: { cwd: string; argv: string[] }[] = [];
  await piDispatcher(registry, launched).dispatch("based");

  const task = registry.getTask("based")!;
  assert.equal(task.status, "running", task.error ?? "dispatch failed");
  assert.equal(task.baseSha, releaseTip);
  assert.equal(git(task.worktreePath!, "rev-parse", "HEAD"), releaseTip);
  assert.notEqual(releaseTip, mainTip);
  const prompt = launched[0]!.argv.join("\n");
  assert.match(prompt, /## Base branch/);
  assert.match(prompt, /gh pr create --base release\/windows/);
});

test("dispatch refuses a base branch origin no longer has, before anything is provisioned", async () => {
  const { repo } = mkRepo("dispatch-gone");
  const registry = new Registry();
  registry.upsertTask(dispatchingTask("gone", repo, "release/gone"));
  const launched: { cwd: string; argv: string[] }[] = [];
  await piDispatcher(registry, launched).dispatch("gone");

  const task = registry.getTask("gone")!;
  assert.equal(task.status, "backlog", "a ship task goes back to the backlog with the reason");
  assert.match(task.error ?? "", /base branch release\/gone does not exist on origin/);
  assert.equal(task.worktreePath, null);
  assert.equal(launched.length, 0);
});

// --- reset ---

function sessionAt(cwd: string, id = "s1"): Session {
  return {
    id, agent: "claude", name: "work", runtime: "terminal", foremanInvite: null, nameSource: "process", state: "idle",
    cwd, gitBranch: null, gitRoot: null, repoRoot: null, pid: 1, tty: null,
    permissionMode: null, terminals: [], agentSessionId: null, transcriptPath: null,
    instrumented: false, stateConfirmed: false, hooksSeen: false, activity: null, startedAt: null, firstSeen: 0, lastSeen: 0,
    lastActivity: null, pendingReviews: 0, task: null,
    prUrl: null, prNumber: null, prState: null, prChecks: null, prMergeable: null, prBaseRef: null, prHeadSha: null, inspector: null,
    meta: null, effortBaselineReady: false, pendingEffort: null, note: null, cost: null, goal: null, queue: null, pendingTurns: [], orphanedQueue: null, pipeline: null, paneDialog: null,
  };
}

test("a reset for a task with a base branch lands on origin/<base>; without one, on origin's default", async () => {
  const { repo, mainTip, releaseTip } = mkRepo("reset-base");
  const wt = join(repos, "reset-base-wt");
  git(repo, "worktree", "add", "-q", "--detach", wt, mainTip);

  const preview = await resetPreview(sessionAt(wt), "release/windows");
  assert.equal(preview.ok, true, preview.error ?? "");
  assert.equal(preview.target, "origin/release/windows");

  const based = await resetToOrigin(sessionAt(wt), false, undefined, undefined, undefined, "release/windows");
  assert.equal(based.ok, true, based.error ?? "");
  assert.equal(git(wt, "rev-parse", "HEAD"), releaseTip);

  const plain = await resetToOrigin(sessionAt(wt), false);
  assert.equal(plain.ok, true, plain.error ?? "");
  assert.equal(git(wt, "rev-parse", "HEAD"), mainTip);

  const gone = await resetToOrigin(sessionAt(wt), false, undefined, undefined, undefined, "release/gone");
  assert.equal(gone.ok, false);
  assert.match(gone.error ?? "", /base branch release\/gone does not exist on origin/);
  assert.equal(git(wt, "rev-parse", "HEAD"), mainTip, "a refused reset moves nothing");
});

// --- routes ---

function appFor(registry = new Registry()) {
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const api = (path: string, body: Record<string, unknown>) => app.request(path, {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const mcp = (path: string, body: Record<string, unknown>) => app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({ env: {}, ...body }),
  });
  return { app, api, mcp, registry, tasks };
}

test("creating a task stores its base branch, and one origin lacks is refused with nothing created", async () => {
  const { repo } = mkRepo("route-create");
  const { api } = appFor();
  const ok = await api("/api/tasks", { repoRoot: repo, title: "Port it", intent: "Port it", backlog: true, workflowId: null, baseBranch: "release/windows" });
  assert.equal(ok.status, 200, await ok.clone().text());
  const created = (await ok.json()) as Task;
  assert.equal(created.baseBranch, "release/windows");
  assert.equal(getTask(created.id)?.baseBranch, "release/windows", "persisted on the row");

  const plain = (await (await api("/api/tasks", { repoRoot: repo, title: "Plain", intent: "Plain", backlog: true, workflowId: null })).json()) as Task;
  assert.equal(plain.baseBranch, null, "no base branch means origin's default");

  const before = openDb().prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
  const refused = await api("/api/tasks", { repoRoot: repo, title: "Port it", intent: "Port it", backlog: true, workflowId: null, baseBranch: "release/gone" });
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { error: string }).error, /base branch release\/gone does not exist/);
  const afterCount = openDb().prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
  assert.equal(afterCount.n, before.n);
});

test("editing a task sets, refuses, and clears its base branch", async () => {
  const { repo } = mkRepo("route-update");
  const { api } = appFor();
  const task = (await (await api("/api/tasks", { repoRoot: repo, title: "Edit me", intent: "Edit me", backlog: true, workflowId: null })).json()) as Task;

  const set = await api(`/api/tasks/${task.id}/update`, { baseBranch: "release/windows" });
  assert.equal(set.status, 200, await set.clone().text());
  assert.equal(getTask(task.id)?.baseBranch, "release/windows");

  const refused = await api(`/api/tasks/${task.id}/update`, { baseBranch: "release/gone" });
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { error: string }).error, /does not exist/);
  assert.equal(getTask(task.id)?.baseBranch, "release/windows", "a refused edit changes nothing");

  const cleared = await api(`/api/tasks/${task.id}/update`, { baseBranch: null });
  assert.equal(cleared.status, 200);
  assert.equal(getTask(task.id)?.baseBranch, null);
});

test("moving a task that keeps a base branch to a repository whose origin lacks it is refused", async () => {
  const { repo } = mkRepo("route-move-from");
  const { repo: bare } = mkRepo("route-move-to", { release: false });
  const { repo: also } = mkRepo("route-move-ok");
  const { api } = appFor();
  const task = (await (await api("/api/tasks", {
    repoRoot: repo, title: "Move me", intent: "Move me", backlog: true, workflowId: null,
    baseBranch: "release/windows",
  })).json()) as Task;

  // The patch names only the repository; the base it keeps is what has to exist there.
  const refused = await api(`/api/tasks/${task.id}/update`, { repoRoot: bare });
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { error: string }).error, /base branch release\/windows does not exist/);
  assert.equal(getTask(task.id)?.repoRoot, repo, "a refused move changes nothing");
  assert.equal(getTask(task.id)?.baseBranch, "release/windows");

  const moved = await api(`/api/tasks/${task.id}/update`, { repoRoot: also });
  assert.equal(moved.status, 200, await moved.clone().text());
  assert.equal(getTask(task.id)?.repoRoot, also);
});

test("MCP create_task files a task with a base branch through the v3 route, and refuses one origin lacks", async () => {
  const { repo } = mkRepo("route-mcp");
  const { mcp } = appFor();
  const body = { cwd: repo, repoRoot: repo, title: "Windows ticket", intent: "Port it" };
  const ok = await mcp("/mcp/v3/tasks", { ...body, baseBranch: "release/windows" });
  assert.equal(ok.status, 200, await ok.clone().text());
  const created = (await ok.json()) as Task;
  assert.equal(created.baseBranch, "release/windows");
  assert.equal(created.status, "backlog");

  const refused = await mcp("/mcp/v3/tasks", { ...body, baseBranch: "release/gone" });
  assert.equal(refused.status, 400);
});

test("the MCP client sends a base branch only to the routes that refuse what they do not know", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url)), "utf8");
  const create = source.slice(
    source.indexOf('server.registerTool(\n  "create_task"'),
    source.indexOf('server.registerTool(\n  "list_backlog_tasks"'),
  );
  // v2 would strip it and file the task on the default branch; v3 is strict.
  assert.match(create, /adoptTaskId !== undefined \|\| baseBranch !== undefined;/);
  assert.match(create, /labels,\n\s+baseBranch,\n\s+adoptTaskId,\n\s+\}\);/);
  const push = source.slice(source.indexOf('server.registerTool(\n  "push_task"'));
  assert.match(push, /sourceId,\n\s+baseBranch,\n\s+\}\);/);
});

test("MCP push_task sets the task's base branch before mirroring it, and refuses one origin lacks", async () => {
  const { repo } = mkRepo("route-push");
  const gh = join(bin, "gh");
  writeFileSync(gh, "#!/bin/sh\necho https://github.com/acme/demo/issues/7\n");
  chmodSync(gh, 0o755);
  process.env.MISSION_GH_BIN = gh;
  setTaskSourcesConfig(TaskSourcesConfigSchema.parse({
    sources: [{ id: "src-gh", kind: "github-issues", label: "demo issues", repoRoot: repo, config: {} }],
  }));
  try {
    const registry = new Registry();
    registry.applyDiscovery([{
      syntheticId: "filer", agent: "claude", name: "filer", nameSource: "process", cwd: repo,
      gitBranch: "main", gitRoot: repo, repoRoot: repo, pid: 101, tty: null, terminals: [], startedAt: Date.now(),
    }]);
    registry.applyHook({
      agent: "claude", event: "Stop", sessionId: "filer-agent", cwd: repo, transcriptPath: null, env: {},
    });
    const session = registry.snapshot().sessions.find((s) => s.name === "filer")!;
    const { mcp } = appFor(registry);
    const filed = await mcp("/mcp/v3/tasks", {
      sessionId: "filer-agent", cwd: repo, repoRoot: repo, title: "Ticket", intent: "Port it",
      dependsOnCurrentSession: true,
    });
    assert.equal(filed.status, 200, await filed.clone().text());
    const ticket = (await filed.json()) as Task;
    assert.ok(ticket.dependencies.some((edge) => edge.type === "session" && edge.sessionId === session.id));

    const push = (baseBranch: string) =>
      mcp("/mcp/push-task", { sessionId: "filer-agent", cwd: repo, taskId: ticket.id, baseBranch });
    const refused = await push("release/gone");
    assert.equal(refused.status, 400);
    assert.equal(getTask(ticket.id)?.source, null, "a refused base publishes nothing");

    const ok = await push("release/windows");
    assert.equal(ok.status, 200, await ok.clone().text());
    const pushed = getTask(ticket.id)!;
    assert.equal(pushed.baseBranch, "release/windows");
    assert.equal(pushed.source?.sourceId, "src-gh");
  } finally {
    delete process.env.MISSION_GH_BIN;
    setTaskSourcesConfig(TaskSourcesConfigSchema.parse({ sources: [] }));
  }
});

test("the reset route and its preview land on the base branch of the task the session runs", async () => {
  const { repo, mainTip, releaseTip } = mkRepo("route-reset");
  const wt = join(repos, "route-reset-wt");
  git(repo, "worktree", "add", "-q", "--detach", wt, mainTip);
  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: "runner", agent: "claude", name: "runner", nameSource: "process", cwd: realpathSync(wt),
    gitBranch: null, gitRoot: realpathSync(wt), repoRoot: repo, pid: 202, tty: null, terminals: [], startedAt: Date.now(),
  }]);
  const session = registry.snapshot().sessions.find((s) => s.name === "runner")!;
  registry.upsertTask(mkTask({
    id: "running-based", status: "running", repoRoot: repo, baseBranch: "release/windows",
    sessionId: session.id, worktreePath: realpathSync(wt),
  }));
  const { app } = appFor(registry);
  const res = await app.request(`/api/sessions/${session.id}/reset/preview`, {
    headers: { host: "127.0.0.1:7317" },
  });
  const preview = (await res.json()) as { ok: boolean; target: string | null; error: string | null };
  assert.equal(preview.ok, true, preview.error ?? "");
  assert.equal(preview.target, "origin/release/windows");

  assert.equal(git(wt, "rev-parse", "HEAD"), mainTip);
  const reset = await app.request(`/api/sessions/${session.id}/reset`, {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({ clear: false }),
  });
  assert.equal(reset.status, 200, await reset.clone().text());
  assert.equal(git(wt, "rev-parse", "HEAD"), releaseTip);
});

test("handing a shelved task with a base branch to a running agent resets its checkout onto origin/<base>", async () => {
  const { repo, mainTip, releaseTip } = mkRepo("assign-reset");
  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: "idle-agent", agent: "claude", name: "idle-agent", nameSource: "process", cwd: repo,
    gitBranch: "main", gitRoot: repo, repoRoot: repo, pid: 303, tty: "ttys3", terminals: [], startedAt: 0,
  }]);
  registry.applyHook({
    agent: "claude", event: "Stop", sessionId: "idle-agent-session", cwd: repo, transcriptPath: null, env: {},
  });
  const session = registry.snapshot().sessions.find((s) => s.name === "idle-agent")!;
  assert.equal(session.state, "idle");
  registry.upsertTask(mkTask({
    id: "assign-based", status: "backlog", repoRoot: repo, baseBranch: "release/windows",
  }));
  assert.equal(git(repo, "rev-parse", "HEAD"), mainTip);

  // The REAL reset runs: no `reset` seam. The fixture has no pane, so the context clear cannot
  // be confirmed and the handover then stops - after the checkout has moved, which is what this
  // pins (`task-assign.test.ts` pins the same shape for a task with no base).
  const res = await new TaskManager(registry).assign("assign-based", session.id, {
    paneReady: async () => ({ ok: true }),
    confirmReset: true,
  });
  assert.equal(git(repo, "rev-parse", "HEAD"), releaseTip);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /clear/);
});

// --- what the agent is told ---

test("the delivered contract names the base branch only when the task has one", () => {
  const based = withTaskKindContract(mkTask({ kind: "ship", baseBranch: "release/windows" }), "Build it");
  assert.match(based, /This task's base branch is `release\/windows`/);
  assert.match(based, /gh pr create --base release\/windows/);
  assert.doesNotMatch(based, /primary repository only/);
  const plain = withTaskKindContract(mkTask({ kind: "ship" }), "Build it");
  assert.doesNotMatch(plain, /Base branch/);
});

test("a workflow binding's PR base is the task's for its primary repository, and the default for an attached one", () => {
  const task = { baseBranch: "release/windows", repoRoot: "/repo" };
  assert.equal(prBaseBranchFor(task, ""), "release/windows", "an empty root is the session's own checkout");
  assert.equal(prBaseBranchFor(task, "/repo"), "release/windows");
  assert.equal(prBaseBranchFor(task, "/attached"), null);
  assert.equal(prBaseBranchFor({ baseBranch: null, repoRoot: "/repo" }, ""), null);
  assert.equal(prBaseBranchFor(undefined, ""), null);
});

test("the workflow pull-request packets name the base branch the PR opens against", () => {
  const handoff = renderPrHandoff({
    workflowName: "Review", workflowVersion: 1, runId: "run-1", originalGoal: "Port it",
    skillCommand: "/mission-pull-request", workflowEvidence: false, repoRoot: null,
    baseBranch: "release/windows",
  });
  assert.match(handoff.payload, /Base branch: release\/windows - open the pull request against it \(gh pr create --base release\/windows\)/);
  const plain = renderPrHandoff({
    workflowName: "Review", workflowVersion: 1, runId: "run-1", originalGoal: "Port it",
    skillCommand: "/mission-pull-request", workflowEvidence: false, repoRoot: null,
  });
  assert.doesNotMatch(plain.payload, /Base branch/);

  const action = renderSessionAction({
    origin: { kind: "run", workflowName: "Review", workflowVersion: 1, runId: "run-1", repoRoot: null },
    actionName: "Pull Request", promptMarkdown: "Open the PR.", skillCommand: null,
    workflowEvidence: false, pullRequestGrant: true, baseBranch: "release/windows",
  });
  assert.ok(action.ok);
  assert.match(action.payload, /gh pr create --base release\/windows/);
  const other = renderSessionAction({
    origin: { kind: "run", workflowName: "Review", workflowVersion: 1, runId: "run-1", repoRoot: null },
    actionName: "Tidy", promptMarkdown: "Tidy up.", skillCommand: null,
    workflowEvidence: false, pullRequestGrant: false, baseBranch: "release/windows",
  });
  assert.ok(other.ok);
  assert.doesNotMatch(other.payload, /Base branch/, "an action that opens no PR is not told where one goes");
});
