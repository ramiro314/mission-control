import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { writeGhPullRequests } from "../fixtures/fake-agents.ts";

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
const TASK = "Shape how exports should work for the archives library";
const PR_URL = "https://github.com/example/demo-repo/pull/31";

interface TaskRow {
  id: string;
  title: string;
  kind: string;
  status: string;
  workflowId: string | null;
  repoRoot: string;
  worktreePath: string | null;
  sessionId: string | null;
  error: string | null;
  shapeTickets?: { state: string | null; followupTaskId: string | null; canCreate: boolean } | null;
}

interface SessionRow {
  id: string;
  state: string;
  agent: string;
  cwd: string;
  agentSessionId: string | null;
}

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/shape-create-tickets/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

const tasks = (daemon: DaemonHandle): Promise<TaskRow[]> => api<TaskRow[]>(daemon, "/api/tasks");

/** Dispatch a shape task with After work None, so its PR is the plan's own. */
async function dispatchShape(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("shape");
  await dialog.getByRole("combobox", { name: "After work", exact: true }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** The dispatched shape session once its first turn settled, and its task once provisioned. */
async function settled(daemon: DaemonHandle): Promise<{ session: SessionRow; task: TaskRow }> {
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
async function announcePullRequest(daemon: DaemonHandle, session: SessionRow): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  for (const [event, body] of [
    ["PostToolUse", { toolName: "Bash", prCreated: true, prUrl: PR_URL, prUrls: [PR_URL] }],
    ["Stop", {}],
  ] as const) {
    const response = await fetch(`${daemon.baseURL}/hooks/${event}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": token },
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
function scriptPullRequest(daemon: DaemonHandle, task: TaskRow, merged: boolean): void {
  writeGhPullRequests(daemon.home, [{
    cwd: task.worktreePath!,
    url: PR_URL,
    number: 31,
    state: merged ? "MERGED" : "OPEN",
    createdAt: new Date().toISOString(),
    mergedAt: merged ? new Date().toISOString() : null,
    headRefOid: "0".repeat(40),
  }]);
}

async function openSitrep(page: Page): Promise<Locator> {
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
  await page.keyboard.press("Shift+P");
  await expect(page.getByRole("heading", { name: "Sitrep" })).toBeVisible();
  return page.locator(".report-section").filter({
    has: page.getByRole("heading", { name: /Recent outcomes/ }),
  });
}

async function setShapeSkills(daemon: DaemonHandle, grill: boolean): Promise<void> {
  await api(daemon, "/api/skills/config", {
    enabled: true,
    skills: { grill, "html-plans": true, tickets: true },
  }, "PUT");
}

/** Dispatch a shape task, open its plan PR, and merge it: the task completes through the merge. */
async function mergedShapeTask(page: Page, daemon: DaemonHandle): Promise<TaskRow> {
  await setShapeSkills(daemon, true);
  await dispatchShape(page, daemon);
  const { session, task } = await settled(daemon);
  // The agent's own branch, as a shaping session cuts one before opening its plan PR.
  execFileSync("git", ["-C", task.worktreePath!, "switch", "-q", "-c", "plans/exports"]);
  await announcePullRequest(daemon, session);
  scriptPullRequest(daemon, task, false);
  await expect
    .poll(async () => (await api<Array<{ url: string }>>(daemon, "/api/inspector/prs")).map((p) => p.url))
    .toEqual([PR_URL]);

  // Before the merge the task is not done, so nothing is offered. The dispatch stamped it as
  // delivered under the contract that defers tickets to the merge; no plan review was answered.
  const running = (await tasks(daemon)).find((t) => t.id === task.id)!;
  expect(running.shapeTickets).toEqual({ state: "awaiting-review", followupTaskId: null, canCreate: false });

  // The plan PR merges; the poller observes it and merge settlement takes the shape task to done.
  scriptPullRequest(daemon, task, true);
  await expect
    .poll(async () => (await tasks(daemon)).find((t) => t.id === task.id)?.status, {
      timeout: 60_000,
      message: "the shape task completes through its plan PR merge",
    })
    .toBe("done");
  // No Create tickets choice was recorded, so the merge started nothing on its own.
  const source = (await tasks(daemon)).find((t) => t.id === task.id)!;
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
