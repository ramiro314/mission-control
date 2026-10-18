import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dirname, join } from "node:path";
import {
  WorkflowCheckOutcomeSchema,
} from "../src/shared/protocol.ts";
import {
  AFFECTED_TESTS_LIMITS,
  WORKFLOW_EXECUTION_LIMITS,
  WORKFLOW_LIMITS,
  commandTemplateProblem,
  emptyWorkflowCommandView,
  type WorkflowCheckOutcome,
} from "../src/shared/workflow.ts";
import { CheckRuntime } from "../src/server/workflows/check-runtime.ts";
import type { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import type { CheckSpawnOutcome, SupervisedCheckRequest } from "../src/server/workflows/check-supervisor.ts";
import {
  runCheck,
  type CheckExecutionRequest,
  type CheckExecutionResult,
  type CheckResult,
  type CheckRunReservation,
} from "../src/server/workflows/checks.ts";
import { checkVerdict } from "../src/server/workflows/engine.ts";
import { AffectedTestsDetails } from "../src/web/workflows/WorkflowRuns.tsx";
import type { StoredTestingLayer, StoredTestingSettings } from "../src/shared/testing-config.ts";
import {
  MONOREPO_CHANGED,
  MONOREPO_ROOT_SETTINGS,
  MONOREPO_SELECTED,
  MONOREPO_SUBDIRECTORY_LAYERS,
  MONOREPO_TRACKED,
  monorepoTree,
} from "./helpers/monorepo-testing-fixture.ts";

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

type Run = { argv: string[]; files: string[]; workingSubpath: string; junit: string; timeoutMs: number | undefined };
type Answer = {
  exitCode: number;
  xml?: string;
  /** What the run prints; `run N` by default. */
  output?: string;
  /**
   * How long the run takes on the harness `clock`. Longer than the timeout it was given, it is
   * killed at that timeout, as the supervisor does.
   */
  durationMs?: number;
  /** What the supervisor reports instead of an ordinary exit: a timeout, or a group left running. */
  abnormal?: Pick<CheckSpawnOutcome, "result" | "emptiness">;
};

function harness(options: {
  root: string;
  changed: string[];
  tracked: string[];
  answer: (run: Run, index: number) => Answer;
  template?: string[];
  /** The slot's global default; `template` (or `TEMPLATE`) unless set, and null for none. */
  defaultCommand?: string[] | null;
  budget?: { released: number };
  /** Answer each claim on the run budget; granted every time when only `budget` is set. */
  reserve?: () => CheckRunReservation;
  /** How long each "test run" takes, so overlapping runs would be seen. */
  delayMs?: number;
  /** Called as each run starts (true) and ends (false). */
  onSpawn?: (entering: boolean) => void;
  /** One command's timeout, as the runtime is configured with it. */
  timeoutMs?: number;
  /** A clock the runtime reads and each run advances by its `durationMs`. */
  clock?: { at: number };
  /** The repository root's stored testing settings, as the daemon's catalog would answer. */
  stored?: StoredTestingSettings;
  /** Subdirectory rows, repository-relative, beside the root's. */
  subdirectories?: StoredTestingLayer[];
  /** Affected-tests overrides, keyed by absolute path, as the Commands catalog holds them. */
  overrides?: Array<{ repoRoot: string; command: string[] }>;
  /** Where the session stands, repository-relative. The root by default. */
  sessionSubpath?: string;
}) {
  const runs: Run[] = [];
  let released = 0;
  let reserved = 0;
  let handedOff = 0;
  const leases = {
    acquireForAttempt: async () => options.root,
    releaseForAttempt: async () => {
      released++;
      return { outcome: "returned" };
    },
    handOffForReclaim: () => { handedOff++; },
    unresolvedLeaseForNode: () => false,
    processes: { record: () => {}, clear: () => {} },
  } as unknown as CheckLeaseManager;
  const supervise = async (request: SupervisedCheckRequest): Promise<CheckSpawnOutcome> => {
    const argv = [...request.command];
    const dest = argv.find((arg) => arg.startsWith("--test-reporter-destination="))!;
    const junitPath = dest.slice("--test-reporter-destination=".length);
    const files = argv.slice(TEMPLATE.length - 1);
    const run = { argv, files, workingSubpath: request.workingSubpath, junit: junitPath, timeoutMs: request.timeoutMs };
    options.onSpawn?.(true);
    if (options.delayMs) await new Promise((done) => setTimeout(done, options.delayMs));
    const answer = options.answer(run, runs.length);
    runs.push(run);
    if (answer.xml !== undefined) writeFileSync(junitPath, answer.xml);
    options.onSpawn?.(false);
    if (options.clock) {
      const allowed = request.timeoutMs ?? Number.POSITIVE_INFINITY;
      const took = answer.durationMs ?? 0;
      options.clock.at += Math.min(took, allowed);
      if (took > allowed) {
        return {
          result: {
            kind: "infrastructure",
            reason: `the check command did not finish within ${allowed}ms and its process group was terminated`,
          },
          emptiness: "empty",
          supervisor: null,
        };
      }
    }
    if (answer.abnormal) return { ...answer.abnormal, supervisor: null };
    return {
      result: { kind: "exited", exitCode: answer.exitCode, output: answer.output ?? `run ${runs.length}\n`, truncatedBytes: 0 },
      emptiness: "empty",
      supervisor: null,
    };
  };
  const runtime = new CheckRuntime(leases, {
    supervise: supervise as never,
    platform: () => ({ supported: true, note: "" }),
    resolveCommit: async (_repo, sha) => sha,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.clock ? { now: () => options.clock!.at } : {}),
    testSelection: {
      changedPaths: async () => ({ ok: true, repoRoot: options.root, paths: options.changed }),
      deletedPaths: async () => ({ ok: true, repoRoot: options.root, paths: [] }),
      trackedFiles: async () => options.tracked,
    },
    storedTestingLayers: (repoRoot) => (repoRoot === options.root
      ? [...(options.stored ? [{ settings: options.stored, scope: "" }] : []), ...(options.subdirectories ?? [])]
      : []),
  });
  const executor = runtime.executorFor({ attemptId: "attempt-1", submissionId: "s", nodeId: "n", testLease: false });
  // What the executor answered, before `runCheck` bounds it for the outcome.
  let raw: CheckExecutionResult | null = null;
  const execute = async (request: CheckExecutionRequest): Promise<CheckExecutionResult> => {
    raw = await executor(request);
    return raw;
  };
  const run = (): Promise<CheckResult> => runCheck({
    slot: "affected-tests",
    command: {
      ...emptyWorkflowCommandView("affected-tests"),
      defaultCommand: options.defaultCommand !== undefined ? options.defaultCommand : options.template ?? TEMPLATE,
      ...(options.overrides ? { overrides: options.overrides } : {}),
    },
    policy: { checksEnabled: true, repoAllowlist: [options.root] },
    reserveRun: options.reserve || options.budget
      ? () => {
        reserved++;
        return options.reserve ? options.reserve() : { granted: true, spent: 0 };
      }
      : null,
    releaseRun: options.budget ? () => { options.budget!.released++; } : undefined,
    cwd: options.sessionSubpath ? join(options.root, options.sessionSubpath) : options.root,
    repoRoot: options.root,
    headSha: "a".repeat(40),
  }, { execute, checkoutSubpath: async () => options.sessionSubpath ?? "" });
  const check = async (): Promise<WorkflowCheckOutcome> => {
    const result = await run();
    assert.equal(result.kind, "outcome", JSON.stringify(result));
    if (result.kind !== "outcome") throw new Error("unreachable");
    // Whatever was recorded must read back through the durable schema unchanged.
    assert.deepEqual(WorkflowCheckOutcomeSchema.parse(result.outcome), result.outcome);
    return result.outcome;
  };
  return {
    runs,
    check,
    run,
    released: () => released,
    reserved: () => reserved,
    handedOff: () => handedOff,
    raw: () => raw,
    budget: options.budget,
  };
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

test("stored testing settings run the gate with no committed file, and the outcome names each source", async () => {
  const root = tree(null);
  const h = harness({
    root,
    changed: ["test/a.test.ts"],
    tracked: TRACKED,
    stored: { tests: { patterns: ["test/*.test.ts"], smokeSet: ["test/smoke.test.ts"] } },
    answer: () => ({ exitCode: 0 }),
  });
  const outcome = await h.check();
  assert.equal(outcome.status, "passed");
  assert.deepEqual(h.runs[0]!.files, ["test/a.test.ts", "test/smoke.test.ts"]);
  assert.deepEqual(outcome.affected?.settings.sources, [
    { key: "tests.patterns", layer: "stored", scope: "" },
    { key: "tests.includeImporters", layer: "default", scope: null },
    { key: "tests.smokeSet", layer: "stored", scope: "" },
  ]);

  // Stored over committed, key by key: the committed smoke set is replaced, its patterns kept.
  const both = tree({ tests: { patterns: ["test/*.test.ts"], smokeSet: ["test/other.test.ts"] } });
  const layered = harness({
    root: both,
    changed: ["test/a.test.ts"],
    tracked: TRACKED,
    stored: { tests: { smokeSet: ["test/smoke.test.ts"] } },
    answer: () => ({ exitCode: 0 }),
  });
  const second = await layered.check();
  assert.deepEqual(layered.runs[0]!.files, ["test/a.test.ts", "test/smoke.test.ts"]);
  assert.deepEqual(second.affected?.settings.sources?.map((source) => source.layer), ["committed", "committed", "stored"]);
});

test("the operator's local file alone runs the gate, over the defaults", async () => {
  // The harness's session repository is the tree itself, so the local file is read from there.
  const root = tree(null);
  mkdirSync(join(root, ".mission"), { recursive: true });
  writeFileSync(join(root, ".mission/testing.local.json"), JSON.stringify({ tests: { smokeSet: ["test/smoke.test.ts"] } }));
  const h = harness({ root, changed: [], tracked: TRACKED, answer: () => ({ exitCode: 0 }) });
  const outcome = await h.check();
  assert.equal(outcome.status, "passed");
  assert.deepEqual(h.runs[0]!.files, ["test/smoke.test.ts"]);
  assert.deepEqual(outcome.affected?.settings.sources?.map((source) => source.layer), ["default", "default", "local"]);
});

test("a stored row that sets nothing skips like a repository with no settings at all", async () => {
  const h = harness({ root: tree(null), changed: [], tracked: TRACKED, stored: {}, answer: () => assert.fail("must not run") });
  const outcome = await h.check();
  assert.equal(outcome.status, "skipped");
  assert.match(outcome.note, /no stored testing settings/);
});

test("subdirectory scopes shape the selection, and the web app's override runs only the web app's tests", async () => {
  // A monorepo with two app scopes and no root tsconfig. Only apps/web has an override, so its
  // tests run there, relative to it, and every other selected test runs through the global
  // default at the root. The session standing in apps/web changes none of that.
  const root = realpathSync(monorepoTree());
  const h = harness({
    root,
    changed: MONOREPO_CHANGED,
    tracked: MONOREPO_TRACKED,
    stored: MONOREPO_ROOT_SETTINGS,
    subdirectories: MONOREPO_SUBDIRECTORY_LAYERS,
    overrides: [{ repoRoot: join(root, "apps/web"), command: TEMPLATE }],
    sessionSubpath: "apps/web",
    answer: () => ({ exitCode: 0 }),
  });
  const outcome = await h.check();
  assert.equal(outcome.status, "passed", outcome.note);
  assert.deepEqual(h.runs.map((run) => [run.workingSubpath, run.files]), [
    ["", ["apps/api/lib/c.spec.ts", "apps/api/smoke.spec.ts", "packages/ui/src/button.test.ts", "tools/root-smoke.test.ts"]],
    ["apps/web", ["smoke/web.smoke.ts", "src/a.test.ts", "src/alias.test.ts"]],
  ]);
  assert.deepEqual(outcome.affected?.selected.map((file) => file.path), MONOREPO_SELECTED.map((file) => file.path));

  // The root's sources stay where they were, and each scope's are recorded beside them.
  assert.deepEqual(outcome.affected?.settings.sources?.map((source) => source.layer), ["stored", "default", "stored"]);
  assert.equal(outcome.affected?.settings.scopeCount, 2);
  assert.deepEqual(outcome.affected?.settings.scopes, [
    {
      path: "apps/api",
      sources: [
        { key: "tests.patterns", layer: "stored", scope: "apps/api" },
        { key: "tests.includeImporters", layer: "stored", scope: "apps/api" },
        { key: "tests.smokeSet", layer: "stored", scope: "" },
      ],
    },
    {
      path: "apps/web",
      sources: [
        { key: "tests.patterns", layer: "stored", scope: "apps/web" },
        { key: "tests.includeImporters", layer: "default", scope: null },
        { key: "tests.smokeSet", layer: "stored", scope: "apps/web" },
      ],
    },
  ]);
  // The app's own alias resolved, so there is nothing to note: the report carries no diagnostics.
  assert.equal(outcome.affected?.diagnostics, undefined);
});

// ---- Partitions: a monorepo with two apps and a package --------------------------------------

/** One affected-tests override per app, as the Commands catalog keys them: by absolute path. */
function appOverrides(root: string): Array<{ repoRoot: string; command: string[] }> {
  return [
    { repoRoot: join(root, "apps/web"), command: TEMPLATE },
    { repoRoot: join(root, "apps/api"), command: TEMPLATE },
  ];
}

type HarnessOptions = Parameters<typeof harness>[0];

/** The fixture monorepo's gate, with each app's override and whatever else `over` sets. */
function monorepoHarness(over: Partial<HarnessOptions> | ((root: string) => Partial<HarnessOptions>) = {}) {
  const root = realpathSync(monorepoTree());
  return {
    root,
    ...harness({
      root,
      changed: MONOREPO_CHANGED,
      tracked: MONOREPO_TRACKED,
      stored: MONOREPO_ROOT_SETTINGS,
      subdirectories: MONOREPO_SUBDIRECTORY_LAYERS,
      overrides: appOverrides(root),
      answer: () => ({ exitCode: 0 }),
      ...(typeof over === "function" ? over(root) : over),
    }),
  };
}

test("a monorepo change runs each app's selected tests in that app, and the rest at the root", async () => {
  const h = monorepoHarness({ budget: { released: 0 } });
  const outcome = await h.check();
  assert.equal(outcome.status, "passed", outcome.note);

  // One invocation per partition: the root's (the global default) first, then each app by path,
  // each in its own subdirectory with files relative to it. No `../` reaches any of them.
  assert.deepEqual(h.runs.map((run) => [run.workingSubpath, run.files]), [
    ["", ["packages/ui/src/button.test.ts", "tools/root-smoke.test.ts"]],
    ["apps/api", ["lib/c.spec.ts", "smoke.spec.ts"]],
    ["apps/web", ["smoke/web.smoke.ts", "src/a.test.ts", "src/alias.test.ts"]],
  ]);
  // Selected once, across the repository.
  assert.deepEqual(outcome.affected?.selected.map((file) => file.path), MONOREPO_SELECTED.map((file) => file.path));
  assert.equal(outcome.note, "`node --test --test-reporter=junit --test-reporter-destination={junit} {files}`: "
    + "Ran 7 selected test files in 3 partitions; all passed.");

  // Run detail's record of each partition.
  assert.equal(outcome.affected?.partitions?.length, 3);
  assert.deepEqual(outcome.affected?.partitions?.map(({ subpath, source, fileCount, status, exitCode, note }) =>
    ({ subpath, source, fileCount, status, exitCode, note })), [
    { subpath: "", source: "default", fileCount: 2, status: "passed", exitCode: 0, note: "Ran 2 selected test files; all passed." },
    { subpath: "apps/api", source: "override", fileCount: 2, status: "passed", exitCode: 0, note: "Ran 2 selected test files; all passed." },
    { subpath: "apps/web", source: "override", fileCount: 3, status: "passed", exitCode: 0, note: "Ran 3 selected test files; all passed." },
  ]);
  assert.deepEqual(outcome.affected?.partitions?.map((partition) => partition.command), [TEMPLATE, TEMPLATE, TEMPLATE]);
  assert.deepEqual(outcome.affected?.partitions?.map((partition) => partition.output), ["run 1\n", "run 2\n", "run 3\n"]);
  assert.equal(outcome.affected?.unrun, undefined);
  // The gate's output keeps every partition's, each under a banner naming it.
  assert.match(outcome.output, /\[Mission Control\] the repository root: 2 files, passed\.\n\nrun 1\n/);
  assert.match(outcome.output, /\[Mission Control\] apps\/web: 3 files, passed\.\n\nrun 3\n/);

  // Three invocations spent one run of the budget, and kept it.
  assert.equal(h.reserved(), 1);
  assert.equal(h.budget!.released, 0);
});

test("each partition writes its own JUnit file and reruns only its own failed files once, in its own subdirectory", async () => {
  let root = "";
  const junits: string[] = [];
  const h = monorepoHarness({
    answer: (run, index) => {
      junits.push(run.junit);
      // The api app's first run fails one test; its rerun passes. The web app fails twice.
      if (run.workingSubpath === "apps/api" && index === 1) {
        return { exitCode: 1, xml: junit(join(root, "apps/api"), [{ file: "lib/c.spec.ts", name: "c timing", failure: "timed out" }]) };
      }
      if (run.workingSubpath === "apps/web") {
        return { exitCode: 1, xml: junit(join(root, "apps/web"), [{ file: "src/a.test.ts", name: "adds", failure: "1 !== 2" }]) };
      }
      return { exitCode: 0 };
    },
  });
  root = h.root;
  const outcome = await h.check();

  assert.equal(outcome.status, "failed");
  assert.deepEqual(h.runs.map((run) => [run.workingSubpath, run.files]), [
    ["", ["packages/ui/src/button.test.ts", "tools/root-smoke.test.ts"]],
    ["apps/api", ["lib/c.spec.ts", "smoke.spec.ts"]],
    ["apps/api", ["lib/c.spec.ts"]],
    ["apps/web", ["smoke/web.smoke.ts", "src/a.test.ts", "src/alias.test.ts"]],
    ["apps/web", ["src/a.test.ts"]],
  ]);
  // A results path of its own for every run: no partition reads another's results.
  assert.equal(new Set(junits).size, junits.length);
  assert.equal(new Set(junits.map((path) => dirname(path))).size, 3);

  // Results map back to tree paths, whichever subdirectory reported them.
  assert.deepEqual(outcome.affected?.flakes, [{ file: "apps/api/lib/c.spec.ts", name: "c timing" }]);
  assert.deepEqual(outcome.affected?.failures, [{
    file: "apps/web/src/a.test.ts",
    name: "adds",
    message: "1 !== 2\n\nstack for adds",
  }]);
  assert.deepEqual(outcome.affected?.partitions?.map((partition) => [partition.subpath, partition.status, partition.exitCode]), [
    ["", "passed", 0],
    ["apps/api", "passed", 0],
    ["apps/web", "failed", 1],
  ]);
  assert.match(outcome.note, /Ran 7 selected test files in 3 partitions; 1 partition failed \(apps\/web\); 1 test failed twice; 1 test flaked and passed on rerun\.$/);
  // The gate's exit code is the failed partition's.
  assert.equal(outcome.exitCode, 1);
  const verdict = checkVerdict(outcome, "attempt-1");
  assert.equal(verdict?.verdict, "fail");
  if (verdict?.verdict === "fail") {
    assert.equal(verdict.requestedChanges[0]!.title, "Fix the failing test \"adds\" in apps/web/src/a.test.ts");
  }
});

test("partitions run one after another, every one of them even after one fails, inside one test lease", async () => {
  let active = 0;
  let most = 0;
  const h = monorepoHarness({
    delayMs: 15,
    onSpawn: (entering) => {
      active += entering ? 1 : -1;
      most = Math.max(most, active);
    },
    // The first partition fails twice; the two after it still run.
    answer: (run) => run.workingSubpath === ""
      ? { exitCode: 1 }
      : { exitCode: 0 },
  });
  const outcome = await h.check();
  assert.equal(most, 1, "never two invocations at once");
  assert.deepEqual(h.runs.map((run) => run.workingSubpath), ["", "apps/api", "apps/web"]);
  assert.equal(outcome.status, "failed");
  assert.deepEqual(outcome.affected?.partitions?.map((partition) => partition.status), ["failed", "passed", "passed"]);
  assert.match(outcome.affected!.partitions![0]!.note, /JUnit results could not be read/);
  // One worktree lease and one test lease for the whole gate: the tree went back once.
  assert.equal(h.released(), 1);
});

test("a selected test no Command can run is listed as unrun, and the gate decides on the partitions that ran", async () => {
  // No global default and no root override: the package's and the root tooling's tests have
  // nowhere to run.
  const h = monorepoHarness({ defaultCommand: null, budget: { released: 0 } });
  const outcome = await h.check();
  assert.equal(outcome.status, "passed", outcome.note);
  assert.deepEqual(h.runs.map((run) => run.workingSubpath), ["apps/api", "apps/web"]);
  assert.deepEqual(outcome.affected?.unrun, ["packages/ui/src/button.test.ts", "tools/root-smoke.test.ts"]);
  assert.equal(outcome.affected?.selectedCount, 7, "unrun tests are still selected");
  assert.match(outcome.note, /Ran 5 selected test files in 2 partitions; all passed\. 2 selected test files were not run: no affected-tests Command covers them\.$/);
  // The outcome names the first partition's command when the root has none.
  assert.deepEqual(outcome.command, TEMPLATE);
  assert.equal(h.reserved(), 1);
  assert.equal(h.budget!.released, 0);

  // A failing partition still fails the gate with tests unrun.
  const failing = monorepoHarness({ defaultCommand: null, answer: (run) => ({ exitCode: run.workingSubpath === "apps/api" ? 1 : 0 }) });
  assert.equal((await failing.check()).status, "failed");
});

test("a selection no Command can run at all runs nothing, lists every test as unrun, and hands its run back", async () => {
  const root = realpathSync(monorepoTree());
  const budget = { released: 0 };
  // Only an override for a docs folder the selection never reaches, and no default.
  const h = harness({
    root,
    changed: ["packages/ui/src/button.ts"],
    tracked: MONOREPO_TRACKED,
    stored: MONOREPO_ROOT_SETTINGS,
    subdirectories: MONOREPO_SUBDIRECTORY_LAYERS,
    overrides: [{ repoRoot: join(root, "apps/docs"), command: TEMPLATE }],
    defaultCommand: null,
    budget,
    answer: () => assert.fail("must not run"),
  });
  const outcome = await h.check();
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.exitCode, null);
  assert.match(outcome.note, /4 selected test files were not run: no affected-tests Command covers them\./);
  assert.deepEqual(outcome.affected?.unrun, [
    "apps/api/smoke.spec.ts",
    "apps/web/smoke/web.smoke.ts",
    "packages/ui/src/button.test.ts",
    "tools/root-smoke.test.ts",
  ]);
  assert.equal(outcome.affected?.partitions, undefined);
  assert.equal(h.runs.length, 0);
  assert.equal(budget.released, 1);
});

