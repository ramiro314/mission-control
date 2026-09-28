import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import type { WorkflowConfig } from "../../src/shared/workflow.ts";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

// The Test checks card writes the two machine-wide settings a workflow test check reads: the
// check test lease and the MISSION_TEST_CONCURRENCY it hands the command.
const EVIDENCE = artifactsDir("workflow-test-checks");

async function config(daemon: DaemonHandle): Promise<WorkflowConfig> {
  const response = await fetch(`${daemon.baseURL}/api/workflows/config`);
  if (!response.ok) throw new Error(`config: ${response.status}`);
  return await response.json() as WorkflowConfig;
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.locator('[data-anchor="workflows/test-checks"]').screenshot({ path: `${EVIDENCE}${name}.png` });
}

test("the test check lease and concurrency default on, save, and read back", async ({ dashboard, daemon }) => {
  await dashboard.setViewportSize({ width: 1440, height: 1200 });
  await dashboard.goto(`${daemon.baseURL}/#/settings/workflows`);
  const card = dashboard.locator('[data-anchor="workflows/test-checks"]');
  const lease = card.getByRole("checkbox", { name: "Run one test check at a time on this machine" });
  const concurrency = card.getByRole("spinbutton", { name: "Test concurrency" });
  await expect(lease).toBeEnabled();
  await expect(lease).toBeChecked();
  await expect(concurrency).toHaveValue("3");
  await expect(card).toContainText("Lint, typecheck and build checks never wait.");
  await shoot(dashboard, "default");

  await concurrency.fill("2");
  await card.getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await config(daemon)).checkTestConcurrency).toBe(2);

  await lease.uncheck();
  await expect.poll(async () => (await config(daemon)).checkTestLease).toBe(false);

  await dashboard.reload();
  await expect(lease).toBeEnabled();
  await expect(lease).not.toBeChecked();
  await expect(concurrency).toHaveValue("2");
  await shoot(dashboard, "changed");

  // An empty box leaves the variable unset rather than writing a number.
  await concurrency.fill("");
  await card.getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await config(daemon)).checkTestConcurrency).toBe(null);

  // Out of range is refused in the panel, and nothing is written.
  await concurrency.fill("40");
  await card.getByRole("button", { name: "Apply" }).click();
  await expect(dashboard.getByText(/Test concurrency must be a whole number from 1 to 32/)).toBeVisible();
  expect((await config(daemon)).checkTestConcurrency).toBe(null);

  await lease.check();
  await expect.poll(async () => (await config(daemon)).checkTestLease).toBe(true);
});
