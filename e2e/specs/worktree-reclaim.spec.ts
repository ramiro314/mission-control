import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
 *
 * Recover: a slot quarantined by a stale `index.lock` reaches Storage as a problem whose link
 * lands on that slot's card, and the card's Recover runs through the preview the daemon builds
 * (naming the lock and the work it discards) to a real reset on disk, after which the slot
 * reads available and the problem is gone.
 *
 * Restore: a slot quarantined only because a read failed, while its owner was alive, goes back to
 * that owner on the next maintenance pass with its work and its process exactly as they were. The
 * lease, the dirty file, the process and the restart are real; the one seeded fact is the
 * quarantine, which this build no longer writes for a failed read.
 *
 * Orphan processes: a process still inside a tree whose owner has finished is listed in Storage,
 * its link lands on the slot card, and Kill there goes through its confirmation to the guarded
 * route and comes back as the process gone and the row cleared over `storage_health`. With more
 * than one, Kill all confirms every listed process in one dialog and stops them all; any the
 * daemon refuses stay in that dialog with its reason.
 *
 * Unowned trees: a folder under `worktrees/` that no task, check or slot names has no slot card,
 * so its fixes live in Worktrees > Unowned trees. A process holding one is reported and killed
 * from its row; the sweep then keeps the folder for its work, and Discard and remove previews the
 * path and the work before it deletes the folder for real.
 */

const EVIDENCE = artifactsDir("worktree-reclaim");
const DAY_MS = 24 * 60 * 60 * 1000;

/** A Recover is a fetch and a reset of a real checkout; this is about the disk, not the dialog. */
const EXECUTES_MS = 30_000;

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

/** The slot's own `index.lock`, under the directory its `.git` file names. */
function indexLockOf(slotPath: string): string {
  const gitDirectory = readFileSync(join(slotPath, ".git"), "utf8").match(/^gitdir: (.+)$/m)![1]!.trim();
  return join(resolve(slotPath, gitDirectory), "index.lock");
}

