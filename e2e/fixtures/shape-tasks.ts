import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect } from "./test.ts";
import type { DaemonHandle } from "./daemon.ts";
import { writeGhPullRequests } from "./fake-agents.ts";

/**
 * Driving a shape task to its plan PR merge, shared by the specs about what that merge does
 * to its tickets (`shape-create-tickets.spec.ts`, `shape-tickets-marker.spec.ts`).
 *
 * Every agent binary is the fake (`fake-agents.ts`), and `gh` is the fake too, so the merge is
 * one the real PR poller observes and settles. No model tokens are spent.
 */

export const SHAPE_TASK = "Shape how exports should work for the archives library";

export interface ShapeTicketsRow {
  state: string | null;
  followupTaskId: string | null;
  canCreate: boolean;
}

export interface TaskRow {
  id: string;
  title: string;
  kind: string;
  status: string;
  workflowId: string | null;
  repoRoot: string;
  worktreePath: string | null;
  sessionId: string | null;
  error: string | null;
  shapeTickets?: ShapeTicketsRow | null;
}

export interface SessionRow {
  id: string;
  state: string;
  agent: string;
  cwd: string;
  agentSessionId: string | null;
}

export async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

export const tasks = (daemon: DaemonHandle): Promise<TaskRow[]> => api<TaskRow[]>(daemon, "/api/tasks");

export const harnessToken = (daemon: DaemonHandle): string =>
  readFileSync(join(daemon.home, "token"), "utf8").trim();

/** Dispatch a shape task with After work None, so its PR is the plan's own. */
export async function dispatchShape(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(SHAPE_TASK);
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("shape");
  await dialog.getByRole("combobox", { name: "After work", exact: true }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** The dispatched shape session once its first turn settled, and its task once provisioned. */
export async function settled(daemon: DaemonHandle): Promise<{ session: SessionRow; task: TaskRow }> {
  let session: SessionRow | undefined;
  await expect
    .poll(async () => {
      session = (await api<SessionRow[]>(daemon, "/api/sessions")).find((s) => s.state !== "exited");
      return session?.state ?? "";
    }, { timeout: 60_000, message: "the dispatched shape session should settle" })
    .toBe("idle");
  let task: TaskRow | undefined;
  await expect
    .poll(async () => {
      task = (await tasks(daemon)).find((t) => t.kind === "shape");
      return Boolean(task?.worktreePath);
    }, { message: "the shape task records its worktree" })
    .toBe(true);
  return { session: session!, task: task! };
}

/** The hook a harness fires when `gh pr create` returns, then the turn ending. */
export async function announcePullRequest(daemon: DaemonHandle, session: SessionRow, prUrl: string): Promise<void> {
  for (const [event, body] of [
    ["PostToolUse", { toolName: "Bash", prCreated: true, prUrl, prUrls: [prUrl] }],
    ["Stop", {}],
  ] as const) {
    const response = await fetch(`${daemon.baseURL}/hooks/${event}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": harnessToken(daemon) },
      body: JSON.stringify({
        agent: session.agent,
        sessionId: session.agentSessionId ?? session.id,
        cwd: session.cwd,
        ...body,
      }),
    });
    if (!response.ok) throw new Error(`${event} answered ${response.status}: ${await response.text()}`);
  }
}

/** What `gh` reports for the shape task's checkout from now on. */
export function scriptPullRequest(daemon: DaemonHandle, task: TaskRow, prUrl: string, merged: boolean): void {
  writeGhPullRequests(daemon.home, [{
    cwd: task.worktreePath!,
    url: prUrl,
    number: Number(prUrl.split("/").pop()),
    state: merged ? "MERGED" : "OPEN",
    createdAt: new Date().toISOString(),
    mergedAt: merged ? new Date().toISOString() : null,
    headRefOid: "0".repeat(40),
  }]);
}

/** Open the Sitrep and return its Recent outcomes section. */
export async function openSitrep(page: Page): Promise<Locator> {
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
  await page.keyboard.press("Shift+P");
  await expect(page.getByRole("heading", { name: "Sitrep" })).toBeVisible();
  return page.locator(".report-section").filter({
    has: page.getByRole("heading", { name: /Recent outcomes/ }),
  });
}

/** The shape kind's three skills, `grill` on or off; off refuses a shape launch. */
export async function setShapeSkills(daemon: DaemonHandle, grill: boolean): Promise<void> {
  await api(daemon, "/api/skills/config", {
    enabled: true,
    skills: { grill, "html-plans": true, tickets: true },
  }, "PUT");
}

/** Open the shape task's plan PR, so the next `scriptPullRequest(..., true)` merges it. */
export async function openPlanPullRequest(
  daemon: DaemonHandle,
  session: SessionRow,
  task: TaskRow,
  prUrl: string,
): Promise<void> {
  // The agent's own branch, as a shaping session cuts one before opening its plan PR.
  execFileSync("git", ["-C", task.worktreePath!, "switch", "-q", "-c", "plans/exports"]);
  await announcePullRequest(daemon, session, prUrl);
  scriptPullRequest(daemon, task, prUrl, false);
  await expect
    .poll(async () => (await api<Array<{ url: string }>>(daemon, "/api/inspector/prs")).map((p) => p.url))
    .toEqual([prUrl]);
}

/** Merge the plan PR and wait for merge settlement to take the shape task to done. */
export async function mergePlanPullRequest(daemon: DaemonHandle, task: TaskRow, prUrl: string): Promise<TaskRow> {
  scriptPullRequest(daemon, task, prUrl, true);
  await expect
    .poll(async () => (await tasks(daemon)).find((t) => t.id === task.id)?.status, {
      timeout: 60_000,
      message: "the shape task completes through its plan PR merge",
    })
    .toBe("done");
  return (await tasks(daemon)).find((t) => t.id === task.id)!;
}
