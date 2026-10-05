import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { writeGhPullRequests, type FakePullRequest } from "../fixtures/fake-agents.ts";

/**
 * A pull request that conflicts with its base, as the PR chip shows it.
 *
 * What is real here: the dispatched task-backed session, the `prCreated` hook that adopts its
 * pull request, the daemon's PR poller asking `gh` for `mergeable` and `baseRefName`, the
 * session snapshot riding `session_upsert`, and the chip deciding through
 * `currentMergeability`. Stood in for: GitHub's answer, through the fake `gh` on `PATH`.
 *
 * The mark is asserted on the Board card and in the Console's session header, then the fake
 * flips to `MERGEABLE` and both marks have to go while the chip itself stays - so the absence
 * is the conflict clearing, not the chip disappearing.
 *
 * No model tokens: every agent binary is a fake (see `fake-agents.ts`).
 */

// The branch poller ships at 20s, which would spend the spec's budget waiting twice.
test.use({ daemonEnv: { MISSION_PR_POLL_MS: "400" } });

const EVIDENCE = artifactsDir("pr-merge-conflicts");
const PR_URL = "https://github.com/acme/mission-e2e/pull/31";
const CONFLICT = "Conflicts with main";

interface SessionRow {
  id: string;
  agent: string;
  cwd: string;
  state: string;
  agentSessionId: string | null;
}

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/pr-merge-conflicts/${name}.png`);
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<SessionRow> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("open a pull request that conflicts");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let live: SessionRow | undefined;
  await expect
    .poll(async () => {
      live = (await api<SessionRow[]>(daemon, "/api/sessions")).find((s) => s.state !== "exited");
      return live?.cwd ? live.state : "";
    }, { timeout: 60_000, message: "the dispatched session should settle with a checkout" })
    .toBe("idle");
  return live!;
}

/** The daemon's own adoption signal: the hook a harness fires when `gh pr create` returns. */
async function announcePullRequest(daemon: DaemonHandle, session: SessionRow): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const response = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: session.agent,
      sessionId: session.agentSessionId ?? session.id,
      cwd: session.cwd,
      prCreated: true,
      prUrl: PR_URL,
    }),
  });
  if (!response.ok) throw new Error(`hook answered ${response.status}: ${await response.text()}`);
}

async function useLayout(page: Page, daemon: DaemonHandle, layout: "board" | "console"): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout }),
  });
  expect(response.ok, `the daemon accepted the ${layout} layout`).toBe(true);
  // A reload: the web store hydrates the layout preference at boot.
  await page.reload();
}

test("a conflicting pull request is marked on the card and in the session header until it is mergeable", async ({
  dashboard,
  daemon,
}) => {
  const session = await dispatch(dashboard, daemon);
  // Model the agent cutting its feature branch after native detached acquisition: the branch
  // poller only asks `gh` about a session on a feature branch.
  execFileSync("git", ["-C", session.cwd, "switch", "-q", "-c", "e2e/pr-conflict"]);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: session.cwd, encoding: "utf8" }).trim();
  const pr: FakePullRequest = {
    cwd: session.cwd,
    url: PR_URL,
    number: 31,
    state: "OPEN",
    createdAt: new Date().toISOString(),
    mergedAt: null,
    headRefOid: head,
    mergeable: "CONFLICTING",
    baseRefName: "main",
  };
  writeGhPullRequests(daemon.home, [pr]);
  await announcePullRequest(daemon, session);
  // The precondition: the poller adopted the pull request and read GitHub's answer for it.
  await expect
    .poll(async () => {
      const row = (await api<Array<SessionRow & { prUrl: string | null; prBaseRef: string | null }>>(
        daemon,
        "/api/sessions",
      )).find((s) => s.id === session.id);
      return `${row?.prUrl} ${row?.prBaseRef}`;
    }, { timeout: 30_000, message: `the PR poller should adopt the pull request:\n${daemon.readLog()}` })
    .toBe(`${PR_URL} main`);

  // The Board card.
  await useLayout(dashboard, daemon, "board");
  const card = dashboard.locator("main.board .tile");
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("link", { name: /#31/ })).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("img", { name: CONFLICT })).toBeVisible({ timeout: 30_000 });
  await shoot(dashboard, "01-card-conflicts-with-main", card);

  // The session header.
  await useLayout(dashboard, daemon, "console");
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = dashboard.locator(".console-detail");
  await expect(detail.getByRole("link", { name: /#31/ })).toBeVisible({ timeout: 30_000 });
  const headerMark = detail.getByRole("link", { name: CONFLICT });
  await expect(headerMark).toBeVisible({ timeout: 30_000 });
  await shoot(dashboard, "02-header-conflicts-with-main", detail);

  // GitHub now reports the pull request mergeable: the mark clears, the chip stays.
  writeGhPullRequests(daemon.home, [{ ...pr, mergeable: "MERGEABLE" }]);
  await expect(headerMark).toHaveCount(0, { timeout: 30_000 });
  await expect(detail.getByRole("link", { name: /#31/ })).toBeVisible();
  await shoot(dashboard, "03-header-mergeable", detail);

  await useLayout(dashboard, daemon, "board");
  await expect(card.getByRole("link", { name: /#31/ })).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("img", { name: CONFLICT })).toHaveCount(0);
  await shoot(dashboard, "04-card-mergeable", card);
});

interface TaskRow {
  id: string;
  worktreePath: string | null;
  extraRepos: Array<{ repoRoot: string; worktreePath: string | null }>;
}

test("a conflict in a multi-repo task's attached repo names that PR and links to it", async ({
  dashboard,
  daemon,
}) => {
  const primaryUrl = "https://github.com/acme/demo-repo/pull/10";
  const secondUrl = "https://github.com/acme/second-repo/pull/20";

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Add another repo" }).click();
  await dialog.getByPlaceholder("repo to attach…").fill(daemon.secondRepo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Attach repo" }).click();
  await dialog.getByPlaceholder("What should this agent do?").fill("rename a field across two repos");
  await dialog.getByLabel("Kind").selectOption("ship");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let session: SessionRow | undefined;
  await expect
    .poll(async () => {
      session = (await api<SessionRow[]>(daemon, "/api/sessions")).find((s) => s.state !== "exited");
      return session?.state ?? "";
    }, { timeout: 60_000, message: "the dispatched session should settle" })
    .toBe("idle");
  let task: TaskRow | undefined;
  await expect
    .poll(async () => {
      task = (await api<TaskRow[]>(daemon, "/api/tasks")).find((t) => t.extraRepos.length === 1);
      return Boolean(task?.worktreePath && task.extraRepos.every((e) => e.worktreePath));
    }, { message: "one worktree per attached repo, recorded on the task" })
    .toBe(true);
  const primaryTree = task!.worktreePath!;
  const secondTree = task!.extraRepos[0]!.worktreePath!;
  for (const tree of [primaryTree, secondTree]) {
    execFileSync("git", ["-C", tree, "switch", "-q", "-c", "e2e/pr-conflict-multi"]);
  }

  // Only the ATTACHED repo's pull request conflicts; the session's own one is mergeable.
  const createdAt = new Date().toISOString();
  const row = (cwd: string, url: string, number: number, mergeable: "MERGEABLE" | "CONFLICTING", base: string): FakePullRequest => ({
    cwd, url, number, state: "OPEN", createdAt, mergedAt: null, headRefOid: "0".repeat(40), mergeable, baseRefName: base,
  });
  writeGhPullRequests(daemon.home, [
    row(primaryTree, primaryUrl, 10, "MERGEABLE", "main"),
    row(secondTree, secondUrl, 20, "CONFLICTING", "develop"),
  ]);
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  for (const [event, body] of [
    ["PostToolUse", { toolName: "Bash", prCreated: true, prUrl: primaryUrl, prUrls: [primaryUrl, secondUrl] }],
    ["Stop", {}],
  ] as const) {
    const response = await fetch(`${daemon.baseURL}/hooks/${event}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": token },
      body: JSON.stringify({
        agent: session!.agent,
        sessionId: session!.agentSessionId ?? session!.id,
        cwd: session!.cwd,
        ...body,
      }),
    });
    expect(response.ok, `${event} hook`).toBe(true);
  }

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = dashboard.locator(".console-detail");
  const alert = detail.getByRole("link", { name: "Conflicts with develop (second-repo #20)" });
  await expect(alert).toBeVisible({ timeout: 30_000 });
  // It leads to the PR that needs the merge, not the session's own mergeable one.
  await expect(alert).toHaveAttribute("href", secondUrl);
  await shoot(dashboard, "05-header-attached-repo-conflict", detail);
});

