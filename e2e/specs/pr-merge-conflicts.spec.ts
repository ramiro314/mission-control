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
