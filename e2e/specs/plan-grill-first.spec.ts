import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

const EVIDENCE = artifactsDir("plan-grill-first");

/** A frame of the state just asserted, behind `MC_E2E_EVIDENCE` so ordinary runs write nothing. */
async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
}

/**
 * Grill me first: a Plan task setting with a default on Settings -> Tasks and an override on
 * the dispatch form, the new-task form and the backlog editor alike.
 *
 * Driven through the browser because the claim spans surfaces: the default chosen on the
 * Settings page is what the dispatch form shows for a plan, what the form sends is what the
 * daemon pins on the task, and the backlog editor reads that pin back and saves a change to
 * it. Every task here is added to the backlog, never launched, so no agent runs and nothing
 * spends model tokens.
 */

interface TaskRow {
  id: string;
  title: string;
  kind: string;
  status: string;
  grillFirst?: boolean;
}

async function storedTask(daemon: DaemonHandle, page: Page, title: string): Promise<TaskRow> {
  const rows = (await (await page.request.get(`${daemon.baseURL}/api/tasks`)).json()) as TaskRow[];
  const row = rows.find((task) => task.title === title);
  expect(row, `a task titled ${title}`).toBeTruthy();
  return row!;
}

function grillBox(scope: Locator | Page): Locator {
  return scope.getByRole("checkbox", { name: "Grill me first", exact: true });
}

