import assert from "node:assert/strict";
import test from "node:test";

import { rollUpChecks } from "../src/server/github/check-rollup.ts";
import { checkEntryRecognized, classifyCheckEntry, type CiCheckEntryState } from "../src/shared/ci-checks.ts";
import { ciCheckRunsFromRollup } from "../src/shared/wait-for-ci.ts";

// Fork (ci-strictness, Wait for CI): the PR chip and the Inspector's merge gate read a commit's
// checks through upstream's `rollUpChecks` (#1524), and Wait for CI through
// `ciCheckRunsFromRollup`. Both must give one check the verdict `classifyCheckEntry` gives it,
// for every result GitHub can report, so a conclusion added to one rule and not the other fails
// here rather than letting the chip go green while Wait for CI still blocks.

const CHECK_RUN_STATUSES = ["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "in_progress"];
const CONCLUSIONS: (string | null | undefined)[] = [
  "SUCCESS", "NEUTRAL", "SKIPPED",
  "FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE",
  "failure", "success", "", null, undefined, "SOMETHING_GITHUB_ADDS_LATER",
];
const STATUS_STATES = ["SUCCESS", "PENDING", "EXPECTED", "FAILURE", "ERROR", "error", "pending", "SOMETHING_ELSE", ""];

const checkRun = (status: string, conclusion?: string | null) => ({
  __typename: "CheckRun",
  name: "unit",
  status,
  ...(conclusion === undefined ? {} : { conclusion }),
  startedAt: "2026-11-21T00:00:00Z",
  completedAt: status.toUpperCase() === "COMPLETED" ? "2026-11-21T00:05:00Z" : null,
});
const statusContext = (state: string) => ({ __typename: "StatusContext", context: "ci/legacy", state, createdAt: "2026-11-21T00:00:00Z" });

const entries = [
  ...CHECK_RUN_STATUSES.map((status) => checkRun(status)),
  ...CONCLUSIONS.map((conclusion) => checkRun("COMPLETED", conclusion)),
  ...STATUS_STATES.map(statusContext),
];

const verdict: Record<CiCheckEntryState, string> = { failing: "failing", pending: "pending", passing: "passing" };

test("the chip's rollup and Wait for CI give every check the shared rule's verdict", () => {
  for (const entry of entries) {
    const shared = classifyCheckEntry(entry);
    assert.ok(shared, JSON.stringify(entry));
    const rollup = rollUpChecks([entry]);
    assert.equal(rollup.checks, verdict[shared], `rollUpChecks: ${JSON.stringify(entry)}`);
    assert.equal(rollup.recognized, checkEntryRecognized(entry), `recognized: ${JSON.stringify(entry)}`);
    const runs = ciCheckRunsFromRollup([entry], () => null).checkRuns;
    assert.equal(runs.length, 1, JSON.stringify(entry));
    assert.equal(runs[0]!.state, shared, `Wait for CI: ${JSON.stringify(entry)}`);
  }
});

test("every failing result fails all three readers, and none of them reads it as a pass", () => {
  const failing = entries.filter((entry) => classifyCheckEntry(entry) === "failing");
  assert.deepEqual(
    failing.map((entry) => ("conclusion" in entry ? entry.conclusion : (entry as { state: string }).state)),
    ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE", "failure", "FAILURE", "ERROR", "error"],
  );
  for (const entry of failing) {
    assert.equal(rollUpChecks([checkRun("COMPLETED", "SUCCESS"), entry]).checks, "failing", JSON.stringify(entry));
    assert.equal(ciCheckRunsFromRollup([entry], () => null).checkRuns[0]!.state, "failing");
  }
});

test("an unrecognised result keeps the rollup's not-recognised flag and never confirms a pass", () => {
  for (const entry of [checkRun("COMPLETED", "SOMETHING_GITHUB_ADDS_LATER"), checkRun("COMPLETED", ""), checkRun("COMPLETED"), statusContext("SOMETHING_ELSE")]) {
    assert.equal(checkEntryRecognized(entry), false, JSON.stringify(entry));
    const alone = rollUpChecks([entry]);
    // Upstream's rule: an unknown value never raises a false alarm, so it reads as passing, but
    // the rollup says it could not recognise the commit's checks rather than reporting a clean pass.
    assert.equal(alone.checks, "passing");
    assert.equal(alone.recognized, false, JSON.stringify(entry));
    // Beside a recognised pass the commit is still not recognised in full.
    assert.equal(rollUpChecks([checkRun("COMPLETED", "SUCCESS"), entry]).recognized, false);
    // It never outranks a check still running or one that failed.
    assert.equal(rollUpChecks([checkRun("IN_PROGRESS"), entry]).checks, "pending");
    assert.equal(rollUpChecks([checkRun("COMPLETED", "FAILURE"), entry]).checks, "failing");
  }
  assert.equal(rollUpChecks([checkRun("COMPLETED", "SUCCESS"), statusContext("SUCCESS")]).recognized, true);
});
