import { mkdirSync, writeFileSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import type { Task } from "../../src/shared/types.ts";

/**
 * The two ways into shape that are not the dispatch form: "shape this" on a backlog card, and
 * a task source whose default kind is shape.
 *
 * "Shape this" is the ordinary kind edit followed by the ordinary dispatch, so what only a
 * browser can show is the chain: click -> POST /update (kind + Plan Validation) -> POST
 * /dispatch -> a live shape session -> the task row still carrying the issue it was swept
 * from. Every agent is the fake and every `gh` call is `FAKE_GH`, so no tokens are spent and
 * nothing reaches GitHub.
 */

const EVIDENCE = artifactsDir("shape-this");
const ISSUE_URL = "https://github.com/acme/demo/issues/17";
const BLOCKER_URL = "https://github.com/acme/infra/issues/99";

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/shape-this/${name}.png`);
}

/** One swept issue, labelled, with a blocker that already closed as completed. */
function upstream(daemon: DaemonHandle): void {
  writeFileSync(daemon.ghIssuesPath, JSON.stringify([
    {
      number: 17, title: "Rework the export pipeline", body: "Too big to ship in one go",
      url: ISSUE_URL, labels: [{ name: "needs-shaping" }], state: "OPEN", stateReason: "",
      blockedBy: { nodes: [{ number: 99, state: "CLOSED", title: "Provision the queue", url: BLOCKER_URL }], totalCount: 1 },
    },
    { number: 99, title: "Provision the queue", body: "", url: BLOCKER_URL, labels: [],
      discoverable: false, state: "CLOSED", stateReason: "COMPLETED" },
  ]));
}

async function putSources(page: Page, daemon: DaemonHandle, sources: Array<Record<string, unknown>>): Promise<void> {
  const res = await page.request.put(`${daemon.baseURL}/api/task-sources/config`, { data: { sources } });
  expect(res.ok(), await res.text()).toBe(true);
}

async function sweep(page: Page, daemon: DaemonHandle, id: string): Promise<void> {
  const res = await page.request.post(`${daemon.baseURL}/api/task-sources/${id}/sweep`);
  expect(res.ok(), await res.text()).toBe(true);
}

async function tasks(page: Page, daemon: DaemonHandle): Promise<Task[]> {
  return (await page.request.get(`${daemon.baseURL}/api/tasks`)).json();
}

async function setSkills(page: Page, daemon: DaemonHandle): Promise<void> {
  const res = await page.request.put(`${daemon.baseURL}/api/skills/config`, {
    data: { enabled: true, skills: { grill: true, "html-plans": true } },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

test("shape this converts a swept backlog task to shape and dispatches it, keeping its issue link", async ({
  page,
  daemon,
}) => {
  upstream(daemon);
  await putSources(page, daemon, [
    { id: "gh", kind: "github-issues", label: "Demo issues", repoRoot: daemon.repo, enabled: false,
      config: { repo: "acme/demo" } },
  ]);
  await setSkills(page, daemon);
  // Shape's review is Plan Validation, which Live delivery refuses on a repository nobody
  // allowlisted. Granted the way an operator grants it, so the dispatch is what is measured.
  expect((await page.request.put(`${daemon.baseURL}/api/workflows/config`, {
    data: { liveEnabled: true, repoAllowlist: [daemon.repo] },
  })).ok()).toBe(true);
  await page.request.put(`${daemon.baseURL}/api/ui/config`, { data: { layout: "board" } });
  await sweep(page, daemon, "gh");

  const [swept] = await tasks(page, daemon);
  expect(swept).toMatchObject({
    kind: "ship",
    status: "backlog",
    source: { sourceId: "gh", externalId: "acme/demo#17", url: ISSUE_URL },
  });
  expect(swept!.labels).toContain("needs-shaping");
  expect(swept!.dependencies).toMatchObject([{ type: "source", externalId: "acme/infra#99", state: "completed" }]);

  await page.goto(`${daemon.baseURL}/#/fleet`);
  const card = page.locator("section.board-backlog .bl-card").filter({ hasText: "Rework the export pipeline" });
  const shapeThis = card.getByRole("button", { name: "shape this" });
  await expect(shapeThis).toBeEnabled();
  await expect(card.locator(".bl-kind")).toHaveText("ship");
  await shoot(card, "01-backlog-card-offers-shape-this");

  // The existing routes, in order: the kind edit, then the dispatch.
  const edited = page.waitForRequest((r) => r.url().endsWith(`/api/tasks/${swept!.id}/update`));
  const dispatched = page.waitForRequest((r) => r.url().endsWith(`/api/tasks/${swept!.id}/dispatch`));
  await shapeThis.click();
  expect((await edited).postDataJSON()).toEqual({ kind: "shape", workflowId: "builtin-workflow:plan-validation" });
  await dispatched;
  await expect(card).toHaveCount(0, { timeout: 30_000 });

  const [converted] = await tasks(page, daemon);
  expect(converted).toMatchObject({
    id: swept!.id,
    kind: "shape",
    workflowId: "builtin-workflow:plan-validation",
    source: swept!.source,
    labels: swept!.labels,
    dependencies: swept!.dependencies,
  });
  expect(converted!.status).not.toBe("backlog");

  // A live session, handed the shape contract (the fake agent echoes its prompt).
  await shoot(page, "02-shape-session-launched");
  // The console layout, where the session rail opens its conversation.
  await page.request.put(`${daemon.baseURL}/api/ui/config`, { data: { layout: "console" } });
  await page.reload();
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = page.locator(".console-detail");
  await expect(detail).toContainText("Mission Control shape", { timeout: 30_000 });
  await expect(detail.locator(".task-kind")).toHaveText("shape");
});

