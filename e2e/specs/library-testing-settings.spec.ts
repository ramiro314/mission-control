import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * Stored testing settings, end to end: a repository that commits NO `.mission/testing.json`
 * gets an affected-tests gate configured entirely in Library › Commands.
 *
 * The operator edits the repository root's row in the affected-tests page's "Testing settings"
 * section, a second window's save makes the first window's next save stale (409, and the row
 * reloads), the operator's own `.mission/testing.local.json` overrides one key, and the run
 * detail card says where every effective key came from.
 *
 * The "test runner" is `sh` writing a passing JUnit result. No model tokens: the dispatch holds
 * a fake agent and the graph has no Persona.
 */

const EVIDENCE = artifactsDir("library-testing-settings");

const RUNNER = [
  "junit=\"$1\"; shift",
  "echo \"selected: $*\"",
  "printf '<testsuites><testcase name=\"smoke\" classname=\"test\" file=\"%s\"/></testsuites>' \"$1\" > \"$junit\"",
  "exit 0",
].join("\n");

interface TestingSettingsView {
  repoRoot: string;
  settings: { tests?: { patterns?: string[]; includeImporters?: boolean; smokeSet?: string[] } };
  revision: number;
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/** Commit one smoke test and nothing else: no `.mission/testing.json` anywhere. */
function commitSmokeTest(repo: string): void {
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "test/smoke.test.ts"), "export {};\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("add", "-A");
  git("-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-qm", "smoke test");
  git("push", "-q", "origin", "main");
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for the testing settings spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect
    .poll(async () => {
      const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
      const live = sessions.find((session) => session.state !== "exited");
      sessionId = live?.id ?? "";
      return live?.state ?? "";
    })
    .toBe("idle");
  return sessionId;
}

async function submitRun(daemon: DaemonHandle, sessionId: string): Promise<string> {
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E stored testing settings",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "affected", kind: "check", slot: "affected-tests", position: { x: 220, y: 0 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        { id: "submit", source: "session", sourcePort: "submitted", target: "affected", targetPort: "activate" },
        { id: "pass", source: "affected", sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "fail", source: "affected", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
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
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-stored-testing-settings" },
  );
  const runId = submitted.run.id;
  try {
    await expect
      .poll(async () => {
        const run = await api<{ attempts: Array<{ nodeId: string; output: unknown }> }>(
          daemon,
          `/api/workflow-runs/${runId}`,
        );
        const output = run.attempts.find((attempt) => attempt.nodeId === "affected")?.output as
          { status?: string } | null | undefined;
        return output?.status ?? "";
      }, { message: "the affected-tests check should run from stored settings and pass", timeout: 60_000 })
      .toBe("passed");
  } catch (caught) {
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }
  return runId;
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/library-testing-settings/${name}.png`);
}

test("a repository's root testing settings are edited in Library and run the gate with no committed file", async ({
  dashboard,
  daemon,
}) => {
  commitSmokeTest(daemon.repo);
  const sessionId = await dispatch(dashboard, daemon);
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true,
    checksEnabled: true,
    repoAllowlist: [daemon.repo],
    kindWorkflowDefaults: { ship: null },
    checkCommands: [{
      repoRoot: daemon.repo,
      slot: "affected-tests",
      command: ["sh", "-c", RUNNER, "sh", "{junit}", "{files}"],
    }],
  }, "PUT");

  // The affected-tests page lists the root its override names, with nothing stored yet.
  await dashboard.goto(`${daemon.baseURL}/#/library/commands/affected-tests`);
  const section = dashboard.getByRole("region", { name: "Testing settings" });
  await expect(section).toBeVisible();
  await expect(section).toContainText("committed, then stored, then local");
  const row = section.getByRole("group", { name: new RegExp(`^Testing settings for .*${basename(daemon.repo)}$`) });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Nothing stored yet");
  const save = row.getByRole("button", { name: "Save testing settings" });
  await expect(save).toBeDisabled();

  await row.getByLabel("Test patterns").fill("test/**/*.test.ts");
  await row.getByLabel("Smoke set").fill("test/smoke.test.ts");
  await save.click();
  await expect(row).toContainText("Stored revision 1");
  const [stored] = await api<TestingSettingsView[]>(daemon, "/api/testing-settings");
  expect(stored!.settings).toEqual({ tests: { patterns: ["test/**/*.test.ts"], smokeSet: ["test/smoke.test.ts"] } });
  const root = stored!.repoRoot;

  // Another window saves first. This window still holds revision 1, so its next save is refused
  // and the row reloads what is stored instead of writing over it.
  await api(daemon, "/api/testing-settings", {
    repoRoot: root,
    expectedRevision: 1,
    settings: { tests: { patterns: ["test/**/*.test.ts"], includeImporters: false, smokeSet: ["test/smoke.test.ts"] } },
  }, "PUT");
  await row.getByLabel("Smoke set").fill("test/other.test.ts");
  await save.click();
  await expect(row.getByRole("alert")).toContainText("Another window saved these testing settings first");
  await expect(row).toContainText("Stored revision 2");
  await expect(row.getByLabel("Include importers")).toHaveValue("off");
  await expect(row.getByLabel("Smoke set")).toHaveValue("test/smoke.test.ts");
  await shoot(dashboard, "testing-settings-row-reloaded");

  // The operator's own checkout has the last word on one key.
  mkdirSync(join(daemon.repo, ".mission"), { recursive: true });
  writeFileSync(join(daemon.repo, ".mission/testing.local.json"), JSON.stringify({ tests: { includeImporters: true } }));

  const runId = await submitRun(daemon, sessionId);
  const run = await api<{ attempts: Array<{ nodeId: string; output: unknown }> }>(daemon, `/api/workflow-runs/${runId}`);
  const outcome = run.attempts.find((attempt) => attempt.nodeId === "affected")!.output as {
    affected: { selectedCount: number; settings: { sources: Array<{ key: string; layer: string }> } };
  };
  expect(outcome.affected.selectedCount).toBe(1);
  expect(outcome.affected.settings.sources.map((source) => `${source.key}:${source.layer}`)).toEqual([
    "tests.patterns:stored",
    "tests.includeImporters:local",
    "tests.smokeSet:stored",
  ]);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const card = dashboard.locator("article.wf-run-check").filter({ hasText: "Command · affected-tests" });
  if (!(await card.isVisible())) {
    // A passing gate sits under the worklist's Passed segment rather than Blocking.
    await dashboard.getByRole("button", { name: /^Passed \d+$/ }).first().click();
    await dashboard.locator("button.wf-run-worklist-row.is-check").first().click();
  }
  await expect(card).toBeVisible({ timeout: 40_000 });
  await expect(card.getByRole("list", { name: "Selected tests" })).toContainText("test/smoke.test.ts");
  await expect(card).toContainText(
    "Settings: tests.patterns stored (root), tests.includeImporters local, tests.smokeSet stored (root)",
  );
  await card.scrollIntoViewIfNeeded();
  await shoot(dashboard, "run-detail-settings-sources");
});