test("partitions do not depend on where the session stands", async () => {
  const seen: string[] = [];
  for (const sessionSubpath of ["", "apps/web", "apps/api/lib", "packages/ui"]) {
    const h = monorepoHarness({ sessionSubpath });
    const outcome = await h.check();
    assert.equal(outcome.status, "passed", outcome.note);
    seen.push(JSON.stringify(h.runs.map((run) => [run.workingSubpath, run.files])));
    // The outcome names the root's command wherever the session stands.
    assert.deepEqual(outcome.command, TEMPLATE);
  }
  assert.equal(new Set(seen).size, 1, seen.join("\n"));

  // A root override beats the global default for the root partition, from any session.
  const rootTemplate = [...TEMPLATE.slice(0, -1), "--root", "{files}"];
  const withRoot = monorepoHarness((root) => ({
    sessionSubpath: "apps/web",
    overrides: [...appOverrides(root), { repoRoot: root, command: rootTemplate }],
  }));
  const outcome = await withRoot.check();
  assert.equal(withRoot.runs[0]!.workingSubpath, "");
  assert.ok(withRoot.runs[0]!.argv.includes("--root"));
  assert.ok(!withRoot.runs[1]!.argv.includes("--root"));
  assert.equal(outcome.affected?.partitions?.[0]?.source, "override");
  assert.deepEqual(outcome.command, rootTemplate);
});