test("a Storage problem link opens the quarantined slot, whose Recover previews and resets it", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  // A slot that served a manual lease and went back to the pool, as every slot does.
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "recover fixture" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };
  const returned = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, {
    data: { leaseId: lease.leaseId },
  });
  expect(returned.ok()).toBe(true);

  // Then the audited incident: a Git command died holding `index.lock`, and the next reset
  // was refused with Git's own text. The lock is planted for real; the refusal is recorded
  // exactly as the manager records it, at a fixed entry time the problem id is built from.
  const lock = indexLockOf(lease.path);
  writeFileSync(lock, "");
  const scratch = join(lease.path, "scratch-notes.md");
  writeFileSync(scratch, "left behind by the crashed run\n");
  const quarantinedAt = Date.now() - 60 * 60_000;
  withDaemonDb(daemon, (db) => {
    const changed = db.prepare(
      `UPDATE worktree_slots
          SET state = 'quarantined', version = version + 1, quarantined_at = ?,
              quarantine_reason = 'return reset failed',
              last_error = ?
        WHERE path = ? AND state = 'available'`,
    ).run(
      quarantinedAt,
      `git checkout --detach failed: fatal: Unable to create '${lock}': File exists.`,
      lease.path,
    );
    expect(Number(changed.changes)).toBe(1);
  });

  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  // The dashboard banner raised by this problem, read from the `storage_health` stream.
  const banner = dashboard.getByRole("status", { name: "Storage needs attention" })
    .filter({ hasText: "is quarantined: a stale index.lock blocked its reset" });
  await expect(banner).toBeVisible();
  const problems = dashboard.getByRole("list", { name: "Storage problems" });
  const problem = problems.getByRole("listitem").filter({ hasText: "Quarantined slot" });
  await expect(problem).toContainText("is quarantined: a stale index.lock blocked its reset");
  await shoot(dashboard, "01-storage-quarantined-slot");
  await problem.getByRole("button", { name: "Open slot" }).click();

  await expect(dashboard.getByRole("tab", { name: "Worktrees" })).toHaveAttribute("aria-selected", "true");
  const slot = dashboard.locator(".wt-slot", { hasText: lease.path });
  await expect(slot.getByText("quarantined", { exact: true })).toBeVisible();
  await expect(slot).toBeInViewport();
  await shoot(dashboard, "02-slot-card-recover");
  await slot.getByRole("button", { name: "Recover", exact: true }).click();

  const preview = dashboard.getByRole("dialog", { name: "recover worktree preview" });
  await expect(preview.getByRole("heading", { name: "Recover worktree" })).toBeVisible();
  await expect(preview.getByText(`Removes the stale lock ${lock}.`)).toBeVisible();
  await expect(preview.getByText(/^Discards the slot's work: checkout has uncommitted, untracked or ignored work\./)).toBeVisible();
  await expectContentClearsBorder(preview);
  const execute = preview.getByRole("button", { name: "Execute" });
  await expect(execute).toBeDisabled();
  await shoot(dashboard, "03-recover-preview");

  // Cancel changes nothing: the lock and the work stay where they were.
  await preview.getByRole("button", { name: "Cancel" }).click();
  await expect(preview).toHaveCount(0);
  expect(existsSync(lock)).toBe(true);
  expect(existsSync(scratch)).toBe(true);

  await slot.getByRole("button", { name: "Recover", exact: true }).click();
  await preview.getByLabel(/I understand: Uncommitted, untracked, unpushed or ignored work will be discarded/).check();
  await expect(execute).toBeEnabled();
  await execute.click();
  await expect(preview).toHaveCount(0);

  await expect.poll(() => existsSync(lock), { timeout: EXECUTES_MS }).toBe(false);
  await expect(slot.getByText("available", { exact: true })).toBeVisible({ timeout: EXECUTES_MS });
  await expect(slot.getByRole("button", { name: "Recover", exact: true })).toHaveCount(0);
  expect(existsSync(scratch)).toBe(false);
  expect(execFileSync("git", ["-C", lease.path, "status", "--porcelain"]).toString()).toBe("");
  // Still on Worktrees, before Storage reads the aggregate itself: the recovery's own
  // `storage_health` event is what clears the banner.
  await expect(banner).toHaveCount(0);
  await shoot(dashboard, "04-slot-recovered");

  await dashboard.getByRole("tab", { name: "Storage" }).click();
  await expect(dashboard.getByText("No storage problems.")).toBeVisible();
  await expect(banner).toHaveCount(0);
  await shoot(dashboard, "05-storage-cleared");
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a maintenance pass returns a slot quarantined only by a failed read to its live owner, as it stood", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "restored lease" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };
  const draft = join(lease.path, "in-progress.md");
  writeFileSync(draft, "Work its owner is still doing.\n");
  const tree = () => ["rev-parse HEAD", "status --porcelain"]
    .map((command) => execFileSync("git", ["-C", lease.path, ...command.split(" ")]).toString());
  const before = tree();

  // The audited state: a process listing failed under load, and an earlier build quarantined a
  // slot whose owner was alive and working in it.
  withDaemonDb(daemon, (db) => {
    const changed = db.prepare(
      `UPDATE worktree_slots
          SET state = 'quarantined', version = version + 1, quarantined_at = ?,
              quarantine_reason = 'slot occupancy is unknown',
              last_error = 'process listing was killed before it answered'
        WHERE path = ? AND state = 'leased'`,
    ).run(Date.now() - 60 * 60_000, lease.path);
    expect(Number(changed.changes)).toBe(1);
  });
  let occupant: ChildProcess | null = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: lease.path, stdio: "ignore",
  });
  await once(occupant, "spawn");
  const pid = occupant.pid!;
  occupant.once("exit", () => { occupant = null; });

  try {
    const inventory = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
    const ordinal = inventory.repositories.flatMap((pool) => pool.slots).find((slot) => slot.path === lease.path)!.ordinal;
    await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
    const disclosure = dashboard.getByRole("button", { name: /demo-repo/ });
    if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
    const card = dashboard.getByRole("article", { name: `Slot ${ordinal}` });
    await expect(card.getByText("quarantined", { exact: true })).toBeVisible();
    await expect(card).toContainText("slot occupancy is unknown");
    const banner = dashboard.getByRole("status", { name: "Storage needs attention" });
    await expect(banner).toBeVisible();
    await shoot(dashboard, "13-failed-read-quarantine");

    // The fixture switches recurring maintenance off, so this daemon comes back with an hour's
    // interval and runs its startup pass, and no other, here.
    await daemon.crash();
    await daemon.restart({ MISSION_WORKTREE_SWEEP_MS: String(60 * 60_000) });
    await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
    await dashboard.reload();
    if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();

    await expect(card.getByText("leased", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText("quarantined", { exact: true })).toHaveCount(0);
    await expect(card).not.toContainText("slot occupancy is unknown");
    await expect(banner).toHaveCount(0);
    await shoot(dashboard, "14-lease-restored");

    // It is the same lease, and nothing about the tree or the process inside it changed.
    const after = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
    const slot = after.repositories.flatMap((pool) => pool.slots).find((entry) => entry.path === lease.path)!;
    expect(slot.state).toBe("leased");
    expect(slot.owner?.kind).toBe("manual");
    expect(tree()).toEqual(before);
    expect(readFileSync(draft, "utf8")).toBe("Work its owner is still doing.\n");
    expect(alive(pid)).toBe(true);

    await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
    await expect(dashboard.getByText("No storage problems.")).toBeVisible();
  } finally {
    occupant?.kill("SIGKILL");
  }
});

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
    // Kill all is for more than one process; with one, its row's Kill is the only one offered.
    await expect(orphans.getByRole("button", { name: "Kill all" })).toHaveCount(0);
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

