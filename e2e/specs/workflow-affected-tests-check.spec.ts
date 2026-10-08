import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { skipSpecOnWin32 } from "../../test/helpers/win32-skip.ts";

skipSpecOnWin32(test, "check commands run only on Linux and macOS, through POSIX process groups, so the daemon records this gate as unavailable on win32 instead of running it");

/**
 * An `affected-tests` Command, end to end: the daemon reads the repository's committed
 * `.mission/testing.json`, selects its smoke test, fills the `{files}` / `{junit}` template,
 * runs it, reads the JUnit results, reruns the one failed file, and reports the test that
 * failed once and passed on the rerun as a local flake - which the run detail card lists.
 *
 * The "test runner" is `sh`: it writes a failing JUnit result the first time and a passing one
 * on the rerun (it can tell because the first run's results file sits beside the second's).
 * No model tokens: the dispatch holds a fake agent and the graph has no Persona.
 */

const EVIDENCE = artifactsDir("affected-tests");

const RUNNER = [
  "junit=\"$1\"; shift",
  "echo \"selected: $*\"",
  "if [ -e \"$(dirname \"$junit\")/junit-1.xml\" ]; then",
  "  printf '<testsuites><testcase name=\"flaky timing\" classname=\"test\" file=\"%s\"/></testsuites>' \"$1\" > \"$junit\"",
  "  exit 0",
  "fi",
  "printf '<testsuites><testcase name=\"flaky timing\" classname=\"test\" file=\"%s\"><failure message=\"timed out under load\">E2E FLAKE</failure></testcase></testsuites>' \"$1\" > \"$junit\"",
  "exit 1",
].join("\n");

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/** Commit the project's testing settings and one smoke test to the fixture repository. */
function commitTestingSettings(repo: string): void {
  mkdirSync(join(repo, ".mission"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, ".mission/testing.json"), JSON.stringify({
    tests: { patterns: ["test/**/*.test.ts"], smokeSet: ["test/smoke.test.ts"] },
  }));
  writeFileSync(join(repo, "test/smoke.test.ts"), "export {};\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("add", "-A");
  git("-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-qm", "testing settings");
  git("push", "-q", "origin", "main");
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for the affected-tests spec");
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

async function seedRun(page: Page, daemon: DaemonHandle): Promise<string> {
  commitTestingSettings(daemon.repo);
  const sessionId = await dispatch(page, daemon);
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

  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E affected tests",
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
    { requestId: "e2e-affected-tests" },
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
      }, { message: "the affected-tests check should run, rerun, and pass", timeout: 60_000 })
      .toBe("passed");
  } catch (caught) {
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }
  return runId;
}

test("an affected-tests check shows its selection and a local flake that passed on rerun", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedRun(dashboard, daemon);

  // The durable outcome records the TEMPLATE, never the argv expanded with the selection.
  const run = await api<{ attempts: Array<{ nodeId: string; output: unknown }> }>(
    daemon,
    `/api/workflow-runs/${runId}`,
  );
  const outcome = run.attempts.find((attempt) => attempt.nodeId === "affected")!.output as {
    command: string[];
    affected: { selectedCount: number; flakes: Array<{ file: string; name: string }> };
  };
  expect(outcome.command).toEqual(["sh", "-c", RUNNER, "sh", "{junit}", "{files}"]);
  expect(outcome.affected.selectedCount).toBe(1);
  expect(outcome.affected.flakes).toEqual([{ file: "test/smoke.test.ts", name: "flaky timing" }]);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const card = dashboard.locator("article.wf-run-check").filter({ hasText: "Command · affected-tests" });
  if (!(await card.isVisible())) {
    // A passing gate sits under the worklist's Passed segment rather than Blocking.
    await dashboard.getByRole("button", { name: /^Passed \d+$/ }).first().click();
    await dashboard.locator("button.wf-run-worklist-row.is-check").first().click();
  }
  await expect(card).toBeVisible({ timeout: 40_000 });
  await expect(card).toContainText("Ran 1 selected test file; 1 test flaked and passed on rerun.");
  const selected = card.getByRole("list", { name: "Selected tests" });
  await expect(selected).toContainText("test/smoke.test.ts");
  await expect(selected).toContainText("smoke set");
  const flakes = card.getByRole("list", { name: "Local flakes" });
  await expect(flakes).toContainText("flaky timing (test/smoke.test.ts)");
  await expect(card).toContainText("did not fail the check");
  // Both runs' output is kept, with the rerun announced between them.
  await expect(card.locator("pre.wf-run-check-output")).toContainText("rerunning 1 file once");

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await card.scrollIntoViewIfNeeded();
    await dashboard.screenshot({ path: `${EVIDENCE}run-detail-local-flake.png`, fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/affected-tests/run-detail-local-flake.png");
  }
});
