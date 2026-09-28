import type { DatabaseSync } from "node:sqlite";
import { slotRunsTests, type WorkflowPolicy } from "@shared/workflow.ts";
import { acquireHostLease } from "../util/host-lease.ts";
import type {
  CheckExecutionRequest,
  CheckExecutionResult,
  CheckExecutor,
} from "./checks.ts";
import {
  CheckLeaseStore,
  type CheckGroupRecovery,
  type CheckLeaseManager,
  type CheckLeaseRelease,
} from "./check-lease.ts";
import type { CheckGroupEmptiness, CheckGroupTeardownOptions } from "./check-group.ts";
import { checkRuntimeSupport, type CheckRuntimeSupport } from "./check-identity.ts";
import { resolveCapturedCommit } from "./commit-id.ts";
import {
  createCheckGroupRecovery,
  DEFAULT_CHECK_TIMEOUT_MS,
  runSupervisedCheck,
  type CheckSpawnOutcome,
  type CheckSupervisorLookup,
} from "./check-supervisor.ts";

// The execution runtime a Check node reaches: the ONE place the worktree lease and the gated
// process supervisor meet, and the change that makes a configured check gate stop passing
// without running.
//
// Everything hard already happened in the two halves this composes. The lease half owns
// ownership, pinning, durability and reclamation; the supervisor half owns spawning, output,
// identity and proving a process group gone. What is left here is an ORDER, and every step of
// it is a rule with a failure behind it:
//
//  1. **Platform first, before anything is leased.** Somewhere a process identity cannot be
//     read, a check could be started and never proven finished - so it is declined, and
//     declining costs no pool slot.
//  2. **A null `headSha` is infrastructure, not `unavailable`.** A capture with no commit
//     cannot be pinned, and running against whatever the tree happens to hold is the exact
//     wrong answer this whole unit exists to avoid. `unavailable` PASSES the gate; this must
//     not.
//  3. **Cleanup precedes classification.** The lease is resolved before any result is
//     returned, especially an `infrastructure` one - because that result sends the engine
//     straight to a retry, a retry is a new attempt id, and a new attempt id would cheerfully
//     lease a SECOND tree while the first group may still be writing into the first.
//  4. **Only a proven-empty group authorises the return.** Anything else keeps the row and
//     the pin and hands the lease to the reclamation pass.
//
// It never decides pass or fail. The ladder in `checks.ts` and `checkVerdict` in `engine.ts`
// own that, and an exit code reaches them exactly as the supervisor reported it.

/**
 * Which attempt an executor is running for.
 *
 * Declared HERE, by the consumer, rather than added to `CheckExecutionRequest`. That type is
 * published, closed, and describes a COMMAND - a slot, an argv, a repository, a commit - while
 * this describes the attempt whose resources the command borrows, which is not something the
 * ladder in `checks.ts` knows or should learn. Widening it would also have made every existing
 * caller of `runCheck` supply an identity it has no reason to hold.
 *
 * This is the same direction the supervisor took with `CheckSupervisorLookup`: the consumer
 * names the narrow shape it needs and its composer supplies one, rather than an earlier phase's
 * published contract growing a member to serve a later phase's consumer. The engine builds one
 * of these per attempt and binds it; nothing in `checks.ts` changes.
 *
 * All three fields answer different questions. `attemptId` is the lease key, the process
 * registry key, and what makes the pooled worktree's holder token unique to one attempt.
 * `submissionId` and `nodeId` are what let the engine ask, before it creates a retry, whether
 * this node still owns a lease that has not resolved - a retry carries a NEW attempt id, so
 * nothing about the retry itself would collide with the lease it must not outrun.
 */
export interface CheckAttemptRef {
  attemptId: string;
  submissionId: string;
  nodeId: string;
}

/** Test suites get the larger budget; faster check slots keep the supervisor default. */
export function defaultCheckTimeoutMs(slot: CheckExecutionRequest["slot"]): number {
  return slot === "test" ? 60 * 60_000 : DEFAULT_CHECK_TIMEOUT_MS;
}