test("the deepest override holding a test wins it", async () => {
  const nested = monorepoHarness((root) => ({
    overrides: [...appOverrides(root), { repoRoot: join(root, "apps/web/src"), command: TEMPLATE }],
  }));
  await nested.check();
  assert.deepEqual(nested.runs.map((run) => [run.workingSubpath, run.files]), [
    ["", ["packages/ui/src/button.test.ts", "tools/root-smoke.test.ts"]],
    ["apps/api", ["lib/c.spec.ts", "smoke.spec.ts"]],
    ["apps/web", ["smoke/web.smoke.ts"]],
    ["apps/web/src", ["a.test.ts", "alias.test.ts"]],
  ]);
});

test("a broken template on any partition fails the gate before it runs, naming the subdirectory", async () => {
  const broken = monorepoHarness((root) => ({
    overrides: [{ repoRoot: join(root, "apps/web"), command: ["npm", "test"] }, appOverrides(root)[1]!],
    budget: { released: 0 },
    answer: () => assert.fail("must not run"),
  }));
  const outcome = await broken.check();
  assert.equal(outcome.status, "failed");
  assert.match(outcome.note, /The affected-tests Command for apps\/web: .*must contain/);
  assert.equal(broken.runs.length, 0);
  assert.equal(broken.budget!.released, 1);
});

