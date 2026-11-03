import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

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
async function seedAndRestart(daemon: DaemonHandle, filler = FILLER): Promise<{ id: string; path: string }> {
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
  for (let i = 0; i < filler; i++) {
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

/** Waits until the daemon's backfill over the seeded store has finished. */
async function backfilled(daemon: DaemonHandle): Promise<void> {
  await expect.poll(async () => {
    const res = await fetch(`${daemon.baseURL}/api/history/sessions?limit=1`);
    const body = await res.json() as { progress: { indexing: boolean; total: number } };
    return !body.progress.indexing && body.progress.total > 0;
  }, { timeout: 30_000 }).toBe(true);
}

test("Load more lands while slow indexing re-reads keep running", async ({ dashboard, daemon }) => {
  await seedAndRestart(daemon);
  await backfilled(daemon);
  // Every read is slower than the poll, and the first page keeps reporting a backfill in
  // progress, so the page re-reads for the whole test. A re-read that started while Load more
  // was in flight would abort it, and the button would flip back with no rows added.
  await dashboard.route("**/api/history/sessions**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const response = await route.fetch();
    if (route.request().url().includes("cursor=")) {
      await route.fulfill({ response });
      return;
    }
    const body = await response.json() as { progress: unknown };
    body.progress = { indexing: true, indexed: 56, total: 59 };
    await route.fulfill({ response, json: body });
  });
  await dashboard.goto(`${daemon.baseURL}/#/history`);
  const page = dashboard.getByRole("main", { name: "History" });
  await expect(page.getByRole("status")).toHaveText("Indexing 56 of 59 sessions");
  await expect(page.getByRole("listitem")).toHaveCount(50);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("listitem")).toHaveCount(57, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
});

test("a re-read that started before Load more does not undo it when it lands later", async ({ dashboard, daemon }) => {
  await seedAndRestart(daemon);
  await backfilled(daemon);
  // The first read reports indexing, so the page starts its poll. Every later re-read is slow
  // and reports the backfill done, so if one lands after Load more and replaces its rows, no
  // further poll ever puts them back. Load more itself is quick.
  let windowReads = 0;
  let slowReadSettled = false;
  await dashboard.route("**/api/history/sessions**", async (route) => {
    if (route.request().url().includes("cursor=")) {
      await route.fulfill({ response: await route.fetch() });
      return;
    }
    windowReads += 1;
    if (windowReads === 1) {
      const response = await route.fetch();
      const body = await response.json() as { progress: unknown };
      body.progress = { indexing: true, indexed: 50, total: 57 };
      await route.fulfill({ response, json: body });
      return;
    }
    try {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await route.fulfill({ response: await route.fetch() });
    } catch {
      // The page cancelled this read, which is the fix under test.
    } finally {
      slowReadSettled = true;
    }
  });
  await dashboard.goto(`${daemon.baseURL}/#/history`);
  const page = dashboard.getByRole("main", { name: "History" });
  const rows = page.getByRole("listitem");
  await expect(rows).toHaveCount(50);
  // Wait for the poll's re-read to be in flight, then page.
  await expect.poll(() => windowReads, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(rows).toHaveCount(57);
  await expect.poll(() => slowReadSettled, { timeout: 10_000 }).toBe(true);
  // Give a late answer the chance to render before asserting it did not.
  await dashboard.waitForTimeout(300);
  await expect(rows).toHaveCount(57);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
});

test("a background re-read that fails keeps the rows on screen and the poll going", async ({ dashboard, daemon }) => {
  await seedAndRestart(daemon);
  await backfilled(daemon);
  // The first read reports indexing, so the page polls. The next re-read fails; the one after
  // answers truthfully that the backfill is done. A page that dropped its rows for an error on
  // the failed re-read, or stopped polling there, never shows the finished state.
  let windowReads = 0;
  await dashboard.route("**/api/history/sessions**", async (route) => {
    if (route.request().url().includes("cursor=")) {
      await route.fulfill({ response: await route.fetch() });
      return;
    }
    windowReads += 1;
    if (windowReads === 2) {
      await route.fulfill({ status: 500, json: { error: "the daemon is restarting" } });
      return;
    }
    const response = await route.fetch();
    if (windowReads === 1) {
      const body = await response.json() as { progress: unknown };
      body.progress = { indexing: true, indexed: 50, total: 57 };
      await route.fulfill({ response, json: body });
      return;
    }
    await route.fulfill({ response });
  });
  await dashboard.goto(`${daemon.baseURL}/#/history`);
  const page = dashboard.getByRole("main", { name: "History" });
  const rows = page.getByRole("listitem");
  await expect(page.getByRole("status")).toHaveText("Indexing 50 of 57 sessions");
  await expect(rows).toHaveCount(50);
  await expect.poll(() => windowReads, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByText("History is unavailable")).toHaveCount(0);
  await expect(rows).toHaveCount(50);
  // The poll carried on past the failure and saw the backfill finish.
  await expect.poll(() => windowReads, { timeout: 5_000 }).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole("status")).toHaveText("");
  await expect(rows).toHaveCount(50);
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
});

test("a Load more the daemon refuses says why, and keeps the rows and the button", async ({ dashboard, daemon }) => {
  await seedAndRestart(daemon);
  await backfilled(daemon);
  await dashboard.route("**/api/history/sessions?*cursor=*", (route) =>
    route.fulfill({ status: 500, json: { error: "the catalog is busy" } }));
  await dashboard.goto(`${daemon.baseURL}/#/history`);
  const page = dashboard.getByRole("main", { name: "History" });
  await expect(page.getByRole("listitem")).toHaveCount(50);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("alert")).toHaveText("Could not load older sessions: the catalog is busy");
  await expect(page.getByRole("listitem")).toHaveCount(50);
  await expect(page.getByRole("button", { name: "Load more" })).toBeEnabled();
  await capture(dashboard, "load-more-refused");
});

