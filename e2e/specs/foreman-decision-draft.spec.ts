import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Foreman drafts answers onto a plan-decisions form, and only the human sends them.
 *
 * In a session Foreman is invited into, its note for a `plan-decisions` review may carry a
 * draft: changed selections and a suggestion in "Other". The form opens on that draft, says
 * it is Foreman's, and offers a one-click revert to the agent's recommendation. Submitting
 * with Foreman's Other text still in place marks it "Foreman draft, accepted" in the answer
 * the agent reads and in the conversation record.
 *
 * The note is SEEDED through `PUT /api/sessions/:id/note`, the route the worker's `putNote`
 * uses, rather than produced by a real Foreman pass - that would spend a model call. The
 * verdict -> draft mapping that produces it is pinned in `test/foreman-decision-draft.test.ts`.
 */

const TASK = "choose the session store";
const FOREMAN_OTHER = "Okta via SAML";
const EVIDENCE = artifactsDir("foreman-decision-draft");

const DECISIONS = [
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
];

/** Foreman moves the store to Redis and suggests its own provider. */
const DRAFT = [
  { decisionId: "store", selected: ["redis"], other: null },
  { decisionId: "providers", selected: ["google"], other: FOREMAN_OTHER },
];

async function shoot(page: Page, name: string, target: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/foreman-decision-draft/${name}.png`);
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(1);
}

function token(daemon: DaemonHandle): string {
  return readFileSync(join(daemon.home, "token"), "utf8").trim();
}

/**
 * The dispatched (so invited) session, once it has bound its agent id. A note is keyed by the
 * agent's id after the bind, so a note pinned before it would be written under a stale key -
 * see the same wait in `foreman-note-retires-on-your-answer.spec.ts`.
 */
async function boundSession(daemon: DaemonHandle): Promise<{ id: string; cwd: string }> {
  let found: { id: string; cwd: string } | null = null;
  await expect
    .poll(async () => {
      const all = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{
        id: string;
        cwd: string | null;
        runtime: string;
        agentSessionId: string | null;
        foremanInvite: string | null;
      }>;
      const sdk = all.find((s) => s.runtime === "sdk");
      found = sdk?.cwd && sdk.agentSessionId && sdk.foremanInvite ? { id: sdk.id, cwd: sdk.cwd } : null;
      return found;
    })
    .toBeTruthy();
  return found!;
}

async function ask(daemon: DaemonHandle, cwd: string): Promise<string> {
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({
      env: {},
      cwd,
      kind: "plan-decisions",
      title: "Session storage plan",
      body: "Store sessions somewhere durable, then ship providers.",
      decisions: DECISIONS,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** Pin Foreman's draft the way the worker's `putNote` does. */
async function pinDraft(
  daemon: DaemonHandle,
  sessionId: string,
  reviewId: string,
  draft: unknown = DRAFT,
): Promise<number> {
  const res = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(sessionId)}/note`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      purpose: "Choosing where sessions live and which providers ship first.",
      recommendation: "Use Redis, and ship Google with Okta via SAML.",
      disposition: "pending",
      lastAction: "drafted answers on the decision form (awaiting you)",
      handledMarker: `review:${reviewId}`,
      draft,
    }),
  });
  return res.status;
}

