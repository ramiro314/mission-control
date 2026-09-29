import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

/**
 * Wait for CI, authored in the editor and read in the run views.
 *
 * Real: the Pipeline editor, Publish, the dispatched session and its worktree, the Live Pull
 * Request packet the fake agent takes a turn on, the daemon's own adoption path (a `prCreated`
 * hook), the continuation, the Wait for CI attempt the engine parks, the manager's sweep that
 * decides it, the repair packet a failure sends, and the dashboard reading all of it over SSE.
 *
 * Stood in for: GitHub. The node reads CI only through the Inspector's stored snapshot, which
 * is a `gh` call this suite never makes, so the spec writes that snapshot
 * (`inspector_prs.observed_ci_json`) the way `withDaemonDb` documents for an observed head.
 * No model tokens are spent and GitHub is never reached.
 */

const EVIDENCE = artifactsDir("workflow-wait-for-ci");
const PROMPT = "# Pull Request\n\nOpen the pull request for the reviewed work.\n";
const PR_URL = "https://github.com/owner/repo/pull/77";
const PR_KEY = "owner/repo#77";

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

test("the Pipeline editor adds Wait for CI after a Pull Request action, with its timeout", async ({
  dashboard,
  daemon,
}) => {
  const created = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E wait for CI authoring",
  });
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E wait for CI authoring/ }).click();

  const pipeline = dashboard.locator(".wf-pipeline-strip");
  // Before any Pull Request action there is nowhere Wait for CI is valid, so it is not offered.
  await expect(pipeline.getByLabel("Add the first stage").locator("option", { hasText: "Wait for CI" }))
    .toHaveCount(0);
  await pipeline.getByLabel("Add the first stage").selectOption({ label: "Pull Request" });
  await pipeline.getByLabel("Insert a stage after Stage 1").click();
  await pipeline.getByLabel("Insert a stage after Stage 1").selectOption({ label: "Wait for CI" });

  const row = pipeline.locator("li.wf-pipeline-reviewer", { hasText: "Wait for CI" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Waits for the pull request's CI · blocks after 45 min");
  const timeout = pipeline.getByLabel("Timeout (minutes)");
  await expect(timeout).toHaveValue("45");
  await timeout.fill("60");
  await expect(row).toContainText("blocks after 60 min");
  // A Wait for CI stage holds nothing else, so it has no "add a reviewer" control.
  await expect(pipeline.getByLabel("Add a reviewer or Command to Stage 2")).toHaveCount(0);

  const publish = dashboard.getByRole("button", { name: "Publish" });
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect
    .poll(async () => (await api<unknown[]>(daemon, `/api/workflows/${created.workflow.id}/versions`)).length)
    .toBe(1);
  const version = await api<{
    graph: {
      nodes: Array<{ id: string; kind: string; timeoutMinutes?: number }>;
      edges: Array<{ source: string; sourcePort: string; target: string }>;
    };
  }>(daemon, `/api/workflows/${created.workflow.id}/versions/1`);
  const ci = version.graph.nodes.find((node) => node.kind === "wait_for_ci");
  expect(ci?.timeoutMinutes).toBe(60);
  const action = version.graph.nodes.find((node) => node.kind === "session_action")!;
  expect(version.graph.edges).toContainEqual(expect.objectContaining({
    source: action.id,
    sourcePort: "complete",
    target: ci!.id,
  }));
  await shoot(dashboard, "01-editor-wait-for-ci");
});

test("the Graph palette adds a Wait for CI node with pass and fail ports", async ({ dashboard, daemon }) => {
  await api(daemon, "/api/workflows", { name: "E2E wait for CI graph" });
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E wait for CI graph/ }).click();
  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();
  await dashboard.locator("section.workflow-palette").getByRole("button", { name: "＋ Wait for CI" }).click();
  const node = dashboard.locator('[data-node-kind="wait_for_ci"]');
  await expect(node).toHaveCount(1);
  await expect(node).toContainText("Wait for CI");
  await expect(node.getByLabel("Pass output")).toHaveCount(1);
  await expect(node.getByLabel("Fail output")).toHaveCount(1);
  await node.click();
  const rail = dashboard.getByRole("complementary", { name: "Workflow properties and validation" });
  await expect(rail.getByLabel("Timeout (minutes)")).toHaveValue("45");
  // Unconnected, it says where it belongs.
  await expect(rail).toContainText("Wait for CI must follow a Pull Request session action's complete route");
});

