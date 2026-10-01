import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("shape-kind");

/**
 * `shape`, the grill-first planning kind, through the dispatch form, the guided pass, and the
 * launch it produces.
 *
 * Every agent binary is the fake (`e2e/fixtures/fake-agents.ts`), which echoes the prompt it
 * received, so the delivered shape contract is read back from the session's own conversation.
 * No model tokens are spent.
 */

const TASK = "Shape how exports should work for the archives library";

const kindSelect = (dialog: Locator): Locator =>
  dialog.getByRole("combobox", { name: "Kind", exact: true });
const afterWorkSelect = (dialog: Locator): Locator =>
  dialog.getByRole("combobox", { name: "After work", exact: true });

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/shape-kind/${name}.png`);
}

async function setSkills(daemon: DaemonHandle, skills: Record<string, boolean>): Promise<void> {
  const res = await fetch(`${daemon.baseURL}/api/skills/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, skills }),
  });
  expect(res.ok, "the skills panel should accept the change").toBeTruthy();
  const view = (await res.json()) as { skills: Array<{ id: string; enabled: boolean }> };
  for (const [id, enabled] of Object.entries(skills)) {
    expect(view.skills.find((skill) => skill.id === id)?.enabled, `${id} is in the catalog`).toBe(enabled);
  }
}

async function openDispatch(page: Page, daemon: DaemonHandle): Promise<Locator> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  return dialog;
}

async function submit(dialog: Locator): Promise<void> {
  const go = dialog.getByRole("button", { name: "Dispatch now" });
  await expect(go).toBeEnabled();
  await go.click();
}

test("a dispatched shape task is told to grill first, then plan, and to offer Create tickets after the plan merges", async ({
  dashboard,
  daemon,
}) => {
  await setSkills(daemon, { grill: true, "html-plans": true, tickets: true });

  const dialog = await openDispatch(dashboard, daemon);
  await kindSelect(dialog).selectOption("shape");
  // Its default review is Plan Validation, the same as plan's.
  await expect(afterWorkSelect(dialog)).toHaveValue("builtin-workflow:plan-validation");
  await shoot(dashboard, "01-shape-selected", dialog);
  // Opted out here so the delivered text is the shape contract alone; this repo is not
  // allowlisted for Live delivery, so the review would refuse the dispatch for another reason.
  await afterWorkSelect(dialog).selectOption("__none");
  await submit(dialog);
  await expect(dialog).toBeHidden();

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await expect(card).toContainText(TASK, { timeout: 30_000 });
  await expect(card).toContainText("Mission Control shape");
  // The two skills the shaping turn runs, in this harness's own syntax, and the grilling rules
  // the kind exists for.
  await expect(card).toContainText("/grill");
  await expect(card).toContainText("/html-plans");
  await expect(card).toContainText("request_plan_decisions");
  await expect(card).toContainText("Ask at least one round");
  await expect(card).toContainText("A dismissed round ends the work");
  // The review's follow-up is Create tickets after the plan merges / Stop, never plan's phased
  // follow-up. The shaping turn itself never slices: a follow-up task does, after the merge.
  await expect(card).toContainText("Create tickets after the plan merges, recommended");
  await expect(card).toContainText("This shaping turn files no tasks and pushes no");
  await expect(card).not.toContainText("/tickets");
  await expect(card).not.toContainText("/phased-plan");
  await expect(card).not.toContainText("Mission Control plan ---");
  // And the session's task pill names the kind.
  await expect(card.locator(".task-kind")).toHaveText("shape");

  await shoot(dashboard, "02-shape-contract-delivered", card);

  const tasks = (await fetch(`${daemon.baseURL}/api/tasks`).then((r) => r.json())) as Array<{ kind: string }>;
  expect(tasks.map((task) => task.kind)).toEqual(["shape"]);
});

test("the guided pass takes shape on s", async ({ dashboard, daemon }) => {
  await setSkills(daemon, { grill: true, "html-plans": true, tickets: true });
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByRole("switch", { name: "Guided" }).click();
  await expect(dialog.getByRole("navigation", { name: "Guided dispatch" })).toBeVisible();
  await dashboard.keyboard.press("Enter");

  const picker = dialog.getByRole("listbox", { name: "What kind of run is this?" });
  await expect(picker).toBeVisible();
  const shapeOption = picker.getByRole("option", { name: /^shape/ });
  await expect(shapeOption).toContainText("Get grilled on the work first");
  // Tall enough that the portaled picker shows its last option, which is shape.
  const viewport = dashboard.viewportSize();
  await dashboard.setViewportSize({ width: 1280, height: 1100 });
  await expect(shapeOption).toBeInViewport();
  await shoot(dashboard, "03-guided-kind-picker");
  if (viewport) await dashboard.setViewportSize(viewport);

  await dashboard.keyboard.press("s");
  await expect(kindSelect(dialog)).toHaveValue("shape");
});

test("a shape dispatch with the grill skill off is refused on the form, naming the toggle", async ({
  dashboard,
  daemon,
}) => {
  await setSkills(daemon, { grill: false, "html-plans": true, tickets: true });

  const dialog = await openDispatch(dashboard, daemon);
  await kindSelect(dialog).selectOption("shape");
  await afterWorkSelect(dialog).selectOption("__none");
  await submit(dialog);

  const refusal = dialog.locator(".dispatch-error");
  await expect(refusal).toContainText("Enable Skills and the grill skill");
  await expect(refusal).toContainText("A shape task's intent invokes the planning skills");
  await expect(refusal).toContainText("Settings → Skills");
  await shoot(dashboard, "04-shape-refused", dialog);

  // Refused before anything exists.
  await expect(dialog).toBeVisible();
  await expect(dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(0);
  expect(await fetch(`${daemon.baseURL}/api/tasks`).then((r) => r.json())).toEqual([]);
});

test("a shape task can be backlogged, but a recurring mission cannot file one", async ({
  dashboard,
  daemon,
}) => {
  const dialog = await openDispatch(dashboard, daemon);
  await kindSelect(dialog).selectOption("shape");
  const created = dashboard.waitForResponse((response) =>
    response.url().endsWith("/api/tasks") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Add to backlog" }).click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const task = (await response.json()) as { kind: string; status: string; workflowId: string | null };
  expect(task).toMatchObject({
    kind: "shape",
    status: "backlog",
    workflowId: "builtin-workflow:plan-validation",
  });
  await expect(dialog).toBeHidden();

  await dashboard.getByRole("button", { name: "Recurring missions" }).click();
  const missions = dashboard.getByRole("dialog", { name: "Recurring missions" });
  await missions.getByRole("button", { name: "Create mission" }).click();
  const missionKind = missions.getByRole("combobox", { name: "Task kind" });
  await expect(missionKind).toBeVisible();
  const offered = await missionKind.evaluate((el) =>
    [...(el as HTMLSelectElement).options].map((option) => option.value));
  expect(offered).not.toContain("shape");
  expect(offered).toContain("plan");
});
