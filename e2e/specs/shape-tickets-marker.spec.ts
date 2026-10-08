import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { WIN32_OCCUPANCY_UNPROVABLE } from "../fixtures/win32-occupancy.ts";
import { skipSpecOnWin32 } from "../../test/helpers/win32-skip.ts";
import {
  api,
  dispatchShape,
  harnessToken,
  mergePlanPullRequest,
  openPlanPullRequest,
  openSitrep,
  setShapeSkills,
  settled,
  tasks,
  type SessionRow,
  type ShapeTicketsRow,
  type TaskRow,
} from "../fixtures/shape-tasks.ts";

/**
 * The tickets marker on a shape task: what will happen to its tickets at the plan's merge, or
 * what happened.
 *
 * What is real: the dispatched shape session, its plan review answered through the review
 * route (which records the choice on the task), the plan PR the fake `gh` reports and the PR
 * poller sees merge, the follow-up the merge starts (or leaves queued), a cancel, the derived
 * `shapeTickets` riding `task_upsert` to the board card, the drawer and the Sitrep, and the
 * click that opens the follow-up. Every agent binary is the fake
 * (`e2e/fixtures/fake-agents.ts`). No model tokens are spent.
 */

const EVIDENCE = artifactsDir("shape-tickets-marker");
const PR_URL = "https://github.com/example/demo-repo/pull/41";
/** The follow-up's title, from the shape task's own (generated) title. */
const followupTitle = (task: TaskRow): string => `Tickets: ${task.title}`;

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/shape-tickets-marker/${name}.png`);
}

const shapeTicketsOf = async (daemon: DaemonHandle, id: string): Promise<ShapeTicketsRow | null | undefined> =>
  (await tasks(daemon)).find((t) => t.id === id)?.shapeTickets;

/** The shaping session's plan review, asked and answered with one `shape-follow-up` option. */
async function chooseFollowUp(daemon: DaemonHandle, session: SessionRow, choice: "create-tickets" | "stop"): Promise<void> {
  const created = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": harnessToken(daemon) },
    body: JSON.stringify({
      env: {},
      sessionId: session.agentSessionId,
      cwd: session.cwd,
      kind: "plan-decisions",
      title: "Archive exports: plan review",
      body: "The plan is at docs/plans/exports/plan.md.",
      decisions: [{
        id: "shape-follow-up",
        question: "What should happen after this plan is approved?",
        options: [
          { id: "create-tickets", label: "Create tickets after the plan merges", recommended: true },
          { id: "stop", label: "Stop" },
        ],
      }],
    }),
  });
  if (!created.ok) throw new Error(`the plan review answered ${created.status}: ${await created.text()}`);
  const { id } = (await created.json()) as { id: string };
  await api(daemon, `/api/reviews/${id}/resolve`, {
    action: "answer",
    selections: [{ decisionId: "shape-follow-up", selected: [choice], other: null }],
  });
}

/** A dispatched shape task whose plan review chose Create tickets, with its plan PR open. */
async function pendingShapeTask(
  page: Page,
  daemon: DaemonHandle,
  { stopFirst = false }: { stopFirst?: boolean } = {},
): Promise<{ session: SessionRow; task: TaskRow; card: Locator }> {
  await setShapeSkills(daemon, true);
  // The Board, whose card and drawer are the marker's first two surfaces.
  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  await page.reload();
  await dispatchShape(page, daemon);
  const { session, task } = await settled(daemon);
  const card = page.locator(".tile").filter({ has: page.getByRole("button", { name: /^Open / }) });
  await expect(card).toHaveCount(1);
  // Awaiting the review is not a state anyone acts on: the card says nothing about tickets.
  expect(await shapeTicketsOf(daemon, task.id)).toMatchObject({ state: "awaiting-review" });
  await expect(card.getByRole("note", { name: /^Tickets/ })).toHaveCount(0);

  if (stopFirst) {
    // Stop is not a state anyone acts on either. A later review still wins.
    await chooseFollowUp(daemon, session, "stop");
    await expect.poll(async () => (await shapeTicketsOf(daemon, task.id))?.state).toBe("stop");
    await expect(card.getByRole("note", { name: /^Tickets/ })).toHaveCount(0);
  }
  await chooseFollowUp(daemon, session, "create-tickets");
  await expect.poll(async () => (await shapeTicketsOf(daemon, task.id))?.state).toBe("pending");
  await openPlanPullRequest(daemon, session, task, PR_URL);
  return { session, task, card };
}

test("pending shows Tickets after merge on the card and in the drawer, then the merge links the started follow-up", async ({
  dashboard,
  daemon,
}) => {
  const { task, card } = await pendingShapeTask(dashboard, daemon);

  // The board card, in its flag row.
  const cardMarker = card.getByRole("note", { name: "Tickets after merge" });
  await expect(cardMarker).toBeVisible();
  await shoot(dashboard, "01-pending-card", card);

  // The drawer, opened from the card through its keyboard control.
  await card.getByRole("button", { name: /^Open / }).press("Enter");
  const drawer = dashboard.getByRole("complementary", { name: "Session detail workspace" });
  await expect(drawer.getByRole("note", { name: "Tickets after merge" })).toBeVisible();
  await shoot(dashboard, "02-pending-drawer", drawer);

  // The plan merges: the follow-up is created and dispatched, and the choice reads started.
  await mergePlanPullRequest(daemon, task, PR_URL);
  let followup: TaskRow | undefined;
  await expect
    .poll(async () => {
      followup = (await tasks(daemon)).find((t) => t.title === followupTitle(task));
      return followup?.status ?? "";
    }, { timeout: 30_000, message: "the merge starts the follow-up" })
    .toMatch(/^(dispatching|running)$/);
  await expect
    .poll(() => shapeTicketsOf(daemon, task.id))
    .toMatchObject({ state: "started", followupTaskId: followup!.id });

  // The shape task is finished, so its Sitrep row carries the marker: a link to the follow-up.
  const outcomes = await openSitrep(dashboard);
  const row = outcomes.locator(".report-row").filter({ hasText: task.title }).filter({ hasNotText: followupTitle(task) });
  const link = row.getByRole("link", { name: "Tickets", exact: true });
  await expect(link).toBeVisible();
  await expect(row.getByRole("note", { name: "Tickets after merge" })).toHaveCount(0);
  await shoot(dashboard, "03-started-sitrep", row);

  // It opens the follow-up: its live session, told tickets-only mode.
  await link.click();
  await expect(dashboard.getByRole("heading", { name: "Sitrep" })).toBeHidden();
  const followupDrawer = dashboard.getByRole("complementary", { name: "Session detail workspace" });
  await expect(followupDrawer).toContainText("tickets-only mode", { timeout: 30_000 });
  await expect(followupDrawer).toContainText(PR_URL);
  await shoot(dashboard, "04-started-opens-followup", followupDrawer);

  // The follow-up finishes itself, as the tickets skill does once the breakdown is dismissed,
  // and its session closes. The choice stays started, and the link still has somewhere to go:
  // the follow-up's own Recent outcomes row, which is where a finished task's outcome is.
  let followupSession: (SessionRow & { task?: { id: string } | null }) | undefined;
  await expect.poll(async () => {
    followupSession = (await api<Array<SessionRow & { task?: { id: string } | null }>>(daemon, "/api/sessions"))
      .find((s) => s.task?.id === followup!.id && s.state !== "exited");
    return Boolean(followupSession?.agentSessionId);
  }).toBe(true);
  const done = await fetch(`${daemon.baseURL}/mcp/shape-tickets/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": harnessToken(daemon) },
    body: JSON.stringify({
      env: {},
      sessionId: followupSession!.agentSessionId,
      cwd: followupSession!.cwd,
      outcome: "dismissed",
    }),
  });
  expect(done.ok, await done.clone().text()).toBe(true);
  await expect
    .poll(async () => {
      const row = (await tasks(daemon)).find((t) => t.id === followup!.id);
      const live = (await api<Array<SessionRow & { task?: { id: string } | null }>>(daemon, "/api/sessions"))
        .some((s) => s.task?.id === followup!.id && s.state !== "exited");
      return `${row?.status}:${live}`;
    }, { timeout: 30_000, message: "the follow-up is done and its session closed" })
    .toBe("done:false");
  expect(await shapeTicketsOf(daemon, task.id)).toMatchObject({ state: "started", followupTaskId: followup!.id });

  const finished = await openSitrep(dashboard);
  const sourceRow = finished.locator(".report-row").filter({ hasText: task.title }).filter({ hasNotText: followupTitle(task) });
  const followupRow = finished.locator(".report-row").filter({ hasText: followupTitle(task) });
  await expect(followupRow).not.toHaveAttribute("aria-current", "true");
  await sourceRow.getByRole("link", { name: "Tickets", exact: true }).click();
  // The click lands: the Sitrep stays open on the follow-up's row, marked and in view.
  await expect(dashboard.getByRole("heading", { name: "Sitrep" })).toBeVisible();
  await expect(followupRow).toHaveAttribute("aria-current", "true");
  await expect(followupRow).toBeInViewport();
  await expect(followupRow).toContainText("done");
  await shoot(dashboard, "08-started-opens-finished-followup", finished);
});

