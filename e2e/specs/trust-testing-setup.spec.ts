import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { Page } from "@playwright/test";
import type { Task } from "../../src/shared/types.ts";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

const EVIDENCE = artifactsDir("trust-testing-setup");

/**
 * "Set up flake-aware testing" on a Trust repository row.
 *
 * Driven through the browser because the claim spans every layer: the row's control has to reach
 * `POST /api/repositories/testing-setup`, the daemon has to refuse before creating anything while
 * the testing-setup skill is off and show that sentence on the row, and with the skill on it has
 * to file and launch the task whose intent invokes the skill. The launch runs the fake agent, so
 * no model tokens are spent.
 */

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

test("the Trust row offers the action, and refuses it on the row while the skill is off", async ({
  dashboard,
  daemon,
}) => {
  await setSkill(dashboard, daemon.baseURL, false);
  await openTrustWith(dashboard, daemon.repo);

  const action = dashboard.getByRole("button", { name: `Set up flake-aware testing for ${daemon.repo}` });
  await expect(action).toBeVisible();
  await expect(action).toHaveText("Set up testing");

  const started = dashboard.waitForResponse((r) => r.url().endsWith("/api/repositories/testing-setup"));
  await action.click();
  expect((await started).status()).toBe(409);

  const refusal = dashboard.getByRole("alert").filter({ hasText: /Enable Skills and the testing-setup skill/ });
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText("cannot load the procedure its intent names");
  expect(await setupTasks(dashboard, daemon.baseURL)).toEqual([]);
  await shoot(dashboard, "01-refused-skill-off");
});

test("with the skill on, the action starts the testing-setup task", async ({ dashboard, daemon }) => {
  await setSkill(dashboard, daemon.baseURL, true);
  await openTrustWith(dashboard, daemon.repo);

  const started = dashboard.waitForResponse((r) => r.url().endsWith("/api/repositories/testing-setup"));
  await dashboard.getByRole("button", { name: `Set up flake-aware testing for ${daemon.repo}` }).click();
  expect((await started).status()).toBe(200);

  await expect(
    dashboard.getByRole("status").filter({ hasText: /Testing setup (started|is in the backlog)/ }),
  ).toBeVisible();

  const [task, ...rest] = await setupTasks(dashboard, daemon.baseURL);
  expect(rest).toEqual([]);
  expect(task).toMatchObject({ kind: "ship", repoRoot: daemon.repo, workflowId: null });
  expect(task!.intent).toContain("Invoke the testing-setup skill and follow it");
  expect(task!.title).toBe(`Set up flake-aware testing: ${basename(daemon.repo)}`);
  await shoot(dashboard, "02-started-skill-on");

  // A second click while that task is open is refused on the row; no second agent starts.
  const again = dashboard.waitForResponse((r) => r.url().endsWith("/api/repositories/testing-setup"));
  await dashboard.getByRole("button", { name: `Set up flake-aware testing for ${daemon.repo}` }).click();
  expect((await again).status()).toBe(409);
  await expect(
    dashboard.getByRole("alert").filter({ hasText: /A testing setup task for this repository is already/ }),
  ).toBeVisible();
  expect(await setupTasks(dashboard, daemon.baseURL)).toHaveLength(1);
  await shoot(dashboard, "04-duplicate-refused");
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
  await expect(dashboard.getByRole("button", { name: `Set up flake-aware testing for ${other}` })).toBeVisible();

  // Hold the first row's request open until the second row has been used.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await dashboard.route("**/api/repositories/testing-setup", async (route) => {
    const body = route.request().postDataJSON() as { repoRoot: string };
    if (body.repoRoot === daemon.repo) await held;
    await route.continue();
  });

  const first = dashboard.getByRole("button", { name: `Set up flake-aware testing for ${daemon.repo}` });
  const second = dashboard.getByRole("button", { name: `Set up flake-aware testing for ${other}` });
  await first.click();
  await expect(first).toBeDisabled();
  await expect(second).toBeEnabled();

  await second.click();
  const rows = dashboard.getByRole("table", { name: "Repository trust grants" });
  const refusals = rows.getByRole("alert").filter({ hasText: /Enable Skills and the testing-setup skill/ });
  await expect(refusals).toHaveCount(1);
  await expect(first).toBeDisabled();
  await expect(rows.getByText("Starting…")).toHaveCount(1);

  release();
  await expect(refusals).toHaveCount(2);
  await expect(first).toBeEnabled();
  await shoot(dashboard, "03-rows-independent");
  rmSync(other, { recursive: true, force: true });
});
