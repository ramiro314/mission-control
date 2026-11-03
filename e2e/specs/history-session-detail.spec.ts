import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * One History session: its header, its read-only conversation paged from the transcript on
 * disk, its launch context as the transcript recorded it, the retention message once that
 * transcript is gone, and Live with Open in Fleet for a session the fake agent keeps running.
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
  shape: {
    cwd: string;
    at: string;
    title: string;
    pairs: number;
    pad?: number;
    /** Attachment bodies, recorded after the title. */
    launch?: Record<string, unknown>[];
    /** Whole records, recorded after the conversation. */
    records?: Record<string, unknown>[];
  },
): { id: string; path: string } {
  const id = sessionId();
  const base = { sessionId: id, cwd: shape.cwd, entrypoint: "cli", version: "2.1.296", gitBranch: "fix-login-retry", isSidechain: false };
  const start = Date.parse(shape.at);
  const lines: Record<string, unknown>[] = [{ ...base, timestamp: shape.at, type: "custom-title", customTitle: shape.title }];
  for (const attachment of shape.launch ?? []) lines.push({ ...base, timestamp: shape.at, type: "attachment", attachment });
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
  for (const record of shape.records ?? []) lines.push({ ...base, timestamp: shape.at, ...record });
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
  // The page scrolls inside the app, so the frame above stops at the header; this one shows
  // where the first window ends.
  await panel.getByRole("button", { name: "Load more messages" }).scrollIntoViewIfNeeded();
  await capture(dashboard, "conversation-load-more");
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

  // A filtered list: the detail carries its filters, and Back returns to that list, not the bare one.
  await dashboard.goto(`${daemon.baseURL}/#/history?q=flaky`);
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await list.getByRole("link", { name: "Fix the flaky login retry" }).click();
  await expect(dashboard).toHaveURL(new RegExp(`#/history/claude/${long.id}\\?q=flaky$`));
  await detail.getByRole("button", { name: "← History" }).click();
  await expect(dashboard).toHaveURL(/#\/history\?q=flaky$/);
  await expect(list.getByLabel("Search history")).toHaveValue("flaky");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await capture(dashboard, "back-with-filters");

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
  // Nothing is left on disk to resume.
  await expect(detail.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
  await expect(detail.getByText("/projects/epsilon", { exact: true })).toBeVisible();
  await expect(detail.getByRole("note")).toHaveText(/removed by Claude Code's retention/);
  await expect(detail.getByText("Question 000", { exact: true })).toHaveCount(0);
  await capture(dashboard, "transcript-gone");
});

test("Launch context renders every recorded section, the instruction files as loaded, and Not recorded for what is missing", async ({ dashboard, daemon }) => {
  // The session loaded one CLAUDE.md, and the file on disk has been rewritten since.
  const claudeMd = join(daemon.repo, "CLAUDE.md");
  writeFileSync(claudeMd, "# Demo repo\nRewritten after the session ran.\n");
  const session = writeConversation(daemon, {
    cwd: daemon.repo,
    at: "2026-10-30T15:00:00.000Z",
    title: "Session with a launch context",
    pairs: 1,
    launch: [
      {
        type: "instructions",
        reason: "session_start",
        files: [
          { path: claudeMd, type: "Project", content: "# Demo repo\nRun only the focused test." },
          { path: "/home/op/.claude/CLAUDE.md", type: "User", content: "# Global\nPrefer small diffs." },
        ],
      },
      {
        type: "prompt_snapshot",
        systemPrompt: ["Ask through the Mission Control channel.\n\n## Standing instructions for this repository\n\nNever push without asking."],
      },
      { type: "skill_listing", names: ["tdd", "brief"], skillCount: 2, isInitial: true },
      { type: "mcp_instructions_delta", addedNames: ["docs"], addedBlocks: ["Search the docs before answering."], removedNames: [] },
      {
        type: "deferred_tools_delta",
        addedNames: ["mcp__docs__search", "mcp__docs__read"],
        removedNames: [],
        pendingMcpServers: ["claude.ai Gmail"],
        needsAuthMcpServers: ["claude.ai Slack"],
        failedMcpServers: ["broken-server"],
      },
      { type: "environment", snapshot: { workingDirectory: daemon.repo, isWorktree: false, isGitRepo: true, additionalWorkingDirectories: [] } },
      { type: "session_context", context: { gitStatus: "Current branch: fix-login-retry\n(clean)" } },
      { type: "a_future_attachment", anything: true },
    ],
    records: [
      {
        type: "assistant",
        uuid: "skill-call",
        message: { id: "m-skill", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_skill", name: "Skill", input: { skill: "tdd" } }] },
      },
      { type: "system", subtype: "stop_hook_summary", hookCount: 1, hookInfos: [{ command: "notify.sh", durationMs: 400 }], hookErrors: [] },
      { type: "system", subtype: "stop_hook_summary", hookCount: 1, hookInfos: [{ command: "notify.sh", durationMs: 700 }], hookErrors: [] },
      { type: "attachment", attachment: { type: "hook_cancelled", hookName: "Stop", hookEvent: "Stop", command: "notify.sh", durationMs: 2_000, timedOut: true } },
      { type: "system", subtype: "stop_hook_summary", hookCount: 1, hookInfos: [{ command: "lint.sh", durationMs: 250 }], hookErrors: [] },
      { type: "system", subtype: "stop_hook_summary", hookCount: 1, hookInfos: [{ command: "lint.sh", durationMs: 100 }], hookErrors: ["exit code 1"] },
    ],
  });
  const bare = writeConversation(daemon, { cwd: "/projects/beta", at: "2026-10-29T12:00:00.000Z", title: "Session with nothing recorded", pairs: 1 });
  const gone = writeConversation(daemon, { cwd: "/projects/epsilon", at: "2026-10-28T10:00:00.000Z", title: "Launch context Claude Code will delete", pairs: 1 });
  await indexed(daemon, session.id);
  await indexed(daemon, bare.id);
  await indexed(daemon, gone.id);

  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${session.id}`);
  const detail = dashboard.getByRole("main", { name: "History session" });
  await expect(detail.getByRole("tab", { name: "Conversation", selected: true })).toBeVisible();
  await detail.getByRole("tab", { name: "Launch context" }).click();
  await expect(detail.getByRole("tab", { name: "Launch context", selected: true })).toBeVisible();
  const panel = detail.getByRole("tabpanel");
  await expect(panel).toHaveCount(1);
  const section = (name: string) => panel.getByRole("region", { name });

  // Instruction files: path, scope and reason, and the text as the session loaded it.
  const files = section("Instruction files");
  await expect(files.getByText(claudeMd, { exact: true })).toBeVisible();
  await expect(files.getByText("/home/op/.claude/CLAUDE.md", { exact: true })).toBeVisible();
  await expect(files.getByText("Project", { exact: true })).toBeVisible();
  await expect(files.getByText("User", { exact: true })).toBeVisible();
  await expect(files.getByText("Loaded at session start")).toHaveCount(2);
  await files.getByText(claudeMd, { exact: true }).click();
  await expect(files.getByText(/Run only the focused test\./)).toBeVisible();
  await expect(files.getByText(/Rewritten after the session ran/)).toHaveCount(0);
  await files.scrollIntoViewIfNeeded();
  await capture(dashboard, "launch-context-instructions");

  // The standing block is split off the appended value it was joined into.
  await expect(section("Standing instructions")).toContainText("Never push without asking.");
  const appended = section("Appended system prompt");
  await expect(appended).not.toContainText("Never push without asking.");
  await appended.getByText("Ask through the Mission Control channel.").first().click();
  await expect(appended.locator("pre")).toHaveText("Ask through the Mission Control channel.");
  await expect(section("Skills").getByRole("list", { name: "Skills available" })).toHaveText(/tdd\s*brief/);
  await expect(section("Skills").getByRole("list", { name: "Skills used" })).toHaveText("tdd");
  await expect(section("Environment")).toContainText("Current branch: fix-login-retry");

  // MCP: each server with its status, the instructions one sent, and the tools offered.
  const mcp = section("MCP servers and tools");
  const server = (name: string) => mcp.getByRole("list", { name: "MCP servers" }).getByRole("listitem").filter({ hasText: name });
  await expect(server("docs")).toContainText("Connected");
  await expect(server("claude.ai Slack")).toContainText("Needs authentication");
  await expect(server("claude.ai Gmail")).toContainText("Pending");
  await expect(server("broken-server")).toContainText("Failed");
  await server("docs").getByText("Instructions", { exact: true }).click();
  await expect(server("docs")).toContainText("Search the docs before answering.");
  await mcp.getByText("2 tools", { exact: true }).click();
  await expect(mcp.getByRole("list", { name: "MCP tools" })).toHaveText(/mcp__docs__search\s*mcp__docs__read/);

  // Hooks: one row per event and command, with runs, failures (cancelled or errored) and durations.
  const hooks = section("Hooks");
  const notify = hooks.getByRole("row").filter({ hasText: "notify.sh" });
  await expect(notify.getByRole("cell")).toHaveText(["Stop", "notify.sh", "3 (1 failed)", "3s", "2s"]);
  const lint = hooks.getByRole("row").filter({ hasText: "lint.sh" });
  await expect(lint.getByRole("cell")).toHaveText(["Stop", "lint.sh", "2 (1 failed)", "350 ms", "250 ms"]);
  await capture(dashboard, "launch-context");
  await hooks.scrollIntoViewIfNeeded();
  await capture(dashboard, "launch-context-mcp-hooks");

  // Back on the Conversation tab, its transcript is still the one already read.
  await detail.getByRole("tab", { name: "Conversation" }).click();
  await expect(detail.getByRole("tabpanel").getByText("Question 000", { exact: true })).toBeVisible();

  // A read that fails says so, and Try again reads it.
  const launchUrl = `**/api/history/sessions/claude/${bare.id}/launch-context`;
  await dashboard.route(launchUrl, (route) => route.fulfill({ status: 500, json: { error: "could not read this transcript (EACCES)" } }));
  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${bare.id}`);
  await detail.getByRole("tab", { name: "Launch context" }).click();
  await expect(panel.getByText("Could not read the launch context")).toBeVisible();
  await expect(panel.getByText("could not read this transcript (EACCES)")).toBeVisible();
  await expect(panel.getByRole("region")).toHaveCount(0);
  await dashboard.unroute(launchUrl);
  await panel.getByRole("button", { name: "Try again" }).click();
  await expect(section("Instruction files")).toBeVisible();

  // A session that recorded no launch context at all: every section says Not recorded.
  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${bare.id}`);
  await detail.getByRole("tab", { name: "Launch context" }).click();
  for (const name of ["Instruction files", "Standing instructions", "Appended system prompt", "MCP servers and tools", "Hooks"]) {
    await expect(section(name).getByText("Not recorded", { exact: true }), name).toBeVisible();
  }
  await expect(section("Skills").getByText("Not recorded", { exact: true })).toBeVisible();
  await capture(dashboard, "launch-context-not-recorded");
  await section("Hooks").scrollIntoViewIfNeeded();
  await capture(dashboard, "launch-context-not-recorded-hooks");

  // A gone transcript shows the retention message and nothing else.
  rmSync(gone.path);
  await indexed(daemon, gone.id, "gone");
  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${gone.id}`);
  await detail.getByRole("tab", { name: "Launch context" }).click();
  await expect(panel.getByRole("note")).toHaveText(/removed by Claude Code's retention/);
  await expect(panel.getByRole("region")).toHaveCount(0);
  await capture(dashboard, "launch-context-gone");
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
  // A running conversation is opened where it runs, never resumed a second time beside it.
  await expect(detail.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
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

  test("shows the retention message on both tabs while its row still says present", async ({ dashboard, daemon }) => {
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

    // The Launch context tab reads the transcript too: its 410 is the retention message, not a failed read.
    let launchStatus = 0;
    dashboard.on("response", (response) => {
      if (new URL(response.url()).pathname === `/api/history/sessions/claude/${session.id}/launch-context`) launchStatus = response.status();
    });
    await detail.getByRole("tab", { name: "Launch context" }).click();
    const panel = detail.getByRole("tabpanel");
    await expect(panel.getByRole("note")).toHaveText(/removed by Claude Code's retention/);
    expect(launchStatus, "the tab fetched, rather than short-circuiting on a gone row").toBe(410);
    await expect(panel.getByRole("region")).toHaveCount(0);
    await expect(panel.getByText("Could not read the launch context")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await capture(dashboard, "launch-context-deleted-between-scans");
    expect((await catalogRow(daemon, session.id) as CatalogRow & { transcriptState: string }).transcriptState).toBe("present");
  });
});