/** The two settings a test-running check reads, asked once per check. */
export type CheckTestPolicy = Pick<WorkflowPolicy, "checkTestLease" | "checkTestConcurrency">;

/** Held machine-wide while one test-running check's command runs. */
export interface CheckTestLease {
  release(): Promise<void>;
}

/**
 * Take the machine-wide check test lease, waiting at most `waitMs`. `onWaiting` fires when the
 * lease turned out to be held by somebody else, so a caller can tell a real wait from none.
 */
export type CheckTestLeaseAcquirer = (
  request: { attemptId: string; waitMs: number; onWaiting: () => void },
) => Promise<CheckTestLease>;

/**
 * Set in a test-running check's environment while this daemon holds the machine's check test
 * lease for it, and read by a daemon from its own environment.
 *
 * A daemon started INSIDE a leased check - an e2e suite run as a workflow test check starts
 * its own daemons - is already covered by its ancestor's hold, and taking the lease again
 * would wait on its own parent until the check timed out. The e2e fixture sets it for the same
 * reason: the e2e host lease already serialises suites, and a fixture daemon's checks are
 * `printf`s that must not queue behind the operator's real test run.
 */
export const CHECK_TEST_LEASE_HELD_ENV = "MISSION_CHECK_TEST_LEASE_HELD";

/** The test concurrency variable this repository's `npm test` reads. */
export const CHECK_TEST_CONCURRENCY_ENV = "MISSION_TEST_CONCURRENCY";

/** The real acquirer: `src/server/util/host-lease.ts` under the check test lease's name. */
export const acquireCheckTestLease: CheckTestLeaseAcquirer = ({ attemptId, waitMs, onWaiting }) =>
  acquireHostLease({
    name: "mission-check-tests",
    label: "Mission Control check test lease",
    waitMs,
    details: { attemptId },
    isDetails: (value) => typeof value.attemptId === "string",
    onWaiting: () => onWaiting(),
  });

/** How the composed runtime is driven, and every seam a test needs to drive it without a pool. */
export interface CheckRuntimeDeps {
  /** Defaults to the real gated supervisor. */
  supervise?: typeof runSupervisedCheck;
  /** Defaults to the platform probe. Asked once per check, before anything is leased. */
  platform?: () => CheckRuntimeSupport;
  /** How long one check command gets. Overrides the slot-specific production defaults. */
  timeoutMs?: number;
  /** Teardown timings, for both live cancellation and startup recovery. */
  teardown?: CheckGroupTeardownOptions;
  /**
   * Where the durable supervisor identity is read back from.
   *
   * The supervisor persists identity through Contract P (`record` / `clear`) and deliberately
   * has no reader on that interface - so the composer supplies one, which is this module. The
   * lease store is the published accessor for those two columns, and passing a row's raw
   * sentinel values straight through is safe: `terminateCheckGroup` already treats a
   * non-signallable pid or an empty identity as "nothing ever ran".
   */
  leaseStore?: CheckLeaseStore;
  /** Only consulted when no store is injected. */
  db?: DatabaseSync;
  /** Defaults to asking git. See `resolveCapturedCommit`. */
  resolveCommit?: (repoRoot: string, headSha: string) => Promise<string>;
  /**
   * The test lease and concurrency settings. Defaults to both OFF, so a runtime nobody wired
   * to the operator's policy - every test that constructs one - never takes the machine lease.
   * The daemon passes `getWorkflowPolicy`.
   */
  testPolicy?: () => CheckTestPolicy;
  /** Defaults to `acquireCheckTestLease`. */
  acquireTestLease?: CheckTestLeaseAcquirer;
  /** Where `CHECK_TEST_LEASE_HELD_ENV` is read from. Defaults to the daemon's environment. */
  env?: NodeJS.ProcessEnv;
}

const NO_TEST_POLICY: CheckTestPolicy = { checkTestLease: false, checkTestConcurrency: null };

/**
 * The composed check execution runtime.
 *
 * Constructed once per daemon, in `src/server/index.ts`, above the `WorkflowManager`: a check
 * must not start before durable check-lease recovery knows which trees it already holds.
 */
