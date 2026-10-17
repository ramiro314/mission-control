import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { junitCaseKey, parseJUnit, type JUnitCase } from "@shared/junit.ts";
import { expandTestCommandTemplate } from "@shared/command-template.ts";
import {
  AFFECTED_TESTS_LIMITS,
  WORKFLOW_EXECUTION_LIMITS,
  WORKFLOW_LIMITS,
  affectedTestsTargetFor,
  commandTemplateProblem,
  type WorkflowAffectedTestsPartition,
  type WorkflowAffectedTestsReport,
  type WorkflowCommandResolution,
  type WorkflowNamedTest,
  type WorkflowSelectedTest,
  type WorkflowTestFailure,
} from "@shared/workflow.ts";
import type { StoredTestingLayer, TestingScopes } from "@shared/testing-config.ts";
import { resolveTestingScopes } from "../testing-config.ts";
import { realpathOr } from "../util/repo-doc.ts";
import { selectAffectedTests, type TestSelectionDeps } from "../test-selection.ts";
import { tailBounded, type CheckExecutionResult } from "./checks.ts";
import type { CheckSpawnOutcome } from "./check-supervisor.ts";

// The `affected-tests` slot's half of the executor: pick the tests once, partition them across
// the repository's affected-tests Commands, and for each partition fill its template, run it in
// its subdirectory, read its JUnit results, rerun only its failed files once, and decide.
//
// It runs INSIDE one executor call, so selection and every partition's run and rerun share one
// worktree lease, one test lease and one run of the Command's budget, and nothing awaits between
// the budget's reservation and the first spawn except the selection the spawn needs. It never
// records an expanded argv: the outcome and each partition carry the configured template.

/** A JUnit file larger than this is not read. */
const MAX_JUNIT_BYTES = 32 * 1024 * 1024;

/** The template with `{files}` and `{junit}` filled in. */
export const expandAffectedTestsTemplate = expandTestCommandTemplate;

/** What the executor hands this module once it holds a tree. */
export interface AffectedTestsContext {
  /**
   * Every place this repository can run tests, root first then each subdirectory override, as
   * `affectedTestsTargets` lists them. Each selected test runs in the deepest one holding it.
   */
  targets: readonly WorkflowCommandResolution[];
  /** The leased check worktree: the committed config and the code under review. */
  treeRoot: string;
  /** The operator's own checkout, where the gitignored local override lives. */
  localRoot: string | null;
  /** The task's base branch the change is measured from, or null for origin's default. */
  baseBranch: string | null;
  /**
   * Every stored testing settings row for the repository, the root's with scope `""` and each
   * subdirectory's with its repository-relative path. Read when selection starts rather than
   * when the context is built, so a failed read is caught with the rest of selection. Absent
   * means none are stored.
   */
  readStoredSettings?: () => readonly StoredTestingLayer[];
  selection?: TestSelectionDeps;
}

/** One target and the selected files it runs, in tree-path order. */
export interface AffectedTestsPartitionPlan {
  target: WorkflowCommandResolution;
  files: WorkflowSelectedTest[];
}

/** Either nothing to run (the check ends here), or the partitions to run, in order. */
export type AffectedTestsPlan =
  | { kind: "done"; result: CheckExecutionResult }
  | {
    kind: "run";
    /** Never empty. In `targets` order: the root's first, then each subdirectory's by path. */
    partitions: AffectedTestsPartitionPlan[];
    /** Every selected file no target holds, repository-relative. */
    unrun: string[];
    report: WorkflowAffectedTestsReport;
  };

/**
 * The root's effective settings, as before scopes existed, plus each subdirectory scope's
 * sources. A scope's globs are not recorded: they are bounded per scope, not across scopes, and
 * the sources already say which row to open.
 */
function settingsOf(scopes: TestingScopes): WorkflowAffectedTestsReport["settings"] {
  const { root } = scopes;
  const subdirectories = scopes.scopes.slice(1);
  return {
    patterns: root.config.tests.patterns,
    includeImporters: root.config.tests.includeImporters,
    smokeSet: root.config.tests.smokeSet,
    localKeys: root.localKeys,
    sources: root.sources,
    ...(subdirectories.length === 0 ? {} : {
      scopes: subdirectories.slice(0, AFFECTED_TESTS_LIMITS.scopes).map((scope) => ({
        path: clip(scope.path, WORKFLOW_LIMITS.checkRepoRoot),
        sources: scope.sources,
      })),
      scopeCount: subdirectories.length,
    }),
  };
}