test.describe("a window paged past the route's 200-row cap", () => {
  // A fast backfill, so 260 fixtures index in a moment; the indexing state the page re-reads
  // under comes from the route rewrite below instead.
  test.use({ daemonEnv: { MISSION_HISTORY_RECONCILE_MS: "300", MISSION_HISTORY_BATCH_SIZE: "100" } });

  test("survives the indexing re-read with every row and its cursor", async ({ dashboard, daemon }) => {
    await seedAndRestart(daemon, 255);
    await backfilled(daemon);
    // Every read keeps reporting a backfill, so the page re-reads once a second throughout.
    // Reads without a cursor are the re-reads, each the start of a rebuilt window.
    let rereads = 0;
    await dashboard.route("**/api/history/sessions**", async (route) => {
      const response = await route.fetch();
      if (!route.request().url().includes("cursor=")) rereads += 1;
      const body = await response.json() as { progress: unknown };
      body.progress = { indexing: true, indexed: 259, total: 262 };
      await route.fulfill({ response, json: body });
    });
    await dashboard.goto(`${daemon.baseURL}/#/history`);
    const page = dashboard.getByRole("main", { name: "History" });
    const rows = page.getByRole("listitem");
    await expect(rows).toHaveCount(50);
    for (const depth of [100, 150, 200, 250]) {
      await page.getByRole("button", { name: "Load more" }).click();
      await expect(rows).toHaveCount(depth);
    }
    // Two full re-reads after the last page landed. Each one rebuilds the window from the top,
    // and a rebuild capped at 200 rows would drop the last fifty and move the cursor back.
    const after = rereads;
    await expect.poll(() => rereads, { timeout: 10_000 }).toBeGreaterThanOrEqual(after + 2);
    await expect(rows).toHaveCount(250);
    // Five featured conversations sit above the filler, so the 250th row is filler 244.
    await expect(page.getByText("Filler conversation 244", { exact: true })).toBeVisible();
    await expect(page.getByText("Filler conversation 245", { exact: true })).toHaveCount(0);
    // The cursor still continues below the window: the next page holds the last ten.
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(rows).toHaveCount(260);
  });
});

