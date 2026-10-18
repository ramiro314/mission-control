import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

/**
 * Command documents, end to end: in Library › Commands an operator imports one repository's
 * Command overrides and testing settings from a versioned JSON document, reviews a preview of
 * every add, change and removal, and applies it in one step. A second window's save in between
 * makes the preview stale: apply is refused, the preview is recomputed, and nothing is written
 * until the operator applies again. Export reads the repository back out as a document, and
 * importing that document changes nothing.
 *
 * No agent runs at all: nothing here dispatches, so no binary is reached, and every agent the
 * fixture daemon knows is already redirected at a fake (`e2e/fixtures/fake-agents.ts`).
 */

const EVIDENCE = artifactsDir("library-command-documents");

const AFFECTED = ["yarn", "test:affected", "--junit-file={junit}", "{files}"];

interface CommandView {
  slot: string;
  defaultCommand: string[] | null;
  maxRuns: number;
  overrides: Array<{ repoRoot: string; command: string[] }>;
  revision: number;
}

interface TestingSettingsView {
  repoRoot: string;
  settings: unknown;
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

/** Replace one slot's overrides the way another window's Save would. */
async function saveSlot(daemon: DaemonHandle, slot: string, overrides: CommandView["overrides"]): Promise<void> {
  const view = await api<CommandView>(daemon, `/api/workflow-commands/${slot}`);
  await api(daemon, `/api/workflow-commands/${slot}`, {
    expectedRevision: view.revision,
    defaultCommand: view.defaultCommand,
    maxRuns: view.maxRuns,
    overrides,
  }, "PUT");
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/library-command-documents/${name}.png`);
}

/** Type the repository into a document modal's picker and leave the field, closing its list. */
async function chooseRepository(dialog: Locator, repo: string): Promise<void> {
  await dialog.getByRole("combobox", { name: "Repository" }).fill(repo);
  await dialog.getByRole("heading").first().click();
}

test("a Command document is previewed, refused as stale after another window saves, applied, exported and round-trips", async ({
  dashboard,
  daemon,
}) => {
  // The folders the document names exist in the main checkout; no commit is needed for that.
  mkdirSync(join(daemon.repo, "apps", "web"), { recursive: true });
  mkdirSync(join(daemon.repo, "apps", "legacy"), { recursive: true });
  const root = (await api<{ repoRoot: string }>(daemon, "/api/repos/resolve", { path: daemon.repo })).repoRoot;

  // What is stored before the import: a `test` override the document removes, a lint default
  // the document must not touch, and a testing settings row for a folder it does not mention.
  await saveSlot(daemon, "test", [{ repoRoot: `${root}/apps/legacy`, command: ["npm", "run", "legacy-test"] }]);
  const lint = await api<CommandView>(daemon, "/api/workflow-commands/lint");
  await api(daemon, "/api/workflow-commands/lint", {
    expectedRevision: lint.revision,
    defaultCommand: ["npm", "run", "lint"],
    maxRuns: 3,
    overrides: [],
  }, "PUT");
  await api(daemon, "/api/testing-settings", {
    repoRoot: `${root}/apps/legacy`,
    expectedRevision: 0,
    settings: { tests: { includeImporters: false } },
  }, "PUT");

  const document = {
    version: 1,
    commands: {
      lint: [{ path: "", argv: ["yarn", "lint"] }, { path: "apps/web", argv: ["yarn", "workspace", "web", "lint"] }],
      "affected-tests": [{ path: "apps/web", argv: AFFECTED }],
      test: [{ path: "apps/legacy", remove: true }],
    },
    testing: [{ path: "apps/web", settings: { tests: { patterns: ["src/**/*.test.ts"], smokeSet: ["smoke/*.ts"] } } }],
  };

  await dashboard.goto(`${daemon.baseURL}/#/library/commands/lint`);
  await expect(dashboard.getByRole("heading", { name: "lint", exact: true })).toBeVisible();
  await dashboard.getByRole("button", { name: "Import document" }).click();
  const importer = dashboard.getByRole("dialog", { name: "Import a Command document" });
  await expect(importer).toBeVisible();
  await expectContentClearsBorder(importer);

  // A document that reaches past its rows is refused in words, before any preview.
  await chooseRepository(importer, daemon.repo);
  const box = importer.getByLabel("Document", { exact: true });
  await box.fill(JSON.stringify({ version: 1, maxRuns: 5 }));
  await importer.getByRole("button", { name: "Preview" }).click();
  await expect(importer.getByRole("alert", { name: "Document problems" })).toContainText("Unrecognized key(s) in object: 'maxRuns'");

  // The affected-tests template rule is the Command editor's own.
  await box.fill(JSON.stringify({ version: 1, commands: { "affected-tests": [{ path: "", argv: ["yarn", "test"] }] } }));
  await importer.getByRole("button", { name: "Preview" }).click();
  await expect(importer.getByRole("alert", { name: "Document problems" }))
    .toContainText("commands.affected-tests[0].argv: An affected-tests command must contain");

  // The real document: the preview lists every add, change and removal, and writes nothing.
  await box.fill(JSON.stringify(document, null, 2));
  await importer.getByRole("button", { name: "Preview" }).click();
  const preview = importer.getByRole("region", { name: "Preview" });
  await expect(preview).toContainText("4 to add, 1 to remove");
  await expect(importer.getByRole("list", { name: "lint changes" })).toContainText("Add the repository root yarn lint");
  await expect(importer.getByRole("list", { name: "lint changes" })).toContainText("Add apps/web yarn workspace web lint");
  await expect(importer.getByRole("list", { name: "test changes" })).toContainText("Remove apps/legacy npm run legacy-test");
  await expect(importer.getByRole("list", { name: "affected-tests changes" })).toContainText("Add apps/web");
  await expect(importer.getByRole("list", { name: "Testing settings changes" }))
    .toContainText("Add apps/web patterns: src/**/*.test.ts · smokeSet: smoke/*.ts");
  expect((await api<CommandView>(daemon, "/api/workflow-commands/lint")).overrides).toEqual([]);
  await expectContentClearsBorder(importer);
  await shoot(dashboard, "import-preview");

  // Another window saves an apps/web lint override while the preview is open.
  await saveSlot(daemon, "lint", [{ repoRoot: `${root}/apps/web`, command: ["pnpm", "lint"] }]);
  await importer.getByRole("button", { name: "Apply 5 changes" }).click();
  await expect(importer.getByRole("status")).toContainText("changed since that preview, so nothing was written");
  // The recomputed preview: apps/web is now a change from the other window's command.
  await expect(importer.getByRole("region", { name: "Preview" })).toContainText("3 to add, 1 to change, 1 to remove");
  await expect(importer.getByRole("list", { name: "lint changes" })).toContainText("Change apps/web pnpm lint");
  expect((await api<CommandView>(daemon, "/api/workflow-commands/test")).overrides).toHaveLength(1);
  expect((await api<TestingSettingsView[]>(daemon, "/api/testing-settings")).map((view) => view.repoRoot))
    .toEqual([`${root}/apps/legacy`]);
  await shoot(dashboard, "import-stale-recomputed");

  await importer.getByRole("button", { name: "Apply 5 changes" }).click();
  await expect(importer).toBeHidden();
  await expect(dashboard.getByRole("status").filter({ hasText: "Applied 5 changes to" })).toBeVisible();

  // Written: the rows, and nothing else. The lint default and run budget are as they were.
  const lintAfter = await api<CommandView>(daemon, "/api/workflow-commands/lint");
  expect(lintAfter.defaultCommand).toEqual(["npm", "run", "lint"]);
  expect(lintAfter.maxRuns).toBe(3);
  expect(lintAfter.overrides).toEqual([
    { repoRoot: root, command: ["yarn", "lint"] },
    { repoRoot: `${root}/apps/web`, command: ["yarn", "workspace", "web", "lint"] },
  ]);
  expect((await api<CommandView>(daemon, "/api/workflow-commands/test")).overrides).toEqual([]);
  const rows = new Map((await api<TestingSettingsView[]>(daemon, "/api/testing-settings")).map((view) => [view.repoRoot, view.settings]));
  expect(rows.get(`${root}/apps/web`)).toEqual({ tests: { patterns: ["src/**/*.test.ts"], smokeSet: ["smoke/*.ts"] } });
  expect(rows.get(`${root}/apps/legacy`)).toEqual({ tests: { includeImporters: false } });

  // The open lint page shows the imported rules over the event stream.
  const rules = dashboard.locator(".wf-command-rules");
  await expect(rules).toContainText("yarn workspace web lint");
  await shoot(dashboard, "import-applied");

  // The affected-tests page's testing settings section lists the imported folder's row.
  await dashboard.getByRole("complementary", { name: "Command library" }).getByRole("button", { name: /^affected-tests/ }).click();
  await expect(dashboard.getByRole("heading", { name: "affected-tests", exact: true })).toBeVisible();
  const section = dashboard.getByRole("region", { name: "Testing settings" });
  const webRow = section.getByRole("group", { name: /^Testing settings for .*\/apps\/web$/ });
  await expect(webRow.getByLabel("Test patterns")).toHaveValue("src/**/*.test.ts");

  // Export reads the repository back out as a document.
  await dashboard.getByRole("button", { name: "Export document" }).click();
  const exporter = dashboard.getByRole("dialog", { name: "Export a Command document" });
  await expect(exporter).toBeVisible();
  await expectContentClearsBorder(exporter);
  await chooseRepository(exporter, daemon.repo);
  await exporter.getByRole("button", { name: "Export", exact: true }).click();
  const exportedBox = exporter.getByLabel(/^Exported document for /);
  await expect(exportedBox).toBeVisible();
  const exported = JSON.parse(await exportedBox.inputValue()) as unknown;
  expect(exported).toEqual({
    version: 1,
    commands: {
      lint: [{ path: "", argv: ["yarn", "lint"] }, { path: "apps/web", argv: ["yarn", "workspace", "web", "lint"] }],
      "affected-tests": [{ path: "apps/web", argv: AFFECTED }],
    },
    testing: [
      { path: "apps/legacy", settings: { tests: { includeImporters: false } } },
      { path: "apps/web", settings: { tests: { patterns: ["src/**/*.test.ts"], smokeSet: ["smoke/*.ts"] } } },
    ],
  });
  await expectContentClearsBorder(exporter);
  await shoot(dashboard, "export");
  await exporter.getByRole("button", { name: "Done" }).click();
  await expect(exporter).toBeHidden();

  // Importing the exported document, uploaded as a file, changes nothing.
  const revisions = {
    lint: (await api<CommandView>(daemon, "/api/workflow-commands/lint")).revision,
    testing: (await api<TestingSettingsView[]>(daemon, "/api/testing-settings")).map((view) => view.revision),
  };
  await dashboard.getByRole("button", { name: "Import document" }).click();
  const again = dashboard.getByRole("dialog", { name: "Import a Command document" });
  await chooseRepository(again, daemon.repo);
  await again.getByLabel("Command document file").setInputFiles({
    name: "commands.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(exported, null, 2)),
  });
  await expect(again.getByLabel("Document", { exact: true })).toHaveValue(/"version": 1/);
  await again.getByRole("button", { name: "Preview" }).click();
  await expect(again.getByRole("region", { name: "Preview" })).toContainText("No changes");
  await expect(again.getByRole("region", { name: "Preview" }))
    .toContainText("Nothing to apply: this repository already matches the document.");
  await expect(again.getByRole("button", { name: /^Apply / })).toBeDisabled();
  await shoot(dashboard, "round-trip-no-changes");
  await again.getByRole("button", { name: "Cancel" }).click();
  expect({
    lint: (await api<CommandView>(daemon, "/api/workflow-commands/lint")).revision,
    testing: (await api<TestingSettingsView[]>(daemon, "/api/testing-settings")).map((view) => view.revision),
  }).toEqual(revisions);
});