export class CheckRuntime {
  private readonly supervise: typeof runSupervisedCheck;
  private readonly platform: () => CheckRuntimeSupport;
  private readonly timeoutMs: number | undefined;
  private readonly teardown: CheckGroupTeardownOptions | undefined;
  private readonly resolveCommit: (repoRoot: string, headSha: string) => Promise<string>;
  private readonly testPolicy: () => CheckTestPolicy;
  private readonly acquireTestLease: CheckTestLeaseAcquirer;
  private readonly env: NodeJS.ProcessEnv;

  /**
   * Phase 3's answer to the lease manager's open question, ready to inject.
   *
   * The lease manager can prove a leased tree is OURS and cannot prove anything about what is
   * running inside it; only the second authorises a destructive return. Its own default
   * refuses, so an uninjected daemon keeps every non-sentinel lease across a restart - fail
   * closed, but a pool slot per restart. This is the injection that closes it, and it is
   * consumed by BOTH `reconcileOnStartup` and the reclamation pass that rides the reaper tick.
   */
  readonly groupRecovery: CheckGroupRecovery;

  constructor(
    private readonly leases: CheckLeaseManager,
    deps: CheckRuntimeDeps = {},
  ) {
    this.supervise = deps.supervise ?? runSupervisedCheck;
    this.platform = deps.platform ?? checkRuntimeSupport;
    this.timeoutMs = deps.timeoutMs;
    this.teardown = deps.teardown;
    this.resolveCommit = deps.resolveCommit ?? resolveCapturedCommit;
    this.testPolicy = deps.testPolicy ?? (() => NO_TEST_POLICY);
    this.acquireTestLease = deps.acquireTestLease ?? acquireCheckTestLease;
    this.env = deps.env ?? process.env;
    const store = deps.leaseStore ?? new CheckLeaseStore(deps.db);
    const lookup: CheckSupervisorLookup = (attemptId) => {
      const row = store.get(attemptId);
      return row ? { pid: row.supervisorPid, startTimeTicks: row.supervisorStartTicks } : null;
    };
    this.groupRecovery = createCheckGroupRecovery(lookup, deps.teardown ?? {});
  }

  /** Bind the runtime to one attempt. The result is Contract E's published executor type. */
  executorFor(attempt: CheckAttemptRef): CheckExecutor {
    return (request) => this.execute(attempt, request);
  }

  /**
   * Contract R, asked by the engine before it creates a retry for a check node.
   *
   * Exposed here rather than reached for directly so the daemon wires one object into the
   * workflow manager instead of two halves that could be injected apart.
   */
  unresolvedLeaseForNode(submissionId: string, nodeId: string): boolean {
    return this.leases.unresolvedLeaseForNode(submissionId, nodeId);
  }

