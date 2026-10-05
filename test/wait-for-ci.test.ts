/**
 * Wait for CI, below the runtime: how CI is read, stored, decided and placed.
 *
 * - The Inspector's ONE PR query reads the head commit's check runs, and `fetchPr` maps them
 *   (driven here through a fake `gh`, so the query text and the mapping are both exercised).
 * - The observation is stored beside the adoption row, keyed to the commit it was read for,
 *   through a migration an existing database has to survive.
 * - `decideWaitForCi` is pure, so every outcome is stated with no daemon at all.
 * - Graph validation only accepts the node after a Pull Request action's `complete` route,
 *   and a path through it to End is still a shipping-only continuation.
 *
 * The runtime (engine, manager, repair packet, retry, disable) is in
 * `test/session-action-runtime.test.ts`, which already drives a real Pull Request action.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const home = mkdtempSync(join(tmpdir(), "mission-wait-for-ci-"));
process.env.MISSION_HOME = home;
// The fake `gh`: prints whatever the test last wrote, and records the query it was asked.
const ghDir = mkdtempSync(join(tmpdir(), "mission-wait-for-ci-gh-"));
const ghBin = join(ghDir, "gh");
writeFileSync(ghBin, `#!/bin/sh\nprintf '%s' "$@" > "${ghDir}/args"\ncat "${ghDir}/response.json"\n`);
chmodSync(ghBin, 0o755);
process.env.MISSION_GH_BIN = ghBin;
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ghDir, { recursive: true, force: true });
});

/** An `inspector_prs` from before the CI column, written out verbatim. */
function seedPreCiDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS inspector_prs (
      key TEXT PRIMARY KEY, url TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
      number INTEGER NOT NULL, repo_root TEXT, cwd TEXT, session_id TEXT, source TEXT NOT NULL,
      state TEXT NOT NULL, head_sha TEXT, review_posture TEXT, round INTEGER NOT NULL DEFAULT 0,
      last_reviewed_at INTEGER, last_error TEXT, fail_count INTEGER NOT NULL DEFAULT 0,
      last_fail_kind TEXT, next_attempt_at INTEGER, last_attempt_sha TEXT, merged_at INTEGER,
      merge_block TEXT, observed_head_sha TEXT, observed_state TEXT, observed_at INTEGER,
      head_ref_name TEXT, title TEXT, adopted_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  raw.prepare(
    `INSERT INTO inspector_prs (key, url, owner, repo, number, source, state, adopted_at, updated_at)
     VALUES ('owner/repo#7', 'https://github.com/owner/repo/pull/7', 'owner', 'repo', 7, 'hook', 'open', 1, 1)`,
  ).run();
  raw.close();
}
seedPreCiDb();

const { openDb, getInspectorCiObservation, getInspectorPr, recordInspectorCiObservation } =
  await import("../src/server/db.ts");
const { fetchPr } = await import("../src/server/inspector/github.ts");
const {
  CI_CHECK_SUMMARY_CHARS,
  WAIT_FOR_CI_FLAKE_REPORT_GRACE_MS,
  ciCheckRunsFromRollup,
  decideWaitForCi,
  initialWaitForCiState,
} = await import("../src/shared/wait-for-ci.ts");
const { FLAKY_TESTS_CHECK_NAME, parseFlakeSummary, renderFlakeSummary } = await import(
  "../src/shared/flake-report.ts"
);
const { validateWorkflowGraph } = await import("../src/shared/workflow-graph.ts");
const { sessionActionContinuationReachesOnlyEnd, waitForCiFollows } = await import(
  "../src/shared/workflow.ts"
);
const { waitForCiVerdict } = await import("../src/server/workflows/engine.ts");
const { WorkflowDraftNodeSchema } = await import("../src/shared/protocol.ts");
import type { CiCheckRun, CiObservation } from "../src/shared/wait-for-ci.ts";
import type { FlakeReport } from "../src/shared/flake-report.ts";
import type { WorkflowDraftGraph, PublishedWorkflowGraph } from "../src/shared/workflow.ts";

openDb();

const HEAD = "a".repeat(40);
const REPORT: FlakeReport = {
  version: 1,
  commit: HEAD,
  ref: "feature",
  pullRequest: 7,
  runUrl: "https://github.com/owner/repo/actions/runs/9",
  flakes: [{ key: "00000000000000aa", runner: "junit", file: "test/a.test.ts", name: "a > b", message: "boom" }],
  failures: [],
  errors: [],
  issues: [{ key: "00000000000000aa", number: 3, url: "https://github.com/owner/repo/issues/3", occurrences: 1, actionable: false }],
};

