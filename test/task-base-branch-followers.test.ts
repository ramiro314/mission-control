import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { trackedTaskManagers } from "./helpers/task-manager.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import { parseTestingConfig } from "../src/shared/testing-config.ts";
import {
  emptyWorkflowCommandView,
  type PublishedWorkflowGraph,
  type WorkflowBinding,
  type WorkflowCheckSlot,
  type WorkflowContextSnapshot,
} from "../src/shared/workflow.ts";
import { FIXTURE_RUN_INTENT } from "./helpers/workflow-run-intent.ts";

// What follows a task's base branch once it has one, after dispatch: the diff its checks and
// Personas measure, the tests its affected-tests check selects, the conflict fix its reactions
// ask for, and the merge watcher that completes it and releases its dependents. Every fixture
// has `release/windows` one change apart from `main`, so measuring from the wrong one shows.

const home = mkdtempSync(join(tmpdir(), "mission-base-branch-followers-home-"));
const repos = mkdtempSync(join(tmpdir(), "mission-base-branch-followers-repos-"));
process.env.HARNESS_HOME = home;

const { Registry, noteKeyFor } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const taskManager = trackedTaskManagers(TaskManager);
const { pollAndReconcilePrs } = await import("../src/server/pr.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { taskWorkEpisodeForTask } = await import("../src/server/db.ts");
const { changedPathsSince, deletedPathsSince, computeSessionDiff } = await import("../src/server/diff.ts");
const { selectAffectedTests } = await import("../src/server/test-selection.ts");
const { CheckRuntime } = await import("../src/server/workflows/check-runtime.ts");
const { runCheck } = await import("../src/server/workflows/checks.ts");
const { workflowPullRequestConflictContract } = await import("../src/server/workflows/agent-contract.ts");
const { renderSessionAction } = await import("../src/server/workflows/feedback.ts");
const { captureBoundaryChanged, probeMatchesEvidence, readWorkflowContextRaw, readWorkflowEvidenceProbe } =
  await import("../src/server/workflows/context.ts");
const { WorkflowStore, workflowJson } = await import("../src/server/workflows/store.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { openDb } = await import("../src/server/db.ts");

after(() => {
  for (const dir of [home, repos]) rmSync(dir, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@test", "-c", "user.name=t", ...args], { stdio: "pipe" })
    .toString()
    .trim();

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/**
 * A feature worktree cut from `origin/release/windows`, which carries a source file, a test and
 * a file the feature then deletes that `main` never had. The feature adds one source file and
 * one test, and deletes `src/legacy.ts`.
 */
function featureOnRelease(name: string): string {
  const repo = join(repos, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  write(repo, { "file.txt": "main\n", "test/main.test.ts": "import '../file.txt';\n" });
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "main");
  const origin = join(repos, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-qu", "origin", "main");
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  git(repo, "checkout", "-qb", "release/windows");
  write(repo, {
    "src/windows.ts": "export const win = 1;\n",
    "test/windows.test.ts": "import '../src/windows.ts';\n",
    "src/legacy.ts": "export const old = 1;\n",
  });
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "windows");
  git(repo, "push", "-q", "origin", "release/windows");
  git(repo, "checkout", "-q", "main");
  git(repo, "fetch", "-q", "origin");
  git(repo, "remote", "set-head", "origin", "main");

  const wt = join(repos, `${name}-wt`);
  git(repo, "worktree", "add", "-q", "-b", "feat/port", wt, "origin/release/windows");
  write(wt, {
    "src/feature.ts": "export const feature = 1;\n",
    "test/feature.test.ts": "import '../src/feature.ts';\n",
  });
  rmSync(join(wt, "src/legacy.ts"));
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", "feature");
  return realpathSync(wt);
}

// --- the diff and the affected-tests base ---

test("a task's changes are measured from origin/<base>, and from origin's default without one", async () => {
  const wt = featureOnRelease("diff-base");

  const based = await changedPathsSince(wt, "release/windows");
  assert.deepEqual(based, { ok: true, repoRoot: wt, paths: ["src/feature.ts", "test/feature.test.ts"] });
  const deleted = await deletedPathsSince(wt, "release/windows");
  assert.deepEqual(deleted.ok && deleted.paths, ["src/legacy.ts"]);

  // Unchanged without a base: origin's default, which counts the release branch's own commits.
  const plain = await changedPathsSince(wt);
  assert.deepEqual(plain.ok && plain.paths, ["src/feature.ts", "src/windows.ts", "test/feature.test.ts", "test/windows.test.ts"]);
  const plainDeleted = await deletedPathsSince(wt);
  assert.deepEqual(plainDeleted.ok && plainDeleted.paths, [], "main never had src/legacy.ts");

  const diff = await computeSessionDiff(wt, undefined, "release/windows");
  assert.equal(diff.ok, true);
  assert.equal(diff.base, "release/windows");
  assert.equal(diff.filesChanged, 3);
  assert.doesNotMatch(diff.patch, /windows\.ts/);
  const plainDiff = await computeSessionDiff(wt);
  assert.equal(plainDiff.base, "main");
  assert.match(plainDiff.patch, /src\/windows\.ts/);
});

test("a base branch that is not fetched fails the measurement rather than falling back to the default", async () => {
  const wt = featureOnRelease("diff-missing-base");
  const changed = await changedPathsSince(wt, "release/gone");
  assert.deepEqual(changed, {
    ok: false,
    reason: "base branch release/gone is not in this repository's remote-tracking refs",
  });
  assert.equal((await deletedPathsSince(wt, "release/gone")).ok, false);
  const diff = await computeSessionDiff(wt, undefined, "release/gone");
  assert.equal(diff.ok, false);
  assert.match(diff.error ?? "", /base branch release\/gone is not in this repository's remote-tracking refs/);
});

test("affected tests are selected from the change against origin/<base>", async () => {
  const wt = featureOnRelease("selection-base");
  const parsed = parseTestingConfig(JSON.stringify({ tests: { patterns: ["test/*.test.ts"] } }));
  assert.ok(parsed.ok);

  const based = await selectAffectedTests(wt, parsed.config, {}, "release/windows");
  assert.deepEqual(based.ok && based.files, [{ path: "test/feature.test.ts", reason: "changed" }]);
  const plain = await selectAffectedTests(wt, parsed.config);
  assert.deepEqual(
    plain.ok && plain.files.map((file) => file.path),
    ["test/feature.test.ts", "test/windows.test.ts"],
    "without a base, the release branch's own test reads as changed",
  );
});

test("an affected-tests check hands its base branch to test selection", async () => {
  const root = realpathSync(mkdtempSync(join(repos, "check-tree-")));
  write(root, { ".mission/testing.json": JSON.stringify({ tests: { patterns: ["test/*.test.ts"] } }) });
  const asked: (string | null)[] = [];
  const leases = {
    acquireForAttempt: async () => root,
    releaseForAttempt: async () => ({ outcome: "returned" }),
    handOffForReclaim: () => {},
    unresolvedLeaseForNode: () => false,
    processes: { record: () => {}, clear: () => {} },
  } as unknown as CheckLeaseManager;
  const runtime = new CheckRuntime(leases, {
    platform: () => ({ supported: true, note: "" }),
    resolveCommit: async (_repo, sha) => sha,
    testSelection: {
      changedPaths: async (_tree, baseBranch) => {
        asked.push(baseBranch);
        return { ok: true, repoRoot: root, paths: [] };
      },
      deletedPaths: async (_tree, baseBranch) => {
        asked.push(baseBranch);
        return { ok: true, repoRoot: root, paths: [] };
      },
      trackedFiles: async () => [],
    },
  });
  const execute = runtime.executorFor({ attemptId: "attempt-1", submissionId: "s", nodeId: "n", testLease: false });
  const check = (baseBranch: string | null) =>
    runCheck({
      slot: "affected-tests",
      command: { ...emptyWorkflowCommandView("affected-tests"), defaultCommand: ["node", "--test", "--test-reporter-destination={junit}", "{files}"] },
      policy: { checksEnabled: true, repoAllowlist: [root] },
      reserveRun: null,
      cwd: root,
      repoRoot: root,
      headSha: "a".repeat(40),
      baseBranch,
    }, { execute, checkoutSubpath: async () => "" });

  await check("release/windows");
  await check(null);
  assert.deepEqual(asked, ["release/windows", "release/windows", null, null]);
});

// --- the base a workflow resolves for its binding ---

/** A session discovered in `cwd`, running a task bound to it with `baseBranch`. */
function sessionRunning(id: string, cwd: string, repoRoot: string, baseBranch: string | null) {
  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: id,
    agent: "claude",
    name: id,
    nameSource: "process",
    cwd,
    gitBranch: "feat/port",
    gitRoot: cwd,
    repoRoot: cwd,
    pid: 1,
    tty: `tty-${id}`,
    terminals: [],
    startedAt: 1,
  } as DiscoveredSession]);
  registry.upsertTask(mkTask({
    id: `task-${id}`,
    status: "running",
    sessionId: id,
    worktreePath: cwd,
    repoRoot,
    baseBranch,
  }));
  const session = registry.getSession(id)!;
  const binding = { id: `binding-${id}`, sessionId: id, noteKey: noteKeyFor(session), repoRoot: "" } as WorkflowBinding;
  return { registry, binding };
}

test("the diff a workflow captures for its Personas is measured from the bound task's base", async () => {
  const wt = featureOnRelease("capture-base");
  const repo = realpathSync(join(repos, "capture-base"));

  const based = sessionRunning("capture-based", wt, repo, "release/windows");
  const captured = await readWorkflowContextRaw(based.registry, based.binding);
  assert.match(captured.raw.evidence.diff, /src\/feature\.ts/);
  assert.doesNotMatch(captured.raw.evidence.diff, /src\/windows\.ts/, "the base branch's own commit is not this change");
  // The cheap probe answers from the same base, or every repair round would read as moved.
  const probe = await readWorkflowEvidenceProbe(based.registry, based.binding);
  assert.equal(probeMatchesEvidence(probe, captured.context.evidence), true);
  assert.equal(await captureBoundaryChanged(based.registry, based.binding, captured.boundary), false);

  const plain = sessionRunning("capture-plain", wt, repo, null);
  const plainCapture = await readWorkflowContextRaw(plain.registry, plain.binding);
  assert.match(plainCapture.raw.evidence.diff, /src\/windows\.ts/, "no base measures from main, as before");
  assert.equal(probeMatchesEvidence(await readWorkflowEvidenceProbe(based.registry, based.binding), plainCapture.context.evidence), false);
});

/** Session -> one affected-tests Check -> End. */
const checkGraph: PublishedWorkflowGraph = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "gate", kind: "check", slot: "affected-tests", position: { x: 200, y: 0 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 400, y: 0 } },
  ],
  edges: [
    { id: "s-gate", source: "session", sourcePort: "submitted", target: "gate", targetPort: "activate" },
    { id: "gate-pass", source: "gate", sourcePort: "pass", target: "end", targetPort: "terminal" },
    { id: "gate-fail", source: "gate", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
  ],
};

const checkContext: WorkflowContextSnapshot = {
  primaryGoal: { rawPrompt: "Port it", refined: null, sourceNoteKey: "note" },
  humanDecisions: [],
  constraints: [],
  acceptanceCriteria: [],
  priorPersonaFeedback: [],
  session: { agent: "claude", name: "work", cwd: "/repo", branch: "feat/port" },
  evidence: {
    headSha: "a".repeat(40),
    diffFingerprint: "diff",
    diff: "patch",
    diffTruncated: false,
    workingTreeDirty: false,
    workingTreeStatus: [],
    workingTreeStatusTruncated: false,
    transcript: [],
    transcriptAnchor: null,
    transcriptTruncated: false,
    standards: [],
    standardsTruncated: false,
  },
  compaction: { status: "fallback", runner: null, model: null, error: null },
};

/**
 * Run one affected-tests Check through the daemon's own WorkflowManager and its engine, for a
 * binding of the session running a task with `baseBranch`, and return the base the executor saw.
 */
async function checkBaseFor(id: string, baseBranch: string | null, bindingRepoRoot = ""): Promise<string | null | undefined> {
  const db = openDb();
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, '', '{"nodes":[],"edges":[]}', '{"kind":"none"}', ?, 1, ?, NULL, 1, 1)`,
  ).run(`workflow-${id}`, `Review ${id}`, `review-${id}`, defaults, `version-${id}`);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES (?, ?, 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(`version-${id}`, `workflow-${id}`, JSON.stringify(checkGraph), defaults);

  const registry = new Registry();
  registry.upsertTask(mkTask({ id: `task-${id}`, status: "running", sessionId: `session-${id}`, repoRoot: "/repo", baseBranch }));
  const store = new WorkflowStore();
  const binding = store.insertBinding({
    id: `binding-${id}`,
    workflowVersionId: `version-${id}`,
    noteKey: `note-${id}`,
    sessionId: `session-${id}`,
    sessionAgent: "claude",
    sessionName: id,
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    repoRoot: bindingRepoRoot,
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });
  store.createInitialSubmission(
    { id: `run-${id}`, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: `manual:${id}`, now: 2 },
    { id: `submission-${id}`, triggerSource: "manual", triggerKey: `manual:${id}`, context: {}, evidence: {}, now: 2 },
  );
  store.updateSubmissionCapture(`submission-${id}`, {
    context: workflowJson(checkContext),
    evidence: workflowJson(checkContext.evidence),
    fingerprint: `fingerprint-${id}`,
    status: "running",
  }, 3);

  const seen: (string | null | undefined)[] = [];
  const manager = new WorkflowManager(registry, store, {
    engine: {
      concurrency: 1,
      retryBaseMs: 1,
      workflowPolicy: () => ({
        liveEnabled: false,
        repoAllowlist: ["/repo"],
        kindWorkflowDefaults: { ship: null },
        retention: { rawEvidenceDays: 30, completedRunDays: 180, maxCompletedRuns: 1_000 },
        checksEnabled: true,
        checkTestLease: false,
        checkTestConcurrency: null,
        skipPassedJudges: true,
      }),
      workflowCommand: (slot: WorkflowCheckSlot) => ({
        ...emptyWorkflowCommandView(slot),
        overrides: [{ repoRoot: "/repo", command: ["node", "--test", "--test-reporter-destination={junit}", "{files}"] }],
      }),
      checkDeps: () => ({
        execute: async (request: { baseBranch?: string | null }) => {
          seen.push(request.baseBranch);
          return { kind: "exited" as const, exitCode: 0, output: "", truncatedBytes: 0 };
        },
      }),
    },
  });
  manager.engine.start();
  manager.engine.activateSubmission(`submission-${id}`);
  const started = Date.now();
  while (seen.length === 0) {
    if (Date.now() - started > 5_000) throw new Error("the check never ran");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await manager.engine.stop();
  return seen[0];
}

test("a workflow check is handed the bound task's base branch by the manager's own wiring", async () => {
  assert.equal(await checkBaseFor("check-based", "release/windows"), "release/windows");
  assert.equal(await checkBaseFor("check-plain", null), null, "a task with no base measures from the default");
  assert.equal(
    await checkBaseFor("check-attached", "release/windows", "/attached"),
    null,
    "an attached repository keeps its own default branch",
  );
});

// --- merge-conflict reactions ---

test("the workflow PR action asks for the conflict fix against the task's base branch", () => {
  const based = workflowPullRequestConflictContract("release/windows");
  assert.match(based, /merge conflicts with its base branch `release\/windows`/);
  assert.match(based, /git fetch origin release\/windows`, then `git merge origin\/release\/windows`/);
  assert.match(workflowPullRequestConflictContract(), /git merge origin\/<base>/, "unchanged without a base");

  const action = renderSessionAction({
    origin: { kind: "run", workflowName: "Review", workflowVersion: 1, runId: "run-1", repoRoot: null },
    actionName: "Pull Request", promptMarkdown: "Open the PR.", skillCommand: null,
    workflowEvidence: false, pullRequestGrant: true, pullRequestConflicts: true, baseBranch: "release/windows",
  });
  assert.ok(action.ok);
  assert.match(action.payload, /git merge origin\/release\/windows/);
});

