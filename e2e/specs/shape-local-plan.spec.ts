import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import {
  api,
  harnessToken,
  setShapeSkills,
  settled,
  SHAPE_TASK,
  tasks,
  type SessionRow,
} from "../fixtures/shape-tasks.ts";

/**
 * A shape task under Settings > Skills > Plan storage: Local. Shape follows the setting as plan
 * does, so its After work defaults to Local Plan Validation and its tickets wait for the plan's
 * local publication rather than a merge.
 *
 * What is real: the stored skills setting, the dispatch form's After work default, the
 * dispatched shape session and the policy its task pinned, the plan review answered through the
 * review route (which records the choice on the task), and the derived marker on the board card
 * and in its drawer. Every agent binary is the fake (`e2e/fixtures/fake-agents.ts`).
 */

const EVIDENCE = artifactsDir("shape-local-plan");

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/shape-local-plan/${name}.png`);
}

async function useLocalPlanStorage(daemon: DaemonHandle): Promise<void> {
  await setShapeSkills(daemon, true);
  await api(daemon, "/api/skills/config", { planStorage: "local" }, "PUT");
  await expect.poll(async () => (await api<{ planStorage: string }>(daemon, "/api/skills")).planStorage).toBe("local");
}

/** The shaping session's plan review, answered with Create tickets. */
async function chooseCreateTickets(daemon: DaemonHandle, session: SessionRow): Promise<void> {
  const created = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": harnessToken(daemon) },
    body: JSON.stringify({
      env: {},
      sessionId: session.agentSessionId,
      cwd: session.cwd,
      kind: "plan-decisions",
      title: "Archive exports: plan review",
      body: "The plan is saved in the local plan store.",
      decisions: [{
        id: "shape-follow-up",
        question: "What should happen after this plan is approved?",
        options: [
          { id: "create-tickets", label: "Create tickets after the plan is published", recommended: true },
          { id: "stop", label: "Stop" },
        ],
      }],
    }),
  });
  if (!created.ok) throw new Error(`the plan review answered ${created.status}: ${await created.text()}`);
  const { id } = (await created.json()) as { id: string };
  await api(daemon, `/api/reviews/${id}/resolve`, {
    action: "answer",
    selections: [{ decisionId: "shape-follow-up", selected: ["create-tickets"], other: null }],
  });
}

test("under local plan storage a shape task defaults to Local Plan Validation and its tickets wait for publication", async ({
  dashboard,
  daemon,
}) => {
  await useLocalPlanStorage(daemon);
  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  await dashboard.reload();

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(SHAPE_TASK);
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  await expect(kind).toBeEnabled();
  await kind.selectOption("shape");
  const afterWork = dialog.getByRole("combobox", { name: "After work", exact: true });
  await expect(afterWork.locator("option:checked")).toHaveText(/Local Plan Validation/);
  await shoot(dashboard, "01-dispatch-after-work-local-plan-validation", dialog);

  // None is a valid choice for a local plan, and keeps the fake session's turn its own.
  await afterWork.selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  const { session, task } = await settled(daemon);
  expect((task as unknown as { planPolicy?: { storage: string } }).planPolicy?.storage).toBe("local");

  await chooseCreateTickets(daemon, session);
  await expect
    .poll(async () => (await tasks(daemon)).find((t) => t.id === task.id)?.shapeTickets?.state)
    .toBe("pending");

  const card = dashboard.locator(".tile").filter({ has: dashboard.getByRole("button", { name: /^Open / }) });
  await expect(card.getByRole("note", { name: "Tickets after publication" })).toBeVisible();
  await expect(card.getByRole("note", { name: "Tickets after merge" })).toHaveCount(0);
  await shoot(dashboard, "02-card-tickets-after-publication", card);

  await card.getByRole("button", { name: /^Open / }).press("Enter");
  const drawer = dashboard.getByRole("complementary", { name: "Session detail workspace" });
  await expect(drawer.getByRole("note", { name: "Tickets after publication" })).toBeVisible();
  await shoot(dashboard, "03-drawer-tickets-after-publication", drawer);
});
