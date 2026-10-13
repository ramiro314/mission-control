import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PersonaVerdictSchema,
  WorkflowCheckOutcomeSchema,
} from "../src/shared/protocol.ts";
import {
  AFFECTED_TESTS_LIMITS,
  WORKFLOW_EXECUTION_LIMITS,
  commandTemplateProblem,
  emptyWorkflowCommandView,
  type WorkflowCheckOutcome,
  type WorkflowTestFailure,
} from "../src/shared/workflow.ts";
import { CheckRuntime } from "../src/server/workflows/check-runtime.ts";
import type { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import type { CheckSpawnOutcome, SupervisedCheckRequest } from "../src/server/workflows/check-supervisor.ts";
import { runCheck } from "../src/server/workflows/checks.ts";
import { checkVerdict } from "../src/server/workflows/engine.ts";

// The affected-tests executor, end to end through `runCheck`, with only the two things that
// would need a real pool and a real suite stubbed: the lease manager hands back a fixture tree,
// and the "test runner" is a function that writes the JUnit file the template named.

const TEMPLATE = ["node", "--test", "--test-reporter=junit", "--test-reporter-destination={junit}", "{files}"];

function tree(testing: unknown | null): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "affected-tests-tree-")));
  if (testing !== null) {
    mkdirSync(join(root, ".mission"));
    writeFileSync(join(root, ".mission/testing.json"), JSON.stringify(testing));
  }
  return root;
}

function junit(root: string, cases: { file: string; name: string; failure?: string }[]): string {
  const body = cases.map((c) => c.failure === undefined
    ? `<testcase name="${c.name}" classname="test" file="${join(root, c.file)}"/>`
    : `<testcase name="${c.name}" classname="test" file="${join(root, c.file)}"><failure message="${c.failure}">stack for ${c.name}</failure></testcase>`);
  return `<?xml version="1.0"?><testsuites>${body.join("")}</testsuites>`;
}

type Run = { argv: string[]; files: string[] };
type Answer = { exitCode: number; xml?: string };

function harness(options: {
  root: string;
  changed: string[];
  tracked: string[];
  answer: (run: Run, index: number) => Answer;
  template?: string[];
  budget?: { released: number };
}) {
  const runs: Run[] = [];
  let released = 0;
  const leases = {
    acquireForAttempt: async () => options.root,
    releaseForAttempt: async () => {
      released++;
      return { outcome: "returned" };
    },
    handOffForReclaim: () => {},
    unresolvedLeaseForNode: () => false,
    processes: { record: () => {}, clear: () => {} },
  } as unknown as CheckLeaseManager;
  const supervise = async (request: SupervisedCheckRequest): Promise<CheckSpawnOutcome> => {
    const argv = [...request.command];
    const dest = argv.find((arg) => arg.startsWith("--test-reporter-destination="))!;
    const junitPath = dest.slice("--test-reporter-destination=".length);
    const files = argv.slice(TEMPLATE.length - 1);
    const run = { argv, files };
    const answer = options.answer(run, runs.length);
    runs.push(run);
    if (answer.xml !== undefined) writeFileSync(junitPath, answer.xml);
    return {
      result: { kind: "exited", exitCode: answer.exitCode, output: `run ${runs.length}\n`, truncatedBytes: 0 },
      emptiness: "empty",
      supervisor: null,
    };
  };
  const runtime = new CheckRuntime(leases, {
    supervise: supervise as never,
    platform: () => ({ supported: true, note: "" }),
    resolveCommit: async (_repo, sha) => sha,
    testSelection: {
      changedPaths: async () => ({ ok: true, repoRoot: options.root, paths: options.changed }),
      deletedPaths: async () => ({ ok: true, repoRoot: options.root, paths: [] }),
      trackedFiles: async () => options.tracked,
    },
  });
  const execute = runtime.executorFor({ attemptId: "attempt-1", submissionId: "s", nodeId: "n", testLease: false });
  const check = async (): Promise<WorkflowCheckOutcome> => {
    const result = await runCheck({
      slot: "affected-tests",
      command: { ...emptyWorkflowCommandView("affected-tests"), defaultCommand: options.template ?? TEMPLATE },
      policy: { checksEnabled: true, repoAllowlist: [options.root] },
      reserveRun: options.budget ? () => ({ granted: true, spent: 0 }) : null,
      releaseRun: options.budget ? () => { options.budget!.released++; } : undefined,
      cwd: options.root,
      repoRoot: options.root,
      headSha: "a".repeat(40),
    }, { execute, checkoutSubpath: async () => "" });
    assert.equal(result.kind, "outcome", JSON.stringify(result));
    if (result.kind !== "outcome") throw new Error("unreachable");
    // Whatever was recorded must read back through the durable schema unchanged.
    assert.deepEqual(WorkflowCheckOutcomeSchema.parse(result.outcome), result.outcome);
    return result.outcome;
  };
  return { runs, check, released: () => released };
}

