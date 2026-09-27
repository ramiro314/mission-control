import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { writeGhIssueCreateScript } from "../fixtures/fake-agents.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The breakdown review's last choice: mirror the tickets to a task source, yes or no.
 *
 * It opens on yes when the repository has a source that can receive pushed tasks, and on no,
 * with the reason shown, when it has none. The spec plays the agent's side of the `tickets`
 * skill over the authenticated MCP routes the bundled server calls - `list_backlog_tasks`
 * (whose `mirror` field decides the recommendation), `request_plan_decisions`, `create_task`
 * and `push_task` - and asserts what a person sees and what lands upstream: the preselected
 * choice and its reason, and, after Submit, one issue per ticket blocked by its blocker's issue
 * and filed under the shape task's own issue.
 *
 * No model tokens (the shape session is the fake agent) and nothing reaches GitHub: every `gh`
 * call is `FAKE_GH`, scripted here to number its issues so each ticket's is distinct.
 */

const EVIDENCE = artifactsDir("breakdown-mirror");
const TICKETS = [
  { n: 1, title: "Refactor the export seam", blockedBy: [] as number[], delivers: "One seam every exporter goes through." },
  { n: 2, title: "Export archives as CSV", blockedBy: [1], delivers: "A CSV download from the archives page." },
];
const YES = "Yes, mirror them";
const NO = "No, keep them in Mission Control only";

interface TaskRow {
  id: string;
  title: string;
  source: { sourceId: string; externalId: string; url: string | null } | null;
}

interface SessionRow {
  id: string;
  cwd: string;
  state: string;
  agentSessionId: string | null;
  hooksSeen: boolean;
  task: { id: string } | null;
}

