import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A real app for the route half, so the state home is set before anything resolves it.
process.env.MISSION_HOME = mkdtempSync(join(tmpdir(), "mission-foreman-decision-draft-"));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { draftFromVerdict, verifyDraftProvenance } = await import("../src/server/foreman/decision-draft.ts");
const { classifyPending } = await import("../src/server/foreman/pending.ts");
const { tier0 } = await import("../src/server/foreman/triage.ts");
const { planFromVerdict } = await import("../src/server/foreman/verdict.ts");
const { formatResponse } = await import("../src/shared/review-item.ts");
const { DecisionForm, draftedAnswers, draftAfterEdit, draftOnChange, openingDraftState } = await import(
  "../src/web/components/PlanDecisions.tsx"
);
import type { Verdict } from "../src/server/foreman/verdict.ts";
import type { PlanDecision, PlanDecisionAnswer, ReviewItem, Session } from "../src/shared/types.ts";

const decisions: PlanDecision[] = [
  {
    id: "store",
    question: "Where should sessions live?",
    options: [
      { id: "redis", label: "Use Redis" },
      { id: "pg", label: "Postgres table", recommended: true },
    ],
  },
  {
    id: "providers",
    question: "Which providers ship first?",
    multiSelect: true,
    allowOther: true,
    options: [
      { id: "google", label: "Google", recommended: true },
      { id: "github", label: "GitHub" },
    ],
  },
  {
    id: "rollout",
    question: "How should it roll out?",
    options: [
      { id: "flag", label: "Behind a flag", recommended: true },
      { id: "all", label: "Everyone at once" },
    ],
  },
];

function answer(form: Record<string, string | string[]>, text = "Redis keeps it simple."): Verdict {
  return {
    purpose: "Choosing the session store for the auth refactor.",
    classification: "design-fork",
    action: "answer",
    answer: { text, submit: true, form: { answers: form } },
  };
}

// ---- the verdict -> draft mapping ----

test("labels select options, own words become Other, and unmentioned decisions are left out", () => {
  const draft = draftFromVerdict(decisions, {
    form: {
      answers: {
        "Where should sessions live?": "use redis",
        // Folded match on the question, a label array, and words no option offers.
        "which providers ship first?": ["GitHub", "Okta via SAML"],
      },
    },
  });
  assert.deepEqual(draft, [
    { decisionId: "store", selected: ["redis"], other: null },
    { decisionId: "providers", selected: ["github"], other: "Okta via SAML" },
  ]);
});

test("a single choice keeps the first option named, and own words need an Other field", () => {
  const draft = draftFromVerdict(decisions, {
    form: {
      answers: {
        "Where should sessions live?": ["Postgres table", "Use Redis"],
        // `rollout` accepts no Other, so free text there has nowhere to go.
        "How should it roll out?": "Ship it on Tuesday",
      },
    },
  });
  assert.deepEqual(draft, [{ decisionId: "store", selected: ["pg"], other: null }]);
});

test("own words alone select nothing, so Other replaces the choice", () => {
  assert.deepEqual(
    draftFromVerdict(decisions, { form: { answers: { providers: "Okta only" } } }),
    [{ decisionId: "providers", selected: [], other: "Okta only" }],
  );
});

test("an answer with no usable form leaves no draft", () => {
  assert.equal(draftFromVerdict(decisions, undefined), null);
  assert.equal(draftFromVerdict(decisions, { form: { answers: {} } }), null);
  assert.equal(
    draftFromVerdict(decisions, { form: { answers: { "Some other question": "Use Redis" } } }),
    null,
  );
});

// ---- the verdict -> note plan ----

const ctx = {
  sessionId: "s1",
  promptMarker: "review:r1",
  inputReviewId: null,
  canSend: false,
  planDecisions: decisions,
};

test("an answer on a plan-decisions form is a draft and never a send, even live", () => {
  // `mayActLive` true: the live, allowlisted mode that sends everywhere else.
  const plan = planFromVerdict(answer({ "Where should sessions live?": "Use Redis" }), ctx, true);
  assert.equal(plan.send, null);
  assert.equal(plan.note.disposition, "pending");
  assert.equal(plan.note.handledMarker, "review:r1");
  assert.equal(plan.note.recommendation, "Redis keeps it simple.");
  assert.deepEqual(plan.note.draft, [{ decisionId: "store", selected: ["redis"], other: null }]);
  assert.match(plan.note.lastAction ?? "", /drafted answers on the decision form/);
});

