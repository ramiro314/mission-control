import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Session History's first page: a fake `~/.claude/projects` in the daemon's redirected home,
 * indexed by the real reconciler and read back through the real route.
 *
 * The spec seeds transcripts, then restarts the daemon onto them, which is what a first run is.
 * Its backfill indexes them five at a time, newest file first, with a pause after each batch,
 * which is what makes the "Indexing N of M sessions" line long enough to see. Later passes run
 * every 300 ms, so a removed transcript is noticed quickly. No agent is launched and no token is spent: the transcripts are written by this file.
 */
test.use({
  daemonEnv: {
    MISSION_HISTORY_RECONCILE_MS: "300",
    MISSION_HISTORY_BATCH_SIZE: "5",
    MISSION_HISTORY_BATCH_PAUSE_MS: "400",
  },
});

const EVIDENCE = artifactsDir("session-history");
/** One more than a page, so Load more has something to fetch. */
const FILLER = 52;

let ordinal = 0;
function sessionId(): string {
  ordinal += 1;
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

interface Shape {
  cwd: string;
  at: string;
  entrypoint?: string;
  tools?: string[] | null;
  prompt: string;
  extra?: Record<string, unknown>[];
}

/** Writes one transcript the way Claude Code lays it out, into a folder named for its cwd. */
function writeSession(daemon: DaemonHandle, shape: Shape): { id: string; path: string } {
  const id = sessionId();
  const envelope = {
    sessionId: id,
    cwd: shape.cwd,
    entrypoint: shape.entrypoint ?? "cli",
    version: "2.1.296",
    gitBranch: "HEAD",
    timestamp: shape.at,
    isSidechain: false,
  };
  const lines: Record<string, unknown>[] = [];
  if (shape.tools) {
    lines.push({
      ...envelope,
      type: "attachment",
      attachment: {
        type: "prompt_snapshot",
        cliPrefix: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
        tools: shape.tools.map((name) => ({ name })),
        systemPrompt: [],
      },
    });
  }
  lines.push({ ...envelope, type: "user", message: { role: "user", content: shape.prompt } });
  lines.push({
    ...envelope,
    type: "assistant",
    message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Done." }] },
  });
  for (const extra of shape.extra ?? []) lines.push({ sessionId: id, ...extra });
  const dir = join(daemon.home, ".claude", "projects", shape.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  // The file's mtime is when Claude last wrote it, which is what backfill orders by.
  const at = new Date(shape.at);
  utimesSync(path, at, at);
  return { id, path };
}

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
}

/**
 * Seeds the fixture store: five conversations carrying every row field, two background runs,
 * one transcript the spec will delete, and enough filler for a second page. Then restarts the
 * daemon onto it, which is what a first run is.
 */
async function seedAndRestart(daemon: DaemonHandle): Promise<{ id: string; path: string }> {
  // The newest row, and the one that carries every field a row shows.
  writeSession(daemon, {
    cwd: "/projects/alpha-service",
    at: "2026-10-30T15:00:00.000Z",
    prompt: "Fix the flaky login retry",
    extra: [
      { type: "ai-title", aiTitle: "Login retry fix" },
      { type: "custom-title", customTitle: "Operator named this one" },
      { type: "attachment", timestamp: "2026-10-30T15:01:00.000Z", gitBranch: "fix-login-retry", cwd: "/projects/alpha-service", attachment: { type: "a-record-type-from-the-future" } },
      { type: "cost-state", totalCostUSD: 2.5, totalDuration: 125_000, startTime: Date.parse("2026-10-30T14:58:00.000Z") },
    ],
  });
  writeSession(daemon, {
    cwd: "/projects/beta",
    at: "2026-10-30T12:00:00.000Z",
    prompt: "Summarize the beta release notes",
    extra: [{ type: "ai-title", aiTitle: "Beta release summary" }],
  });
  writeSession(daemon, { cwd: "/projects/gamma", at: "2026-10-29T09:00:00.000Z", prompt: "A session titled only by its first prompt" });
  // Not cli and no prompt_snapshot: unclassified, and still shown.
  writeSession(daemon, { cwd: "/projects/delta", at: "2026-10-29T08:00:00.000Z", entrypoint: "sdk-ts", tools: null, prompt: "An unplaceable session" });
  // Background runs: hidden from the default list even though they are the newest of all.
  writeSession(daemon, { cwd: "/projects/alpha-service", at: "2026-10-31T10:00:00.000Z", entrypoint: "sdk-ts", tools: [], prompt: "Background one-shot run" });
  writeSession(daemon, { cwd: "/projects/alpha-service", at: "2026-10-31T11:00:00.000Z", entrypoint: "sdk-ts", tools: ["Read", "StructuredOutput"], prompt: "Background reviewer run" });
  const gone = writeSession(daemon, { cwd: "/projects/epsilon", at: "2026-10-28T10:00:00.000Z", prompt: "A transcript Claude Code will delete" });
  for (let i = 0; i < FILLER; i++) {
    writeSession(daemon, {
      cwd: "/projects/filler",
      at: new Date(Date.UTC(2026, 9, 20, 12, 0, 0) - i * 60_000).toISOString(),
      prompt: `Filler conversation ${String(i).padStart(2, "0")}`,
    });
  }
  // A first run is a daemon starting onto a store that already holds transcripts. This one's
  // first pass saw the store empty, so it is restarted onto the seeded store.
  await daemon.crash();
  await daemon.restart();
  return gone;
}

test("History lists conversations as they are indexed, newest first by day, with Load more", async ({
  dashboard,
  daemon,
}) => {
  const gone = await seedAndRestart(daemon);

  await dashboard.goto(`${daemon.baseURL}/#/history`);
  const page = dashboard.getByRole("main", { name: "History" });
  await expect(page.getByRole("heading", { name: "History", level: 2 })).toBeVisible();

  // First run: the progress line names the job while rows appear beneath it.
  const progress = page.getByRole("status");
  await expect(progress).toHaveText(/Indexing \d+ of \d+ sessions/);
  await expect(page.getByText("Operator named this one")).toBeVisible();
  await capture(dashboard, "first-run-progress");
  await expect(progress).toHaveText("", { timeout: 20_000 });

  // Title fallback: custom title, then AI title, then the first prompt.
  await expect(page.getByText("Operator named this one")).toBeVisible();
  await expect(page.getByText("Login retry fix")).toHaveCount(0);
  await expect(page.getByText("Beta release summary")).toBeVisible();
  await expect(page.getByText("A session titled only by its first prompt")).toBeVisible();
  await expect(page.getByText("An unplaceable session")).toBeVisible();

  // Conversations only: background runs stay out of the default list.
  await expect(page.getByText("Background one-shot run")).toHaveCount(0);
  await expect(page.getByText("Background reviewer run")).toHaveCount(0);

  // The full row: place, branch, kind, model, cost and duration.
  const newest = page.getByRole("listitem").filter({ hasText: "Operator named this one" });
  await expect(newest).toContainText("Interactive");
  await expect(newest).toContainText("/projects/alpha-service");
  await expect(newest).toContainText("fix-login-retry");
  await expect(newest).toContainText("claude-opus-5-5");
  await expect(newest).toContainText("$2.50");
  await expect(newest).toContainText("2m 05s");
  await expect(page.getByRole("listitem").filter({ hasText: "An unplaceable session" })).toContainText("Unclassified");

  // Newest activity first, grouped by day.
  const titles = page.locator(".history-row-title");
  await expect(titles.first()).toHaveText("Operator named this one");
  expect(await page.getByRole("heading", { level: 3 }).count()).toBeGreaterThanOrEqual(3);

  // One page of fifty, then Load more fetches the oldest.
  const conversations = 5 + FILLER;
  await expect(page.getByRole("listitem")).toHaveCount(50);
  await expect(page.getByText(`Filler conversation ${String(FILLER - 1).padStart(2, "0")}`)).toHaveCount(0);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("listitem")).toHaveCount(conversations);
  await expect(page.getByText(`Filler conversation ${String(FILLER - 1).padStart(2, "0")}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  await capture(dashboard, "loaded-more");

  // A transcript removed from disk keeps its row, marked gone, after the next complete walk.
  rmSync(gone.path);
  await expect.poll(async () => {
    const res = await fetch(`${daemon.baseURL}/api/history/sessions?limit=200`);
    const body = await res.json() as { sessions: { agentSessionId: string; transcriptState: string }[] };
    return body.sessions.find((row) => row.agentSessionId === gone.id)?.transcriptState;
  }).toBe("gone");
  await dashboard.reload();
  const goneRow = page.getByRole("listitem").filter({ hasText: "A transcript Claude Code will delete" });
  await expect(goneRow).toContainText("Transcript gone");
  await capture(dashboard, "transcript-gone");
});

test("a catalog read slower than the poll interval still lands, so the backfill is seen to finish", async ({
  dashboard,
  daemon,
}) => {
  await seedAndRestart(daemon);
  // Every read takes longer than the one-second poll. A poll that fires on a timer rather than
  // on an answer would abort each read before it landed and freeze the list mid-backfill.
  await dashboard.route("**/api/history/sessions**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  await dashboard.goto(`${daemon.baseURL}/#/history`);
  const page = dashboard.getByRole("main", { name: "History" });
  const progress = page.getByRole("status");
  await expect(progress).toHaveText(/Indexing \d+ of \d+ sessions/, { timeout: 10_000 });
  await expect(progress).toHaveText("", { timeout: 30_000 });
  await expect(page.getByRole("listitem")).toHaveCount(50);
});
