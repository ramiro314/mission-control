import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

/**
 * Reclaiming what a finished owner left behind, driven from the Storage problem that names it.
 *
 * What only this layer proves: that an orphan process the daemon found really reaches the
 * Storage Problems list, that its link lands on the slot card, and that Kill there goes
 * through its confirmation to the guarded route and comes back as the process gone and the
 * row cleared over `storage_health`. No agent is launched, so no model tokens are spent.
 */

const EVIDENCE = artifactsDir("worktree-reclaim");

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/worktree-reclaim/${name}.png`);
}

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
    await problem.getByRole("button", { name: "Open worktrees" }).click();

    const slot = dashboard.locator(".wt-slot", { hasText: lease.path });
    const orphans = slot.getByRole("region", { name: /Orphan processes in slot/ });
    await expect(orphans).toContainText(`PID ${pid}`);
    await expect(orphans).toContainText("setInterval");
    await slot.scrollIntoViewIfNeeded();
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

    // Confirm kills it, and the row leaves with the next storage_health event.
    await orphans.getByRole("button", { name: `Kill process ${pid}` }).click();
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