async function answerFor(
  daemon: DaemonHandle,
  id: string,
): Promise<{ status: string; response: string | null; selections: unknown }> {
  const res = await fetch(`${daemon.baseURL}/mcp/reviews/${id}/wait`, {
    headers: { "x-harness-token": token(daemon) },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { status: string; response: string | null; selections: unknown };
}

async function openReview(dashboard: Page): Promise<Locator> {
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await dashboard.locator(".console-detail").getByRole("button", { name: /to review/ }).click();
  const modal = dashboard.locator(".review-modal");
  await expect(modal).toBeVisible();
  return modal;
}

async function setup(dashboard: Page, daemon: DaemonHandle): Promise<{ sessionId: string; reviewId: string }> {
  await dispatch(dashboard, daemon);
  const live = await boundSession(daemon);
  const reviewId = await ask(daemon, live.cwd);
  expect(await pinDraft(daemon, live.id, reviewId), "an invited session takes the draft").toBe(200);
  return { sessionId: live.id, reviewId };
}

test("Foreman's draft is shown on the form and reverts to the agent's recommendation", async ({
  dashboard,
  daemon,
}) => {
  await setup(dashboard, daemon);
  const modal = await openReview(dashboard);

  // The draft, named as Foreman's: its selections and its Other text, not the preselection.
  const banner = modal.getByRole("status", { name: "Foreman's draft" });
  await expect(banner).toBeVisible();
  await expect(modal.getByRole("radio", { name: /Use Redis/ })).toBeChecked();
  await expect(modal.getByRole("radio", { name: /Postgres table/ })).not.toBeChecked();
  const other = modal.getByPlaceholder("Other…");
  await expect(other).toHaveValue(FOREMAN_OTHER);
  await expect(modal.locator(".decision-other-draft")).toHaveText("◆ Foreman's draft");
  await expect(modal.getByText(`Selected: Use Redis · Google, Other: ${FOREMAN_OTHER} (Foreman's draft)`)).toBeVisible();
  // A draft is never sent by itself: the form is still waiting on Submit.
  await expect(modal.getByRole("button", { name: "Submit" })).toBeEnabled();
  await shoot(dashboard, "draft-on-the-form", modal);

  // One click back to the agent's recommendation, and Foreman's Other text is gone.
  await banner.getByRole("button", { name: "Revert to recommendation" }).click();
  await expect(banner).toHaveCount(0);
  await expect(modal.getByRole("radio", { name: /Postgres table/ })).toBeChecked();
  await expect(modal.getByRole("radio", { name: /Use Redis/ })).not.toBeChecked();
  await expect(modal.getByRole("checkbox", { name: /Google/ })).toBeChecked();
  await expect(other).toHaveValue("");
  await expect(modal.locator(".decision-other-draft")).toHaveCount(0);
  await expect(modal.getByText("Selected: Postgres table · Google")).toBeVisible();
  await shoot(dashboard, "draft-reverted", modal);
});

test("submitting Foreman's Other text marks it as an accepted Foreman draft", async ({
  dashboard,
  daemon,
}) => {
  const { reviewId } = await setup(dashboard, daemon);
  const modal = await openReview(dashboard);
  await expect(modal.getByPlaceholder("Other…")).toHaveValue(FOREMAN_OTHER);
  await modal.getByRole("button", { name: "Submit" }).click();
  await expect(modal).toBeHidden();

  // What the agent's blocked tool call reads.
  const review = await answerFor(daemon, reviewId);
  expect(review.status).toBe("answered");
  expect(review.selections).toEqual([
    { decisionId: "store", selected: ["redis"], other: null },
    { decisionId: "providers", selected: ["google"], other: FOREMAN_OTHER, foremanDraftAccepted: true },
  ]);
  expect(review.response).toBe(
    "Plan decisions submitted:\n\n" +
      "• Where should sessions live?\n  → Use Redis\n\n" +
      `• Which providers ship first?\n  → Google\n  Other: ${FOREMAN_OTHER} (Foreman draft, accepted)`,
  );

  // And the conversation's record of your answer.
  const record = dashboard.locator(".console-detail .review-answer");
  await expect(record.locator(".review-answer-other")).toContainText(FOREMAN_OTHER);
  await expect(record.locator(".review-answer-foreman-draft")).toHaveText("Foreman draft, accepted");
  await shoot(dashboard, "accepted-in-the-record", record);
});

test("editing Foreman's Other text makes it yours, with no Foreman mark", async ({ dashboard, daemon }) => {
  const { reviewId } = await setup(dashboard, daemon);
  const modal = await openReview(dashboard);
  await modal.getByPlaceholder("Other…").fill("Okta via OIDC");
  await expect(modal.locator(".decision-other-draft")).toHaveCount(0);
  await modal.getByRole("button", { name: "Submit" }).click();
  await expect(modal).toBeHidden();

  const review = await answerFor(daemon, reviewId);
  expect(review.response).toContain("Other: Okta via OIDC");
  expect(review.response).not.toContain("Foreman draft, accepted");
});

test("a withdrawn invite takes the draft off the form", async ({ dashboard, daemon }) => {
  const { sessionId, reviewId } = await setup(dashboard, daemon);
  const res = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(sessionId)}/foreman-invite`, {
    method: "DELETE",
  });
  expect(res.status).toBe(200);
  // An uninvited session refuses a new draft outright.
  expect(await pinDraft(daemon, sessionId, reviewId)).toBe(403);

  const modal = await openReview(dashboard);
  await expect(modal.getByRole("status", { name: "Foreman's draft" })).toHaveCount(0);
  await expect(modal.getByRole("radio", { name: /Postgres table/ })).toBeChecked();
  await expect(modal.getByPlaceholder("Other…")).toHaveValue("");
});

/** Dispatch and ask, with no draft yet: the form is opened before Foreman has spoken. */
async function setupWithoutDraft(
  dashboard: Page,
  daemon: DaemonHandle,
): Promise<{ sessionId: string; reviewId: string }> {
  await dispatch(dashboard, daemon);
  const live = await boundSession(daemon);
  return { sessionId: live.id, reviewId: await ask(daemon, live.cwd) };
}

test("a draft landing on an open, untouched form is applied live", async ({ dashboard, daemon }) => {
  // Foreman's review takes minutes, so this is the usual order: the form is already open.
  const { sessionId, reviewId } = await setupWithoutDraft(dashboard, daemon);
  const modal = await openReview(dashboard);
  await expect(modal.getByRole("radio", { name: /Postgres table/ })).toBeChecked();
  await expect(modal.getByRole("status", { name: "Foreman's draft" })).toHaveCount(0);

  expect(await pinDraft(daemon, sessionId, reviewId)).toBe(200);
  await expect(modal.getByRole("status", { name: "Foreman's draft" })).toBeVisible();
  await expect(modal.getByRole("radio", { name: /Use Redis/ })).toBeChecked();
  await expect(modal.getByPlaceholder("Other…")).toHaveValue(FOREMAN_OTHER);
});

test("a draft never overwrites a form you already touched", async ({ dashboard, daemon }) => {
  const { sessionId, reviewId } = await setupWithoutDraft(dashboard, daemon);
  const modal = await openReview(dashboard);
  await modal.getByRole("checkbox", { name: /GitHub/ }).check();

  expect(await pinDraft(daemon, sessionId, reviewId)).toBe(200);
  // The note did arrive - its prose already marks Foreman's pick - but the choices stay yours.
  await expect(modal.locator(".decision-option").filter({ hasText: "Use Redis" })).toContainText(
    "Foreman's pick",
  );
  await expect(modal.getByRole("status", { name: "Foreman's draft" })).toHaveCount(0);
  await expect(modal.getByRole("radio", { name: /Postgres table/ })).toBeChecked();
  await expect(modal.getByRole("checkbox", { name: /GitHub/ })).toBeChecked();
  await expect(modal.getByPlaceholder("Other…")).toHaveValue("");
});

test("a draft withdrawn from an open, untouched form falls back to the recommendation", async ({
  dashboard,
  daemon,
}) => {
  const { sessionId } = await setup(dashboard, daemon);
  const modal = await openReview(dashboard);
  await expect(modal.getByRole("radio", { name: /Use Redis/ })).toBeChecked();
  await expect(modal.getByPlaceholder("Other…")).toHaveValue(FOREMAN_OTHER);

  const res = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(sessionId)}/foreman-invite`, {
    method: "DELETE",
  });
  expect(res.status).toBe(200);
  await expect(modal.getByRole("status", { name: "Foreman's draft" })).toHaveCount(0);
  await expect(modal.getByRole("radio", { name: /Postgres table/ })).toBeChecked();
  await expect(modal.getByRole("radio", { name: /Use Redis/ })).not.toBeChecked();
  await expect(modal.getByPlaceholder("Other…")).toHaveValue("");
});

