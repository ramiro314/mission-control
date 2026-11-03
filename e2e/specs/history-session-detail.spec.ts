import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * One History session: its header, its read-only conversation paged from the transcript on
 * disk, the retention message once that transcript is gone, and Live with Open in Fleet for a
 * session the fake agent keeps running.
 *
 * Transcripts are written into the daemon's redirected `~/.claude/projects` by this file, and
 * the live session is a fake Claude launched through the real dispatch route. No model token
 * is spent.
 */
test.use({ daemonEnv: { MISSION_HISTORY_RECONCILE_MS: "300" } });

const EVIDENCE = artifactsDir("history-session-detail");
/**
 * Turn pairs in the long conversation. A window is at least 100 turns and 512 KB, so 160 pairs
 * of about 4 KB span two windows and the second needs Load more.
 */
const PAIRS = 160;

let ordinal = 0;
function sessionId(): string {
  ordinal += 1;
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

/** Writes one interactive conversation the way Claude Code lays it out. */
function writeConversation(
  daemon: DaemonHandle,
  shape: { cwd: string; at: string; title: string; pairs: number; pad?: number },
): { id: string; path: string } {
  const id = sessionId();
  const base = { sessionId: id, cwd: shape.cwd, entrypoint: "cli", version: "2.1.296", gitBranch: "fix-login-retry", isSidechain: false };
  const start = Date.parse(shape.at);
  const lines: Record<string, unknown>[] = [{ ...base, timestamp: shape.at, type: "custom-title", customTitle: shape.title }];
  for (let i = 0; i < shape.pairs; i++) {
    const timestamp = new Date(start + i * 1_000).toISOString();
    const n = String(i).padStart(3, "0");
    lines.push({ ...base, timestamp, uuid: `u-${id}-${n}`, type: "user", message: { role: "user", content: `Question ${n}` } });
    lines.push({
      ...base,
      timestamp,
      uuid: `a-${id}-${n}`,
      type: "assistant",
      message: {
        id: `m-${id}-${n}`,
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: `Answer ${n}.${" ".repeat(shape.pad ?? 0)}` }],
      },
    });
  }
  lines.push({ ...base, timestamp: shape.at, type: "cost-state", totalCostUSD: 1.25, totalDuration: 65_000, startTime: start });
  const dir = join(daemon.home, ".claude", "projects", shape.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const at = new Date(shape.at);
  utimesSync(path, at, at);
  return { id, path };
}

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
}

interface CatalogRow {
  repoRoot: string | null;
  startedAt: number | null;
  lastActivityAt: number;
}

async function catalogRow(daemon: DaemonHandle, id: string): Promise<CatalogRow> {
  const res = await fetch(`${daemon.baseURL}/api/history/sessions/claude/${id}`);
  return ((await res.json()) as { session: CatalogRow }).session;
}

/** One header field's value, found by its label. */
function meta(detail: Locator, label: string): Locator {
  return detail.locator(".history-meta-item").filter({ has: detail.page().getByRole("term").filter({ hasText: label }) })
    .getByRole("definition");
}

/** A time as the header prints it, in the browser's own locale and zone. */
function stamp(page: Page, at: number): Promise<string> {
  return page.evaluate((value) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }), at);
}

/** Waits until the catalog holds `id`, in the state given. */
async function indexed(daemon: DaemonHandle, id: string, state: "present" | "gone" = "present"): Promise<void> {
  await expect.poll(async () => {
    const res = await fetch(`${daemon.baseURL}/api/history/sessions/claude/${id}`);
    if (!res.ok) return null;
    return ((await res.json()) as { session: { transcriptState: string } }).session.transcriptState;
  }, { timeout: 30_000 }).toBe(state);
}

