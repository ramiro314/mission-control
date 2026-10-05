import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordEpisode } from "../src/shared/protocol.ts";
import type { FollowupMark, ReviewFollowupDecision } from "../src/server/foreman/review-followup.ts";

// What is at stake: the worker half of Foreman's conflict escalation. The decision core
// (`decideReviewFollowup`) says WHEN to escalate; `escalateConflict` is what makes it land
// exactly once in the audit trail, stays quiet on the minute re-sends, and leaves the mark
// retryable when the daemon never heard the request.

// Isolate state before the worker's imports can resolve a home.
const home = mkdtempSync(join(tmpdir(), "mission-foreman-conflict-escalation-"));
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { escalateConflict } = await import("../src/server/foreman/worker.ts");
const { ForemanClient } = await import("../src/server/foreman/client.ts");
const { mkSession } = await import("./helpers/session-fixture.ts");

type Client = InstanceType<typeof ForemanClient>;
type Escalate = Extract<ReviewFollowupDecision, { kind: "escalate" }>;

const URL_ = "https://github.com/owner/repo/pull/7";
const KEY = "owner/repo#7";

function mark(over: Partial<FollowupMark> = {}): FollowupMark {
  return {
    prKey: KEY,
    findingsRound: null,
    ciNudged: false,
    conflictHead: "C",
    conflictNudges: 3,
    conflictNudgedAt: 1,
    conflictEscalated: false,
    conflictEscalatedAt: null,
    ...over,
  };
}

function decision(resend: boolean): Escalate {
  return {
    kind: "escalate",
    prKey: KEY,
    url: URL_,
    headSha: "D",
    mark: mark({ conflictEscalated: true, conflictEscalatedAt: 100 }),
    reason: "3 conflict nudges did not resolve it",
    resend,
  };
}

/** A client that records what the worker asked of it. `escalate` decides the route's answer. */
function fakeClient(escalate: () => Promise<boolean>) {
  const escalations: Array<[string, string]> = [];
  const episodes: Array<{ id: string; episode: RecordEpisode }> = [];
  const client = {
    escalatePrConflict: async (prUrl: string, headSha: string) => {
      escalations.push([prUrl, headSha]);
      return escalate();
    },
    recordEpisode: async (id: string, episode: RecordEpisode) => {
      episodes.push({ id, episode });
    },
  } as unknown as Client;
  return { client, escalations, episodes };
}

const session = mkSession({ id: "s1", name: "atlas" });

test("the first escalation of an episode is sent, stamped and recorded once as a pr-conflict episode", async () => {
  const fake = fakeClient(async () => true);
  const marks = new Map([[KEY, mark()]]);
  await escalateConflict(fake.client, session, marks, decision(false));

  assert.deepEqual(fake.escalations, [[URL_, "D"]]);
  assert.equal(fake.episodes.length, 1);
  const { id, episode } = fake.episodes[0]!;
  assert.equal(id, "s1");
  assert.equal(episode.situation, "pr-conflict");
  assert.equal(episode.disposition, "escalated");
  assert.equal(episode.marker, `pr-conflict:${URL_}:D`);
  assert.equal(episode.sentBy, null, "nothing was typed into the session");
  assert.deepEqual(marks.get(KEY), decision(false).mark, "the escalated mark is kept");
});

test("a re-send reaches the daemon but records no second episode", async () => {
  const fake = fakeClient(async () => true);
  const marks = new Map([[KEY, mark({ conflictEscalated: true, conflictEscalatedAt: 40 })]]);
  await escalateConflict(fake.client, session, marks, decision(true));

  assert.deepEqual(fake.escalations, [[URL_, "D"]]);
  assert.deepEqual(fake.episodes, []);
  assert.equal(marks.get(KEY)?.conflictEscalatedAt, 100, "the re-send cadence moves on");
});

test("a failed request restores the prior mark, so the next pass retries, and records nothing", async () => {
  const prior = mark();
  const fake = fakeClient(async () => {
    throw new Error("escalatePrConflict -> 500");
  });
  const marks = new Map([[KEY, prior]]);
  await escalateConflict(fake.client, session, marks, decision(false));
  assert.equal(marks.get(KEY), prior);
  assert.deepEqual(fake.episodes, []);

  const fresh = new Map<string, FollowupMark>();
  await escalateConflict(fake.client, session, fresh, decision(false));
  assert.equal(fresh.has(KEY), false, "a mark that did not exist before is not left behind");
});

// ---- the client ----

async function withDaemon<T>(
  respond: { ok: boolean; body: unknown },
  fn: () => Promise<T>,
): Promise<{ result: T; request: { url: string; init: RequestInit } }> {
  const real = globalThis.fetch;
  let request: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    request = { url, init };
    return { ok: respond.ok, status: respond.ok ? 200 : 503, json: async () => respond.body };
  }) as unknown as typeof fetch;
  try {
    const result = await fn();
    return { result, request: request! };
  } finally {
    globalThis.fetch = real;
  }
}

test("ForemanClient.escalatePrConflict posts the body and reports whether an episode was marked", async () => {
  const client = new ForemanClient();
  const marked = await withDaemon({ ok: true, body: { ok: true, escalated: true } }, () =>
    client.escalatePrConflict(URL_, "D"),
  );
  assert.equal(marked.result, true);
  assert.match(marked.request.url, /\/api\/pr-conflicts\/escalate$/);
  assert.equal(marked.request.init.method, "POST");
  assert.deepEqual(JSON.parse(String(marked.request.init.body)), { prUrl: URL_, headSha: "D" });

  const none = await withDaemon({ ok: true, body: { ok: true, escalated: false } }, () =>
    client.escalatePrConflict(URL_, "D"),
  );
  assert.equal(none.result, false);

  await assert.rejects(
    withDaemon({ ok: false, body: { error: "no tracker" } }, () => client.escalatePrConflict(URL_, "D")),
    /escalatePrConflict -> 503/,
  );
});
