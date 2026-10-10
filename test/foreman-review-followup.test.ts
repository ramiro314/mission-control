import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFLICT_ESCALATE_RESEND_MS,
  CONFLICT_GIVE_UP_MS,
  activeWorkflowOwnsSession,
  advanceFollowupMark,
  buildPayload,
  decideReviewFollowup,
  followupPrs,
} from "../src/server/foreman/review-followup.ts";
import type {
  FollowupMark,
  FollowupPr,
  ReviewFollowupInput,
} from "../src/server/foreman/review-followup.ts";
import type {
  InspectorSummary,
  Session,
  SessionQueueSummary,
  TaskRepoPrSummary,
  TaskSummary,
} from "../src/shared/types.ts";
import type { TerminalHandle } from "../src/shared/terminal.ts";
import { WORKFLOW_RUN_STATUSES } from "../src/shared/workflow.ts";

// What is at stake: Foreman must re-engage a session whose PR is carrying feedback nobody
// is acting on - unresolved Inspector comments or a red CI - WITHOUT interrupting live
// work, relaying feedback a human owns, or nagging a PR that is being handled. Every gate
// below is a case where typing would be wrong, and there is no model call to catch a
// mistake, so the whole policy is pinned here as a table.

const NOW = 10_000_000;
const SETTLE = 10_000;

const PANE: TerminalHandle = {
  kind: "multiplexer",
  backend: "tmux",
  session: "sess",
  windowIndex: 0,
  paneId: "%1",
  sessionName: "sess",
  windowName: "sess",
};

function inspector(over: Partial<InspectorSummary> = {}): InspectorSummary {
  const open = over.open ?? 0;
  return {
    prKey: "owner/repo#7",
    url: "https://github.com/owner/repo/pull/7",
    mode: "live",
    open,
    postedOpen: over.postedOpen ?? open,
    round: 1,
    lastReviewedAt: NOW - 60_000,
    failed: false,
    ...over,
  };
}

function queue(openCount: number): SessionQueueSummary {
  return {
    openCount,
    totalCount: openCount,
    inFlightState: null,
    inFlightIntent: null,
    round: 0,
    blockingGaps: 0,
    verifiedCount: 0,
    escalatedCount: 0,
    drained: false,
    wrapupAskedAt: null,
    wrapupAnswered: false,
    updatedAt: 0,
  };
}

/** A session parked idle on an OPEN PR - the base case a nudge fires on. Override per test. */
function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    agent: "claude",
    name: "atlas",
    runtime: "terminal",
    // A dispatched worktree session parked on its PR - the base case a nudge fires on.
    foremanInvite: "dispatch",
    nameSource: "process",
    state: "idle",
    cwd: "/work/alpha",
    gitBranch: "feat/x",
    gitRoot: "/work/alpha",
    repoRoot: "/work/alpha",
    pid: 1,
    tty: "/dev/ttys001",
    permissionMode: null,
    terminals: [PANE],
    agentSessionId: "agent-1",
    transcriptPath: null,
    instrumented: true,
    stateConfirmed: true,
    hooksSeen: true,
    activity: null,
    startedAt: null,
    firstSeen: 0,
    lastSeen: NOW,
    lastActivity: NOW - 20_000, // older than SETTLE, so settledIdle is true
    pendingReviews: 0,
    task: null,
    prUrl: "https://github.com/owner/repo/pull/7",
    prNumber: 7,
    prState: "open",
    prChecks: null,
    prMergeable: null,
    prBaseRef: null,
    prHeadSha: null,
    prConflictEscalated: false,
    meta: null,
    effortBaselineReady: false,
    pendingEffort: null,
    note: null,
    cost: null,
    goal: null,
    queue: null,
    pendingTurns: [],
    orphanedQueue: null,
    inspector: null,
    pipeline: null,
    paneDialog: null,
    ...over,
  };
}

function decide(over: Partial<ReviewFollowupInput> = {}) {
  const session = over.session ?? mkSession();
  return decideReviewFollowup({
    session,
    // The session's own pull request unless a case names one, which is what the worker
    // passes for a single-repo session and keeps every case below reading as it did.
    pr: followupPrs(session)[0] ?? null,
    bucket: "idle",
    mayActLive: true,
    workflowOwnsSession: false,
    mark: null,
    cfg: { trackReviewComments: true, trackCiFailures: true, trackMergeConflicts: true, settleMs: SETTLE },
    now: NOW,
    ...over,
  });
}

// ---- what fires ----

test("open findings on a live-posted review earn a nudge", () => {
  const d = decide({ session: mkSession({ inspector: inspector({ open: 2 }) }) });
  assert.equal(d.kind, "nudge");
  if (d.kind !== "nudge") return;
  assert.match(d.reason, /2 review comment/);
  assert.match(d.payload, /Do NOT open a new pull request/);
});

test("a failing CI alone earns a nudge, even with no findings", () => {
  const d = decide({ session: mkSession({ prChecks: "failing" }) });
  assert.equal(d.kind, "nudge");
  if (d.kind !== "nudge") return;
  assert.equal(d.reason, "CI failing");
});