// --- the merge watcher ---

const NOW = 5_000_000;

function discovered(id: string, cwd: string): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: `agent-${id}`,
    nameSource: "process",
    cwd,
    gitBranch: "feat/port",
    gitRoot: "/repo",
    repoRoot: "/repo",
    pid: 100,
    tty: null,
    terminals: [],
    startedAt: 0,
  };
}

/**
 * A task with base branch `release/windows` bound to its agent's work episode, with a backlog
 * task declaring a dependency on it.
 */
function withDependent(id: string, baseBranch: string | null = "release/windows") {
  setShippingConfig({ closeSessionAfterMerge: false });
  const registry = new Registry();
  const tasks = taskManager(registry);
  const taskId = `task-${id}`;
  const cwd = `/repo/${id}`;
  registry.applyDiscovery([discovered(id, cwd)]);
  registry.applyHook({ agent: "claude", event: "Stop", sessionId: `${id}-episode`, cwd, transcriptPath: null, env: {} });
  registry.upsertTask(mkTask({
    id: taskId,
    title: "Port it",
    status: "running",
    sessionId: id,
    worktreePath: cwd,
    homeName: "Port it",
    repoRoot: "/repo",
    baseBranch,
  }));
  registry.bindTaskToWorkEpisode(taskId, id);
  registry.upsertTask(mkTask({
    id: `${id}-dependent`,
    title: "The next ticket",
    status: "backlog",
    repoRoot: "/repo",
    dependencies: [{
      type: "task",
      taskId,
      title: "Port it",
      sessionId: null,
      episodeId: null,
      agentSessionId: null,
      branch: null,
      prUrl: null,
      selectedAt: 1,
      satisfiedAt: null,
    }],
  }));
  const episode = registry.workEpisodeForSession(id)!;
  /** `gh` reporting the session's branch PR in `state`, merged into `baseRef` when merged. */
  const branchPoll = (url: string, state: "open" | "merged", baseRef: string) =>
    registry.reconcilePrs(
      new Map([[id, {
        url,
        number: 1,
        state,
        checks: "passing" as const,
        branch: "feat/port",
        agentSessionId: `${id}-episode`,
        episodeId: episode.episodeId,
        createdAt: episode.startedAt,
        mergedAt: state === "merged" ? NOW : null,
        headSha: "head",
        worktreeHeadSha: "head",
        baseRef,
      }]]),
      new Set(),
    );
  /** The agent goes away, so only the by-URL poller can see the merge. */
  const depart = () => {
    registry.applyDiscovery([]);
    registry.emit("event", { type: "session_remove", id });
  };
  /** One by-URL poll pass in which `url` reports merged into `baseRef` (null: `gh` named none). */
  const urlPoll = (url: string, baseRef: string | null) =>
    pollAndReconcilePrs(
      registry,
      async () => null,
      async (candidate) => (candidate === url ? { state: "merged" as const, mergedAt: NOW, baseRef } : null),
    );
  const dependent = () => registry.getTask(`${id}-dependent`)!;
  return { registry, tasks, taskId, branchPoll, depart, urlPoll, dependent };
}