const CONFIG = { tests: { patterns: ["test/*.test.ts"], smokeSet: ["test/smoke.test.ts"] } };
const TRACKED = ["test/a.test.ts", "test/b.test.ts", "test/smoke.test.ts", "test/other.test.ts"];

test("an empty selection skips without running anything", async () => {
  const root = tree({ tests: { patterns: ["test/*.test.ts"] } });
  const h = harness({ root, changed: ["README.md"], tracked: TRACKED, answer: () => assert.fail("must not run") });
  const outcome = await h.check();
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.note, "No tests were selected for this change.");
  assert.equal(outcome.affected?.selectedCount, 0);
  assert.equal(h.runs.length, 0);
  assert.equal(h.released(), 1);
});

test("a repository with no .mission/testing.json skips with the file named", async () => {
  const h = harness({ root: tree(null), changed: [], tracked: TRACKED, answer: () => assert.fail("must not run") });
  const outcome = await h.check();
  assert.equal(outcome.status, "skipped");
  assert.match(outcome.note, /\.mission\/testing\.json/);
});

test("a pass runs only the selection, one argv element per file, and records the template", async () => {
  const root = tree(CONFIG);
  const h = harness({ root, changed: ["test/a.test.ts"], tracked: TRACKED, answer: () => ({ exitCode: 0 }) });
  const outcome = await h.check();
  assert.equal(outcome.status, "passed");
  assert.deepEqual(h.runs[0]!.files, ["test/a.test.ts", "test/smoke.test.ts"]);
  assert.ok(!h.runs[0]!.argv.includes("{files}"));
  assert.ok(!h.runs[0]!.argv.some((arg) => arg.includes("{junit}")));
  // The template, never the expanded argv.
  assert.deepEqual(outcome.command, TEMPLATE);
  assert.match(outcome.note, /Ran 2 selected test files; all passed\./);
  assert.deepEqual(outcome.affected?.selected, [
    { path: "test/a.test.ts", reason: "changed" },
    { path: "test/smoke.test.ts", reason: "smoke" },
  ]);
  assert.equal(checkVerdict(outcome, "attempt-1")?.verdict, "pass");
});

test("a test that fails and then passes on the rerun is a local flake, and the check passes", async () => {
  const root = tree(CONFIG);
  const h = harness({
    root,
    changed: ["test/a.test.ts", "test/b.test.ts"],
    tracked: TRACKED,
    answer: (run, index) => index === 0
      ? { exitCode: 1, xml: junit(root, [{ file: "test/a.test.ts", name: "a ok" }, { file: "test/b.test.ts", name: "b timing", failure: "timed out" }]) }
      : { exitCode: 0, xml: junit(root, run.files.map((file) => ({ file, name: "b timing" }))) },
  });
  const outcome = await h.check();
  assert.equal(outcome.status, "passed");
  // Only the failed file is rerun.
  assert.deepEqual(h.runs[1]!.files, ["test/b.test.ts"]);
  assert.deepEqual(outcome.affected?.flakes, [{ file: "test/b.test.ts", name: "b timing" }]);
  assert.deepEqual(outcome.affected?.failures, []);
  assert.match(outcome.note, /1 test flaked and passed on rerun/);
  assert.match(outcome.output, /rerunning 1 file once/);
});

test("a test that fails twice fails the check, with one requested change naming it", async () => {
  const root = tree(CONFIG);
  const failing = junit(root, [{ file: "test/a.test.ts", name: "adds numbers", failure: "1 !== 2" }]);
  const h = harness({
    root,
    changed: ["test/a.test.ts"],
    tracked: TRACKED,
    answer: () => ({ exitCode: 1, xml: failing }),
  });
  const outcome = await h.check();
  assert.equal(outcome.status, "failed");
  assert.equal(h.runs.length, 2);
  assert.deepEqual(outcome.affected?.failures, [{
    file: "test/a.test.ts",
    name: "adds numbers",
    message: "1 !== 2\n\nstack for adds numbers",
  }]);
  const verdict = checkVerdict(outcome, "attempt-1");
  assert.equal(verdict?.verdict, "fail");
  if (verdict?.verdict !== "fail") return;
  assert.equal(verdict.requestedChanges.length, 1);
  assert.equal(verdict.requestedChanges[0]!.title, "Fix the failing test \"adds numbers\" in test/a.test.ts");
  assert.match(verdict.requestedChanges[0]!.rationale, /1 !== 2/);
});

