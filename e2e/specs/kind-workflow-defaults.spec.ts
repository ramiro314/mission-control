import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";

/**
 * Settings -> Workflows -> Dispatch defaults: one after-work Workflow per task kind.
 *
 * Driven through the browser because the claim spans two surfaces: a row chosen on the
 * Settings page is what the dispatch form preselects when that kind is picked, and what the
 * daemon files when an API caller omits the Workflow. No dispatch is launched, so nothing
 * here spends model tokens.
 */

const GENERAL_REVIEW = "builtin-workflow:general-review";

/** The text of a `<select>`'s chosen option; a collapsed select renders no option text. */
function selectedLabel(select: Locator): Promise<string> {
  return select.evaluate(
    (el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? "",
  );
}

function kindRow(page: Page, kind: string): Locator {
  return page.getByRole("combobox", { name: `Default after-work Workflow for ${kind} tasks`, exact: true });
}

/** Choose a row's Workflow and wait for the Settings write that carries it to land. */
async function chooseRow(page: Page, kind: string, value: string): Promise<void> {
  const saved = page.waitForResponse((response) =>
    response.url().endsWith("/api/workflows/config") && response.request().method() === "PUT");
  await kindRow(page, kind).selectOption(value);
  expect((await saved).ok()).toBe(true);
}

test("each kind's dispatch default is chosen in Settings and preselected at dispatch", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/workflows`);

  // One row per kind this app launches, each naming what its built-in resolves to.
  await expect(kindRow(dashboard, "bugfix")).toBeEnabled();
  expect(await selectedLabel(kindRow(dashboard, "ship"))).toBe("Built-in default (No-Mistakes Review (High Rigor))");
  expect(await selectedLabel(kindRow(dashboard, "bugfix"))).toBe("Built-in default (Bug Fix Review)");
  expect(await selectedLabel(kindRow(dashboard, "plan"))).toBe("Built-in default (Plan Validation)");
  expect(await selectedLabel(kindRow(dashboard, "scout"))).toBe("Built-in default (None)");
  await expect(kindRow(dashboard, "pipeline")).toHaveCount(0);

  await chooseRow(dashboard, "bugfix", GENERAL_REVIEW);
  await chooseRow(dashboard, "scout", GENERAL_REVIEW);
  await chooseRow(dashboard, "plan", "__none");

  // Durable, not just drawn: a reload reads the rows back from the daemon.
  await dashboard.reload();
  await expect(kindRow(dashboard, "bugfix")).toHaveValue(GENERAL_REVIEW);
  await expect(kindRow(dashboard, "scout")).toHaveValue(GENERAL_REVIEW);
  await expect(kindRow(dashboard, "plan")).toHaveValue("__none");
  expect(await selectedLabel(kindRow(dashboard, "ship"))).toBe("Built-in default (No-Mistakes Review (High Rigor))");

  await dashboard.goto(`${daemon.baseURL}/`);
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  const afterWork = dialog.getByRole("combobox", { name: "After work", exact: true });
  await expect
    .poll(() => selectedLabel(afterWork), { message: "the Workflow config fetch should settle" })
    .not.toContain("loading");

  await kind.selectOption("bugfix");
  await expect(afterWork).toHaveValue(GENERAL_REVIEW);
  expect(await selectedLabel(afterWork)).toContain("General Review");
  await kind.selectOption("scout");
  await expect(afterWork).toHaveValue(GENERAL_REVIEW);
  await kind.selectOption("plan");
  await expect(afterWork).toHaveValue("__none");
  await expect(dialog.getByText("No handoff")).toBeVisible();
  // Back to the kind the form opened on hands back what it opened with.
  await kind.selectOption("ship");
  await expect(afterWork).toHaveValue("__default");
  expect(await selectedLabel(afterWork)).toContain("No-Mistakes Review");

  // The same rows reach a creator that names no Workflow.
  const created = await dashboard.request.post(`${daemon.baseURL}/api/tasks`, {
    data: {
      repoRoot: daemon.repo,
      intent: "fix the retry regression",
      title: "Retry regression",
      agent: "claude",
      kind: "bugfix",
      backlog: true,
    },
  });
  expect(created.ok()).toBe(true);
  expect(((await created.json()) as { workflowId: string | null }).workflowId).toBe(GENERAL_REVIEW);
});

test("returning a row to its built-in follows the built-in again", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/workflows`);
  await expect(kindRow(dashboard, "bugfix")).toBeEnabled();

  await chooseRow(dashboard, "bugfix", GENERAL_REVIEW);
  await chooseRow(dashboard, "bugfix", "__builtin");

  expect(await selectedLabel(kindRow(dashboard, "bugfix"))).toBe("Built-in default (Bug Fix Review)");
  const config = (await (await dashboard.request.get(`${daemon.baseURL}/api/workflows/config`)).json()) as {
    kindWorkflowDefaults: Record<string, string | null>;
  };
  expect(config.kindWorkflowDefaults).toEqual({});
});
