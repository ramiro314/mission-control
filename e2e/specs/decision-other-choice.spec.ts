import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * On a single-choice question that allows Other, Other is a real choice in the radio group.
 *
 * The form opens with the recommended radio checked. Before this, the Other box sat beside the
 * radios with no link to them, so typing in it always sent the recommendation AND the text -
 * nothing could send "Other only". Now typing, clicking the Other radio, or a pointer press in
 * the box chooses Other and clears the listed option; picking a listed option again keeps the
 * text visible but unsent. Tabbing into the box changes nothing.
 *
 * The review is asked through `POST /mcp/reviews`, the route the MCP tool uses, from a
 * dispatched session whose agent is faked - no model call is made.
 */

const TASK = "choose how the installer runs";
const EVIDENCE = artifactsDir("decision-other-choice");
const QUESTION = "How should the installer run?";
const RECOMMENDED = "Run install.sh inside WSL";
const LISTED = "PowerShell script";

const DECISIONS = [
  {
    id: "install",
    question: QUESTION,
    allowOther: true,
    options: [
      { id: "wsl", label: RECOMMENDED, recommended: true },
      { id: "ps", label: LISTED },
    ],
  },
];

async function shoot(page: Page, name: string, target: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/decision-other-choice/${name}.png`);
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

/** The dispatched session once it has bound its agent id (a Foreman note is keyed by it). */
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
      title: "Installer plan",
      body: "Pick how the installer runs on Windows.",
      decisions: DECISIONS,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { id: string }).id;
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

async function setup(dashboard: Page, daemon: DaemonHandle): Promise<{ sessionId: string; reviewId: string }> {
  await dispatch(dashboard, daemon);
  const live = await boundSession(daemon);
  return { sessionId: live.id, reviewId: await ask(daemon, live.cwd) };
}

async function openReview(dashboard: Page): Promise<Locator> {
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await dashboard.locator(".console-detail").getByRole("button", { name: /to review/ }).click();
  const modal = dashboard.locator(".review-modal");
  await expect(modal).toBeVisible();
  return modal;
}

function controls(modal: Locator): { recommended: Locator; listed: Locator; other: Locator; box: Locator } {
  return {
    recommended: modal.getByRole("radio", { name: new RegExp(RECOMMENDED) }),
    listed: modal.getByRole("radio", { name: new RegExp(LISTED) }),
    other: modal.getByRole("radio", { name: "Other", exact: true }),
    box: modal.getByPlaceholder("Other…"),
  };
}

test("typing in Other chooses it alone, and only its text is sent", async ({ dashboard, daemon }) => {
  const { reviewId } = await setup(dashboard, daemon);
  const modal = await openReview(dashboard);
  const { recommended, other, box } = controls(modal);

  await expect(recommended).toBeChecked();
  await expect(other).not.toBeChecked();
  await expect(modal.getByText(`Selected: ${RECOMMENDED}`)).toBeVisible();

  await box.click();
  await box.pressSequentially("Use a VM");
  await expect(other).toBeChecked();
  await expect(recommended).not.toBeChecked();
  await expect(modal.getByText("Selected: Other: Use a VM", { exact: true })).toBeVisible();
  await shoot(dashboard, "other-only", modal);

  await modal.getByRole("button", { name: "Submit" }).click();
  await expect(modal).toBeHidden();
  const review = await answerFor(daemon, reviewId);
  expect(review.status).toBe("answered");
  expect(review.selections).toEqual([{ decisionId: "install", selected: [], other: "Use a VM" }]);
  expect(review.response).toBe(`Plan decisions submitted:\n\n• ${QUESTION}\n  Other: Use a VM`);
});

test("a listed option deselects Other and keeps its text unsent; Tab is inert, a click is not", async ({
  dashboard,
  daemon,
}) => {
  const { reviewId } = await setup(dashboard, daemon);
  const modal = await openReview(dashboard);
  const { listed, other, box } = controls(modal);

  await box.fill("Use a VM");
  await expect(other).toBeChecked();

  // Back to a listed option: Other is deselected, its text stays visible and is not sent.
  await listed.click();
  await expect(listed).toBeChecked();
  await expect(other).not.toBeChecked();
  await expect(box).toHaveValue("Use a VM");
  await expect(modal.getByText(`Selected: ${LISTED}`, { exact: true })).toBeVisible();
  await shoot(dashboard, "listed-keeps-text", modal);

  // Tabbing from the checked radio lands in the box and changes nothing.
  await listed.focus();
  await dashboard.keyboard.press("Tab");
  await expect(box).toBeFocused();
  await expect(listed).toBeChecked();
  await expect(other).not.toBeChecked();

  // A pointer click in the box chooses Other again, with the kept text intact.
  await listed.click();
  await box.click();
  await expect(other).toBeChecked();
  await expect(listed).not.toBeChecked();
  await expect(modal.getByText("Selected: Other: Use a VM", { exact: true })).toBeVisible();

  // Clicking the Other radio (after a listed option) chooses it and moves focus into the box.
  await listed.click();
  await other.click();
  await expect(other).toBeChecked();
  await expect(box).toBeFocused();

  // Submit with a listed option chosen sends only that option.
  await listed.click();
  await modal.getByRole("button", { name: "Submit" }).click();
  await expect(modal).toBeHidden();
  const review = await answerFor(daemon, reviewId);
  expect(review.selections).toEqual([{ decisionId: "install", selected: ["ps"], other: null }]);
  expect(review.response).toBe(`Plan decisions submitted:\n\n• ${QUESTION}\n  → ${LISTED}`);
});

test("Other chosen with an empty box leaves the question unanswered", async ({ dashboard, daemon }) => {
  await setup(dashboard, daemon);
  const modal = await openReview(dashboard);
  const { recommended, other } = controls(modal);
  const submit = modal.getByRole("button", { name: "Submit" });

  await expect(submit).toBeEnabled();
  await other.click();
  await expect(other).toBeChecked();
  await expect(recommended).not.toBeChecked();
  await expect(submit).toBeDisabled();
  await expect(modal.getByText(/^Selected:/)).toHaveCount(0);
  await shoot(dashboard, "empty-other-disabled", modal);

  await recommended.click();
  await expect(submit).toBeEnabled();
});

test("a Foreman draft with Other opens on Other, and revert restores the recommendation", async ({
  dashboard,
  daemon,
}) => {
  const { sessionId, reviewId } = await setup(dashboard, daemon);
  const res = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(sessionId)}/note`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      purpose: "Choosing how the installer runs.",
      recommendation: "Run it in a VM instead.",
      disposition: "pending",
      lastAction: "drafted answers on the decision form (awaiting you)",
      handledMarker: `review:${reviewId}`,
      draft: [{ decisionId: "install", selected: [], other: "Use a VM" }],
    }),
  });
  expect(res.status).toBe(200);

  const modal = await openReview(dashboard);
  const { recommended, other, box } = controls(modal);
  const banner = modal.getByRole("status", { name: "Foreman's draft" });
  await expect(banner).toBeVisible();
  await expect(other).toBeChecked();
  await expect(recommended).not.toBeChecked();
  await expect(box).toHaveValue("Use a VM");
  await expect(modal.getByText("Selected: Other: Use a VM (Foreman's draft)")).toBeVisible();

  await banner.getByRole("button", { name: "Revert to recommendation" }).click();
  await expect(recommended).toBeChecked();
  await expect(other).not.toBeChecked();
  await expect(box).toHaveValue("");
  await expect(modal.getByText(`Selected: ${RECOMMENDED}`, { exact: true })).toBeVisible();
});