test("missing JUnit results fail with the output tail rather than guessing", async () => {
  const root = tree(CONFIG);
  const h = harness({ root, changed: ["test/a.test.ts"], tracked: TRACKED, answer: () => ({ exitCode: 1 }) });
  const outcome = await h.check();
  assert.equal(outcome.status, "failed");
  assert.equal(h.runs.length, 1);
  assert.match(outcome.note, /JUnit results could not be read/);
  const verdict = checkVerdict(outcome, "attempt-1");
  assert.equal(verdict?.verdict, "fail");
  if (verdict?.verdict === "fail") assert.match(verdict.requestedChanges[0]!.rationale, /run 1/);
});

test("a template without its placeholders is refused when saved and fails when run", async () => {
  assert.equal(commandTemplateProblem("test", ["npm", "test"]), null);
  assert.equal(commandTemplateProblem("affected-tests", TEMPLATE), null);
  assert.match(commandTemplateProblem("affected-tests", ["npm", "test"]) ?? "", /\{files\}.*\{junit\}/);
  // `{files}` must be a whole argument: it expands to one argument per file.
  assert.match(commandTemplateProblem("affected-tests", ["x", "--files={files}", "{junit}"]) ?? "", /\{files\}/);

  const h = harness({
    root: tree(CONFIG),
    changed: ["test/a.test.ts"],
    tracked: TRACKED,
    template: ["npm", "test"],
    answer: () => assert.fail("must not run"),
  });
  const outcome = await h.check();
  assert.equal(outcome.status, "failed");
  assert.match(outcome.note, /must contain/);
});

test("a gate that ran nothing hands its run budget back; one that ran keeps it spent", async () => {
  const idle = { released: 0 };
  await harness({
    root: tree({ tests: { patterns: ["test/*.test.ts"] } }),
    changed: [],
    tracked: TRACKED,
    budget: idle,
    answer: () => assert.fail("must not run"),
  }).check();
  assert.equal(idle.released, 1);

  const ran = { released: 0 };
  await harness({
    root: tree(CONFIG),
    changed: ["test/a.test.ts"],
    tracked: TRACKED,
    budget: ran,
    answer: () => ({ exitCode: 0 }),
  }).check();
  assert.equal(ran.released, 0);
});

test("a rerun whose JUnit results cannot be read fails, keeping both runs' output", async () => {
  const root = tree(CONFIG);
  const h = harness({
    root,
    changed: ["test/a.test.ts"],
    tracked: TRACKED,
    // The first run names its failure; the rerun exits non-zero and writes nothing.
    answer: (_run, index) => index === 0
      ? { exitCode: 1, xml: junit(root, [{ file: "test/a.test.ts", name: "adds", failure: "1 !== 2" }]) }
      : { exitCode: 7 },
  });
  const outcome = await h.check();
  assert.equal(h.runs.length, 2);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.exitCode, 7);
  assert.match(outcome.note, /the rerun exited 7 and its JUnit results could not be read/);
  assert.match(outcome.output, /run 1\n[\s\S]*rerunning 1 file once[\s\S]*run 2\n/);
  assert.deepEqual(outcome.affected?.failures, []);
  // No test is named, so the repair packet falls back to the output tail.
  const verdict = checkVerdict(outcome, "attempt-1");
  assert.equal(verdict?.verdict, "fail");
  if (verdict?.verdict === "fail") {
    assert.equal(verdict.requestedChanges.length, 1);
    assert.match(verdict.requestedChanges[0]!.rationale, /run 2/);
  }
});

test("a rerun that exits non-zero while its results name no failing test fails, never passes", async () => {
  const root = tree(CONFIG);
  const h = harness({
    root,
    changed: ["test/a.test.ts"],
    tracked: TRACKED,
    answer: (run, index) => index === 0
      ? { exitCode: 1, xml: junit(root, [{ file: "test/a.test.ts", name: "adds", failure: "1 !== 2" }]) }
      // Every named test passed, yet the process failed (a crash after the reporter flushed).
      : { exitCode: 1, xml: junit(root, run.files.map((file) => ({ file, name: "adds" }))) },
  });
  const outcome = await h.check();
  assert.equal(h.runs.length, 2);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.note, /the rerun exited 1, but its JUnit results name no failing test/);
  assert.deepEqual(outcome.affected?.flakes, []);
});

