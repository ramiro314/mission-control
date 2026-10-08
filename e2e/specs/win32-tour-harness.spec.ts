import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * Every server tour recipe prefers Codex, which win32 refuses (D37 in
 * `docs/plans/windows-support/plan.md`). On such a host `tourCreateFor` launches the tour's
 * tasks on a harness the host runs, so both tours that start a live session still reach it.
 *
 * `MC_E2E_WIN32_HOST` builds the production daemon with only its host-platform answer
 * replaced (`e2e/fixtures/win32-host-build.ts`), so this runs on every runner.
 */
test.use({ daemonEnv: { MC_E2E_WIN32_HOST: "1" } });
test.describe.configure({ timeout: 120_000 });

const EVIDENCE = artifactsDir("win32-tour-harness");

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
}

function step(page: Page, title: string): Locator {
  return page.getByRole("dialog", { name: title }).or(page.getByRole("status", { name: title }));
}

interface TourTask { title: string; agent: string; model: string | null; status: string; outcome: string | null }

/** Stand in for the demo agent calling `request_input`, over the channel that tool uses. */
async function raiseTourReview(daemon: DaemonHandle): Promise<void> {
  let cwd: string | null = null;
  await expect.poll(async () => {
    const sessions = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as Array<{ cwd: string | null; task?: { title: string } }>;
    cwd = sessions.find((session) => session.task?.title === "Tour demo")?.cwd ?? null;
    return cwd;
  }, { timeout: 30_000 }).toBeTruthy();
  const question = "Which review path should this demo take?";
  const response = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": readFileSync(join(daemon.home, "token"), "utf8").trim() },
    body: JSON.stringify({
      env: {}, cwd, kind: "input", title: question, body: question,
      decisions: [{ id: "q", question, options: [{ id: "o0", label: "Looks good" }, { id: "o1", label: "Show me later" }] }],
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function tourTask(daemon: DaemonHandle, title: string): Promise<TourTask | undefined> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`);
  return ((await response.json()) as TourTask[]).find((task) => task.title === title);
}

test("See the work walks its conversation and demo to completion on a harness the host supports", async ({ dashboard, daemon }) => {
  await dashboard.emulateMedia({ reducedMotion: "reduce" });
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  await dashboard.getByRole("button", { name: "Start See the work tour" }).click();
  for (const title of ["Fleet and the Line", "Board View"]) {
    await step(dashboard, title).getByRole("button", { name: "Next" }).click();
  }

  const desk = step(dashboard, "Session detail");
  await expect(dashboard.getByRole("tablist", { name: "Session detail" })).toBeVisible({ timeout: 30_000 });
  await expect(desk).not.toContainText("could not start");
  await expect.poll(async () => (await tourTask(daemon, "Tour conversation"))?.agent).toBe("claude");
  await shoot(dashboard, "see-work-session-detail");
  await desk.getByRole("button", { name: "Next" }).click();

  await step(dashboard, "Open Dispatch").getByRole("button", { name: "Open Dispatch" }).click();
  await step(dashboard, "Choose the kind").getByRole("button", { name: "Write the brief" }).click();
  await step(dashboard, "Brief ready").getByRole("button", { name: "Choose after work" }).click();
  await step(dashboard, "Choose what follows").getByRole("button", { name: "Review dispatch" }).click();
  await dashboard.getByRole("dialog", { name: "Dispatch an agent" })
    .getByRole("button", { name: "Dispatch now" }).click();

  const working = step(dashboard, "Working");
  await expect(working).toBeVisible({ timeout: 30_000 });
  await expect(working).not.toContainText("could not continue");
  await expect(working.getByRole("button", { name: "Next" })).toBeEnabled({ timeout: 30_000 });
  const demo = await tourTask(daemon, "Tour demo");
  expect({ agent: demo?.agent, model: demo?.model }).toEqual({ agent: "claude", model: null });
  await shoot(dashboard, "see-work-working");

  await expect(dashboard.getByRole("heading", { name: /^working$/i })).toBeVisible();

  // The demo's live lifecycle on the substituted harness: a real review pause, Idle, Complete.
  const review = raiseTourReview(daemon);
  await working.getByRole("button", { name: "Next" }).click();
  const needsYou = step(dashboard, "Needs You");
  await expect(needsYou.getByRole("button", { name: "Open review" })).toBeEnabled({ timeout: 30_000 });
  await review;
  await needsYou.getByRole("button", { name: "Open review" }).click();
  const reviewDialog = dashboard.getByRole("dialog", { name: "Review request" });
  await reviewDialog.getByRole("radio", { name: /Looks good/ }).check();
  await reviewDialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(reviewDialog).toBeHidden();

  const idle = step(dashboard, "Idle");
  await expect(idle).toBeVisible({ timeout: 30_000 });
  await idle.getByRole("button", { name: "Show actions" }).click();
  await step(dashboard, "Complete or run a retro").getByRole("button", { name: "Open Complete" }).click();
  const complete = step(dashboard, "Complete the tour");
  await complete.getByRole("button", { name: "Complete tour" }).click();
  await expect(complete).toBeHidden({ timeout: 30_000 });
  await expect.poll(async () => {
    const tasks = await Promise.all(["Tour conversation", "Tour demo"].map((title) => tourTask(daemon, title)));
    return tasks.map((task) => task && { status: task.status, outcome: task.outcome });
  }).toEqual([
    { status: "done", outcome: "Tour conversation" },
    { status: "done", outcome: "Tour demo" },
  ]);
});

test("Follow the review binds and walks the run from its temporary conversation", async ({ dashboard, daemon }) => {
  await dashboard.emulateMedia({ reducedMotion: "reduce" });
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  await dashboard.getByRole("button", { name: "Start Follow the review tour" }).click();
  await step(dashboard, "Work gets reviewed").getByRole("button", { name: "Open Dispatch" }).click();
  await step(dashboard, "Dispatch picks the workflow").getByRole("button", { name: "Open a session" }).click();

  const binding = step(dashboard, "A binding pins the version");
  await expect(binding).toContainText("Step 3 of 13");
  await expect(dashboard.locator(".workflow-bind-chip")).toBeVisible({ timeout: 60_000 });
  await expect(binding).not.toContainText("could not start");
  await expect.poll(async () => (await tourTask(daemon, "Tour conversation"))?.agent).toBe("claude");
  await shoot(dashboard, "workflows-binding-chip");

  await binding.getByRole("button", { name: "Open Bind workflow" }).click();
  const bindDialog = dashboard.getByRole("dialog", { name: "Bind workflow" });
  await expect(bindDialog).toBeVisible();
  await expect(bindDialog.getByLabel("Session")).toBeDisabled();
  await step(dashboard, "Bind one yourself").getByRole("button", { name: "Open a run" }).click();
  await expect(bindDialog).toBeHidden();

  const run = step(dashboard, "A run walks its stages");
  await expect(run).toContainText("Step 5 of 13");
  await expect(dashboard.getByRole("group", { name: "Workflow run pipeline" })).toBeVisible({ timeout: 30_000 });
  await run.getByRole("button", { name: "Exit tour" }).click();
  await expect(run).toBeHidden({ timeout: 30_000 });
  await expect.poll(async () => (await tourTask(daemon, "Tour conversation"))?.status).toBe("done");
});
