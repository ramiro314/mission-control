import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { Locator, Page } from "@playwright/test";
import type { Task } from "../../src/shared/types.ts";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

const EVIDENCE = artifactsDir("trust-testing-setup");

/**
 * "Set up flake-aware testing" on a Trust repository row.
 *
 * Driven through the browser because the claim spans every layer: the row's control has to open
 * the committed-or-stored choice, the choice has to reach `POST /api/repositories/testing-setup`
 * with the mode the operator picked, the daemon has to refuse before creating anything while the
 * testing-setup skill is off and show that sentence on the row, and with the skill on it has to
 * file and launch the task whose intent invokes the skill in that mode. The launch runs the fake
 * agent, so no model tokens are spent.
 */

const COMMITTED = "Commit a testing file";
const STORED = "Store settings in Mission Control";

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  const original = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
  await page.setViewportSize(original);
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/trust-testing-setup/${name}.png`);
}

async function openTrustWith(page: Page, repo: string): Promise<void> {
  await page.goto(`${page.url().split("#")[0]}#/settings/trust`);
  await expect(page.getByText(/Every grant that lets Mission Control act outside/).first()).toBeVisible();
  await page.getByRole("combobox", { name: /search repos or type a path/i }).fill(repo);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Repository trust grants" }).locator(".trust-repo-path"),
  ).toHaveText(basename(repo));
}

async function setupTasks(page: Page, baseURL: string): Promise<Task[]> {
  const all = (await (await page.request.get(`${baseURL}/api/tasks`)).json()) as Task[];
  return all.filter((task) => task.labels.includes("testing-setup"));
}

