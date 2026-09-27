import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A decision form opens with the agent's recommendation already selected.
 *
 * `recommended` used to be a hint only: the form opened empty and Submit stayed disabled until
 * the human clicked something, even when they only meant to accept what the agent suggested.
 * Now both option-carrying review kinds open preselected, a line beside Submit names what it
 * will send, and an untouched Submit returns exactly the recommendation. Asserted on the
 * answer the agent's blocked tool call actually reads - the same `/mcp/reviews/:id/wait` the
 * MCP child polls - not on the form's state.
 */

const TASK = "choose the session store";

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

/** Post a review on the channel the MCP child uses, bound to the one dispatched session. */
async function ask(daemon: DaemonHandle, body: Record<string, unknown>): Promise<string> {
  let cwd: string | null = null;
  await expect
    .poll(async () => {
      const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{
        cwd: string | null;
      }>;
      cwd = sessions[0]?.cwd ?? null;
      return cwd;
    })
    .toBeTruthy();
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, cwd, ...body }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** What the agent's blocked tool call receives once the review resolves. */
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

test("plan decisions open preselected and an untouched submit returns the recommendation", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const id = await ask(daemon, {
    kind: "plan-decisions",
    title: "Session storage plan",
    body: "Store sessions somewhere durable, then ship providers.",
    decisions: [
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
          { id: "gitlab", label: "GitLab", recommended: true },
        ],
      },
    ],
  });

  const modal = await openReview(dashboard);
  await expect(modal.getByRole("radio", { name: /Postgres table/ })).toBeChecked();
  await expect(modal.getByRole("radio", { name: /Use Redis/ })).not.toBeChecked();
  await expect(modal.getByRole("checkbox", { name: /Google/ })).toBeChecked();
  await expect(modal.getByRole("checkbox", { name: /GitLab/ })).toBeChecked();
  await expect(modal.getByRole("checkbox", { name: /GitHub/ })).not.toBeChecked();
  // Dismiss stays available, and Submit says what it will send.
  await expect(modal.getByRole("button", { name: "Dismiss" })).toBeEnabled();
  await expect(modal.getByText("Selected: Postgres table · Google, GitLab")).toBeVisible();
  if (process.env.MC_E2E_EVIDENCE === "1") {
    const dir = join(process.cwd(), "e2e", ".artifacts", "review-recommended-preselected");
    mkdirSync(dir, { recursive: true });
    await modal.screenshot({ path: join(dir, "plan-decisions-preselected.png") });
  }

  const submit = modal.getByRole("button", { name: "Submit" });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(modal).toBeHidden();

  const review = await answerFor(daemon, id);
  expect(review.status).toBe("answered");
  expect(review.selections).toEqual([
    { decisionId: "store", selected: ["pg"], other: null },
    { decisionId: "providers", selected: ["google", "gitlab"], other: null },
  ]);
  expect(review.response).toBe(
    "Plan decisions submitted:\n\n" +
      "• Where should sessions live?\n  → Postgres table\n\n" +
      "• Which providers ship first?\n  → Google, GitLab",
  );
});

test("request_input options open preselected and an untouched submit returns the recommendation", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const question = "Which caching strategy should the transcript reader use?";
  const id = await ask(daemon, {
    kind: "input",
    title: question,
    body: question,
    decisions: [
      {
        id: "q",
        question,
        options: [
          { id: "o0", label: "Single shared ring buffer" },
          { id: "o1", label: "Bounded LRU per session", recommended: true },
        ],
        allowOther: true,
      },
    ],
  });

  const modal = await openReview(dashboard);
  await expect(modal.getByRole("radio", { name: /Bounded LRU per session/ })).toBeChecked();
  await expect(modal.getByText("Selected: Bounded LRU per session")).toBeVisible();
  await expect(modal.getByRole("button", { name: "Dismiss" })).toBeEnabled();
  if (process.env.MC_E2E_EVIDENCE === "1") {
    const dir = join(process.cwd(), "e2e", ".artifacts", "review-recommended-preselected");
    mkdirSync(dir, { recursive: true });
    await modal.screenshot({ path: join(dir, "request-input-preselected.png") });
  }
  await modal.getByRole("button", { name: "Submit" }).click();
  await expect(modal).toBeHidden();

  const review = await answerFor(daemon, id);
  expect(review.status).toBe("answered");
  expect(review.selections).toEqual([{ decisionId: "q", selected: ["o1"], other: null }]);
  expect(review.response).toBe(`Answered:\n\n• ${question}\n  → Bounded LRU per session`);
});

test("a form with no recommendation still opens empty", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  const question = "Which retry budget?";
  await ask(daemon, {
    kind: "input",
    title: question,
    body: question,
    decisions: [
      {
        id: "q",
        question,
        options: [
          { id: "o0", label: "Three attempts" },
          { id: "o1", label: "Five attempts" },
        ],
      },
    ],
  });

  const modal = await openReview(dashboard);
  await expect(modal.getByRole("radio", { name: /Three attempts/ })).not.toBeChecked();
  await expect(modal.getByRole("radio", { name: /Five attempts/ })).not.toBeChecked();
  await expect(modal.getByText(/^Selected:/)).toHaveCount(0);
  await expect(modal.getByRole("button", { name: "Submit" })).toBeDisabled();

  // Choosing is what fills the line in, so it always matches what Submit will send.
  await modal.getByRole("radio", { name: /Five attempts/ }).check();
  await expect(modal.getByText("Selected: Five attempts")).toBeVisible();
  await expect(modal.getByRole("button", { name: "Submit" })).toBeEnabled();
});
