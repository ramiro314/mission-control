import { mkdirSync, writeFileSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import type { Task } from "../../src/shared/types.ts";

/**
 * A task source names the Workflow its swept tasks bind, in place of the kind's Dispatch
 * default - the flake source binding a lightweight review while Ship keeps its own.
 *
 * `test/task-source-ingest.test.ts` pins that each of the three stored states reaches the
 * filed task, and `test/task-sources-panel.test.ts` pins the options the picker draws. Only
 * this layer connects choosing one in the editor to the config the daemon stores, and that
 * stored config to the task a real sweep files.
 *
 * Nothing reaches GitHub: every `gh` call goes to the fake, which answers `issue list` from
 * `daemon.ghIssuesPath`. No agent is dispatched; the seeded Workflow is only published.
 */

const EVIDENCE = artifactsDir("task-source-workflow");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/task-source-workflow/${name}.png`);
}

async function post<T>(page: Page, daemon: DaemonHandle, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(`${daemon.baseURL}${path}`, { data });
  expect(response.ok(), `${path} answered ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}

/** A published one-reviewer Workflow, the shape a custom Deflake Review has. */
async function publishWorkflow(page: Page, daemon: DaemonHandle, name: string): Promise<string> {
  const persona = await post<{ id: string }>(page, daemon, "/api/personas", {
    name: `${name} reviewer`,
    guidanceMarkdown: `# ${name} reviewer`,
  });
  const created = await post<{ workflow: { id: string } }>(page, daemon, "/api/workflows", {
    name,
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "judge", kind: "persona", personaId: persona.id, position: { x: 220, y: 0 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        { id: "a", source: "session", sourcePort: "submitted", target: "judge", targetPort: "activate" },
        { id: "b", source: "judge", sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "c", source: "judge", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      ],
    },
  });
  await post(page, daemon, `/api/workflows/${created.workflow.id}/publish`, { expectedDraftRevision: 1 });
  return created.workflow.id;
}

async function storedWorkflowId(page: Page, daemon: DaemonHandle): Promise<string | null | undefined> {
  const res = await page.request.get(`${daemon.baseURL}/api/task-sources/config`);
  const body = (await res.json()) as { sources: { defaults: { workflowId?: string | null } }[] };
  return body.sources[0]?.defaults.workflowId;
}

test("a workflow picked for a task source is saved and binds the task a sweep files", async ({
  page,
  daemon,
}) => {
  const workflowId = await publishWorkflow(page, daemon, "Deflake Review");
  writeFileSync(
    daemon.ghIssuesPath,
    JSON.stringify([
      {
        number: 12,
        title: "Flaky test: sweeps a source",
        body: "Flaky.",
        url: "https://github.com/acme/demo/issues/12",
        labels: [{ name: "flaky-test" }],
        discoverable: true,
      },
    ]),
  );
  const configured = await page.request.put(`${daemon.baseURL}/api/task-sources/config`, {
    data: {
      sources: [
        { id: "flakes", kind: "github-issues", label: "Flake issues", repoRoot: daemon.repo, config: { repo: "acme/demo" } },
      ],
    },
  });
  expect(configured.ok()).toBe(true);

  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
  const picker = page.getByRole("combobox", { name: "Workflow for tasks this source files" });
  // Unset inherits, and says what it inherits.
  await expect(picker.locator("option:checked")).toHaveText(/^Kind default \(No-Mistakes Review/);
  await expect(picker.getByRole("option", { name: "None", exact: true })).toHaveCount(1);

  await picker.selectOption({ label: "Deflake Review · v1" });
  await expect
    .poll(() => storedWorkflowId(page, daemon), { message: "the daemon should have stored the choice" })
    .toBe(workflowId);

  // A fresh page reads it back from the daemon, not from component state.
  await page.reload();
  await expect(picker).toHaveValue(workflowId);
  await picker.scrollIntoViewIfNeeded();
  await shoot(page, "workflow-picked");

  const swept = page.waitForResponse((r) => r.url().endsWith("/flakes/sweep") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sweep now", exact: true }).click();
  expect((await swept).ok()).toBe(true);
  await expect(page.getByText(/Swept: filed 1/)).toBeVisible();
  const tasks = (await (await page.request.get(`${daemon.baseURL}/api/tasks`)).json()) as Task[];
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.workflowId).toBe(workflowId);

  // The source now holds it, so archiving it is refused by name.
  const archived = await page.request.delete(`${daemon.baseURL}/api/workflows/${workflowId}`, {
    data: { expectedDraftRevision: 1 },
  });
  expect(archived.status()).toBe(409);
  expect(((await archived.json()) as { error: string }).error).toContain("Used by the task source Flake issues");
});
