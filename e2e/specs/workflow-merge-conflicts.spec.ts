import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { writeGhPullRequests, type FakePullRequest } from "../fixtures/fake-agents.ts";

/**
 * A workflow-owned session whose pull request conflicts with its base.
 *
 * Real: the dispatched session and its worktree, the published workflow and its binding, the
 * Live Pull Request packet, the daemon's adoption path (a `prCreated` hook), the PR poller
 * asking `gh` for `mergeable`, `baseRefName` and `headRefOid`, the Wait for CI attempt deciding
 * on the session's head-bound observation, the repair packet it sends, the conflict episodes'
 * classification of a run that cannot reach Wait for CI, and the dashboard reading all of it
 * over SSE. Stood in for: GitHub's answer, through the fake `gh` on `PATH`.
 *
 * No model tokens: every agent binary is a fake (see `fake-agents.ts`).
 */

// The branch poller ships at 20s, which would spend the spec's budget waiting twice.
test.use({ daemonEnv: { MISSION_PR_POLL_MS: "400" } });

const EVIDENCE = artifactsDir("workflow-merge-conflicts");
const PROMPT = "# Pull Request\n\nOpen the pull request for the reviewed work.\n";
const PR_URL = "https://github.com/acme/mission-e2e/pull/31";

interface SessionRow {
  id: string;
  agent: string;
  cwd: string;
  state: string;
  agentSessionId: string | null;
}

