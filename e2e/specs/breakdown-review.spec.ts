import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * A shape task's breakdown review: the human's final approval before any ticket exists.
 *
 * The shape session is the fake agent (`e2e/fixtures/fake-agents.ts`), so no model tokens are
 * spent. The spec plays the agent's side of the `tickets` skill over the same authenticated
 * MCP routes the bundled server calls - `list_backlog_tasks`, `request_plan_decisions`, then
 * `create_task` per approved ticket - and asserts everything a person sees and chooses in
 * between: the breakdown, the preselected "New task", the adopt choice, nothing filed before
 * Submit, nothing filed on Dismiss, and the dependency-gated cards after.
 */

const EVIDENCE = artifactsDir("breakdown-review");
const EXISTING = "Existing export work";
const TICKETS = [
  { n: 1, title: "Refactor the export seam", blockedBy: [] as number[], delivers: "One seam every exporter goes through." },
  { n: 2, title: "Export archives as CSV", blockedBy: [1], delivers: "A CSV download from the archives page." },
  { n: 3, title: "Fix the truncated export filename", blockedBy: [2], delivers: "Filenames keep their extension." },
];

interface TaskRow {
  id: string;
  title: string;
  intent: string;
  kind: string;
  labels: string[];
  status: string;
  enabled: boolean;
  dependencies: Array<{ type: string; taskId?: string; sessionId?: string }>;
  adopted?: boolean;
}

interface SessionRow {
  id: string;
  cwd: string;
  state: string;
  agentSessionId: string | null;
  hooksSeen: boolean;
  task: { id: string } | null;
}

async function json<T>(response: Response, context: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) throw new Error(`${context} answered ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

const token = (daemon: DaemonHandle): string => readFileSync(join(daemon.home, "token"), "utf8").trim();

async function mcp(daemon: DaemonHandle, path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${daemon.baseURL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify(body),
  });
}

const allTasks = async (daemon: DaemonHandle): Promise<TaskRow[]> =>
  json<TaskRow[]>(await fetch(`${daemon.baseURL}/api/tasks`), "task list");

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/breakdown-review/${name}.png`);
}

