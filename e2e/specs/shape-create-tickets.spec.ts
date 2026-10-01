import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import {
  dispatchShape,
  mergePlanPullRequest,
  openPlanPullRequest,
  openSitrep,
  setShapeSkills,
  settled,
  tasks,
  type TaskRow,
} from "../fixtures/shape-tasks.ts";

/**
 * **Create tickets** on a shape task whose plan pull request merged.
 *
 * What is real: the dispatched shape session, the pull request it announces, the merge the PR
 * poller observes through the fake `gh`, the merge settlement that takes the shape task to done,
 * the derived `shapeTickets` field riding `task_upsert` to the Sitrep, the click, the route, and
 * the follow-up's own dispatch, whose tickets-only contract is read back from its conversation.
 *
 * Every agent binary is the fake (`e2e/fixtures/fake-agents.ts`), which echoes the prompt it
 * received. No model tokens are spent.
 */

const EVIDENCE = artifactsDir("shape-create-tickets");
const PR_URL = "https://github.com/example/demo-repo/pull/31";

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/shape-create-tickets/${name}.png`);
}

/** Dispatch a shape task, open its plan PR, and merge it: the task completes through the merge. */
async function mergedShapeTask(page: Page, daemon: DaemonHandle): Promise<TaskRow> {
  await setShapeSkills(daemon, true);
  await dispatchShape(page, daemon);
  const { session, task } = await settled(daemon);
  await openPlanPullRequest(daemon, session, task, PR_URL);

  // Before the merge the task is not done, so nothing is offered. The dispatch stamped it as
  // delivered under the contract that defers tickets to the merge; no plan review was answered.
  const running = (await tasks(daemon)).find((t) => t.id === task.id)!;
  expect(running.shapeTickets).toEqual({ state: "awaiting-review", followupTaskId: null, canCreate: false });

  // The plan PR merges; the poller observes it and merge settlement takes the shape task to done.
  const source = await mergePlanPullRequest(daemon, task, PR_URL);
  // No Create tickets choice was recorded, so the merge started nothing on its own.
  expect(source.shapeTickets).toEqual({ state: "awaiting-review", followupTaskId: null, canCreate: true });
  return source;
}

test("Create tickets on a merged shape task dispatches its tickets-only follow-up", async ({
  dashboard,
  daemon,
}) => {
  const source = await mergedShapeTask(dashboard, daemon);

  const outcomes = await openSitrep(dashboard);
  const row = outcomes.locator(".report-row").filter({ hasText: source.title });
  const create = row.getByRole("button", { name: "Create tickets" });
  await expect(create).toBeVisible();
  await shoot(dashboard, "01-create-tickets-offered", row);

  await create.click();

  // The follow-up exists, linked and dispatched, and the source no longer offers the action.
  const title = `Tickets: ${source.title}`;
  let followup: TaskRow | undefined;
  await expect
    .poll(async () => {
      followup = (await tasks(daemon)).find((t) => t.title === title);
      return followup?.status ?? "";
    }, { timeout: 30_000, message: "the follow-up is created and launched" })
    .toMatch(/^(dispatching|running)$/);
  expect(followup).toMatchObject({ kind: "shape", workflowId: null, repoRoot: source.repoRoot });
  await expect(create).toBeHidden();
  await expect
    .poll(async () => (await tasks(daemon)).find((t) => t.id === source.id)?.shapeTickets)
    .toEqual({ state: "awaiting-review", followupTaskId: followup!.id, canCreate: false });
  await shoot(dashboard, "02-action-withdrawn", row);

  // The follow-up's card is on the board, and its session was told tickets-only mode.
  await dashboard.keyboard.press("Escape");
  await expect(dashboard.getByRole("heading", { name: "Sitrep" })).toBeHidden();
  const rail = dashboard.getByRole("navigation", { name: "Sessions" });
  // The rail truncates a long session name, so match the follow-up by its prefix.
  const followupRow = rail.locator("button.rail-row").filter({ hasText: title.slice(0, 40) });
  await expect(followupRow).toBeVisible({ timeout: 60_000 });
  await followupRow.click();
  const card = dashboard.locator(".console-detail");
  await expect(card).toContainText("tickets-only mode", { timeout: 30_000 });
  await expect(card).toContainText(PR_URL);
  await expect(card).toContainText("/tickets");
  await expect(card).toContainText("complete_shape_tickets");
  await expect(card).not.toContainText("/grill");
  await shoot(dashboard, "03-followup-tickets-only-contract", card);
});

test("a Create tickets whose launch is refused leaves the follow-up in the backlog and says why on the row", async ({
  dashboard,
  daemon,
}) => {
  const source = await mergedShapeTask(dashboard, daemon);
  // Switched off after the merge: Create tickets is still offered, but the follow-up's launch
  // is refused by the shape kind's skill gate.
  await setShapeSkills(daemon, false);

  const outcomes = await openSitrep(dashboard);
  const row = outcomes.locator(".report-row").filter({ hasText: source.title });
  await row.getByRole("button", { name: "Create tickets" }).click();

  // The row says the follow-up is waiting in the backlog, and why.
  const note = row.getByRole("status");
  await expect(note).toContainText("tickets task is waiting in the backlog:");
  await expect(note).toContainText("Enable Skills and the grill skill");
  await expect(row.getByRole("button", { name: "Create tickets" })).toBeHidden();
  // On its own line below the title, never printed over it.
  const titleBox = await row.getByText(source.title, { exact: true }).boundingBox();
  const noteBox = await note.boundingBox();
  expect(titleBox && noteBox && noteBox.y >= titleBox.y + titleBox.height).toBe(true);
  await shoot(dashboard, "04-create-tickets-queued", row);

  // The follow-up exists in the backlog, carrying that reason as its error.
  const followup = (await tasks(daemon)).find((t) => t.title === `Tickets: ${source.title}`);
  expect(followup).toMatchObject({ kind: "shape", status: "backlog", workflowId: null });
  expect(followup!.error).toContain("Enable Skills and the grill skill");
  expect((await tasks(daemon)).find((t) => t.id === source.id)?.shapeTickets)
    .toEqual({ state: "awaiting-review", followupTaskId: followup!.id, canCreate: false });
});