  private async execute(
    attempt: CheckAttemptRef,
    request: CheckExecutionRequest,
  ): Promise<CheckExecutionResult> {
    // Asked before a tree is taken. `runSupervisedCheck` asks it again - it has to, since it
    // is reachable on its own - but an unsupported platform must never reach a pool at all:
    // leasing a worktree to decline a check would spend the resource the decline exists to
    // protect.
    const support = this.platform();
    if (!support.supported) return { kind: "unavailable", note: support.note };

    if (request.headSha === null) {
      // Not `unavailable`, which PASSES. There is nothing to pin the worktree to, and a check
      // run against whatever a pooled tree happens to be holding would report an answer about
      // some other commit as though it were about this submission.
      return {
        kind: "infrastructure",
        reason:
          "this submission captured no commit, so there was nothing to pin a check worktree to",
      };
    }

    // `acquireForAttempt` verifies the commit BEFORE it leases, using the same full-40-hex
    // check the dispatcher uses, and unwinds its own lease on any pin failure - so a commit
    // this repository does not have costs an error rather than a pool slot. Every failure it
    // can produce is infrastructure and never a verdict.
    let leasePath: string;
    try {
      leasePath = await this.leases.acquireForAttempt({
        attemptId: attempt.attemptId,
        submissionId: attempt.submissionId,
        nodeId: attempt.nodeId,
        repoRoot: request.repoRoot,
        // The capture records an abbreviation and a pin takes a full id, so this is the step
        // that turns one into the other. See `resolveCapturedCommit`: without it every check on
        // every real submission failed here, before a tree was ever leased.
        headSha: await this.resolveCommit(request.repoRoot, request.headSha),
      });
    } catch (err) {
      return {
        kind: "infrastructure",
        reason: `a worktree for the ${request.slot} check could not be prepared: ${message(err)}`,
      };
    }

    // The command's own timeout starts at spawn, so a wait here never eats into it. The wait
    // has its own ceiling, the same length, and running out is infrastructure: the engine's
    // ordinary retry asks again rather than reporting a verdict about a command never run.
    const timeoutMs = this.timeoutMs ?? defaultCheckTimeoutMs(request.slot);
    const runsTests = slotRunsTests(request.slot);
    const policy = runsTests ? this.testPolicy() : NO_TEST_POLICY;
    const extraEnv: Record<string, string> = {};
    if (runsTests && policy.checkTestConcurrency !== null) {
      extraEnv[CHECK_TEST_CONCURRENCY_ENV] = String(policy.checkTestConcurrency);
    }
    let testLease: CheckTestLease | null = null;
    let waitedMs: number | undefined;
    if (policy.checkTestLease && !this.env[CHECK_TEST_LEASE_HELD_ENV]) {
      const waitStarted = Date.now();
      let waited = false;
      try {
        testLease = await this.acquireTestLease({
          attemptId: attempt.attemptId,
          waitMs: timeoutMs,
          onWaiting: () => { waited = true; },
        });
      } catch (err) {
        // Nothing ran, so the group is empty by construction and the tree can go straight back.
        const cleanup = await this.settle(attempt.attemptId, "empty");
        return {
          kind: "infrastructure",
          reason:
            `the ${request.slot} check could not take the machine's test lease: ${message(err)}`
            + (cleanup.ok ? "" : `; its worktree also could not be accounted for: ${cleanup.reason}`),
        };
      }
      if (waited) waitedMs = Date.now() - waitStarted;
      extraEnv[CHECK_TEST_LEASE_HELD_ENV] = "1";
    }

    let outcome: CheckSpawnOutcome;
    try {
      outcome = await this.supervise(
        {
          attemptId: attempt.attemptId,
          command: request.command,
          // THE LEASED TREE, joined with the subpath the winning command entry named. Never
          // the binding's `sessionRepoRoot`: on the ordinary dispatch shape that names the
          // shared main repository behind a linked worktree, so a check would test an
          // unrelated checkout and report the answer as if it were about this submission.
          leasePath,
          workingSubpath: request.workingSubpath,
          timeoutMs,
          extraEnv,
        },
        {
          registry: this.leases.processes,
          teardown: this.teardown,
        },
      );
    } catch (err) {
      // The supervisor is written not to throw, and a lease outliving one that did would be a
      // pool slot lost to a bug nobody can see. Resolved as unproven, which is the fail-closed
      // reading: the row and the pin are kept and reclamation asks about the group later.
      await testLease?.release().catch(() => {});
      await this.settle(attempt.attemptId, "unknown");
      return {
        kind: "infrastructure",
        reason: `the ${request.slot} check runtime failed: ${message(err)}`,
      };
    }
    // Released as soon as the command is done, before the tree settles: the next test check
    // may start while this one's worktree is still being handed back. A release that fails
    // closes nothing it can still hold - the socket closes with this process at the latest.
    await testLease?.release().catch(() => {});

    // BEFORE the result surfaces, always. An `infrastructure` result reaches
    // `handleInfrastructureFailure`, which finishes this attempt and creates a fresh one, and
    // the retry gate it consults can only be right if this lease has already reached its true
    // state by the time it is asked.
    const cleanup = await this.settle(attempt.attemptId, outcome.emptiness);
    // A cleanup that did not resolve is an INFRASTRUCTURE failure, and it outranks whatever the
    // command said. Two reasons, and the second is the one that makes this load-bearing rather
    // than fastidious:
    //
    //  - A gate whose worktree is still held, or was re-leased to somebody else while it ran,
    //    has not been shown to have run against the commit it claims. Reporting `passed` on a
    //    tree we cannot account for is the same class of wrong answer as running the command in
    //    `sessionRepoRoot` - a verdict about the wrong thing, delivered confidently.
    //  - The retry gate only ever sees an attempt through `handleInfrastructureFailure`. Let a
    //    verdict through here and a run whose check exited 0 with a stranded lease advances,
    //    completes, and holds a pool slot with nothing anywhere saying so. Returning
    //    infrastructure is what turns that into a visible `check_cleanup_unresolved` block that
    //    reclamation then clears.
    //
    // The command's own outcome rides along in the reason rather than being dropped, so the
    // operator can still see what the build said before the lease went wrong.
    if (!cleanup.ok) {
      return {
        kind: "infrastructure",
        reason:
          `the ${request.slot} check ran and ${describeResult(outcome.result)}, but that result is `
          + `not reported because its pooled worktree could not be accounted for: ${cleanup.reason}`,
      };
    }
    return waitedMs !== undefined && outcome.result.kind === "exited"
      ? { ...outcome.result, waitedMs }
      : outcome.result;
  }

