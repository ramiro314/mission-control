import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { launchedCommand } from "../fixtures/isolated-launch.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { recordsIn } from "../fixtures/records.ts";

/**
 * History Resume in the original directory: the Resume button a conversation offers, the
 * dialog that reads `resume-options`, the terminal it opens, and the pending launch that blocks
 * a second Resume until Cancel pending resume closes it. Then the slot target: an original
 * directory that is a worktree slot another owner holds opens the picker, the chosen slot is
 * leased and named on its card, and Returning it there releases the launch. Last, what a slot
 * card says once a resumed session ends: kept with its reason when dirty, back in the pool when
 * clean, and held when its agent never appeared.
 *
 * The terminal is the suite's fake cmux (`CMUX_BIN`, see fake-agents.ts), which records the
 * `new-workspace` it was asked for and runs nothing, so the command a person's terminal would
 * run is read back from that record. The agent is the fake Claude. No model token is spent.
 * Live with Open in Fleet, and no Resume, for a running session is pinned in
 * `history-session-detail.spec.ts`.
 */
test.use({ daemonEnv: { MISSION_HISTORY_RECONCILE_MS: "300" } });

const EVIDENCE = artifactsDir("history-resume");

let ordinal = 0;
function sessionId(): string {
  ordinal += 1;
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

/**
 * Writes one conversation the way Claude Code lays it out, recorded in `cwd`. A one-shot run
 * carries an empty tool list in its prompt snapshot; `mode` is the permission mode it last
 * recorded.
 */
function writeSession(
  daemon: DaemonHandle,
  shape: { cwd: string; title: string; at: string; oneShot?: boolean; mode?: string; branch?: string },
): string {
  const id = sessionId();
  const base = {
    sessionId: id,
    cwd: shape.cwd,
    entrypoint: shape.oneShot ? "sdk-cli" : "cli",
    version: "2.1.296",
    gitBranch: shape.branch ?? "main",
    isSidechain: false,
  };
  const lines: Record<string, unknown>[] = [{ ...base, timestamp: shape.at, type: "custom-title", customTitle: shape.title }];
  if (shape.mode) lines.push({ type: "permission-mode", permissionMode: shape.mode, sessionId: id });
  if (shape.oneShot) {
    lines.push({ ...base, timestamp: shape.at, type: "attachment", attachment: { type: "prompt_snapshot", cliPrefix: "You are a Claude agent", tools: [], systemPrompt: [] } });
  }
  lines.push({ ...base, timestamp: shape.at, uuid: `u-${id}`, type: "user", message: { role: "user", content: `Start ${shape.title}` } });
  lines.push({
    ...base,
    timestamp: shape.at,
    uuid: `a-${id}`,
    type: "assistant",
    message: { id: `m-${id}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "On it." }] },
  });
  const dir = join(daemon.home, ".claude", "projects", shape.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const at = new Date(shape.at);
  utimesSync(path, at, at);
  return id;
}

async function indexed(daemon: DaemonHandle, id: string): Promise<void> {
  await expect.poll(async () => (await fetch(`${daemon.baseURL}/api/history/sessions/claude/${id}`)).status, { timeout: 30_000 }).toBe(200);
}

/** Every `new-workspace` the fake cmux was asked for, oldest first. */
function workspaces(daemon: DaemonHandle): string[][] {
  return recordsIn<{ argv?: unknown }>(daemon.recordDir, (file) => file.startsWith("cmux-"))
    .map((record) => (Array.isArray(record.argv) ? record.argv.filter((arg): arg is string => typeof arg === "string") : []))
    .filter((argv) => argv[0] === "new-workspace");
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
}

function detail(page: Page): Locator {
  return page.getByRole("main", { name: "History session" });
}

test("Resume opens a terminal in the original directory, and a pending launch blocks a second until it is cancelled", async ({
  dashboard,
  daemon,
}) => {
  const original = join(daemon.home, "projects", "resume-original");
  mkdirSync(original, { recursive: true });
  const id = writeSession(daemon, { cwd: original, title: "Tidy the release notes", at: "2026-10-30T15:00:00.000Z", mode: "acceptEdits" });
  await indexed(daemon, id);

  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${id}`);
  const view = detail(dashboard);
  await expect(view.getByRole("heading", { name: "Tidy the release notes", level: 2 })).toBeVisible();
  await expect(view.getByRole("button", { name: "Open in Fleet" })).toHaveCount(0);
  await expect(view.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await capture(dashboard, "00-button");
  await view.getByRole("button", { name: "Resume", exact: true }).click();

  const dialog = dashboard.getByRole("dialog", { name: "Resume this conversation" });
  await expect(dialog.getByText(original, { exact: true })).toBeVisible();
  await expect(dialog.getByText("Still there", { exact: true })).toBeVisible();
  const menu = dialog.getByRole("menu", { name: "Resume in" });
  const cmux = menu.getByRole("menuitem").filter({ hasText: "cmux" });
  await expect(cmux).toBeEnabled();
  await expectContentClearsBorder(dialog);
  await capture(dashboard, "01-dialog");

  await cmux.click();
  await expect(dialog.getByRole("status")).toContainText(`Started in cmux, in ${original}`);
  await expect(menu).toBeHidden();
  await capture(dashboard, "02-started");

  // What the terminal was told to run: the fake Claude resuming THIS conversation, in the
  // recorded mode, in the original directory - and nothing that makes it a managed session.
  await expect.poll(() => workspaces(daemon).length, { timeout: 15_000 }).toBe(1);
  const [workspace] = workspaces(daemon);
  expect(flag(workspace!, "--cwd")).toBe(original);
  const launch = launchedCommand(flag(workspace!, "--command")!);
  expect(launch).toContain(join(daemon.home, "fake-bin", "fake-claude"));
  expect(launch).toContain(`'--resume' '${id}'`);
  expect(launch).toContain("'--permission-mode' 'acceptEdits'");
  expect(launch).not.toContain("--mcp-config");

  // Closed and reopened, the dialog reads the pending launch and refuses a second Resume.
  await dialog.locator(".modal-foot").getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
  await view.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    `This conversation is already being resumed in ${original}, and its agent may still appear there.`,
  );
  await expect(menu).toHaveCount(0);
  await capture(dashboard, "03-pending");

  await dialog.getByRole("button", { name: "Cancel pending resume" }).click();
  await expect(dialog.getByRole("status")).toHaveText("The pending resume was cancelled.");
  await expect(menu.getByRole("menuitem").filter({ hasText: "cmux" })).toBeEnabled();
  await capture(dashboard, "04-cancelled");

  // Cancelled means closed: the next Resume launches again.
  await menu.getByRole("menuitem").filter({ hasText: "cmux" }).click();
  await expect(dialog.getByRole("status")).toContainText("Started in cmux");
  await expect.poll(() => workspaces(daemon).length, { timeout: 15_000 }).toBe(2);
});

test("Resume in the Agent SDK starts an embedded session in the original directory that turns the conversation Live", async ({
  dashboard,
  daemon,
}) => {
  const original = join(daemon.home, "projects", "resume-sdk");
  mkdirSync(original, { recursive: true });
  const id = writeSession(daemon, { cwd: original, title: "Finish the changelog", at: "2026-10-31T15:00:00.000Z" });
  await indexed(daemon, id);

  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${id}`);
  const view = detail(dashboard);
  await view.getByRole("button", { name: "Resume", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Resume this conversation" });
  const sdk = dialog.getByRole("menu", { name: "Resume in" }).getByRole("menuitem").filter({ hasText: "Agent SDK" });
  await expect(sdk).toBeEnabled();
  await expect(sdk).toContainText("Runs inside Mission Control, as a card in the Fleet.");
  await expectContentClearsBorder(dialog);
  await capture(dashboard, "20-sdk-dialog");

  await sdk.click();
  await expect(dialog.getByRole("status")).toHaveText(
    `Started in the Agent SDK, in ${original}. Its card is in the Fleet, waiting for your next message.`,
  );
  await capture(dashboard, "21-sdk-started");

  // The embedded session continues THIS conversation, in the original directory, and no
  // terminal was asked for.
  await expect.poll(async () => {
    const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{ runtime: string; agentSessionId: string | null; cwd: string }>;
    return sessions.filter((session) => session.runtime === "sdk").map((session) => [session.agentSessionId, session.cwd]);
  }, { timeout: 15_000 }).toEqual([[id, original]]);
  expect(workspaces(daemon)).toHaveLength(0);

  // Live status is read when the row is served, so the detail says so once it is read again.
  await dialog.locator(".modal-foot").getByRole("button", { name: "Close", exact: true }).click();
  await dashboard.reload();
  await expect(view.getByRole("button", { name: "Open in Fleet" })).toBeVisible({ timeout: 15_000 });
  await expect(view.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
});

test("the Agent SDK is not offered for a typed directory, which resumes a fork", async ({ dashboard, daemon }) => {
  const id = writeSession(daemon, { cwd: join(daemon.home, "projects", "sdk-deleted"), title: "Rename the flag", at: "2026-10-27T12:00:00.000Z" });
  await indexed(daemon, id);
  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${id}`);
  await detail(dashboard).getByRole("button", { name: "Resume", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Resume this conversation" });
  const typed = join(daemon.home, "projects", "sdk-typed");
  mkdirSync(typed, { recursive: true });
  await dialog.getByRole("textbox", { name: "Resume in another directory" }).fill(typed);
  const sdk = dialog.getByRole("menu", { name: "Resume in" }).getByRole("menuitem").filter({ hasText: "Agent SDK" });
  await expect(sdk).toBeDisabled();
  await expect(sdk).toContainText("Agent SDK cannot fork a conversation into another directory: choose a terminal.");
  await expect(dialog.getByRole("menu", { name: "Resume in" }).getByRole("menuitem").filter({ hasText: "cmux" })).toBeEnabled();
});

test("Resume is offered only on conversations whose transcript is present, and a directory that is gone opens the picker", async ({
  dashboard,
  daemon,
}) => {
  const oneShot = writeSession(daemon, { cwd: join(daemon.home, "projects", "batch"), title: "Summarize the diff", at: "2026-10-29T12:00:00.000Z", oneShot: true });
  const missing = writeSession(daemon, { cwd: join(daemon.home, "projects", "deleted-checkout"), title: "Port the importer", at: "2026-10-28T12:00:00.000Z" });
  await indexed(daemon, oneShot);
  await indexed(daemon, missing);

  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${oneShot}`);
  await expect(detail(dashboard).getByRole("heading", { name: "Summarize the diff", level: 2 })).toBeVisible();
  await expect(detail(dashboard).getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);

  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${missing}`);
  await expect(detail(dashboard).getByRole("heading", { name: "Port the importer", level: 2 })).toBeVisible();
  await detail(dashboard).getByRole("button", { name: "Resume", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Resume this conversation" });
  await expect(dialog.getByText("No longer exists", { exact: true })).toBeVisible();
  await expect(dialog.getByText(
    `The original directory ${join(daemon.home, "projects", "deleted-checkout")} no longer exists.`,
    { exact: true },
  )).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  // The original cannot be used, so the picker offers a typed directory, and the terminals
  // wait for one.
  await expect(dialog.getByRole("textbox", { name: "Resume in another directory" })).toBeVisible();
  await expect(dialog.getByRole("menu", { name: "Resume in" })).toHaveCount(0);
  await capture(dashboard, "05-missing");
  expect(workspaces(daemon)).toHaveLength(0);
});

test("a typed directory resumes a fork from a copy of the transcript, in the directory resolved through symlinks", async ({
  dashboard,
  daemon,
}) => {
  const id = writeSession(daemon, { cwd: join(daemon.home, "projects", "removed-checkout"), title: "Split the parser", at: "2026-10-27T12:00:00.000Z" });
  await indexed(daemon, id);
  const real = join(daemon.home, "projects", "fork-target");
  mkdirSync(real, { recursive: true });
  const alias = join(daemon.home, "projects", "fork-alias");
  symlinkSync(real, alias);
  const resolved = realpathSync(real);
  const copyPath = join(daemon.home, ".claude", "projects", resolved.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);

  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${id}`);
  await detail(dashboard).getByRole("button", { name: "Resume", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Resume this conversation" });
  // This session has no repository, so the picker is the directory field alone.
  const field = dialog.getByRole("textbox", { name: "Resume in another directory" });
  await expect(field).toBeVisible();
  await expect(dialog.getByRole("textbox")).toHaveCount(1);
  await expect(dialog.getByText("in a directory you choose, because the original cannot be used", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("listbox")).toHaveCount(0);
  await expectContentClearsBorder(dialog);

  // A relative path is refused, and the field stays up to correct it.
  await field.fill("projects/fork-target");
  const menu = dialog.getByRole("menu", { name: "Resume in" });
  await menu.getByRole("menuitem").filter({ hasText: "cmux" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("projects/fork-target is a relative path: type the directory's absolute path.");
  await expect(field).toBeVisible();
  await capture(dashboard, "07-relative");
  expect(workspaces(daemon)).toHaveLength(0);

  await field.fill(alias);
  await capture(dashboard, "08-typed");
  await menu.getByRole("menuitem").filter({ hasText: "cmux" }).click();
  await expect(dialog.getByRole("status")).toHaveText(
    `Started a fork in cmux, in ${resolved}, from the transcript copied to ${copyPath}. The fork appears in History as its own session once Mission Control finds the agent.`,
  );
  await capture(dashboard, "09-fork-started");

  // The copy is in the resolved directory's project folder, byte for byte the original.
  expect(existsSync(copyPath)).toBe(true);
  const original = join(daemon.home, ".claude", "projects", join(daemon.home, "projects", "removed-checkout").replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
  expect(readFileSync(copyPath, "utf8")).toBe(readFileSync(original, "utf8"));

  // The terminal runs in the resolved directory, resuming THIS conversation as a fork under
  // the id Mission Control minted for it.
  await expect.poll(() => workspaces(daemon).length, { timeout: 15_000 }).toBe(1);
  const [workspace] = workspaces(daemon);
  expect(flag(workspace!, "--cwd")).toBe(resolved);
  const launch = launchedCommand(flag(workspace!, "--command")!);
  const options = (await (await fetch(`${daemon.baseURL}/api/history/sessions/claude/${id}/resume-options`)).json()) as {
    openLaunch: { expectedAgentSessionId: string; copyPath: string; cwd: string };
  };
  const fork = options.openLaunch.expectedAgentSessionId;
  expect(fork).not.toBe(id);
  expect(options.openLaunch.copyPath).toBe(copyPath);
  expect(launch).toContain(`'--resume' '${id}'`);
  expect(launch).toContain(`'--fork-session' '--session-id' '${fork}'`);
  expect(launch).not.toContain("--mcp-config");
});

test("a Cancel pending resume the daemon refuses says why, and the dialog offers Resume again once nothing holds it", async ({
  dashboard,
  daemon,
}) => {
  const original = join(daemon.home, "projects", "resume-cancelled-elsewhere");
  mkdirSync(original, { recursive: true });
  const id = writeSession(daemon, { cwd: original, title: "Rename the importer flags", at: "2026-10-30T15:00:00.000Z" });
  await indexed(daemon, id);

  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${id}`);
  await detail(dashboard).getByRole("button", { name: "Resume", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Resume this conversation" });
  const menu = dialog.getByRole("menu", { name: "Resume in" });
  await menu.getByRole("menuitem").filter({ hasText: "cmux" }).click();
  await expect(dialog.getByRole("status")).toContainText("Started in cmux");

  // Another tab cancels the same launch first, so this dialog's Cancel finds it already closed.
  const options = (await (await fetch(`${daemon.baseURL}/api/history/sessions/claude/${id}/resume-options`)).json()) as {
    openLaunch: { launchId: string };
  };
  const elsewhere = await fetch(`${daemon.baseURL}/api/history/sessions/claude/${id}/resume/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ launchId: options.openLaunch.launchId }),
  });
  expect(elsewhere.status).toBe(200);

  await dialog.getByRole("button", { name: "Cancel pending resume" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("This launch is no longer pending.");
  await expect(dialog.getByText(/^Started in cmux/)).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Cancel pending resume" })).toHaveCount(0);
  // Nothing holds the session now, so the dialog offers Resume again without being reopened.
  const cmux = menu.getByRole("menuitem").filter({ hasText: "cmux" });
  await expect(cmux).toBeEnabled();
  await capture(dashboard, "06-cancel-refused");
  await cmux.click();
  await expect(dialog.getByRole("status")).toContainText("Started in cmux");
});

test("an original slot another owner holds opens the picker; the chosen slot is leased, named on its card, and Return releases the launch", async ({
  dashboard,
  daemon,
}) => {
  // Two slots of the fixture repository: the first stays held by a manual lease, which is the
  // session's original directory; the second is returned, idle and clean.
  const acquire = async (label: string) => {
    const response = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
      data: { repositoryPath: daemon.repo, label },
    });
    expect(response.status()).toBe(201);
    return await response.json() as { path: string; leaseId: string };
  };
  const held = await acquire("someone else's work");
  const spare = await acquire("spare slot");
  expect((await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, { data: { leaseId: spare.leaseId } })).ok()).toBe(true);

  // Recorded on `main`, which the fixture's main checkout holds: the slot gets its tip detached.
  const id = writeSession(daemon, { cwd: held.path, title: "Finish the importer", at: "2026-10-31T09:00:00.000Z", branch: "main" });
  await indexed(daemon, id);

  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${id}`);
  const view = detail(dashboard);
  await view.getByRole("button", { name: "Resume", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Resume this conversation" });
  await expect(dialog.getByText("A worktree slot that is in use or not idle", { exact: true })).toBeVisible();
  const picker = dialog.getByRole("group", { name: "Choose an idle slot of this repository" });
  // One idle slot of this repository (not the held original), and the typed directory beside it.
  await expect(picker.getByRole("radio", { name: /^Slot / })).toHaveCount(1);
  await expect(picker.getByRole("radio", { name: "Another directory" })).not.toBeChecked();
  await expect(picker.getByRole("radio", { name: /^Slot 2\b/ })).toBeChecked();
  await expect(dialog.getByRole("textbox", { name: "Resume in another directory" })).toHaveCount(0);
  await expect(picker.getByText(spare.path, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expectContentClearsBorder(dialog);
  await capture(dashboard, "07-picker");

  // Choosing the typed directory instead shows its field, and the terminals wait for a path.
  await picker.getByRole("radio", { name: "Another directory" }).check();
  await expect(dialog.getByRole("textbox", { name: "Resume in another directory" })).toBeVisible();
  await expect(dialog.getByRole("menu", { name: "Resume in" })).toHaveCount(0);
  await picker.getByRole("radio", { name: /^Slot 2\b/ }).check();
  await expect(dialog.getByRole("textbox", { name: "Resume in another directory" })).toHaveCount(0);

  await dialog.getByRole("menu", { name: "Resume in" }).getByRole("menuitem").filter({ hasText: "cmux" }).click();
  await expect(dialog.getByRole("status")).toContainText(`Started in cmux, in ${spare.path}`);
  await expect(dialog.getByRole("status")).toContainText("The slot stays leased to this Resume until you Return it from its card");
  await expect(dialog.getByRole("alert")).toHaveText(
    `The branch main is checked out in ${daemon.repo}, so this slot has its tip detached: commits made here will not move the branch.`,
  );
  await expect(picker).toBeHidden();
  await capture(dashboard, "08-started-in-slot");
  await expect.poll(() => workspaces(daemon).length, { timeout: 15_000 }).toBe(1);
  expect(flag(workspaces(daemon)[0]!, "--cwd")).toBe(spare.path);
  expect(launchedCommand(flag(workspaces(daemon)[0]!, "--command")!)).toContain(`'--resume' '${id}'`);

  // Cancel pending resume does not close a slot launch: the open launch names the way out.
  await dialog.locator(".modal-foot").getByRole("button", { name: "Close", exact: true }).click();
  await view.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Return the slot from its card to close it.");
  await expect(dialog.getByRole("button", { name: "Cancel pending resume" })).toHaveCount(0);
  await dialog.locator(".modal-foot").getByRole("button", { name: "Close", exact: true }).click();

  // The slot card names the History resume owner, and its Return releases the launch.
  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const pool = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = pool.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const slot = pool.getByRole("article", { name: "Slot 2" });
  await expect(slot.getByText("leased", { exact: true })).toBeVisible();
  await expect(slot.getByText("Resumed History session")).toBeVisible();
  await slot.scrollIntoViewIfNeeded();
  await capture(dashboard, "09-slot-card");
  await slot.getByRole("button", { name: "Return", exact: true }).click();
  const preview = dashboard.getByRole("dialog", { name: "return worktree preview" });
  await preview.getByRole("button", { name: "Execute" }).click();
  await expect(slot.getByText("available", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(slot.getByText("Resumed History session")).toHaveCount(0);

  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${id}`);
  await detail(dashboard).getByRole("button", { name: "Resume", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(picker.getByRole("radio", { name: /^Slot / })).toHaveCount(1);
  await expect(dialog.getByRole("menu", { name: "Resume in" }).getByRole("menuitem").filter({ hasText: "cmux" })).toBeEnabled();
  await capture(dashboard, "10-resume-again");
  await dialog.locator(".modal-foot").getByRole("button", { name: "Close", exact: true }).click();

  // A conversation recorded on a branch this clone has nowhere: the slot stays detached, warned.
  const lost = writeSession(daemon, { cwd: held.path, title: "Revive the parser", at: "2026-10-31T10:00:00.000Z", branch: "feature/never-pushed" });
  await indexed(daemon, lost);
  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${lost}`);
  await detail(dashboard).getByRole("button", { name: "Resume", exact: true }).click();
  await expect(picker.getByRole("radio", { name: /^Slot 2\b/ })).toBeChecked();
  await dialog.getByRole("menu", { name: "Resume in" }).getByRole("menuitem").filter({ hasText: "cmux" }).click();
  await expect(dialog.getByRole("status")).toContainText(`Started in cmux, in ${spare.path}`);
  await expect(dialog.getByRole("alert")).toHaveText(
    "The branch feature/never-pushed was not found here or on origin, so the slot stays detached where it was: the code may not match the conversation.",
  );
  await capture(dashboard, "11-missing-branch");
});

test("an Agent SDK Resume into another slot shows its conversation before any prompt, and again after a daemon restart", async ({
  dashboard,
  daemon,
}) => {
  // The original slot stays held, so the Resume runs in a second slot of the same repository.
  // Claude continues such a conversation IN PLACE: its file stays in the original slot's project
  // folder, and nothing is written under the slot it now runs in.
  const acquire = async (label: string) => {
    const response = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
      data: { repositoryPath: daemon.repo, label },
    });
    expect(response.status()).toBe(201);
    return await response.json() as { path: string; leaseId: string };
  };
  const held = await acquire("the conversation's first slot");
  const spare = await acquire("spare slot");
  expect((await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, { data: { leaseId: spare.leaseId } })).ok()).toBe(true);
  const id = writeSession(daemon, { cwd: held.path, title: "Break down the merge", at: "2026-10-31T09:30:00.000Z" });
  await indexed(daemon, id);

  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${id}`);
  await detail(dashboard).getByRole("button", { name: "Resume", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Resume this conversation" });
  await expect(dialog.getByRole("group", { name: "Choose an idle slot of this repository" }).getByRole("radio", { name: /^Slot 2\b/ })).toBeChecked();
  await dialog.getByRole("menu", { name: "Resume in" }).getByRole("menuitem").filter({ hasText: "Agent SDK" }).click();
  await expect(dialog.getByRole("status")).toContainText(`Started in the Agent SDK, in ${spare.path}`);

  const embedded = async () => {
    const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{ id: string; name: string; runtime: string; cwd: string }>;
    return sessions.find((session) => session.runtime === "sdk" && session.cwd === spare.path) ?? null;
  };
  await expect.poll(embedded, { timeout: 15_000 }).not.toBeNull();
  const { id: sessionId } = (await embedded())!;

  // The resumed conversation is on the card before anyone types into it.
  const conversation = async (label: string) => {
    // The card's name, read each time: a restored card takes its name afresh.
    const { name } = (await embedded())!;
    // A hash-only `goto` keeps the page, so reload: the conversation must come from THIS daemon.
    await dashboard.goto(`${daemon.baseURL}/#/session/${encodeURIComponent(sessionId)}`);
    await dashboard.reload();
    await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: name }).first().click();
    await expect(dashboard.getByText("Start Break down the merge")).toBeVisible({ timeout: 15_000 });
    await expect(dashboard.getByText("On it.", { exact: true })).toBeVisible();
    await expect(dashboard.getByText(/No transcript for this session yet/)).toHaveCount(0);
    await capture(dashboard, label);
  };
  await conversation("13-sdk-slot-conversation");

  // A restart restores the embedded session with no hook-reported path. It still finds the file.
  await daemon.shutdown();
  await daemon.restart();
  await expect.poll(async () => (await embedded())?.id, { timeout: 30_000 }).toBe(sessionId);
  await conversation("14-sdk-slot-conversation-after-restart");
});

test("a resumed session that ends with uncommitted changes keeps its slot and says why; a clean one returns it; one never seen is held", async ({
  dashboard,
  daemon,
}) => {
  // Three idle slots of the fixture repository, each the original directory of one conversation.
  // All three are held before any is returned, or the pool would hand out the same one again.
  const leases: { path: string; leaseId: string }[] = [];
  for (const label of ["dirty", "clean", "unseen"]) {
    const response = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
      data: { repositoryPath: daemon.repo, label },
    });
    expect(response.status()).toBe(201);
    leases.push(await response.json() as { path: string; leaseId: string });
  }
  for (const lease of leases) {
    expect((await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, { data: { leaseId: lease.leaseId } })).ok()).toBe(true);
  }
  const [dirtyPath, cleanPath, unseenPath] = leases.map((lease) => lease.path) as [string, string, string];
  const dirty = writeSession(daemon, { cwd: dirtyPath, title: "Leave the parser half done", at: "2026-10-31T11:00:00.000Z" });
  const clean = writeSession(daemon, { cwd: cleanPath, title: "Read the parser through", at: "2026-10-31T12:00:00.000Z" });
  const unseen = writeSession(daemon, { cwd: unseenPath, title: "Never came back", at: "2026-10-31T13:00:00.000Z" });
  for (const id of [dirty, clean, unseen]) await indexed(daemon, id);

  // Each Resume leases its own original slot, through the dialog.
  const dialog = dashboard.getByRole("dialog", { name: "Resume this conversation" });
  for (const [id, path] of [[dirty, dirtyPath], [clean, cleanPath], [unseen, unseenPath]] as const) {
    await dashboard.goto(`${daemon.baseURL}/#/history/claude/${id}`);
    await detail(dashboard).getByRole("button", { name: "Resume", exact: true }).click();
    await dialog.getByRole("menu", { name: "Resume in" }).getByRole("menuitem").filter({ hasText: "cmux" }).click();
    await expect(dialog.getByRole("status")).toContainText(`Started in cmux, in ${path}`);
    await dialog.locator(".modal-foot").getByRole("button", { name: "Close", exact: true }).click();
  }
  await expect.poll(() => workspaces(daemon).length, { timeout: 15_000 }).toBe(3);

  // The fake cmux runs nothing, so no agent can appear in a slot here. Two of the resumed
  // agents are recorded as discovered (bound) while the daemon is down, the first having left
  // an uncommitted file behind, and the restart's startup twin finds both sessions ended. The
  // third never appeared.
  writeFileSync(join(dirtyPath, "half-done.txt"), "work in progress\n");
  await daemon.crash();
  withDaemonDb(daemon, (db) => {
    const bind = db.prepare(
      "UPDATE history_resume_launches SET state = 'bound', mc_session_id = ? WHERE source_session_id = ? AND state = 'pending'",
    );
    for (const id of [dirty, clean]) expect(Number(bind.run(`term:${id}`, id).changes)).toBe(1);
  });
  await daemon.restart();

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const pool = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = pool.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const card = (path: string) => pool.getByRole("article").filter({ hasText: path });

  await expect(card(dirtyPath).getByText("Kept: uncommitted changes from a resumed session")).toBeVisible({ timeout: 30_000 });
  await expect(card(dirtyPath).getByText("leased", { exact: true })).toBeVisible();
  await expect(card(dirtyPath).getByRole("button", { name: "Return", exact: true })).toBeVisible();

  await expect(card(cleanPath).getByText("available", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(card(cleanPath).getByText(/Resumed History session|Kept:/)).toHaveCount(0);

  await expect(card(unseenPath).getByText("Held for a resumed session that has not appeared")).toBeVisible();
  await expect(card(unseenPath).getByText("leased", { exact: true })).toBeVisible();
  await expect(card(unseenPath).getByRole("button", { name: "Return", exact: true })).toBeVisible();
  await card(dirtyPath).scrollIntoViewIfNeeded();
  await capture(dashboard, "12-ended-slots");
  expect(existsSync(join(dirtyPath, "half-done.txt"))).toBe(true);

  // The session whose agent never appeared cannot be resumed again while its slot is held.
  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${unseen}`);
  await detail(dashboard).getByRole("button", { name: "Resume", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(`This conversation is already being resumed in ${unseenPath}`);
  await expect(dialog.getByRole("alert")).toContainText("Return the slot from its card to close it.");
  await dialog.locator(".modal-foot").getByRole("button", { name: "Close", exact: true }).click();

  // The clean one can: its slot is back in the pool, and its launch is closed.
  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${clean}`);
  await detail(dashboard).getByRole("button", { name: "Resume", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("menu", { name: "Resume in" }).getByRole("menuitem").filter({ hasText: "cmux" })).toBeEnabled();
});
