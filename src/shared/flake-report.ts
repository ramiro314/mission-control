import { z } from "zod";

// The flake report, version 1: what CI found flaky in one run, and where its history lives.
//
// Browser-safe on purpose (no `node:` imports). The CI flake report action bundles this module
// to write the report, and the daemon reads it back out of the "Flaky tests" check's summary
// with `parseFlakeSummary`. Everything exported here is a cross-phase contract: a later change
// adds a version (`version: 2`, marker `v2`), it never changes what v1 means, because a check
// summary written today is read by a daemon released later.

/** The check run every CI run publishes on the commit it tested (the PR head, for a PR). */
export const FLAKY_TESTS_CHECK_NAME = "Flaky tests";

/** Opens the hidden machine-readable copy of the report at the end of the summary. */
export const FLAKE_REPORT_MARKER_PREFIX = "<!-- mission-flake-report:v1 ";
const FLAKE_REPORT_MARKER_SUFFIX = " -->";
const FLAKE_REPORT_MARKER = /<!-- mission-flake-report:v1 (\{.*?\}) -->/gs;

/** GitHub refuses a check run summary longer than 65,535 characters; stay well clear. */
export const FLAKE_SUMMARY_LIMIT = 60_000;
/** An error message is cut to this many characters when a report is built. */
export const FLAKE_MESSAGE_LIMIT = 400;

const TestEntrySchema = z.object({
  /** `flakeKey(runner, file, name)`: the test's identity across runs. */
  key: z.string().min(1),
  /** The runner that reported it, e.g. `junit` or `playwright`. */
  runner: z.string().min(1),
  /** Repository-relative test file. */
  file: z.string(),
  /** The test's name, with its enclosing suites joined by ` > `. */
  name: z.string(),
  /** The first failure's message, cut to `FLAKE_MESSAGE_LIMIT`. */
  message: z.string(),
  /** The CI job that saw it, e.g. `unit (node 24, shard 3/6)`. */
  job: z.string().optional(),
});
export type FlakeReportTest = z.infer<typeof TestEntrySchema>;

const IssueEntrySchema = z.object({
  key: z.string().min(1),
  number: z.number().int(),
  url: z.string(),
  /** Occurrences counted for the actionable threshold: within the window, since the last reopen. */
  occurrences: z.number().int().min(0),
  actionable: z.boolean(),
});
export type FlakeReportIssue = z.infer<typeof IssueEntrySchema>;

export const FlakeReportSchema = z.object({
  version: z.literal(1),
  /** The commit the tests ran against: the PR head for a pull request, else the pushed commit. */
  commit: z.string(),
  /** The branch the run belongs to (the PR's head branch for a pull request). */
  ref: z.string(),
  pullRequest: z.number().int().nullable().optional(),
  runUrl: z.string(),
  /** Tests that failed and then passed on one rerun. */
  flakes: z.array(TestEntrySchema),
  /** Tests that failed on the run and on the rerun. */
  failures: z.array(TestEntrySchema),
  /** Why a job's results could not be classified (it failed for a reason no test explains). */
  errors: z.array(z.string()),
  /** The history issue for each flake, when this run could write issues. */
  issues: z.array(IssueEntrySchema),
  /** Entries left out of this copy so it fits a check summary; counted, never listed. */
  omitted: z.object({ flakes: z.number().int(), failures: z.number().int() }).optional(),
});
export type FlakeReport = z.infer<typeof FlakeReportSchema>;

/**
 * A short, stable identity for one test across runs: 16 hex characters of FNV-1a 64 over the
 * runner, the repository-relative file and the test name. Used in issue markers, so it must
 * never change for v1.
 */