  /**
   * Resolve the lease against what the supervisor could PROVE, not against how the command
   * exited, and say whether the resource ended up accounted for.
   *
   * Those are two different questions and the caller needs both. A command that exits zero
   * having left a background server running is ordinary, and its exit code is still zero - but
   * its tree is not free, and only a proven-empty group may authorise a `return --force`.
   */
  private async settle(attemptId: string, emptiness: CheckGroupEmptiness): Promise<CheckCleanup> {
    if (emptiness !== "empty") {
      // Keep the row, keep the pin, drop only this process's claim - so the reclamation pass
      // stops treating the lease as a check that is still running and starts asking whether
      // its group has finally gone.
      this.leases.handOffForReclaim(attemptId);
      return {
        ok: false,
        reason:
          `its process group could not be proven empty (${emptiness}), so the worktree is kept `
          + "until reclamation can prove it gone",
      };
    }
    let released: CheckLeaseRelease;
    try {
      released = await this.leases.releaseForAttempt(attemptId);
    } catch (err) {
      // Ownership is dropped in `releaseForAttempt`'s own `finally`, but a throw before that is
      // reached would leave this attempt looking like a check still running - which is the one
      // state reclamation skips.
      this.leases.handOffForReclaim(attemptId);
      return { ok: false, reason: `releasing the worktree failed outright: ${message(err)}` };
    }
    if (released.outcome === "returned") return { ok: true };
    if (released.outcome === "lost") {
      // The tree was leased to somebody else by the time we tried to give it back, which means
      // it may have been reset under the command while it ran. Nothing can be concluded about
      // what that command was standing in, so nothing is concluded.
      return {
        ok: false,
        reason:
          `the worktree was held by ${released.holder ?? "another holder"} by the time it was `
          + "handed back, so what the command was standing in cannot be established",
      };
    }
    return {
      ok: false,
      reason: `the worktree could not be handed back (${released.reason}), and the lease is kept`,
    };
  }
}

/** Whether a check's pooled worktree ended up accounted for, and why not when it did not. */
type CheckCleanup = { ok: true } | { ok: false; reason: string };

/**
 * What the command did, for a reason line whose whole job is to explain a discarded result.
 *
 * The outcome is not lost just because it is not reported as a verdict: an operator looking at
 * a blocked run has to be able to tell "the build failed and then cleanup went wrong" from
 * "the build passed and then cleanup went wrong", because only one of those is also a repair.
 */
function describeResult(result: CheckExecutionResult): string {
  if (result.kind === "exited") return `exited ${result.exitCode}`;
  if (result.kind === "unavailable") return "reported that its command was not found";
  return `could not be run (${result.reason})`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
