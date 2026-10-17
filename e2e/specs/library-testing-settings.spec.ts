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

test("a repository with no override is added to Testing settings by its root, and a folder inside it adds its own row", async ({
  dashboard,
  daemon,
}) => {
  // No affected-tests override and nothing stored: the section starts with no rows at all.
  await dashboard.goto(`${daemon.baseURL}/#/library/commands/affected-tests`);
  const section = dashboard.getByRole("region", { name: "Testing settings" });
  await expect(section).toBeVisible();
  const rows = section.getByRole("group", { name: /^Testing settings for / });
  await expect(rows).toHaveCount(0);
  expect(await api<TestingSettingsView[]>(daemon, "/api/testing-settings")).toEqual([]);

  const box = section.getByRole("combobox", { name: "Add a repository or folder" });
  const add = section.getByRole("button", { name: "Add row" });

  // A path that is not in any repository is refused in words, and adds no row.
  await box.fill(join(daemon.repo, "..", "not-a-repository-anywhere"));
  await add.click();
  await expect(section.getByRole("alert")).toContainText("not a git repository");
  await expect(rows).toHaveCount(0);

  // The repository itself adds one row, under its canonical root, with nothing stored yet.
  await box.fill(daemon.repo);
  await add.click();
  await expect(rows).toHaveCount(1);
  const row = rows.first();
  await expect(row).toHaveAccessibleName(new RegExp(`^Testing settings for .*${basename(daemon.repo)}$`));
  await expect(row).toContainText("Nothing stored yet");
  await expect(section.getByRole("alert")).toHaveCount(0);
  await expect(box).toHaveValue("");

  // Adding it again does not duplicate the row.
  await box.fill(daemon.repo);
  await add.click();
  await expect(rows).toHaveCount(1);

  await row.getByLabel("Test patterns").fill("test/**/*.test.ts");
  await row.getByLabel("Include importers").selectOption("off");
  await row.getByRole("button", { name: "Save testing settings" }).click();
  await expect(row).toContainText("Stored revision 1");
  const stored = await api<TestingSettingsView[]>(daemon, "/api/testing-settings");
  expect(stored).toHaveLength(1);
  expect(stored[0]!.settings).toEqual({ tests: { patterns: ["test/**/*.test.ts"], includeImporters: false } });
  expect(stored[0]!.repoRoot.endsWith(`/${basename(daemon.repo)}`)).toBe(true);
  await shoot(dashboard, "testing-settings-added-repository");

  // An explicit empty list is a value of its own: "This row" with no globs stores [] for the
  // smoke set, which replaces a committed one, while Inherit leaves the key unset.
  const smokeFrom = row.getByLabel("Smoke globs come from");
  await expect(smokeFrom).toHaveValue("inherit");
  await smokeFrom.selectOption("set");
  await expect(row.getByLabel("Smoke set")).toHaveValue("");
  await row.getByRole("button", { name: "Save testing settings" }).click();
  await expect(row).toContainText("Stored revision 2");
  const [emptySmoke] = await api<TestingSettingsView[]>(daemon, "/api/testing-settings");
  expect(emptySmoke!.settings).toEqual({
    tests: { patterns: ["test/**/*.test.ts"], includeImporters: false, smokeSet: [] },
  });
  await shoot(dashboard, "testing-settings-empty-smoke-set");

  // A reload lists the stored row by itself, with no override behind it, and the empty list
  // reads back as set by this row rather than inherited.
  await dashboard.reload();
  const reloaded = section.getByRole("group", { name: /^Testing settings for / });
  await expect(reloaded).toHaveCount(1);
  await expect(section).toContainText("Stored revision 2");
  await expect(reloaded.getByLabel("Smoke globs come from")).toHaveValue("set");
  await expect(reloaded.getByLabel("Patterns come from")).toHaveValue("set");

  // Back to Inherit unsets the key again.
  await reloaded.getByLabel("Smoke globs come from").selectOption("inherit");
  await reloaded.getByRole("button", { name: "Save testing settings" }).click();
  await expect(reloaded).toContainText("Stored revision 3");
  const [inherited] = await api<TestingSettingsView[]>(daemon, "/api/testing-settings");
  expect(inherited!.settings).toEqual({ tests: { patterns: ["test/**/*.test.ts"], includeImporters: false } });
});

