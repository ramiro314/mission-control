import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { launchedCommand } from "../fixtures/isolated-launch.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { recordsIn } from "../fixtures/records.ts";

/**
 * History Resume in the original directory: the Resume button a conversation offers, the
 * dialog that reads `resume-options`, the terminal it opens, and the pending launch that blocks
 * a second Resume until Cancel pending resume closes it.
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
  shape: { cwd: string; title: string; at: string; oneShot?: boolean; mode?: string },
): string {
  const id = sessionId();
  const base = { sessionId: id, cwd: shape.cwd, entrypoint: shape.oneShot ? "sdk-cli" : "cli", version: "2.1.296", gitBranch: "main", isSidechain: false };
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
