import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { writeGhPullRequests } from "../fixtures/fake-agents.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * A stacked task's base branch, moved from the session footer once its base merged (#771).
 *
 * The task is filed on `feat/base`, a real branch on the fixture repository's bare origin, and
 * dispatched to the fake agent. The daemon asks `gh` where `feat/base`'s pull request merged,
 * so the fake `gh` is scripted to say `main`, and the branch is deleted on origin the way
 * GitHub deletes a merged head. No model tokens are spent.
 */

const EVIDENCE = artifactsDir("task-base-branch-move");
const TITLE = "Stacked on the base";
const BASE_PR = "https://github.com/mc-e2e-fixture/demo-repo/pull/41";

async function shoot(page: Page, name: string, target: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/task-base-branch-move/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

/**
 * The commit `feat/base` was pushed at, which is `main`'s tip. The daemon only moves a base for
 * a merged pull request whose head carries the commit the task started from, so the fake `gh`
 * reports this real head rather than a placeholder.
 */
function baseTip(daemon: DaemonHandle): string {
  return execFileSync("git", ["-C", daemon.repo, "rev-parse", "main"], { stdio: "pipe" }).toString().trim();
}

type TaskReply = { id: string; status: string; baseBranch: string | null; baseBranchMove: unknown };

async function taskById(daemon: DaemonHandle, id: string): Promise<TaskReply | undefined> {
  return (await api<TaskReply[]>(daemon, "/api/tasks")).find((task) => task.id === id);
}

test("a running task's base moves to where its base branch merged, from the session footer", async ({ dashboard, daemon }) => {
  execFileSync("git", ["-C", daemon.repo, "push", "-q", "origin", "main:refs/heads/feat/base"], { stdio: "pipe" });
  const filed = await api<TaskReply>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: TITLE, intent: "Build on the base branch.", kind: "ship",
    backlog: true, workflowId: null, baseBranch: "feat/base",
  });
  expect(filed.baseBranch).toBe("feat/base");
  await api(daemon, `/api/tasks/${filed.id}/dispatch`, {});
  await expect.poll(async () => (await taskById(daemon, filed.id))?.status, { timeout: 60_000 })
    .toBe("running");

  const row = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: TITLE });
  await expect(row).toHaveCount(1, { timeout: 60_000 });
  await row.click();
  const card = dashboard.locator(".console-detail");
  const move = card.getByRole("button", { name: "move base" });
  await expect(move).toBeVisible();
  const flash = card.locator(".action-flash");

  // Before the base branch's pull request merges, the daemon has nowhere to move it.
  await move.click();
  await expect(flash).toHaveText("base branch feat/base has no merged pull request, so it has nowhere to move yet");
  await shoot(dashboard, "01-refused-before-merge", card);

  // GitHub merges `feat/base`'s pull request into `main` and deletes the branch.
  writeGhPullRequests(daemon.home, [{
    cwd: daemon.repo, url: BASE_PR, number: 41, state: "MERGED",
    createdAt: "2026-11-01T09:00:00Z", mergedAt: "2026-11-01T10:00:00Z",
    headRefOid: baseTip(daemon), baseRefName: "main",
  }]);
  execFileSync("git", ["-C", daemon.repo, "push", "-q", "origin", ":refs/heads/feat/base"], { stdio: "pipe" });

  const moved = dashboard.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith(`/api/tasks/${filed.id}/base-branch/move`));
  await move.click();
  expect((await moved).status()).toBe(200);
  await expect(flash).toHaveText("base moved from feat/base to main");
  // Moved onto origin's default, so there is nowhere further to move it and the control goes.
  await expect(move).toHaveCount(0);
  await shoot(dashboard, "02-moved", card);

  const task = (await taskById(daemon, filed.id))!;
  expect(task.status).toBe("running");
  expect(task.baseBranch).toBe("main");
  expect(task.baseBranchMove).toMatchObject({ from: "feat/base", to: "main", toDefault: true, prUrl: BASE_PR });
});