async function setSkill(page: Page, baseURL: string, on: boolean): Promise<void> {
  const res = await page.request.put(`${baseURL}/api/skills/config`, {
    data: { enabled: true, skills: { "testing-setup": on } },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

function setupAction(page: Page, repo: string): Locator {
  return page.getByRole("button", { name: `Set up flake-aware testing for ${repo}` });
}

/** Open one row's choice and return it; nothing has been sent yet. */
async function openChoice(page: Page, repo: string): Promise<Locator> {
  await setupAction(page, repo).click();
  const choice = page.getByRole("group", { name: `Testing setup for ${repo}` });
  await expect(choice).toBeVisible();
  await expect(setupAction(page, repo)).toHaveAttribute("aria-expanded", "true");
  return choice;
}

/** Pick a mode in an open choice and start it. */
async function chooseAndStart(choice: Locator, label: string): Promise<void> {
  await choice.getByRole("radio", { name: label }).check();
  await choice.getByRole("button", { name: "Start testing setup" }).click();
}

test("the Trust row offers the choice, and refuses the start on the row while the skill is off", async ({
  dashboard,
  daemon,
}) => {
  await setSkill(dashboard, daemon.baseURL, false);
  await openTrustWith(dashboard, daemon.repo);

  const action = setupAction(dashboard, daemon.repo);
  await expect(action).toBeVisible();
  await expect(action).toHaveText("Set up testing");

  // The first click sends nothing: it asks where the settings live, with neither preselected.
  let sent = 0;
  dashboard.on("request", (r) => {
    if (r.url().endsWith("/api/repositories/testing-setup")) sent += 1;
  });
  const choice = await openChoice(dashboard, daemon.repo);
  await expect(choice).toContainText("Where should this repository's testing settings live?");
  await expect(choice.getByRole("radio", { name: COMMITTED })).not.toBeChecked();
  await expect(choice.getByRole("radio", { name: STORED })).not.toBeChecked();
  await expect(choice.getByRole("radio", { name: STORED })).toHaveAccessibleDescription(
    /will not commit a testing file\. The agent changes no file/,
  );
  await expect(choice.getByRole("button", { name: "Start testing setup" })).toBeDisabled();
  await shoot(dashboard, "00-choice-open");

  // Cancel closes it without starting anything.
  await choice.getByRole("button", { name: "Cancel" }).click();
  await expect(choice).toBeHidden();
  await expect(action).toHaveAttribute("aria-expanded", "false");
  expect(sent).toBe(0);

  const reopened = await openChoice(dashboard, daemon.repo);
  const started = dashboard.waitForResponse((r) => r.url().endsWith("/api/repositories/testing-setup"));
  await chooseAndStart(reopened, COMMITTED);
  const response = await started;
  expect(response.status()).toBe(409);
  expect(response.request().postDataJSON()).toEqual({ repoRoot: daemon.repo, mode: "committed" });
  await expect(reopened).toBeHidden();

  const refusal = dashboard.getByRole("alert").filter({ hasText: /Enable Skills and the testing-setup skill/ });
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText("cannot load the procedure its intent names");
  expect(await setupTasks(dashboard, daemon.baseURL)).toEqual([]);
  await shoot(dashboard, "01-refused-skill-off");
});

test("with the skill on, the committed choice starts the testing-setup task that commits", async ({ dashboard, daemon }) => {
  await setSkill(dashboard, daemon.baseURL, true);
  await openTrustWith(dashboard, daemon.repo);

  const started = dashboard.waitForResponse((r) => r.url().endsWith("/api/repositories/testing-setup"));
  await chooseAndStart(await openChoice(dashboard, daemon.repo), COMMITTED);
  const response = await started;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({ repoRoot: daemon.repo, mode: "committed" });

  await expect(
    dashboard.getByRole("status").filter({ hasText: /Testing setup (started\. Its agent audits|is in the backlog)/ }),
  ).toBeVisible();

  const [task, ...rest] = await setupTasks(dashboard, daemon.baseURL);
  expect(rest).toEqual([]);
  expect(task).toMatchObject({ kind: "ship", repoRoot: daemon.repo, workflowId: null });
  expect(task!.labels).toEqual(["testing-setup"]);
  expect(task!.intent).toContain("Testing setup mode: committed.");
  expect(task!.intent).toContain("Invoke the testing-setup skill and follow it");
  expect(task!.intent).toContain("set_affected_tests_command");
  expect(task!.intent).not.toContain("propose_command_document");
  expect(task!.title).toBe(`Set up flake-aware testing: ${basename(daemon.repo)}`);
  await shoot(dashboard, "02-started-skill-on");

  // A second start while that task is open is refused on the row, whichever mode it asks for;
  // no second agent starts.
  const again = dashboard.waitForResponse((r) => r.url().endsWith("/api/repositories/testing-setup"));
  await chooseAndStart(await openChoice(dashboard, daemon.repo), STORED);
  expect((await again).status()).toBe(409);
  await expect(
    dashboard.getByRole("alert").filter({ hasText: /A testing setup task for this repository is already/ }),
  ).toBeVisible();
  expect(await setupTasks(dashboard, daemon.baseURL)).toHaveLength(1);
  await shoot(dashboard, "04-duplicate-refused");
});

test("the stored choice starts a setup that changes no file and proposes a Command document", async ({
  dashboard,
  daemon,
}) => {
  await setSkill(dashboard, daemon.baseURL, true);
  await openTrustWith(dashboard, daemon.repo);

  const choice = await openChoice(dashboard, daemon.repo);
  await choice.getByRole("radio", { name: STORED }).check();
  await expect(choice.getByRole("radio", { name: STORED })).toBeChecked();
  await expect(choice.getByRole("button", { name: "Start testing setup" })).toBeEnabled();
  await shoot(dashboard, "05-stored-chosen");

  const started = dashboard.waitForResponse((r) => r.url().endsWith("/api/repositories/testing-setup"));
  await choice.getByRole("button", { name: "Start testing setup" }).click();
  const response = await started;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({ repoRoot: daemon.repo, mode: "stored" });

  await expect(
    dashboard.getByRole("status").filter({
      hasText: /Testing setup started with stored settings\.[\s\S]*apply it from Library › Commands|Testing setup is in the backlog/,
    }),
  ).toBeVisible();

  const [task, ...rest] = await setupTasks(dashboard, daemon.baseURL);
  expect(rest).toEqual([]);
  expect(task).toMatchObject({ kind: "ship", repoRoot: daemon.repo, workflowId: null });
  expect(task!.labels).toEqual(["testing-setup", "testing-setup:stored"]);
  expect(task!.title).toBe(`Set up flake-aware testing (stored): ${basename(daemon.repo)}`);
  expect(task!.intent).toContain("Testing setup mode: stored.");
  expect(task!.intent).toContain("Invoke the testing-setup skill and follow its stored mode");
  expect(task!.intent).toContain("change no file in this repository and make no commit");
  expect(task!.intent).toContain("Submit the result only with propose_command_document");
  expect(task!.intent).toContain("Do not call set_affected_tests_command.");
  await shoot(dashboard, "06-stored-started");
});

test("a request in flight on one row leaves every other row's action usable and answered on its own row", async ({
  dashboard,
  daemon,
}) => {
  await setSkill(dashboard, daemon.baseURL, false);
  // A second real repository, so both rows resolve and stage.
  const other = realpathSync(mkdtempSync(join(tmpdir(), "mc-e2e-setup-other-")));
  execFileSync("git", ["-C", other, "init", "-q"]);
  await openTrustWith(dashboard, daemon.repo);
  await dashboard.getByRole("combobox", { name: /search repos or type a path/i }).fill(other);
  await dashboard.getByRole("button", { name: "Add", exact: true }).click();
  await expect(setupAction(dashboard, other)).toBeVisible();

  // Hold the first row's request open until the second row has been used.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await dashboard.route("**/api/repositories/testing-setup", async (route) => {
    const body = route.request().postDataJSON() as { repoRoot: string };
    if (body.repoRoot === daemon.repo) await held;
    await route.continue();
  });

  const first = setupAction(dashboard, daemon.repo);
  const second = setupAction(dashboard, other);
  await chooseAndStart(await openChoice(dashboard, daemon.repo), COMMITTED);
  await expect(first).toBeDisabled();
  await expect(second).toBeEnabled();
  // Mid-request: the first row reads "Starting…" with its action dimmed, the second is usable.
  await expect(dashboard.getByRole("status").filter({ hasText: "Starting…" })).toBeVisible();
  await shoot(dashboard, "03a-first-row-in-flight");

  await chooseAndStart(await openChoice(dashboard, other), STORED);
  const rows = dashboard.getByRole("table", { name: "Repository trust grants" });
  const refusals = rows.getByRole("alert").filter({ hasText: /Enable Skills and the testing-setup skill/ });
  await expect(refusals).toHaveCount(1);
  await expect(first).toBeDisabled();
  await expect(rows.getByText("Starting…")).toHaveCount(1);
  // Still mid-request on the first row, and the second row already has its own answer.
  await shoot(dashboard, "03b-second-row-answered-while-first-in-flight");

  release();
  await expect(refusals).toHaveCount(2);
  await expect(first).toBeEnabled();
  await shoot(dashboard, "03-rows-independent");
  rmSync(other, { recursive: true, force: true });
});
