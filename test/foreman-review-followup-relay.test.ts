import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InspectorFindingsResponse } from "../src/shared/protocol.ts";
import type { InspectorComment, InspectorSummary, Session } from "../src/shared/types.ts";
import type {
  FollowupMark,
  ReviewFollowupDecision,
  ReviewFollowupInput,
} from "../src/server/foreman/review-followup.ts";

// What is at stake: the worker half of the findings relay. The decision core says a nudge
// includes findings; `relayReviewFollowup` is what reads their text through the daemon and
// types it, and what holds - no stamp, nothing typed - when that read cannot be trusted. A
// round stamped on a failed read would never be relayed, and the session would never hear
// about a finding that exists only in Mission Control.

// Isolate state before the worker's imports can resolve a home.
const home = mkdtempSync(join(tmpdir(), "mission-foreman-review-relay-"));
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { relayReviewFollowup } = await import("../src/server/foreman/worker.ts");
const { ForemanClient } = await import("../src/server/foreman/client.ts");
const { InjectError } = await import("../src/server/foreman/queue-apply.ts");
const { decideReviewFollowup, followupPrs } = await import("../src/server/foreman/review-followup.ts");
const { mkSession } = await import("./helpers/session-fixture.ts");

type Client = InstanceType<typeof ForemanClient>;

const NOW = 10_000_000;
const KEY = "owner/repo#7";
const PR_URL = "https://github.com/owner/repo/pull/7";

function summary(over: Partial<InspectorSummary> = {}): InspectorSummary {
  return {
    prKey: KEY,
    url: PR_URL,
    mode: "dry-run",
    open: 1,
    postedOpen: 0,
    round: 3,
    lastReviewedAt: NOW - 60_000,
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
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    ...over,
  };
}

/** Parked on an open PR whose Inspector holds one dry-run draft: the case this ticket opens. */
function parked(over: Partial<Session> = {}): Session {
  return mkSession({
    id: "s1",
    name: "atlas",
    state: "idle",
    lastActivity: NOW - 60_000,
    prUrl: PR_URL,
    prNumber: 7,
    prState: "open",
    inspector: summary(),
    ...over,
  });
}

function input(session: Session): ReviewFollowupInput {
  return {
    session,
    pr: followupPrs(session)[0] ?? null,
    bucket: "idle",
    mayActLive: true,
    workflowOwnsSession: false,
    mark: null,
    cfg: { trackReviewComments: true, trackCiFailures: true, trackMergeConflicts: true, settleMs: 10_000 },
    now: NOW,
  };
}

/** A client that records what the worker asked of it. */
function fakeClient(opts: {
  findings: () => Promise<InspectorFindingsResponse>;
  inject?: () => Promise<void>;
}) {
  const reads: string[] = [];
  const injected: Array<{ id: string; text: string }> = [];
  const client = {
    inspectorFindings: async (prKey: string) => {
      reads.push(prKey);
      return opts.findings();
    },
    inject: async (id: string, text: string) => {
      injected.push({ id, text });
      await (opts.inject ?? (async () => {}))();
    },
  } as unknown as Client;
  return { client, reads, injected };
}

function response(findings: InspectorComment[]): InspectorFindingsResponse {
  // The relay reads only `findings`; the inspection row beside them is the modal's.
  return { pr: {} as InspectorFindingsResponse["pr"], findings };
}

/** Run the relay the way `runReviewFollowup` does after its freshness recheck. */
async function relay(session: Session, client: Client, marks = new Map<string, FollowupMark>()) {
  const base = input(session);
  const decision = decideReviewFollowup(base);
  assert.ok(decision.kind === "nudge" || decision.kind === "read-findings", decision.kind);
  const outcome = await relayReviewFollowup(
    client,
    session,
    marks,
    decision as Extract<ReviewFollowupDecision, { kind: "nudge" | "read-findings" }>,
    (findings) => decideReviewFollowup({ ...base, findings }),
    () => true,
  );
  return { decision, outcome, marks };
}

