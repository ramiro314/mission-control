import { expect, test } from "../fixtures/test.ts";

/**
 * Ctrl+Y redoes a draft edit in the workflow builder off macOS, beside Ctrl+Shift+Z.
 *
 * Playwright's Chromium reports Linux, which is the platform this answers for. The macOS half
 * (Cmd+Y is not redo there) is pinned by `test/workflow-draft.test.ts`.
 */

test("Ctrl+Z undoes a pipeline stage and Ctrl+Y redoes it", async ({ dashboard, daemon }) => {
  const created = await fetch(`${daemon.baseURL}/api/workflows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "E2E redo with Ctrl+Y" }),
  });
  expect(created.ok).toBe(true);
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E redo with Ctrl\+Y/ }).click();

  const pipeline = dashboard.locator(".wf-pipeline-strip");
  const firstStage = pipeline.getByLabel("Add the first stage");
  await firstStage.selectOption({ label: "Pull Request" });
  const row = pipeline.locator("li.wf-pipeline-reviewer", { hasText: "Pull Request" });
  await expect(row).toBeVisible();

  // The builder ignores keys typed into a field, so the shortcut goes to a toolbar button.
  const undo = dashboard.getByRole("button", { name: "Undo", exact: true });
  const redo = dashboard.getByRole("button", { name: "Redo", exact: true });
  await dashboard.getByRole("button", { name: "Pipeline", exact: true }).focus();
  await dashboard.keyboard.press("Control+z");
  await expect(row).toHaveCount(0);
  await expect(redo).toBeEnabled();

  await dashboard.getByRole("button", { name: "Pipeline", exact: true }).focus();
  await dashboard.keyboard.press("Control+y");
  await expect(row).toBeVisible();
  await expect(redo).toBeDisabled();
  await expect(undo).toBeEnabled();
});
