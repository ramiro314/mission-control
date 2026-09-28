import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { expandTestCommandTemplate } from "@shared/command-template.ts";
import {
  flakeKey,
  flakeMessageSnippet,
  type FlakeReport,
  type FlakeReportTest,
} from "@shared/flake-report.ts";
import { junitCaseKey, parseJUnit, type JUnitCase } from "@shared/junit.ts";
import type { RunContext } from "./context.ts";

// `mode: rerun`, one step in each test job: decide which of the job's failures were flakes.
//
// For a JUnit runner the action reruns only the failed files once, from the rerun command
// template. For Playwright, whose own retry already reran each failed test, it reads the JSON
// report's `flaky` outcome instead. Either way a test that failed and then passed is a flake,
// a test that failed both times is a real failure, and a job that failed for a reason no test
// explains is an error - the last two fail the step.

/** A JUnit file larger than this is not read. */
const MAX_RESULTS_BYTES = 64 * 1024 * 1024;

/** Spawns argv in cwd with inherited stdio and resolves to its exit code. */
export type SpawnCommand = (argv: readonly string[], cwd: string) => Promise<number>;

export interface Classified {
  flakes: FlakeReportTest[];
  failures: FlakeReportTest[];
  errors: string[];
}

export function emptyReport(ctx: RunContext): FlakeReport {
  return {
    version: 1,
    commit: ctx.commit,
    ref: ctx.ref,
    pullRequest: ctx.pullRequest,
    runUrl: ctx.runUrl,
    flakes: [],
    failures: [],
    errors: [],
    issues: [],
  };
}

function realpathOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * A runner's file path as a repository-relative, forward-slash path. Both sides are resolved
 * through symlinks first, so a key never depends on which spelling of the checkout a runner
 * reported (`/var` against `/private/var` on macOS).
 */
export function repoRelative(file: string, cwd: string): string {
  const rel = isAbsolute(file) ? relative(realpathOr(cwd), realpathOr(file)) : file;
  return rel.split(sep).join("/");
}

/** Node reports a top-level test's classname as `test`; anything else is its enclosing suite. */
function junitName(testCase: JUnitCase): string {
  return testCase.classname && testCase.classname !== "test"
    ? `${testCase.classname} > ${testCase.name}`
    : testCase.name;
}

function junitEntry(testCase: JUnitCase, runner: string, cwd: string, job: string | undefined): FlakeReportTest {
  const file = testCase.file ? repoRelative(testCase.file, cwd) : "";
  const name = junitName(testCase);
  return {
    key: flakeKey(runner, file, name),
    runner,
    file,
    name,
    message: flakeMessageSnippet(testCase.message ?? testCase.detail),
    ...(job ? { job } : {}),
  };
}

type ReadResult = { ok: true; cases: JUnitCase[] } | { ok: false; error: string };

export function readJUnitFile(path: string): ReadResult {
  if (!existsSync(path)) return { ok: false, error: `no JUnit results at ${path}` };
  let xml: string;
  try {
    xml = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, error: `the JUnit results at ${path} could not be read: ${String(err)}` };
  }
  if (xml.length > MAX_RESULTS_BYTES) return { ok: false, error: `the JUnit results at ${path} are too large to read` };
  const parsed = parseJUnit(xml);
  return parsed.ok ? { ok: true, cases: parsed.results.cases } : { ok: false, error: parsed.error };
}

/**
 * Compare a run with its rerun. A test that failed on one and passed on the other is a flake
 * (in either order: a test that passed the full run and failed the rerun is just as
 * nondeterministic). A test that failed both times, or that the rerun did not report, is a
 * real failure.
 */
export function classifyJUnit(
  first: readonly JUnitCase[],
  rerun: readonly JUnitCase[],
  opts: { runner: string; cwd: string; job?: string },
): { flakes: FlakeReportTest[]; failures: FlakeReportTest[] } {
  const keyOf = (testCase: JUnitCase) =>
    junitCaseKey({ ...testCase, file: testCase.file ? repoRelative(testCase.file, opts.cwd) : null });
  const rerunByKey = new Map(rerun.map((testCase) => [keyOf(testCase), testCase]));
  const firstByKey = new Map(first.map((testCase) => [keyOf(testCase), testCase]));
  const flakes: FlakeReportTest[] = [];
  const failures: FlakeReportTest[] = [];
  for (const testCase of first) {
    if (testCase.status !== "failed") continue;
    const again = rerunByKey.get(keyOf(testCase));
    const entry = junitEntry(testCase, opts.runner, opts.cwd, opts.job);
    (again?.status === "passed" ? flakes : failures).push(entry);
  }
  for (const testCase of rerun) {
    if (testCase.status !== "failed") continue;
    const before = firstByKey.get(keyOf(testCase));
    if (before?.status === "failed") continue;
    const entry = junitEntry(testCase, opts.runner, opts.cwd, opts.job);
    (before?.status === "passed" ? flakes : failures).push(entry);
  }
  return { flakes, failures };
}

export interface JUnitRerunOptions {
  junitPath: string;
  /** The first run's exit code, or null when the step did not record one. */
  exitCode: number | null;
  /** The rerun command template, split into argv, or null for none. */
  template: readonly string[] | null;
  /** Where the rerun writes its JUnit results. */
  rerunJUnitPath: string;
  runner: string;
  job?: string;
  cwd: string;
  spawn: SpawnCommand;
}