// ---- reading CI --------------------------------------------------------------------------

test("the rollup maps check runs and legacy statuses, and parses the full Flaky tests summary", () => {
  // Padded past the stored summary cap, so the marker at the END survives only because the
  // report is parsed before the summary is cut.
  const summary = `${"x".repeat(CI_CHECK_SUMMARY_CHARS * 2)}\n\n${renderFlakeSummary(REPORT)}`;
  const { checkRuns, flakeReport } = ciCheckRunsFromRollup([
    { name: "unit", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/unit", title: "ok", summary: "fine" },
    { name: "e2e", status: "IN_PROGRESS", conclusion: null, detailsUrl: null, title: null, summary: null },
    { name: "lint", status: "COMPLETED", conclusion: "TIMED_OUT", detailsUrl: "https://ci/lint", title: "slow", summary: null },
    { name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
    { name: FLAKY_TESTS_CHECK_NAME, status: "COMPLETED", conclusion: "NEUTRAL", title: "1 flaky test", summary },
    { context: "legacy/ci", state: "ERROR", targetUrl: "https://legacy", description: "broke" },
    { context: "legacy/pending", state: "EXPECTED" },
    { unknown: true },
  ], parseFlakeSummary);
  assert.deepEqual(checkRuns.map((run) => [run.name, run.state, run.conclusion]), [
    ["unit", "passing", "SUCCESS"],
    ["e2e", "pending", null],
    ["lint", "failing", "TIMED_OUT"],
    ["docs", "passing", "SKIPPED"],
    [FLAKY_TESTS_CHECK_NAME, "passing", "NEUTRAL"],
    ["legacy/ci", "failing", "ERROR"],
    ["legacy/pending", "pending", null],
  ]);
  assert.deepEqual(flakeReport, REPORT);
  const stored = checkRuns.find((run) => run.name === FLAKY_TESTS_CHECK_NAME)!;
  assert.equal(stored.summary!.length, CI_CHECK_SUMMARY_CHARS);
  assert.ok(stored.summary!.endsWith("..."));
});

test("fetchPr reads CI from the same query as the head, keyed to the head commit", async () => {
  writeFileSync(join(ghDir, "response.json"), JSON.stringify({
    data: { repository: { pullRequest: {
      state: "OPEN", headRefOid: HEAD, headRefName: "feature", isDraft: false, title: "t", body: "",
      createdAt: "2026-01-01T00:00:00Z", mergeable: "MERGEABLE", reviewDecision: null,
      commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { state: "FAILURE", contexts: { nodes: [
        { name: "unit", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/unit", title: "2 failed", summary: "a.test.ts" },
        { name: FLAKY_TESTS_CHECK_NAME, status: "COMPLETED", conclusion: "NEUTRAL", title: "1 flaky test", summary: renderFlakeSummary(REPORT) },
      ] } } } }] },
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      reviews: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } },
    } } },
  }));
  const result = await fetchPr(null, "owner", "repo", 7);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  const snapshot = result.ok ? result.value! : null;
  assert.equal(snapshot?.checks, "failing");
  assert.equal(snapshot?.ci?.headSha, HEAD);
  assert.deepEqual(snapshot?.ci?.checkRuns.map((run) => [run.name, run.state]), [
    ["unit", "failing"],
    [FLAKY_TESTS_CHECK_NAME, "passing"],
  ]);
  assert.equal(snapshot?.ci?.flakeReport?.flakes.length, 1);
});

test("the observation survives an upgraded database and reads back only while it parses", () => {
  // The row written before the column existed is still whole, and reads as "not looked at".
  assert.equal(getInspectorPr("owner/repo#7")?.url, "https://github.com/owner/repo/pull/7");
  assert.equal(getInspectorCiObservation("owner/repo#7"), null);
  const observation: CiObservation = {
    headSha: HEAD,
    observedAt: 5,
    checkRuns: [{ name: "unit", state: "passing", conclusion: "SUCCESS", detailsUrl: null, title: null, summary: null }],
    flakeReport: REPORT,
  };
  recordInspectorCiObservation("owner/repo#7", observation);
  assert.deepEqual(getInspectorCiObservation("owner/repo#7"), observation);
  assert.equal(getInspectorCiObservation("owner/repo#404"), null);
  openDb().prepare("UPDATE inspector_prs SET observed_ci_json = '{\"nope\":1}' WHERE key = 'owner/repo#7'").run();
  assert.equal(getInspectorCiObservation("owner/repo#7"), null);
});

