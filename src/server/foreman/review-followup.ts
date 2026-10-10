import type {
  InspectorSummary,
  PrChecks,
  PrMergeableObservation,
  Session,
} from "@shared/types.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import type { ReportBucket } from "@shared/session.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { hasPane } from "./queue-machine.ts";
import { settledIdle } from "@shared/session.ts";
import { currentMergeability, mergeConflictResolutionSteps } from "@shared/pr-mergeable.ts";

// The review follow-through trigger's decision core: a session's work has become an
// OPEN pull request, it has parked, and the PR now carries feedback nobody is acting on
// - unresolved Inspector comments, a failing CI, or both. Should Foreman type the
// session back onto it?
//
// Zero I/O and `now` always injected, exactly like queue-machine.ts and
// prompted-wrapup.ts, so the whole policy is a unit-testable table and the worker holds
// none of it. Unlike those two this needs no `claude -p`: the question is not "is this
// work done" (a judgement) but "does this PR carry feedback we have not relayed yet" (a
// fact), and every input to that fact is already on the session snapshot - `inspector`,
// `prChecks`, `prState`, and per repository `task.repoPrs[].feedback`. So there is no
// verify step; decide, then type.
//
// ONE SESSION, N PULL REQUESTS
//
// A multi-repo task's session opens one pull request per repository it changed, so "the
// session's PR" is not a thing this can read. `followupPrs` turns a session into the list it
// actually owns and everything below decides about ONE of them, with its own mark. A
// single-repo session yields exactly one entry built from the same scalars this always read,
// which is why nothing about the common case changes.
//
// WHY THIS IS ITS OWN TRIGGER, NOT A WRAP-UP
//
// The wrap-up triggers (`drain`, `prompted`) answer "has the work finished, so ship it".
// By the time this fires the work HAS shipped - there is a PR - and what is left is the
// review loop the PR opened. `tickTargets` never selects a parked straight-to-PR session
// (no queue, no armed prompted trigger), so this runs FLEET-LEVEL in the worker's loop,
// over every session, the same shape as the backlog autopilot.
//
// MERGE CONFLICTS, THE THIRD DIMENSION
//
// A conflicting pull request is nudged once per conflicting head, at most
// `CONFLICT_NUDGE_CAP` times per conflict episode. When the nudges run out, or the agent parks
// on the head it was nudged about, Foreman ESCALATES instead: the daemon marks the episode
// and the conflict lands in the operator's Blocked pull requests inbox. Everything reads the
// current head's mergeability through `currentMergeability`, so a fix push GitHub has not
// answered for yet is neither nudged, counted nor given up on.

/** Nudges per conflict episode before Foreman hands the conflict to the operator. */
export const CONFLICT_NUDGE_CAP = 3;
/** Settled-idle on the nudged, still-conflicting head for this long means the agent gave up. */
export const CONFLICT_GIVE_UP_MS = 2 * 60_000;
/** How often an escalated mark re-sends its escalation, so a restarted daemon re-learns it. */
export const CONFLICT_ESCALATE_RESEND_MS = 60_000;

/** The knobs this trigger reads. A projection of ForemanConfig, like QueueConfig. */
export interface ReviewFollowupConfig {
  /** Relay posted Inspector comments from `ForemanConfig.trackReviewFeedback`. */
  trackReviewComments: boolean;
  /** Relay failing CI episodes from `ForemanConfig.trackCiFailures`. */
  trackCiFailures: boolean;
  /** Keep conflicting pull requests on track, from `ForemanConfig.trackMergeConflicts`. */
  trackMergeConflicts: boolean;
  /** How long a session must sit idle before its work counts as settled. */
  settleMs: number;
}

/**
 * ONE open pull request this session's work is carrying, and the feedback on it.
 *
 * The unit this whole file decides about, and it is a pull request rather than a session
 * because a session can legitimately own several: a multi-repo task opens one per repository
 * it changed. Everything below reads THIS and never the session's `prUrl`/`prChecks`/
 * `inspector` scalars, which answer for the session's own checkout alone - so a secondary
 * repository's red CI and unresolved findings are as visible here as the primary's.
 *
 * `followupPrs` is the only thing that builds one. A single-repo session yields exactly one,
 * carrying exactly the scalars this file used to read.
 */