/** Commit a small monorepo app and nothing else: no `.mission/testing.json` anywhere. */
function commitMonorepoApp(repo: string): void {
  const files: Record<string, string> = {
    "apps/web/src/a.test.ts": "export {};\n",
    "apps/web/smoke/web.smoke.ts": "export {};\n",
    // Matches the root's smoke glob below, but the app's own smoke set replaces it inside apps/web.
    "apps/web/root-smoke.test.ts": "export {};\n",
    "tools/root-smoke.test.ts": "export {};\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("add", "-A");
  git("-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-qm", "monorepo app");
  git("push", "-q", "origin", "main");
}

test("a subdirectory's testing settings are edited in Library and shape the gate's selection", async ({
  dashboard,
  daemon,
}) => {
  commitMonorepoApp(daemon.repo);
  const sessionId = await dispatch(dashboard, daemon);
  const command = ["sh", "-c", RUNNER, "sh", "{junit}", "{files}"];
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true,
    checksEnabled: true,
    repoAllowlist: [daemon.repo],
    kindWorkflowDefaults: { ship: null },
    checkCommands: [
      { repoRoot: daemon.repo, slot: "affected-tests", command },
      // A subdirectory override lists its folder's row with nothing stored.
      { repoRoot: join(daemon.repo, "tools"), slot: "affected-tests", command },
    ],
  }, "PUT");

  // The root's row, stored through the API: a smoke glob for every `root-smoke.test.ts`.
  const rootPath = (await api<{ repoRoot: string }>(daemon, "/api/repos/resolve", { path: daemon.repo })).repoRoot;
  await api(daemon, "/api/testing-settings", {
    repoRoot: rootPath,
    expectedRevision: 0,
    settings: { tests: { smokeSet: ["**/root-smoke.test.ts"] } },
  }, "PUT");

  await dashboard.goto(`${daemon.baseURL}/#/library/commands/affected-tests`);
  const section = dashboard.getByRole("region", { name: "Testing settings" });
  await expect(section).toContainText("its globs are relative to the folder");
  const rows = section.getByRole("group", { name: /^Testing settings for / });
  await expect(rows).toHaveCount(2);
  const tools = section.getByRole("group", { name: /^Testing settings for .*\/tools$/ });
  await expect(tools).toContainText("Nothing stored yet");
  await expect(tools).toContainText("Applies to files inside tools");

  // The operator adds the app's folder: a row of its own, below the root's, nothing stored yet.
  await section.getByRole("combobox", { name: "Add a repository or folder" }).fill(join(daemon.repo, "apps", "web"));
  await section.getByRole("button", { name: "Add row" }).click();
  await expect(rows).toHaveCount(3);
  const app = section.getByRole("group", { name: /^Testing settings for .*\/apps\/web$/ });
  await expect(app).toBeVisible();
  await expect(rows.nth(1)).toHaveAccessibleName(/\/apps\/web$/);
  await expect(app).toContainText("Nothing stored yet");
  await expect(app).toContainText("Applies to files inside apps/web");
  await expect(app).toContainText("relative to apps/web");

  // Its globs are typed relative to the folder.
  await app.getByLabel("Test patterns").fill("src/**/*.test.ts");
  await app.getByLabel("Smoke set").fill("smoke/*.ts");
  await app.getByRole("button", { name: "Save testing settings" }).click();
  await expect(app).toContainText("Stored revision 1");
  const stored = await api<TestingSettingsView[]>(daemon, "/api/testing-settings");
  const appRow = stored.find((view) => view.repoRoot === `${rootPath}/apps/web`);
  expect(appRow?.settings).toEqual({ tests: { patterns: ["src/**/*.test.ts"], smokeSet: ["smoke/*.ts"] } });
  await shoot(dashboard, "testing-settings-subdirectory-row");

  // A reload lists both rows again, the folder's with what it stored.
  await dashboard.reload();
  await expect(rows).toHaveCount(3);
  await expect(app.getByLabel("Patterns come from")).toHaveValue("set");
  await expect(app.getByLabel("Smoke set")).toHaveValue("smoke/*.ts");
  await expect(app.getByLabel("Include importers")).toHaveValue("inherit");

  // The gate: nothing changed, so the smoke sets decide. Inside apps/web the app's own smoke set
  // replaces the root's, so apps/web/root-smoke.test.ts is NOT selected while tools' one is.
  const runId = await submitRun(daemon, sessionId);
  const run = await api<{ attempts: Array<{ nodeId: string; output: unknown }> }>(daemon, `/api/workflow-runs/${runId}`);
  const outcome = run.attempts.find((attempt) => attempt.nodeId === "affected")!.output as {
    affected: {
      selected: Array<{ path: string; reason: string }>;
      settings: { scopes: Array<{ path: string; sources: Array<{ key: string; layer: string; scope: string | null }> }> };
      diagnostics: string[];
    };
  };
  expect(outcome.affected.selected).toEqual([
    { path: "apps/web/smoke/web.smoke.ts", reason: "smoke" },
    { path: "tools/root-smoke.test.ts", reason: "smoke" },
  ]);
  expect(outcome.affected.settings.scopes.map((scope) => scope.path)).toEqual(["apps/web"]);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const card = dashboard.locator("article.wf-run-check").filter({ hasText: "Command · affected-tests" });
  if (!(await card.isVisible())) {
    await dashboard.getByRole("button", { name: /^Passed \d+$/ }).first().click();
    await dashboard.locator("button.wf-run-worklist-row.is-check").first().click();
  }
  await expect(card).toBeVisible({ timeout: 40_000 });
  await expect(card.getByRole("list", { name: "Selected tests" })).toContainText("apps/web/smoke/web.smoke.ts");
  await expect(card.getByRole("list", { name: "Selected tests" })).not.toContainText("apps/web/root-smoke.test.ts");
  await expect(card.getByRole("list", { name: "Testing scopes" })).toContainText(
    "apps/web: tests.patterns stored (apps/web), tests.includeImporters default, tests.smokeSet stored (apps/web)",
  );
  // Per-app aliases are resolved now, so a monorepo with app scopes has nothing to note.
  await expect(card.getByRole("list", { name: "Selection notes" })).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await shoot(dashboard, "run-detail-testing-scopes");
});