/** Read the first run, rerun its failed files once, and classify. */
export async function rerunJUnit(opts: JUnitRerunOptions): Promise<Classified> {
  const label = opts.job ? `${opts.job}: ` : "";
  const first = readJUnitFile(opts.junitPath);
  if (!first.ok) {
    if (opts.exitCode === 0) return { flakes: [], failures: [], errors: [] };
    return {
      flakes: [],
      failures: [],
      errors: [`${label}the test command exited ${opts.exitCode ?? "without a recorded code"} and ${first.error}.`],
    };
  }
  const failed = first.cases.filter((testCase) => testCase.status === "failed");
  if (failed.length === 0) {
    if (opts.exitCode === 0 || opts.exitCode === null) return { flakes: [], failures: [], errors: [] };
    return {
      flakes: [],
      failures: [],
      errors: [`${label}the test command exited ${opts.exitCode}, but no test in its JUnit results failed.`],
    };
  }
  const files = [...new Set(failed.flatMap((testCase) => testCase.file ? [repoRelative(testCase.file, opts.cwd)] : []))];
  if (opts.template === null || files.length === 0) {
    const why = opts.template === null ? "no rerun command was given" : "the failed tests name no file to rerun";
    return {
      flakes: [],
      failures: failed.map((testCase) => junitEntry(testCase, opts.runner, opts.cwd, opts.job)),
      errors: [`${label}nothing was rerun: ${why}.`],
    };
  }
  console.log(`Rerunning ${files.length} failed test file(s) once: ${files.join(" ")}`);
  const rerunExit = await opts.spawn(expandTestCommandTemplate(opts.template, files, opts.rerunJUnitPath), opts.cwd);
  const rerun = readJUnitFile(opts.rerunJUnitPath);
  if (!rerun.ok) {
    return {
      flakes: [],
      failures: failed.map((testCase) => junitEntry(testCase, opts.runner, opts.cwd, opts.job)),
      errors: [`${label}the rerun exited ${rerunExit} and ${rerun.error}.`],
    };
  }
  const classified = classifyJUnit(first.cases, rerun.cases, opts);
  const rerunFailed = rerun.cases.some((testCase) => testCase.status === "failed");
  const errors = rerunExit !== 0 && !rerunFailed
    ? [`${label}the rerun exited ${rerunExit}, but no test in its JUnit results failed.`]
    : [];
  return { ...classified, errors };
}

// Playwright's JSON reporter: the subset this reads.
interface PlaywrightResult {
  error?: { message?: string };
}
interface PlaywrightTest {
  status?: string;
  results?: PlaywrightResult[];
}
interface PlaywrightSpec {
  title?: string;
  file?: string;
  tests?: PlaywrightTest[];
}
interface PlaywrightSuite {
  title?: string;
  file?: string;
  specs?: PlaywrightSpec[];
  suites?: PlaywrightSuite[];
}
interface PlaywrightReport {
  config?: { rootDir?: string };
  suites?: PlaywrightSuite[];
  errors?: { message?: string }[];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Classify Playwright's own retries: `flaky` is a flake, `unexpected` a real failure. */
export function classifyPlaywright(
  report: PlaywrightReport,
  opts: { cwd: string; job?: string },
): Classified {
  const runner = "playwright";
  const flakes: FlakeReportTest[] = [];
  const failures: FlakeReportTest[] = [];
  const rootDir = report.config?.rootDir ?? opts.cwd;
  const visit = (suite: PlaywrightSuite, titles: string[], topLevel: boolean) => {
    // The top-level suite is the file itself; its title is the file name, not a describe.
    const path = topLevel || !suite.title ? titles : [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      const fileOf = spec.file ?? suite.file ?? "";
      const file = fileOf ? repoRelative(join(rootDir, fileOf), opts.cwd) : "";
      const name = [...path, spec.title ?? "(unnamed test)"].join(" > ");
      for (const test of spec.tests ?? []) {
        if (test.status !== "flaky" && test.status !== "unexpected") continue;
        const firstError = test.results?.find((result) => result.error?.message)?.error?.message ?? "";
        const entry: FlakeReportTest = {
          key: flakeKey(runner, file, name),
          runner,
          file,
          name,
          message: flakeMessageSnippet(firstError.replace(ANSI, "")),
          ...(opts.job ? { job: opts.job } : {}),
        };
        (test.status === "flaky" ? flakes : failures).push(entry);
      }
    }
    for (const child of suite.suites ?? []) visit(child, path, false);
  };
  for (const suite of report.suites ?? []) visit(suite, [], true);
  const label = opts.job ? `${opts.job}: ` : "";
  const errors = (report.errors ?? []).map((error) =>
    `${label}Playwright reported an error outside any test: ${flakeMessageSnippet((error.message ?? "").replace(ANSI, ""))}`);
  return { flakes, failures, errors };
}

/** Read Playwright's JSON report and classify it. */
export function readPlaywright(path: string, opts: { cwd: string; job?: string }): Classified {
  const label = opts.job ? `${opts.job}: ` : "";
  let report: PlaywrightReport;
  try {
    report = JSON.parse(readFileSync(path, "utf8")) as PlaywrightReport;
  } catch (err) {
    return { flakes: [], failures: [], errors: [`${label}Playwright's JSON report at ${path} could not be read: ${String(err)}`] };
  }
  return classifyPlaywright(report, opts);
}