export interface FollowupPr {
  /** `owner/repo#123` where the Inspector adopted it, else `#123`. Marks are keyed on it. */
  prKey: string;
  url: string;
  number: number | null;
  /**
   * The repository this pull request belongs to, or NULL when it is the session's own
   * checkout - which is every single-repo session, and is what keeps their nudge unchanged.
   * A path here means "one of several", and the payload says so.
   */
  repoRoot: string | null;
  /** The Inspector's state for THIS pull request, or null when it never adopted it. */
  inspector: InspectorSummary | null;
  /** THIS pull request's CI rollup, or null when nothing has answered for it. */
  checks: PrChecks | null;
  /**
   * THIS pull request's mergeability observation, bound to the head it was made on. Read it
   * through `currentMergeability` with `headSha`, never directly.
   */
  mergeable: PrMergeableObservation | null;
  /** The base branch, or null while unknown. */
  baseRef: string | null;
  /** The current head commit, or null while unknown. */
  headSha: string | null;
  /** The daemon escalated this PR's open conflict episode: the operator owns it now. */
  conflictEscalated: boolean;
}

export interface ReviewFollowupInput {
  session: Session;
  /**
   * The pull request being considered, from `followupPrs`, or null when the session has no
   * open one at all.
   */
  pr: FollowupPr | null;
  /** The session's bucket, computed from the current fleet snapshot. */
  bucket: ReportBucket;
  /** Whether Foreman is cleared to type here (live + allowlisted) - the same gate a send passes. */
  mayActLive: boolean;
  /** Whether a non-terminal workflow run currently owns this session and its checkout. */
  workflowOwnsSession: boolean;
  /**
   * What we have already nudged this session about ON THIS PULL REQUEST, advanced by
   * `advanceFollowupMark` for this pass's observation. Null when we have never nudged it.
   */
  mark: FollowupMark | null;
  cfg: ReviewFollowupConfig;
  now: number;
}

export type ReviewFollowupDecision =
  /** Not a candidate. `why` is for the tests/log - every skip is explicable. */
  | { kind: "skip"; why: string }
  /** Type the follow-up. Carries the mark to stamp on delivery and the exact payload. */
  | { kind: "nudge"; prKey: string; mark: FollowupMark; reason: string; payload: string }
  /**
   * Hand the conflict to the operator through `POST /api/pr-conflicts/escalate`. `resend` is
   * an escalated mark repeating itself, so a restarted daemon re-learns it; it is neither
   * logged nor recorded again.
   */
  | {
      kind: "escalate";
      prKey: string;
      url: string;
      headSha: string;
      mark: FollowupMark;
      reason: string;
      resend: boolean;
    };

/**
 * What we have already relayed to a session about ONE pull request, so we neither nag an
 * unchanged state nor miss a genuinely new one. In-memory only.
 *
 * The two feedback sources have different "newness" clocks, and one signature string
 * cannot track both (that was the bug the Inspector caught): findings are keyed by the
 * Inspector ROUND, which advances with every push, while a CI failure is an EPISODE that
 * can recur on the same round (a flaky rerun, a re-triggered check) and so needs its own
 * observed-recovery bit. Keyed alongside `prKey` so a new PR resets everything.
 *
 * ONE MARK PER PULL REQUEST, not per session. A multi-repo task's session owns a pull request
 * in each repository it changed, and they carry independent review histories: repo A's second
 * Inspector round says nothing about whether repo B's first has been relayed. A single mark
 * per session would have each new pull request reset the other's, which is both a missed nudge
 * (the reset one looks fresh, so its feedback is repeated) and a permanent nag (the two take
 * turns resetting each other). The worker holds the map; the key here is what indexes it.
 */
