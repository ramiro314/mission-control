import { z } from "zod";
import { FLAKY_TESTS_CHECK_NAME, FlakeReportSchema, type FlakeReport } from "./flake-report.ts";

// The Wait for CI node: what it reads, what it records, and how it decides.
//
// Browser-safe (no `node:` imports). The daemon decides with `decideWaitForCi`, and the run
// views read the same `WaitForCiState` the attempt carries in `output_json`, so the two cannot
// describe one wait differently.
//
// The node never talks to GitHub. The GitHub Inspector's one PR query reads the head commit's
// check runs beside the head sha, and the node is re-observed when that snapshot changes and
// on the workflow manager's fifteen-second timer. See docs/workflows.md#wait-for-ci.

/** The timeout a new node gets, and the range an author may choose, in minutes. */
export const WAIT_FOR_CI_TIMEOUT_MINUTES = { default: 45, min: 5, max: 240 } as const;

/**
 * How long CI may sit green without a "Flaky tests" check before the node blocks.
 *
 * The report job runs after every test job, so there is a moment when every check that exists
 * has passed and the report's check does not exist yet. Blocking on the first such sighting
 * would block a healthy run; five minutes is several Inspector polls.
 */
export const WAIT_FOR_CI_FLAKE_REPORT_GRACE_MS = 5 * 60_000;

/** A check run summary is cut to this many characters when it is stored. */
export const CI_CHECK_SUMMARY_CHARS = 1_500;
/** A check run title is cut to this many characters when it is stored. */
export const CI_CHECK_TITLE_CHARS = 300;
/** At most this many check runs are stored for one head. GitHub's query reads 100. */
export const CI_CHECK_RUNS_MAX = 100;

export const CI_CHECK_RUN_STATES = ["pending", "passing", "failing"] as const;
export type CiCheckRunState = (typeof CI_CHECK_RUN_STATES)[number];

/** One check on the pull request's head commit: a GitHub check run or a legacy status. */
export const CiCheckRunSchema = z.object({
  name: z.string().max(500),
  state: z.enum(CI_CHECK_RUN_STATES),
  /** GitHub's conclusion (`FAILURE`, `TIMED_OUT`, ...) or status state; null while pending. */
  conclusion: z.string().max(100).nullable(),
  detailsUrl: z.string().max(2_000).nullable(),
  title: z.string().max(CI_CHECK_TITLE_CHARS).nullable(),
  summary: z.string().max(CI_CHECK_SUMMARY_CHARS).nullable(),
});
export type CiCheckRun = z.infer<typeof CiCheckRunSchema>;

/**
 * What the Inspector last read about CI on one pull request, keyed to the commit it read.
 *
 * `flakeReport` is parsed from the "Flaky tests" check's FULL summary before that summary is
 * cut to `CI_CHECK_SUMMARY_CHARS`, because the report's machine-readable marker is at the end.
 */
export const CiObservationSchema = z.object({
  headSha: z.string().max(100),
  observedAt: z.number(),
  checkRuns: z.array(CiCheckRunSchema).max(CI_CHECK_RUNS_MAX),
  flakeReport: FlakeReportSchema.nullable(),
});
export type CiObservation = z.infer<typeof CiObservationSchema>;

