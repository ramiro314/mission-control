import { z } from "zod";
import { FLAKY_TESTS_CHECK_NAME, FlakeReportSchema, type FlakeReport } from "./flake-report.ts";
import { classifyCheckEntry } from "./ci-checks.ts";
import type { PrMergeable } from "./types.ts";

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
 * What every Wait for CI node judges under: all checks count, a 3-minute quiet period, and no
 * expected checks. Literals, frozen for ever: a node or attempt that names no setting means
 * exactly this, never whatever a later default becomes.
 */
export const WAIT_FOR_CI_LEGACY_SETTINGS = {
  strictness: "all",
  quietMinutes: 3,
  expectedChecks: [],
} as const;

/**
 * How long a quiet period still running at the timeout may wait for the observation that
 * decides it, counted from the moment the period would end.
 *
 * Past the timeout a quiet period may finish but never start again, and it is decided on the
 * first new observation at or after its end. The Inspector reviews pull requests one at a
 * time, and a review can take ten minutes before the next 90-second poll, so that observation
 * can come minutes late; fifteen minutes covers one review, one poll and the CodeRabbit read
 * in the same turn. A literal, because this module cannot import the Inspector worker.
 */
export const WAIT_FOR_CI_QUIET_GRACE_MS = 15 * 60_000;

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
    const state = classifyCheckEntry(node);
    if (state === null) continue;
    if (typeof node.status === "string" && typeof node.name === "string") {
      const conclusion = typeof node.conclusion === "string" ? node.conclusion.toUpperCase() : null;
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
  /**
   * Every check passed and no "Flaky tests" check appeared. Nothing produces it any more:
   * runs blocked with it before that check stopped being required keep it, and "Wait for CI
   * again" judges them under the current rules.
   */
  "ci_flake_report_missing",
  /** No check appeared on the head commit before the timeout. */
  "ci_missing",
  /** Checks were still running, or had not stayed settled for the quiet period, at the timeout. */
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
  /**
   * Retired: when CI was first seen green without a "Flaky tests" check. Always written as
   * null, and kept in the schema so a downgraded daemon can still read attempts this one wrote.
   */
  greenWithoutReportSince: z.number().nullable(),
  /**
   * The `observedAt` of the Inspector observation that first saw this settled set of checks:
   * the start of the quiet period. Null while any check is pending or the set has not been
   * seen settled; absent on attempts written before the quiet period existed.
   */
  quietSince: z.number().nullable().optional(),
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
    quietSince: null,
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

/**
 * Whether the pull request conflicts with its base, as the PR poller last observed it.
 *
 * `headSha` is the head that observation was MADE on (`Session.prMergeable.headSha`), never
 * the pull request's current head: GitHub answers `UNKNOWN` after a push, and the poller then
 * keeps the previous observation whole, old head included. Reading the current head here
 * would make a conflict observed before the repair push look like a conflict on the repair.
 */
export interface WaitForCiMergeability {
  mergeable: PrMergeable;
  headSha: string;
  /** The pull request's base branch, or null while the poller has not reported it. */
  baseRef: string | null;
}

export type WaitForCiDecision =
  | { kind: "wait"; state: WaitForCiState }
  | { kind: "pass"; state: WaitForCiState }
  | {
      kind: "fail";
      state: WaitForCiState;
      failing: CiCheckRun[];
      /** Set when the pull request conflicts with its base; `failing` is then empty. */
      conflict?: { baseRef: string | null };
    }
  | { kind: "block"; state: WaitForCiState; code: WaitForCiBlockCode; detail: string };

function sameHead(expected: string, observed: string): boolean {
  return expected.toLowerCase() === observed.toLowerCase();
}

/** A check as the quiet period compares it: what it is called and what it concluded. */
function checkKey(run: CiCheckRun): string {
  return JSON.stringify([run.name, run.state, run.conclusion]);
}

/** Whether two observations saw the same checks, in any order. */
function sameChecks(a: readonly CiCheckRun[], b: readonly CiCheckRun[]): boolean {
  if (a.length !== b.length) return false;
  const left = a.map(checkKey).sort();
  const right = b.map(checkKey).sort();
  return left.every((key, index) => key === right[index]);
}

/**
 * One observation of a waiting node, decided. Pure: the caller supplies the stored
 * observation and the time. Every node judges under `WAIT_FOR_CI_LEGACY_SETTINGS`.
 *
 * - The pull request conflicts with its base on the expected head: fail, before anything else.
 *   GitHub runs no `pull_request` checks on a conflicting pull request, so waiting for them
 *   would only end in `ci_missing`. A conflict observed on another head waits like any other
 *   observation of another head.
 * - Another head, or no observation yet: wait. The node never judges a head it was not given.
 * - Any check still pending: wait, and clear the quiet period.
 * - Every check settled, one failing: fail, naming every failing check. "Flaky tests" is a
 *   check like any other.
 * - Every check passed: the quiet period. Its clock starts at the `observedAt` of the
 *   observation that first saw this set, and the node passes on an observation at least the
 *   quiet period later that saw the same set. A changed set restarts it. The clock reads
 *   observations, never `now`, so the manager's fifteen-second sweep re-deciding one
 *   observation cannot pass the node on its own. The pass carries the flake report, when CI
 *   published one.
 * - At the timeout: a quiet period already running may still finish on its first new
 *   observation, unchanged, but never starts or restarts. It blocks `ci_timeout` when the set
 *   changes, or when no new observation arrives within `WAIT_FOR_CI_QUIET_GRACE_MS` of the
 *   period's end. Otherwise it blocks `ci_missing` when no check ever appeared, and
 *   `ci_timeout`, naming the checks still running, when one did.
 */
export function decideWaitForCi(
  state: WaitForCiState,
  observation: CiObservation | null,
  now: number,
  mergeability: WaitForCiMergeability | null = null,
): WaitForCiDecision {
  // Retired, and never written as anything but null again, whatever an older daemon left.
  let next: WaitForCiState = { ...state, greenWithoutReportSince: null };
  if (!next.expectedHeadOid) {
    const blocked = {
      code: "ci_pull_request_unknown" as const,
      detail: next.pullRequestKey
        ? "The pull request's head commit could not be identified: GitHub had not reported it, "
          + "and the checkout's own head could not be resolved."
        : "The step before this node recorded no pull request to watch.",
    };
    return { kind: "block", ...blocked, state: { ...next, outcome: "blocked", blocked } };
  }
  if (
    mergeability?.mergeable === "conflicting"
    && sameHead(next.expectedHeadOid, mergeability.headSha)
  ) {
    return {
      kind: "fail",
      failing: [],
      conflict: { baseRef: mergeability.baseRef },
      state: { ...next, outcome: "fail", quietSince: null },
    };
  }
  const quietMs = WAIT_FOR_CI_LEGACY_SETTINGS.quietMinutes * 60_000;
  if (observation && sameHead(next.expectedHeadOid, observation.headSha)) {
    const previous = next.checkRuns;
    const runs = observation.checkRuns;
    next = { ...next, observedAt: observation.observedAt, checkRuns: runs };
    const settled = runs.length > 0 && runs.every((run) => run.state !== "pending");
    if (!settled) {
      next = { ...next, quietSince: null };
    } else {
      const failing = runs.filter((run) => run.state === "failing");
      if (failing.length > 0) {
        return { kind: "fail", failing, state: { ...next, outcome: "fail", quietSince: null } };
      }
      const since = next.quietSince ?? null;
      if (since !== null && sameChecks(previous, runs)) {
        if (observation.observedAt - since >= quietMs) {
          return {
            kind: "pass",
            state: { ...next, outcome: "pass", flakeReport: observation.flakeReport },
          };
        }
        if (timedOut(next, now) && now - since >= quietMs + WAIT_FOR_CI_QUIET_GRACE_MS) {
          return timeoutBlock(next, "No new CI observation arrived to finish the quiet period "
            + `within ${WAIT_FOR_CI_QUIET_GRACE_MS / 60_000} minutes of its end.`);
        }
        return { kind: "wait", state: next };
      }
      if (timedOut(next, now)) {
        return timeoutBlock(next, `CI had not stayed settled for the ${quietMs / 60_000}-minute quiet `
          + `period after ${next.timeoutMinutes} minutes.`);
      }
      return { kind: "wait", state: { ...next, quietSince: observation.observedAt } };
    }
  }
  if (timedOut(next, now)) {
    if (next.checkRuns.length === 0) {
      const blocked = {
        code: "ci_missing" as const,
        detail: `No CI check appeared on the head commit within ${next.timeoutMinutes} minutes.`,
      };
      return { kind: "block", ...blocked, state: { ...next, outcome: "blocked", blocked } };
    }
    const pending = next.checkRuns.filter((run) => run.state === "pending").map((run) => `"${run.name}"`);
    return timeoutBlock(next, pending.length > 0
      ? `Still running after ${next.timeoutMinutes} minutes: ${pending.join(", ")}.`
      : `CI had not stayed settled for the ${quietMs / 60_000}-minute quiet period after `
        + `${next.timeoutMinutes} minutes.`);
  }
  return { kind: "wait", state: next };
}

function timeoutBlock(state: WaitForCiState, detail: string): WaitForCiDecision {
  const blocked = { code: "ci_timeout" as const, detail };
  return { kind: "block", ...blocked, state: { ...state, outcome: "blocked", blocked } };
}

function timedOut(state: WaitForCiState, now: number): boolean {
  return now - state.waitingSince >= state.timeoutMinutes * 60_000;
}