export interface FollowupMark {
  /** The PR this mark is about. A different PR key resets the other two fields. */
  prKey: string;
  /** The Inspector round we last nudged POSTED findings for, or null if never. */
  findingsRound: number | null;
  /** Whether we have nudged for the CURRENT CI-failing episode; re-armed on recovery. */
  ciNudged: boolean;
  /** The conflicting head SHA last nudged about, or null. */
  conflictHead: string | null;
  /** Conflict nudges sent this episode. */
  conflictNudges: number;
  /** When the last conflict nudge was stamped, so the give-up clock never starts before it. */
  conflictNudgedAt: number | null;
  /** This episode was escalated: Foreman stays silent about the conflict until it re-arms. */
  conflictEscalated: boolean;
  /** When the escalation was last sent, for the re-send cadence. Null until sent. */
  conflictEscalatedAt: number | null;
}

/** The conflict half of a mark, re-armed: a new episode starts from here. */
const CONFLICT_REARMED = {
  conflictHead: null,
  conflictNudges: 0,
  conflictNudgedAt: null,
  conflictEscalated: false,
  conflictEscalatedAt: null,
} as const satisfies Partial<FollowupMark>;

/** A mark that has relayed nothing yet about `prKey`. */
function freshMark(prKey: string): FollowupMark {
  return {
    prKey,
    findingsRound: null,
    ciNudged: false,
    ...CONFLICT_REARMED,
  };
}

/**
 * Every OPEN pull request this session's work is carrying, in the order they should be
 * offered - the primary repository's first.
 *
 * The one place that knows a session can own more than one, and the single-repo answer is
 * deliberately the first branch: no attached repositories means the session's own scalars,
 * exactly the three fields this file read before any of this existed, wrapped in one entry.
 *
 * A multi-repo task reads its per-repository lines instead, and only those whose `feedback`
 * the branch poller still holds - which IS the open test for a repository that has no session
 * scalar to retract. The durable `prState` beside it is never retracted once set, so trusting
 * it here would keep nudging about a pull request somebody closed.
 */
export function followupPrs(s: Session): FollowupPr[] {
  const repoPrs = s.task?.repoPrs ?? [];
  if (repoPrs.length === 0) {
    if (s.prState !== "open" || !s.prUrl) return [];
    return [
      {
        prKey: s.inspector?.prKey ?? (s.prNumber !== null ? `#${s.prNumber}` : "pr"),
        url: s.prUrl,
        number: s.prNumber,
        repoRoot: null,
        inspector: s.inspector,
        checks: s.prChecks,
        mergeable: s.prMergeable,
        baseRef: s.prBaseRef,
        headSha: s.prHeadSha,
        conflictEscalated: s.prConflictEscalated,
      },
    ];
  }
  const out: FollowupPr[] = [];
  for (const entry of repoPrs) {
    if (!entry.prUrl || !entry.feedback) continue;
    out.push({
      // The repository qualifies the fallback, unlike the single-repo one above. Two
      // repositories of one task can hold pull request #7 apiece, and the Inspector adopts
      // both - but it can be switched off, and then two entries would key the same mark and
      // evict each other, which is the exact bug this whole file is keyed per PR to avoid.
      prKey: entry.feedback.inspector?.prKey ?? `${entry.repoRoot}#${entry.feedback.prNumber}`,
      url: entry.prUrl,
      number: entry.feedback.prNumber,
      repoRoot: entry.repoRoot,
      inspector: entry.feedback.inspector,
      checks: entry.feedback.prChecks,
      mergeable: entry.feedback.prMergeable,
      baseRef: entry.feedback.prBaseRef,
      headSha: entry.feedback.prHeadSha,
      conflictEscalated: entry.feedback.prConflictEscalated,
    });
  }
  return out;
}

/** The PR's current head mergeability, the one reading rule applied to a `FollowupPr`. */
function mergeabilityOf(pr: FollowupPr) {
  return currentMergeability({ prMergeable: pr.mergeable, prHeadSha: pr.headSha });
}

