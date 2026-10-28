import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { StorageView } from "../../src/shared/storage-health.ts";
import type { WorktreeInventory } from "../../src/shared/worktrees.ts";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

/**
 * Worktree reclaim, as the operator meets it: what Storage lists about a tree, and where its fix
 * lives on the Worktrees page.
 *
 * Stale live leases: a slot whose owner is live but whose checkout has had no Git-visible change
 * for `staleLeaseDays` is flagged, never reclaimed. The lease, its probe and its activity clock
 * are all real; the one seeded fact is the clock's age, moved back five days in the daemon's own
 * record after its first real probe, because nothing here can wait out a day. No agent is
 * launched, so no model tokens are spent.
 *
 * Dirty settled trees: a restart that settles a task reclaims a clean tree at once, and keeps a
 * tree holding work for its 30-day window, listed in Storage only. The task, its native slot,
 * the uncommitted file, the Kill and the restart are all real, through the fake agents.
 */

const EVIDENCE = artifactsDir("worktree-reclaim");
const DAY_MS = 24 * 60 * 60 * 1000;

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/worktree-reclaim/${name}.png`);
}

type LeaseClock = Record<string, { slotId: string; digest: string; changedAt: number }>;

function leaseClock(daemon: DaemonHandle): LeaseClock {
  return withDaemonDb(daemon, (db) => {
    const row = db.prepare("SELECT value FROM app_config WHERE key = 'worktrees.leaseActivity'").get() as
      | { value: string }
      | undefined;
    return row ? JSON.parse(row.value) as LeaseClock : {};
  });
}

test("a live lease quiet past staleLeaseDays shows a stale chip and a Storage-only problem, and a higher threshold clears both", async ({
  dashboard,
  daemon,
}) => {
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "quiet lease" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };

  // Acquiring publishes a pool change, which starts the lease's clock with a real probe.
  await expect.poll(() => leaseClock(daemon)[lease.leaseId]?.digest ?? null).not.toBeNull();
  const clock = leaseClock(daemon);
  const slotId = clock[lease.leaseId]!.slotId;
  const quietSince = Date.now() - 5 * DAY_MS;
  withDaemonDb(daemon, (db) => {
    db.prepare("UPDATE app_config SET value = ? WHERE key = 'worktrees.leaseActivity'").run(JSON.stringify({
      ...clock,
      [lease.leaseId]: { ...clock[lease.leaseId]!, changedAt: quietSince },
    }));
  });

  const inventory = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
  const ordinal = inventory.repositories.flatMap((pool) => pool.slots).find((slot) => slot.id === slotId)!.ordinal;

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const threshold = dashboard.getByLabel("Stale lease threshold in days");
  await expect(threshold).toHaveValue("7");
  const disclosure = dashboard.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const card = dashboard.getByRole("article", { name: `Slot ${ordinal}` });
  const staleChip = card.getByText("stale", { exact: true });
  await expect(card).toContainText("leased");
  await expect(staleChip).toHaveCount(0);

  // The threshold saves on blur or Enter, not per keystroke: an uncommitted value reaches nothing,
  // and an emptied field snaps back to the saved value instead of being sent as 0.
  const savedDays = async () => ((await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees/config`)).json()) as {
    config: { staleLeaseDays: number };
  }).config.staleLeaseDays;
  await threshold.fill("1");
  expect(await savedDays()).toBe(7);
  await expect(staleChip).toHaveCount(0);
  await threshold.fill("");
  await threshold.blur();
  await expect(threshold).toHaveValue("7");
  expect(await savedDays()).toBe(7);

  // Five quiet days against a threshold of three: flagged.
  await threshold.fill("3");
  await threshold.press("Enter");
  await expect(staleChip).toBeVisible();
  await shoot(dashboard, "01-stale-chip");

  // The threshold is stored, so a fresh load reads it back and still flags the slot.
  await dashboard.reload();
  await expect(threshold).toHaveValue("3");
  expect(await savedDays()).toBe(3);
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  await expect(staleChip).toBeVisible();

  // Storage lists it, and only there: it never raises the banner.
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  const problems = dashboard.getByRole("list", { name: "Storage problems" });
  await expect(problems.getByRole("listitem")).toHaveCount(1);
  await expect(problems).toContainText("Stale lease");
  await expect(problems).toContainText(`${lease.path} is still leased but has had no Git-visible change since ${
    new Date(quietSince).toISOString().slice(0, 10)
  }`);
  await expect(dashboard.getByRole("status", { name: "Storage needs attention" })).toHaveCount(0);
  const storage = await (await dashboard.request.get(`${daemon.baseURL}/api/storage`)).json() as StorageView;
  expect(storage.health.problems).toEqual([{
    id: `stale-lease:${slotId}:${lease.leaseId}`,
    kind: "stale-lease",
    bannered: false,
    message: expect.stringContaining(lease.path) as unknown as string,
    link: { target: "slot", slotId },
  }]);
  await shoot(dashboard, "02-storage-problem");

  // Its link lands on the slot card that carries the chip.
  await problems.getByRole("button", { name: "Open slot" }).click();
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  await expect(staleChip).toBeVisible();

  // Raising the threshold above the lease's age clears the chip and the problem.
  await threshold.fill("10");
  await threshold.blur();
  await expect(staleChip).toHaveCount(0);
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await expect(dashboard.getByText("No storage problems.")).toBeVisible();
  await shoot(dashboard, "03-cleared");

  // Flagged, never reclaimed: the lease still holds its slot and its checkout.
  const after = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
  const slot = after.repositories.flatMap((pool) => pool.slots).find((entry) => entry.id === slotId)!;
  expect(slot.state).toBe("leased");
  expect(slot.owner?.kind).toBe("manual");
  expect(existsSync(lease.path)).toBe(true);
  expect(leaseClock(daemon)[lease.leaseId]?.changedAt).toBe(quietSince);
});