test("a dry-run draft is read through the daemon and typed, marked not posted", async () => {
  const fake = fakeClient({ findings: async () => response([draft()]) });
  const { decision, outcome, marks } = await relay(parked(), fake.client);

  assert.equal(decision.kind, "read-findings", "the decision asks for the text before typing");
  assert.deepEqual(fake.reads, [KEY]);
  assert.equal(outcome, "claimed");
  assert.equal(fake.injected.length, 1);
  const { id, text } = fake.injected[0]!;
  assert.equal(id, "s1");
  assert.match(text, /^PR #7 needs follow-through: GitHub Inspector has 1 unresolved finding on it \(0 posted on GitHub, 1 not posted\)\./);
  assert.match(text, /## MAJOR - Null check missing/);
  assert.match(text, /Not posted on GitHub\. This message is the only copy\./);
  assert.match(text, /The handler dereferences `user` before checking it\./);
  assert.doesNotMatch(text, /gh pr view/);
  assert.equal(marks.get(KEY)?.findingsRound, 3, "the round is stamped once the relay lands");
});

test("a failed read is held: no stamp and nothing typed, so the next pass reads again", async () => {
  const fake = fakeClient({ findings: async () => Promise.reject(new Error("GET /api/inspector/findings -> 503")) });
  const prior: FollowupMark = {
    prKey: KEY,
    findingsRound: 2,
    ciNudged: false,
    conflictHead: null,
    conflictNudges: 0,
    conflictNudgedAt: null,
    conflictEscalated: false,
    conflictEscalatedAt: null,
  };
  const marks = new Map([[KEY, prior]]);
  const { outcome } = await relay(parked(), fake.client, marks);

  assert.equal(outcome, "free", "nothing reached the pane");
  assert.deepEqual(fake.injected, []);
  assert.deepEqual(marks.get(KEY), prior, "round 3 is not recorded as relayed");

  // The next pass, with the daemon answering again, relays round 3.
  const retry = fakeClient({ findings: async () => response([draft()]) });
  const again = await relay(parked(), retry.client, marks);
  assert.equal(again.outcome, "claimed");
  assert.equal(retry.injected.length, 1);
  assert.equal(marks.get(KEY)?.findingsRound, 3);
});

test("a response the client cannot parse is a failed read too", async () => {
  // `inspectorFindings` parses with the shared schema and throws on a shape it cannot vouch
  // for; the relay treats that exactly like a lost request.
  const fake = fakeClient({ findings: async () => Promise.reject(new Error("Expected array, received null")) });
  const { outcome, marks } = await relay(parked(), fake.client);
  assert.equal(outcome, "free");
  assert.deepEqual(fake.injected, []);
  assert.equal(marks.size, 0);
});

test("findings resolved before the read: nothing else open, so the pass skips without stamping", async () => {
  const fake = fakeClient({ findings: async () => response([draft({ status: "resolved" })]) });
  const { outcome, marks } = await relay(parked(), fake.client);
  assert.equal(outcome, "free");
  assert.deepEqual(fake.injected, []);
  assert.equal(marks.size, 0);
});

test("findings resolved before the read, CI still red: the CI half goes out alone", async () => {
  const fake = fakeClient({ findings: async () => response([]) });
  const { outcome, marks } = await relay(parked({ prChecks: "failing" }), fake.client);
  assert.equal(outcome, "claimed");
  assert.equal(fake.injected.length, 1);
  const text = fake.injected[0]!.text;
  assert.match(text, /^PR #7 needs follow-through: its CI checks are failing\./);
  assert.doesNotMatch(text, /unresolved finding/);
  assert.equal(marks.get(KEY)?.findingsRound, null, "the findings round was not relayed");
  assert.equal(marks.get(KEY)?.ciNudged, true);
});

test("a nudge without findings types straight away, with no read", async () => {
  const fake = fakeClient({ findings: async () => assert.fail("no findings to read") });
  const { decision, outcome } = await relay(
    parked({ inspector: summary({ open: 0 }), prChecks: "failing" }),
    fake.client,
  );
  assert.equal(decision.kind, "nudge");
  assert.equal(outcome, "claimed");
  assert.deepEqual(fake.reads, []);
  assert.equal(fake.injected.length, 1);
});

test("a delivery the daemon refused restores the mark; one that may have landed keeps it", async () => {
  const refused = fakeClient({
    findings: async () => response([draft()]),
    inject: async () => Promise.reject(new InjectError("pane gone", false)),
  });
  const first = await relay(parked(), refused.client);
  assert.equal(first.outcome, "free");
  assert.equal(first.marks.size, 0, "no mark existed before, so none is left behind");

  const lost = fakeClient({
    findings: async () => response([draft()]),
    inject: async () => Promise.reject(new Error("socket hang up")),
  });
  const second = await relay(parked(), lost.client);
  assert.equal(second.outcome, "claimed");
  assert.equal(second.marks.get(KEY)?.findingsRound, 3, "a lost response must not become a second nudge");
});

test("a worker that lost the lease reads but types nothing and stamps nothing", async () => {
  const fake = fakeClient({ findings: async () => response([draft()]) });
  const session = parked();
  const base = input(session);
  const decision = decideReviewFollowup(base);
  assert.equal(decision.kind, "read-findings");
  const marks = new Map<string, FollowupMark>();
  const outcome = await relayReviewFollowup(
    fake.client,
    session,
    marks,
    decision as Extract<ReviewFollowupDecision, { kind: "read-findings" }>,
    (findings) => decideReviewFollowup({ ...base, findings }),
    () => false,
  );
  assert.equal(outcome, "free");
  assert.deepEqual(fake.injected, []);
  assert.equal(marks.size, 0);
});