/**
 * Fold this pass's observation into the mark: reset it on a new PR, and RE-ARM CI when the
 * checks are no longer failing, so a later failure counts as a fresh episode.
 *
 * The conflict half re-arms ONLY when the current head is observed `mergeable`: an unknown
 * head, straight after a fix push, leaves it untouched. And a mark that has not escalated is
 * seeded from the daemon's `prConflictEscalated`, so a restarted Foreman stays silent about a
 * conflict the operator already owns.
 *
 * Pure, and called every pass for EVERY open pull request - not only the ones about to be
 * nudged - because that is the whole fix: a CI recovery seen while the session was working
 * (or while Foreman was dry-run) has to be remembered so the next failure re-arms once the
 * session parks. Without a PR head sha on the snapshot this observed-recovery bit is the
 * only thing that can tell a re-failure from the one we already relayed.
 */
export function advanceFollowupMark(prev: FollowupMark | null, pr: FollowupPr): FollowupMark {
  let mark: FollowupMark = prev && prev.prKey === pr.prKey ? prev : freshMark(pr.prKey);
  // CI is no longer failing: whatever episode we may have nudged is over. Re-arm it.
  if (mark.ciNudged && pr.checks !== "failing") mark = { ...mark, ciNudged: false };
  const mergeable = mergeabilityOf(pr);
  if (mergeable === "mergeable") {
    const rearmed = mark.conflictHead === null && mark.conflictNudges === 0 && !mark.conflictEscalated;
    if (!rearmed) mark = { ...mark, ...CONFLICT_REARMED };
  } else if (pr.conflictEscalated && !mark.conflictEscalated) {
    mark = { ...mark, conflictEscalated: true };
  }
  return mark;
}

/** What is actionable on one pull request right now. */
interface Feedback {
  /** The Inspector has open findings that are actually posted on the PR. */
  findings: boolean;
  /** The PR's CI rollup is failing (as opposed to pending or passing). */
  ciFailing: boolean;
  /** The PR's current head is observed conflicting with its base. */
  conflicting: boolean;
}

/** Terminal runs have released their session; every other durable state still owns it. */
export function activeWorkflowOwnsSession(
  runs: readonly Pick<WorkflowRunSummary, "status">[],
): boolean {
  return runs.some((run) => !["completed", "cancelled", "failed"].includes(run.status));
}

/**
 * Why Foreman's follow-through will not type into this session, or null when it may.
 *
 * Gate 2 of `decideReviewFollowup`, and also what the daemon's conflict episodes
 * (`src/server/pr-conflicts.ts`) read to decide a conflict is "foreman-cannot-nudge", so the
 * two cannot disagree about which sessions Foreman drives. Live mode and the allowlist are
 * `foremanMayActLive`'s, the other half of that answer.
 */
export function foremanCannotDrive(
  s: Pick<Session, "foremanInvite" | "agent" | "state" | "hooksSeen">,
): string | null {
  if (s.foremanInvite === null) return "Foreman is not invited into this session";
  // No `workQueue` capability means no hooks and no reliable state to read; an exited
  // session has nothing left to type into.
  // `workQueue` is the reliable-idle/drivable proxy for this automation.
  if (!capabilitiesFor(s.agent).workQueue) {
    return `${AGENT_IDENTITY[s.agent].label} sessions can't be followed up`;
  }
  if (s.state === "exited") return "the session exited";
  if (!s.hooksSeen) return "the session is not hook-instrumented";
  return null;
}

function feedbackState(pr: FollowupPr, cfg: ReviewFollowupConfig): Feedback {
  const findings = cfg.trackReviewComments && !!pr.inspector && pr.inspector.postedOpen > 0;
  return {
    findings,
    ciFailing: cfg.trackCiFailures && pr.checks === "failing",
    conflicting: cfg.trackMergeConflicts && mergeabilityOf(pr) === "conflicting",
  };
}