type RunDetail = {
  run: { status: string };
  summary: { actionWait?: string | null };
  attempts: Array<{ nodeId: string; state: string; output: { expectedHeadOid?: string | null } | null }>;
  deliveries: Array<{ kind: string; payload: string }>;
};

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-merge-conflicts/${name}.png`);
}

async function hook(daemon: DaemonHandle, session: SessionRow, extra: Record<string, unknown>): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const response = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: session.agent,
      sessionId: session.agentSessionId ?? session.id,
      cwd: session.cwd,
      ...extra,
    }),
  });
  if (!response.ok) throw new Error(`hook answered ${response.status}: ${await response.text()}`);
}

/** Dispatch a session onto a feature branch, which is what the branch poller asks `gh` about. */
async function dispatch(page: Page, daemon: DaemonHandle, branch: string): Promise<SessionRow> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("open a pull request that conflicts");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let session: SessionRow | undefined;
  await expect.poll(async () => {
    session = (await api<SessionRow[]>(daemon, "/api/sessions")).find((item) => item.state !== "exited");
    return session?.cwd ? session.state : "";
  }, { timeout: 60_000, message: "the dispatched session should settle with a checkout" }).toBe("idle");
  execFileSync("git", ["-C", session!.cwd, "switch", "-q", "-c", branch]);
  await hook(daemon, session!, {});
  await expect.poll(async () =>
    (await api<Array<{ id: string; gitBranch: string | null }>>(daemon, "/api/sessions"))
      .find((item) => item.id === session!.id)?.gitBranch ?? null,
  ).toBe(branch);
  return session!;
}

/** Publish Session -> Pull Request [-> Wait for CI] -> End, bind it, and run it to the action. */
async function runToPullRequestAction(
  daemon: DaemonHandle,
  session: SessionRow,
  name: string,
  waitForCi: boolean,
): Promise<string> {
  await api(daemon, "/api/workflows/config", { liveEnabled: true, repoAllowlist: [daemon.repo] }, "PUT");
  const action = await api<{ id: string }>(daemon, "/api/session-actions", {
    name: `Open the pull request ${name}`,
    description: "Open the pull request for the reviewed work",
    promptMarkdown: PROMPT,
    requiredSkillId: null,
    completion: { kind: "pull_request" },
  });
  const end = { id: "end-node", kind: "end", outcome: "Approved", position: { x: 720, y: 0 } };
  const draft = waitForCi
    ? {
        nodes: [
          { id: "session-node", kind: "session", position: { x: 0, y: 0 } },
          { id: "action-node", kind: "session_action", sessionActionId: action.id, position: { x: 240, y: 0 } },
          { id: "ci-node", kind: "wait_for_ci", timeoutMinutes: 45, position: { x: 480, y: 0 } },
          end,
        ],
        edges: [
          { id: "e-submit", source: "session-node", sourcePort: "submitted", target: "action-node", targetPort: "activate" },
          { id: "e-complete", source: "action-node", sourcePort: "complete", target: "ci-node", targetPort: "activate" },
          { id: "e-pass", source: "ci-node", sourcePort: "pass", target: "end-node", targetPort: "terminal" },
          { id: "e-fail", source: "ci-node", sourcePort: "fail", target: "session-node", targetPort: "return_for_changes" },
        ],
      }
    : {
        nodes: [
          { id: "session-node", kind: "session", position: { x: 0, y: 0 } },
          { id: "action-node", kind: "session_action", sessionActionId: action.id, position: { x: 240, y: 0 } },
          end,
        ],
        edges: [
          { id: "e-submit", source: "session-node", sourcePort: "submitted", target: "action-node", targetPort: "activate" },
          { id: "e-complete", source: "action-node", sourcePort: "complete", target: "end-node", targetPort: "terminal" },
        ],
      };
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: `E2E merge conflicts ${name}`,
    resumptionPolicy: "manual",
    draft,
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId: session.id,
    deliveryMode: "live",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: `e2e-merge-conflicts-${name}` },
  );
  const runId = submitted.run.id;
  await expect.poll(async () =>
    (await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).summary.actionWait ?? null, {
    message: "the Pull Request action never settled into a wait for its pull request",
    timeout: 180_000,
  }).toBe("awaiting_pull_request");
  return runId;
}

function conflictingPr(session: SessionRow): FakePullRequest {
  return {
    cwd: session.cwd,
    url: PR_URL,
    number: 31,
    state: "OPEN",
    createdAt: new Date().toISOString(),
    mergedAt: null,
    headRefOid: execFileSync("git", ["rev-parse", "HEAD"], { cwd: session.cwd, encoding: "utf8" }).trim(),
    mergeable: "CONFLICTING",
    baseRefName: "main",
  };
}

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

test("a conflicting pull request fails Wait for CI into one merge-in repair round", async ({ dashboard, daemon }) => {
  test.setTimeout(360_000);
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const session = await dispatch(dashboard, daemon, "e2e/conflict-wait-for-ci");
  const runId = await runToPullRequestAction(daemon, session, "wait-for-ci", true);

  // The agent opened the pull request, and GitHub reports it conflicting on the head it pushed.
  // No CI check ever appears: GitHub runs no `pull_request` workflow on a conflicting PR.
  const pr = conflictingPr(session);
  writeGhPullRequests(daemon.home, [pr]);
  await hook(daemon, session, { prCreated: true, prUrl: PR_URL });

  await expect.poll(async () =>
    (await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).run.status, {
    message: `the conflict did not return the run to the session:\n${daemon.readLog()}`,
    timeout: 120_000,
  }).toBe("waiting_for_session");
  const detail = await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`);
  const ci = detail.attempts.find((attempt) => attempt.nodeId === "ci-node")!;
  expect(ci.output?.expectedHeadOid).toBe(pr.headRefOid);
  const repair = detail.deliveries.find((delivery) => delivery.kind === "persona_feedback");
  expect(repair?.payload).toContain("Resolve merge conflicts with `main`");
  expect(repair?.payload).toContain("git merge origin/main");
  expect(repair?.payload).toContain("Do not rebase or force-push.");

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const ciRow = dashboard.locator('[aria-label="Workflow run pipeline"]')
    .locator("li.wf-pipeline-reviewer", { hasText: "Wait for CI" });
  await expect(ciRow).toContainText("CI failed");
  await ciRow.click();
  const card = dashboard.locator("article.wf-run-verdict", { hasText: "Wait for CI" });
  await expect(card).toContainText("Resolve merge conflicts with `main`");
  await shoot(dashboard, "01-run-conflict-repair", card);
});

test("a workflow with no Wait for CI puts its conflict in Blocked pull requests", async ({ dashboard, daemon }) => {
  test.setTimeout(360_000);
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const session = await dispatch(dashboard, daemon, "e2e/conflict-not-gating");
  // The run sits on its Pull Request action, which leads only to End: no Wait for CI is
  // reachable, so nothing in the workflow will react, and Foreman stays out of its session.
  const runId = await runToPullRequestAction(daemon, session, "not-gating", false);
  writeGhPullRequests(daemon.home, [conflictingPr(session)]);

  const inbox = await openInbox(dashboard);
  const row = inbox.getByRole("region", { name: "Blocked pull request acme/mission-e2e #31" });
  await expect(row).toContainText("the workflow isn't waiting on CI for this PR", { timeout: 60_000 });
  await expect(row).toContainText("into main");
  await expect(row.getByRole("link", { name: "Open PR" })).toHaveAttribute("href", PR_URL);
  expect((await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).run.status).toBe("waiting_for_action");
  await shoot(dashboard, "02-inbox-workflow-not-gating", inbox);
});
