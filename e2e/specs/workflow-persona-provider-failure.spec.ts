import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { skipSpecOnWin32 } from "../../test/helpers/win32-skip.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

/**
 * A Codex Persona whose account has hit its usage limit says so on the failed node.
 *
 * The fake `codex exec` replays the provider's exact refusal for a prompt carrying
 * `E2E_CODEX_QUOTA_EXHAUSTED`. The run must stop after ONE call, record `quota_exhausted`,
 * and show the operator the reason and the reset time rather than a generic infrastructure
 * failure. No model tokens: the binary is the fake installed by the daemon fixture.
 */

const EVIDENCE = artifactsDir("workflow-persona-provider-failure");
const REVIEWER = "Codex quota reviewer";
const REASON = "Codex usage limit reached; resets Oct 22nd, 2026 9:01 PM";

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for the quota spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { message: "the dispatched session should settle before evidence capture", timeout: 40_000 }).toBe("idle");
  return sessionId;
}

test("a Codex Persona out of quota shows the provider's reason on its failed node", async ({ dashboard, daemon }) => {
  skipSpecOnWin32(test, "Codex is unavailable on win32");
  test.setTimeout(120_000);
  const sessionId = await dispatch(dashboard, daemon);
  const reviewer = await api<{ id: string }>(daemon, "/api/personas", {
    name: REVIEWER,
    guidanceMarkdown: "# Codex quota reviewer\n\nE2E_CODEX_QUOTA_EXHAUSTED",
    runner: "codex",
    model: null,
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E Codex quota",
    draft: {
      nodes: [
        { id: "session-node", kind: "session", position: { x: 0, y: 0 } },
        { id: "reviewer", kind: "persona", personaId: reviewer.id, position: { x: 220, y: 0 } },
        { id: "end-node", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        { id: "e-submit", source: "session-node", sourcePort: "submitted", target: "reviewer", targetPort: "activate" },
        { id: "e-pass", source: "reviewer", sourcePort: "pass", target: "end-node", targetPort: "terminal" },
        { id: "e-fail", source: "reviewer", sourcePort: "fail", target: "session-node", targetPort: "return_for_changes" },
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
    deliveryMode: "preview",
  });
  const { run } = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-codex-quota-submit" },
  );
  await expect.poll(async () => (
    await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${run.id}`)
  ).run.status, { message: "the run should block on the permanent provider failure", timeout: 60_000 }).toBe("blocked");

  // One call, typed, rather than two identical generic ones.
  const calls = withDaemonDb(daemon, (db) => db.prepare(
    "SELECT error_code FROM workflow_llm_calls WHERE run_id = ? AND purpose = 'persona_review'",
  ).all(run.id).map((row) => (row as { error_code: string | null }).error_code));
  expect(calls).toEqual(["quota_exhausted"]);
  const log = join(daemon.recordDir, "codex", "workflow-quota-exhausted.log");
  expect(existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0).toBe(1);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${run.id}`);
  const worklist = dashboard.getByRole("region", { name: "Review worklist" });
  const row = worklist.locator("button.wf-run-worklist-row").filter({ hasText: REVIEWER });
  await expect(row).toContainText(REASON);
  await row.click();
  const card = worklist.locator("article.wf-run-attempt").filter({ hasText: REVIEWER });
  await expect(card.locator(".wf-run-error")).toContainText(`${REVIEWER} Persona could not run: ${REASON}.`);

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await worklist.screenshot({ path: `${EVIDENCE}quota-reason.png` });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/workflow-persona-provider-failure/quota-reason.png");
  }
});