/**
 * Should Foreman hand this conflict to the operator now? Null when not.
 *
 * Not a typing act, so none of the pane, idle or live-mode gates apply: it is a state write
 * on the daemon. Three ways in, all on a head currently observed conflicting:
 *
 *  - RE-SEND: the mark is already escalated, and a minute has passed since it was last sent.
 *    The route is idempotent; this is what a restarted daemon re-learns `nudges-exhausted`
 *    from. A seeded mark has never sent, so it sends once straight away.
 *  - CAP: a new conflicting head after `CONFLICT_NUDGE_CAP` nudges.
 *  - GIVE-UP: the agent has sat settled-idle for `CONFLICT_GIVE_UP_MS` on the very head it was
 *    nudged about, counted from the nudge as well, so a session idle long before the nudge
 *    landed is not given up on the next pass. A new head, even one GitHub has not answered
 *    for, means the agent pushed, and never reaches here.
 */
function decideConflictEscalation(
  s: Session,
  pr: FollowupPr,
  fb: Feedback,
  cur: FollowupMark,
  now: number,
): ReviewFollowupDecision | null {
  if (!fb.conflicting || pr.headSha === null) return null;
  const head = pr.headSha;
  const escalate = (reason: string, resend: boolean): ReviewFollowupDecision => ({
    kind: "escalate",
    prKey: pr.prKey,
    url: pr.url,
    headSha: head,
    mark: { ...cur, conflictEscalated: true, conflictEscalatedAt: now },
    reason,
    resend,
  });
  if (cur.conflictEscalated) {
    const last = cur.conflictEscalatedAt;
    return last === null || now - last >= CONFLICT_ESCALATE_RESEND_MS
      ? escalate("re-sending the conflict escalation", true)
      : null;
  }
  if (head !== cur.conflictHead && cur.conflictNudges >= CONFLICT_NUDGE_CAP) {
    return escalate(`${cur.conflictNudges} conflict nudges did not resolve it`, false);
  }
  if (
    head === cur.conflictHead &&
    cur.conflictNudgedAt !== null &&
    now - cur.conflictNudgedAt >= CONFLICT_GIVE_UP_MS &&
    settledIdle(s, now, CONFLICT_GIVE_UP_MS)
  ) {
    return escalate("the agent parked on the nudged head without resolving the conflict", false);
  }
  return null;
}

/**
 * Is this session a candidate for a review follow-through nudge? Every branch is an early
 * return and the order is the policy.
 *
 * Strict on purpose. Each gate below is a case where typing would be WRONG - interrupting
 * live work, relaying feedback a human is already handling, or nagging a PR that is being
 * dealt with - and there is no model call here to catch a mistake the gates let through.
 */