test.describe("search and filters", () => {
  // A fast backfill: these fixtures are few, and the first run is not what is under test.
  test.use({ daemonEnv: { MISSION_HISTORY_RECONCILE_MS: "300", MISSION_HISTORY_BATCH_SIZE: "100" } });

  const POOL = "/projects/worktree-pools/app-1f2e";

  /**
   * Two slots of one worktree pool whose directories never existed on disk, a plain checkout,
   * and a background run in the pool. The pool row is what an earlier daemon would have left;
   * the restart is the first run that indexes them.
   */
  async function seedFilters(daemon: DaemonHandle): Promise<void> {
    withDaemonDb(daemon, (db) => {
      db.prepare(
        `INSERT INTO worktree_pools (id, git_common_dir, main_checkout_root, pool_path, created_at, updated_at)
         VALUES ('e2e-history-pool', '/projects/app/.git', '/projects/app', ?, 0, 0)`,
      ).run(POOL);
    });
    writeSession(daemon, {
      cwd: `${POOL}/3/app`,
      at: "2026-10-15T12:00:00.000Z",
      prompt: "Set up the build",
      extra: [
        { type: "user", timestamp: "2026-10-15T12:05:00.000Z", message: { role: "user", content: "Then rename the walrus module" } },
        { type: "ai-title", aiTitle: "Module rename" },
      ],
    });
    writeSession(daemon, { cwd: `${POOL}/5/app`, at: "2026-10-05T12:00:00.000Z", prompt: "Older slot work" });
    writeSession(daemon, { cwd: "/projects/plain", at: "2026-10-25T12:00:00.000Z", prompt: "Plain checkout work" });
    writeSession(daemon, {
      cwd: `${POOL}/4/app`,
      at: "2026-10-16T12:00:00.000Z",
      entrypoint: "sdk-ts",
      tools: [],
      prompt: "Generate a commit message",
      extra: [{ type: "user", message: { role: "user", content: "A second background prompt about the walrus" } }],
    });
    await daemon.crash();
    await daemon.restart();
  }

  test("search finds a conversation by a later prompt, and the filters survive a reload", async ({ dashboard, daemon }) => {
    await seedFilters(daemon);
    await backfilled(daemon);
    await dashboard.goto(`${daemon.baseURL}/#/history`);
    const page = dashboard.getByRole("main", { name: "History" });
    const rows = page.getByRole("listitem");
    await expect(rows).toHaveCount(3);
    await expect(page.getByText("Generate a commit message")).toHaveCount(0);
    // Only Claude has a history reader, so there is nothing to choose between.
    await expect(page.getByRole("combobox", { name: "Agent", exact: true })).toHaveCount(0);

    // A conversation's later prompt is indexed. The background run's second prompt is not, so
    // even with background runs shown it does not match.
    const search = page.getByRole("searchbox", { name: "Search history" });
    await search.fill("WALRUS");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Module rename");
    await expect(dashboard).toHaveURL(/#\/history\?q=WALRUS$/);
    await page.getByRole("combobox", { name: "Kind", exact: true }).selectOption("all");
    await expect(rows).toHaveCount(1);
    await search.fill("commit message");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Generate a commit message");
    await expect(rows.first()).toContainText("One-shot");
    await search.fill("");
    await expect(rows).toHaveCount(4);
    await page.getByRole("combobox", { name: "Kind", exact: true }).selectOption("");
    await expect(rows).toHaveCount(3);

    // Pool slots collapse to their repository, in the filter and in each row.
    const repository = page.getByRole("combobox", { name: "Repository", exact: true });
    await expect(repository.getByRole("option")).toHaveText(["Any repository", "/projects/app"]);
    await repository.selectOption("/projects/app");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Plain checkout work" })).toHaveCount(0);
    await expect(rows.filter({ hasText: "Module rename" })).toContainText("app");

    // A date range, then the Kind filter adds the background run inside it.
    await page.getByLabel("From", { exact: true }).fill("2026-10-10");
    await page.getByLabel("To", { exact: true }).fill("2026-10-20");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Module rename");
    await page.getByRole("combobox", { name: "Kind", exact: true }).selectOption("all");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Generate a commit message" })).toHaveCount(1);
    await expect(dashboard).toHaveURL(/#\/history\?repo=%2Fprojects%2Fapp&from=2026-10-10&to=2026-10-20&kind=all$/);
    await capture(dashboard, "filters");

    // The filters are the route, so a reload lands on the same list with the same controls.
    await dashboard.reload();
    await expect(rows).toHaveCount(2);
    await expect(repository).toHaveValue("/projects/app");
    await expect(page.getByLabel("From", { exact: true })).toHaveValue("2026-10-10");
    await expect(page.getByLabel("To", { exact: true })).toHaveValue("2026-10-20");
    await expect(page.getByRole("combobox", { name: "Kind", exact: true })).toHaveValue("all");

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(rows).toHaveCount(3);
    await expect(dashboard).toHaveURL(/#\/history$/);
  });

  test("the header shows Claude Code's retention, 30 days when unset, and links to the setting", async ({ dashboard, daemon }) => {
    await dashboard.goto(`${daemon.baseURL}/#/history`);
    const page = dashboard.getByRole("main", { name: "History" });
    await expect(page.getByText("Claude Code keeps transcripts for 30 days.")).toBeVisible();
    const link = page.getByRole("link", { name: "cleanupPeriodDays" });
    await expect(link).toHaveAttribute("href", "https://code.claude.com/docs/en/settings-reference#cleanupperioddays");

    mkdirSync(join(daemon.home, ".claude"), { recursive: true });
    writeFileSync(join(daemon.home, ".claude", "settings.json"), JSON.stringify({ cleanupPeriodDays: 14 }));
    await dashboard.reload();
    await expect(page.getByText("Claude Code keeps transcripts for 14 days.")).toBeVisible();
    await capture(dashboard, "retention-configured");
  });
});