test("one gate attempt spends one run of a capped budget however many partitions it has", async () => {
  // A budget of one run, shared by every attempt of the gate: the first attempt's three
  // partitions spend it once, and the next attempt is refused rather than spending more.
  let spent = 0;
  const reserve = () => {
    const granted = spent < 1;
    if (granted) spent++;
    return { granted, spent: granted ? spent - 1 : spent };
  };
  const first = monorepoHarness({ reserve });
  assert.equal((await first.check()).status, "passed");
  assert.equal(first.runs.length, 3);
  assert.equal(spent, 1);

  const second = monorepoHarness({ reserve, answer: () => assert.fail("must not run") });
  const outcome = await second.check();
  assert.equal(outcome.status, "budget_spent");
  assert.equal(spent, 1);
});

test("a partition that times out ends the gate there, unrun partitions after it, with the supervisor's answer kept", async () => {
  const budget = { released: 0 };
  const timedOut = "the affected-tests command timed out after 600000 ms";
  const h = monorepoHarness({
    budget,
    // The second partition, apps/api, times out. Its group was torn down and proven empty.
    answer: (run) => run.workingSubpath === "apps/api"
      ? { exitCode: 0, abnormal: { result: { kind: "infrastructure", reason: timedOut }, emptiness: "empty" } }
      : { exitCode: 0 },
  });
  const result = await h.run();
  // apps/web, which would have run third, was never spawned.
  assert.deepEqual(h.runs.map((run) => run.workingSubpath), ["", "apps/api"]);
  // The supervisor's own outcome, not a verdict built from the partitions that did finish.
  assert.deepEqual(result, { kind: "infrastructure", reason: timedOut });
  // A proven-empty group hands the tree back; a command did run, so the budget stays spent.
  assert.equal(h.released(), 1);
  assert.equal(h.handedOff(), 0);
  assert.equal(h.reserved(), 1);
  assert.equal(budget.released, 0);
});