test("a failure that names no selected file reruns the whole selection", async () => {
  const root = tree(CONFIG);
  const h = harness({
    root,
    changed: ["test/a.test.ts", "test/b.test.ts"],
    tracked: TRACKED,
    answer: (run, index) => index === 0
      // One failure traces to a selected file, the other to a helper nobody selected.
      ? {
        exitCode: 1,
        xml: junit(root, [
          { file: "test/a.test.ts", name: "adds", failure: "1 !== 2" },
          { file: "test/helpers/setup.ts", name: "setup hook", failure: "port in use" },
        ]),
      }
      : { exitCode: 0, xml: junit(root, run.files.map((file) => ({ file, name: "ok" }))) },
  });
  const outcome = await h.check();
  assert.deepEqual(h.runs[0]!.files, ["test/a.test.ts", "test/b.test.ts", "test/smoke.test.ts"]);
  // Not just test/a.test.ts: the untraceable failure could belong to any of them.
  assert.deepEqual(h.runs[1]!.files, h.runs[0]!.files);
  assert.match(outcome.output, /rerunning 3 files once/);
  assert.equal(outcome.status, "passed");
  assert.deepEqual(outcome.affected?.flakes, [
    { file: "test/a.test.ts", name: "adds" },
    { file: "test/helpers/setup.ts", name: "setup hook" },
  ]);
});

test("more failures than the cap are counted in full, on the outcome and in the repair packet", async () => {
  const root = tree(CONFIG);
  const names = Array.from({ length: 25 }, (_, i) => `case ${String(i).padStart(2, "0")}`);
  const h = harness({
    root,
    changed: ["test/a.test.ts"],
    tracked: TRACKED,
    answer: () => ({
      exitCode: 1,
      xml: junit(root, names.map((name) => ({ file: "test/a.test.ts", name, failure: "boom" }))),
    }),
  });
  const outcome = await h.check();
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.affected?.failureCount, 25);
  assert.equal(outcome.affected?.failures.length, 20);
  assert.equal(outcome.affected?.flakeCount, 0);
  assert.match(outcome.note, /25 tests failed twice/);
  const verdict = checkVerdict(outcome, "attempt-1");
  assert.equal(verdict?.verdict, "fail");
  if (verdict?.verdict !== "fail") return;
  assert.equal(verdict.requestedChanges.length, 20);
  assert.match(verdict.requestedChanges[0]!.rationale, /25 tests failed twice in this check; only the first 20 are listed\./);
  // Every recorded failure is listed, so there is nothing more in run detail to point to.
  assert.doesNotMatch(verdict.requestedChanges[0]!.rationale, /Run detail/);
  assert.doesNotMatch(verdict.requestedChanges[1]!.rationale, /only the first/);
});

// Issue #466: twenty listed failures, each quoting a 2,000-character message into both its
// rationale and its evidence, came to several times `verdictJsonBytes`. The strict schema
// refused the verdict and a real test failure was retried as an infrastructure failure.
function failedTwice(failures: WorkflowTestFailure[], failureCount: number, note?: string): WorkflowCheckOutcome {
  return WorkflowCheckOutcomeSchema.parse({
    status: "failed",
    slot: "affected-tests",
    command: TEMPLATE,
    exitCode: 1,
    output: "run 2\n",
    truncatedBytes: 0,
    note: note ?? `Ran 542 selected test files; ${failureCount} tests failed twice.`,
    affected: {
      selectedCount: 542,
      selected: [],
      flakeCount: 0,
      flakes: [],
      failureCount,
      failures,
      settings: { patterns: ["test/*.test.ts"], includeImporters: true, smokeSet: [], localKeys: [] },
    },
  });
}

// Ten UTF-16 code units: CJK, an astral emoji, a quote, a newline and a tab, so the message is
// costly both as UTF-8 and as JSON, and a cut through it can land mid-character.
const COSTLY = "期待値≠実😀\"\n\t";

function costlyMessage(index: number, length: number = AFFECTED_TESTS_LIMITS.failureMessage): string {
  const head = `#${String(index).padStart(2, "0")} fails `;
  return head + COSTLY.repeat((length - head.length) / COSTLY.length);
}