// CheckRun conclusions and StatusContext states that count as a failed check. SUCCESS,
// NEUTRAL and SKIPPED pass, and so does anything unrecognised, matching `src/server/pr.ts`.
const FAIL_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);
const FAIL_STATES = new Set(["FAILURE", "ERROR"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

/**
 * The head commit's `statusCheckRollup.contexts` nodes as stored check runs, plus the flake
 * report parsed from the "Flaky tests" check. Unknown node shapes are skipped.
 */
export function ciCheckRunsFromRollup(
  contexts: readonly unknown[],
  parseReport: (summary: string) => FlakeReport | null,
): { checkRuns: CiCheckRun[]; flakeReport: FlakeReport | null } {
  const checkRuns: CiCheckRun[] = [];
  let flakeReport: FlakeReport | null = null;
  for (const raw of contexts) {
    if (!raw || typeof raw !== "object" || checkRuns.length >= CI_CHECK_RUNS_MAX) continue;
    const node = raw as Record<string, unknown>;
    if (typeof node.status === "string" && typeof node.name === "string") {
      const status = node.status.toUpperCase();
      const conclusion = typeof node.conclusion === "string" ? node.conclusion.toUpperCase() : null;
      const state: CiCheckRunState = status !== "COMPLETED"
        ? "pending"
        : FAIL_CONCLUSIONS.has(conclusion ?? "") ? "failing" : "passing";
      if (node.name === FLAKY_TESTS_CHECK_NAME && typeof node.summary === "string") {
        flakeReport = parseReport(node.summary) ?? flakeReport;
      }
      checkRuns.push({
        name: node.name.slice(0, 500),
        state,
        conclusion: state === "pending" ? null : conclusion,
        detailsUrl: text(node.detailsUrl, 2_000),
        title: text(node.title, CI_CHECK_TITLE_CHARS),
        summary: text(node.summary, CI_CHECK_SUMMARY_CHARS),
      });
      continue;
    }
    if (typeof node.context === "string" && typeof node.state === "string") {
      const upper = node.state.toUpperCase();
      const state: CiCheckRunState = FAIL_STATES.has(upper)
        ? "failing"
        : PENDING_STATES.has(upper) ? "pending" : "passing";
      checkRuns.push({
        name: node.context.slice(0, 500),
        state,
        conclusion: state === "pending" ? null : upper,
        detailsUrl: text(node.targetUrl, 2_000),
        title: null,
        summary: text(node.description, CI_CHECK_SUMMARY_CHARS),
      });
    }
  }
  return { checkRuns, flakeReport };
}

/**
 * Why a Wait for CI node blocked its run. APPEND-ONLY: each is also a run phase
 * (`WORKFLOW_RUN_PHASES`) and a `Record` key in the run views.
 */
export const WAIT_FOR_CI_BLOCK_CODES = [
  /** Every check passed and no "Flaky tests" check appeared. */
  "ci_flake_report_missing",
  /** No check appeared on the head commit before the timeout. */
  "ci_missing",
  /** Checks were still running at the timeout. */
  "ci_timeout",
  /** The node has no pull request to watch: the action before it recorded none. */
  "ci_pull_request_unknown",
] as const;
export type WaitForCiBlockCode = (typeof WAIT_FOR_CI_BLOCK_CODES)[number];

/** The state a Wait for CI attempt carries in `output_json`, waiting and after. */
export const WaitForCiStateSchema = z.object({
  kind: z.literal("wait_for_ci"),
  pullRequestKey: z.string().nullable(),
  pullRequestUrl: z.string().nullable(),
  pullRequestNumber: z.number().int().nullable(),
  /**
   * The full head commit the node watches, and judges no other: the commit the Pull Request
   * action's continuation captured, which is what the session pushed. Null until the manager
   * has resolved it.
   */
  expectedHeadOid: z.string().nullable(),
  /**
   * The head GitHub last reported for the pull request when the action completed. Only a
   * fallback for a captured head that cannot be resolved: it can be a poll behind a push.
   */
  reportedHeadOid: z.string().nullable().optional(),
  waitingSince: z.number(),
  timeoutMinutes: z.number().int(),
  /** When the Inspector last read CI for the expected head; null until it has. */
  observedAt: z.number().nullable(),
  /** The expected head's checks as last read. */
  checkRuns: z.array(CiCheckRunSchema).max(CI_CHECK_RUNS_MAX),
  /** When CI was first seen all green without a "Flaky tests" check. */
  greenWithoutReportSince: z.number().nullable(),
  outcome: z.enum(["pass", "fail", "blocked"]).nullable(),
  /** The flake report of a passing run, when the "Flaky tests" check carried one. */
  flakeReport: FlakeReportSchema.nullable(),
  blocked: z.object({ code: z.enum(WAIT_FOR_CI_BLOCK_CODES), detail: z.string() }).nullable(),
  /** True when the operator disabled the node and it passed without waiting. */
  disabled: z.boolean().optional(),
});
export type WaitForCiState = z.infer<typeof WaitForCiStateSchema>;

/** The state a freshly activated node starts with. */
export function initialWaitForCiState(input: {
  pullRequestKey: string | null;
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
  expectedHeadOid: string | null;
  reportedHeadOid?: string | null;
  timeoutMinutes: number;
  now: number;
}): WaitForCiState {
  return {
    kind: "wait_for_ci",
    pullRequestKey: input.pullRequestKey,
    pullRequestUrl: input.pullRequestUrl,
    pullRequestNumber: input.pullRequestNumber,
    expectedHeadOid: input.expectedHeadOid,
    reportedHeadOid: input.reportedHeadOid ?? null,
    waitingSince: input.now,
    timeoutMinutes: input.timeoutMinutes,
    observedAt: null,
    checkRuns: [],
    greenWithoutReportSince: null,
    outcome: null,
    flakeReport: null,
    blocked: null,
  };
}

/** The attempt output as a Wait for CI state, or null when it is something else. */
export function readWaitForCiState(output: unknown): WaitForCiState | null {
  const parsed = WaitForCiStateSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}

export type WaitForCiDecision =
  | { kind: "wait"; state: WaitForCiState }
  | { kind: "pass"; state: WaitForCiState }
  | { kind: "fail"; state: WaitForCiState; failing: CiCheckRun[] }
  | { kind: "block"; state: WaitForCiState; code: WaitForCiBlockCode; detail: string };

function sameHead(expected: string, observed: string): boolean {
  return expected.toLowerCase() === observed.toLowerCase();
}

/**
 * One observation of a waiting node, decided. Pure: the caller supplies the stored
 * observation and the time.
 *
 * - Another head, or no observation yet: wait. The node never judges a head it was not given.
 * - Any check still pending: wait.
 * - A failing check other than "Flaky tests": fail, naming every failing check.
 * - All passing with a "Flaky tests" check: pass, carrying its report.
 * - All passing without one: wait out the grace period, then block `ci_flake_report_missing`.
 * - At the timeout: block `ci_missing` when no check ever appeared, `ci_timeout` otherwise.
 */
export function decideWaitForCi(
  state: WaitForCiState,
  observation: CiObservation | null,
  now: number,
): WaitForCiDecision {
  if (!state.expectedHeadOid) {
    const blocked = {
      code: "ci_pull_request_unknown" as const,
      detail: state.pullRequestKey
        ? "The pull request's head commit could not be identified: GitHub had not reported it, "
          + "and the checkout's own head could not be resolved."
        : "The step before this node recorded no pull request to watch.",
    };
    return { kind: "block", ...blocked, state: { ...state, outcome: "blocked", blocked } };
  }
  let next = state;
  if (observation && sameHead(state.expectedHeadOid, observation.headSha)) {
    next = { ...next, observedAt: observation.observedAt, checkRuns: observation.checkRuns };
    const runs = observation.checkRuns;
    const settled = runs.length > 0 && runs.every((run) => run.state !== "pending");
    if (settled) {
      const failing = runs.filter((run) => run.state === "failing" && run.name !== FLAKY_TESTS_CHECK_NAME);
      if (failing.length > 0) {
        return { kind: "fail", failing, state: { ...next, outcome: "fail", greenWithoutReportSince: null } };
      }
      if (runs.some((run) => run.name === FLAKY_TESTS_CHECK_NAME)) {
        return {
          kind: "pass",
          state: { ...next, outcome: "pass", flakeReport: observation.flakeReport, greenWithoutReportSince: null },
        };
      }
      const since = next.greenWithoutReportSince ?? now;
      next = { ...next, greenWithoutReportSince: since };
      if (now - since >= WAIT_FOR_CI_FLAKE_REPORT_GRACE_MS || timedOut(next, now)) {
        const blocked = {
          code: "ci_flake_report_missing" as const,
          detail: `Every check passed, but no "${FLAKY_TESTS_CHECK_NAME}" check appeared on the head commit.`,
        };
        return { kind: "block", ...blocked, state: { ...next, outcome: "blocked", blocked } };
      }
      return { kind: "wait", state: next };
    }
    next = { ...next, greenWithoutReportSince: null };
  }
  if (timedOut(next, now)) {
    const blocked = next.checkRuns.length === 0
      ? {
          code: "ci_missing" as const,
          detail: `No CI check appeared on the head commit within ${next.timeoutMinutes} minutes.`,
        }
      : {
          code: "ci_timeout" as const,
          detail: `CI was still running after ${next.timeoutMinutes} minutes.`,
        };
    return { kind: "block", ...blocked, state: { ...next, outcome: "blocked", blocked } };
  }
  return { kind: "wait", state: next };
}

function timedOut(state: WaitForCiState, now: number): boolean {
  return now - state.waitingSince >= state.timeoutMinutes * 60_000;
}