interface TaskSnapshot {
  id: string;
  title: string;
  intent: string;
  status: string;
  worktreePath: string | null;
  worktreeLeaseId: string | null;
}

async function taskFor(daemon: DaemonHandle, intent: string): Promise<TaskSnapshot | undefined> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`);
  if (!response.ok) return undefined;
  return ((await response.json()) as TaskSnapshot[]).find((task) => task.intent === intent);
}

async function storageProblems(daemon: DaemonHandle): Promise<StorageView["health"]["problems"]> {
  const response = await fetch(`${daemon.baseURL}/api/storage`);
  return response.ok ? ((await response.json()) as StorageView).health.problems : [];
}

test("a settled task kept for its uncommitted work is listed, and its Return states the discard before reclaiming it", async ({
  dashboard,
  daemon,
}) => {
  // A dispatch, a Kill, a restart and a real native return: seconds of git and process work.
  test.setTimeout(180_000);
  const intent = "Leave uncommitted work behind for a restart to settle";
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  await dialog.getByLabel("Kind").selectOption("ship");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => taskFor(daemon, intent), { timeout: 60_000 }).toMatchObject({
    status: "running",
    worktreeLeaseId: expect.any(String),
  });
  const task = (await taskFor(daemon, intent))!;
  const worktree = task.worktreePath!;
  writeFileSync(join(worktree, "settled-notes.md"), "Work a restart must not discard.\n");

  // The agent goes away, then the daemon restarts and settles what is left.
  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row", { hasText: task.title })
    .click();
  await dashboard.locator(".console-detail").getByRole("button", { name: /kill$/i }).click();
  const kill = dashboard.getByRole("dialog", { name: "Kill session" });
  await kill.getByRole("button", { name: "Kill" }).click();
  await expect(kill).toBeHidden();
  await expect.poll(() => taskFor(daemon, intent), { timeout: 60_000 }).toMatchObject({ status: "failed" });
  await daemon.crash();
  await daemon.restart();

  const problemFor = async () => (await storageProblems(daemon)).find((problem) => problem.kind === "dirty-settled-tree");
  await expect.poll(problemFor, { timeout: 60_000 }).toMatchObject({
    id: expect.stringMatching(new RegExp(`^dirty-settled-tree:${task.id}:\\d+$`)) as unknown as string,
    bannered: false,
    link: { target: "slot" },
  });
  expect((await taskFor(daemon, intent))?.worktreePath, "the restart kept the tree").toBe(worktree);
  const inventory = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
  const ordinal = inventory.repositories.flatMap((pool) => pool.slots).find((slot) => slot.path === worktree)!.ordinal;

  // Storage lists it, and only there.
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  const problems = dashboard.getByRole("list", { name: "Storage problems" });
  const row = problems.getByRole("listitem").filter({ hasText: "Dirty settled tree" });
  await expect(row).toContainText(`settled with work left in ${worktree}`);
  await expect(row).toContainText("kept for the 30-day retention window");
  await expect(dashboard.getByRole("status", { name: "Storage needs attention" })).toHaveCount(0);
  await shoot(dashboard, "04-dirty-settled-tree");

  // Its link lands on the slot card, whose Return preview says what it discards.
  await row.getByRole("button", { name: "Open slot" }).click();
  const disclosure = dashboard.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const card = dashboard.getByRole("article", { name: `Slot ${ordinal}` });
  await expect(card).toBeVisible();
  const discard = `Discards the uncommitted, untracked or ignored work in ${worktree}.`;
  await card.getByRole("button", { name: "Return", exact: true }).click();
  const preview = dashboard.getByRole("dialog", { name: "return worktree preview" });
  await expect(preview.getByText(discard)).toBeVisible();
  await expectContentClearsBorder(preview);
  await shoot(dashboard, "05-return-states-discard");

  // Cancel keeps the tree.
  await preview.getByRole("button", { name: "Cancel" }).click();
  await expect(preview).toHaveCount(0);
  expect(existsSync(join(worktree, "settled-notes.md"))).toBe(true);
  expect((await taskFor(daemon, intent))?.worktreePath).toBe(worktree);
  expect(await problemFor()).toBeDefined();

  // Confirm reclaims it through the task, and the problem goes with it.
  await card.getByRole("button", { name: "Return", exact: true }).click();
  await expect(preview.getByText(discard)).toBeVisible();
  await preview.getByRole("checkbox", { name: /Dirty or untracked work will be discarded/ }).check();
  await preview.getByRole("button", { name: "Execute" }).click();
  await expect(preview).toHaveCount(0);
  await expect.poll(() => taskFor(daemon, intent), { timeout: 60_000 }).toMatchObject({
    status: "failed",
    worktreePath: null,
  });
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await expect(dashboard.getByText("No storage problems.")).toBeVisible({ timeout: 30_000 });
  expect(await problemFor()).toBeUndefined();
  expect(existsSync(join(worktree, "settled-notes.md")), "the discarded file is gone").toBe(false);
  await shoot(dashboard, "06-reclaimed");
});
