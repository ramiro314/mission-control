import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
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
 * Orphan processes: a process still inside a tree whose owner has finished is listed in Storage,
 * its link lands on the slot card, and Kill there goes through its confirmation to the guarded
 * route and comes back as the process gone and the row cleared over `storage_health`.
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("Kill, from a Storage problem link, stops an orphan process in a quarantined slot through its confirmation", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "orphan process" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };
  const returned = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, {
    data: { leaseId: lease.leaseId },
  });
  expect(returned.ok()).toBe(true);

  // The audited state: a reset that git refused left the slot quarantined, and a process
  // whose owner is long gone still has its working directory inside it.
  withDaemonDb(daemon, (db) => {
    const changed = db.prepare(
      `UPDATE worktree_slots
          SET state = 'quarantined', version = version + 1,
              quarantine_reason = 'worktree reset failed',
              last_error = 'a process still uses the slot'
        WHERE path = ? AND state = 'available'`,
    ).run(lease.path);
    expect(Number(changed.changes)).toBe(1);
  });
  let orphan: ChildProcess | null = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: lease.path, stdio: "ignore",
  });
  await once(orphan, "spawn");
  const pid = orphan.pid!;
  orphan.once("exit", () => { orphan = null; });

  try {
    // Opening Storage scans the finished trees, so the problem is there without waiting for a
    // maintenance pass.
    await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
    const problems = dashboard.getByRole("list", { name: "Storage problems" });
    const problem = problems.getByRole("listitem").filter({ hasText: `Process ${pid}` });
    await expect(problem.getByText("Orphan process", { exact: true })).toBeVisible();
    await expect(problem).toContainText(lease.path);
    await shoot(dashboard, "01-orphan-process-problem");
    await problem.getByRole("button", { name: "Open slot" }).click();

    // The link lands on this slot's card, scrolled into view, with its orphan row.
    const slot = dashboard.locator(".wt-slot", { hasText: lease.path });
    await expect(slot).toBeInViewport();
    const orphans = slot.getByRole("region", { name: /Orphan processes in slot/ });
    await expect(orphans).toContainText(`PID ${pid}`);
    await expect(orphans).toContainText("setInterval");
    await shoot(dashboard, "02-slot-card-orphan-row");

    // Cancel signals nothing.
    await orphans.getByRole("button", { name: `Kill process ${pid}` }).click();
    const confirm = dashboard.getByRole("dialog", { name: "Kill orphan process" });
    await expect(confirm.getByRole("heading", { name: `Kill process ${pid}` })).toBeVisible();
    await expect(confirm).toContainText(lease.path);
    await expect(confirm).toContainText("SIGTERM, then SIGKILL if the process is still running 5 seconds later");
    await expectContentClearsBorder(confirm);
    await shoot(dashboard, "03-kill-confirmation");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    expect(alive(pid)).toBe(true);
    await expect(orphans).toContainText(`PID ${pid}`);

    // A request the daemon never answers leaves the dialog open and says the outcome is unknown,
    // rather than a bare network error that reads like a refusal.
    await orphans.getByRole("button", { name: `Kill process ${pid}` }).click();
    await dashboard.route("**/api/worktrees/processes/kill", (route) => route.abort());
    await confirm.getByRole("button", { name: "Kill process" }).click();
    await expect(confirm.getByRole("alert")).toContainText(`not known whether process ${pid} was signalled`);
    await expect(confirm.getByRole("button", { name: "Kill process" })).toBeEnabled();
    expect(alive(pid)).toBe(true);
    await shoot(dashboard, "05-kill-unanswered");
    await dashboard.unroute("**/api/worktrees/processes/kill");

    // Confirm kills it, and the row leaves with the next storage_health event.
    const killed = dashboard.waitForResponse((response) => response.url().endsWith("/api/worktrees/processes/kill"));
    await confirm.getByRole("button", { name: "Kill process" }).click();
    expect((await killed).status()).toBe(200);
    await expect(confirm).toHaveCount(0);
    await expect.poll(() => alive(pid)).toBe(false);
    await expect(slot.getByRole("region", { name: /Orphan processes in slot/ })).toHaveCount(0);
    await shoot(dashboard, "04-orphan-killed");
  } finally {
    orphan?.kill("SIGKILL");
  }
});