function decided(
  status: "passed" | "failed" | "skipped" | "unavailable",
  note: string,
  over: Partial<Extract<CheckExecutionResult, { kind: "decided" }>> = {},
): CheckExecutionResult {
  return { kind: "decided", status, note, exitCode: null, output: "", truncatedBytes: 0, ...over };
}

/** Read the settings and select the tests. Everything before the test lease is taken. */
export async function planAffectedTests(ctx: AffectedTestsContext): Promise<AffectedTestsPlan> {
  if (ctx.targets.length === 0) {
    return { kind: "done", result: decided("skipped", "No affected-tests Command is configured for this repository.") };
  }
  // A bad template fails the gate before anything is read, as a single Command always did. Every
  // target is checked, not only those this change reaches: a broken Command must not pass for as
  // long as no change happens to touch its app.
  for (const target of ctx.targets) {
    const problem = commandTemplateProblem("affected-tests", target.command);
    if (problem) {
      const where = target.workingSubpath === "" ? "" : `The affected-tests Command for ${target.workingSubpath}: `;
      return { kind: "done", result: decided("failed", `${where}${problem}`) };
    }
  }

  const read = resolveTestingScopes(ctx.treeRoot, ctx.localRoot, ctx.readStoredSettings?.() ?? []);
  if (!read.ok) {
    if (read.kind === "missing") return { kind: "done", result: decided("skipped", read.note) };
    if (read.kind === "invalid-local") {
      return {
        kind: "done",
        result: decided("unavailable", `${read.note} Fix or remove the local override; this gate did not run.`),
      };
    }
    return { kind: "done", result: decided("failed", read.note) };
  }

  // Selected once across the repository, then partitioned by target below.
  const selection = await selectAffectedTests(ctx.treeRoot, read.scopes, ctx.selection, ctx.baseBranch);
  if (!selection.ok) {
    return {
      kind: "done",
      result: { kind: "infrastructure", reason: `tests for the affected-tests check could not be selected: ${selection.reason}` },
    };
  }
  const report: WorkflowAffectedTestsReport = {
    selectedCount: selection.files.length,
    selected: selection.files.slice(0, AFFECTED_TESTS_LIMITS.selectionShown).map(boundSelected),
    flakeCount: 0,
    flakes: [],
    failureCount: 0,
    failures: [],
    settings: settingsOf(read.scopes),
    ...(selection.diagnostics.length === 0 ? {} : {
      diagnostics: selection.diagnostics
        .slice(0, AFFECTED_TESTS_LIMITS.diagnostics)
        .map((note) => clip(note, AFFECTED_TESTS_LIMITS.diagnostic)),
    }),
  };
  if (selection.files.length === 0) {
    return {
      kind: "done",
      result: decided("skipped", "No tests were selected for this change.", { affected: report }),
    };
  }

  // Each selected file to the deepest target holding it; the rest are selected but unrun.
  const byTarget = new Map<WorkflowCommandResolution, WorkflowSelectedTest[]>();
  const unrun: string[] = [];
  for (const file of selection.files) {
    const target = affectedTestsTargetFor(ctx.targets, file.path);
    if (!target) {
      unrun.push(file.path);
      continue;
    }
    const files = byTarget.get(target) ?? [];
    files.push(file);
    byTarget.set(target, files);
  }
  const partitions = ctx.targets
    .filter((target) => byTarget.has(target))
    .map((target) => ({ target, files: byTarget.get(target)! }));
  const planned: WorkflowAffectedTestsReport = unrun.length === 0 ? report : {
    ...report,
    unrun: unrun.slice(0, AFFECTED_TESTS_LIMITS.unrunShown).map((path) => clip(path, AFFECTED_TESTS_LIMITS.path)),
    unrunCount: unrun.length,
  };
  if (partitions.length === 0) {
    // Selected, but no Command can run any of it. Nothing ran, so the run goes back.
    return { kind: "done", result: decided("skipped", unrunSentence(unrun.length), { affected: planned }) };
  }
  return { kind: "run", partitions, unrun, report: planned };
}

/** Says how many selected files no Command could run, as a sentence of its own. */
function unrunSentence(count: number): string {
  return count === 1
    ? "1 selected test file was not run: no affected-tests Command covers it."
    : `${count} selected test files were not run: no affected-tests Command covers them.`;
}

/** A partition's subdirectory, as a sentence names it. */
function partitionLabel(subpath: string): string {
  return subpath === "" ? "the repository root" : subpath;
}

