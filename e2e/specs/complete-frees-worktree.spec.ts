import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { settled } from "../fixtures/settle.ts";

const EVIDENCE = artifactsDir("complete-frees-worktree");

/**
 * "Free this task's worktree" on the Complete dialog.
 *
 * The claims only a browser can settle: the box is there and ticked for a clean task, clear
 * with its reason for a dirty one, absent when there is nothing to free; confirming it
 * returns the pool slot; and a free the daemon refuses after stopping the agent is reported
 * in the dialog while the task still reads done. Unchecked Complete keeps the tree, as it
 * always has.
 *
 * No model tokens: every dispatched agent is `e2e/fixtures/fake-agents.ts`.
 */

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/complete-frees-worktree/${name}.png`);
}

interface TaskRow {
  id: string;
  status: string;
  worktreePath: string | null;
}

/** Dispatch one ship task, wait for its agent to settle, and return its task and checkout. */
async function dispatchIdle(page: Page, daemon: DaemonHandle, intent: string): Promise<TaskRow> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // Closes the portalled repo listbox, not the modal - see dispatch-and-converse.spec.ts.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let task: TaskRow | undefined;
  await expect.poll(async () => {
    const sessions = await api<Array<{ state: string; task: { id: string } | null }>>(
      daemon,
      "/api/sessions",
    );
    const live = sessions.find((s) => s.state !== "exited" && s.task);
    if (!live?.task) return "";
    task = (await api<TaskRow[]>(daemon, "/api/tasks")).find((t) => t.id === live.task!.id);
    return task?.worktreePath ? live.state : "";
  }, { timeout: 60_000 }).toBe("idle");
  return task!;
}

async function openComplete(page: Page): Promise<Locator> {
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const complete = page.locator(".console-detail").getByRole("button", { name: "Complete" });
  await expect(complete).toBeVisible();
  await settled(complete);
  await complete.click();
  const dialog = page.getByRole("dialog", { name: "Complete task and close session" });
  await expect(dialog).toBeVisible();
  return dialog;
}

const taskById = async (daemon: DaemonHandle, id: string): Promise<TaskRow | undefined> =>
  (await api<TaskRow[]>(daemon, "/api/tasks")).find((t) => t.id === id);

test("a clean task's box is ticked, and confirming it returns the slot", async ({ dashboard, daemon }) => {
  const task = await dispatchIdle(dashboard, daemon, "free me when done");
  const dialog = await openComplete(dashboard);

  const free = dialog.getByRole("checkbox", { name: "Free this task's worktree" });
  await expect(free).toBeVisible();
  await expect(free).toBeChecked();
  await expect(dialog.getByText("Also closes this task's terminal")).toBeVisible();
  await expectContentClearsBorder(dialog);
  await shoot(dialog, "01-clean-task-box-ticked");

  await dialog.getByRole("button", { name: "Complete & close" }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect(dashboard.getByRole("status").filter({ hasText: "Task completed · worktree freed" }))
    .toBeVisible();

  await expect.poll(async () => {
    const row = await taskById(daemon, task.id);
    return `${row?.status} ${row?.worktreePath}`;
  }).toBe("done null");

  // The Worktrees view shows the slot the task held back in the pool.
  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const pool = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = pool.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const slot = pool.locator(".wt-slot", { hasText: task.worktreePath! });
  await expect(slot).toBeVisible();
  await expect(slot.locator(".wt-slot-head")).toContainText("available");
  await expect(slot.locator(".wt-owner")).toHaveCount(0);
  await shoot(dashboard, "02-slot-available-after-free");
});

test("a dirty task's box starts clear with the reason, and unchecked Complete keeps the tree", async ({
  dashboard,
  daemon,
}) => {
  const task = await dispatchIdle(dashboard, daemon, "leave uncommitted work behind");
  writeFileSync(join(task.worktreePath!, "unsaved-notes.txt"), "not committed\n");
  const dialog = await openComplete(dashboard);

  const free = dialog.getByRole("checkbox", { name: "Free this task's worktree" });
  await expect(free).toBeVisible();
  await expect(free).not.toBeChecked();
  await expect(dialog.getByText("it has 1 uncommitted file(s)")).toBeVisible();
  await expectContentClearsBorder(dialog);
  await shoot(dialog, "03-dirty-task-box-clear-with-reason");

  await dialog.getByRole("button", { name: "Complete & close" }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect.poll(async () => {
    const row = await taskById(daemon, task.id);
    return `${row?.status} ${row?.worktreePath}`;
  }).toBe(`done ${task.worktreePath}`);
});

test("ticking a dirty task's box sends discardWork and frees the tree anyway", async ({
  dashboard,
  daemon,
}) => {
  const task = await dispatchIdle(dashboard, daemon, "discard my uncommitted work");
  writeFileSync(join(task.worktreePath!, "throwaway.txt"), "not worth keeping\n");
  const dialog = await openComplete(dashboard);
  const free = dialog.getByRole("checkbox", { name: "Free this task's worktree" });
  await expect(free).not.toBeChecked();
  await expect(dialog.getByText("it has 1 uncommitted file(s)")).toBeVisible();

  // The operator's deliberate act: the only way uncommitted work is ever freed.
  await free.check();
  const request = dashboard.waitForRequest((r) =>
    r.method() === "POST" && r.url().endsWith(`/api/tasks/${task.id}/complete`));
  await dialog.getByRole("button", { name: "Complete & close" }).click();
  expect((await request).postDataJSON()).toMatchObject({ freeWorktree: "discardWork" });

  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect.poll(async () => {
    const row = await taskById(daemon, task.id);
    return `${row?.status} ${row?.worktreePath}`;
  }).toBe("done null");
});

test("a preview that fails hides the box and does not block Complete", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.route("**/api/tasks/*/free-preview", (route) =>
    route.fulfill({ status: 500, json: { error: "boom" } }));
  const task = await dispatchIdle(dashboard, daemon, "preview goes wrong");
  const dialog = await openComplete(dashboard);
  await expect(dialog.getByText("checking…")).toHaveCount(0);
  await expect(dialog.getByRole("checkbox", { name: /Free this task's/ })).toHaveCount(0);

  const request = dashboard.waitForRequest((r) =>
    r.method() === "POST" && r.url().endsWith(`/api/tasks/${task.id}/complete`));
  await dialog.getByRole("button", { name: "Complete & close" }).click();
  expect((await request).postDataJSON()).not.toHaveProperty("freeWorktree");
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect.poll(async () => {
    const row = await taskById(daemon, task.id);
    return `${row?.status} ${row?.worktreePath}`;
  }).toBe(`done ${task.worktreePath}`);
});

test("a completion that frees nothing still stops the agent and claims no free", async ({
  dashboard,
  daemon,
}) => {
  const task = await dispatchIdle(dashboard, daemon, "nothing freed after all");
  const dialog = await openComplete(dashboard);
  await expect(dialog.getByRole("checkbox", { name: "Free this task's worktree" })).toBeChecked();

  // The daemon answers a real completion without `freed: true` - as it does when the task
  // has nothing left to free by confirm time - because the option is dropped in flight.
  await dashboard.route(`**/api/tasks/${task.id}/complete`, async (route) => {
    const { freeWorktree: _dropped, ...body } = route.request().postDataJSON();
    await route.continue({ postData: JSON.stringify(body) });
  });
  const kill = dashboard.waitForRequest((r) => r.method() === "POST" && /\/api\/sessions\/[^/]+\/kill$/.test(r.url()));
  await dialog.getByRole("button", { name: "Complete & close" }).click();
  await kill;
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect(dashboard.getByText("Task completed · worktree freed")).toHaveCount(0);
  await expect.poll(async () => {
    const row = await taskById(daemon, task.id);
    return `${row?.status} ${row?.worktreePath}`;
  }).toBe(`done ${task.worktreePath}`);
  await expect.poll(async () => {
    const sessions = await api<Array<{ state: string; task: { id: string } | null }>>(daemon, "/api/sessions");
    return sessions.find((s) => s.task?.id === task.id)?.state ?? "removed";
  }, { timeout: 30_000 }).toMatch(/^(stopping|exited|removed)$/);
});

test("a free the daemon refuses after stopping the agent is reported while the task reads done", async ({
  dashboard,
  daemon,
}) => {
  const task = await dispatchIdle(dashboard, daemon, "change after the preview");
  const dialog = await openComplete(dashboard);
  const free = dialog.getByRole("checkbox", { name: "Free this task's worktree" });
  await expect(free).toBeChecked();

  // The tree becomes unsafe after the preview answered. `ifSafe` re-checks on the server
  // after the agent is stopped, so the daemon keeps the tree and says why.
  writeFileSync(join(task.worktreePath!, "late-change.txt"), "written after the preview\n");
  await dialog.getByRole("button", { name: "Complete & close" }).click();

  await expect(dialog.getByText(
    "Task completed, but the worktree could not be freed: worktree kept: it has 1 uncommitted file(s)",
  )).toBeVisible({ timeout: 60_000 });
  await shoot(dialog, "04-refused-free-reported");
  const row = await taskById(daemon, task.id);
  expect(row?.status).toBe("done");
  expect(row?.worktreePath).toBe(task.worktreePath);
});

test("the box is absent when the task has nothing Mission Control provisioned", async ({
  dashboard,
  daemon,
}) => {
  // An assigned or pipeline task answers `applicable: false`; that rule is pinned in
  // test/complete-frees-worktree.test.ts. Here the answer is fixed so the spec asserts what
  // the dialog does with it without staging a tmux handover.
  await dashboard.route("**/api/tasks/*/free-preview", (route) =>
    route.fulfill({ json: { applicable: false, freeable: false, reasons: [] } }));
  await dispatchIdle(dashboard, daemon, "nothing to free here");
  const dialog = await openComplete(dashboard);
  await expect(dialog.getByRole("button", { name: "Complete & close" })).toBeEnabled();
  await expect(dialog.getByRole("checkbox", { name: /Free this task's/ })).toHaveCount(0);
  await expect(dialog.getByText("checking…")).toHaveCount(0);
  await expect(dialog.getByText("Also closes this task's terminal")).toHaveCount(0);
});
