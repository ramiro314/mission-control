import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

/**
 * A worktree return refused for over an hour, from Settings > Storage to its slot card.
 *
 * The refusal is seeded: a check-lease row naming a real native slot's lease, whose recorded
 * first refusal is two hours old. An hour of real refusals is not something a spec can wait
 * out, and the e2e daemon runs no maintenance sweep that would retry the return. Everything
 * downstream of the row is real: the daemon reads the refusal columns, raises `stuck-return`,
 * resolves the lease to its slot, and publishes the aggregate the two panels draw. No agent is
 * launched, so no model tokens are spent.
 */

const EVIDENCE = artifactsDir("stuck-return");

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/stuck-return/${name}.png`);
}

const REASON = "one or more processes still occupy the worktree";

test("a return refused for over an hour is a Storage problem that opens its slot card, which shows the reason until the return succeeds", async ({
  dashboard,
  daemon,
}) => {
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "held by a refused return" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };

  const firstRefusedAt = Date.now() - 2 * 60 * 60 * 1_000;
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `INSERT INTO workflow_check_leases
         (attempt_id, submission_id, node_id, repo_root, lease_path, holder_token, cleanup_state,
          supervisor_pid, supervisor_start_ticks, provider, lease_id, created_at, updated_at,
          first_refused_at, last_refusal)
       VALUES ('stuck-attempt', 'stuck-submission', 'unit tests', ?, ?, ?, 'returning',
               0, '', 'mission', ?, ?, ?, ?, ?)`,
    ).run(
      daemon.repo, lease.path, lease.leaseId, lease.leaseId, firstRefusedAt, firstRefusedAt, firstRefusedAt,
      JSON.stringify({ reason: REASON, processes: [{ pid: 4242, command: "node vite" }] }),
    );
  });
  const message = `Check "unit tests" worktree return refused for over an hour: ${REASON}; blocked by process 4242 (node vite)`;

  // Storage lists it, with the latest refusal and the process behind it.
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  const problems = dashboard.getByRole("list", { name: "Storage problems" });
  const row = problems.getByRole("listitem").filter({ hasText: "Stuck return" });
  await expect(row).toContainText(message);
  await shoot(dashboard, "01-storage-problem");

  // Its link opens the Worktrees page on that very slot card, which says why it is held.
  await row.getByRole("button", { name: "Open slot" }).click();
  await expect(dashboard.getByRole("tab", { name: "Worktrees" })).toHaveAttribute("aria-selected", "true");
  const slot = dashboard.locator(".wt-slot", { hasText: lease.path });
  await expect(slot).toBeInViewport();
  await expect(slot.getByText("return stuck", { exact: true })).toBeVisible();
  await expect(slot.getByText(message)).toBeVisible();
  await shoot(dashboard, "02-slot-card");

  // A successful return clears the columns; the next recompute takes the reason off the card.
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `UPDATE workflow_check_leases SET cleanup_state = 'returned', first_refused_at = NULL, last_refusal = NULL
        WHERE attempt_id = 'stuck-attempt'`,
    ).run();
  });
  expect((await dashboard.request.get(`${daemon.baseURL}/api/storage`)).ok()).toBe(true);
  await expect(slot.getByText("return stuck", { exact: true })).toHaveCount(0);
  await expect(slot.getByText(message)).toHaveCount(0);
});