test("a refused follow-up shows Tickets queued, linking to it in the backlog", async ({ dashboard, daemon }) => {
  const { task } = await pendingShapeTask(dashboard, daemon);
  // Switched off before the merge, so the follow-up's launch is refused by the skill gate.
  await setShapeSkills(daemon, false);

  await mergePlanPullRequest(daemon, task, PR_URL);
  let followup: TaskRow | undefined;
  await expect
    .poll(async () => {
      followup = (await tasks(daemon)).find((t) => t.title === followupTitle(task));
      return followup?.status ?? "";
    }, { timeout: 30_000, message: "the merge files the follow-up, refused, in the backlog" })
    .toBe("backlog");
  await expect
    .poll(() => shapeTicketsOf(daemon, task.id))
    .toMatchObject({ state: "queued", followupTaskId: followup!.id });

  const outcomes = await openSitrep(dashboard);
  const row = outcomes.locator(".report-row").filter({ hasText: task.title }).filter({ hasNotText: followupTitle(task) });
  const link = row.getByRole("link", { name: "Tickets queued" });
  await expect(link).toBeVisible();
  await shoot(dashboard, "05-queued-sitrep", row);

  // It opens the waiting follow-up in the backlog editor.
  await link.click();
  const editor = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(editor).toBeVisible();
  await expect(editor.getByPlaceholder("What should this agent do?")).toHaveValue(/^Create tickets for the merged plan/);
  await shoot(dashboard, "06-queued-opens-followup", editor);
});

test("Stop shows nothing, and a pending choice whose task is cancelled shows Tickets lapsed", async ({
  dashboard,
  daemon,
}) => {
  // The cancel below has to release the task's worktree to answer ok.
  skipSpecOnWin32(test, WIN32_OCCUPANCY_UNPROVABLE);
  const { task, card } = await pendingShapeTask(dashboard, daemon, { stopFirst: true });
  await expect(card.getByRole("note", { name: "Tickets after merge" })).toBeVisible();

  await api(daemon, `/api/tasks/${task.id}/cancel`, {});
  await expect.poll(async () => (await shapeTicketsOf(daemon, task.id))?.state).toBe("lapsed");
  // Lapsing creates nothing.
  expect((await tasks(daemon)).filter((t) => t.title === followupTitle(task))).toEqual([]);

  const outcomes = await openSitrep(dashboard);
  const row = outcomes.locator(".report-row").filter({ hasText: task.title });
  const lapsed = row.getByRole("note", { name: "Tickets lapsed" });
  await expect(lapsed).toBeVisible();
  // A note, not a control: there is no follow-up to open.
  await expect(row.getByRole("link", { name: /^Tickets/ })).toHaveCount(0);
  await shoot(dashboard, "07-lapsed-sitrep", row);
});
