import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

/**
 * What Mission Control adds to History: a bound session's task title, outcome and PR in the
 * list and the header, the Mission Control link, task outcome and PR filters in the URL, and
 * the Mission Control-only record of a bound session whose transcript was deleted before the
 * catalog ever indexed it.
 *
 * Transcripts are written into the daemon's redirected `~/.claude/projects`, and tasks, their
 * work episode bindings and ledger cost are seeded into its database, both before a restart so
 * the recent tasks load the way a real daemon start loads them. No agent is launched and no
 * token is spent.
 */
test.use({ daemonEnv: { MISSION_HISTORY_RECONCILE_MS: "300" } });

const EVIDENCE = artifactsDir("history-mission");

let ordinal = 0;
function sessionId(): string {
  ordinal += 1;
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

/** One transcript: interactive, or a one-shot background run (a prompt snapshot with no tools). */
function writeSession(
  daemon: DaemonHandle,
  shape: { at: string; prompt: string; oneShot?: boolean; extra?: Record<string, unknown>[] },
): string {
  const id = sessionId();
  const cwd = "/projects/app";
  const envelope = {
    sessionId: id,
    cwd,
    entrypoint: shape.oneShot ? "sdk-ts" : "cli",
    version: "2.1.296",
    gitBranch: "main",
    timestamp: shape.at,
    isSidechain: false,
  };
  const lines: Record<string, unknown>[] = [];
  if (shape.oneShot) {
    lines.push({
      ...envelope,
      type: "attachment",
      attachment: { type: "prompt_snapshot", cliPrefix: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", tools: [], systemPrompt: [] },
    });
  }
  lines.push({ ...envelope, type: "user", message: { role: "user", content: shape.prompt } });
  lines.push({ ...envelope, type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Done." }] } });
  for (const extra of shape.extra ?? []) lines.push({ ...envelope, ...extra });
  const dir = join(daemon.home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const at = new Date(shape.at);
  utimesSync(path, at, at);
  return id;
}

interface TaskSeed {
  id: string;
  title: string;
  status: string;
  agentSessionId: string;
  outcome?: string;
  outcomeUrl?: string;
  prUrl?: string;
  mergedAt?: number;
  ledgerCost?: number;
}

/** Tasks, their current work episode bindings, and session spend in the ledger. */
function seedTasks(daemon: DaemonHandle, tasks: TaskSeed[]): void {
  const now = Date.now();
  withDaemonDb(daemon, (db) => {
    for (const task of tasks) {
      db.prepare(
        `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, branch, status, outcome, outcome_url,
                            created_at, updated_at, completed_at)
         VALUES (?, ?, 'intent', 'ship', 'claude', '/repos/app', 'task-branch', ?, ?, ?, ?, ?, ?)`,
      ).run(task.id, task.title, task.status, task.outcome ?? null, task.outcomeUrl ?? null, now, now, now);
      db.prepare(
        `INSERT INTO task_work_episode_bindings
           (task_id, episode_id, session_id, agent_session_id, branch, pr_url, merged_at, bound_at, updated_at)
         VALUES (?, ?, ?, ?, 'feature-branch', ?, ?, ?, ?)`,
      ).run(task.id, `ep-${task.id}`, `mc-${task.id}`, task.agentSessionId, task.prUrl ?? null, task.mergedAt ?? null, now, now);
      if (task.ledgerCost !== undefined) {
        db.prepare(
          `INSERT INTO usage_ledger (note_key, agent, model_id, window_end_ns, ts, cost_usd)
           VALUES (?, 'claude', 'claude-opus-5-5', ?, ?, ?)`,
        ).run(task.agentSessionId, `w-${task.id}`, now, task.ledgerCost);
      }
    }
  });
}

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
}

/** Waits until the catalog holds every seeded transcript. */
async function indexed(daemon: DaemonHandle, count: number): Promise<void> {
  await expect.poll(async () => {
    const res = await fetch(`${daemon.baseURL}/api/history/sessions?kind=all&limit=200`);
    const body = await res.json() as { sessions: unknown[]; progress: { indexing: boolean } };
    return !body.progress.indexing && body.sessions.length === count;
  }, { timeout: 20_000 }).toBe(true);
}

interface Seeded {
  shipped: string;
  failedRun: string;
  unindexed: string;
}

async function seedAndRestart(daemon: DaemonHandle): Promise<Seeded> {
  const shipped = writeSession(daemon, {
    at: "2026-10-30T15:00:00.000Z",
    prompt: "Fix the flaky login retry",
    extra: [
      { type: "custom-title", customTitle: "Operator chat title" },
      { type: "cost-state", totalCostUSD: 2.5 },
    ],
  });
  // A background run, but a task ran it, so it is a conversation.
  const failedRun = writeSession(daemon, { at: "2026-10-30T14:00:00.000Z", prompt: "Review the parser diff", oneShot: true });
  writeSession(daemon, { at: "2026-10-30T13:00:00.000Z", prompt: "Exploring the codebase by hand" });
  writeSession(daemon, { at: "2026-10-30T12:00:00.000Z", prompt: "Unbound background run", oneShot: true });
  // Bound, with no transcript at all: deleted before the catalog ever saw it.
  const unindexed = sessionId();
  seedTasks(daemon, [
    {
      id: "e2e-history-shipped",
      title: "Ship the login fix",
      status: "done",
      agentSessionId: shipped,
      outcome: "opened PR #12",
      outcomeUrl: "https://github.com/o/r/pull/12",
      prUrl: "https://github.com/o/r/pull/12",
      mergedAt: Date.parse("2026-10-30T16:00:00.000Z"),
      ledgerCost: 9,
    },
    { id: "e2e-history-failed", title: "Review the parser", status: "failed", agentSessionId: failedRun, ledgerCost: 0.75 },
    {
      id: "e2e-history-unindexed",
      title: "Deleted before indexing",
      status: "done",
      agentSessionId: unindexed,
      outcome: "merged",
      outcomeUrl: "https://github.com/o/r/pull/40",
      prUrl: "https://github.com/o/r/pull/40",
      mergedAt: Date.parse("2026-10-01T10:00:00.000Z"),
      ledgerCost: 3.1,
    },
  ]);
  await daemon.crash();
  await daemon.restart();
  await indexed(daemon, 4);
  return { shipped, failedRun, unindexed };
}

test("bound sessions show their task, outcome and PR, and the link, outcome and PR filters live in the URL", async ({
  dashboard,
  daemon,
}) => {
  await seedAndRestart(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/history`);
  const page = dashboard.getByRole("main", { name: "History" });

  // A bound session's title is its task's, and its row says how the task ended and its PR.
  const shipped = page.getByRole("listitem").filter({ hasText: "Ship the login fix" });
  await expect(shipped).toBeVisible();
  await expect(page.getByText("Operator chat title")).toHaveCount(0);
  await expect(shipped).toContainText("done");
  await expect(shipped.getByRole("link", { name: "opened PR #12" })).toHaveAttribute("href", "https://github.com/o/r/pull/12");
  await expect(shipped.getByRole("link", { name: "PR #12 merged" })).toBeVisible();
  await expect(shipped).toContainText("$2.50");

  // A task-bound background run is in the default list; its cost comes from the ledger.
  const failed = page.getByRole("listitem").filter({ hasText: "Review the parser" });
  await expect(failed).toContainText("One-shot");
  await expect(failed).toContainText("failed");
  await expect(failed).toContainText("$0.75");
  // An unbound session is complete without any of it; an unbound background run stays hidden.
  await expect(page.getByRole("listitem").filter({ hasText: "Exploring the codebase by hand" })).toBeVisible();
  await expect(page.getByText("Unbound background run")).toHaveCount(0);
  await expect(page.getByRole("listitem")).toHaveCount(3);
  await capture(dashboard, "bound-rows");

  // Mission Control link: managed by a task.
  const link = page.getByRole("combobox", { name: "Mission Control link", exact: true });
  await link.selectOption("task");
  await expect(dashboard).toHaveURL(/#\/history\?link=task$/);
  await expect(page.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByText("Exploring the codebase by hand")).toHaveCount(0);

  // Task outcome, with the link filter.
  await page.getByRole("combobox", { name: "Task outcome", exact: true }).selectOption("failed");
  await expect(dashboard).toHaveURL(/#\/history\?link=task&outcome=failed$/);
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("listitem").first()).toContainText("Review the parser");

  // External, with the Kind filter: every session no task ran, background runs included.
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(dashboard).toHaveURL(/#\/history$/);
  await link.selectOption("external");
  await page.getByRole("combobox", { name: "Kind", exact: true }).selectOption("all");
  await expect(dashboard).toHaveURL(/#\/history\?kind=all&link=external$/);
  await expect(page.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByText("Unbound background run")).toBeVisible();
  await expect(page.getByText("Ship the login fix")).toHaveCount(0);

  // PR: merged.
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("combobox", { name: "Pull request", exact: true }).selectOption("merged");
  await expect(dashboard).toHaveURL(/#\/history\?pr=merged$/);
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("listitem").first()).toContainText("Ship the login fix");

  // A pasted link lands on the same list, with its controls showing the filters.
  await dashboard.goto(`${daemon.baseURL}/#/history?link=task&outcome=done&pr=any`);
  await expect(page.getByRole("combobox", { name: "Mission Control link", exact: true })).toHaveValue("task");
  await expect(page.getByRole("combobox", { name: "Task outcome", exact: true })).toHaveValue("done");
  await expect(page.getByRole("combobox", { name: "Pull request", exact: true })).toHaveValue("any");
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("listitem").first()).toContainText("Ship the login fix");
  await capture(dashboard, "filtered");
});

test("a bound session's header shows its task, outcome and PR; one with no catalog row shows the Mission Control record", async ({
  dashboard,
  daemon,
}) => {
  const seeded = await seedAndRestart(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/history`);
  const detail = dashboard.getByRole("main", { name: "History session" });

  // An unbound session's record is complete without any Mission Control field.
  await dashboard.getByRole("main", { name: "History" }).getByRole("link", { name: "Exploring the codebase by hand" }).click();
  await expect(detail.getByRole("heading", { name: "Exploring the codebase by hand", level: 2 })).toBeVisible();
  await expect(detail.getByRole("term")).toContainText(["Branch", "Working directory", "Kind", "Model"]);
  await expect(detail.getByRole("term").filter({ hasText: /^(Task|Outcome|Task kind)$/ })).toHaveCount(0);
  await expect(detail.getByRole("tab", { name: "Conversation" })).toBeVisible();

  await detail.getByRole("button", { name: "← History" }).click();
  await dashboard.getByRole("main", { name: "History" }).getByRole("link", { name: "Ship the login fix" }).click();
  await expect(detail.getByRole("heading", { name: "Ship the login fix", level: 2 })).toBeVisible();
  // The header is a `<header>` inside `<main>`, which has no landmark role, so the detail is the scope.
  const header = detail;
  await expect(header.getByRole("definition").filter({ hasText: "opened PR #12" })).toContainText("done");
  await expect(header.getByRole("link", { name: "PR #12 merged" })).toHaveAttribute("href", "https://github.com/o/r/pull/12");
  await expect(header).toContainText("$2.50");
  await expect(detail.getByRole("tab", { name: "Conversation" })).toBeVisible();
  await expect(detail.getByText("Fix the flaky login retry")).toBeVisible();
  await capture(dashboard, "bound-detail");

  // The task links back to it: a finished task opens in the Sitrep, its row marked.
  await header.getByRole("button", { name: "Ship the login fix" }).click();
  await expect(detail).toHaveCount(0);
  await expect(dashboard.locator('[aria-current="true"]').filter({ hasText: "Ship the login fix" })).toBeVisible();
  await dashboard.getByRole("dialog", { name: "Sitrep" }).getByRole("button", { name: "Close" }).click();
  await expect(dashboard.getByRole("dialog", { name: "Sitrep" })).toHaveCount(0);

  // No catalog row, but a task binding names the id: the record is Mission Control's alone.
  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${seeded.unindexed}`);
  await expect(detail.getByRole("heading", { name: "Deleted before indexing", level: 2 })).toBeVisible();
  await expect(detail.getByText("Not indexed")).toBeVisible();
  await expect(detail.getByRole("note")).toContainText("removed before Mission Control indexed it");
  const record = detail;
  await expect(record.getByRole("link", { name: "merged", exact: true })).toHaveAttribute("href", "https://github.com/o/r/pull/40");
  await expect(record.getByRole("link", { name: "PR #40 merged" })).toBeVisible();
  await expect(record).toContainText("/repos/app");
  await expect(record).toContainText("feature-branch");
  await expect(record).toContainText("$3.10");
  await expect(detail.getByRole("tablist")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Resume" })).toHaveCount(0);
  await capture(dashboard, "mission-only-record");

  // A task seeded after the daemon started is one the dashboard does not hold: its title is
  // named without a control that would do nothing.
  const unheld = sessionId();
  seedTasks(daemon, [{ id: "e2e-history-unheld", title: "Task the dashboard never loaded", status: "done", agentSessionId: unheld }]);
  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${unheld}`);
  await expect(detail.getByRole("heading", { name: "Task the dashboard never loaded", level: 2 })).toBeVisible();
  await expect(detail.getByRole("definition").filter({ hasText: "Task the dashboard never loaded" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Task the dashboard never loaded" })).toHaveCount(0);

  // An id neither the catalog nor Mission Control knows.
  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${sessionId()}`);
  await expect(detail.getByText("This session is not in History")).toBeVisible();
});
