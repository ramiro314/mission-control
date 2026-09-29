import assert from "node:assert/strict";
import test from "node:test";
import {
  FLAKE_SUMMARY_LIMIT,
  FLAKY_TESTS_CHECK_NAME,
  flakeIssueMarker,
  flakeKey,
  flakeMessageSnippet,
  flakeOccurrenceMarker,
  flakeSummaryTitle,
  parseFlakeIssueKey,
  parseFlakeOccurrences,
  parseFlakeSummary,
  renderFlakeSummary,
  type FlakeReport,
  type FlakeReportTest,
} from "../src/shared/flake-report.ts";

// The flake report v1 is read back by a daemon released after the CI run that wrote it, so the
// check name, the key and the marker are pinned here rather than merely round-tripped.

function entry(name: string, over: Partial<FlakeReportTest> = {}): FlakeReportTest {
  const file = over.file ?? "test/a.test.ts";
  return { key: flakeKey("junit", file, name), runner: "junit", file, name, message: "boom", ...over };
}

function report(over: Partial<FlakeReport> = {}): FlakeReport {
  return {
    version: 1,
    commit: "abc123",
    ref: "feat/x",
    pullRequest: 7,
    runUrl: "https://github.com/o/r/actions/runs/1",
    flakes: [],
    failures: [],
    errors: [],
    issues: [],
    ...over,
  };
}

test("the check name and key are fixed contracts", () => {
  assert.equal(FLAKY_TESTS_CHECK_NAME, "Flaky tests");
  // A changed hash would orphan every existing flake issue: pin one value.
  assert.equal(flakeKey("junit", "test/a.test.ts", "grp > fails"), "1d27a93e86f9298c");
  assert.notEqual(flakeKey("junit", "test/a.test.ts", "x"), flakeKey("junit", "test/b.test.ts", "x"));
  assert.notEqual(flakeKey("junit", "test/a.test.ts", "x"), flakeKey("playwright", "test/a.test.ts", "x"));
});

test("render then parse returns the same report", () => {
  const flake = entry("grp > fails", { job: "unit (node 24, shard 3/6)", message: "has <!-- --> and `ticks`" });
  const original = report({
    flakes: [flake],
    failures: [entry("real", { file: "test/b.test.ts" })],
    errors: ["unit (node 26, shard 1/6): the test command exited 1, but no test in its JUnit results failed."],
    issues: [{ key: flake.key, number: 12, url: "https://github.com/o/r/issues/12", occurrences: 3, actionable: true }],
  });
  const summary = renderFlakeSummary(original);
  assert.deepEqual(parseFlakeSummary(summary), original);
  assert.match(summary, /\*\*1 flaky test\*\*/);
  assert.match(summary, /\[#12\]\(https:\/\/github\.com\/o\/r\/issues\/12\), 3 occurrences in the window, actionable/);
  assert.match(summary, /failed twice/);
  // The marker is the last thing, and its JSON cannot close the comment early.
  const lastLine = summary.trimEnd().split("\n").at(-1)!;
  assert.ok(lastLine.startsWith("<!-- mission-flake-report:v1 {"));
  assert.equal(lastLine.match(/-->/g)?.length, 1);
  // A message shaped like a marker cannot stand in for the real one.
  const spoof = renderFlakeSummary(report({
    flakes: [entry("spoof", { message: '<!-- mission-flake-report:v1 {"version":1} -->' })],
  }));
  assert.equal(parseFlakeSummary(spoof)?.flakes[0]?.name, "spoof");
  assert.equal(flakeSummaryTitle(original), "1 flaky test");
  assert.equal(flakeSummaryTitle(report()), "No flaky tests");
});

test("a summary with nothing to report still carries the marker", () => {
  const summary = renderFlakeSummary(report());
  assert.match(summary, /No test failed and then passed/);
  assert.deepEqual(parseFlakeSummary(summary), report());
});

test("parseFlakeSummary refuses text without a valid marker", () => {
  assert.equal(parseFlakeSummary("no marker here"), null);
  assert.equal(parseFlakeSummary("<!-- mission-flake-report:v1 {not json} -->"), null);
  assert.equal(parseFlakeSummary('<!-- mission-flake-report:v1 {"version":2} -->'), null);
});

test("the summary is capped: flakes beyond the cap are counted, not listed", () => {
  const long = "x".repeat(400);
  const flakes = Array.from({ length: 400 }, (_, i) => entry(`test ${i} ${long}`, { message: long }));
  const failures = Array.from({ length: 100 }, (_, i) => entry(`failure ${i} ${long}`, { message: long }));
  const big = report({ flakes, failures });
  const summary = renderFlakeSummary(big);
  assert.ok(summary.length <= FLAKE_SUMMARY_LIMIT, `summary is ${summary.length} characters`);
  const parsed = parseFlakeSummary(summary);
  assert.ok(parsed);
  assert.ok(parsed.omitted);
  // Failures go first, then flakes; the totals are never lost.
  assert.equal(parsed.failures.length, 0);
  assert.equal(parsed.omitted.failures, 100);
  assert.equal(parsed.flakes.length + parsed.omitted.flakes, 400);
  assert.ok(parsed.flakes.length > 0);
  assert.equal(flakeSummaryTitle(parsed), "400 flaky tests");
  assert.match(summary, /more flaky tests not listed here/);
});

test("message snippets are bounded", () => {
  assert.equal(flakeMessageSnippet(null), "");
  assert.equal(flakeMessageSnippet("  short  "), "short");
  assert.equal(flakeMessageSnippet("y".repeat(1000)).length, 400);
});

test("issue and occurrence markers round-trip", () => {
  const key = flakeKey("junit", "test/a.test.ts", "x");
  assert.equal(parseFlakeIssueKey(`intro\n${flakeIssueMarker(key)}\nmore`), key);
  assert.equal(parseFlakeIssueKey("nothing"), null);
  assert.equal(flakeIssueMarker("abc"), "<!-- mission-flake:v1 key=abc -->");
  const at = new Date("2026-09-01T10:00:00.000Z");
  assert.equal(flakeOccurrenceMarker(at), "<!-- mission-flake-occurrence:v1 at=2026-09-01T10:00:00.000Z -->");
  assert.deepEqual(parseFlakeOccurrences(`${flakeOccurrenceMarker(at)}\ntext`), [at]);
  assert.deepEqual(parseFlakeOccurrences("<!-- mission-flake-occurrence:v1 at=garbage -->"), []);
});