// ---- a run -------------------------------------------------------------------------------

async function dispatch(page: Page, daemon: DaemonHandle, branch: string): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for the CI spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let session: { id: string; state: string; cwd: string; agent: string; agentSessionId: string | null } | undefined;
  await expect.poll(async () => {
    const sessions = await api<Array<NonNullable<typeof session>>>(daemon, "/api/sessions");
    session = sessions.find((item) => item.state !== "exited");
    return session?.state ?? "";
  }, { message: "the dispatched session should settle to idle" }).toBe("idle");
  execFileSync("git", ["-C", session!.cwd, "switch", "-q", "-c", branch]);
  await hook(daemon, session!, {});
  await expect.poll(async () =>
    (await api<Array<{ id: string; gitBranch: string | null }>>(daemon, "/api/sessions"))
      .find((item) => item.id === session!.id)?.gitBranch ?? null,
  ).toBe(branch);
  return session!.id;
}

async function hook(
  daemon: DaemonHandle,
  session: { id: string; agent: string; cwd: string; agentSessionId: string | null },
  extra: Record<string, unknown>,
): Promise<void> {
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

interface CiWait {
  runId: string;
  head: string;
}

type RunDetail = {
  run: { status: string; currentPhase: string };
  summary: { actionWait?: string | null };
  attempts: Array<{ nodeId: string; state: string; output: { expectedHeadOid?: string | null } | null }>;
  deliveries: Array<{ kind: string; payload: string }>;
};

/** Dispatch, publish Session -> Pull Request -> Wait for CI -> End, and run it to the wait. */
async function runToCiWait(page: Page, daemon: DaemonHandle, name: string): Promise<CiWait> {
  await api(daemon, "/api/workflows/config", { liveEnabled: true, repoAllowlist: [daemon.repo] }, "PUT");
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const sessionId = await dispatch(page, daemon, `e2e/${name}`);
  const action = await api<{ id: string }>(daemon, "/api/session-actions", {
    name: `Open the pull request ${name}`,
    description: "Open the pull request for the reviewed work",
    promptMarkdown: PROMPT,
    requiredSkillId: null,
    completion: { kind: "pull_request" },
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: `E2E wait for CI ${name}`,
    resumptionPolicy: "manual",
    draft: {
      nodes: [
        { id: "session-node", kind: "session", position: { x: 0, y: 0 } },
        { id: "action-node", kind: "session_action", sessionActionId: action.id, position: { x: 240, y: 0 } },
        { id: "ci-node", kind: "wait_for_ci", timeoutMinutes: 45, position: { x: 480, y: 0 } },
        { id: "end-node", kind: "end", outcome: "Approved", position: { x: 720, y: 0 } },
      ],
      edges: [
        { id: "e-submit", source: "session-node", sourcePort: "submitted", target: "action-node", targetPort: "activate" },
        { id: "e-complete", source: "action-node", sourcePort: "complete", target: "ci-node", targetPort: "activate" },
        { id: "e-pass", source: "ci-node", sourcePort: "pass", target: "end-node", targetPort: "terminal" },
        { id: "e-fail", source: "ci-node", sourcePort: "fail", target: "session-node", targetPort: "return_for_changes" },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId,
    deliveryMode: "live",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: `e2e-wait-for-ci-${name}` },
  );
  const runId = submitted.run.id;
  await expect.poll(async () =>
    (await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).summary.actionWait ?? null, {
    message: "the Pull Request action never settled into a wait for its pull request",
    timeout: 180_000,
  }).toBe("awaiting_pull_request");

  // The turn opened the pull request, through the daemon's own adoption path.
  const session = (await api<Array<{ id: string; agent: string; cwd: string; agentSessionId: string | null }>>(
    daemon, "/api/sessions")).find((item) => item.id === sessionId)!;
  await hook(daemon, session, { prCreated: true, prUrl: PR_URL });

  // The Inspector has not polled, so the node watches the head the continuation captured.
  let head = "";
  await expect.poll(async () => {
    const detail = await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`);
    const ci = detail.attempts.find((attempt) => attempt.nodeId === "ci-node" && attempt.state === "waiting");
    head = ci?.output?.expectedHeadOid ?? "";
    return head.length;
  }, { message: "Wait for CI never started waiting on a head", timeout: 120_000 }).toBe(40);
  expect(head).toBe(execFileSync("git", ["-C", session.cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  return { runId, head };
}

/** What the Inspector's poll would store for the pull request: CI on one head. */
function seedCi(daemon: DaemonHandle, head: string, checkRuns: unknown[], flakeReport: unknown = null): void {
  withDaemonDb(daemon, (db) => {
    const changed = db.prepare("UPDATE inspector_prs SET observed_ci_json = ? WHERE key = ?")
      .run(JSON.stringify({ headSha: head, observedAt: Date.now(), checkRuns, flakeReport }), PR_KEY);
    if (Number(changed.changes) !== 1) throw new Error("the adopted pull request row is missing");
  });
}

const check = (name: string, state: "pending" | "passing" | "failing", extra: Record<string, unknown> = {}) => ({
  name,
  state,
  conclusion: state === "pending" ? null : state === "failing" ? "FAILURE" : "SUCCESS",
  detailsUrl: `https://ci.example/${encodeURIComponent(name)}`,
  title: null,
  summary: null,
  ...extra,
});

test("a run waits for CI, then returns a failing check to the session by name", async ({ dashboard, daemon }) => {
  test.setTimeout(360_000);
  const { runId, head } = await runToCiWait(dashboard, daemon, "ci-fail");

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const strip = dashboard.getByRole("region", { name: "Workflow run pipeline" }).or(
    dashboard.locator('[aria-label="Workflow run pipeline"]'),
  );
  const ciRow = strip.locator("li.wf-pipeline-reviewer", { hasText: "Wait for CI" });
  await expect(ciRow).toContainText("Waiting for CI");
  await shoot(dashboard, "02-run-waiting-for-ci");

  seedCi(daemon, head, [
    check("unit (node 24)", "failing", { title: "2 tests failed", summary: "test/a.test.ts failed twice" }),
    check("lint", "passing"),
    check("Flaky tests", "passing", { conclusion: "SUCCESS", title: "No flaky tests" }),
  ]);
  await expect.poll(async () =>
    (await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).run.status, {
    message: "failing CI did not return the run to the session",
    timeout: 60_000,
  }).toBe("waiting_for_session");
  const detail = await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`);
  const repair = detail.deliveries.find((delivery) => delivery.kind === "persona_feedback");
  expect(repair?.payload).toContain('Fix the failing CI check "unit (node 24)"');
  expect(repair?.payload).not.toContain('CI check "Flaky tests"');

  await expect(ciRow).toContainText("CI failed");
  await ciRow.click();
  const card = dashboard.locator("article.wf-run-verdict", { hasText: "Wait for CI" });
  await expect(card).toContainText("CI failed on PR #77");
  await expect(card).toContainText('Fix the failing CI check "unit (node 24)"');
  // The full check list folds away once CI has decided; the failing checks are listed above it.
  await expect(card.getByRole("list", { name: "CI checks" })).toBeHidden();
  await card.getByText("Checks on the head commit (3)").click();
  await expect(card.getByRole("list", { name: "CI checks" })).toContainText("lint");
  await shoot(dashboard, "03-run-ci-failed");
  if (process.env.MC_E2E_EVIDENCE) await card.screenshot({ path: `${EVIDENCE}03-ci-failed-card.png` });
});

test("a run passes green CI with a flake, and lists the flake with its history", async ({ dashboard, daemon }) => {
  test.setTimeout(360_000);
  const { runId, head } = await runToCiWait(dashboard, daemon, "ci-pass");
  seedCi(daemon, head, [
    check("unit (node 24)", "passing"),
    check("Flaky tests", "passing", { conclusion: "NEUTRAL", title: "1 flaky test" }),
  ], {
    version: 1,
    commit: head,
    ref: "e2e/ci-pass",
    pullRequest: 77,
    runUrl: "https://github.com/owner/repo/actions/runs/1",
    flakes: [{ key: "00000000000000aa", runner: "junit", file: "test/timing.test.ts", name: "timing > settles", message: "timed out once" }],
    failures: [],
    errors: [],
    issues: [{ key: "00000000000000aa", number: 12, url: "https://github.com/owner/repo/issues/12", occurrences: 2, actionable: false }],
  });
  await expect.poll(async () =>
    (await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).run.status, {
    message: "green CI with a flake did not complete the run",
    timeout: 60_000,
  }).toBe("completed");

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const ciRow = dashboard.locator('[aria-label="Workflow run pipeline"]')
    .locator("li.wf-pipeline-reviewer", { hasText: "Wait for CI" });
  await expect(ciRow).toContainText("CI passed");
  await ciRow.click();
  const card = dashboard.locator("article.wf-run-verdict", { hasText: "Wait for CI" });
  await expect(card).toContainText("CI passed on PR #77");
  await expect(card).toContainText("1 flaky test failed, then passed on rerun");
  const flakes = card.getByRole("list", { name: "Flaky tests" });
  await expect(flakes).toContainText("timing > settles");
  await expect(flakes.getByRole("link", { name: "#12" })).toHaveAttribute("href", "https://github.com/owner/repo/issues/12");
  await shoot(dashboard, "04-run-ci-passed-with-flake");
  if (process.env.MC_E2E_EVIDENCE) await card.screenshot({ path: `${EVIDENCE}04-ci-passed-card.png` });
});

/** Both widths, for `workflow-session-action-evidence.spec.ts`' reason. */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  for (const [suffix, width] of [["wide", 1440], ["narrow", 720]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${EVIDENCE}${name}-${suffix}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("a run blocked by Wait for CI says why in plain words, and offers to wait again", async ({ dashboard, daemon }) => {
  test.setTimeout(360_000);
  const { runId, head } = await runToCiWait(dashboard, daemon, "ci-block");

  // Every check green, no "Flaky tests" check. The node starts its grace period on the first
  // sighting; backdating that start by six minutes lets the daemon's own sweep reach the block
  // through the real decision, instead of this spec waiting five minutes of wall clock.
  seedCi(daemon, head, [check("unit (node 24)", "passing"), check("lint", "passing")]);
  await expect.poll(() => withDaemonDb(daemon, (db) => {
    const row = db.prepare(
      "SELECT output_json FROM workflow_node_attempts WHERE node_id = 'ci-node' AND state = 'waiting'",
    ).get() as { output_json: string } | undefined;
    return row ? (JSON.parse(row.output_json) as { greenWithoutReportSince: number | null }).greenWithoutReportSince : null;
  }), { message: "the node never saw green CI without a report" }).not.toBeNull();
  withDaemonDb(daemon, (db) => {
    const row = db.prepare(
      "SELECT id, output_json FROM workflow_node_attempts WHERE node_id = 'ci-node' AND state = 'waiting'",
    ).get() as { id: string; output_json: string };
    const state = JSON.parse(row.output_json) as { greenWithoutReportSince: number };
    state.greenWithoutReportSince -= 6 * 60_000;
    db.prepare("UPDATE workflow_node_attempts SET output_json = ? WHERE id = ?").run(JSON.stringify(state), row.id);
  });
  await expect.poll(async () => (await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).run.currentPhase, {
    message: "the missing report never blocked the run",
    timeout: 60_000,
  }).toBe("ci_flake_report_missing");

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const ciRow = dashboard.locator('[aria-label="Workflow run pipeline"]')
    .locator("li.wf-pipeline-reviewer", { hasText: "Wait for CI" });
  await expect(ciRow).toContainText("Blocked");
  await ciRow.click();
  const card = dashboard.locator("article.wf-run-attempt", { hasText: "Wait for CI" });
  const reason = card.locator(".wf-run-ci-headline");
  await expect(reason).toHaveText(
    'Every CI check passed, but no "Flaky tests" check appeared on the head commit. Rerun CI '
    + "and wait for CI again, or add the flake report to this repository's CI (see Flaky tests "
    + "in CI) and start a new round.",
  );
  await expect(reason).not.toContainText("Waiting for CI on");
  await expect(card.getByRole("link", { name: PR_KEY })).toHaveAttribute("href", PR_URL);
  // The triage clause names the cause, and the run offers the retry as its move.
  await expect(dashboard.getByText("no Flaky tests check").first()).toBeVisible();
  const again = dashboard.getByRole("button", { name: "Wait for CI again" });
  await expect(again).toBeVisible();
  await shoot(dashboard, "05-run-ci-blocked");
  if (process.env.MC_E2E_EVIDENCE) await card.screenshot({ path: `${EVIDENCE}05-ci-blocked-card.png` });

  // Waiting again reopens the same head with a fresh timeout.
  await again.click();
  await expect.poll(async () => (await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).run.status, {
    message: "Wait for CI again did not reopen the run",
  }).toBe("running");
  await expect(ciRow).toContainText("Waiting for CI");
});