/** Open the attention inbox from the topbar segment that counts it. */
async function openInbox(page: Page): Promise<Locator> {
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  const toAnswer = page.locator("button.pulse-seg", { hasText: "to answer" });
  // Retried whole, as `attention-pills-agree.spec.ts` explains: an SSE frame replaces the
  // segment rather than moving it, so one resolved click can land on a detached node.
  await expect(async () => {
    if (!(await inbox.isVisible())) await toAnswer.click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  return inbox;
}

async function openForemanSettings(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: /Foreman - the auto-responder/ }).click();
  const popover = page.getByRole("dialog", { name: "Foreman settings" });
  await expect(popover).toBeVisible();
  return popover;
}

const NOTIFICATIONS = "__e2eNotifications";

interface RecordedNotification {
  title: string;
  body: string;
  tag: string;
}

/**
 * Replace `window.Notification` with a recorder that reports permission granted.
 *
 * The log lives in `sessionStorage` so it outlasts the spec's reload: a recorder rebuilt
 * empty by every navigation could not tell "the reloaded page stayed quiet" from "it alerted
 * again". `alerts.notifications` ships off, so it is switched on here too.
 */
async function recordNotifications(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.addInitScript((key) => {
    class FakeNotification {
      onclick: (() => void) | null = null;
      static permission = "granted";
      static requestPermission = async (): Promise<string> => "granted";
      constructor(title: string, options?: { body?: string; tag?: string }) {
        const log = JSON.parse(sessionStorage.getItem(key) ?? "[]") as RecordedNotification[];
        log.push({ title, body: options?.body ?? "", tag: options?.tag ?? "" });
        sessionStorage.setItem(key, JSON.stringify(log));
      }
      close(): void {}
    }
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
  }, NOTIFICATIONS);
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alerts: { notifications: true, sound: false } }),
  });
  expect(response.ok, "the daemon accepted the alert settings").toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
}