test("escalating or skipping a plan-decisions form carries no draft", () => {
  const escalate: Verdict = {
    purpose: "p",
    classification: "intent-unclear",
    action: "escalate",
    recommendation: "Use Redis",
  };
  const skip: Verdict = { purpose: "p", classification: "other", action: "skip" };
  assert.equal(planFromVerdict(escalate, ctx, true).note.draft, null);
  assert.equal(planFromVerdict(skip, ctx, true).note.draft, null);
  // And a note about any other kind of ask does not mention a draft at all.
  assert.equal("draft" in planFromVerdict(skip, { ...ctx, planDecisions: null }, true).note, false);
});

// ---- classification ----

function review(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "r1",
    sessionId: "s1",
    kind: "plan-decisions",
    title: "Session storage plan",
    body: "Store sessions somewhere durable.",
    status: "pending",
    response: null,
    decisions,
    createdAt: 1,
    resolvedAt: null,
    ...over,
  };
}

test("a pending plan-decisions review routes to the full reviewer as a draft-only ask", () => {
  const pending = classifyPending({ id: "s1" } as Session, [review()]);
  assert.equal(pending.situation, "plan-decisions-review");
  assert.equal(pending.inputReviewId, null, "never a delivery channel");
  assert.equal(pending.canSend, false);
  assert.equal(pending.marker, "review:r1");
  assert.deepEqual(pending.decisions, decisions);
  assert.match(pending.question, /Postgres table \(the agent's recommendation\)/);
  assert.match(pending.question, /You CANNOT submit this form/);
  assert.deepEqual(tier0(pending), { kind: "route-up", reason: "plan-decisions-draft" });
  // A plain plan review is still purpose-only.
  const plain = classifyPending({ id: "s1" } as Session, [review({ kind: "plan", decisions: null })]);
  assert.equal(plain.situation, "non-input-review");
});

// ---- provenance in the answer ----

test("accepted Foreman Other text is marked in the response the agent reads", () => {
  const text = formatResponse(
    decisions,
    [
      { decisionId: "store", selected: ["pg"], other: null },
      { decisionId: "providers", selected: ["google"], other: "Okta via SAML", foremanDraftAccepted: true },
      { decisionId: "rollout", selected: ["flag"], other: null },
    ],
    "Plan decisions submitted:",
  );
  assert.match(text, /Other: Okta via SAML \(Foreman draft, accepted\)/);
});

// ---- the form ----

const DRAFT = [{ decisionId: "providers", selected: ["github"], other: "Okta via SAML" }];

test("the form opens on Foreman's draft, names it, and offers the revert", () => {
  const answers = draftedAnswers(decisions, DRAFT);
  // The drafted decision changes; the others keep the agent's recommendation.
  assert.deepEqual(answers.providers, { selected: ["github"], other: "Okta via SAML" });
  assert.deepEqual(answers.store, { selected: ["pg"], other: "" });

  const html = renderToStaticMarkup(
    createElement(DecisionForm, { decisions, busy: false, onSubmit: () => {}, foremanDraft: DRAFT }),
  );
  assert.match(html, /Foreman&#x27;s draft/);
  assert.match(html, />Revert to recommendation</);
  assert.match(html, /value="Okta via SAML"/);
  assert.match(html, /Other: Okta via SAML \(Foreman&#x27;s draft\)/);
});

test("a form with no draft shows no Foreman draft", () => {
  const html = renderToStaticMarkup(
    createElement(DecisionForm, { decisions, busy: false, onSubmit: () => {} }),
  );
  assert.doesNotMatch(html, /Foreman&#x27;s draft/);
  assert.doesNotMatch(html, /Revert to recommendation/);
});

// ---- the daemon's boundaries ----

openDb();
const TOKEN = ensureToken();
const registry = new Registry();
const reviews = new ReviewManager(registry);
const app = buildApp({
  registry,
  reviews,
  tasks: new TaskManager(registry),
  queues: new QueueManager(registry),
});
const LOOPBACK = { host: "127.0.0.1:7317" };
const authed = { ...LOOPBACK, "content-type": "application/json", "x-harness-token": TOKEN };

async function ask(sessionId: string, cwd: string): Promise<string> {
  const res = await app.request("/mcp/reviews", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({
      env: {},
      sessionId,
      cwd,
      kind: "plan-decisions",
      title: "Session storage plan",
      body: "# Plan",
      decisions,
    }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return ((await res.json()) as { id: string }).id;
}

async function putNote(sessionId: string, body: unknown): Promise<Response> {
  return app.request(`/api/sessions/${encodeURIComponent(sessionId)}/note`, {
    method: "PUT",
    headers: { ...LOOPBACK, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function resolve(id: string, body: unknown): Promise<Response> {
  return app.request(`/api/reviews/${id}/resolve`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify(body),
  });
}

test("Foreman cannot resolve a plan-decisions review by any action", async () => {
  const id = "sdk:draft-refuse";
  registry.registerSdkSession({ id, agent: "claude", name: "refuse", cwd: "/repo/refuse" });
  const reviewId = await ask(id, "/repo/refuse");
  for (const action of ["answer", "approve", "dismiss"]) {
    const res = await resolve(reviewId, { action, response: "Use Redis", by: "foreman" });
    assert.equal(res.status, 400, `Foreman ${action} is refused`);
  }
  assert.equal(registry.getReview(reviewId)?.status, "pending", "the review is still the human's");
});

test("a draft is shown only in an invited session, and your answer retires it", async () => {
  const id = "sdk:draft-invited";
  registry.registerSdkSession({ id, agent: "claude", name: "invited", cwd: "/repo/invited" });
  const reviewId = await ask(id, "/repo/invited");
  const note = {
    purpose: "Choosing the session store.",
    recommendation: "Use Redis.",
    disposition: "pending",
    handledMarker: `review:${reviewId}`,
    draft: DRAFT,
  };
  assert.equal((await putNote(id, note)).status, 200);
  assert.deepEqual(registry.getSession(id)?.note?.draft, DRAFT, "an invited session shows the draft");

  // Withdrawn: the stored draft is hidden, and a new one is refused.
  registry.withdrawForemanInvite(id);
  assert.equal(registry.getSession(id)?.note?.draft ?? null, null);
  assert.equal((await putNote(id, note)).status, 403);
  registry.inviteForeman(id);
  assert.deepEqual(registry.getSession(id)?.note?.draft, DRAFT);

  // The human submits with Foreman's Other text in place; the record keeps the provenance.
  const selections: PlanDecisionAnswer[] = [
    { decisionId: "store", selected: ["pg"], other: null },
    { decisionId: "providers", selected: ["github"], other: "Okta via SAML", foremanDraftAccepted: true },
    { decisionId: "rollout", selected: ["flag"], other: null },
  ];
  const res = await resolve(reviewId, {
    action: "answer",
    response: formatResponse(decisions, selections, "Plan decisions submitted:"),
    selections,
  });
  assert.equal(res.status, 200);
  const settled = registry.getReview(reviewId);
  assert.equal(settled?.selections?.[1]?.foremanDraftAccepted, true);
  assert.match(settled?.response ?? "", /\(Foreman draft, accepted\)/);
  const retired = registry.getSession(id)?.note;
  assert.equal(retired?.disposition, "skipped");
  assert.equal(retired?.draft ?? null, null, "the draft is spent with the question");
});

test("a note moving to another ask drops the old draft unless it brings its own", async () => {
  const id = "sdk:draft-marker-move";
  registry.registerSdkSession({ id, agent: "claude", name: "move", cwd: "/repo/move" });
  const reviewId = await ask(id, "/repo/move");
  const marker = `review:${reviewId}`;
  assert.equal(
    (await putNote(id, { disposition: "pending", handledMarker: marker, draft: DRAFT })).status,
    200,
  );

  // Same ask, no draft in the patch: a purpose-only update keeps the draft.
  assert.equal((await putNote(id, { purpose: "Still choosing the store." })).status, 200);
  assert.deepEqual(registry.getSession(id)?.note?.draft, DRAFT);
  assert.equal((await putNote(id, { handledMarker: marker, disposition: "pending" })).status, 200);
  assert.deepEqual(registry.getSession(id)?.note?.draft, DRAFT, "restating the same marker keeps it");

  // A different ask, no draft of its own: the old draft must not ride along onto it.
  assert.equal(
    (await putNote(id, { handledMarker: "state:awaiting_input:7", disposition: "escalated" })).status,
    200,
  );
  assert.equal(registry.getNote(id)?.draft ?? null, null);
  assert.equal(registry.getSession(id)?.note?.draft ?? null, null);
});

// ---- the daemon decides provenance ----

test("provenance is decided from the held draft, not from the caller's flag", () => {
  const draft = [{ decisionId: "providers", selected: ["github"], other: "Okta via SAML" }];
  const honest = [{ decisionId: "providers", selected: ["github"], other: "Okta via SAML", foremanDraftAccepted: true as const }];
  assert.equal(verifyDraftProvenance(honest, draft), honest, "an honest claim is kept as-is");
  // Forged: no draft at all, or a draft that said something else.
  assert.deepEqual(verifyDraftProvenance(honest, null), [
    { decisionId: "providers", selected: ["github"], other: "Okta via SAML" },
  ]);
  const edited = [{ ...honest[0]!, other: "Okta via OIDC" }];
  assert.equal(verifyDraftProvenance(edited, draft)[0]?.foremanDraftAccepted, undefined);
  // Unclaimed but word for word Foreman's: the mark is added.
  const unclaimed = [{ decisionId: "providers", selected: ["github"], other: " Okta via SAML " }];
  assert.equal(verifyDraftProvenance(unclaimed, draft)[0]?.foremanDraftAccepted, true);
});

test("the resolve route strips a forged mark and adds a missing one", async () => {
  const id = "sdk:draft-provenance";
  registry.registerSdkSession({ id, agent: "claude", name: "provenance", cwd: "/repo/provenance" });
  const lead = "Plan decisions submitted:";

  // No draft on this review: a claimed mark is dropped, from the record and the answer.
  const forgedId = await ask(id, "/repo/provenance");
  const forged: PlanDecisionAnswer[] = [
    { decisionId: "store", selected: ["pg"], other: null },
    { decisionId: "providers", selected: ["google"], other: "Okta via SAML", foremanDraftAccepted: true },
    { decisionId: "rollout", selected: ["flag"], other: null },
  ];
  assert.equal(
    (await resolve(forgedId, { action: "answer", response: formatResponse(decisions, forged, lead), selections: forged })).status,
    200,
  );
  const settledForged = registry.getReview(forgedId);
  assert.equal(settledForged?.selections?.[1]?.foremanDraftAccepted, undefined);
  assert.doesNotMatch(settledForged?.response ?? "", /Foreman draft, accepted/);
  assert.match(settledForged?.response ?? "", /Other: Okta via SAML$/m);

  // A live draft whose text the caller submitted unmarked: the daemon marks it.
  const draftedId = await ask(id, "/repo/provenance");
  assert.equal(
    (await putNote(id, { disposition: "pending", handledMarker: `review:${draftedId}`, draft: DRAFT })).status,
    200,
  );
  const unmarked: PlanDecisionAnswer[] = forged.map(({ foremanDraftAccepted: _f, ...a }) => a);
  assert.equal(
    (await resolve(draftedId, { action: "answer", response: formatResponse(decisions, unmarked, lead), selections: unmarked })).status,
    200,
  );
  const settled = registry.getReview(draftedId);
  assert.equal(settled?.selections?.[1]?.foremanDraftAccepted, true);
  assert.match(settled?.response ?? "", /Other: Okta via SAML \(Foreman draft, accepted\)/);
});

// ---- one explicit draft state on the open form ----

test("the form's draft state: applied only while untouched, set aside once you take over", () => {
  const other = [{ decisionId: "store", selected: ["redis"], other: null }];
  const none = openingDraftState(null);
  assert.deepEqual(none, { kind: "none" });

  // A draft landing on an untouched form is applied.
  const landed = draftOnChange(none, DRAFT);
  assert.equal(landed?.answers, "drafted");
  assert.equal(landed?.next.kind, "applied");
  // The same draft again is no change.
  assert.equal(draftOnChange(landed!.next, DRAFT), null);
  // A different draft replaces an untouched one.
  assert.equal(draftOnChange(landed!.next, other)?.answers, "drafted");
  // A vanished draft puts the recommendation back on an untouched form.
  assert.deepEqual(draftOnChange(landed!.next, null), { next: { kind: "none" }, answers: "recommended" });

  // Edited after it was applied: a change sets it aside and keeps your answers.
  const edited = draftAfterEdit(landed!.next);
  assert.equal(edited.kind === "applied" && edited.edited, true);
  assert.equal(draftOnChange(edited, DRAFT), null, "the banner stays for the same draft");
  assert.deepEqual(draftOnChange(edited, null), { next: { kind: "set-aside" }, answers: "kept" });
  assert.deepEqual(draftOnChange(edited, other), { next: { kind: "set-aside" }, answers: "kept" });

  // Touched before any draft arrived: the form is yours, and no draft is applied to it.
  const taken = draftAfterEdit(none);
  assert.deepEqual(taken, { kind: "set-aside" });
  assert.equal(draftOnChange(taken, DRAFT), null);
});

test("the draft gate follows the resolved invite, not the session's cached copy", async () => {
  const id = "sdk:draft-cached-invite";
  registry.registerSdkSession({ id, agent: "claude", name: "cached", cwd: "/repo/cached" });
  const reviewId = await ask(id, "/repo/cached");
  const note = { disposition: "pending", handledMarker: `review:${reviewId}`, draft: DRAFT };

  // An embedded session is invited by resolution; a stale denormalized field must not refuse it.
  const live = registry.getSession(id)!;
  (live as { foremanInvite: unknown }).foremanInvite = null;
  assert.equal(registry.foremanMayDraft(id), true);
  assert.equal((await putNote(id, note)).status, 200);
  assert.deepEqual(registry.getSession(id)?.note?.draft, DRAFT);

  // Withdrawn by resolution: refused, and hidden, whatever the cached field says.
  registry.withdrawForemanInvite(id);
  (registry.getSession(id)! as { foremanInvite: unknown }).foremanInvite = "sdk";
  assert.equal(registry.foremanMayDraft(id), false);
  assert.equal((await putNote(id, note)).status, 403);
});