// ---- deciding ------------------------------------------------------------------------------

const T0 = 1_000_000;
const state = (over: Partial<ReturnType<typeof initialWaitForCiState>> = {}) => ({
  ...initialWaitForCiState({
    pullRequestKey: "owner/repo#7",
    pullRequestUrl: "https://github.com/owner/repo/pull/7",
    pullRequestNumber: 7,
    expectedHeadOid: HEAD,
    timeoutMinutes: 45,
    now: T0,
  }),
  ...over,
});
const run = (name: string, runState: CiCheckRun["state"]): CiCheckRun => ({
  name,
  state: runState,
  conclusion: runState === "pending" ? null : runState === "failing" ? "FAILURE" : "SUCCESS",
  detailsUrl: null,
  title: null,
  summary: null,
});
const seen = (checkRuns: CiCheckRun[], headSha = HEAD, flakeReport: FlakeReport | null = null): CiObservation =>
  ({ headSha, observedAt: T0 + 1, checkRuns, flakeReport });

test("another head, no observation, and pending checks all wait", () => {
  assert.equal(decideWaitForCi(state(), null, T0 + 1).kind, "wait");
  const other = decideWaitForCi(state(), seen([run("unit", "failing")], "b".repeat(40)), T0 + 1);
  assert.equal(other.kind, "wait");
  assert.deepEqual(other.state.checkRuns, [], "another head's checks were recorded as this head's");
  const pending = decideWaitForCi(state(), seen([run("unit", "passing"), run("e2e", "pending")]), T0 + 1);
  assert.equal(pending.kind, "wait");
  assert.equal(pending.state.checkRuns.length, 2);
  // Even a failure waits while anything is still running, so the packet names every failure.
  assert.equal(decideWaitForCi(state(), seen([run("unit", "failing"), run("e2e", "pending")]), T0 + 1).kind, "wait");
  // Heads compare case-insensitively: both spellings are the same full object id.
  assert.equal(decideWaitForCi(state(), seen([run("unit", "passing")], HEAD.toUpperCase()), T0 + 1).state.checkRuns.length, 1);
});

test("a failing check fails the node, naming every failing check except Flaky tests", () => {
  const decision = decideWaitForCi(state(), seen([
    run("unit", "failing"),
    run("lint", "failing"),
    run("docs", "passing"),
    run(FLAKY_TESTS_CHECK_NAME, "failing"),
  ]), T0 + 1);
  assert.equal(decision.kind, "fail");
  if (decision.kind !== "fail") return;
  assert.deepEqual(decision.failing.map((check) => check.name), ["unit", "lint"]);
  assert.equal(decision.state.outcome, "fail");
});

test("all green with a Flaky tests check passes and records the report", () => {
  const decision = decideWaitForCi(state(), seen([run("unit", "passing"), run(FLAKY_TESTS_CHECK_NAME, "passing")], HEAD, REPORT), T0 + 1);
  assert.equal(decision.kind, "pass");
  assert.equal(decision.state.outcome, "pass");
  assert.deepEqual(decision.state.flakeReport, REPORT);
  // Only Flaky tests failing is still green: it never fails the node.
  assert.equal(decideWaitForCi(state(), seen([run("unit", "passing"), run(FLAKY_TESTS_CHECK_NAME, "failing")]), T0 + 1).kind, "pass");
});

test("green without a Flaky tests check waits out the grace period, then blocks", () => {
  const green = seen([run("unit", "passing")]);
  const first = decideWaitForCi(state(), green, T0 + 10);
  assert.equal(first.kind, "wait");
  assert.equal(first.state.greenWithoutReportSince, T0 + 10);
  const still = decideWaitForCi(first.state, green, T0 + 10 + WAIT_FOR_CI_FLAKE_REPORT_GRACE_MS - 1);
  assert.equal(still.kind, "wait");
  const blocked = decideWaitForCi(still.state, green, T0 + 10 + WAIT_FOR_CI_FLAKE_REPORT_GRACE_MS);
  assert.equal(blocked.kind, "block");
  if (blocked.kind === "block") assert.equal(blocked.code, "ci_flake_report_missing");
  // A report arriving within the grace period passes normally.
  const late = decideWaitForCi(first.state, seen([run("unit", "passing"), run(FLAKY_TESTS_CHECK_NAME, "passing")]), T0 + 20);
  assert.equal(late.kind, "pass");
});

