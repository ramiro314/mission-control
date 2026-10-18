import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * An `affected-tests` Command, end to end: the daemon reads the repository's committed
 * `.mission/testing.json`, selects its smoke test, fills the `{files}` / `{junit}` template,
 * runs it, reads the JUnit results, reruns the one failed file, and reports the test that
 * failed once and passed on the rerun as a local flake - which the run detail card lists.
 *
 * The "test runner" is `sh`: it writes a failing JUnit result the first time and a passing one
 * on the rerun (it can tell because the first run's results file sits beside the second's).
 * No model tokens: the dispatch holds a fake agent and the graph has no Persona.
 *
 * The monorepo case partitions the same selection by app: each app's override runs its own
 * tests in its own folder, and a package no Command covers is listed as selected but unrun.
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

/** What one spec commits to the fixture repository, and the affected-tests Commands it saves. */
interface Fixture {
  testing: unknown;
  /** Repository-relative test files, each written as an empty module. */
  files: string[];
  checkCommands: (repo: string) => Array<{ repoRoot: string; slot: "affected-tests"; command: string[] }>;
  /** Further workflow policy for this spec, laid over the shared consent settings. */
  policy?: Record<string, unknown>;
  /** The check status the run settles on. `passed` unless set. */
  expect?: "passed" | "failed";
}

/** The single-repository case: one smoke test, and one Command at the repository root. */
const SMOKE_FIXTURE: Fixture = {
  testing: { tests: { patterns: ["test/**/*.test.ts"], smokeSet: ["test/smoke.test.ts"] } },
  files: ["test/smoke.test.ts"],
  checkCommands: (repo) => [{
    repoRoot: repo,
    slot: "affected-tests",
    command: ["sh", "-c", RUNNER, "sh", "{junit}", "{files}"],
  }],
};

/** Commit the project's testing settings and its test files to the fixture repository. */
function commitTestingSettings(repo: string, fixture: Fixture): void {
  mkdirSync(join(repo, ".mission"), { recursive: true });
  writeFileSync(join(repo, ".mission/testing.json"), JSON.stringify(fixture.testing));
  for (const file of fixture.files) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), "export {};\n");
  }
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

async function seedRun(page: Page, daemon: DaemonHandle, fixture: Fixture = SMOKE_FIXTURE): Promise<string> {
  commitTestingSettings(daemon.repo, fixture);
  const sessionId = await dispatch(page, daemon);
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true,
    checksEnabled: true,
    repoAllowlist: [daemon.repo],
    kindWorkflowDefaults: { ship: null },
    ...fixture.policy,
    checkCommands: fixture.checkCommands(daemon.repo),
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
      }, { message: `the affected-tests check should settle as ${fixture.expect ?? "passed"}`, timeout: 60_000 })
      .toBe(fixture.expect ?? "passed");
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

/** The web app's runner: it passes, and says where it ran and what it was handed. */
const WEB_RUNNER = [
  "junit=\"$1\"; shift",
  "echo \"web partition in $(basename \"$PWD\") ran: $*\"",
  "exit 0",
].join("\n");

/**
 * A monorepo: two apps, each with its own affected-tests override, and a package with none.
 * There is no root override and no global default, so the package's test is selected but unrun.
 */
const MONOREPO_FIXTURE: Fixture = {
  testing: {
    tests: {
      patterns: ["**/*.test.ts"],
      smokeSet: ["apps/web/web.test.ts", "apps/api/api.test.ts", "packages/ui/ui.test.ts"],
    },
  },
  files: ["apps/web/web.test.ts", "apps/api/api.test.ts", "packages/ui/ui.test.ts"],
  checkCommands: (repo) => [
    { repoRoot: `${repo}/apps/web`, slot: "affected-tests", command: ["sh", "-c", WEB_RUNNER, "sh", "{junit}", "{files}"] },
    // The api app's runner flakes: it fails first and passes on the rerun of its own partition.
    { repoRoot: `${repo}/apps/api`, slot: "affected-tests", command: ["sh", "-c", RUNNER, "sh", "{junit}", "{files}"] },
  ],
};