export function flakeKey(runner: string, file: string, name: string): string {
  const input = `${runner}\u0000${file}\u0000${name}`;
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** A failure message, trimmed to its first lines and `FLAKE_MESSAGE_LIMIT` characters. */
export function flakeMessageSnippet(message: string | null | undefined): string {
  const text = (message ?? "").trim();
  if (text.length <= FLAKE_MESSAGE_LIMIT) return text;
  return `${text.slice(0, FLAKE_MESSAGE_LIMIT - 3)}...`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Inline code that survives backticks inside the text. */
function code(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/** A one-line quote of a message, safe inside a list item. */
function quote(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat ? `\n  ${code(flat)}` : "";
}

/** The check title: what a person reads in the PR's check list. */
export function flakeSummaryTitle(report: FlakeReport): string {
  const flakes = report.flakes.length + (report.omitted?.flakes ?? 0);
  return flakes === 0 ? "No flaky tests" : plural(flakes, "flaky test");
}

function renderBody(report: FlakeReport): string {
  const issues = new Map(report.issues.map((issue) => [issue.key, issue]));
  const flakeCount = report.flakes.length + (report.omitted?.flakes ?? 0);
  const failureCount = report.failures.length + (report.omitted?.failures ?? 0);
  const lines: string[] = [];
  if (flakeCount === 0) {
    lines.push("No test failed and then passed on its rerun in this run.");
  } else {
    lines.push(
      `**${plural(flakeCount, "flaky test")}** in this run. Each failed, then passed when rerun, so it did not fail CI.`,
      "",
    );
    for (const flake of report.flakes) {
      const issue = issues.get(flake.key);
      const where = [code(flake.file), flake.job ? `in ${flake.job}` : null].filter(Boolean).join(" ");
      const history = issue
        ? ` · [#${issue.number}](${issue.url}), ${plural(issue.occurrences, "occurrence")} in the window${issue.actionable ? ", actionable" : ""}`
        : "";
      lines.push(`- **${code(flake.name)}** ${where}${history}${quote(flake.message)}`);
    }
    if (report.omitted?.flakes) lines.push(`- ...and ${plural(report.omitted.flakes, "more flaky test")} not listed here.`);
  }
  if (failureCount > 0) {
    lines.push(
      "",
      `**${plural(failureCount, "test")} failed twice.** These are real failures and fail their jobs.`,
      "",
    );
    for (const failure of report.failures) {
      const where = [code(failure.file), failure.job ? `in ${failure.job}` : null].filter(Boolean).join(" ");
      lines.push(`- ${code(failure.name)} ${where}`);
    }
    if (report.omitted?.failures) lines.push(`- ...and ${plural(report.omitted.failures, "more failure")} not listed here.`);
  }
  if (report.errors.length > 0) {
    lines.push("", "**Not classified:**", "");
    for (const error of report.errors) lines.push(`- ${error.replace(/\s+/g, " ")}`);
  }
  return lines.join("\n");
}

/** The report as JSON that cannot close the HTML comment it sits in. */
function markerFor(report: FlakeReport): string {
  const json = JSON.stringify(report).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `${FLAKE_REPORT_MARKER_PREFIX}${json}${FLAKE_REPORT_MARKER_SUFFIX}`;
}

function renderWhole(report: FlakeReport): string {
  return `${renderBody(report)}\n\n${markerFor(report)}\n`;
}

/**
 * The Markdown used for the "Flaky tests" check output and the job summary. It ends with a
 * hidden `<!-- mission-flake-report:v1 {json} -->` marker holding the report, so a reader gets
 * the same facts a person does. When the whole report would not fit a check summary, failures
 * and then flakes are dropped from the listing (and from the marker) and counted in `omitted`.
 */
export function renderFlakeSummary(report: FlakeReport): string {
  let flakes = report.flakes.length;
  let failures = report.failures.length;
  const capped = (): FlakeReport => {
    const omittedFlakes = report.flakes.length - flakes + (report.omitted?.flakes ?? 0);
    const omittedFailures = report.failures.length - failures + (report.omitted?.failures ?? 0);
    const keptFlakes = report.flakes.slice(0, flakes);
    const keptKeys = new Set(keptFlakes.map((flake) => flake.key));
    return {
      ...report,
      flakes: keptFlakes,
      failures: report.failures.slice(0, failures),
      errors: report.errors.slice(0, 20),
      issues: report.issues.filter((issue) => keptKeys.has(issue.key)),
      ...(omittedFlakes > 0 || omittedFailures > 0
        ? { omitted: { flakes: omittedFlakes, failures: omittedFailures } }
        : {}),
    };
  };
  let text = renderWhole(capped());
  while (text.length > FLAKE_SUMMARY_LIMIT && (flakes > 0 || failures > 0)) {
    if (failures > 0) failures = Math.floor(failures / 2);
    else flakes = Math.floor(flakes / 2);
    text = renderWhole(capped());
  }
  return text;
}

/** Read the report back out of a summary `renderFlakeSummary` wrote, or null when there is none. */
export function parseFlakeSummary(markdown: string): FlakeReport | null {
  // The last marker: the body above it quotes test messages, which a test could fill with
  // something shaped like a marker, but nothing follows the real one.
  const match = [...markdown.matchAll(FLAKE_REPORT_MARKER)].at(-1);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]!);
  } catch {
    return null;
  }
  const parsed = FlakeReportSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// Flake history issues. One GitHub issue per flaky test, found again by the key in its body
// marker; each occurrence (the first in the body, later ones as comments) carries its own
// marker with the time it happened. Both markers are v1 contracts the `deflake` skill reads.

/** The body marker that ties an issue to one test's `flakeKey`. */
export function flakeIssueMarker(key: string): string {
  return `<!-- mission-flake:v1 key=${key} -->`;
}

/** The key an issue body's marker names, or null. */
export function parseFlakeIssueKey(body: string | null | undefined): string | null {
  const match = /<!-- mission-flake:v1 key=([0-9a-f]+) -->/.exec(body ?? "");
  return match ? match[1]! : null;
}

/** Opens one occurrence, in the issue body or in a comment. */
export function flakeOccurrenceMarker(at: Date): string {
  return `<!-- mission-flake-occurrence:v1 at=${at.toISOString()} -->`;
}

/** Every occurrence time recorded in a body or comment, in order. Unparseable times are skipped. */
export function parseFlakeOccurrences(text: string | null | undefined): Date[] {
  const times: Date[] = [];
  for (const match of (text ?? "").matchAll(/<!-- mission-flake-occurrence:v1 at=(\S+) -->/g)) {
    const at = new Date(match[1]!);
    if (!Number.isNaN(at.getTime())) times.push(at);
  }
  return times;
}

/** Opens the issue body's occurrence count line, which each occurrence rewrites. */
export const FLAKE_COUNT_MARKER = "<!-- mission-flake-count:v1 -->";