test("the timeout blocks as missing CI when nothing appeared, and as a timeout otherwise", () => {
  const limit = T0 + 45 * 60_000;
  assert.equal(decideWaitForCi(state(), null, limit - 1).kind, "wait");
  const missing = decideWaitForCi(state(), null, limit);
  assert.equal(missing.kind === "block" && missing.code, "ci_missing");
  const otherHead = decideWaitForCi(state(), seen([run("unit", "pending")], "b".repeat(40)), limit);
  assert.equal(otherHead.kind === "block" && otherHead.code, "ci_missing");
  const running = decideWaitForCi(state(), seen([run("unit", "pending")]), limit);
  assert.equal(running.kind === "block" && running.code, "ci_timeout");
  assert.match(running.kind === "block" ? running.detail : "", /45 minutes/);
});

test("a node with no proven head blocks rather than guessing one", () => {
  const decision = decideWaitForCi(state({ expectedHeadOid: null }), seen([run("unit", "passing")]), T0 + 1);
  assert.equal(decision.kind === "block" && decision.code, "ci_pull_request_unknown");
});

test("the verdicts cite the attempt and carry each failing check's own words", () => {
  const failing = decideWaitForCi(state(), seen([{
    ...run("unit (node 24)", "failing"),
    title: "2 tests failed",
    summary: "test/a.test.ts failed twice",
    detailsUrl: "https://ci/unit",
  }]), T0 + 1);
  assert.equal(failing.kind, "fail");
  if (failing.kind !== "fail") return;
  const verdict = waitForCiVerdict(failing, "attempt-1");
  assert.equal(verdict?.verdict, "fail");
  if (verdict?.verdict !== "fail") return;
  assert.equal(verdict.requestedChanges[0]!.title, 'Fix the failing CI check "unit (node 24)"');
  assert.match(verdict.requestedChanges[0]!.rationale, /2 tests failed[\s\S]*failed twice[\s\S]*https:\/\/ci\/unit/);
  assert.deepEqual(verdict.requestedChanges[0]!.evidence, [{ kind: "check", path: "attempt-1", quote: "2 tests failed" }]);
  const passing = decideWaitForCi(state(), seen([run("unit", "passing"), run(FLAKY_TESTS_CHECK_NAME, "passing")], HEAD, REPORT), T0 + 1);
  if (passing.kind !== "pass") return assert.fail("expected a pass");
  assert.match(waitForCiVerdict(passing, "attempt-2")?.summary ?? "", /1 flaky test that passed on rerun/);
});

// ---- merge conflicts -------------------------------------------------------------------------

const conflict = (headSha = HEAD, baseRef: string | null = "main") =>
  ({ mergeable: "conflicting", headSha, baseRef }) as const;

test("a conflict on the expected head fails the node before any check, even with none", () => {
  for (const observation of [
    null,
    seen([]),
    seen([run("unit", "pending")]),
    seen([run("unit", "passing"), run(FLAKY_TESTS_CHECK_NAME, "passing")], HEAD, REPORT),
  ]) {
    const decision = decideWaitForCi(state(), observation, T0 + 1, conflict());
    assert.equal(decision.kind, "fail");
    if (decision.kind !== "fail") return;
    assert.deepEqual(decision.conflict, { baseRef: "main" });
    assert.deepEqual(decision.failing, []);
    assert.equal(decision.state.outcome, "fail");
  }
  // Before the timeout, too: a conflicting PR may never get checks, so it never reaches
  // `ci_missing`.
  const late = decideWaitForCi(state(), null, T0 + 46 * 60_000, conflict(HEAD.toUpperCase()));
  assert.equal(late.kind === "fail" && late.conflict?.baseRef, "main");
});

test("a conflict observed on another head waits, and a mergeable one lets the checks decide", () => {
  const other = decideWaitForCi(state(), null, T0 + 1, conflict("b".repeat(40)));
  assert.equal(other.kind, "wait");
  const mergeable = { mergeable: "mergeable", headSha: HEAD, baseRef: "main" } as const;
  assert.equal(decideWaitForCi(state(), seen([run("unit", "pending")]), T0 + 1, mergeable).kind, "wait");
  assert.equal(decideWaitForCi(state(), seen([run("unit", "failing")]), T0 + 1, mergeable).kind, "fail");
});

