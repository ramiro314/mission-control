import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectDashboardReady } from "../fixtures/dashboard-ready.ts";

/**
 * A Recent outcomes title opens the task's session in History: the session a current work
 * episode binding names, or the newest historical one when the current row was replaced. A
 * task with no bound session, or one whose harness History does not read, keeps a plain title.
 * A session deleted before it was ever indexed still opens, on the Mission Control-only record.
 *
 * Tasks, bindings and one transcript are seeded before a restart, so the recent tasks load the
 * way a real daemon start loads them. No agent is launched and no token is spent.
 */
test.use({ daemonEnv: { MISSION_HISTORY_RECONCILE_MS: "300" } });

const EVIDENCE = artifactsDir("sitrep-history-link");

const INDEXED = "00000000-0000-4000-8000-000000000101";
const UNINDEXED = "00000000-0000-4000-8000-000000000102";
const ROLLED = "00000000-0000-4000-8000-000000000103";
const CODEX = "00000000-0000-4000-8000-000000000104";

function writeTranscript(daemon: DaemonHandle, id: string, prompt: string): void {
  const cwd = "/projects/app";
  const at = "2026-10-30T15:00:00.000Z";
  const envelope = { sessionId: id, cwd, entrypoint: "cli", version: "2.1.296", gitBranch: "main", timestamp: at, isSidechain: false };
  const lines = [
    { ...envelope, type: "user", message: { role: "user", content: prompt } },
    { ...envelope, type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Done." }] } },
  ];
  const dir = join(daemon.home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  utimesSync(path, new Date(at), new Date(at));
}

interface TaskSeed {
  id: string;
  title: string;
  status: string;
  agent?: string;
  outcome?: string;
  outcomeUrl?: string;
  /** Where its binding lives, if it has one. */
  binding?: { agentSessionId: string; table: "task_work_episode_bindings" | "historical_task_work_episode_bindings" };
}

function seedTasks(daemon: DaemonHandle, tasks: TaskSeed[]): void {
  const now = Date.now();
  withDaemonDb(daemon, (db) => {
    tasks.forEach((task, index) => {
      // Staggered so Recent outcomes has a stable order.
      const at = now - index * 1000;
      db.prepare(
        `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, status, outcome, outcome_url,
                            created_at, updated_at, completed_at)
         VALUES (?, ?, 'intent', 'ship', ?, '/repos/app', ?, ?, ?, ?, ?, ?)`,
      ).run(task.id, task.title, task.agent ?? "claude", task.status, task.outcome ?? null, task.outcomeUrl ?? null, at, at, at);
      if (!task.binding) return;
      db.prepare(
        `INSERT INTO ${task.binding.table}
           (task_id, episode_id, session_id, agent_session_id, branch, pr_url, bound_at, updated_at)
         VALUES (?, ?, ?, ?, 'feature-branch', 'https://github.com/o/r/pull/9', ?, ?)`,
      ).run(task.id, `ep-${task.id}`, `mc-${task.id}`, task.binding.agentSessionId, at, at);
    });
  });
}

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
}

async function openRecentOutcomes(dashboard: Page, baseURL: string): Promise<{ sitrep: Locator; recent: Locator }> {
  await dashboard.goto(baseURL);
  await expectDashboardReady(dashboard);
  await dashboard.keyboard.press("Shift+P");
  const sitrep = dashboard.getByRole("dialog", { name: "Sitrep" });
  const recent = sitrep.locator("section.report-section", {
    has: dashboard.locator("h3.report-section-title", { hasText: /^Recent outcomes\b/ }),
  });
  await expect(recent).toBeVisible();
  return { sitrep, recent };
}

test("a Recent outcomes title opens its task's session in History, and only when there is one", async ({
  dashboard,
  daemon,
}) => {
  writeTranscript(daemon, INDEXED, "Fix the flaky login retry");
  seedTasks(daemon, [
    {
      id: "e2e-sitrep-indexed",
      title: "Ship the login fix",
      status: "done",
      outcome: "opened PR #12",
      outcomeUrl: "https://github.com/o/r/pull/12",
      binding: { agentSessionId: INDEXED, table: "task_work_episode_bindings" },
    },
    {
      id: "e2e-sitrep-unindexed",
      title: "Deleted before indexing",
      status: "done",
      binding: { agentSessionId: UNINDEXED, table: "task_work_episode_bindings" },
    },
    {
      id: "e2e-sitrep-rolled",
      title: "Rolled past its binding",
      status: "failed",
      binding: { agentSessionId: ROLLED, table: "historical_task_work_episode_bindings" },
    },
    { id: "e2e-sitrep-unbound", title: "Never bound to a session", status: "failed" },
    {
      id: "e2e-sitrep-codex",
      title: "Codex has no History reader",
      status: "done",
      agent: "codex",
      binding: { agentSessionId: CODEX, table: "task_work_episode_bindings" },
    },
  ]);
  await daemon.crash();
  await daemon.restart();
  await expect.poll(async () => {
    const res = await fetch(`${daemon.baseURL}/api/history/sessions?kind=all&limit=200`);
    const body = await res.json() as { sessions: unknown[]; progress: { indexing: boolean } };
    return !body.progress.indexing && body.sessions.length === 1;
  }, { timeout: 20_000 }).toBe(true);

  const { sitrep, recent } = await openRecentOutcomes(dashboard, daemon.baseURL);
  const row = (title: string) => recent.locator(".report-row", { hasText: title });

  // Bound sessions link, the historical binding included when no current one is left.
  await expect(recent.getByRole("link", { name: "Ship the login fix", exact: true }))
    .toHaveAttribute("href", `#/history/claude/${INDEXED}`);
  await expect(recent.getByRole("link", { name: "Deleted before indexing", exact: true }))
    .toHaveAttribute("href", `#/history/claude/${UNINDEXED}`);
  await expect(recent.getByRole("link", { name: "Rolled past its binding", exact: true }))
    .toHaveAttribute("href", `#/history/claude/${ROLLED}`);
  // No bound session, or a harness History does not read: the title is plain text.
  await expect(row("Never bound to a session")).toBeVisible();
  await expect(recent.getByRole("link", { name: "Never bound to a session" })).toHaveCount(0);
  await expect(row("Codex has no History reader")).toBeVisible();
  await expect(recent.getByRole("link", { name: "Codex has no History reader" })).toHaveCount(0);

  // The rest of the row is what it was: the outcome link, the status, and Reschedule.
  await expect(row("Ship the login fix").getByRole("link", { name: "opened PR #12" }))
    .toHaveAttribute("href", "https://github.com/o/r/pull/12");
  await expect(row("Ship the login fix")).toContainText("done");
  await expect(row("Rolled past its binding").getByRole("button", { name: "Reschedule", exact: true })).toBeVisible();
  await expect(row("Never bound to a session").getByRole("button", { name: "Reschedule", exact: true })).toBeVisible();
  await capture(dashboard, "recent-outcomes");

  // Following a title closes the Sitrep and lands on the session's History page.
  await recent.getByRole("link", { name: "Ship the login fix", exact: true }).click();
  await expect(sitrep).toHaveCount(0);
  await expect(dashboard).toHaveURL(new RegExp(`#/history/claude/${INDEXED}$`));
  const detail = dashboard.getByRole("main", { name: "History session" });
  await expect(detail.getByRole("heading", { name: "Ship the login fix", level: 2 })).toBeVisible();
  await expect(detail.getByText("Fix the flaky login retry")).toBeVisible();
  await capture(dashboard, "indexed-session");

  // A session deleted before it was indexed still opens, on the Mission Control-only record.
  const again = await openRecentOutcomes(dashboard, daemon.baseURL);
  await again.recent.getByRole("link", { name: "Deleted before indexing", exact: true }).click();
  await expect(again.sitrep).toHaveCount(0);
  await expect(detail.getByRole("heading", { name: "Deleted before indexing", level: 2 })).toBeVisible();
  await expect(detail.getByText("Not indexed")).toBeVisible();
  await expect(detail.getByRole("note")).toContainText("removed before Mission Control indexed it");
  await capture(dashboard, "mission-only-record");
});