/**
 * A quarantined slot with `count` real processes still running in it, opened on its card from
 * the first one's Storage problem link, so the card lists every one of them.
 */
async function slotWithOrphans(dashboard: Page, daemon: DaemonHandle, count: number) {
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "orphan processes" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };
  const returned = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, {
    data: { leaseId: lease.leaseId },
  });
  expect(returned.ok()).toBe(true);
  withDaemonDb(daemon, (db) => {
    const changed = db.prepare(
      `UPDATE worktree_slots
          SET state = 'quarantined', version = version + 1,
              quarantine_reason = 'worktree reset failed',
              last_error = 'processes still use the slot'
        WHERE path = ? AND state = 'available'`,
    ).run(lease.path);
    expect(Number(changed.changes)).toBe(1);
  });
  const children: ChildProcess[] = [];
  for (let index = 0; index < count; index += 1) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: lease.path, stdio: "ignore" });
    await once(child, "spawn");
    children.push(child);
  }
  const pids = children.map((child) => child.pid!);
  const cleanup = () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  try {
    await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
    const problem = dashboard.getByRole("list", { name: "Storage problems" })
      .getByRole("listitem").filter({ hasText: `Process ${pids[0]}` });
    await expect(problem.getByText("Orphan process", { exact: true })).toBeVisible();
    await problem.getByRole("button", { name: "Open slot" }).click();
    const slot = dashboard.locator(".wt-slot", { hasText: lease.path });
    const orphans = slot.getByRole("region", { name: /Orphan processes in slot/ });
    for (const pid of pids) await expect(orphans).toContainText(`PID ${pid}`);
    return { lease, children, pids, slot, orphans, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

test("Kill all, on a slot card, confirms every orphan process together and stops them all", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  const { lease, pids, slot, orphans, cleanup } = await slotWithOrphans(dashboard, daemon, 2);
  try {
    await shoot(dashboard, "06-slot-card-kill-all");

    // Kill all opens one confirmation naming every process, and Cancel signals none of them.
    await orphans.getByRole("button", { name: "Kill all" }).click();
    const confirm = dashboard.getByRole("dialog", { name: "Kill orphan processes" });
    await expect(confirm.getByRole("heading", { name: "Kill 2 processes" })).toBeVisible();
    const listed = confirm.getByRole("list", { name: "Processes to kill" });
    for (const pid of pids) await expect(listed).toContainText(`PID ${pid}`);
    await expect(confirm).toContainText(lease.path);
    await expectContentClearsBorder(confirm);
    await shoot(dashboard, "06-kill-all-confirmation");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    for (const pid of pids) expect(alive(pid)).toBe(true);

    // Confirm sends one guarded kill per process, and the section leaves once all are gone.
    await orphans.getByRole("button", { name: "Kill all" }).click();
    await confirm.getByRole("button", { name: "Kill 2 processes" }).click();
    await expect(confirm).toHaveCount(0, { timeout: 30_000 });
    for (const pid of pids) await expect.poll(() => alive(pid)).toBe(false);
    await expect(slot.getByRole("region", { name: /Orphan processes in slot/ })).toHaveCount(0);
    await shoot(dashboard, "06-kill-all-done");
  } finally {
    cleanup();
  }
});

test("Kill all keeps only the processes the daemon refused in its dialog, each with its reason", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  const { children, pids, orphans, cleanup } = await slotWithOrphans(dashboard, daemon, 2);
  const [gone, killed] = pids;
  try {
    await orphans.getByRole("button", { name: "Kill all" }).click();
    const many = dashboard.getByRole("dialog", { name: "Kill orphan processes" });
    await expect(many.getByRole("heading", { name: "Kill 2 processes" })).toBeVisible();

    // The first process ends on its own while the dialog is open, so the daemon's fresh
    // inspection no longer finds it and refuses that one kill, while the other goes through.
    const exited = once(children[0], "exit");
    children[0].kill("SIGKILL");
    await exited;
    const kills = new Map<number, number>();
    dashboard.on("response", async (response) => {
      if (!response.url().endsWith("/api/worktrees/processes/kill")) return;
      const body = response.request().postDataJSON() as { pid: number };
      kills.set(body.pid, response.status());
    });
    await many.getByRole("button", { name: "Kill 2 processes" }).click();

    // The dialog stays open, narrowed to the refused process, with the daemon's reason for it.
    const one = dashboard.getByRole("dialog", { name: "Kill orphan process" });
    await expect(one.getByRole("heading", { name: `Kill process ${gone}` })).toBeVisible({ timeout: 30_000 });
    await expect(one.getByRole("list", { name: "Processes to kill" })).toHaveCount(0);
    await expect(one).not.toContainText(`${killed}`);
    await expect(one.getByRole("alert")).toContainText(new RegExp(`process ${gone} is (no longer|not reported) in that tree`));
    await expect(one.getByRole("button", { name: "Kill process" })).toBeEnabled();
    await expect.poll(() => alive(killed)).toBe(false);
    expect(Object.fromEntries(kills)).toEqual({ [gone]: 409, [killed]: 200 });
    await shoot(dashboard, "06-kill-all-partial");

    await one.getByRole("button", { name: "Cancel" }).click();
    await expect(one).toHaveCount(0);
  } finally {
    cleanup();
  }
});