test("a rerun that leaves its process group running ends the gate before the next partition", async () => {
  let root = "";
  const h = monorepoHarness({
    answer: (run, index) => {
      if (run.workingSubpath !== "apps/api") return { exitCode: 0 };
      // The api app fails once, then its rerun exits 0 with a child still in the group.
      if (index === 1) {
        return { exitCode: 1, xml: junit(join(root, "apps/api"), [{ file: "lib/c.spec.ts", name: "c", failure: "boom" }]) };
      }
      return {
        exitCode: 0,
        abnormal: { result: { kind: "exited", exitCode: 0, output: "rerun\n", truncatedBytes: 0 }, emptiness: "not-empty" },
      };
    },
  });
  root = h.root;
  const result = await h.run();
  assert.deepEqual(h.runs.map((run) => [run.workingSubpath, run.files]), [
    ["", ["packages/ui/src/button.test.ts", "tools/root-smoke.test.ts"]],
    ["apps/api", ["lib/c.spec.ts", "smoke.spec.ts"]],
    ["apps/api", ["lib/c.spec.ts"]],
  ]);
  assert.equal(result.kind, "infrastructure");
  if (result.kind !== "infrastructure") return;
  // The rerun's own exit is what the reason carries, and the tree is kept for reclamation.
  assert.match(result.reason, /ran and exited 0, but that result is not reported/);
  assert.match(result.reason, /could not be proven empty \(not-empty\)/);
  assert.equal(h.handedOff(), 1);
  assert.equal(h.released(), 0);
});

/** The `index`th one-test folder of `capHarness`, in path order. */
function folderOf(index: number): string {
  return `pkg/p${String(index).padStart(3, "0")}`;
}

