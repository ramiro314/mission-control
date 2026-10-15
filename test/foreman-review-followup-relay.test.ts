import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForemanConfig, InspectorFindingsResponse } from "../src/shared/protocol.ts";
import type { InspectorComment, InspectorSummary, Session } from "../src/shared/types.ts";
import { WORKFLOW_RUN_STATUSES } from "../src/shared/workflow.ts";

// What is at stake: the worker half of the findings relay, driven through the real pass. The
// decision core says a nudge includes findings; `runReviewFollowup` reads their text through
// the daemon and types it. Two things can go wrong in that read, and both are pinned here:
//
//  - it fails, and a round stamped anyway would never be relayed, so the session would never
//    hear about a finding that exists only in Mission Control;
//  - it takes time, and anything the pass observed before it may be stale after it. The
//    session can start working, need a human or gain a workflow, and the Inspector can finish
//    a round. Gates decided on the pre-read snapshot would type across all of that.

// Isolate state before the worker's imports can resolve a home.
const home = mkdtempSync(join(tmpdir(), "mission-foreman-review-relay-"));
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { runReviewFollowup } = await import("../src/server/foreman/worker.ts");
const { ForemanClient } = await import("../src/server/foreman/client.ts");
const { InjectError } = await import("../src/server/foreman/queue-apply.ts");
const { mkSession } = await import("./helpers/session-fixture.ts");

type Client = InstanceType<typeof ForemanClient>;

const REPO = "/work/alpha";
const PR_URL = "https://github.com/owner/repo/pull/7";
const KEY = "owner/repo#7";
const LEADER = () => true;

const CFG = {
  enabled: true,
  mode: "live",
  repoAllowlist: [REPO],
  trackReviewFeedback: true,
  trackCiFailures: true,
  trackMergeConflicts: true,
} as ForemanConfig;

function summary(over: Partial<InspectorSummary> = {}): InspectorSummary {
  return {
    prKey: KEY,
    url: PR_URL,
    mode: "dry-run",
    open: 1,
    postedOpen: 0,
    round: 3,
    lastReviewedAt: Date.now() - 60_000,
    failed: false,
    ...over,
  };
}