async function prConflictNotifications(page: Page): Promise<RecordedNotification[]> {
  const log = await page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key) ?? "[]") as RecordedNotification[],
    NOTIFICATIONS,
  );
  return log.filter((n) => n.tag.startsWith("pr-conflict:"));
}

test("a conflict nothing is handling gets a Blocked pull requests row until it is mergeable", async ({
  dashboard,
  daemon,
}) => {
  await recordNotifications(dashboard, daemon);
  const session = await dispatch(dashboard, daemon);
  execFileSync("git", ["-C", session.cwd, "switch", "-q", "-c", "e2e/pr-conflict-blocked"]);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: session.cwd, encoding: "utf8" }).trim();
  const pr: FakePullRequest = {
    cwd: session.cwd,
    url: PR_URL,
    number: 31,
    state: "OPEN",
    createdAt: new Date().toISOString(),
    mergedAt: null,
    headRefOid: head,
    mergeable: "CONFLICTING",
    baseRefName: "main",
  };
  writeGhPullRequests(daemon.home, [pr]);
  await announcePullRequest(daemon, session);

  // Foreman is off by default, so it cannot drive this session: nobody handles the conflict.
  const inbox = await openInbox(dashboard);
  await expect(inbox.getByRole("heading", { name: "Blocked pull requests" })).toBeVisible({ timeout: 30_000 });
  const row = inbox.getByRole("region", { name: "Blocked pull request acme/mission-e2e #31" });
  await expect(row).toContainText("Foreman can't drive this session");
  await expect(row).toContainText("into main");
  await expect(row).toContainText(/Conflicting for \d+m/);
  await expect(row.getByRole("link", { name: "Open PR" })).toHaveAttribute("href", PR_URL);
  await expect(row.getByRole("button", { name: "Open session" })).toBeVisible();
  // Entry: exactly one desktop alert, naming the PR.
  const alerted: RecordedNotification = {
    title: "acme/mission-e2e #31 has merge conflicts",
    body: "Conflicts with main: Foreman can't drive this session",
    tag: `pr-conflict:${PR_URL}`,
  };
  await expect.poll(() => prConflictNotifications(dashboard)).toEqual([alerted]);
  await shoot(dashboard, "06-inbox-foreman-cannot-drive", inbox);
  await dashboard.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // The setting: beside the other follow-through toggles, on by default, and it persists.
  const popover = await openForemanSettings(dashboard);
  const conflicts = popover.getByRole("checkbox", { name: "Keep sessions on track with merge conflicts" });
  await expect(popover.getByRole("checkbox", { name: "Keep sessions on track with CI" })).toBeChecked();
  await expect(conflicts).toBeChecked();
  const pullRequests = popover.getByRole("group", { name: "Pull requests" });
  await pullRequests.scrollIntoViewIfNeeded();
  await shoot(dashboard, "07-foreman-merge-conflicts-toggle", pullRequests);
  await conflicts.uncheck();
  await expect
    .poll(async () => (await api<{ trackMergeConflicts: boolean }>(daemon, "/api/foreman/config")).trackMergeConflicts)
    .toBe(false);
  await dashboard.reload();
  const reopened = await openForemanSettings(dashboard);
  await expect(
    reopened.getByRole("checkbox", { name: "Keep sessions on track with merge conflicts" }),
  ).not.toBeChecked();
  await dashboard.keyboard.press("Escape");

  // Still blocked, for the same reason, after the reload.
  const again = await openInbox(dashboard);
  const sameRow = again.getByRole("region", { name: "Blocked pull request acme/mission-e2e #31" });
  await expect(sameRow).toContainText("Foreman can't drive this session");
  // The reload baselined the already-blocked PR silently.
  expect(await prConflictNotifications(dashboard)).toEqual([alerted]);

  // The session ends. The same row now says so, fed by the by-URL poller through the task.
  const killed = await fetch(`${daemon.baseURL}/api/sessions/${session.id}/kill`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(killed.ok, "the session was killed").toBe(true);
  await expect(sameRow).toContainText("session ended", { timeout: 30_000 });
  await expect(sameRow).toContainText(/open a pull request that conflicts/i);
  // A reason change only updates the row: still the one alert from entry.
  expect(await prConflictNotifications(dashboard)).toEqual([alerted]);
  await shoot(dashboard, "08-inbox-session-ended", again);

  // GitHub now reports the pull request mergeable: the row clears itself.
  writeGhPullRequests(daemon.home, [{ ...pr, mergeable: "MERGEABLE" }]);
  await expect(sameRow).toHaveCount(0, { timeout: 60_000 });
  await expect(again.getByRole("heading", { name: "Blocked pull requests" })).toHaveCount(0);
  await shoot(dashboard, "09-inbox-cleared", again);
});