function assertWithinBudget(verdict: ReturnType<typeof checkVerdict>) {
  assert.ok(verdict, "a failed check must yield a verdict, never an infrastructure failure");
  assert.equal(verdict.verdict, "fail");
  assert.ok(PersonaVerdictSchema.safeParse(verdict).success);
  assert.ok(Buffer.byteLength(JSON.stringify(verdict)) <= WORKFLOW_EXECUTION_LIMITS.verdictJsonBytes);
  if (verdict.verdict !== "fail") throw new Error("unreachable");
  for (const change of verdict.requestedChanges) {
    // A clip never leaves half a surrogate pair behind.
    assert.doesNotMatch(change.rationale + change.evidence[0]!.quote, /[\ud800-\udbff](?![\udc00-\udfff])/);
  }
  return verdict;
}

test("as many max-length multi-byte failures as fit are listed, and the verdict says how many it left out", () => {
  const failures = Array.from({ length: AFFECTED_TESTS_LIMITS.failures }, (_, i) => ({
    file: "test/headless-cwd.test.ts",
    name: `resolves the working directory ${i}`,
    message: costlyMessage(i),
  }));
  assert.equal(failures[0]!.message.length, AFFECTED_TESTS_LIMITS.failureMessage);
  const verdict = assertWithinBudget(checkVerdict(failedTwice(failures, 58), "attempt-1"));
  // Pinned for this fixture: 18 changes at the 200-byte message floor do not fit the budget,
  // and 17 do, so a verdict that listed fewer than fit would be caught here.
  const listed = verdict.requestedChanges.length;
  assert.equal(listed, 17);
  const first = verdict.requestedChanges[0]!;
  assert.equal(first.title, "Fix the failing test \"resolves the working directory 0\" in test/headless-cwd.test.ts");
  assert.match(first.rationale, new RegExp(`58 tests failed twice in this check; only the first ${listed} are listed\\.`));
  assert.match(first.rationale, /Run detail names the first 20\./);
  assert.match(first.rationale, /#00 fails 期待値/);
  assert.match(first.evidence[0]!.quote, /^#00 fails 期待値/);
  // Every listed failure is the one at its own position, still carrying its own message.
  verdict.requestedChanges.forEach((change, i) => {
    assert.match(change.title, new RegExp(`directory ${i}"`));
    assert.match(change.evidence[0]!.quote, new RegExp(`^#${String(i).padStart(2, "0")} fails`));
  });
});

test("failures that all fit are listed in full with no omission note", () => {
  const failures = Array.from({ length: 3 }, (_, i) => ({ file: null, name: `case ${i}`, message: costlyMessage(i, 400) }));
  const verdict = assertWithinBudget(checkVerdict(failedTwice(failures, 3), "attempt-1"));
  assert.equal(verdict.requestedChanges.length, 3);
  assert.doesNotMatch(verdict.requestedChanges[0]!.rationale, /only the first/);
  assert.equal(verdict.requestedChanges[2]!.evidence[0]!.quote, costlyMessage(2, 400).trim());
});

test("even maximal names, paths and summary still yield a valid failing verdict naming the first failure", () => {
  const failures = Array.from({ length: AFFECTED_TESTS_LIMITS.failures }, (_, i) => ({
    file: `test/${"漢".repeat(AFFECTED_TESTS_LIMITS.path - 10)}.ts`,
    name: `${i} ${"😀".repeat((AFFECTED_TESTS_LIMITS.testName - 4) / 2)}`,
    message: costlyMessage(i),
  }));
  const note = "漢".repeat(WORKFLOW_EXECUTION_LIMITS.verdictSummary);
  const verdict = assertWithinBudget(checkVerdict(failedTwice(failures, 58, note), "attempt-1"));
  assert.match(verdict.requestedChanges[0]!.title, /^Fix the failing test "0 😀/);
});

test("a single failure squeezed to its floor still quotes a whole character, not just the ellipsis", () => {
  const failure = {
    file: `test/${"漢".repeat(AFFECTED_TESTS_LIMITS.path - 10)}.ts`,
    name: "😀".repeat(AFFECTED_TESTS_LIMITS.testName / 2),
    message: "😀".repeat(AFFECTED_TESTS_LIMITS.failureMessage / 2),
  };
  // The longest summary that still leaves the failure room is where its message cap is smallest.
  // A control character is six bytes as JSON, so the summary alone can fill the budget.
  for (let length = WORKFLOW_EXECUTION_LIMITS.verdictSummary; length > 0; length--) {
    const verdict = checkVerdict(failedTwice([failure], 1, "\u0001".repeat(length)), "attempt-1");
    if (verdict?.verdict !== "fail" || !verdict.requestedChanges[0]!.title.startsWith("Fix the failing test")) continue;
    assertWithinBudget(verdict);
    assert.match(verdict.requestedChanges[0]!.evidence[0]!.quote, /^😀/);
    return;
  }
  assert.fail("the failure never fit");
});