test("a shape card offers no shape this", async ({ page, daemon }) => {
  const res = await page.request.post(`${daemon.baseURL}/api/tasks`, {
    data: { repoRoot: daemon.repo, intent: "Already a shape task", kind: "shape", backlog: true },
  });
  expect(res.ok(), await res.text()).toBe(true);
  await page.request.put(`${daemon.baseURL}/api/ui/config`, { data: { layout: "board" } });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const card = page.locator("section.board-backlog .bl-card").filter({ hasText: "Already a shape task" });
  await expect(card.getByRole("button", { name: "launch new agent" })).toBeVisible();
  await expect(card.getByRole("button", { name: "shape this" })).toHaveCount(0);
});

test("every task source kind can file its items as shape tasks", async ({ page, daemon }) => {
  upstream(daemon);
  await putSources(page, daemon, [
    { id: "gh", kind: "github-issues", label: "Demo issues", repoRoot: daemon.repo, enabled: false,
      config: { repo: "acme/demo" } },
    { id: "jira", kind: "jira", label: "Platform queue", repoRoot: daemon.repo, enabled: false },
  ]);

  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
  // One editor at a time, opened from the directory. Each kind's picker offers shape, and each
  // takes it: the saved default is read back from the daemon, and the editor is captured.
  const kind = page.getByRole("combobox", { name: "Kind", exact: true });
  for (const [id, name] of [["jira", "Platform queue"], ["gh", "Demo issues"]] as const) {
    await page.locator("button.ts-directory-row").filter({ hasText: name }).click();
    await expect(page.locator("button.ts-directory-row").filter({ hasText: name })).toHaveAttribute("aria-current", "true");
    await expect(kind.locator("option[value=shape]")).toHaveText("shape - shape work into a reviewed plan");
    await kind.selectOption("shape");
    await expect.poll(async () => {
      const config = await (await page.request.get(`${daemon.baseURL}/api/task-sources/config`)).json() as {
        sources: Array<{ id: string; defaults: { kind: string } }>;
      };
      return config.sources.find((s) => s.id === id)?.defaults.kind;
    }).toBe("shape");
    await expect(kind).toHaveValue("shape");
    await kind.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await shoot(page, `03-${id}-source-kind-shape`);
  }

  // The GitHub source now files shape tasks.
  await sweep(page, daemon, "gh");
  const filed = await tasks(page, daemon);
  expect(filed).toMatchObject([{
    title: "Rework the export pipeline",
    kind: "shape",
    status: "backlog",
    source: { sourceId: "gh", externalId: "acme/demo#17" },
  }]);
});

test("the Line's backlog drawer offers the same shape this, through the same two routes", async ({
  page,
  daemon,
}) => {
  upstream(daemon);
  await putSources(page, daemon, [
    { id: "gh", kind: "github-issues", label: "Demo issues", repoRoot: daemon.repo, enabled: false,
      config: { repo: "acme/demo" } },
  ]);
  await setSkills(page, daemon);
  expect((await page.request.put(`${daemon.baseURL}/api/workflows/config`, {
    data: { liveEnabled: true, repoAllowlist: [daemon.repo] },
  })).ok()).toBe(true);
  await sweep(page, daemon, "gh");
  const [swept] = await tasks(page, daemon);

  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.getByRole("navigation", { name: "The Line" }).getByRole("button", { name: /^Backlog,/ }).click();
  const drawer = page.getByRole("region", { name: "Backlog drawer" });
  const row = drawer.locator("li.line-bl-row").filter({ hasText: "Rework the export pipeline" });
  const shapeThis = row.getByRole("button", { name: "Shape this" });
  await expect(shapeThis).toBeEnabled();
  await shoot(drawer, "04-line-drawer-offers-shape-this");

  const edited = page.waitForRequest((r) => r.url().endsWith(`/api/tasks/${swept!.id}/update`));
  const dispatched = page.waitForRequest((r) => r.url().endsWith(`/api/tasks/${swept!.id}/dispatch`));
  await shapeThis.click();
  expect((await edited).postDataJSON()).toEqual({ kind: "shape", workflowId: "builtin-workflow:plan-validation" });
  await dispatched;
  await expect(row).toHaveCount(0, { timeout: 30_000 });

  const [converted] = await tasks(page, daemon);
  expect(converted).toMatchObject({ kind: "shape", source: swept!.source, labels: swept!.labels });
  expect(converted!.status).not.toBe("backlog");
});