test("an unowned tree: Kill its process from its row, then Discard and remove it through the preview", async ({
  dashboard,
  daemon,
}) => {
  // Two sweeps, a kill, a restart and a real `git worktree remove`.
  test.setTimeout(180_000);
  // An overflow tree a crash left behind: a real worktree of the seeded repository, holding work
  // no row names, and older than the sweep's 30-minute creation grace.
  const tree = join(daemon.home, "worktrees", "left-behind");
  mkdirSync(join(daemon.home, "worktrees"), { recursive: true });
  execFileSync("git", ["-C", daemon.repo, "worktree", "add", "-q", "-b", "harness/left-behind", tree]);
  const draft = join(tree, "draft.md");
  writeFileSync(draft, "Work nobody owns any more.\n");
  const hoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
  utimesSync(tree, hoursAgo, hoursAgo);
  utimesSync(join(tree, ".git"), hoursAgo, hoursAgo);
  let holder: ChildProcess | null = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: tree, stdio: "ignore",
  });
  await once(holder, "spawn");
  const pid = holder.pid!;
  holder.once("exit", () => { holder = null; });

  try {
    // The startup sweep finds the folder occupied and leaves it; the scan after it reports the
    // process. The fixture switches maintenance off, which skips the startup sweep too, so this
    // daemon comes back with an hour's interval: the startup pass runs, and no other does here.
    await daemon.crash();
    await daemon.restart({ MISSION_WORKTREE_SWEEP_MS: String(60 * 60_000) });
    await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
    const problems = dashboard.getByRole("list", { name: "Storage problems" });
    const orphanProblem = problems.getByRole("listitem").filter({ hasText: `Process ${pid}` });
    await expect(orphanProblem.getByText("Orphan process", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(orphanProblem).toContainText(`${tree}, which no task or check owns`);
    await shoot(dashboard, "07-unowned-orphan-problem");

    // Its link lands on the tree's row, with the process and its Kill, and nothing to discard yet.
    await orphanProblem.getByRole("button", { name: "Open tree" }).click();
    await expect(dashboard.getByRole("tab", { name: "Worktrees" })).toHaveAttribute("aria-selected", "true");
    const row = dashboard.getByRole("article", { name: `Unowned tree ${tree}` });
    await expect(row).toBeInViewport();
    const orphans = row.getByRole("region", { name: `Orphan processes in ${tree}` });
    await expect(orphans).toContainText(`PID ${pid}`);
    await expect(row.getByRole("button", { name: "Discard and remove" })).toHaveCount(0);
    await shoot(dashboard, "08-unowned-row-orphan");

    await orphans.getByRole("button", { name: `Kill process ${pid}` }).click();
    const confirm = dashboard.getByRole("dialog", { name: "Kill orphan process" });
    await expect(confirm).toContainText(tree);
    await confirm.getByRole("button", { name: "Kill process" }).click();
    await expect(confirm).toHaveCount(0);
    await expect.poll(() => alive(pid)).toBe(false);

    // The kill sweeps the folder again: free of its process, it is kept for its work.
    const discard = row.getByRole("button", { name: "Discard and remove" });
    await expect(discard).toBeVisible({ timeout: 30_000 });
    await expect(orphans).toHaveCount(0);
    await expect(row).toContainText(`Unowned tree ${tree} was kept: checkout has uncommitted, untracked or ignored work`);

    // Storage lists it too, raising the banner, and its link lands on the same row.
    await dashboard.getByRole("tab", { name: "Storage" }).click();
    const keptProblem = problems.getByRole("listitem").filter({ hasText: "Dirty unowned tree" });
    await expect(keptProblem).toContainText(tree);
    await expect(dashboard.getByRole("status", { name: "Storage needs attention" })).toBeVisible();
    await shoot(dashboard, "09-dirty-unowned-tree-problem");
    await keptProblem.getByRole("button", { name: "Open tree" }).click();
    await expect(row).toBeInViewport();
    await shoot(dashboard, "10-unowned-row-kept");

    // The preview names the path and the work it discards.
    await discard.click();
    const preview = dashboard.getByRole("dialog", { name: "removeUnowned worktree preview" });
    await expect(preview.getByRole("heading", { name: "Discard and remove unowned tree" })).toBeVisible();
    await expect(preview.getByText(`Discards the work in ${tree}: checkout has uncommitted, untracked or ignored work.`)).toBeVisible();
    await expect(preview.getByText("Files it deletes include: draft.md (untracked).")).toBeVisible();
    await expect(preview.getByRole("button", { name: "Execute" })).toBeDisabled();
    await expectContentClearsBorder(preview);
    await shoot(dashboard, "11-discard-preview");

    // Cancel keeps the row and the folder.
    await preview.getByRole("button", { name: "Cancel" }).click();
    await expect(preview).toHaveCount(0);
    await expect(row).toBeVisible();
    expect(existsSync(draft)).toBe(true);

    // Confirm removes the folder, and the row and the problem leave with the next storage_health event.
    await discard.click();
    await preview.getByLabel(/I understand: Uncommitted, untracked, unpushed or ignored work will be discarded/).check();
    await preview.getByRole("button", { name: "Execute" }).click();
    await expect(preview).toHaveCount(0);
    await expect.poll(() => existsSync(tree), { timeout: EXECUTES_MS }).toBe(false);
    await expect(row).toHaveCount(0);
    await expect(dashboard.getByText("No unowned trees.", { exact: false })).toBeVisible();
    await shoot(dashboard, "12-unowned-tree-removed");
    await dashboard.getByRole("tab", { name: "Storage" }).click();
    await expect(dashboard.getByText("No storage problems.")).toBeVisible();
    await expect(dashboard.getByRole("status", { name: "Storage needs attention" })).toHaveCount(0);
  } finally {
    holder?.kill("SIGKILL");
  }
});
