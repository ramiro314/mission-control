import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

/**
 * A Command document an agent PROPOSES, end to end. A dispatched session calls
 * `propose_command_document` - here, its HTTP route, which is exactly the POST
 * `src/mcp/server.ts` makes - for its own task repository. Nothing is written: the proposal shows
 * as an item in the attention inbox and as a banner on that repository in Library › Commands, and
 * both lead to the import preview, where the operator applies it (writing the rows and clearing
 * the proposal) or dismisses it (clearing it and writing nothing).
 *
 * The only stub is the model: the dispatch launches the fake agent every binary is redirected at
 * (`e2e/fixtures/fake-agents.ts`), so no tokens are spent.
 */

const EVIDENCE = artifactsDir("library-command-document-proposals");

interface CommandView {
  slot: string;
  overrides: Array<{ repoRoot: string; command: string[] }>;
}

interface Proposed {
  proposal: { id: string; repoRoot: string };
  replaced: string | null;
  preview: { problems: string[] };
}

const DOCUMENT = {
  version: 1,
  commands: { lint: [{ path: "apps/web", argv: ["yarn", "workspace", "web", "lint"] }] },
  testing: [{ path: "apps/web", settings: { tests: { patterns: ["src/**/*.test.ts"] } } }],
};

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/library-command-document-proposals/${name}.png`);
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field; Escape closes the list, not the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("work out this monorepo's Commands");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(1);
}

/** Propose a document from the dispatched session, the way its MCP child does: bound by its cwd. */
async function propose(daemon: DaemonHandle, document: unknown): Promise<Proposed> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  let cwd: string | null = null;
  await expect
    .poll(async () => {
      const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{ cwd: string | null }>;
      cwd = sessions[0]?.cwd ?? null;
      return cwd;
    }, { message: "the dispatched session is on the fleet with a checkout to bind the proposal to" })
    .toBeTruthy();
  const res = await fetch(`${daemon.baseURL}/mcp/command-documents/proposals`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ env: {}, cwd, document }),
  });
  expect(res.status, `the proposal was accepted: ${await res.clone().text()}`).toBe(200);
  return (await res.json()) as Proposed;
}

async function lintOverrides(daemon: DaemonHandle): Promise<CommandView["overrides"]> {
  return ((await (await fetch(`${daemon.baseURL}/api/workflow-commands/lint`)).json()) as CommandView).overrides;
}

test("a proposed Command document reaches the inbox and Library › Commands, and is applied or dismissed from the preview", async ({
  dashboard,
  daemon,
}) => {
  // The folder the document names exists in the main checkout, so the preview has no problem.
  mkdirSync(join(daemon.repo, "apps", "web"), { recursive: true });
  await dispatch(dashboard, daemon);

  const first = await propose(daemon, DOCUMENT);
  expect(first.preview.problems).toEqual([]);
  const repoRoot = first.proposal.repoRoot;
  expect(await lintOverrides(daemon), "a proposal writes no live row").toEqual([]);

  // The attention item: listed under its own section, and it leads to the preview.
  const opener = dashboard.locator("button.pulse-seg", { hasText: "to answer" });
  await expect(opener).toBeVisible();
  await opener.click();
  const inbox = dashboard.getByRole("dialog", { name: "Attention inbox" });
  await expect(inbox.getByRole("heading", { name: "Proposed Command documents" })).toBeVisible();
  const item = inbox.getByRole("region", { name: `Proposed Command document for ${repoRoot}` });
  await expect(item).toContainText(/work out this monorepo's commands/i);
  await expect(item).toContainText("(2 entries)");
  await shoot(dashboard, "inbox-item");
  await item.getByRole("button", { name: "Review proposal" }).click();
  await expect(inbox).toBeHidden();

  const review = dashboard.getByRole("dialog", { name: "Review a proposed Command document" });
  await expect(review).toBeVisible();
  await expect(review).toContainText(/Proposed by the task "work out this monorepo's commands"/i);
  // The preview is computed on open, against what is stored, and nothing is written yet.
  await expect(review.getByRole("region", { name: "Preview" })).toContainText("2 to add");
  await expect(review.getByRole("list", { name: "lint changes" })).toContainText("Add apps/web yarn workspace web lint");
  await expect(review.getByRole("list", { name: "Testing settings changes" })).toContainText("Add apps/web patterns: src/**/*.test.ts");
  // What is reviewed is what was proposed: the document is read-only and nothing can replace it.
  await expect(review.getByLabel("Document", { exact: true })).toHaveAttribute("readonly", "");
  await expect(review.getByRole("button", { name: "Upload .json" })).toHaveCount(0);
  await expect(review.getByRole("combobox", { name: "Repository" })).toBeDisabled();
  await expectContentClearsBorder(review);
  await shoot(dashboard, "review-preview");

  // Later keeps it pending: the banner on that repository in Library › Commands is the other door.
  await review.getByRole("button", { name: "Later" }).click();
  await expect(review).toBeHidden();
  const banner = dashboard.getByRole("listitem", { name: `Proposed Command document for ${repoRoot}` });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("proposed 2 entries for this repository's Commands and testing settings");
  await shoot(dashboard, "library-banner");
  expect(await lintOverrides(daemon)).toEqual([]);

  // Applying from the banner's preview writes the rows and clears the proposal everywhere.
  await banner.getByRole("button", { name: "Review proposal" }).click();
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: "Apply 2 changes" }).click();
  await expect(review).toBeHidden();
  await expect(dashboard.getByRole("status").filter({ hasText: `Applied 2 changes to ${repoRoot}.` })).toBeVisible();
  await expect(banner).toHaveCount(0);
  expect(await lintOverrides(daemon)).toEqual([{ repoRoot: `${repoRoot}/apps/web`, command: ["yarn", "workspace", "web", "lint"] }]);
  await shoot(dashboard, "applied");

  // A second proposal, dismissed: it clears and nothing changes.
  const second = await propose(daemon, {
    version: 1,
    commands: { lint: [{ path: "apps/web", remove: true }] },
  });
  expect(second.replaced).toBeNull();
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "Review proposal" }).click();
  await expect(review.getByRole("list", { name: "lint changes" })).toContainText("Remove apps/web");
  await review.getByRole("button", { name: "Dismiss proposal" }).click();
  await expect(review).toBeHidden();
  await expect(dashboard.getByRole("status").filter({ hasText: "Dismissed the proposed document" })).toBeVisible();
  await expect(banner).toHaveCount(0);
  expect(await lintOverrides(daemon), "a dismissed proposal writes nothing").toEqual([
    { repoRoot: `${repoRoot}/apps/web`, command: ["yarn", "workspace", "web", "lint"] },
  ]);

  // The inbox no longer lists it. Its opener is drawn only while something is owed, and the fake
  // session may or may not be owed an answer of its own, so the section is checked when it opens.
  if ((await opener.count()) > 0) {
    await opener.click();
    await expect(inbox).toBeVisible();
    await expect(inbox.getByRole("heading", { name: "Proposed Command documents" })).toHaveCount(0);
  }
});

test("a proposal replaced while its preview is open says so, still applies what was reviewed, and leaves the newer one pending", async ({
  dashboard,
  daemon,
}) => {
  mkdirSync(join(daemon.repo, "apps", "web"), { recursive: true });
  await dispatch(dashboard, daemon);
  const reviewed = await propose(daemon, DOCUMENT);
  const repoRoot = reviewed.proposal.repoRoot;

  await dashboard.goto(`${daemon.baseURL}/#/library/commands/lint`);
  const banner = dashboard.getByRole("listitem", { name: `Proposed Command document for ${repoRoot}` });
  await banner.getByRole("button", { name: "Review proposal" }).click();
  const review = dashboard.getByRole("dialog", { name: "Review a proposed Command document" });
  await expect(review.getByRole("region", { name: "Preview" })).toContainText("2 to add");
  const notice = review.getByRole("status").filter({ hasText: "no longer the repository's pending one" });
  await expect(notice).toHaveCount(0);
  await expect(review.getByRole("button", { name: "Dismiss proposal" })).toBeEnabled();

  // The agent proposes again while the operator is reviewing the first document.
  const newer = await propose(daemon, { version: 1, commands: { test: [{ path: "", argv: ["yarn", "test"] }] } });
  expect(newer.replaced).toBe(reviewed.proposal.id);

  // The open preview stays on what the operator was reading, and says it has been replaced.
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Applying it still writes exactly what this preview lists.");
  await expect(review.getByRole("button", { name: "Dismiss proposal" })).toBeDisabled();
  await expect(review.getByRole("list", { name: "lint changes" })).toContainText("Add apps/web yarn workspace web lint");
  await shoot(dashboard, "replaced-while-reviewing");

  // Applying writes the reviewed document, not the newer one, and the newer one stays pending.
  await review.getByRole("button", { name: "Apply 2 changes" }).click();
  await expect(review).toBeHidden();
  await expect(dashboard.getByRole("status").filter({ hasText: `Applied 2 changes to ${repoRoot}.` })).toBeVisible();
  expect(await lintOverrides(daemon)).toEqual([{ repoRoot: `${repoRoot}/apps/web`, command: ["yarn", "workspace", "web", "lint"] }]);
  const testSlot = (await (await fetch(`${daemon.baseURL}/api/workflow-commands/test`)).json()) as CommandView;
  expect(testSlot.overrides, "the newer proposal was not applied").toEqual([]);
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("proposed 1 entry for this repository's Commands and testing settings");

  // The banner now opens the newer proposal.
  await banner.getByRole("button", { name: "Review proposal" }).click();
  await expect(review.getByRole("list", { name: "test changes" })).toContainText("Add the repository root yarn test");
  await expect(notice).toHaveCount(0);
});