/** Open the dispatch form on this repo with a plan intent and an explicit title. */
async function openPlanDispatch(page: Page, daemon: DaemonHandle, title: string): Promise<Locator> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // RepoCombobox portals its list over the form. Close it before reaching fields below.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Plan how archive exports should work.");
  await dialog.getByRole("button", { name: /^Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(title);
  return dialog;
}

/** Add the open form's task to the backlog and wait for the daemon to accept it. */
async function addToBacklog(page: Page, dialog: Locator): Promise<void> {
  const created = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/tasks");
  await dialog.getByRole("button", { name: "Add to backlog" }).click();
  expect((await created).ok()).toBe(true);
  await expect(dialog).toBeHidden();
}

test("the default is chosen on Settings -> Tasks and survives a reload", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/tasks`);
  const card = dashboard.locator('[data-anchor="tasks/grill-first"]');
  await expect(card.getByRole("heading", { name: "Plan tasks" })).toBeVisible();
  const box = grillBox(card);
  await expect(box).toBeEnabled();
  await expect(box).not.toBeChecked();

  const saved = dashboard.waitForResponse((response) =>
    response.url().endsWith("/api/skills/config") && response.request().method() === "PUT");
  await box.check();
  expect((await saved).ok()).toBe(true);

  // Durable, not just drawn: a reload reads the box back from the daemon.
  await dashboard.reload();
  await expect(grillBox(dashboard.locator('[data-anchor="tasks/grill-first"]'))).toBeChecked();
  const skills = (await (await dashboard.request.get(`${daemon.baseURL}/api/skills`)).json()) as {
    planGrillFirst: boolean;
  };
  expect(skills.planGrillFirst).toBe(true);
  await shoot(dashboard, dashboard.locator('[data-anchor="tasks/grill-first"]'), "01-settings-grill-first");
});

test("the dispatch form shows the default for a plan, overrides it per task, and the daemon pins it", async ({
  dashboard,
  daemon,
}) => {
  const turnedOn = await dashboard.request.put(`${daemon.baseURL}/api/skills/config`, {
    data: { planGrillFirst: true },
  });
  expect(turnedOn.ok()).toBe(true);

  // Following the default: the box opens checked for a plan, and the task is pinned on.
  let dialog = await openPlanDispatch(dashboard, daemon, "Plan exports, grilled");
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  await expect(grillBox(dialog)).toHaveCount(0);
  await kind.selectOption("plan");
  await expect(grillBox(dialog)).toBeChecked();
  await expect(dialog.getByText("The agent asks you every open question, a round at a time, before it drafts the plan."))
    .toBeVisible();
  await shoot(dashboard, dialog, "02-dispatch-plan-follows-default");
  // Only a plan task grills first, so no other kind offers it.
  await kind.selectOption("ship");
  await expect(grillBox(dialog)).toHaveCount(0);
  await kind.selectOption("plan");
  await addToBacklog(dashboard, dialog);
  expect(await storedTask(daemon, dashboard, "Plan exports, grilled")).toMatchObject({
    kind: "plan",
    status: "backlog",
    grillFirst: true,
  });

  // Overriding it for one task: unchecked here, pinned off, and the default is untouched.
  dialog = await openPlanDispatch(dashboard, daemon, "Plan exports, straight");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("plan");
  await grillBox(dialog).uncheck();
  await expect(dialog.getByText("The agent drafts the plan straight from this request.")).toBeVisible();
  await shoot(dashboard, dialog, "03-dispatch-plan-override-off");
  await addToBacklog(dashboard, dialog);
  expect((await storedTask(daemon, dashboard, "Plan exports, straight")).grillFirst).toBe(false);
  const skills = (await (await dashboard.request.get(`${daemon.baseURL}/api/skills`)).json()) as {
    planGrillFirst: boolean;
  };
  expect(skills.planGrillFirst).toBe(true);
});

test("the backlog editor reads a plan task's pin back and saves a change to it", async ({ dashboard, daemon }) => {
  const created = await dashboard.request.post(`${daemon.baseURL}/api/tasks`, {
    data: {
      repoRoot: daemon.repo,
      intent: "Plan how archive imports should work.",
      title: "Plan imports",
      kind: "plan",
      grillFirst: true,
      backlog: true,
    },
  });
  expect(created.ok()).toBe(true);
  const task = (await created.json()) as TaskRow;
  expect(task.grillFirst).toBe(true);

  // Board layout, so the backlog card is on screen to open.
  const layout = await dashboard.request.put(`${daemon.baseURL}/api/ui/config`, { data: { layout: "board" } });
  expect(layout.ok()).toBe(true);
  await dashboard.reload();
  const card = dashboard.locator(".bl-card", { hasText: "Plan imports" });
  await card.getByRole("button", { name: "Plan imports", exact: true }).click();
  const editor = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(grillBox(editor)).toBeChecked();

  await grillBox(editor).uncheck();
  const saved = dashboard.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === `/api/tasks/${task.id}/update`);
  await editor.getByRole("button", { name: "Save" }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  expect(JSON.parse(response.request().postData() ?? "{}")).toEqual({ grillFirst: false });
  await expect(editor).toBeHidden();
  expect((await storedTask(daemon, dashboard, "Plan imports")).grillFirst).toBe(false);
});

test("an explicit Grill me first off survives switching a backlog task into plan", async ({ dashboard, daemon }) => {
  const turnedOn = await dashboard.request.put(`${daemon.baseURL}/api/skills/config`, { data: { planGrillFirst: true } });
  expect(turnedOn.ok()).toBe(true);
  const created = await dashboard.request.post(`${daemon.baseURL}/api/tasks`, {
    data: { repoRoot: daemon.repo, intent: "Work out the export format.", title: "Becomes a plan", kind: "ship", backlog: true },
  });
  expect(created.ok()).toBe(true);
  const task = (await created.json()) as TaskRow;

  const layout = await dashboard.request.put(`${daemon.baseURL}/api/ui/config`, { data: { layout: "board" } });
  expect(layout.ok()).toBe(true);
  await dashboard.reload();
  const card = dashboard.locator(".bl-card", { hasText: "Becomes a plan" });
  await card.getByRole("button", { name: "Becomes a plan", exact: true }).click();
  const editor = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(grillBox(editor)).toHaveCount(0);

  // Into plan, the box follows the default; clearing it is the operator's answer, and it must
  // reach the daemon even though it matches what the ship task stored.
  await editor.getByRole("combobox", { name: "Kind", exact: true }).selectOption("plan");
  await expect(grillBox(editor)).toBeChecked();
  await grillBox(editor).uncheck();
  await expect(editor.getByText("The agent drafts the plan straight from this request.")).toBeVisible();
  const saved = dashboard.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === `/api/tasks/${task.id}/update`);
  await editor.getByRole("button", { name: "Save" }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  expect(JSON.parse(response.request().postData() ?? "{}")).toMatchObject({ kind: "plan", grillFirst: false });
  await expect(editor).toBeHidden();
  expect(await storedTask(daemon, dashboard, "Becomes a plan")).toMatchObject({ kind: "plan", grillFirst: false });
});

test("the dispatch form claims no answer until it knows the default", async ({ dashboard, daemon }) => {
  const turnedOn = await dashboard.request.put(`${daemon.baseURL}/api/skills/config`, { data: { planGrillFirst: true } });
  expect(turnedOn.ok()).toBe(true);
  // A plan draft, kept by the dispatch surface across a close.
  let dialog = await openPlanDispatch(dashboard, daemon, "Plan exports, waiting");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("plan");
  await expect(grillBox(dialog)).toBeChecked();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();

  // Reopened with the Skills read held: the box is indeterminate and cannot be used yet.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await dashboard.route("**/api/skills", async (route) => {
    if (route.request().method() === "GET") await gate;
    await route.continue();
  });
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(grillBox(dialog)).toBeDisabled();
  await expect(grillBox(dialog)).toBeChecked({ indeterminate: true });
  await expect(dialog.getByText("Reading the default from Settings → Tasks…")).toBeVisible();
  await shoot(dashboard, dialog, "04-dispatch-default-loading");
  release();
  await expect(grillBox(dialog)).toBeEnabled();
  await expect(grillBox(dialog)).toBeChecked();
  await dashboard.unroute("**/api/skills");
});

test("a default that cannot be read is said so, and the box still chooses for the task", async ({ dashboard, daemon }) => {
  await dashboard.route("**/api/skills", (route) =>
    route.request().method() === "GET" ? route.fulfill({ status: 500, body: "unavailable" }) : route.continue());
  const dialog = await openPlanDispatch(dashboard, daemon, "Plan exports, unread default");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("plan");
  await expect(grillBox(dialog)).toBeEnabled();
  await expect(grillBox(dialog)).toBeChecked({ indeterminate: true });
  await expect(dialog.getByText("Follows the Settings → Tasks default, which could not be read.", { exact: false }))
    .toBeVisible();
  await expect(dialog.getByText("The agent drafts the plan straight from this request.")).toHaveCount(0);
  await shoot(dashboard, dialog, "05-dispatch-default-unreadable");

  await grillBox(dialog).check();
  await expect(grillBox(dialog)).toBeChecked();
  await grillBox(dialog).uncheck();
  await addToBacklog(dashboard, dialog);
  expect((await storedTask(daemon, dashboard, "Plan exports, unread default")).grillFirst).toBe(false);
});