/**
 * A repository of `count` one-test folders. `covered` gives each folder its own override; otherwise
 * only `run/` has one, so every folder's test is selected but unrun. `withRoot` adds a test at the
 * root and a global default to run it; otherwise there is no default.
 */
function capHarness(count: number, covered: boolean, withRoot = false) {
  const root = tree({ tests: { patterns: ["**/*.test.ts"], includeImporters: false } });
  const folders = Array.from({ length: count }, (_, index) => folderOf(index));
  const files = [
    ...(withRoot ? ["a.test.ts"] : []),
    ...folders.map((folder) => `${folder}/a.test.ts`),
    ...(covered ? [] : ["run/a.test.ts"]),
  ];
  for (const file of files) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), "export {};\n");
  }
  const overrides = (covered ? folders : ["run"]).map((folder) => ({ repoRoot: join(root, folder), command: TEMPLATE }));
  return harness({
    root,
    changed: files,
    tracked: files,
    overrides,
    defaultCommand: withRoot ? TEMPLATE : null,
    answer: () => ({ exitCode: 0 }),
  });
}

/** One section of the rendered card: from its heading to the next of `ends`, or the end. */
function section(html: string, heading: string, ends: string[]): string {
  const start = html.indexOf(heading);
  assert.ok(start >= 0, `${heading} is rendered`);
  const stops = ends.map((end) => html.indexOf(end, start + heading.length)).filter((at) => at >= 0);
  return html.slice(start, stops.length === 0 ? html.length : Math.min(...stops));
}