/** A live shape session and an operator's own backlog task a ticket may adopt. */
async function setUp(daemon: DaemonHandle): Promise<{ session: SessionRow; existing: TaskRow; shape: TaskRow }> {
  const skills = await fetch(`${daemon.baseURL}/api/skills/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, skills: { grill: true, "html-plans": true, tickets: true } }),
  });
  expect(skills.ok, "the shape skills should be enabled").toBe(true);

  const existing = await json<TaskRow>(await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repoRoot: daemon.repo,
      title: EXISTING,
      intent: "The operator's own brief for exports.",
      kind: "ship",
      agent: "claude",
      labels: ["operator"],
      backlog: true,
    }),
  }), "existing backlog task");

  const shape = await json<TaskRow>(await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repoRoot: daemon.repo,
      title: "Shape archive exports",
      intent: "Shape how exports should work for the archives library.",
      kind: "shape",
      agent: "claude",
      workflowId: null,
      backlog: false,
    }),
  }), "shape dispatch");

  let session: SessionRow | undefined;
  await expect.poll(async () => {
    const sessions = await json<SessionRow[]>(await fetch(`${daemon.baseURL}/api/sessions`), "sessions");
    session = sessions.find((candidate) => candidate.task?.id === shape.id);
    return Boolean(session?.agentSessionId && session.hooksSeen && session.state !== "exited");
  }, { timeout: 60_000, message: "the fake shape agent should establish its session" }).toBe(true);
  return { session: session!, existing, shape };
}

/** The breakdown review, exactly as the tickets skill asks for it. */
async function requestBreakdown(daemon: DaemonHandle, session: SessionRow): Promise<string> {
  const backlog = await json<{ tasks: Array<{ id: string; title: string }> }>(
    await mcp(daemon, "/mcp/backlog", { env: {}, sessionId: session.agentSessionId, cwd: session.cwd, repoRoot: session.cwd }),
    "list_backlog_tasks",
  );
  const table = [
    "| # | Ticket | Blocked by | What it delivers | Kind |",
    "|---|---|---|---|---|",
    ...TICKETS.map((t) =>
      `| ${t.n} | ${t.title} | ${t.blockedBy.length ? t.blockedBy.join(", ") : "None"} | ${t.delivers} | ${t.n === 3 ? "bugfix" : "ship"} |`),
    "",
    "Submitting files these tickets as backlog tasks gated on this session. Dismiss files nothing.",
  ].join("\n");
  const created = await json<{ id: string }>(await mcp(daemon, "/mcp/reviews", {
    env: {},
    sessionId: session.agentSessionId,
    cwd: session.cwd,
    kind: "plan-decisions",
    title: "Archive exports: breakdown review",
    body: table,
    decisions: TICKETS.map((t) => ({
      id: `ticket-${t.n}`,
      question: `Ticket ${t.n}: ${t.title} - file a new task, or adopt an open backlog task?`,
      allowOther: true,
      options: [
        {
          id: "new",
          label: "New task",
          detail: `Blocked by: ${t.blockedBy.length ? t.blockedBy.join(", ") : "None"}. ${t.delivers}`,
          recommended: true,
        },
        ...backlog.tasks.map((task) => ({ id: `adopt:${task.id}`, label: `Adopt: ${task.title}` })),
      ],
    })),
  }), "breakdown review");
  return created.id;
}

async function openReview(page: Page): Promise<Locator> {
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await page.locator(".console-detail").getByRole("button", { name: /to review/ }).click();
  const modal = page.locator(".review-modal");
  await expect(modal).toBeVisible();
  return modal;
}

async function answerFor(
  daemon: DaemonHandle,
  id: string,
): Promise<{ status: string; selections: Array<{ decisionId: string; selected: string[]; other: string | null }> | null }> {
  const res = await fetch(`${daemon.baseURL}/mcp/reviews/${id}/wait`, {
    headers: { "x-harness-token": token(daemon) },
  });
  expect(res.status).toBe(200);
  return res.json();
}

test("an approved breakdown files each ticket, adopts the chosen backlog task, and gates them all", async ({
  dashboard,
  daemon,
}) => {
  const { session, existing, shape } = await setUp(daemon);
  const reviewId = await requestBreakdown(daemon, session);

  const modal = await openReview(dashboard);
  // The breakdown: every ticket with what blocks it and what it delivers.
  for (const ticket of TICKETS) {
    await expect(modal.getByRole("cell", { name: ticket.title, exact: true })).toBeVisible();
    await expect(modal.getByRole("cell", { name: ticket.delivers, exact: true })).toBeVisible();
  }
  await expect(modal.getByText("Dismiss files nothing.")).toBeVisible();
  // Each ticket opens as a new task, with the operator's backlog task offered to adopt.
  const ticket2 = modal.getByRole("group", { name: /Ticket 2: Export archives as CSV/ });
  await expect(ticket2.getByRole("radio", { name: /New task/ })).toBeChecked();
  await ticket2.getByRole("radio", { name: `Adopt: ${EXISTING}` }).check();
  await expect(ticket2.getByRole("radio", { name: `Adopt: ${EXISTING}` })).toBeChecked();
  await shoot(dashboard, modal, "01-breakdown-review");

  // Nothing is filed while the breakdown is still open.
  expect((await allTasks(daemon)).map((task) => task.title).sort())
    .toEqual([EXISTING, "Shape archive exports"].sort());

  await modal.getByRole("button", { name: "Submit" }).click();
  await expect(modal).toBeHidden();
  const answer = await answerFor(daemon, reviewId);
  expect(answer.status).toBe("answered");
  expect(answer.selections).toEqual([
    { decisionId: "ticket-1", selected: ["new"], other: null },
    { decisionId: "ticket-2", selected: [`adopt:${existing.id}`], other: null },
    { decisionId: "ticket-3", selected: ["new"], other: null },
  ]);

  // The agent's side: create_task per ticket, blockers first, each gated on this session.
  const ids = new Map<number, string>();
  for (const ticket of TICKETS) {
    const selected = answer.selections!.find((s) => s.decisionId === `ticket-${ticket.n}`)!.selected[0]!;
    const filed = await json<TaskRow>(await mcp(daemon, "/mcp/v3/tasks", {
      env: {},
      sessionId: session.agentSessionId,
      cwd: session.cwd,
      repoRoot: session.cwd,
      title: ticket.title,
      intent: `**What to build:** ${ticket.delivers}`,
      kind: ticket.n === 3 ? "bugfix" : "ship",
      labels: ["archive-exports"],
      dependsOnTaskIds: ticket.blockedBy.map((n) => ids.get(n)!),
      dependsOnCurrentSession: true,
      ...(selected.startsWith("adopt:") ? { adoptTaskId: selected.slice("adopt:".length) } : {}),
    }), `create_task for ticket ${ticket.n}`);
    ids.set(ticket.n, filed.id);
  }
  expect(ids.get(2)).toBe(existing.id);

  const tasks = await allTasks(daemon);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const adopted = byId.get(existing.id)!;
  // Adopting added edges and nothing else.
  expect(adopted).toMatchObject({ title: EXISTING, intent: "The operator's own brief for exports.", labels: ["operator"] });
  // The planning-session gate lands as an edge on the shape task the session is working, so
  // it releases when that task's planning pull request merges.
  expect(adopted.dependencies.map((d) => d.taskId ?? d.sessionId)).toEqual([ids.get(1), shape.id]);
  const fix = byId.get(ids.get(3)!)!;
  expect(fix).toMatchObject({ kind: "bugfix", labels: ["archive-exports"], status: "backlog", enabled: true });
  expect(fix.dependencies.map((d) => d.taskId ?? d.sessionId)).toEqual([existing.id, shape.id]);
  expect(tasks).toHaveLength(4);

  // On the board, every ticket waits on its blockers and on the planning session.
  const ui = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(ui.ok).toBe(true);
  await dashboard.reload();
  await expect(dashboard.locator("main.board")).toBeVisible();
  // A card is found by its own title button: a dependent card names its blockers' titles too.
  const cardFor = (title: string): Locator =>
    dashboard.locator(".bl-card").filter({ has: dashboard.getByRole("button", { name: title, exact: true }) });
  for (const title of [TICKETS[0]!.title, EXISTING, TICKETS[2]!.title]) {
    await expect(cardFor(title).getByRole("button", { name: "waiting for dependencies" })).toBeVisible();
  }
  await expect(cardFor(TICKETS[2]!.title).getByText("archive-exports")).toBeVisible();
  await expect(cardFor(TICKETS[1]!.title)).toHaveCount(0);
  await shoot(dashboard, dashboard.locator("section.board-backlog"), "02-tickets-filed");
});

test("a dismissed breakdown files nothing", async ({ dashboard, daemon }) => {
  const { session } = await setUp(daemon);
  const reviewId = await requestBreakdown(daemon, session);
  const before = (await allTasks(daemon)).map((task) => task.id).sort();

  const modal = await openReview(dashboard);
  await modal.getByRole("button", { name: "Dismiss" }).click();
  await expect(modal).toBeHidden();

  const answer = await answerFor(daemon, reviewId);
  expect(answer.status).toBe("dismissed");
  expect(answer.selections ?? null).toBeNull();
  expect((await allTasks(daemon)).map((task) => task.id).sort()).toEqual(before);
  await expect(dashboard.getByText(TICKETS[0]!.title)).toHaveCount(0);
});