test("a base moved onto a non-default branch keeps the control, naming the new base", async ({ dashboard, daemon }) => {
  // A stack of three: this task sits on `feat/base`, which merged into `feat/mid`, which has
  // not merged yet. The control stays so the next merge can be followed the same way.
  for (const branch of ["feat/base", "feat/mid"]) {
    execFileSync("git", ["-C", daemon.repo, "push", "-q", "origin", `main:refs/heads/${branch}`], { stdio: "pipe" });
  }
  const filed = await api<TaskReply>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: TITLE, intent: "Build on the base branch.", kind: "ship",
    backlog: true, workflowId: null, baseBranch: "feat/base",
  });
  await api(daemon, `/api/tasks/${filed.id}/dispatch`, {});
  await expect.poll(async () => (await taskById(daemon, filed.id))?.status, { timeout: 60_000 }).toBe("running");
  writeGhPullRequests(daemon.home, [{
    cwd: daemon.repo, url: BASE_PR, number: 41, state: "MERGED",
    createdAt: "2026-11-01T09:00:00Z", mergedAt: "2026-11-01T10:00:00Z",
    headRefOid: baseTip(daemon), baseRefName: "feat/mid",
  }]);

  const row = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: TITLE });
  await expect(row).toHaveCount(1, { timeout: 60_000 });
  await row.click();
  const card = dashboard.locator(".console-detail");
  const move = card.getByRole("button", { name: "move base" });
  await expect(move).toHaveAccessibleDescription(/^Move this task's base from feat\/base /);
  await move.click();
  await expect(card.locator(".action-flash")).toHaveText("base moved from feat/base to feat/mid");
  await expect(move).toBeVisible();
  await expect(move).toHaveAccessibleDescription(/^Move this task's base from feat\/mid /);
  await shoot(dashboard, "03-moved-onto-mid", card);

  const task = (await taskById(daemon, filed.id))!;
  expect(task.baseBranch).toBe("feat/mid");
  expect(task.baseBranchMove).toMatchObject({ from: "feat/base", to: "feat/mid", toDefault: false });
});

test("a task sent back and stacked again is offered the move, despite its earlier move onto main", async ({ dashboard, daemon }) => {
  for (const branch of ["feat/base", "feat/other"]) {
    execFileSync("git", ["-C", daemon.repo, "push", "-q", "origin", `main:refs/heads/${branch}`], { stdio: "pipe" });
  }
  const filed = await api<TaskReply>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: TITLE, intent: "Build on the base branch.", kind: "ship",
    backlog: true, workflowId: null, baseBranch: "feat/base",
  });
  await api(daemon, `/api/tasks/${filed.id}/dispatch`, {});
  await expect.poll(async () => (await taskById(daemon, filed.id))?.status, { timeout: 60_000 }).toBe("running");
  writeGhPullRequests(daemon.home, [{
    cwd: daemon.repo, url: BASE_PR, number: 41, state: "MERGED",
    createdAt: "2026-11-01T09:00:00Z", mergedAt: "2026-11-01T10:00:00Z",
    headRefOid: baseTip(daemon), baseRefName: "main",
  }]);
  execFileSync("git", ["-C", daemon.repo, "push", "-q", "origin", ":refs/heads/feat/base"], { stdio: "pipe" });
  await api(daemon, `/api/tasks/${filed.id}/base-branch/move`, {});
  expect((await taskById(daemon, filed.id))?.baseBranchMove).toMatchObject({ to: "main", toDefault: true });

  // Back to the backlog, onto a new stacked base, and out again. The move record onto `main`
  // stays on the task, and must not hide the control for a base it does not describe.
  await api(daemon, `/api/tasks/${filed.id}/requeue`, {});
  await expect.poll(async () => (await taskById(daemon, filed.id))?.status, { timeout: 60_000 }).toBe("backlog");
  await api(daemon, `/api/tasks/${filed.id}/update`, { baseBranch: "feat/other" });
  await api(daemon, `/api/tasks/${filed.id}/dispatch`, {});
  await expect.poll(async () => (await taskById(daemon, filed.id))?.status, { timeout: 60_000 }).toBe("running");
  const again = (await taskById(daemon, filed.id))!;
  expect(again.baseBranch).toBe("feat/other");
  expect(again.baseBranchMove).toMatchObject({ to: "main", toDefault: true });

  const card = dashboard.locator(".console-detail");
  const move = card.getByRole("button", { name: "move base" });
  const rows = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: TITLE });
  // The first session may still be leaving the rail; the live one is the one offering the move.
  await expect(async () => {
    await rows.first().click();
    await expect(move).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(move).toHaveAccessibleDescription(/^Move this task's base from feat\/other /);
  await shoot(dashboard, "04-offered-after-restack", card);
});