test("push, then UNKNOWN, then resolved: the kept pre-repair conflict never fails the repair head", () => {
  const before = "b".repeat(40);
  // The node watches the repair push. GitHub has answered UNKNOWN for it, so the poller kept
  // the conflict observed on the head before the push, with that head.
  const repair = state({ expectedHeadOid: HEAD });
  const kept = decideWaitForCi(repair, null, T0 + 1, conflict(before));
  assert.equal(kept.kind, "wait");
  assert.equal(kept.state.outcome, null);
  // GitHub answers for the repair head: mergeable, so the checks decide.
  const resolved = { mergeable: "mergeable", headSha: HEAD, baseRef: "main" } as const;
  const passed = decideWaitForCi(
    kept.state,
    seen([run("unit", "passing"), run(FLAKY_TESTS_CHECK_NAME, "passing")], HEAD, REPORT),
    T0 + 2,
    resolved,
  );
  assert.equal(passed.kind, "pass");
});

test("a conflict verdict asks for one merge-in repair and forbids rebasing", () => {
  const decision = decideWaitForCi(state(), null, T0 + 1, conflict());
  if (decision.kind !== "fail") return assert.fail("expected a fail");
  const verdict = waitForCiVerdict(decision, "attempt-9");
  assert.equal(verdict?.verdict, "fail");
  if (verdict?.verdict !== "fail") return;
  assert.equal(verdict.requestedChanges.length, 1);
  const change = verdict.requestedChanges[0]!;
  assert.equal(change.title, "Resolve merge conflicts with `main`");
  assert.match(change.rationale, /git fetch origin main/);
  assert.match(change.rationale, /git merge origin\/main/);
  assert.match(change.rationale, /Do not rebase or force-push\./);
  assert.equal(change.evidence[0]!.path, "attempt-9");
  assert.match(verdict.summary, /conflicts with `main`/);

  const unknownBase = decideWaitForCi(state(), null, T0 + 1, conflict(HEAD, null));
  if (unknownBase.kind !== "fail") return assert.fail("expected a fail");
  const named = waitForCiVerdict(unknownBase, "attempt-10");
  assert.equal(named?.verdict === "fail" && named.requestedChanges[0]!.title, "Resolve merge conflicts with its base branch");
});

// ---- placing -------------------------------------------------------------------------------

const action = (completion: "pull_request" | "session_turn", id = `action-${completion}`) => ({
  id,
  archivedAt: null,
  completion: { kind: completion },
}) as never;

function shippingGraph(ciSource: { node: string; port: "complete" | "pass" }): WorkflowDraftGraph {
  return {
    nodes: [
      { id: "s", kind: "session", position: { x: 0, y: 0 } },
      { id: "check", kind: "check", slot: "lint", position: { x: 100, y: 0 } },
      { id: "pr", kind: "session_action", sessionActionId: "action-pull_request", position: { x: 200, y: 0 } },
      { id: "ci", kind: "wait_for_ci", timeoutMinutes: 45, position: { x: 300, y: 0 } },
      { id: "end", kind: "end", outcome: "Done", position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "s", sourcePort: "submitted", target: "check", targetPort: "activate" },
      { id: "e2", source: "check", sourcePort: "fail", target: "s", targetPort: "return_for_changes" },
      { id: "e3", source: "check", sourcePort: "pass", target: "pr", targetPort: "activate" },
      ...(ciSource.node === "pr"
        ? [{ id: "e4", source: "pr", sourcePort: "complete" as const, target: "ci", targetPort: "activate" as const }]
        : [
            { id: "e4", source: "pr", sourcePort: "complete" as const, target: "end", targetPort: "terminal" as const },
            { id: "e4b", source: ciSource.node, sourcePort: ciSource.port, target: "ci", targetPort: "activate" as const },
          ]),
      { id: "e5", source: "ci", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "e6", source: "ci", sourcePort: "fail", target: "s", targetPort: "return_for_changes" },
    ],
  };
}