function boundSelected(file: WorkflowSelectedTest): WorkflowSelectedTest {
  return {
    ...file,
    path: clip(file.path, AFFECTED_TESTS_LIMITS.path),
    ...(file.via === undefined ? {} : { via: clip(file.via, AFFECTED_TESTS_LIMITS.path) }),
  };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Runs one expanded argv under the executor's supervisor, in a subdirectory of the leased tree. */
export type AffectedTestsSpawn = (argv: string[], workingSubpath: string) => Promise<CheckSpawnOutcome>;

/** One run of the template, read back. */
type RunRead =
  /** It did not run to a proven-empty group, or was not a test run at all: pass it through. */
  | { kind: "aborted"; outcome: CheckSpawnOutcome }
  | { kind: "unreadable"; exitCode: number; output: string; truncatedBytes: number; error: string }
  | { kind: "read"; failed: Map<string, NamedCase>; exitCode: number; output: string; truncatedBytes: number };

interface NamedCase {
  /** Repository-relative when it maps into the tree, else as reported. */
  file: string | null;
  /** True when `file` is one of the selected files, so it can be rerun alone. */
  selected: boolean;
  testCase: JUnitCase;
}

/** One partition, run and rerun, decided on its own. */
interface PartitionRun {
  status: "passed" | "failed";
  note: string;
  exitCode: number;
  output: string;
  truncatedBytes: number;
  flakes: WorkflowNamedTest[];
  failures: WorkflowTestFailure[];
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Run each partition's files, and its failed ones once more, one partition after another, and
 * decide: the gate passes only if every partition that ran passed.
 *
 * Returns a spawn outcome so the executor settles the lease exactly as it does for any other
 * slot. A run whose group could not be proven empty is passed straight through and never
 * followed by another spawn, neither its partition's rerun nor a later partition, so every
 * outcome built here follows a proven-empty last run.
 */
export async function runAffectedTests(
  ctx: AffectedTestsContext,
  plan: Extract<AffectedTestsPlan, { kind: "run" }>,
  spawn: AffectedTestsSpawn,
): Promise<CheckSpawnOutcome> {
  const dir = mkdtempSync(join(tmpdir(), "mission-junit-"));
  try {
    const runs: PartitionResult[] = [];
    for (const [index, partition] of plan.partitions.entries()) {
      // Each partition's own directory, so its results never meet another's.
      const junitDir = join(dir, `partition-${index + 1}`);
      mkdirSync(junitDir);
      const run = await runPartition(ctx, partition, junitDir, spawn);
      if ("outcome" in run) return run.outcome;
      runs.push({ partition, run });
    }
    return { result: decideGate(plan, runs), emptiness: "empty", supervisor: null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface PartitionResult {
  partition: AffectedTestsPartitionPlan;
  run: PartitionRun;
}

async function runPartition(
  ctx: AffectedTestsContext,
  partition: AffectedTestsPartitionPlan,
  junitDir: string,
  spawn: AffectedTestsSpawn,
): Promise<PartitionRun | { outcome: CheckSpawnOutcome }> {
  const { target, files } = partition;
  const cwd = join(ctx.treeRoot, target.workingSubpath);
  const roots = [realpathOr(ctx.treeRoot), ctx.treeRoot];
  const selectedPaths = new Set(files.map((file) => file.path));
  const argFor = (path: string) => relative(cwd, join(ctx.treeRoot, path)) || ".";
  const ranLabel = `Ran ${plural(files.length, "selected test file", "selected test files")}`;

  const mapFile = (reported: string | null): string | null => {
    if (reported === null) return null;
    const abs = isAbsolute(reported) ? reported : resolve(cwd, reported);
    for (const root of roots) {
      const rel = relative(root, abs);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split("\\").join("/");
    }
    return reported;
  };

  const runOnce = async (paths: readonly string[], junitPath: string): Promise<RunRead> => {
    const argv = expandAffectedTestsTemplate(target.command, paths.map(argFor), junitPath);
    const outcome = await spawn(argv, target.workingSubpath);
    if (outcome.result.kind !== "exited" || outcome.emptiness !== "empty") return { kind: "aborted", outcome };
    const { exitCode, output, truncatedBytes } = outcome.result;
    if (exitCode === 0) return { kind: "read", failed: new Map(), exitCode, output, truncatedBytes };
    const read = readJUnitFile(junitPath);
    if (!read.ok) return { kind: "unreadable", exitCode, output, truncatedBytes, error: read.error };
    const failed = new Map<string, NamedCase>();
    for (const testCase of read.cases) {
      if (testCase.status !== "failed") continue;
      const file = mapFile(testCase.file);
      failed.set(junitCaseKey({ ...testCase, file }), {
        file,
        selected: file !== null && selectedPaths.has(file),
        testCase,
      });
    }
    return { kind: "read", failed, exitCode, output, truncatedBytes };
  };

  const finish = (
    status: "passed" | "failed",
    note: string,
    run: { exitCode: number; output: string; truncatedBytes: number },
    named: { flakes: WorkflowNamedTest[]; failures: WorkflowTestFailure[] } = { flakes: [], failures: [] },
  ): PartitionRun => ({
    status,
    note,
    exitCode: run.exitCode,
    output: run.output,
    truncatedBytes: run.truncatedBytes,
    ...named,
  });

  const first = await runOnce(files.map((file) => file.path), join(junitDir, "junit-1.xml"));
  if (first.kind === "aborted") return { outcome: first.outcome };
  if (first.kind === "unreadable") {
    return finish("failed", `${ranLabel}; it exited ${first.exitCode} and its JUnit results could not be read (${first.error}).`, first);
  }
  if (first.exitCode === 0) return finish("passed", `${ranLabel}; all passed.`, first);
  if (first.failed.size === 0) {
    return finish("failed", `${ranLabel}; it exited ${first.exitCode}, but its JUnit results name no failing test.`, first);
  }

  // Only the failed files, unless a failure cannot be traced to one - then all of them.
  const failedCases = [...first.failed.values()];
  const rerunPaths = failedCases.every((entry) => entry.selected)
    ? [...new Set(failedCases.map((entry) => entry.file!))].sort()
    : files.map((file) => file.path);
  const banner = `\n\n[Mission Control] ${plural(first.failed.size, "test", "tests")} failed; `
    + `rerunning ${plural(rerunPaths.length, "file", "files")} once.\n\n`;
  const second = await runOnce(rerunPaths, join(junitDir, "junit-2.xml"));
  if (second.kind === "aborted") return { outcome: second.outcome };
  const both = {
    exitCode: second.exitCode,
    output: first.output + banner + second.output,
    truncatedBytes: first.truncatedBytes + second.truncatedBytes,
  };
  if (second.kind === "unreadable") {
    return finish("failed", `${ranLabel}; the rerun exited ${second.exitCode} and its JUnit results could not be read (${second.error}).`, both);
  }
  if (second.exitCode !== 0 && second.failed.size === 0) {
    return finish("failed", `${ranLabel}; the rerun exited ${second.exitCode}, but its JUnit results name no failing test.`, both);
  }

  const failures: WorkflowTestFailure[] = [];
  const flakes: WorkflowNamedTest[] = [];
  for (const [key, entry] of first.failed) {
    const again = second.failed.get(key);
    if (again) failures.push(failureOf(again));
    else flakes.push(namedOf(entry));
  }
  // Passed first and failed on the rerun: it did not fail twice, so it is a flake too.
  for (const [key, entry] of second.failed) {
    if (!first.failed.has(key)) flakes.push(namedOf(entry));
  }
  const flaked = flakes.length === 0
    ? ""
    : `; ${plural(flakes.length, "test", "tests")} flaked and passed on rerun`;
  return failures.length === 0
    ? finish("passed", `${ranLabel}${flaked}.`, both, { flakes, failures })
    : finish("failed", `${ranLabel}; ${plural(failures.length, "test", "tests")} failed twice${flaked}.`, both, { flakes, failures });
}

/** Failed partitions a gate note names before saying how many more. */
const NOTE_PARTITIONS_NAMED = 3;

/**
 * Room for the gate's note once `runCheck` prefixes the command: the outcome's note is bounded
 * by `verdictSummary`, and a note that took all of it would leave the command no characters.
 */
const NOTE_MAX = Math.floor(WORKFLOW_EXECUTION_LIMITS.verdictSummary / 2);

/** Every partition that ran, decided as one gate: it passes only if each of them passed. */
function decideGate(
  plan: Extract<AffectedTestsPlan, { kind: "run" }>,
  runs: readonly PartitionResult[],
): CheckExecutionResult {
  const flakes = runs.flatMap(({ run }) => run.flakes);
  const failures = runs.flatMap(({ run }) => run.failures);
  const failed = runs.filter(({ run }) => run.status === "failed");
  const unrunNote = plan.unrun.length === 0 ? "" : ` ${unrunSentence(plan.unrun.length)}`;

  let note: string;
  let exitCode: number;
  let output: string;
  let truncatedBytes: number;
  if (runs.length === 1) {
    // One invocation reads exactly as the gate always did.
    const { run } = runs[0]!;
    ({ note, exitCode, output, truncatedBytes } = run);
  } else {
    const fileCount = runs.reduce((sum, { partition }) => sum + partition.files.length, 0);
    const ranLabel = `Ran ${plural(fileCount, "selected test file", "selected test files")} in ${runs.length} partitions`;
    const flaked = flakes.length === 0 ? "" : `${plural(flakes.length, "test", "tests")} flaked and passed on rerun`;
    if (failed.length === 0) {
      note = `${ranLabel}; ${flaked || "all passed"}.`;
    } else {
      const names = failed
        .slice(0, NOTE_PARTITIONS_NAMED)
        .map(({ partition }) => partitionLabel(partition.target.workingSubpath));
      if (failed.length > names.length) names.push(`${failed.length - names.length} more`);
      const twice = failures.length === 0 ? "" : `; ${plural(failures.length, "test", "tests")} failed twice`;
      note = `${ranLabel}; ${plural(failed.length, "partition", "partitions")} failed `
        + `(${names.join(", ")})${twice}${flaked ? `; ${flaked}` : ""}.`;
    }
    // The first failed partition's exit code, so the gate's names a run that failed it.
    exitCode = (failed[0] ?? runs[runs.length - 1]!).run.exitCode;
    output = runs
      .map(({ partition, run }) => `[Mission Control] ${partitionLabel(partition.target.workingSubpath)}: `
        + `${plural(partition.files.length, "file", "files")}, ${run.status}.\n\n${run.output}`)
      .join("\n\n");
    truncatedBytes = runs.reduce((sum, { run }) => sum + run.truncatedBytes, 0);
  }

  const affected: WorkflowAffectedTestsReport = {
    ...plan.report,
    flakeCount: flakes.length,
    flakes: flakes.slice(0, AFFECTED_TESTS_LIMITS.flakes),
    failureCount: failures.length,
    failures: failures.slice(0, AFFECTED_TESTS_LIMITS.failures),
    partitions: runs.slice(0, AFFECTED_TESTS_LIMITS.partitions).map(partitionOf),
    partitionCount: runs.length,
  };
  return decided(failed.length === 0 ? "passed" : "failed", clip(`${note}${unrunNote}`, NOTE_MAX), {
    exitCode,
    output,
    truncatedBytes,
    affected,
  });
}

function partitionOf({ partition, run }: PartitionResult): WorkflowAffectedTestsPartition {
  const tail = tailBounded(run.output, AFFECTED_TESTS_LIMITS.partitionOutput);
  return {
    subpath: clip(partition.target.workingSubpath, WORKFLOW_LIMITS.checkRepoRoot),
    command: [...partition.target.command],
    source: partition.target.source,
    fileCount: partition.files.length,
    status: run.status,
    exitCode: run.exitCode,
    note: clip(run.note, NOTE_MAX),
    output: tail.text,
    truncatedBytes: run.truncatedBytes + tail.droppedBytes,
  };
}

function namedOf(entry: NamedCase): WorkflowNamedTest {
  return {
    file: entry.file === null ? null : clip(entry.file, AFFECTED_TESTS_LIMITS.path),
    name: clip(entry.testCase.name, AFFECTED_TESTS_LIMITS.testName),
  };
}

function failureOf(entry: NamedCase): WorkflowTestFailure {
  const { message, detail } = entry.testCase;
  const text = [message, detail && detail !== message ? detail : null].filter(Boolean).join("\n\n");
  return {
    ...namedOf(entry),
    message: clip(text || "The test failed without a message.", AFFECTED_TESTS_LIMITS.failureMessage),
  };
}

function readJUnitFile(path: string): { ok: true; cases: JUnitCase[] } | { ok: false; error: string } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { ok: false, error: "the command wrote no results file" };
  }
  if (size > MAX_JUNIT_BYTES) return { ok: false, error: `the results file is larger than ${MAX_JUNIT_BYTES} bytes` };
  const parsed = parseJUnit(readFileSync(path, "utf8"));
  return parsed.ok ? { ok: true, cases: parsed.results.cases } : { ok: false, error: parsed.error };
}