/** A draft the Inspector wrote in dry run: on no pull request, so only the relay carries it. */
function draft(over: Partial<InspectorComment> = {}): InspectorComment {
  return {
    id: "c1",
    prKey: KEY,
    fingerprint: "fp-draft",
    path: "src/a.ts",
    line: 12,
    title: "Null check missing",
    body: "The handler dereferences `user` before checking it.",
    severity: "major",
    round: 3,
    status: "drafted",
    replies: 0,
    answeredCommentId: null,
    postedAt: null,
    githubUrl: null,
    legacyPosted: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** Parked on an open PR whose Inspector holds one dry-run draft: the case this ticket opens. */
function parked(id: string, over: Partial<Session> = {}): Session {
  return mkSession({
    id,
    name: id,
    agentSessionId: `agent-${id}`,
    state: "idle",
    cwd: REPO,
    repoRoot: REPO,
    lastActivity: Date.now() - 60_000,
    prUrl: PR_URL,
    prNumber: 7,
    prState: "open",
    inspector: summary(),
    ...over,
  });
}

/** The route's answer, which names the Inspector round it read. */
function response(findings: InspectorComment[], round = 3): InspectorFindingsResponse {
  return { pr: { round } as InspectorFindingsResponse["pr"], findings };
}

/**
 * A daemon whose answers can change once the findings have been read, which is the window
 * the pass has to survive. `calls` records the order the worker asked in.
 */
function fakeDaemon(opts: {
  sessions: (afterRead: boolean) => Session[];
  findings: () => Promise<InspectorFindingsResponse>;
  workflowRuns?: (afterRead: boolean) => Array<{ status: string }>;
  inject?: () => Promise<void>;
}) {
  let afterRead = false;
  const calls: string[] = [];
  const injected: Array<{ id: string; text: string }> = [];
  const client = {
    sessions: async () => {
      calls.push("sessions");
      return opts.sessions(afterRead);
    },
    getConfig: async () => CFG,
    workflowRuns: async () => {
      calls.push("workflowRuns");
      return opts.workflowRuns?.(afterRead) ?? [];
    },
    inspectorFindings: async (prKey: string) => {
      calls.push(`findings:${prKey}`);
      try {
        return await opts.findings();
      } finally {
        afterRead = true;
      }
    },
    inject: async (id: string, text: string) => {
      calls.push("inject");
      injected.push({ id, text });
      await (opts.inject ?? (async () => {}))();
    },
  } as unknown as Client;
  return { client, calls, injected };
}

test("a dry-run draft is read through the daemon, then the fleet is re-read, then it is typed", async () => {
  const fake = fakeDaemon({ sessions: () => [parked("draft")], findings: async () => response([draft()]) });
  const claimed = await runReviewFollowup(fake.client, CFG, LEADER);

  assert.deepEqual([...claimed], ["draft"]);
  // The read comes before the freshness recheck, so nothing but the inject follows the recheck.
  assert.deepEqual(fake.calls, [
    "sessions",
    "workflowRuns",
    `findings:${KEY}`,
    "sessions",
    "workflowRuns",
    "inject",
  ]);
  const { id, text } = fake.injected[0]!;
  assert.equal(id, "draft");
  assert.match(text, /^PR #7 needs follow-through: GitHub Inspector has 1 unresolved finding on it \(0 posted on GitHub, 1 not posted\)\./);
  assert.match(text, /## MAJOR - Null check missing/);
  assert.match(text, /Not posted on GitHub\. This message is the only copy\./);
  assert.match(text, /The handler dereferences `user` before checking it\./);
  assert.doesNotMatch(text, /gh pr view/);

  // The round was stamped: the same round is not relayed again.
  const again = fakeDaemon({ sessions: () => [parked("draft")], findings: async () => response([draft()]) });
  assert.equal((await runReviewFollowup(again.client, CFG, LEADER)).size, 0);
  assert.deepEqual(again.injected, []);
});

test("a session that starts working during the read is not typed into, and the round stays unrelayed", async () => {
  let working = true;
  const fake = fakeDaemon({
    sessions: (afterRead) => [parked("busy", afterRead && working ? { state: "working", lastActivity: Date.now() } : {})],
    findings: async () => response([draft()]),
  });
  assert.equal((await runReviewFollowup(fake.client, CFG, LEADER)).size, 0);
  assert.deepEqual(fake.injected, [], "the post-read snapshot says working");

  // It parks again: the round was never stamped, so it is relayed now.
  working = false;
  const later = fakeDaemon({ sessions: () => [parked("busy")], findings: async () => response([draft()]) });
  assert.equal((await runReviewFollowup(later.client, CFG, LEADER)).size, 1);
  assert.equal(later.injected.length, 1);
});

test("a session that comes to need a human, or gains a workflow, during the read is left alone", async () => {
  const needsYou = fakeDaemon({
    sessions: (afterRead) => [parked("asks", afterRead ? { state: "awaiting_input" } : {})],
    findings: async () => response([draft()]),
  });
  assert.equal((await runReviewFollowup(needsYou.client, CFG, LEADER)).size, 0);
  assert.deepEqual(needsYou.injected, []);

  const active = WORKFLOW_RUN_STATUSES.find((s) => !["completed", "cancelled", "failed"].includes(s));
  assert.ok(active);
  const owned = fakeDaemon({
    sessions: () => [parked("owned")],
    workflowRuns: (afterRead) => (afterRead ? [{ status: active }] : []),
    findings: async () => response([draft()]),
  });
  assert.equal((await runReviewFollowup(owned.client, CFG, LEADER)).size, 0);
  assert.deepEqual(owned.injected, []);
});

test("an Inspector round that finishes during the read is held, then relayed exactly once", async () => {
  // The snapshot still says round 3; the route already answers for round 4. Typing would
  // stamp round 3 with round 4's findings, and the next pass would relay round 4 again.
  const raced = fakeDaemon({
    sessions: () => [parked("race")],
    findings: async () => response([draft({ round: 4 })], 4),
  });
  assert.equal((await runReviewFollowup(raced.client, CFG, LEADER)).size, 0);
  assert.deepEqual(raced.injected, []);

  const caughtUp = () => [parked("race", { inspector: summary({ round: 4 }) })];
  const next = fakeDaemon({ sessions: caughtUp, findings: async () => response([draft({ round: 4 })], 4) });
  assert.equal((await runReviewFollowup(next.client, CFG, LEADER)).size, 1);
  assert.equal(next.injected.length, 1);

  const after = fakeDaemon({ sessions: caughtUp, findings: async () => response([draft({ round: 4 })], 4) });
  assert.equal((await runReviewFollowup(after.client, CFG, LEADER)).size, 0);
  assert.deepEqual(after.injected, [], "round 4 is relayed once");
});

test("a failed read is held: nothing typed, no stamp, and the next pass relays", async () => {
  const failed = fakeDaemon({
    sessions: () => [parked("flaky")],
    findings: async () => Promise.reject(new Error("GET /api/inspector/findings -> 503")),
  });
  assert.equal((await runReviewFollowup(failed.client, CFG, LEADER)).size, 0);
  assert.deepEqual(failed.injected, []);
  assert.deepEqual(failed.calls, ["sessions", "workflowRuns", `findings:${KEY}`], "no recheck, no inject");

  // A shape the client's schema refused throws the same way.
  const unparsed = fakeDaemon({
    sessions: () => [parked("flaky")],
    findings: async () => Promise.reject(new Error("Expected array, received null")),
  });
  assert.equal((await runReviewFollowup(unparsed.client, CFG, LEADER)).size, 0);
  assert.deepEqual(unparsed.injected, []);

  const retry = fakeDaemon({ sessions: () => [parked("flaky")], findings: async () => response([draft()]) });
  assert.equal((await runReviewFollowup(retry.client, CFG, LEADER)).size, 1);
  assert.equal(retry.injected.length, 1, "round 3 was never recorded as relayed");
});

test("findings resolved before the read: nothing else open, so the pass skips without stamping", async () => {
  const fake = fakeDaemon({
    sessions: () => [parked("resolved")],
    findings: async () => response([draft({ status: "resolved" })]),
  });
  assert.equal((await runReviewFollowup(fake.client, CFG, LEADER)).size, 0);
  assert.deepEqual(fake.injected, []);
});

test("findings resolved before the read, CI still red: the CI half goes out alone", async () => {
  const fake = fakeDaemon({
    sessions: () => [parked("red", { prChecks: "failing" })],
    findings: async () => response([]),
  });
  assert.equal((await runReviewFollowup(fake.client, CFG, LEADER)).size, 1);
  const text = fake.injected[0]!.text;
  assert.match(text, /^PR #7 needs follow-through: its CI checks are failing\./);
  assert.doesNotMatch(text, /unresolved finding/);
});

test("a nudge without findings types with no read", async () => {
  const fake = fakeDaemon({
    sessions: () => [parked("ci", { inspector: summary({ open: 0 }), prChecks: "failing" })],
    findings: async () => assert.fail("no findings to read"),
  });
  assert.equal((await runReviewFollowup(fake.client, CFG, LEADER)).size, 1);
  assert.ok(!fake.calls.some((call) => call.startsWith("findings:")));
});

test("a delivery the daemon refused frees the pane and leaves the round to retry", async () => {
  const refused = fakeDaemon({
    sessions: () => [parked("gone")],
    findings: async () => response([draft()]),
    inject: async () => Promise.reject(new InjectError("pane gone", false)),
  });
  assert.equal((await runReviewFollowup(refused.client, CFG, LEADER)).size, 0);

  const retry = fakeDaemon({ sessions: () => [parked("gone")], findings: async () => response([draft()]) });
  assert.equal((await runReviewFollowup(retry.client, CFG, LEADER)).size, 1);
  assert.equal(retry.injected.length, 1);
});

test("a worker that lost the lease types nothing", async () => {
  const fake = fakeDaemon({ sessions: () => [parked("follower")], findings: async () => response([draft()]) });
  assert.equal((await runReviewFollowup(fake.client, CFG, () => false)).size, 0);
  assert.deepEqual(fake.injected, []);
});