test("Wait for CI is valid only after a Pull Request action's complete route", () => {
  const valid = validateWorkflowGraph({
    graph: shippingGraph({ node: "pr", port: "complete" }),
    sessionActions: [action("pull_request")],
    completionPolicy: { kind: "none" },
  });
  assert.deepEqual(valid.diagnostics, []);
  const afterCheck = validateWorkflowGraph({ graph: shippingGraph({ node: "check", port: "pass" }) });
  assert.ok(afterCheck.diagnostics.some((item) => item.code === "wait_for_ci_placement" && item.nodeId === "ci"));
  const afterOtherAction = validateWorkflowGraph({
    graph: shippingGraph({ node: "pr", port: "complete" }),
    sessionActions: [action("session_turn", "action-pull_request")],
  });
  assert.ok(afterOtherAction.diagnostics.some((item) => item.code === "wait_for_ci_placement"));
  // The timeout is bounded by the persisted schema, not by the validator.
  assert.equal(WorkflowDraftNodeSchema.safeParse({ id: "ci", kind: "wait_for_ci", timeoutMinutes: 4, position: { x: 0, y: 0 } }).success, false);
  assert.equal(WorkflowDraftNodeSchema.safeParse({ id: "ci", kind: "wait_for_ci", timeoutMinutes: 240, position: { x: 0, y: 0 } }).success, true);
  assert.equal(WorkflowDraftNodeSchema.safeParse({ id: "ci", kind: "wait_for_ci", timeoutMinutes: 241, position: { x: 0, y: 0 } }).success, false);
});

test("a continuation through Wait for CI to End is still shipping-only, and owns CI", () => {
  const graph = shippingGraph({ node: "pr", port: "complete" }) as unknown as PublishedWorkflowGraph;
  assert.equal(sessionActionContinuationReachesOnlyEnd(graph, "pr"), true);
  assert.equal(waitForCiFollows(graph, "pr"), true);
  const withoutCi: PublishedWorkflowGraph = {
    nodes: graph.nodes.filter((node) => node.id !== "ci"),
    edges: [
      ...graph.edges.filter((edge) => edge.source !== "ci" && edge.target !== "ci"),
      { id: "e4", source: "pr", sourcePort: "complete", target: "end", targetPort: "terminal" },
    ],
  };
  assert.equal(sessionActionContinuationReachesOnlyEnd(withoutCi, "pr"), true);
  assert.equal(waitForCiFollows(withoutCi, "pr"), false);
  // A reviewer after Wait for CI makes it an ordinary evaluator-bound continuation again.
  const reviewed: PublishedWorkflowGraph = {
    nodes: [...graph.nodes, { id: "late", kind: "check", slot: "lint", position: { x: 0, y: 0 } }],
    edges: graph.edges.map((edge) => edge.id === "e5" ? { ...edge, target: "late", targetPort: "activate" } : edge),
  };
  assert.equal(sessionActionContinuationReachesOnlyEnd(reviewed, "pr"), false);
});


test("the PR card and Wait for CI classify a check by one shared rule", async () => {
  const { classifyCheckEntry } = await import("../src/shared/ci-checks.ts");
  const { readFileSync } = await import("node:fs");
  assert.equal(classifyCheckEntry({ status: "IN_PROGRESS" }), "pending");
  assert.equal(classifyCheckEntry({ status: "COMPLETED", conclusion: "stale" }), "failing");
  assert.equal(classifyCheckEntry({ status: "COMPLETED", conclusion: "NEUTRAL" }), "passing");
  assert.equal(classifyCheckEntry({ state: "EXPECTED" }), "pending");
  assert.equal(classifyCheckEntry({ state: "ERROR" }), "failing");
  assert.equal(classifyCheckEntry({ other: 1 }), null);
  for (const path of ["../src/server/pr.ts", "../src/shared/wait-for-ci.ts"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /classifyCheckEntry\(/, path);
    assert.doesNotMatch(source, /FAIL_CONCLUSIONS/, `${path} keeps its own copy of the rule`);
  }
});

test("which CI blocks retry is read from the recovery table, and only those offer retry", async () => {
  const { WORKFLOW_PHASE_RECOVERY, infrastructureRecoveryAvailable } = await import("../src/server/workflows/recovery.ts");
  const { WAIT_FOR_CI_BLOCK_CODES } = await import("../src/shared/wait-for-ci.ts");
  const failed = { mode: "full_workflow", status: "failed", triggerSource: "manual", triggerKey: "k" } as never;
  for (const code of WAIT_FOR_CI_BLOCK_CODES) {
    assert.equal(
      infrastructureRecoveryAvailable({ status: "blocked", phase: code }, failed, true),
      WORKFLOW_PHASE_RECOVERY[code] === "retry",
      code,
    );
  }
  assert.equal(WORKFLOW_PHASE_RECOVERY.ci_pull_request_unknown, "resume");
});
