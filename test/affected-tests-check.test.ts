import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkflowCheckOutcomeSchema,
} from "../src/shared/protocol.ts";
import {
  commandTemplateProblem,
  emptyWorkflowCommandView,
  type WorkflowCheckOutcome,
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