test("a refused dispatch leaves the task converted to shape in the backlog and shows the refusal", async ({
  page,
  daemon,
}) => {
  upstream(daemon);
  await putSources(page, daemon, [
    { id: "gh", kind: "github-issues", label: "Demo issues", repoRoot: daemon.repo, enabled: false,
      config: { repo: "acme/demo" } },
  ]);
  // Grill off: the kind edit is accepted, and the shape dispatch is refused naming the toggle.
  expect((await page.request.put(`${daemon.baseURL}/api/skills/config`, {
    data: { enabled: true, skills: { grill: false, "html-plans": true } },
  })).ok()).toBe(true);
  // Live delivery granted, so the refusal is the Grill one and not the workflow's.
  expect((await page.request.put(`${daemon.baseURL}/api/workflows/config`, {
    data: { liveEnabled: true, repoAllowlist: [daemon.repo] },
  })).ok()).toBe(true);
  await page.request.put(`${daemon.baseURL}/api/ui/config`, { data: { layout: "board" } });
  await sweep(page, daemon, "gh");
  const [swept] = await tasks(page, daemon);

  await page.goto(`${daemon.baseURL}/#/fleet`);
  const card = page.locator("section.board-backlog .bl-card").filter({ hasText: "Rework the export pipeline" });
  const dispatched = page.waitForResponse((r) => r.url().endsWith(`/api/tasks/${swept!.id}/dispatch`));
  await card.getByRole("button", { name: "shape this" }).click();
  expect((await dispatched).ok()).toBe(false);

  // The refusal is surfaced, and the card stays, now reading shape, with no button to shape it again.
  await expect(page.getByText(/Enable Skills and the grill skill/).first()).toBeVisible();
  await expect(card.locator(".bl-kind")).toHaveText("shape");
  await expect(card.getByRole("button", { name: "shape this" })).toHaveCount(0);
  await shoot(page, "05-refused-dispatch-left-shape");

  const [after] = await tasks(page, daemon);
  expect(after).toMatchObject({
    id: swept!.id,
    kind: "shape",
    status: "backlog",
    source: swept!.source,
    labels: swept!.labels,
    dependencies: swept!.dependencies,
  });
});

test("a task waiting on a declared dependency cannot be shaped from either layout", async ({ page, daemon }) => {
  const create = async (data: Record<string, unknown>): Promise<Task> => {
    const res = await page.request.post(`${daemon.baseURL}/api/tasks`, {
      data: { repoRoot: daemon.repo, backlog: true, ...data },
    });
    expect(res.ok(), await res.text()).toBe(true);
    return res.json();
  };
  const base = await create({ intent: "Lay the base", title: "Lay the base" });
  await create({ intent: "Build on the base", title: "Build on the base", dependencies: [{ type: "task", taskId: base.id }] });
  await page.request.put(`${daemon.baseURL}/api/ui/config`, { data: { layout: "board" } });
  await page.goto(`${daemon.baseURL}/#/fleet`);

  // Board: the waiting card's button is present but disabled; the free card's is enabled.
  const cards = page.locator("section.board-backlog .bl-card");
  const card = (title: string): Locator =>
    cards.filter({ has: page.getByRole("button", { name: title, exact: true }) });
  const waiting = card("Build on the base");
  await expect(waiting.getByRole("button", { name: "waiting for dependencies" })).toBeDisabled();
  await expect(waiting.getByRole("button", { name: "shape this" })).toBeDisabled();
  await expect(card("Lay the base").getByRole("button", { name: "shape this" })).toBeEnabled();

  // Line drawer: the blocked row carries neither Launch now nor Shape this.
  await page.getByRole("navigation", { name: "The Line" }).getByRole("button", { name: /^Backlog,/ }).click();
  const drawer = page.getByRole("region", { name: "Backlog drawer" });
  const rows = drawer.locator("li.line-bl-row");
  const blockedRow = rows.filter({ hasText: "Build on the base" });
  await expect(blockedRow).toBeVisible();
  await expect(blockedRow.getByRole("button", { name: "Shape this" })).toHaveCount(0);
  await expect(rows.filter({ has: page.getByRole("button", { name: "Lay the base", exact: true }) })
    .getByRole("button", { name: "Shape this" })).toBeVisible();
  await shoot(drawer, "06-blocked-row-has-no-shape-this");
});