test("revert leaves your answer to a question Foreman did not draft", async ({ dashboard, daemon }) => {
  // Foreman drafts only the providers question; the store question is yours alone.
  const { sessionId, reviewId } = await setupWithoutDraft(dashboard, daemon);
  expect(
    await pinDraft(daemon, sessionId, reviewId, [
      { decisionId: "providers", selected: ["github"], other: FOREMAN_OTHER },
    ]),
  ).toBe(200);
  const modal = await openReview(dashboard);
  const banner = modal.getByRole("status", { name: "Foreman's draft" });
  await expect(banner).toBeVisible();
  await expect(modal.getByRole("checkbox", { name: /GitHub/ })).toBeChecked();

  await modal.getByRole("radio", { name: /Use Redis/ }).check();
  await banner.getByRole("button", { name: "Revert to recommendation" }).click();

  // Foreman's change is undone...
  await expect(modal.getByRole("checkbox", { name: /Google/ })).toBeChecked();
  await expect(modal.getByRole("checkbox", { name: /GitHub/ })).not.toBeChecked();
  await expect(modal.getByPlaceholder("Other…")).toHaveValue("");
  // ...and yours is not.
  await expect(modal.getByRole("radio", { name: /Use Redis/ })).toBeChecked();
  await expect(modal.getByText("Selected: Use Redis · Google")).toBeVisible();
});