test("a task's PR merged into its non-default base completes it, and its dependent becomes dispatchable", async () => {
  const url = "https://github.com/example/repo/pull/900";
  const f = withDependent("lands-on-base");
  f.branchPoll(url, "open", "release/windows");
  f.depart();
  assert.equal(f.registry.getTask(f.taskId)?.status, "failed", "no outcome recorded yet");
  assert.equal(f.tasks.dependencyBlockers(f.dependent())[0]?.state, "stopped");

  await f.urlPoll(url, "release/windows");

  const done = f.registry.getTask(f.taskId)!;
  assert.equal(done.status, "done");
  assert.equal(done.outcomeUrl, url);
  assert.notEqual(f.dependent().dependencies[0]?.satisfiedAt, null, "stamped on the edge");
  assert.deepEqual(f.tasks.dependencyBlockers(f.dependent()), []);
});

test("a task's PR merged into some other branch completes nothing and releases no dependent", async () => {
  const url = "https://github.com/example/repo/pull/901";
  const f = withDependent("lands-elsewhere");
  f.branchPoll(url, "open", "release/windows");
  f.depart();

  await f.urlPoll(url, "main");

  assert.equal(f.registry.getTask(f.taskId)?.status, "failed");
  assert.equal(taskWorkEpisodeForTask(f.taskId)?.mergedAt, null, "the merge is not recorded as this task's");
  assert.equal(f.dependent().dependencies[0]?.satisfiedAt, null);
  assert.equal(f.tasks.dependencyBlockers(f.dependent())[0]?.state, "stopped");
});