test("a session opens from its row and from a deep link, pages its conversation, and Back returns to the list", async ({
  dashboard,
  daemon,
}) => {
  // In the fixture repository, so the header has a Repository to show.
  const long = writeConversation(daemon, { cwd: daemon.repo, at: "2026-10-30T15:00:00.000Z", title: "Fix the flaky login retry", pairs: PAIRS, pad: 4_000 });
  writeConversation(daemon, { cwd: "/projects/beta", at: "2026-10-29T12:00:00.000Z", title: "Summarize the beta notes", pairs: 1 });
  const gone = writeConversation(daemon, { cwd: "/projects/epsilon", at: "2026-10-28T10:00:00.000Z", title: "A transcript Claude Code will delete", pairs: 1 });
  await indexed(daemon, long.id);
  await indexed(daemon, gone.id);

  const row = await catalogRow(daemon, long.id);
  expect(row.repoRoot, "the fixture repository resolves").toBeTruthy();

  // Every read of the list itself, so Back can be shown to land on the list already loaded.
  let listReads = 0;
  dashboard.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/history/sessions") listReads += 1;
  });
  await dashboard.goto(`${daemon.baseURL}/#/history`);
  const list = dashboard.getByRole("main", { name: "History" });
  await expect(list.getByRole("listitem")).toHaveCount(3);

  // Open from the row.
  await list.getByRole("link", { name: "Fix the flaky login retry" }).click();
  await expect(dashboard).toHaveURL(new RegExp(`#/history/claude/${long.id}$`));
  const detail = dashboard.getByRole("main", { name: "History session" });
  await expect(detail.getByRole("heading", { name: "Fix the flaky login retry", level: 2 })).toBeVisible();
  await expect(meta(detail, "Repository")).toHaveText(row.repoRoot!);
  await expect(meta(detail, "Working directory")).toHaveText(daemon.repo);
  await expect(meta(detail, "Branch")).toHaveText("fix-login-retry");
  await expect(meta(detail, "Kind")).toHaveText("Interactive");
  await expect(meta(detail, "Model")).toHaveText("claude-opus-5-5");
  await expect(meta(detail, "Started")).toHaveText(await stamp(dashboard, row.startedAt!));
  await expect(meta(detail, "Last activity")).toHaveText(await stamp(dashboard, row.lastActivityAt));
  await expect(meta(detail, "Duration")).toHaveText("1m 05s");
  await expect(meta(detail, "Cost")).toHaveText("$1.25");

  // The conversation, read-only, one window at a time.
  await expect(detail.getByRole("tab", { name: "Conversation", selected: true })).toBeVisible();
  const panel = detail.getByRole("tabpanel");
  await expect(panel.getByText("Question 000", { exact: true })).toBeVisible();
  await expect(panel.getByText(/^Answer 000\./)).toBeVisible();
  await expect(panel.getByText(`Question ${PAIRS - 1}`, { exact: true })).toHaveCount(0);
  await expect(detail.getByRole("textbox")).toHaveCount(0);
  await capture(dashboard, "conversation");
  await panel.getByRole("button", { name: "Load more messages" }).click();
  await expect(panel.getByText(`Question ${PAIRS - 1}`, { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Load more messages" })).toHaveCount(0);
  await expect(panel.getByRole("article")).toHaveCount(PAIRS * 2);

  // Back lands on the list that was open: its rows are still there, not read again.
  const readsBeforeBack = listReads;
  await detail.getByRole("button", { name: "← History" }).click();
  await expect(dashboard).toHaveURL(/#\/history$/);
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await dashboard.waitForTimeout(500);
  expect(listReads, "Back reuses the list it left").toBe(readsBeforeBack);

  // A deep link opens the same detail.
  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${long.id}`);
  await expect(detail.getByRole("heading", { name: "Fix the flaky login retry", level: 2 })).toBeVisible();
  await expect(panel.getByText("Question 000", { exact: true })).toBeVisible();

  // An id History does not know says so, rather than drawing an empty session.
  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${sessionId()}`);
  await expect(detail.getByText("This session is not in History")).toBeVisible();

  // A gone transcript keeps its header and says why there is no conversation.
  rmSync(gone.path);
  await indexed(daemon, gone.id, "gone");
  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${gone.id}`);
  await expect(detail.getByRole("heading", { name: "A transcript Claude Code will delete", level: 2 })).toBeVisible();
  await expect(detail.getByText("Transcript gone")).toBeVisible();
  await expect(detail.getByText("/projects/epsilon", { exact: true })).toBeVisible();
  await expect(detail.getByRole("note")).toHaveText(/removed by Claude Code's retention/);
  await expect(detail.getByText("Question 000", { exact: true })).toHaveCount(0);
  await capture(dashboard, "transcript-gone");
});

interface LiveSession {
  id: string;
  runtime: string;
  agentSessionId: string | null;
}

test("a session the fake agent keeps running shows Live and opens in the Fleet", async ({ dashboard, daemon }) => {
  // Through `POST /api/tasks`, which launches now; `workflowId: null` opts out of a Workflow
  // this fixture repository is not allowlisted for.
  const res = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoRoot: daemon.repo, title: "Keep running for History", intent: "stay open", workflowId: null }),
  });
  expect(res.ok, `dispatch answered ${res.status}`).toBe(true);
  let live: LiveSession | undefined;
  await expect.poll(async () => {
    const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as LiveSession[];
    live = sessions.find((s) => s.runtime === "sdk" && s.agentSessionId !== null);
    return Boolean(live);
  }, { timeout: 30_000 }).toBe(true);
  const agentSessionId = live!.agentSessionId!;
  await indexed(daemon, agentSessionId);

  // What the detail asks for: one transcript read, and no live stream.
  let messageReads = 0;
  let streams = 0;
  dashboard.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === `/api/history/sessions/claude/${agentSessionId}/messages`) messageReads += 1;
    if (path.endsWith("/transcript/stream")) streams += 1;
  });

  await dashboard.goto(`${daemon.baseURL}/#/history`);
  const list = dashboard.getByRole("main", { name: "History" });
  const row = list.getByRole("listitem").filter({ has: dashboard.getByRole("link") }).first();
  await expect(row).toContainText("Live");
  await capture(dashboard, "live-list");
  await row.getByRole("link").click();

  const detail = dashboard.getByRole("main", { name: "History session" });
  await expect(detail.getByText("Live", { exact: true })).toBeVisible();
  const open = detail.getByRole("button", { name: "Open in Fleet" });
  await expect(open).toBeVisible();
  await expect(detail.getByRole("tabpanel").getByRole("article").first()).toBeVisible();
  await capture(dashboard, "live");
  // The fake agent keeps running; the detail still read its transcript once and streams nothing.
  await dashboard.waitForTimeout(1_000);
  expect(messageReads).toBe(1);
  expect(streams).toBe(0);
  await open.click();
  await expect(dashboard).toHaveURL(/#\/fleet/);
});

test("a failed read says so and recovers on Try again, and a refused Load more keeps the rows", async ({ dashboard, daemon }) => {
  const long = writeConversation(daemon, { cwd: "/projects/alpha-service", at: "2026-10-30T15:00:00.000Z", title: "Fix the flaky login retry", pairs: PAIRS, pad: 4_000 });
  await indexed(daemon, long.id);
  const detailUrl = `**/api/history/sessions/claude/${long.id}`;
  const firstWindow = `**/api/history/sessions/claude/${long.id}/messages`;
  const laterWindow = `**/api/history/sessions/claude/${long.id}/messages?cursor=*`;
  const detail = dashboard.getByRole("main", { name: "History session" });
  const panel = detail.getByRole("tabpanel");

  // The session itself cannot be read: not "unknown", but unavailable, with a way back.
  await dashboard.route(detailUrl, (route) => route.fulfill({ status: 500, json: { error: "the catalog is busy" } }));
  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${long.id}`);
  await expect(detail.getByText("History is unavailable")).toBeVisible();
  await expect(detail.getByText("the catalog is busy")).toBeVisible();
  await expect(detail.getByText("This session is not in History")).toHaveCount(0);
  await dashboard.unroute(detailUrl);

  // Its conversation cannot be read.
  await dashboard.route(firstWindow, (route) => route.fulfill({ status: 500, json: { error: "the disk is busy" } }));
  await detail.getByRole("button", { name: "Try again" }).click();
  await expect(detail.getByRole("heading", { name: "Fix the flaky login retry", level: 2 })).toBeVisible();
  await expect(panel.getByText("Could not read this conversation")).toBeVisible();
  await expect(panel.getByText("the disk is busy")).toBeVisible();
  await dashboard.unroute(firstWindow);
  await panel.getByRole("button", { name: "Try again" }).click();
  await expect(panel.getByText("Question 000", { exact: true })).toBeVisible();

  // A later window is refused: the turns already read stay, and the button stays usable.
  await dashboard.route(laterWindow, (route) => route.fulfill({ status: 500, json: { error: "the disk is busy" } }));
  await panel.getByRole("button", { name: "Load more messages" }).click();
  await expect(panel.getByRole("alert")).toHaveText("Could not load more messages: the disk is busy");
  await expect(panel.getByText("Question 000", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Load more messages" })).toBeEnabled();
  await capture(dashboard, "load-more-refused");
  await dashboard.unroute(laterWindow);
  await panel.getByRole("button", { name: "Load more messages" }).click();
  await expect(panel.getByText(`Question ${PAIRS - 1}`, { exact: true })).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

test.describe("a transcript deleted after its row was indexed", () => {
  // No recurring scan: the one pass at startup indexes the row, and nothing marks it gone after.
  test.use({ daemonEnv: { MISSION_HISTORY_RECONCILE_MS: "0" } });

  test("shows the retention message while its row still says present", async ({ dashboard, daemon }) => {
    const session = writeConversation(daemon, { cwd: "/projects/zeta", at: "2026-10-27T10:00:00.000Z", title: "Deleted between scans", pairs: 1 });
    // The fixture daemon's startup pass saw an empty store; a restart is a startup onto this one.
    await daemon.crash();
    await daemon.restart();
    await indexed(daemon, session.id);
    rmSync(session.path);

    await dashboard.goto(`${daemon.baseURL}/#/history/claude/${session.id}`);
    const detail = dashboard.getByRole("main", { name: "History session" });
    await expect(detail.getByRole("heading", { name: "Deleted between scans", level: 2 })).toBeVisible();
    await expect(detail.getByRole("note")).toHaveText(/removed by Claude Code's retention/);
    // The read found it gone; the catalog has not walked since, so the row is not yet badged.
    await expect(detail.getByText("Transcript gone")).toHaveCount(0);
    expect((await catalogRow(daemon, session.id) as CatalogRow & { transcriptState: string }).transcriptState).toBe("present");
  });
});