test("findings and a red CI together are reported together", () => {
  const d = decide({ session: mkSession({ inspector: inspector({ open: 1 }), prChecks: "failing" }) });
  assert.equal(d.kind, "nudge");
  if (d.kind !== "nudge") return;
  assert.match(d.reason, /1 review comment.*\+ CI failing/);
});

// ---- what stays quiet ----

test("an UNINVITED session is never followed up - the personal-chat regression", () => {
  // THE bug this whole plan exists for. This path iterated every session with an open PR
  // and typed "create a PR" / "CI is red" into personal Claude chats, because a
  // machine-scoped hook made them look like sessions Mission Control had launched. The
  // subject below is otherwise a perfect nudge candidate - open findings, red CI, idle,
  // hooked, a pane - and the invite is the only thing standing between it and a nudge.
  const personal = mkSession({
    foremanInvite: null,
    inspector: inspector({ open: 2 }),
    prChecks: "failing",
  });
  const d = decide({ session: personal });
  assert.equal(d.kind, "skip");
  // C7: phase 3 reads this concept, so the reason names it.
  if (d.kind === "skip") assert.match(d.why, /not invited/);

  // The same session, invited, IS nudged - so the refusal above is the invite talking and
  // not some other gate quietly holding.
  assert.equal(decide({ session: { ...personal, foremanInvite: "operator" } }).kind, "nudge");
});

test("an operator invite is enough for PR follow-through", () => {
  // Approved decision 2: an operator invite grants triage, wrapup and PR follow-through.
  // Only the backlog autopilot demands more (see backlog-machine.test.ts).
  for (const invite of ["sdk", "dispatch", "operator"] as const) {
    const d = decide({ session: mkSession({ foremanInvite: invite, prChecks: "failing" }) });
    assert.equal(d.kind, "nudge", `${invite} should be followed up`);
  }
});

test("the invite refusal outranks every other reason a session cannot be nudged", () => {
  // Ordered first among the gates, above even the capability check, so the log says the
  // true thing about the session that matters most. A hookless, incapable (pi declares no
  // work queue), uninvited session reports the invite.
  const d = decide({
    session: mkSession({ foremanInvite: null, agent: "pi", hooksSeen: false }),
  });
  assert.deepEqual(d, { kind: "skip", why: "Foreman is not invited into this session" });
});

test("the trigger off is the first and cheapest skip", () => {
  const d = decide({
    session: mkSession({ inspector: inspector({ open: 3 }) }),
    cfg: { trackReviewComments: false, trackCiFailures: false, trackMergeConflicts: false, settleMs: SETTLE },
  });
  assert.deepEqual(d, { kind: "skip", why: "PR follow-through is off" });
});

test("the trigger is off only when all three follow-through toggles are", () => {
  const d = decide({
    session: mkSession({ inspector: inspector({ open: 3 }) }),
    cfg: { trackReviewComments: false, trackCiFailures: false, trackMergeConflicts: true, settleMs: SETTLE },
  });
  assert.equal(d.kind, "skip");
  assert.notEqual(d.kind === "skip" && d.why, "PR follow-through is off");
});

test("review comments and CI can be followed independently", () => {
  const both = mkSession({ inspector: inspector({ open: 2 }), prChecks: "failing" });

  const ciOnly = decide({
    session: both,
    cfg: { trackReviewComments: false, trackCiFailures: true, trackMergeConflicts: false, settleMs: SETTLE },
  });
  assert.equal(ciOnly.kind, "nudge");
  if (ciOnly.kind === "nudge") {
    assert.equal(ciOnly.reason, "CI failing");
    assert.doesNotMatch(ciOnly.payload, /review comment/);
  }

  const commentsOnly = decide({
    session: both,
    cfg: { trackReviewComments: true, trackCiFailures: false, trackMergeConflicts: false, settleMs: SETTLE },
  });
  assert.equal(commentsOnly.kind, "nudge");
  if (commentsOnly.kind === "nudge") {
    assert.match(commentsOnly.reason, /2 review comment/);
    assert.doesNotMatch(commentsOnly.payload, /failing CI/);
  }
});

test("CI follow-through waits for an existing PR and never creates one", () => {
  const d = decide({
    session: mkSession({ prState: null, prUrl: null, prChecks: "failing" }),
    cfg: { trackReviewComments: false, trackCiFailures: true, trackMergeConflicts: false, settleMs: SETTLE },
  });
  assert.deepEqual(d, { kind: "skip", why: "no open pull request" });
});

test("no open PR is nothing to follow through on", () => {
  assert.equal(decide({ session: mkSession({ prState: null, prUrl: null }) }).kind, "skip");
  // A merged PR is done, not open.
  assert.equal(decide({ session: mkSession({ prState: "merged", prChecks: "failing" }) }).kind, "skip");
});

test("a clean open PR - no findings, CI not red - is left alone", () => {
  const d = decide({ session: mkSession({ inspector: inspector({ open: 0 }), prChecks: "passing" }) });
  assert.deepEqual(d, { kind: "skip", why: "no enabled review comments, failing CI or merge conflict" });
});