export function decideReviewFollowup(input: ReviewFollowupInput): ReviewFollowupDecision {
  const { session: s, pr, bucket, mayActLive, workflowOwnsSession, mark, cfg, now } = input;

  // 1. The trigger is off. First because it is the cheapest and because an off trigger
  //    must reach no branch that decides to type.
  if (!cfg.trackReviewComments && !cfg.trackCiFailures && !cfg.trackMergeConflicts) {
    return skip("PR follow-through is off");
  }

  // 2. Only a session Foreman was invited into, and only one it can actually drive, and
  //    only a live one.
  //
  //    The invite comes FIRST of the three, above even the capability check, because it is
  //    the refusal that matters most here and the one a reader needs to see reported
  //    plainly: this path is the one that typed "create a PR" into personal Claude chats,
  //    and it did so because it iterated every session with an open PR. A hand-started
  //    session with a PR on its branch is capable, hooked, live, and still none of
  //    Foreman's business.
  const refusal = foremanCannotDrive(s);
  if (refusal) return skip(refusal);

  // 3. There has to be an OPEN pull request to speak about. A merged one is done; a
  //    closed-unmerged one is dropped like no PR at all (see `Session.prUrl`). WHICH one is
  //    the caller's choice now - `followupPrs` enumerates them and a multi-repo session has
  //    several - but the gate is the same one, and it still reads as a property of the
  //    session in the log: nothing here to follow through on.
  if (!pr) return skip("no open pull request");

  // The mark with this pass's observation already folded in by `advanceFollowupMark`.
  const cur: FollowupMark = mark && mark.prKey === pr.prKey ? mark : freshMark(pr.prKey);
  const fb = feedbackState(pr, cfg);

  // Handing a conflict to the operator types nothing, so it is decided before the gates that
  // protect the pane. Only a workflow outranks it: a run that owns the session owns its
  // conflict too, and classifies it itself.
  if (!workflowOwnsSession) {
    const escalation = decideConflictEscalation(s, pr, fb, cur, now);
    if (escalation) return escalation;
  }

  // 4. Something needs a human. An unanswered question or an input wait means the agent
  //    is stopped ON that, not free to be handed the PR - triage owns it until it doesn't.
  if (bucket === "needs-you") return skip("the session needs a human");
  if (s.state === "awaiting_input") return skip("the session is waiting on input");

  // 5. THE OVERLAP RULE, the same shape prompted-wrapup states: a checkout with live work
  //    queue items belongs to the drain path. Gated on open ITEMS, via the card summary
  //    already on the session - a row exists for any session Foreman ever touched.
  if ((s.queue?.openCount ?? 0) > 0) {
    return skip("this checkout has a work queue - the drain trigger owns it");
  }

  // 6. A non-terminal workflow run owns its bound session and checkout. It may be
  //    reviewing, delivering repair guidance, waiting for the session to act, or driving
  //    PR/Inspector gates. A separate Foreman nudge must never type across that ownership.
  if (workflowOwnsSession) {
    return skip("an active workflow owns this session");
  }

  // 7. Is there anything to act on? Open posted findings, a red CI, or a conflict nobody
  //    escalated. Nothing here is the overwhelmingly common state of an open PR and it is not
  //    a fault - say nothing. An escalated conflict belongs to the operator, so it is not
  //    mentioned again, even alongside other feedback.
  const conflictOpen = fb.conflicting && !cur.conflictEscalated && !pr.conflictEscalated;
  const open: Feedback = { ...fb, conflicting: conflictOpen };
  if (!open.findings && !open.ciFailing && !open.conflicting) {
    return skip("no enabled review comments, failing CI or merge conflict");
  }

  // 8. Only a settled-idle session with a delivery channel. The idle gate is what keeps
  //    this from interrupting an agent already working the fixes: once it acts on a nudge
  //    it is no longer idle, so it is not re-selected until it parks again.
  if (!settledIdle(s, now, cfg.settleMs)) return skip("still working");
  if (!hasPane(s)) return skip("no pane to type into");

  // 9. Typing is a live act, so it needs the same clearance a queue send does - live mode
  //    on an allowlisted repo. Dry-run means dry-run: no card to fall back to here, so it
  //    simply holds.
  if (!mayActLive) return skip("dry-run or off-allowlist - won't type");

  // Is anything here NEW since we last nudged? The sources are judged on their own clocks
  // (see `FollowupMark`): findings by the Inspector round, CI by whether the current failing
  // episode has been relayed, a conflict by its head and the per-episode cap. `mark` has
  // already had this pass's recovery folded in by `advanceFollowupMark`, so a re-failure
  // after a recovery reads as new.
  const round = pr.inspector?.round ?? 0;
  const findingsNew = open.findings && cur.findingsRound !== round;
  const ciNew = open.ciFailing && !cur.ciNudged;
  const conflictNew =
    open.conflicting && pr.headSha !== cur.conflictHead && cur.conflictNudges < CONFLICT_NUDGE_CAP;
  if (!findingsNew && !ciNew && !conflictNew) return skip("already nudged this round of feedback");

  // Stamp every currently-open dimension as relayed. The payload covers everything open, so
  // once it lands the agent has heard about all of it - not only whichever one was new. A
  // conflict counts toward the cap only on a head it had not been nudged about.
  const next: FollowupMark = {
    ...cur,
    findingsRound: open.findings ? round : cur.findingsRound,
    ciNudged: cur.ciNudged || open.ciFailing,
    ...(conflictNew
      ? { conflictHead: pr.headSha, conflictNudges: cur.conflictNudges + 1, conflictNudgedAt: now }
      : {}),
  };
  return {
    kind: "nudge",
    prKey: pr.prKey,
    mark: next,
    reason: describe(pr, open),
    payload: buildPayload(pr, open),
  };
}