test("a monorepo affected-tests check lists each app's partition and the test no Command could run", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedRun(dashboard, daemon, MONOREPO_FIXTURE);

  // The durable outcome: one partition per app, in path order, each in its own folder.
  const run = await api<{ attempts: Array<{ nodeId: string; output: unknown }> }>(
    daemon,
    `/api/workflow-runs/${runId}`,
  );
  const outcome = run.attempts.find((attempt) => attempt.nodeId === "affected")!.output as {
    note: string;
    affected: {
      selectedCount: number;
      flakes: Array<{ file: string; name: string }>;
      partitions: Array<{ subpath: string; fileCount: number; status: string; output: string }>;
      unrun: string[];
    };
  };
  expect(outcome.affected.selectedCount).toBe(3);
  expect(outcome.affected.partitions.map(({ subpath, fileCount, status }) => ({ subpath, fileCount, status }))).toEqual([
    { subpath: "apps/api", fileCount: 1, status: "passed" },
    { subpath: "apps/web", fileCount: 1, status: "passed" },
  ]);
  // Files reach each Command relative to its own folder, and results map back to tree paths.
  expect(outcome.affected.partitions[1]!.output).toContain("web partition in web ran: web.test.ts");
  expect(outcome.affected.flakes).toEqual([{ file: "apps/api/api.test.ts", name: "flaky timing" }]);
  expect(outcome.affected.unrun).toEqual(["packages/ui/ui.test.ts"]);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const card = dashboard.locator("article.wf-run-check").filter({ hasText: "Command · affected-tests" });
  if (!(await card.isVisible())) {
    // A passing gate sits under the worklist's Passed segment rather than Blocking.
    await dashboard.getByRole("button", { name: /^Passed \d+$/ }).first().click();
    await dashboard.locator("button.wf-run-worklist-row.is-check").first().click();
  }
  await expect(card).toBeVisible({ timeout: 40_000 });
  await expect(card).toContainText(
    "Ran 2 selected test files in 2 partitions; 1 test flaked and passed on rerun. "
    + "1 selected test file was not run: no affected-tests Command covers it.",
  );

  const partitions = card.getByRole("list", { name: "Partitions" });
  await expect(card.getByRole("heading", { name: "Partitions (2)" })).toBeVisible();
  const apiApp = partitions.getByRole("listitem", { name: "Partition apps/api" });
  const webApp = partitions.getByRole("listitem", { name: "Partition apps/web" });
  await expect(apiApp).toContainText("Passed");
  await expect(apiApp).toContainText("1 file · exit 0");
  await expect(apiApp).toContainText("sh -c");
  await expect(apiApp).toContainText("Ran 1 selected test file; 1 test flaked and passed on rerun.");
  await expect(webApp).toContainText("Ran 1 selected test file; all passed.");

  // Each partition's own output tail, folded until asked for.
  const apiTail = apiApp.locator("pre.wf-run-partition-output");
  await expect(apiTail).toBeHidden();
  await apiApp.getByText("Output tail").click();
  await expect(apiTail).toContainText("rerunning 1 file once");
  await webApp.getByText("Output tail").click();
  await expect(webApp.locator("pre.wf-run-partition-output")).toContainText("web partition in web ran: web.test.ts");

  await expect(card.getByRole("heading", { name: "Selected but unrun (1)" })).toBeVisible();
  await expect(card.getByRole("list", { name: "Selected but unrun tests" })).toHaveText("packages/ui/ui.test.ts");
  await expect(card).toContainText("The gate decided on the partitions that ran.");

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    // Tall enough to hold both partitions and the unrun list, from the partitions heading down.
    await dashboard.setViewportSize({ width: 1280, height: 1400 });
    await dashboard.mouse.move(0, 0);
    await card.getByRole("heading", { name: "Partitions (2)" }).scrollIntoViewIfNeeded();
    await dashboard.screenshot({ path: `${EVIDENCE}run-detail-partitions.png` });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/affected-tests/run-detail-partitions.png");
  }
});

/** Each app's runner: it takes three of the four seconds a command may run, then passes. */
const SLOW_RUNNER = [
  "junit=\"$1\"; shift",
  "echo \"slow partition ran: $*\"",
  "sleep 3",
  "exit 0",
].join("\n");