interface Mirror {
  sources: Array<{ id: string; label: string; kind: string; relates: boolean }>;
  unavailable: string | null;
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

async function api(daemon: DaemonHandle, path: string, method: string, body: unknown): Promise<Response> {
  return fetch(`${daemon.baseURL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/breakdown-mirror/${name}.png`);
}

/** Every `gh issue create` argv the fake has recorded, oldest first. */
function issueCreates(daemon: DaemonHandle): string[][] {
  return readdirSync(daemon.recordDir)
    .filter((f) => f.startsWith("gh-"))
    .sort()
    .map((f) => (JSON.parse(readFileSync(join(daemon.recordDir, f), "utf8")) as { argv: string[] }).argv)
    .filter((argv) => argv[0] === "issue" && argv[1] === "create");
}

/**
 * A live shape session. With `fromIssue`, the shape task was first pushed as issue #1 (the
 * issue a shaped item would have come from) and then dispatched, so its tickets have a parent.
 */
async function startShape(daemon: DaemonHandle, fromIssue: boolean): Promise<SessionRow> {
  const skills = await api(daemon, "/api/skills/config", "PUT", {
    enabled: true,
    skills: { grill: true, "html-plans": true, tickets: true },
  });
  expect(skills.ok, "the shape skills should be enabled").toBe(true);

  const shape = await json<TaskRow>(await api(daemon, "/api/tasks", "POST", {
    repoRoot: daemon.repo,
    title: "Shape archive exports",
    intent: "Shape how exports should work for the archives library.",
    kind: "shape",
    agent: "claude",
    workflowId: null,
    backlog: fromIssue,
  }), "shape task");
  if (fromIssue) {
    const pushed = await json<TaskRow>(
      await api(daemon, `/api/tasks/${shape.id}/push`, "POST", { sourceId: "gh-mirror" }),
      "shape task's own issue",
    );
    expect(pushed.source?.externalId).toBe("acme/demo-repo#1");
    await json(await api(daemon, `/api/tasks/${shape.id}/dispatch`, "POST", {}), "shape dispatch");
  }

  let session: SessionRow | undefined;
  await expect.poll(async () => {
    const sessions = await json<SessionRow[]>(await fetch(`${daemon.baseURL}/api/sessions`), "sessions");
    session = sessions.find((candidate) => candidate.task?.id === shape.id);
    return Boolean(session?.agentSessionId && session.hooksSeen && session.state !== "exited");
  }, { timeout: 60_000, message: "the fake shape agent should establish its session" }).toBe(true);
  return session!;
}

const identity = (session: SessionRow) => ({ env: {}, sessionId: session.agentSessionId, cwd: session.cwd });

/** The breakdown review as the tickets skill builds it, mirror decision included. */
async function requestBreakdown(daemon: DaemonHandle, session: SessionRow): Promise<{ reviewId: string; mirror: Mirror }> {
  const { mirror } = await json<{ mirror: Mirror }>(
    await mcp(daemon, "/mcp/backlog", { ...identity(session), repoRoot: session.cwd }),
    "list_backlog_tasks",
  );
  const source = mirror.sources[0];
  const mirrorDecision = source
    ? {
        id: "mirror",
        question: `Mirror the tickets to ${source.label}?`,
        allowOther: false,
        options: [
          {
            id: "yes",
            label: YES,
            detail: `Files each ticket in ${source.label} (${source.kind}), blocked by its blockers' items and under this task's item.`,
            recommended: true,
          },
          { id: "no", label: NO },
        ],
      }
    : {
        id: "mirror",
        question: "Mirror the tickets to a task source?",
        allowOther: false,
        options: [
          { id: "no", label: NO, detail: mirror.unavailable!, recommended: true },
          { id: "yes", label: YES, detail: `Not available: ${mirror.unavailable}` },
        ],
      };
  const created = await json<{ id: string }>(await mcp(daemon, "/mcp/reviews", {
    ...identity(session),
    kind: "plan-decisions",
    title: "Archive exports: breakdown review",
    body: [
      "| # | Ticket | Blocked by | What it delivers |",
      "|---|---|---|---|",
      ...TICKETS.map((t) => `| ${t.n} | ${t.title} | ${t.blockedBy.join(", ") || "None"} | ${t.delivers} |`),
    ].join("\n"),
    decisions: [
      ...TICKETS.map((t) => ({
        id: `ticket-${t.n}`,
        question: `Ticket ${t.n}: ${t.title} - file a new task, or adopt an open backlog task?`,
        allowOther: true,
        options: [{ id: "new", label: "New task", detail: t.delivers, recommended: true }],
      })),
      mirrorDecision,
    ],
  }), "breakdown review");
  return { reviewId: created.id, mirror };
}

async function openReview(page: Page): Promise<Locator> {
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await page.locator(".console-detail").getByRole("button", { name: /to review/ }).click();
  const modal = page.locator(".review-modal");
  await expect(modal).toBeVisible();
  return modal;
}

async function mirrorSelection(daemon: DaemonHandle, reviewId: string): Promise<string[]> {
  const res = await fetch(`${daemon.baseURL}/mcp/reviews/${reviewId}/wait`, {
    headers: { "x-harness-token": token(daemon) },
  });
  const answer = (await res.json()) as { status: string; selections: Array<{ decisionId: string; selected: string[] }> };
  expect(answer.status).toBe("answered");
  return answer.selections.find((s) => s.decisionId === "mirror")!.selected;
}

test("with a source that can push, mirroring opens on yes and each ticket becomes a linked issue", async ({
  dashboard,
  daemon,
}) => {
  const sources = await api(daemon, "/api/task-sources/config", "PUT", {
    sources: [{ id: "gh-mirror", kind: "github-issues", label: "demo issues", repoRoot: daemon.repo, config: {} }],
  });
  expect(sources.ok, await sources.text()).toBe(true);
  writeGhIssueCreateScript(daemon.home, { next: 1 });
  const session = await startShape(daemon, true);
  const { reviewId, mirror } = await requestBreakdown(daemon, session);
  expect(mirror).toEqual({
    sources: [{ id: "gh-mirror", label: "demo issues", kind: "GitHub issues", relates: true }],
    unavailable: null,
  });

  const modal = await openReview(dashboard);
  const choice = modal.getByRole("group", { name: /Mirror the tickets to demo issues\?/ });
  await expect(choice.getByRole("radio", { name: new RegExp(YES) })).toBeChecked();
  await expect(choice.getByRole("radio", { name: new RegExp(NO) })).not.toBeChecked();
  await expect(choice.getByText(/Files each ticket in demo issues \(GitHub issues\)/)).toBeVisible();
  await shoot(dashboard, choice, "01-mirror-preselected-yes");
  await modal.getByRole("button", { name: "Submit" }).click();
  await expect(modal).toBeHidden();
  expect(await mirrorSelection(daemon, reviewId)).toEqual(["yes"]);

  // The agent's side: file every ticket, then push every ticket, blockers first.
  const ids = new Map<number, string>();
  for (const ticket of TICKETS) {
    const filed = await json<TaskRow>(await mcp(daemon, "/mcp/v3/tasks", {
      ...identity(session),
      repoRoot: session.cwd,
      title: ticket.title,
      intent: `**What to build:** ${ticket.delivers}`,
      kind: "ship",
      labels: ["archive-exports"],
      dependsOnTaskIds: ticket.blockedBy.map((n) => ids.get(n)!),
      dependsOnCurrentSession: true,
    }), `create_task for ticket ${ticket.n}`);
    ids.set(ticket.n, filed.id);
  }
  const urls: string[] = [];
  for (const ticket of TICKETS) {
    const pushed = await json<{ source: { url: string }; alreadyPushed: boolean }>(
      await mcp(daemon, "/mcp/push-task", { ...identity(session), taskId: ids.get(ticket.n)!, sourceId: "gh-mirror" }),
      `push_task for ticket ${ticket.n}`,
    );
    expect(pushed.alreadyPushed).toBe(false);
    urls.push(pushed.source.url);
  }
  expect(urls).toEqual([
    "https://github.com/acme/demo-repo/issues/2",
    "https://github.com/acme/demo-repo/issues/3",
  ]);

  // What GitHub was asked: ticket 2 blocked by ticket 1's issue, both under the shape's issue.
  const [, first, second] = issueCreates(daemon);
  expect(first).not.toContain("--blocked-by");
  expect(first!.slice(first!.indexOf("--parent"))).toEqual(["--parent", "https://github.com/acme/demo-repo/issues/1"]);
  expect(second!.slice(second!.indexOf("--blocked-by"))).toEqual([
    "--blocked-by", "https://github.com/acme/demo-repo/issues/2",
    "--parent", "https://github.com/acme/demo-repo/issues/1",
  ]);

  // A retry files nothing new.
  const retry = await json<{ alreadyPushed: boolean }>(
    await mcp(daemon, "/mcp/push-task", { ...identity(session), taskId: ids.get(2)! }),
    "push_task retry",
  );
  expect(retry.alreadyPushed).toBe(true);
  expect(issueCreates(daemon)).toHaveLength(3);

  // A person sees the link on the ticket itself.
  const ui = await api(daemon, "/api/ui/config", "PUT", { layout: "board" });
  expect(ui.ok).toBe(true);
  await dashboard.reload();
  await expect(dashboard.locator("main.board")).toBeVisible();
  const card = dashboard.locator(".bl-card").filter({ has: dashboard.getByRole("button", { name: TICKETS[1]!.title, exact: true }) });
  await card.getByRole("button", { name: TICKETS[1]!.title, exact: true }).click();
  const editor = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(editor.getByRole("link", { name: "acme/demo-repo#3" })).toHaveAttribute(
    "href",
    "https://github.com/acme/demo-repo/issues/3",
  );
  await shoot(dashboard, editor, "02-ticket-linked-issue");
});

test("without a source that can push, mirroring opens on no and says why", async ({ dashboard, daemon }) => {
  const session = await startShape(daemon, false);
  const { reviewId, mirror } = await requestBreakdown(daemon, session);
  const reason = "No task source is configured for this repository, so there is nowhere to mirror the tickets.";
  expect(mirror).toEqual({ sources: [], unavailable: reason });

  const modal = await openReview(dashboard);
  const choice = modal.getByRole("group", { name: /Mirror the tickets to a task source\?/ });
  await expect(choice.getByRole("radio", { name: new RegExp(NO) })).toBeChecked();
  await expect(choice.getByRole("radio", { name: new RegExp(YES) })).not.toBeChecked();
  await expect(choice.getByText(reason, { exact: true })).toBeVisible();
  await shoot(dashboard, choice, "03-mirror-unavailable");
  await modal.getByRole("button", { name: "Submit" }).click();
  await expect(modal).toBeHidden();
  expect(await mirrorSelection(daemon, reviewId)).toEqual(["no"]);
  expect(issueCreates(daemon)).toHaveLength(0);
});
