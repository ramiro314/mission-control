import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { junitCaseKey, parseJUnit, type JUnitCase } from "@shared/junit.ts";
import {
  AFFECTED_TESTS_FILES_PLACEHOLDER,
  AFFECTED_TESTS_JUNIT_PLACEHOLDER,
  AFFECTED_TESTS_LIMITS,
  commandTemplateProblem,
  type WorkflowAffectedTestsReport,
  type WorkflowNamedTest,
  type WorkflowSelectedTest,
  type WorkflowTestFailure,
} from "@shared/workflow.ts";
import type { MergedTestingConfig } from "@shared/testing-config.ts";
import { readTestingConfig } from "../testing-config.ts";
import { realpathOr } from "../util/repo-doc.ts";
import { selectAffectedTests, type TestSelectionDeps } from "../test-selection.ts";
import type { CheckExecutionResult } from "./checks.ts";
import type { CheckSpawnOutcome } from "./check-supervisor.ts";

// The `affected-tests` slot's half of the executor: pick the tests, fill the command template,
// run it, read its JUnit results, rerun only the failed files once, and decide.
//
// It runs INSIDE one executor call, so selection, the run and the rerun share one worktree
// lease and one test lease, and nothing awaits between the run budget's reservation and the
// first spawn except the selection the spawn needs. It never records the expanded argv: the
// outcome carries the template the operator configured, which `runCheck` already holds.

/** A JUnit file larger than this is not read. */
const MAX_JUNIT_BYTES = 32 * 1024 * 1024;

/** The template with `{files}` and `{junit}` filled in. */
export function expandAffectedTestsTemplate(
  template: readonly string[],
  files: readonly string[],
  junitPath: string,
): string[] {
  return template.flatMap((arg) =>
    arg === AFFECTED_TESTS_FILES_PLACEHOLDER
      ? [...files]
      : [arg.split(AFFECTED_TESTS_JUNIT_PLACEHOLDER).join(junitPath)]);
}

/** What the executor hands this module once it holds a tree. */
export interface AffectedTestsContext {
  template: readonly string[];
  /** The leased check worktree: the committed config and the code under review. */
  treeRoot: string;
  /** Where inside it the command runs, relative. */
  workingSubpath: string;
  /** The operator's own checkout, where the gitignored local override lives. */
  localRoot: string | null;
  selection?: TestSelectionDeps;
}

/** Either nothing to run (the check ends here), or the files to run. */
export type AffectedTestsPlan =
  | { kind: "done"; result: CheckExecutionResult }
  | { kind: "run"; files: WorkflowSelectedTest[]; report: WorkflowAffectedTestsReport };

function settingsOf(merged: MergedTestingConfig): WorkflowAffectedTestsReport["settings"] {
  return {
    patterns: merged.config.tests.patterns,
    includeImporters: merged.config.tests.includeImporters,
    smokeSet: merged.config.tests.smokeSet,
    localKeys: merged.localKeys,
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
  const problem = commandTemplateProblem("affected-tests", ctx.template);
  if (problem) return { kind: "done", result: decided("failed", problem) };

  const read = readTestingConfig(ctx.treeRoot, ctx.localRoot);
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

  const selection = await selectAffectedTests(ctx.treeRoot, read.merged.config, ctx.selection);
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
    settings: settingsOf(read.merged),
  };
  if (selection.files.length === 0) {
    return {
      kind: "done",
      result: decided("skipped", "No tests were selected for this change.", { affected: report }),
    };
  }
  return { kind: "run", files: selection.files, report };
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

/** Runs one expanded argv under the executor's supervisor, in the leased tree. */
export type AffectedTestsSpawn = (argv: string[]) => Promise<CheckSpawnOutcome>;

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

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Run the selected files, and the failed ones once more, and decide.
 *
 * Returns a spawn outcome so the executor settles the lease exactly as it does for any other
 * slot. A run whose group could not be proven empty is passed straight through and never
 * followed by a rerun, so every outcome built here follows a proven-empty last run.
 */
export async function runAffectedTests(
  ctx: AffectedTestsContext,
  plan: Extract<AffectedTestsPlan, { kind: "run" }>,
  spawn: AffectedTestsSpawn,
): Promise<CheckSpawnOutcome> {
  const dir = mkdtempSync(join(tmpdir(), "mission-junit-"));
  const cwd = join(ctx.treeRoot, ctx.workingSubpath);
  const roots = [realpathOr(ctx.treeRoot), ctx.treeRoot];
  const selectedPaths = new Set(plan.files.map((file) => file.path));
  const argFor = (path: string) => relative(cwd, join(ctx.treeRoot, path)) || ".";
  const ranLabel = `Ran ${plural(plan.files.length, "selected test file", "selected test files")}`;

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
    const outcome = await spawn(expandAffectedTestsTemplate(ctx.template, paths.map(argFor), junitPath));
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
    affected: WorkflowAffectedTestsReport = plan.report,
  ): CheckSpawnOutcome => ({
    // Fields named rather than spread: a run read carries its own `kind`.
    result: decided(status, note, {
      exitCode: run.exitCode,
      output: run.output,
      truncatedBytes: run.truncatedBytes,
      affected,
    }),
    emptiness: "empty",
    supervisor: null,
  });

  try {
    const first = await runOnce(plan.files.map((file) => file.path), join(dir, "junit-1.xml"));
    if (first.kind === "aborted") return first.outcome;
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
      : plan.files.map((file) => file.path);
    const banner = `\n\n[Mission Control] ${plural(first.failed.size, "test", "tests")} failed; `
      + `rerunning ${plural(rerunPaths.length, "file", "files")} once.\n\n`;
    const second = await runOnce(rerunPaths, join(dir, "junit-2.xml"));
    if (second.kind === "aborted") return second.outcome;
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
    const affected: WorkflowAffectedTestsReport = {
      ...plan.report,
      flakeCount: flakes.length,
      flakes: flakes.slice(0, AFFECTED_TESTS_LIMITS.flakes),
      failureCount: failures.length,
      failures: failures.slice(0, AFFECTED_TESTS_LIMITS.failures),
    };
    const flaked = flakes.length === 0
      ? ""
      : `; ${plural(flakes.length, "test", "tests")} flaked and passed on rerun`;
    return failures.length === 0
      ? finish("passed", `${ranLabel}${flaked}.`, both, affected)
      : finish("failed", `${ranLabel}; ${plural(failures.length, "test", "tests")} failed twice${flaked}.`, both, affected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