/**
 * Three apps, each with an override running a three-second suite, under a four-second command
 * timeout and so an eight-second gate deadline. The first two finish; the third has at most two
 * seconds left and the deadline stops it.
 */
const DEADLINE_FIXTURE: Fixture = {
  testing: {
    tests: {
      patterns: ["**/*.test.ts"],
      smokeSet: ["apps/api/api.test.ts", "apps/docs/docs.test.ts", "apps/web/web.test.ts"],
    },
  },
  files: ["apps/api/api.test.ts", "apps/docs/docs.test.ts", "apps/web/web.test.ts"],
  checkCommands: (repo) => ["apps/api", "apps/docs", "apps/web"].map((app) => ({
    repoRoot: `${repo}/${app}`,
    slot: "affected-tests" as const,
    command: ["sh", "-c", SLOW_RUNNER, "sh", "{junit}", "{files}"],
  })),
  // The machine-wide test lease is shared with every other worker's daemon, and a four-second
  // wait for it would be a flake rather than a finding. Partitions still run one after another.
  policy: { checkTestLease: false },
  expect: "failed",
};

test.describe("a gate that reaches its deadline", () => {
  test.use({ daemonEnv: { MISSION_CHECK_TIMEOUT_MS: "4000" } });

  test("run detail lists the partitions that ran and the one the deadline stopped", async ({ dashboard, daemon }) => {
    const runId = await seedRun(dashboard, daemon, DEADLINE_FIXTURE);

    const run = await api<{ attempts: Array<{ nodeId: string; output: unknown }> }>(
      daemon,
      `/api/workflow-runs/${runId}`,
    );
    const outcome = run.attempts.find((attempt) => attempt.nodeId === "affected")!.output as {
      status: string;
      affected: {
        deadlineMs: number;
        partitions: Array<{ subpath: string; status: string }>;
        unfinished: Array<{ subpath: string; fileCount: number }>;
      };
    };
    expect(outcome.status).toBe("failed");
    expect(outcome.affected.deadlineMs).toBe(8_000);
    expect(outcome.affected.partitions.map(({ subpath, status }) => ({ subpath, status }))).toEqual([
      { subpath: "apps/api", status: "passed" },
      { subpath: "apps/docs", status: "passed" },
    ]);
    expect(outcome.affected.unfinished.map(({ subpath, fileCount }) => ({ subpath, fileCount }))).toEqual([
      { subpath: "apps/web", fileCount: 1 },
    ]);

    await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
    const card = dashboard.locator("article.wf-run-check").filter({ hasText: "Command · affected-tests" });
    if (!(await card.isVisible())) await dashboard.locator("button.wf-run-worklist-row.is-check").first().click();
    await expect(card).toBeVisible({ timeout: 40_000 });
    await expect(card).toContainText(
      "Ran 2 selected test files in 2 partitions before the gate's 8 seconds deadline; "
      + "1 partition did not finish (apps/web), so the gate fails rather than pass on part of the change.",
    );
    await expect(card.getByRole("heading", { name: "Partitions (2)" })).toBeVisible();
    await expect(card.getByRole("heading", { name: "Did not finish (1)" })).toBeVisible();
    const unfinished = card.getByRole("list", { name: "Partitions that did not finish" });
    const web = unfinished.getByRole("listitem", { name: "Unfinished partition apps/web" });
    await expect(web).toContainText("1 file");
    await expect(web).toContainText(/stopped at the deadline|not started/);
    await expect(web).toContainText("sh -c");
    await expect(card).toContainText("The gate's 8 seconds deadline passed before these partitions finished");
    // Not the failed status's usual "exited non-zero": no command did.
    await expect(card).toContainText("The gate's deadline passed before every partition finished, so it failed.");
    await expect(card).not.toContainText("exited non-zero");

    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync(EVIDENCE, { recursive: true });
      await dashboard.setViewportSize({ width: 1280, height: 1400 });
      await dashboard.mouse.move(0, 0);
      await web.scrollIntoViewIfNeeded();
      await dashboard.screenshot({ path: `${EVIDENCE}run-detail-deadline.png` });
      // eslint-disable-next-line no-console
      console.log("CAPTURED e2e/.artifacts/affected-tests/run-detail-deadline.png");
    }
  });
});