for (const [count, withRoot] of [[51, false], [WORKFLOW_LIMITS.commandOverrides, true]] as const) {
  const total = count + (withRoot ? 1 : 0);
  test(`${total} partitions are every one recorded and listed in run detail`, async () => {
    const h = capHarness(count, true, withRoot);
    // `check` parses the outcome through the durable schema, so the most a gate can have fits it.
    const outcome = await h.check();
    assert.equal(outcome.status, "passed", outcome.note);
    assert.equal(h.runs.length, total);
    const partitions = outcome.affected!.partitions!;
    assert.deepEqual(partitions.map((partition) => partition.subpath), h.runs.map((run) => run.workingSubpath));
    if (withRoot) assert.equal(total, AFFECTED_TESTS_LIMITS.partitions);

    const html = renderToStaticMarkup(createElement(AffectedTestsDetails, { report: outcome.affected! }));
    const listed = section(html, `Partitions (${total})`, ["Selected but unrun", "Settings:"]);
    assert.equal(listed.match(/aria-label="Partition /g)?.length, total);
    assert.match(listed, new RegExp(`aria-label="Partition ${folderOf(count - 1)}"`));
    assert.doesNotMatch(listed, /not listed here/);
  });
}

for (const count of [51, 300]) {
  test(`${count} selected-but-unrun tests are every one recorded and listed in run detail`, async () => {
    const h = capHarness(count, false);
    const outcome = await h.check();
    // The one covered test ran and passed; the gate decided on it.
    assert.equal(outcome.status, "passed", outcome.note);
    assert.deepEqual(h.runs.map((run) => run.workingSubpath), ["run"]);
    const unrun = outcome.affected!.unrun!;
    assert.equal(unrun.length, count);
    assert.equal(unrun[0], `${folderOf(0)}/a.test.ts`);
    assert.equal(unrun.at(-1), `${folderOf(count - 1)}/a.test.ts`);
    assert.match(outcome.note, new RegExp(`${count} selected test files were not run`));

    const html = renderToStaticMarkup(createElement(AffectedTestsDetails, { report: outcome.affected! }));
    const listed = section(html, `Selected but unrun (${count})`, ["Settings:"]);
    // Five inline and the rest folded, every one of them a list item.
    assert.equal(listed.match(/<li><code>/g)?.length, count);
    assert.match(listed, new RegExp(`${count - 5} more unrun`));
    assert.doesNotMatch(listed, /not listed here/);
  });
}

test("the gate's combined output keeps the outcome's tail, counting every byte it drops, while each partition keeps its own", async () => {
  const outputs: Record<string, string> = {
    "": `root start ${"r".repeat(2_990)}root end\n`,
    "apps/api": `api start ${"a".repeat(2_990)}api end\n`,
    "apps/web": `web start ${"w".repeat(2_990)}web end\n`,
  };
  const h = monorepoHarness({ answer: (run) => ({ exitCode: 0, output: outputs[run.workingSubpath]! }) });
  const outcome = await h.check();
  assert.equal(outcome.status, "passed", outcome.note);

  // Bounded by the executor itself, not only by `runCheck` afterwards.
  const raw = h.raw();
  assert.equal(raw?.kind, "decided");
  if (raw?.kind !== "decided") return;
  const kept = Buffer.byteLength(raw.output);
  assert.ok(kept <= WORKFLOW_EXECUTION_LIMITS.checkOutput, `kept ${kept} bytes`);
  const banners = ["the repository root: 2 files", "apps/api: 2 files", "apps/web: 3 files"]
    .map((label) => `[Mission Control] ${label}, passed.\n\n`);
  const whole = banners.map((banner, index) => banner + Object.values(outputs)[index]).join("\n\n");
  assert.equal(raw.truncatedBytes, Buffer.byteLength(whole) - kept);
  // The tail: the last partition's output ends it, and the first partition's start is gone.
  assert.ok(raw.output.endsWith("web end\n"));
  assert.ok(!raw.output.includes("root start"));
  // The outcome records the same bound, and each partition its own 2,000-byte tail.
  assert.equal(outcome.output, raw.output);
  assert.equal(outcome.truncatedBytes, raw.truncatedBytes);
  for (const partition of outcome.affected!.partitions!) {
    assert.equal(Buffer.byteLength(partition.output), AFFECTED_TESTS_LIMITS.partitionOutput);
    assert.equal(
      partition.truncatedBytes,
      Buffer.byteLength(outputs[partition.subpath]!) - AFFECTED_TESTS_LIMITS.partitionOutput,
    );
  }
});

// ---- The gate's deadline: twice the command timeout, from when the partitions start ---------

const TIMEOUT_MS = 1_000;

test("the gate's deadline stops a later partition, which fails the gate naming it as unfinished", async () => {
  const clock = { at: 0 };
  const budget = { released: 0 };
  // Each run takes 800 ms. The root and apps/api finish at 1,600 ms, so apps/web is allowed only
  // the 400 ms left before the 2,000 ms deadline, and is stopped there.
  const h = monorepoHarness({ clock, timeoutMs: TIMEOUT_MS, budget, answer: () => ({ exitCode: 0, durationMs: 800 }) });
  const outcome = await h.check();
  assert.deepEqual(h.runs.map((run) => [run.workingSubpath, run.timeoutMs]), [
    ["", TIMEOUT_MS],
    ["apps/api", TIMEOUT_MS],
    ["apps/web", 400],
  ]);
  assert.equal(clock.at, 2_000);
  assert.equal(outcome.status, "failed");
  assert.match(outcome.note, /Ran 4 selected test files in 2 partitions before the gate's 2 seconds deadline; 1 partition did not finish \(apps\/web\), so the gate fails rather than pass on part of the change\.$/);
  assert.equal(outcome.affected?.deadlineMs, 2_000);
  assert.deepEqual(outcome.affected?.unfinished, [
    { subpath: "apps/web", command: TEMPLATE, source: "override", fileCount: 3, stopped: true },
  ]);
  assert.deepEqual(outcome.affected?.partitions?.map((partition) => partition.subpath), ["", "apps/api"]);
  assert.match(outcome.output, /The gate's 2 seconds deadline passed; apps\/web did not finish\./);
  // Partitions ran, so the run is spent, and the stopped group was proven empty: the tree went back.
  assert.equal(outcome.exitCode, 0);
  assert.equal(h.reserved(), 1);
  assert.equal(budget.released, 0);
  assert.equal(h.released(), 1);
  const verdict = checkVerdict(outcome, "attempt-1");
  assert.equal(verdict?.verdict, "fail");
});

test("a partition the deadline left no time for is never started, and is listed as not started", async () => {
  const clock = { at: 0 };
  // The root and apps/api each take the full timeout, which spends the whole deadline.
  const h = monorepoHarness({ clock, timeoutMs: TIMEOUT_MS, answer: () => ({ exitCode: 0, durationMs: TIMEOUT_MS }) });
  const outcome = await h.check();
  assert.deepEqual(h.runs.map((run) => run.workingSubpath), ["", "apps/api"]);
  assert.equal(outcome.status, "failed");
  assert.deepEqual(outcome.affected?.unfinished?.map(({ subpath, stopped }) => ({ subpath, stopped })), [
    { subpath: "apps/web", stopped: false },
  ]);
});

test("a rerun the deadline stops leaves its partition unfinished, along with every partition after it", async () => {
  let root = "";
  const clock = { at: 0 };
  // apps/api fails once at 1,500 ms, so its rerun is allowed 500 ms, takes 800 and is stopped.
  const h = monorepoHarness({
    clock,
    timeoutMs: TIMEOUT_MS,
    answer: (run, index) => index === 1
      ? { exitCode: 1, durationMs: 700, xml: junit(join(root, "apps/api"), [{ file: "lib/c.spec.ts", name: "c", failure: "boom" }]) }
      : { exitCode: 0, durationMs: 800 },
  });
  root = h.root;
  const outcome = await h.check();
  assert.deepEqual(h.runs.map((run) => [run.workingSubpath, run.timeoutMs]), [
    ["", TIMEOUT_MS],
    ["apps/api", TIMEOUT_MS],
    ["apps/api", 500],
  ]);
  assert.equal(outcome.status, "failed");
  assert.deepEqual(outcome.affected?.unfinished?.map(({ subpath, stopped }) => ({ subpath, stopped })), [
    { subpath: "apps/api", stopped: true },
    { subpath: "apps/web", stopped: false },
  ]);
  assert.match(outcome.note, /2 partitions did not finish \(apps\/api, apps\/web\)/);
});

test("a single invocation keeps its full run and rerun, and its own timeout stays infrastructure", async () => {
  const root = tree(CONFIG);
  const clock = { at: 0 };
  const h = harness({
    root,
    changed: ["test/a.test.ts"],
    tracked: TRACKED,
    clock,
    timeoutMs: TIMEOUT_MS,
    answer: (_run, index) => index === 0
      ? { exitCode: 1, durationMs: 900, xml: junit(root, [{ file: "test/a.test.ts", name: "adds", failure: "1 !== 2" }]) }
      : { exitCode: 0, durationMs: 900 },
  });
  const outcome = await h.check();
  // The rerun starts at 900 ms with 1,100 ms left before the deadline: it still gets a full timeout.
  assert.deepEqual(h.runs.map((run) => run.timeoutMs), [TIMEOUT_MS, TIMEOUT_MS]);
  assert.equal(outcome.status, "passed");
  assert.equal(outcome.affected?.unfinished, undefined);
  assert.equal(outcome.affected?.deadlineMs, undefined);

  // A run that outlasts a FULL timeout is the command's own timeout: infrastructure, as before.
  const slow = harness({
    root: tree(CONFIG),
    changed: ["test/a.test.ts"],
    tracked: TRACKED,
    clock: { at: 0 },
    timeoutMs: TIMEOUT_MS,
    answer: () => ({ exitCode: 0, durationMs: 1_500 }),
  });
  const result = await slow.run();
  assert.equal(result.kind, "infrastructure");
  if (result.kind === "infrastructure") assert.match(result.reason, /did not finish within 1000ms/);
});

test("a single partition reads exactly as the one invocation it always was", async () => {
  const root = tree(CONFIG);
  const h = harness({ root, changed: ["test/a.test.ts"], tracked: TRACKED, answer: () => ({ exitCode: 0 }) });
  const outcome = await h.check();
  assert.match(outcome.note, /: Ran 2 selected test files; all passed\.$/);
  assert.equal(outcome.output, "run 1\n");
  assert.deepEqual(outcome.affected?.partitions, [{
    subpath: "",
    command: TEMPLATE,
    source: "default",
    fileCount: 2,
    status: "passed",
    exitCode: 0,
    note: "Ran 2 selected test files; all passed.",
    output: "run 1\n",
    truncatedBytes: 0,
  }]);
});

test("a repository with no subdirectory scope records neither scopes nor diagnostics", async () => {
  const root = tree(CONFIG);
  const h = harness({ root, changed: ["test/a.test.ts"], tracked: TRACKED, answer: () => ({ exitCode: 0 }) });
  const outcome = await h.check();
  assert.equal(outcome.status, "passed");
  assert.equal(outcome.affected?.settings.scopes, undefined);
  assert.equal(outcome.affected?.settings.scopeCount, undefined);
  assert.equal(outcome.affected?.diagnostics, undefined);
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

/** A failed affected-tests outcome naming `failures`, out of 58 that failed twice. */
function failedOutcome(failures: { file: string; name: string; message: string }[]): WorkflowCheckOutcome {
  return WorkflowCheckOutcomeSchema.parse({
    status: "failed",
    slot: "affected-tests",
    command: TEMPLATE,
    exitCode: 1,
    output: "the end of the run log",
    truncatedBytes: 0,
    note: "Ran 542 selected test files; 58 tests failed twice.",
    affected: {
      selectedCount: 542,
      selected: [],
      flakeCount: 0,
      flakes: [],
      failureCount: 58,
      failures,
      settings: { patterns: ["test/*.test.ts"], includeImporters: true, smokeSet: [], localKeys: [] },
    },
  });
}

// Every message at the cap: multi-byte text, and newlines and quotes that JSON escaping inflates.
const LONG_MESSAGE = "断言失败: \"expected\" ≠ \"actual\"\n"
  .repeat(AFFECTED_TESTS_LIMITS.failureMessage)
  .slice(0, AFFECTED_TESTS_LIMITS.failureMessage);

function assertWithinBudget(verdict: unknown): void {
  assert.ok(Buffer.byteLength(JSON.stringify(verdict)) <= WORKFLOW_EXECUTION_LIMITS.verdictJsonBytes);
}

test("many failing tests with long messages still make a valid failing verdict that fits its budget", () => {
  const failures = Array.from({ length: AFFECTED_TESTS_LIMITS.failures }, (_, index) => ({
    file: `test/suite-${index}.test.ts`,
    name: `case ${index} keeps its invariant`,
    message: LONG_MESSAGE,
  }));
  const verdict = checkVerdict(failedOutcome(failures), "attempt-1");
  assert.equal(verdict?.verdict, "fail");
  if (verdict?.verdict !== "fail") return;
  assertWithinBudget(verdict);
  const [first] = verdict.requestedChanges;
  assert.equal(first!.title, "Fix the failing test \"case 0 keeps its invariant\" in test/suite-0.test.ts");
  assert.equal(first!.evidence[0]!.kind, "check");
  // The messages share the budget, so each is shortened and every capped failure still fits.
  assert.equal(verdict.requestedChanges.length, failures.length);
  for (const change of verdict.requestedChanges) {
    const quote = change.evidence[0]!.quote!;
    assert.ok(quote.length > 0 && quote.length < LONG_MESSAGE.length && LONG_MESSAGE.startsWith(quote));
    assert.ok(change.rationale.endsWith(`${quote}…`));
  }
  assert.match(
    first!.rationale,
    /58 tests failed twice in this check; only the first 20 are listed\. This check's run detail has the rest\./,
  );
});

test("failures that cannot all fit the verdict budget are listed in part, saying how many", () => {
  // Names and paths near their caps, in three-byte characters: every title is kilobytes.
  const failures = Array.from({ length: AFFECTED_TESTS_LIMITS.failures }, (_, index) => ({
    file: `test/${"深".repeat(AFFECTED_TESTS_LIMITS.path - 20)}-${index}.test.ts`,
    name: `case ${index} ${"名".repeat(AFFECTED_TESTS_LIMITS.testName - 20)}`,
    message: LONG_MESSAGE,
  }));
  const verdict = checkVerdict(failedOutcome(failures), "attempt-1");
  assert.equal(verdict?.verdict, "fail");
  if (verdict?.verdict !== "fail") return;
  assertWithinBudget(verdict);
  const listed = verdict.requestedChanges.length;
  assert.ok(listed >= 1 && listed < failures.length, `listed ${listed}`);
  assert.match(verdict.requestedChanges[0]!.title, /^Fix the failing test "case 0 /);
  assert.match(
    verdict.requestedChanges[0]!.rationale,
    new RegExp(`58 tests failed twice in this check; only the first ${listed} are listed\\. This check's run detail has the rest\\.`),
  );
});

test("a failing test too large for any verdict falls back to the output tail, never to no verdict", () => {
  // A name of quotes and a message of backslashes double when JSON escapes them, and the path's
  // three-byte characters triple: one failure alone is over the budget.
  const outcome = failedOutcome([{
    file: "测".repeat(AFFECTED_TESTS_LIMITS.path),
    name: "\"".repeat(AFFECTED_TESTS_LIMITS.testName),
    message: "\\".repeat(AFFECTED_TESTS_LIMITS.failureMessage),
  }]);
  const verdict = checkVerdict(outcome, "attempt-1");
  assert.equal(verdict?.verdict, "fail");
  if (verdict?.verdict !== "fail") return;
  assertWithinBudget(verdict);
  assert.equal(verdict.requestedChanges.length, 1);
  assert.equal(verdict.requestedChanges[0]!.title, "Fix the failing affected-tests check");
  assert.equal(verdict.requestedChanges[0]!.rationale, "the end of the run log");
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
  assert.doesNotMatch(verdict.requestedChanges[1]!.rationale, /only the first/);
});