test("dry-run Inspector findings are previews, not comments on the PR, so they do not fire", () => {
  // open > 0 but postedOpen = 0: the findings are drafted, never posted - pointing the agent
  // at "the review comments" would point it at comments that are not there.
  const d = decide({
    session: mkSession({ inspector: inspector({ open: 4, postedOpen: 0, mode: "dry-run" }) }),
  });
  assert.deepEqual(d, { kind: "skip", why: "no enabled review comments, failing CI or merge conflict" });
});

test("unposted findings do not fire even when the current Inspector mode is live", () => {
  const d = decide({
    session: mkSession({ inspector: inspector({ open: 4, postedOpen: 0, mode: "live" }) }),
  });
  assert.deepEqual(d, { kind: "skip", why: "no enabled review comments, failing CI or merge conflict" });
});

test("a session that needs a human is not free to be handed its PR", () => {
  assert.equal(
    decide({ session: mkSession({ inspector: inspector({ open: 1 }) }), bucket: "needs-you" }).kind,
    "skip",
  );
  assert.equal(
    decide({ session: mkSession({ state: "awaiting_input", inspector: inspector({ open: 1 }) }) }).kind,
    "skip",
  );
});

test("a checkout with a live work queue belongs to the drain trigger", () => {
  const d = decide({ session: mkSession({ inspector: inspector({ open: 1 }), queue: queue(1) }) });
  assert.match((d as { why: string }).why, /work queue/);
});

test("an active workflow owns the session and blocks an independent PR nudge", () => {
  const d = decide({
    session: mkSession({ inspector: inspector({ open: 1 }) }),
    workflowOwnsSession: true,
  });
  assert.deepEqual(d, { kind: "skip", why: "an active workflow owns this session" });
});

test("every non-terminal workflow state retains ownership until the run ends", () => {
  const terminal = new Set(["completed", "cancelled", "failed"]);
  for (const status of WORKFLOW_RUN_STATUSES) {
    assert.equal(activeWorkflowOwnsSession([{ status }]), !terminal.has(status), status);
  }
  assert.equal(activeWorkflowOwnsSession([]), false);
});

test("a still-working session is not interrupted", () => {
  const d = decide({ session: mkSession({ state: "working", inspector: inspector({ open: 2 }) }) });
  assert.deepEqual(d, { kind: "skip", why: "still working" });
});

test("an idle session too recently active has not settled", () => {
  const d = decide({
    session: mkSession({ inspector: inspector({ open: 2 }), lastActivity: NOW - 1000 }),
  });
  assert.deepEqual(d, { kind: "skip", why: "still working" });
});

test("no pane means nowhere to type", () => {
  const d = decide({ session: mkSession({ terminals: [], inspector: inspector({ open: 2 }) }) });
  assert.deepEqual(d, { kind: "skip", why: "no pane to type into" });
});

test("an exited session has nothing to type into", () => {
  const d = decide({ session: mkSession({ state: "exited", inspector: inspector({ open: 2 }) }) });
  assert.deepEqual(d, { kind: "skip", why: "the session exited" });
});

test("an operator-started Codex session without hooks is not automated", () => {
  const d = decide({
    session: mkSession({
      agent: "codex",
      hooksSeen: false,
      inspector: inspector({ open: 2 }),
    }),
  });
  assert.deepEqual(d, { kind: "skip", why: "the session is not hook-instrumented" });
});