/**
 * A monorepo app with its own `@web/*` alias and a workspace package, on main. The change, made
 * in the session's checkout, touches one file behind each: only an import through the app's
 * tsconfig.json or the workspace name reaches it.
 */
function commitAliasedApp(repo: string): void {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", main: "src/index.ts" }),
    "packages/ui/src/index.ts": "export const ui = 1;\n",
    "apps/web/tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@web/*": ["./src/*"] } } }),
    "apps/web/src/util.ts": "export const u = 1;\n",
    "apps/web/src/alias.test.ts": "import { u } from \"@web/util\";\n",
    "apps/web/src/ui.test.ts": "import { ui } from \"@acme/ui\";\n",
    "apps/web/src/untouched.test.ts": "export {};\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("add", "-A");
  git("-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-qm", "aliased monorepo app");
  git("push", "-q", "origin", "main");
}

test("an import through an app's own alias or a workspace name selects its importer, with no selection notes", async ({
  dashboard,
  daemon,
}) => {
  commitAliasedApp(daemon.repo);
  const sessionId = await dispatch(dashboard, daemon);
  const sessions = await api<Array<{ id: string; cwd: string | null }>>(daemon, "/api/sessions");
  const checkout = sessions.find((session) => session.id === sessionId)?.cwd ?? "";
  expect(checkout, "the dispatched session reported a checkout").not.toBe("");

  // The session's change: one file behind the alias, one inside the workspace package.
  writeFileSync(join(checkout, "apps/web/src/util.ts"), "export const u = 2;\n");
  writeFileSync(join(checkout, "packages/ui/src/index.ts"), "export const ui = 2;\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", checkout, ...args], { stdio: "pipe" });
  git("add", "-A");
  git("-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-qm", "touch the app and the package");

  const command = ["sh", "-c", RUNNER, "sh", "{junit}", "{files}"];
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true,
    checksEnabled: true,
    repoAllowlist: [daemon.repo],
    kindWorkflowDefaults: { ship: null },
    checkCommands: [{ repoRoot: daemon.repo, slot: "affected-tests", command }],
  }, "PUT");
  // The root's patterns, and an app scope of its own: the monorepo shape that used to report
  // per-app aliases as unresolved.
  const rootPath = (await api<{ repoRoot: string }>(daemon, "/api/repos/resolve", { path: daemon.repo })).repoRoot;
  await api(daemon, "/api/testing-settings", {
    repoRoot: rootPath,
    expectedRevision: 0,
    settings: { tests: { patterns: ["**/*.test.ts"] } },
  }, "PUT");
  await api(daemon, "/api/testing-settings", {
    repoRoot: `${rootPath}/apps/web`,
    expectedRevision: 0,
    settings: { tests: { patterns: ["src/**/*.test.ts"] } },
  }, "PUT");

  const runId = await submitRun(daemon, sessionId);
  const run = await api<{ attempts: Array<{ nodeId: string; output: unknown }> }>(daemon, `/api/workflow-runs/${runId}`);
  const outcome = run.attempts.find((attempt) => attempt.nodeId === "affected")!.output as {
    affected: { selected: Array<{ path: string; reason: string; via?: string }>; diagnostics?: string[] };
  };
  expect(outcome.affected.selected).toEqual([
    { path: "apps/web/src/alias.test.ts", reason: "imports", via: "apps/web/src/util.ts" },
    { path: "apps/web/src/ui.test.ts", reason: "imports", via: "packages/ui/src/index.ts" },
  ]);
  expect(outcome.affected.diagnostics).toBeUndefined();

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const card = dashboard.locator("article.wf-run-check").filter({ hasText: "Command · affected-tests" });
  if (!(await card.isVisible())) {
    await dashboard.getByRole("button", { name: /^Passed \d+$/ }).first().click();
    await dashboard.locator("button.wf-run-worklist-row.is-check").first().click();
  }
  await expect(card).toBeVisible({ timeout: 40_000 });
  const selected = card.getByRole("list", { name: "Selected tests" });
  await expect(selected).toContainText("apps/web/src/alias.test.ts");
  await expect(selected).toContainText("apps/web/src/ui.test.ts");
  await expect(selected).not.toContainText("apps/web/src/untouched.test.ts");
  await expect(card.getByRole("list", { name: "Selection notes" })).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await shoot(dashboard, "run-detail-per-app-aliases");
});