function skip(why: string): ReviewFollowupDecision {
  return { kind: "skip", why };
}

/** One-line reason for the worker's log. */
function describe(pr: FollowupPr, fb: Feedback): string {
  const open = pr.inspector?.postedOpen ?? 0;
  const where = pr.repoRoot !== null ? ` in ${pr.repoRoot}` : "";
  const parts: string[] = [];
  if (fb.findings) parts.push(`${open} review comment(s)`);
  if (fb.ciFailing) parts.push("CI failing");
  if (fb.conflicting) parts.push(`merge conflicts with ${pr.baseRef ?? "its base"}`);
  return `${parts.join(" + ")}${where}`;
}

/**
 * The instruction typed back at the session. Harness-neutral - it is plain text that
 * lands in whatever composer the session has - and it names the concrete PR so the agent
 * does not have to rediscover which one it is.
 *
 * The load-bearing line is "do not open a new pull request": a session told to fix its
 * work will, left to its own devices, sometimes branch and open a second PR, orphaning
 * the review threads on the first. Everything else is guidance the agent could infer, but
 * spelled out so a cheaper model on a fresh turn does the right thing.
 *
 * That line is right PER PULL REQUEST and wrong per session, and the difference shows up on a
 * multi-repo task: the session legitimately owns one pull request per repository it changed,
 * and an unqualified "do not open a new pull request" would read as a ban on the sibling it
 * has not opened yet. So when the pull request belongs to an attached repository the
 * instruction names it - which repository to stand in, which pull request to push to, and
 * which one to leave alone. A single-repo session's payload names no repository: `repoRoot`
 * is null there and every qualifier below collapses to nothing.
 */
export function buildPayload(pr: FollowupPr, fb: Feedback): string {
  const ref = pr.number !== null ? `PR #${pr.number}` : "your open pull request";
  // By URL rather than number: a bare number makes `gh` pick the repository from the remotes,
  // which on a fork means asking about the parent - and an org enforcing SAML SSO refuses that.
  const target = ` ${pr.url}`;

  const problems: string[] = [];
  if (fb.findings) {
    const n = pr.inspector?.postedOpen ?? 0;
    problems.push(`GitHub Inspector left ${n} unresolved review comment${n === 1 ? "" : "s"} on it`);
  }
  if (fb.ciFailing) problems.push("its CI checks are failing");
  // `baseRefName` rides every poll, so a missing base is a rare race; say so rather than
  // guess `main`.
  if (fb.conflicting) {
    problems.push(`it has merge conflicts with ${pr.baseRef ? `\`${pr.baseRef}\`` : "its base branch"}`);
  }

  const steps: string[] = [];
  if (pr.repoRoot !== null) {
    steps.push(
      `This is the pull request for ${pr.repoRoot}, one of several repositories this task ` +
        "changed. Work in that repository's worktree and leave the others alone.",
    );
    steps.push(
      "Do NOT open a new pull request for it - push your fixes to the branch it is already on.",
    );
  } else {
    steps.push("Do NOT open a new pull request - push your fixes to this same branch.");
  }
  if (fb.findings) {
    steps.push(
      `Read GitHub Inspector's review comments (\`gh pr view${target} --comments\`, and the ` +
        `line threads under Files changed) and address every one.`,
    );
  }
  if (fb.ciFailing) {
    steps.push(
      `Look at the failing CI (\`gh pr checks${target}\`), reproduce it locally, and fix it.`,
    );
  }
  // The merge-in method has one owner, shared with the workflow's conflict repair round.
  if (fb.conflicting) steps.push(...mergeConflictResolutionSteps(pr.baseRef).split("\n"));
  steps.push("Commit and push.");
  steps.push(
    "Then keep watching the PR until CI is green and the review threads are resolved - " +
      "GitHub Inspector re-reviews each push automatically, so wait for it and answer anything new.",
  );

  return (
    `${ref} needs follow-through: ${problems.join(", and ")}.\n\n` +
    steps.map((step, i) => `${i + 1}. ${step}`).join("\n")
  );
}