test("typing is a live act - dry-run or off-allowlist holds", () => {
  const d = decide({ session: mkSession({ inspector: inspector({ open: 2 }) }), mayActLive: false });
  assert.match((d as { why: string }).why, /won't type/);
});

// ---- the once-per-feedback guard (the mark) ----

/** The one pull request a single-repo session owns - what the worker decides about. */
function onlyPr(session: Session): FollowupPr {
  const prs = followupPrs(session);
  assert.equal(prs.length, 1, "this fixture is meant to own exactly one pull request");
  const [pr] = prs;
  assert.ok(pr);
  return pr;
}

/** Fold the observation for a fresh session, exactly as the worker does each pass. */
function observe(session: Session, prev: FollowupMark | null = null): FollowupMark {
  return advanceFollowupMark(prev, onlyPr(session));
}

test("the same feedback state, already nudged, stays quiet", () => {
  const session = mkSession({ inspector: inspector({ open: 2, round: 1 }) });
  const first = decide({ session });
  assert.equal(first.kind, "nudge");
  if (first.kind !== "nudge") return;
  // Feed the stamped mark back through the pass's observation: nothing changed.
  const again = decide({ session, mark: observe(session, first.mark) });
  assert.deepEqual(again, { kind: "skip", why: "already nudged this round of feedback" });
});

test("a later PR resets the mark - no collision with the prior PR at the same round", () => {
  const firstSession = mkSession({ inspector: inspector({ open: 2, round: 1 }) });
  const first = decide({ session: firstSession });
  assert.equal(first.kind, "nudge");
  if (first.kind !== "nudge") return;

  const nextSession = mkSession({
    prUrl: "https://github.com/owner/repo/pull/8",
    prNumber: 8,
    inspector: inspector({
      prKey: "owner/repo#8",
      url: "https://github.com/owner/repo/pull/8",
      open: 2,
      round: 1,
    }),
  });
  // Same session id, new PR: advanceFollowupMark resets the mark to the new prKey.
  const next = decide({ session: nextSession, mark: observe(nextSession, first.mark) });
  assert.equal(next.kind, "nudge");
});

test("a new Inspector round with posted findings re-arms the nudge", () => {
  const round1 = mkSession({ inspector: inspector({ open: 2, round: 1 }) });
  const d1 = decide({ session: round1 });
  assert.equal(d1.kind, "nudge");
  if (d1.kind !== "nudge") return;

  // Agent pushed, the Inspector reviewed again and still found two things: new round.
  const round2 = mkSession({ inspector: inspector({ open: 2, round: 2 }) });
  const d2 = decide({ session: round2, mark: observe(round2, d1.mark) });
  assert.equal(d2.kind, "nudge");
});

test("CI clearing does not redundantly re-nudge open findings", () => {
  // Nudge findings + failing CI, then CI goes green while the same findings stay open at
  // the same round. The findings were already relayed; there is nothing new to say.
  const both = mkSession({ inspector: inspector({ open: 1, round: 1 }), prChecks: "failing" });
  const d1 = decide({ session: both });
  assert.equal(d1.kind, "nudge");
  if (d1.kind !== "nudge") return;

  const ciGreen = mkSession({ inspector: inspector({ open: 1, round: 1 }), prChecks: "passing" });
  const d2 = decide({ session: ciGreen, mark: observe(ciGreen, d1.mark) });
  assert.deepEqual(d2, { kind: "skip", why: "already nudged this round of feedback" });
});

test("CI that recovers and fails again re-arms, even on the same Inspector round", () => {
  // The Inspector's finding: a CI-only nudge must re-arm after checks recover and fail
  // again, without waiting for a new Inspector round.
  const round = { open: 0, round: 1 };
  const failing1 = mkSession({ inspector: inspector(round), prChecks: "failing" });
  const d1 = decide({ session: failing1 });
  assert.equal(d1.kind, "nudge");
  if (d1.kind !== "nudge") return;

  // Checks recover (still same round) - observed each pass even though nothing is nudged.
  const passing = mkSession({ inspector: inspector(round), prChecks: "passing" });
  const markAfterRecovery = observe(passing, d1.mark);
  assert.equal(markAfterRecovery.ciNudged, false, "recovery re-arms the CI episode");
  assert.equal(
    decide({ session: passing, mark: markAfterRecovery }).kind,
    "skip",
    "a green PR is not actionable",
  );

  // A fresh failure on the same round is a new episode - nudge again.
  const failing2 = mkSession({ inspector: inspector(round), prChecks: "failing" });
  const d2 = decide({ session: failing2, mark: observe(failing2, markAfterRecovery) });
  assert.equal(d2.kind, "nudge");
});

// ---- the payload ----

test("the payload names the PR and forbids opening a second one", () => {
  const p = buildPayload(onlyPr(mkSession()), { findings: true, ciFailing: true, conflicting: false });
  assert.match(p, /PR #7/);
  assert.match(p, /Do NOT open a new pull request/);
  // By URL, so `gh` never picks the repository from the remotes - on a fork, the parent.
  assert.match(p, /gh pr view https:\/\/github\.com\/owner\/repo\/pull\/7 --comments/);
  assert.match(p, /gh pr checks https:\/\/github\.com\/owner\/repo\/pull\/7/);
  // A session with one repository is told nothing about repositories.
  assert.doesNotMatch(p, /repositor/);
});

test("the payload only mentions the feedback that is actually open", () => {
  const ciOnly = buildPayload(onlyPr(mkSession()), { findings: false, ciFailing: true, conflicting: false });
  assert.doesNotMatch(ciOnly, /review comment/);
  assert.match(ciOnly, /CI/);

  const findingsOnly = buildPayload(
    onlyPr(mkSession({ inspector: inspector({ open: 1 }) })),
    { findings: true, ciFailing: false, conflicting: false },
  );
  assert.match(findingsOnly, /review comment/);
  assert.doesNotMatch(findingsOnly, /failing CI/);
});

// ---- one session, several pull requests (a multi-repo task) ----
//
// The premise this half exists for: a multi-repo task's session opens one pull request per
// repository it changed, and the session scalars (`prUrl`, `prChecks`, `inspector`) answer
// for its own checkout alone. Everything below is about the ones that reach no scalar.

/** One repository's line on a multi-repo task's card, with a pull request the poll saw open. */
function repoPr(over: Partial<TaskRepoPrSummary> & { repoRoot: string }): TaskRepoPrSummary {
  return {
    primary: false,
    prUrl: null,
    prState: "open",
    mergedAt: null,
    feedback: null,
    ...over,
  };
}

/** A session running a two-repo task: the primary at /work/alpha, a secondary at /work/beta. */
function mkMultiRepoSession(repoPrs: TaskRepoPrSummary[], over: Partial<Session> = {}): Session {
  const task: TaskSummary = {
    id: "t1",
    title: "cross-repo change",
    fullTitle: "cross-repo change",
    kind: "ship",
    workflowId: null,
    status: "running",
    outcome: null,
    outcomeUrl: null,
    pipelineRun: null,
    scheduleId: null,
    scheduleOccurrenceId: null,
    scheduledFor: null,
    ensemble: null,
    repoPrs,
  };
  return mkSession({ task, ...over });
}

const ALPHA_PR = repoPr({
  repoRoot: "/work/alpha",
  primary: true,
  prUrl: "https://github.com/owner/alpha/pull/7",
  feedback: {
    prNumber: 7,
    prChecks: null,
    prMergeable: null,
    prBaseRef: null,
    prHeadSha: null,
    prConflictEscalated: false,
    inspector: inspector({
      prKey: "owner/alpha#7",
      url: "https://github.com/owner/alpha/pull/7",
      open: 0,
    }),
  },
});

const BETA_PR = repoPr({
  repoRoot: "/work/beta",
  prUrl: "https://github.com/owner/beta/pull/9",
  feedback: {
    prNumber: 9,
    prChecks: null,
    prMergeable: null,
    prBaseRef: null,
    prHeadSha: null,
    prConflictEscalated: false,
    inspector: inspector({
      prKey: "owner/beta#9",
      url: "https://github.com/owner/beta/pull/9",
      open: 0,
    }),
  },
});

test("a multi-repo session offers every repository's open pull request, primary first", () => {
  const prs = followupPrs(mkMultiRepoSession([ALPHA_PR, BETA_PR]));
  assert.deepEqual(
    prs.map((pr) => [pr.prKey, pr.repoRoot, pr.number]),
    [
      ["owner/alpha#7", "/work/alpha", 7],
      ["owner/beta#9", "/work/beta", 9],
    ],
  );
});

test("a repository with no pull request, or one no poll still sees open, is not offered", () => {
  const noPr = repoPr({ repoRoot: "/work/gamma" });
  // A pull request the durable row still calls open, whose live observation was retracted -
  // what a closed-unmerged sibling looks like. Trusting `prState` here would nudge about it.
  const closed = repoPr({
    repoRoot: "/work/delta",
    prUrl: "https://github.com/owner/delta/pull/3",
    prState: "open",
    feedback: null,
  });
  const prs = followupPrs(mkMultiRepoSession([ALPHA_PR, noPr, closed]));
  assert.deepEqual(prs.map((pr) => pr.prKey), ["owner/alpha#7"]);
});

test("a single-repo session still yields exactly its own pull request", () => {
  // `repoPrs` is empty for every single-repo task, and the session scalars answer instead.
  const prs = followupPrs(mkSession({ inspector: inspector({ open: 2 }) }));
  assert.equal(prs.length, 1);
  assert.deepEqual(prs.map((pr) => [pr.prKey, pr.repoRoot, pr.number]), [
    ["owner/repo#7", null, 7],
  ]);
});

test("each pull request carries its OWN feedback, not the session's", () => {
  // The whole degradation this lifts: the secondary is red and full of findings while the
  // session scalars - the primary's - are clean.
  const beta = repoPr({
    ...BETA_PR,
    repoRoot: "/work/beta",
    feedback: {
      prNumber: 9,
      prChecks: "failing",
      prMergeable: null,
      prBaseRef: null,
      prHeadSha: null,
      prConflictEscalated: false,
      inspector: inspector({
        prKey: "owner/beta#9",
        url: "https://github.com/owner/beta/pull/9",
        open: 3,
      }),
    },
  });
  const session = mkMultiRepoSession([ALPHA_PR, beta]);
  const prs = followupPrs(session);

  const quiet = decide({ session, pr: prs[0] });
  assert.deepEqual(quiet, { kind: "skip", why: "no enabled review comments, failing CI or merge conflict" });

  const loud = decide({ session, pr: prs[1] });
  assert.equal(loud.kind, "nudge");
  if (loud.kind !== "nudge") return;
  assert.equal(loud.prKey, "owner/beta#9");
  assert.match(loud.reason, /3 review comment.*\+ CI failing/);
  assert.match(loud.reason, /\/work\/beta/);
});

test("a nudge about one repository's pull request names it, and only forbids a second OF IT", () => {
  const pr = followupPrs(mkMultiRepoSession([ALPHA_PR, BETA_PR]))[1];
  assert.ok(pr);
  const payload = buildPayload(pr, { findings: true, ciFailing: true, conflicting: false });
  assert.match(payload, /PR #9/);
  assert.match(payload, /\/work\/beta/);
  assert.match(payload, /one of several repositories/);
  assert.match(payload, /Do NOT open a new pull request for it/);
  // `gh` runs in the session's own checkout, which is the PRIMARY repo's worktree, so a
  // sibling's pull request has to be named by its URL or the command answers about the
  // wrong one.
  assert.match(payload, /gh pr view https:\/\/github\.com\/owner\/beta\/pull\/9 --comments/);
  assert.match(payload, /gh pr checks https:\/\/github\.com\/owner\/beta\/pull\/9/);
});

test("two pull requests on one session hold independent marks", () => {
  // The collision a session-keyed mark caused: nudging repo B erased what repo A had been
  // told, so A's unchanged findings were relayed again - and then A erased B's, for ever.
  const session = mkMultiRepoSession([
    {
      ...ALPHA_PR,
      feedback: {
        prNumber: 7,
        prChecks: null,
        prMergeable: null,
        prBaseRef: null,
        prHeadSha: null,
        prConflictEscalated: false,
        inspector: inspector({
          prKey: "owner/alpha#7",
          url: "https://github.com/owner/alpha/pull/7",
          open: 2,
          round: 1,
        }),
      },
    },
    {
      ...BETA_PR,
      feedback: {
        prNumber: 9,
        prChecks: null,
        prMergeable: null,
        prBaseRef: null,
        prHeadSha: null,
        prConflictEscalated: false,
        inspector: inspector({
          prKey: "owner/beta#9",
          url: "https://github.com/owner/beta/pull/9",
          open: 4,
          round: 1,
        }),
      },
    },
  ]);
  const [alpha, beta] = followupPrs(session);
  assert.ok(alpha && beta);

  const first = decide({ session, pr: alpha });
  assert.equal(first.kind, "nudge");
  if (first.kind !== "nudge") return;

  // The worker keys marks by PR key, so beta's decision never sees alpha's mark.
  const marks = new Map<string, FollowupMark>([[first.prKey, first.mark]]);
  const second = decide({ session, pr: beta, mark: marks.get(beta.prKey) ?? null });
  assert.equal(second.kind, "nudge", "beta has never been nudged and must be");
  if (second.kind !== "nudge") return;
  marks.set(second.prKey, second.mark);

  // And alpha's history survived beta's nudge: same round, same findings, nothing new.
  assert.deepEqual(
    decide({
      session,
      pr: alpha,
      mark: advanceFollowupMark(marks.get(alpha.prKey) ?? null, alpha),
    }),
    { kind: "skip", why: "already nudged this round of feedback" },
  );
  assert.equal(marks.get(alpha.prKey)?.findingsRound, 1);
  assert.equal(marks.get(beta.prKey)?.findingsRound, 1);
});

test("a mark advances on its own pull request's CI, not a sibling's", () => {
  const failing: FollowupPr = {
    prKey: "owner/beta#9",
    url: "https://github.com/owner/beta/pull/9",
    number: 9,
    repoRoot: "/work/beta",
    inspector: null,
    checks: "failing",
    mergeable: null,
    baseRef: null,
    headSha: null,
    conflictEscalated: false,
  };
  const nudged = advanceFollowupMark(
    { ...advanceFollowupMark(null, failing), ciNudged: true },
    failing,
  );
  assert.equal(nudged.ciNudged, true, "still the same failing episode");
  const recovered = advanceFollowupMark(nudged, { ...failing, checks: "passing" });
  assert.equal(recovered.ciNudged, false, "this pull request's own checks recovered");
});

test("two repositories holding the same pull request NUMBER do not share a mark", () => {
  // Only reachable with the Inspector switched off, which is a supported configuration: with
  // no ledger row there is no `owner/repo#n` key, and a bare `#7` in each of two repositories
  // is one key for two pull requests - the collision this file is keyed per PR to avoid.
  const unadopted = (repoRoot: string, url: string): TaskRepoPrSummary =>
    repoPr({
      repoRoot,
      prUrl: url,
      feedback: { prNumber: 7, prChecks: "failing", prMergeable: null, prBaseRef: null, prHeadSha: null, inspector: null, prConflictEscalated: false },
    });
  const prs = followupPrs(
    mkMultiRepoSession([
      { ...unadopted("/work/alpha", "https://github.com/owner/alpha/pull/7"), primary: true },
      unadopted("/work/beta", "https://github.com/owner/beta/pull/7"),
    ]),
  );
  assert.equal(new Set(prs.map((pr) => pr.prKey)).size, 2, "one key per pull request");
});

// ---- merge conflicts, the third dimension ----

/** A session parked on a PR whose head `head` is observed conflicting with `main`. */
function conflictingOn(head: string, over: Partial<Session> = {}): Session {
  return mkSession({
    prMergeable: { state: "conflicting", headSha: head },
    prHeadSha: head,
    prBaseRef: "main",
    ...over,
  });
}

/** One worker pass: fold the observation in, decide, and stamp what the decision carries. */
function pass(
  session: Session,
  prev: FollowupMark | null,
  now = NOW,
  over: Partial<ReviewFollowupInput> = {},
) {
  const observed = observe(session, prev);
  const d = decide({ session, mark: observed, now, ...over });
  return { d, mark: d.kind === "skip" ? observed : d.mark };
}

const MIN = 60_000;

test("a conflicting head earns a nudge with the merge steps and the no-rebase line", () => {
  const { d, mark } = pass(conflictingOn("A"), null);
  assert.equal(d.kind, "nudge");
  if (d.kind !== "nudge") return;
  assert.match(d.reason, /merge conflicts with main/);
  assert.match(d.payload, /PR #7 needs follow-through: it has merge conflicts with `main`\./);
  assert.match(d.payload, /git fetch origin main/);
  assert.match(d.payload, /git merge origin\/main/);
  assert.match(d.payload, /Resolve every conflict/);
  assert.match(d.payload, /Run the tests that cover the files you touched/);
  assert.match(d.payload, /Do not rebase or force-push/);
  assert.match(d.payload, /Do NOT open a new pull request/);
  assert.equal(mark.conflictHead, "A");
  assert.equal(mark.conflictNudges, 1);
  assert.equal(mark.conflictNudgedAt, NOW);
});

test("the same conflicting head is not nudged twice; a new one is", () => {
  const first = pass(conflictingOn("A"), null);
  const again = pass(conflictingOn("A"), first.mark, NOW + 30_000);
  assert.deepEqual(again.d, { kind: "skip", why: "already nudged this round of feedback" });

  const next = pass(conflictingOn("B"), again.mark, NOW + 60_000);
  assert.equal(next.d.kind, "nudge");
  assert.equal(next.mark.conflictHead, "B");
  assert.equal(next.mark.conflictNudges, 2);
});

test("after 3 nudges a new conflicting head escalates instead of nudging", () => {
  let mark: FollowupMark | null = null;
  for (const [i, head] of ["A", "B", "C"].entries()) {
    const r = pass(conflictingOn(head), mark, NOW + i * MIN);
    assert.equal(r.d.kind, "nudge", `nudge ${i + 1} on ${head}`);
    mark = r.mark;
  }
  assert.equal(mark?.conflictNudges, 3);

  // Escalation types nothing, so even a session that is busy again is handed over.
  const { d, mark: escalated } = pass(conflictingOn("D", { state: "working" }), mark, NOW + 3 * MIN);
  assert.equal(d.kind, "escalate");
  if (d.kind !== "escalate") return;
  assert.equal(d.url, "https://github.com/owner/repo/pull/7");
  assert.equal(d.headSha, "D");
  assert.equal(d.resend, false);
  assert.match(d.reason, /3 conflict nudges/);
  assert.equal(escalated.conflictEscalated, true);
  assert.equal(escalated.conflictNudges, 3, "an escalation is not a nudge");
});

test("settled-idle for 2 minutes on the nudged, still-conflicting head escalates", () => {
  const nudged = pass(conflictingOn("A"), null).mark;
  // Idle since NOW - 20s: at +1 minute that is not yet two minutes of settled idle.
  const early = pass(conflictingOn("A"), nudged, NOW + MIN);
  assert.equal(early.d.kind, "skip");

  const late = pass(conflictingOn("A"), early.mark, NOW + 2 * MIN);
  assert.equal(late.d.kind, "escalate");
  if (late.d.kind !== "escalate") return;
  assert.equal(late.d.resend, false);
  assert.match(late.d.reason, /parked on the nudged head/);
});

test("the give-up clock starts at the nudge, not at a long idle before it", () => {
  const longIdle = { lastActivity: NOW - 30 * MIN };
  const nudged = pass(conflictingOn("A", longIdle), null).mark;
  const next = pass(conflictingOn("A", longIdle), nudged, NOW + 10_000);
  assert.equal(next.d.kind, "skip", "the pass right after the nudge does not give up");
  const later = pass(conflictingOn("A", longIdle), nudged, NOW + CONFLICT_GIVE_UP_MS);
  assert.equal(later.d.kind, "escalate");
});

test("a still-working agent on the nudged head is not given up on", () => {
  const nudged = pass(conflictingOn("A"), null).mark;
  const r = pass(conflictingOn("A", { state: "working", lastActivity: NOW + 5 * MIN }), nudged, NOW + 5 * MIN);
  assert.equal(r.d.kind, "skip");
});

test("an escalated mark re-sends at most once a minute while conflicting, and stops after re-arming", () => {
  let mark: FollowupMark | null = null;
  for (const [i, head] of ["A", "B", "C"].entries()) mark = pass(conflictingOn(head), mark, NOW + i * MIN).mark;
  const t0 = NOW + 3 * MIN;
  mark = pass(conflictingOn("D"), mark, t0).mark;
  assert.equal(mark.conflictEscalated, true);

  // The daemon publishes the flag; the conflict is the operator's and is never nudged again.
  const owned = { prConflictEscalated: true };
  const quiet = pass(conflictingOn("D", owned), mark, t0 + 30_000);
  assert.equal(quiet.d.kind, "skip");
  const newHead = pass(conflictingOn("E", owned), quiet.mark, t0 + 45_000);
  assert.equal(newHead.d.kind, "skip", "not even on a new head");

  const resent = pass(conflictingOn("E", owned), newHead.mark, t0 + CONFLICT_ESCALATE_RESEND_MS);
  assert.equal(resent.d.kind, "escalate");
  if (resent.d.kind !== "escalate") return;
  assert.equal(resent.d.resend, true);
  assert.equal(resent.d.headSha, "E");
  const tooSoon = pass(conflictingOn("E", owned), resent.mark, t0 + CONFLICT_ESCALATE_RESEND_MS + 30_000);
  assert.equal(tooSoon.d.kind, "skip");

  // Fixed: observed mergeable on the current head. Everything re-arms and nothing re-sends.
  const fixed = mkSession({ prMergeable: { state: "mergeable", headSha: "F" }, prHeadSha: "F", prBaseRef: "main" });
  const rearmed = pass(fixed, tooSoon.mark, t0 + 5 * MIN);
  assert.equal(rearmed.d.kind, "skip");
  assert.equal(rearmed.mark.conflictEscalated, false);
  assert.equal(rearmed.mark.conflictNudges, 0);
  assert.equal(rearmed.mark.conflictHead, null);

  // A new conflict after that is a new episode: nudged again from one.
  const reopened = pass(conflictingOn("G"), rearmed.mark, t0 + 6 * MIN);
  assert.equal(reopened.d.kind, "nudge");
  assert.equal(reopened.mark.conflictNudges, 1);
});

test("a restarted daemon (no episode flag) still gets the re-send", () => {
  let mark: FollowupMark | null = null;
  for (const [i, head] of ["A", "B", "C", "D"].entries()) mark = pass(conflictingOn(head), mark, NOW + i * MIN).mark;
  assert.equal(mark?.conflictEscalated, true);
  // The snapshot says nothing is escalated: the daemon forgot. Foreman's mark still holds it.
  const r = pass(conflictingOn("D", { prConflictEscalated: false }), mark, NOW + 5 * MIN);
  assert.equal(r.d.kind, "escalate");
  if (r.d.kind === "escalate") assert.equal(r.d.resend, true);
});

test("a restarted Foreman seeds its mark from prConflictEscalated and never nudges", () => {
  const session = conflictingOn("A", { prConflictEscalated: true });
  const seeded = observe(session, null);
  assert.equal(seeded.conflictEscalated, true);
  assert.equal(seeded.conflictEscalatedAt, null);

  const first = decide({ session, mark: seeded });
  assert.equal(first.kind, "escalate", "an unsent seeded mark sends once, which the daemon already holds");
  if (first.kind !== "escalate") return;
  assert.equal(first.resend, true);
  const after = pass(session, first.mark, NOW + 10_000);
  assert.equal(after.d.kind, "skip");
});

test("push, then UNKNOWN, then resolved: no nudge, no cap increment, no give-up while the new head is unknown", () => {
  const nudged = pass(conflictingOn("A"), null).mark;
  // Head B pushed; GitHub has not answered for it. The kept observation stays on A.
  const unknownB = mkSession({
    prMergeable: { state: "conflicting", headSha: "A" },
    prHeadSha: "B",
    prBaseRef: "main",
    lastActivity: NOW,
  });
  for (const at of [NOW + MIN, NOW + 5 * MIN, NOW + 30 * MIN]) {
    const r = pass(unknownB, nudged, at);
    assert.equal(r.d.kind, "skip", `still unknown at +${(at - NOW) / MIN}m`);
    assert.deepEqual(r.mark, nudged, "the mark is untouched");
  }

  const mergeableB = mkSession({ prMergeable: { state: "mergeable", headSha: "B" }, prHeadSha: "B", prBaseRef: "main" });
  const resolved = pass(mergeableB, nudged, NOW + 31 * MIN);
  assert.equal(resolved.d.kind, "skip");
  assert.equal(resolved.mark.conflictHead, null, "re-armed once B is mergeable");
  assert.equal(resolved.mark.conflictNudges, 0);
});

test("trackMergeConflicts off neither nudges nor escalates a conflict", () => {
  const cfg = { trackReviewComments: true, trackCiFailures: true, trackMergeConflicts: false, settleMs: SETTLE };
  assert.equal(pass(conflictingOn("A"), null, NOW, { cfg }).d.kind, "skip");
  const escalated: FollowupMark = { ...observe(conflictingOn("A")), conflictEscalated: true };
  assert.equal(pass(conflictingOn("A"), escalated, NOW, { cfg }).d.kind, "skip");
});

test("an active workflow owns its session's conflict: no nudge and no escalation", () => {
  const escalated: FollowupMark = { ...observe(conflictingOn("A")), conflictEscalated: true };
  assert.deepEqual(pass(conflictingOn("A"), escalated, NOW, { workflowOwnsSession: true }).d, {
    kind: "skip",
    why: "an active workflow owns this session",
  });
});

test("a conflict shares one payload with CI and findings; an escalated one is left out", () => {
  const all = pass(conflictingOn("A", { prChecks: "failing", inspector: inspector({ open: 2 }) }), null);
  assert.equal(all.d.kind, "nudge");
  if (all.d.kind !== "nudge") return;
  assert.match(all.d.payload, /2 unresolved review comments on it, and its CI checks are failing, and it has merge conflicts with `main`/);

  const owned = conflictingOn("A", { prChecks: "failing", prConflictEscalated: true });
  const ciOnly = pass(owned, null);
  assert.equal(ciOnly.d.kind, "escalate", "the seeded mark's one send comes first");
  const next = pass(owned, ciOnly.mark, NOW + 1);
  assert.equal(next.d.kind, "nudge");
  if (next.d.kind !== "nudge") return;
  assert.match(next.d.payload, /CI checks are failing/);
  assert.doesNotMatch(next.d.payload, /merge conflicts/);
});