test("the branch poller records a merge only into the task's base branch", () => {
  const wrong = withDependent("branch-elsewhere");
  wrong.branchPoll("https://github.com/example/repo/pull/902", "merged", "main");
  assert.equal(taskWorkEpisodeForTask(wrong.taskId)?.mergedAt, null);
  assert.equal(wrong.dependent().dependencies[0]?.satisfiedAt, null);

  const right = withDependent("branch-on-base");
  right.branchPoll("https://github.com/example/repo/pull/903", "merged", "release/windows");
  assert.equal(taskWorkEpisodeForTask(right.taskId)?.mergedAt, NOW);
  assert.notEqual(right.dependent().dependencies[0]?.satisfiedAt, null, "stamped on the edge");
  assert.deepEqual(right.tasks.dependencyBlockers(right.dependent()), []);
});

test("a merge gh reports with no base branch does not count for a task that names one", async () => {
  const url = "https://github.com/example/repo/pull/905";
  const f = withDependent("lands-unnamed");
  f.branchPoll(url, "open", "release/windows");
  f.depart();

  await f.urlPoll(url, null);

  assert.equal(f.registry.getTask(f.taskId)?.status, "failed");
  assert.equal(taskWorkEpisodeForTask(f.taskId)?.mergedAt, null);
  assert.equal(f.tasks.dependencyBlockers(f.dependent())[0]?.state, "stopped");
});

test("a task with no base branch completes on a merge into any branch, exactly as before", async () => {
  const url = "https://github.com/example/repo/pull/904";
  const f = withDependent("no-base", null);
  f.branchPoll(url, "open", "main");
  f.depart();

  await f.urlPoll(url, "some/other");

  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  assert.deepEqual(f.tasks.dependencyBlockers(f.dependent()), []);
});
