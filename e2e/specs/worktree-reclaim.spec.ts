import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
 * reads available and the problem is gone. An ignored file the remote default keeps ignored and
 * untracked is not work: a slot holding only a warm install recovers without acknowledgement,
 * and one the default would overwrite is named by its path.
 *
 * Automatic recovery: a maintenance pass clears a quarantine that no longer applies, with no
 * operator. A slot quarantined by a failed read, with no owner, no process and nothing the reset
 * would discard, reads available again with its warm install in place. One the default would
 * overwrite stays quarantined, and its card names the entry that blocked the pass. The pass is
 * real, on the daemon's own timer; only its interval is set.
 *
 * Restore: a slot quarantined only because a read failed, while its owner was alive, goes back to
 * that owner on the next maintenance pass with its work and its process exactly as they were. The
 * lease, the dirty file, the process and the restart are real; the one seeded fact is the
 * quarantine, which this build no longer writes for a failed read.
 *
 * Repair: a slot quarantined for its Git registration has a Repair of its own, because Recover needs
 * the registration it is missing. The preview names Git's fix, Execute runs it for real and then
 * recovers the slot, and a slot that holds work comes out repaired and still quarantined, for
 * Recover. The broken registrations are real files in the repository's Git directory; the one
 * seeded fact is the quarantine reason, which needs a pass this fixture has switched off.
 *
 * Orphan processes: a process still inside a tree whose owner has finished is listed in Storage,
 * its link lands on the slot card, and Kill there goes through its confirmation to the guarded
 * route and comes back as the process gone and the row cleared over `storage_health`. With more
 * than one, Kill all confirms every listed process in one dialog and stops them all; any the
 * daemon refuses stay in that dialog with its reason. A process in an available slot, which has
 * no owner at all, is an orphan process too: the slot stays available and its card offers Kill.
 *
 * Unowned trees: a folder under `worktrees/` that no task, check or slot names has no slot card,
 * so its fixes live in Worktrees > Unowned trees. A process holding one is reported and killed
 * from its row; the sweep then keeps the folder for its work, and Discard and remove previews the
 * path and the work before it deletes the folder for real. Removing a folder takes the delete
 * rule, so an ignored path the pool's claim seeds is regenerable there, never work.
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
  await expect(preview.getByText("Discards the slot's work: untracked scratch-notes.md.")).toBeVisible();
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

test("Repair runs Git's own fix from the slot card through its preview, and a slot holding work stays quarantined for Recover", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  const lease = async (label: string) => {
    const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
      data: { repositoryPath: daemon.repo, label },
    });
    expect(acquired.status()).toBe(201);
    return await acquired.json() as { path: string; leaseId: string };
  };
  const interrupted = await lease("interrupted add");
  const holdingWork = await lease("holds work");
  for (const { leaseId } of [interrupted, holdingWork]) {
    const returned = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, { data: { leaseId } });
    expect(returned.ok()).toBe(true);
  }

  // What an interrupted `git worktree add` leaves: a registration locked `initializing`.
  const locked = (path: string) => join(dirname(indexLockOf(path)), "locked");
  writeFileSync(locked(interrupted.path), "initializing\n");
  writeFileSync(locked(holdingWork.path), "initializing\n");
  const notes = join(holdingWork.path, "notes.md");
  writeFileSync(notes, "not committed anywhere\n");
  withDaemonDb(daemon, (db) => {
    for (const path of [interrupted.path, holdingWork.path]) {
      const changed = db.prepare(
        `UPDATE worktree_slots
            SET state = 'quarantined', version = version + 1, quarantined_at = ?,
                quarantine_reason = 'slot Git registration is bare, locked, or prunable', last_error = NULL
          WHERE path = ? AND state = 'available'`,
      ).run(Date.now(), path);
      expect(Number(changed.changes)).toBe(1);
    }
  });

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const slot = dashboard.locator(".wt-slot", { hasText: interrupted.path });
  await expect(slot.getByText("quarantined", { exact: true })).toBeVisible();
  await expect(slot).toContainText("slot Git registration is bare, locked, or prunable");
  await expect(slot.getByRole("button", { name: "Recover", exact: true })).toHaveCount(0);
  // The cards sit below the pool's settings, in a scrolling pane, so the card is brought into frame.
  await dashboard.setViewportSize({ width: 1280, height: 1100 });
  await slot.scrollIntoViewIfNeeded();
  await shoot(dashboard, "11-slot-card-repair");
  await slot.getByRole("button", { name: "Repair", exact: true }).click();

  const preview = dashboard.getByRole("dialog", { name: "repair worktree preview" });
  await expect(preview.getByRole("heading", { name: "Repair worktree" })).toBeVisible();
  await expect(preview.getByText("Removes the initializing lock an interrupted git worktree add left, with git worktree unlock.")).toBeVisible();
  await expect(preview.getByText('A slot that holds work is not reset: it stays quarantined as "registration repaired; holds work", for Recover.')).toBeVisible();
  await expectContentClearsBorder(preview);
  await shoot(dashboard, "12-repair-preview");

  // Cancel changes nothing: the lock stays where it was.
  await preview.getByRole("button", { name: "Cancel" }).click();
  await expect(preview).toHaveCount(0);
  expect(existsSync(locked(interrupted.path))).toBe(true);

  await slot.getByRole("button", { name: "Repair", exact: true }).click();
  await preview.getByRole("button", { name: "Execute" }).click();
  await expect(preview).toHaveCount(0);
  await expect(slot.getByText("available", { exact: true })).toBeVisible({ timeout: EXECUTES_MS });
  await expect(slot.getByRole("button", { name: "Repair", exact: true })).toHaveCount(0);
  expect(existsSync(locked(interrupted.path))).toBe(false);

  const kept = dashboard.locator(".wt-slot", { hasText: holdingWork.path });
  await kept.getByRole("button", { name: "Repair", exact: true }).click();
  await preview.getByRole("button", { name: "Execute" }).click();
  await expect(preview).toHaveCount(0);
  await expect(kept).toContainText("registration repaired; holds work", { timeout: EXECUTES_MS });
  await expect(kept).toContainText("notes.md");
  await expect(kept.getByText("quarantined", { exact: true })).toBeVisible();
  await expect(kept.getByRole("button", { name: "Repair", exact: true })).toHaveCount(0);
  await expect(kept.getByRole("button", { name: "Recover", exact: true })).toBeVisible();
  expect(existsSync(locked(holdingWork.path))).toBe(false);
  expect(readFileSync(notes, "utf8")).toBe("not committed anywhere\n");
  await shoot(dashboard, "13-repaired-holds-work");
});

test("Recover keeps a warm install: it names an ignored path the default would overwrite, and asks nothing once it would not", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  // The repository ignores what a monorepo slot carries, and origin's default says so.
  const repo = (...args: string[]) => execFileSync("git", ["-C", daemon.repo, ...args], { stdio: "pipe" }).toString().trim();
  repo("config", "user.name", "Spec");
  repo("config", "user.email", "spec@example.com");
  writeFileSync(join(daemon.repo, ".gitignore"), ".yarn/install-state.gz\nnode_modules/\n.idea/\n");
  repo("add", ".gitignore");
  repo("commit", "-qm", "ignore the install");
  repo("push", "-q", "origin", "main");

  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "warm install fixture" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };
  const returned = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, {
    data: { leaseId: lease.leaseId },
  });
  expect(returned.ok()).toBe(true);

  // The warm install and an IDE folder, all ignored, then the stale lock that quarantines it.
  const kept = [".yarn/install-state.gz", "node_modules/pkg/index.js", ".idea/workspace.xml"];
  for (const file of kept) {
    mkdirSync(join(lease.path, file, ".."), { recursive: true });
    writeFileSync(join(lease.path, file), "installed\n");
  }
  const inodes = kept.map((file) => statSync(join(lease.path, file)).ino);
  const lock = indexLockOf(lease.path);
  writeFileSync(lock, "");
  withDaemonDb(daemon, (db) => {
    const changed = db.prepare(
      `UPDATE worktree_slots
          SET state = 'quarantined', version = version + 1, quarantined_at = ?,
              quarantine_reason = 'return reset failed',
              last_error = ?
        WHERE path = ? AND state = 'available'`,
    ).run(Date.now(), `git checkout --detach failed: fatal: Unable to create '${lock}': File exists.`, lease.path);
    expect(Number(changed.changes)).toBe(1);
  });

  // Origin's default starts tracking a file inside the ignored .idea/, which the reset would write.
  mkdirSync(join(daemon.repo, ".idea", "codeStyles"), { recursive: true });
  writeFileSync(join(daemon.repo, ".idea", "codeStyles", "Project.xml"), "<code_scheme/>\n");
  repo("add", "-f", ".idea/codeStyles/Project.xml");
  repo("commit", "-qm", "share the code style");
  repo("push", "-q", "origin", "main");

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const slot = dashboard.locator(".wt-slot", { hasText: lease.path });
  await expect(slot.getByText("quarantined", { exact: true })).toBeVisible();
  await slot.getByRole("button", { name: "Recover", exact: true }).click();
  const preview = dashboard.getByRole("dialog", { name: "recover worktree preview" });
  await expect(preview.getByText(
    "Discards the slot's work: ignored .idea/ (the target tracks .idea/codeStyles/Project.xml).",
  )).toBeVisible();
  await expect(preview.getByLabel(/I understand: Uncommitted, untracked, unpushed or ignored work will be discarded/)).toBeVisible();
  await expect(preview.getByRole("button", { name: "Execute" })).toBeDisabled();
  await shoot(dashboard, "07-recover-names-blocking-path");
  await preview.getByRole("button", { name: "Cancel" }).click();
  await expect(preview).toHaveCount(0);

  // Once the default stops tracking it, every ignored file stays ignored: nothing to acknowledge.
  repo("rm", "-q", "--cached", ".idea/codeStyles/Project.xml");
  repo("commit", "-qm", "unshare the code style");
  repo("push", "-q", "origin", "main");
  await slot.getByRole("button", { name: "Recover", exact: true }).click();
  await expect(preview.getByText(
    "Keeps every ignored file the remote default still ignores and does not track, such as node_modules/ and .yarn/install-state.gz.",
  )).toBeVisible();
  await expect(preview.getByText(/^Discards the slot's work/)).toHaveCount(0);
  await expect(preview.getByLabel(/I understand/)).toHaveCount(0);
  await expectContentClearsBorder(preview);
  await shoot(dashboard, "08-recover-keeps-warm-install");
  await preview.getByRole("button", { name: "Execute" }).click();
  await expect(preview).toHaveCount(0);

  await expect(slot.getByText("available", { exact: true })).toBeVisible({ timeout: EXECUTES_MS });
  expect(existsSync(lock)).toBe(false);
  expect(kept.map((file) => statSync(join(lease.path, file)).ino), "the install kept every inode").toEqual(inodes);
  await shoot(dashboard, "09-recovered-with-install");
});

test("a maintenance pass clears a slot whose quarantine no longer applies, and names what keeps another", async ({
  dashboard,
  daemon,
}) => {
  // One real maintenance pass, on the shortest interval the daemon accepts.
  test.setTimeout(180_000);
  const repo = (...args: string[]) => execFileSync("git", ["-C", daemon.repo, ...args], { stdio: "pipe" }).toString().trim();
  repo("config", "user.name", "Spec");
  repo("config", "user.email", "spec@example.com");
  writeFileSync(join(daemon.repo, ".gitignore"), ".yarn/install-state.gz\nnode_modules/\n.idea/\n");
  repo("add", ".gitignore");
  repo("commit", "-qm", "ignore the install");
  repo("push", "-q", "origin", "main");

  // Two slots that served a lease at once, so each went back to the pool as itself.
  const lease = async (label: string) => {
    const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
      data: { repositoryPath: daemon.repo, label },
    });
    expect(acquired.status()).toBe(201);
    return await acquired.json() as { path: string; leaseId: string };
  };
  const clearing = await lease("clears by itself");
  const blocked = await lease("kept by the pass");
  for (const { leaseId } of [clearing, blocked]) {
    const returned = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, { data: { leaseId } });
    expect(returned.ok()).toBe(true);
  }

  // Both hold only ignored files, then a read that failed under load quarantines them, written
  // as older builds wrote it. Nothing in either folder has anything wrong with it.
  const install = join(clearing.path, ".yarn", "install-state.gz");
  mkdirSync(join(clearing.path, ".yarn"), { recursive: true });
  writeFileSync(install, "installed\n");
  const inode = statSync(install).ino;
  const idea = join(blocked.path, ".idea", "workspace.xml");
  mkdirSync(join(blocked.path, ".idea"), { recursive: true });
  writeFileSync(idea, "<project/>\n");
  withDaemonDb(daemon, (db) => {
    for (const path of [clearing.path, blocked.path]) {
      const changed = db.prepare(
        `UPDATE worktree_slots
            SET state = 'quarantined', version = version + 1, quarantined_at = ?,
                quarantine_reason = 'slot process occupancy is unknown',
                last_error = 'process listing was killed before it answered'
          WHERE path = ? AND state = 'available'`,
      ).run(Date.now(), path);
      expect(Number(changed.changes)).toBe(1);
    }
  });

  // Origin's default starts tracking a file inside the ignored .idea/, which a reset would write.
  mkdirSync(join(daemon.repo, ".idea", "codeStyles"), { recursive: true });
  writeFileSync(join(daemon.repo, ".idea", "codeStyles", "Project.xml"), "<code_scheme/>\n");
  repo("add", "-f", ".idea/codeStyles/Project.xml");
  repo("commit", "-qm", "share the code style");
  repo("push", "-q", "origin", "main");

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const card = (path: string) => dashboard.locator(".wt-slot", { hasText: path });
  await expect(card(clearing.path).getByText("quarantined", { exact: true })).toBeVisible();
  await expect(card(blocked.path).getByText("quarantined", { exact: true })).toBeVisible();

  // The fixture switches maintenance off, so this daemon comes back with it on.
  await daemon.crash();
  await daemon.restart({ MISSION_WORKTREE_SWEEP_MS: "30000" });
  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);

  // The ignored install is not work: the slot comes back with no operator, and keeps it.
  await expect(card(clearing.path).getByText("available", { exact: true })).toBeVisible({ timeout: 90_000 });
  expect(statSync(install).ino, "the install kept its inode").toBe(inode);
  expect(readFileSync(install, "utf8")).toBe("installed\n");
  await expect(card(clearing.path).getByRole("button", { name: "Recover", exact: true })).toHaveCount(0);

  // The other stays quarantined, its file intact, and its card says exactly what blocked the pass.
  const kept = card(blocked.path);
  await expect(kept.getByText("quarantined", { exact: true })).toBeVisible();
  await expect(kept).toContainText(
    "the slot holds work Recover would discard: ignored .idea/ (the target tracks .idea/codeStyles/Project.xml)",
    { timeout: EXECUTES_MS },
  );
  await expect(kept).toContainText("Blocked by");
  expect(readFileSync(idea, "utf8")).toBe("<project/>\n");
  // The cards sit below the pool's settings, in a scrolling pane, so both are brought into frame.
  await dashboard.setViewportSize({ width: 1280, height: 1100 });
  await card(clearing.path).scrollIntoViewIfNeeded();
  await shoot(dashboard, "10-automatic-recovery");
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

test("a quarantined slot whose owner is referenced names it, and Return opens the owner's preview, refused while a process is inside", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "owned quarantine" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };

  // A reset that failed under a lease its owner still holds: the slot is quarantined, and the
  // manual lease that owns it is live.
  withDaemonDb(daemon, (db) => {
    const changed = db.prepare(
      `UPDATE worktree_slots
          SET state = 'quarantined', version = version + 1, quarantined_at = ?,
              quarantine_reason = 'worktree reset failed',
              last_error = 'git checkout --detach failed: exit 128'
        WHERE path = ? AND state = 'leased'`,
    ).run(Date.now(), lease.path);
    expect(Number(changed.changes)).toBe(1);
  });

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const disclosure = dashboard.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const inventory = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
  const ordinal = inventory.repositories.flatMap((pool) => pool.slots).find((slot) => slot.path === lease.path)!.ordinal;
  const card = dashboard.getByRole("article", { name: `Slot ${ordinal}` });
  await expect(card.getByText("quarantined", { exact: true })).toBeVisible();
  // The owner is named, and so is the way back. Recover is for an owner that is gone.
  await expect(card.getByText(/Manual lease [0-9a-f]{8}: owned quarantine$/)).toBeVisible();
  await expect(card.getByText("Its owner's return brings this slot back.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Recover", exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Destroy", exact: true })).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await shoot(dashboard, "owned-01-card-names-owner");

  let occupant: ChildProcess | null = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: lease.path, stdio: "ignore",
  });
  await once(occupant, "spawn");
  const pid = occupant.pid!;
  const exited = once(occupant, "exit");
  occupant.once("exit", () => { occupant = null; });
  const preview = dashboard.getByRole("dialog", { name: "return worktree preview" });
  try {
    // Return opens the owner's ordinary preview, refused while the process is inside.
    await card.getByRole("button", { name: "Return", exact: true }).click();
    await expect(preview.getByRole("heading", { name: "Return worktree" })).toBeVisible();
    await expect(preview.getByText("Returns the exact durable manual lease before any slot removal.")).toBeVisible();
    await expect(preview.getByText(
      `Slot ${ordinal} is quarantined with 1 process(es) inside; they must exit before its owner can return it.`,
    )).toBeVisible();
    await expect(preview.getByRole("button", { name: "Execute" })).toBeDisabled();
    await expectContentClearsBorder(preview);
    await shoot(dashboard, "owned-02-return-refused-while-occupied");
    await preview.getByRole("button", { name: "Cancel" }).click();
    await expect(preview).toHaveCount(0);
    expect(alive(pid)).toBe(true);
  } finally {
    occupant?.kill("SIGKILL");
  }
  await exited;

  // With the slot empty, the same Return runs the owner's return and the slot comes back.
  await card.getByRole("button", { name: "Return", exact: true }).click();
  await expect(preview.getByText("Returns the exact durable manual lease before any slot removal.")).toBeVisible();
  await expect(preview.getByRole("heading", { name: "Cannot execute" })).toHaveCount(0);
  await shoot(dashboard, "owned-03-return-preview");
  await preview.getByRole("button", { name: "Execute" }).click();
  await expect(preview).toHaveCount(0);
  await expect(card.getByText("available", { exact: true })).toBeVisible({ timeout: EXECUTES_MS });
  await expect(card.getByText("Its owner's return brings this slot back.")).toHaveCount(0);
  await expect(card.getByText(/owned quarantine/)).toHaveCount(0);
  expect(existsSync(lease.path), "Return keeps the slot as warm capacity").toBe(true);
  await card.scrollIntoViewIfNeeded();
  await shoot(dashboard, "owned-04-returned");
});

test("a slot a dead seed left quarantined refuses Destroy, points at Recover, and Recover brings it back", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "dead seed" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };

  // What a restart leaves when it interrupts a seed and reconcile cannot return its lease: the
  // `warm` owner stays on the row, and no seed by that key is running in this daemon.
  withDaemonDb(daemon, (db) => {
    const changed = db.prepare(
      `UPDATE worktree_slots
          SET state = 'quarantined', version = version + 1, quarantined_at = ?,
              active_owner_kind = 'warm', active_owner_key = 'seed-interrupted-by-restart',
              quarantine_reason = 'an interrupted warm lease could not be returned',
              last_error = 'a process still uses the slot'
        WHERE path = ? AND state = 'leased'`,
    ).run(Date.now(), lease.path);
    expect(Number(changed.changes)).toBe(1);
  });

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const disclosure = dashboard.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const inventory = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
  const ordinal = inventory.repositories.flatMap((pool) => pool.slots).find((slot) => slot.path === lease.path)!.ordinal;
  const card = dashboard.getByRole("article", { name: `Slot ${ordinal}` });
  await expect(card.getByText("quarantined", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Return", exact: true })).toHaveCount(0);

  // Destroy says what works, rather than telling the operator to wait for a seed that is gone.
  await card.getByRole("button", { name: "Destroy", exact: true }).click();
  const destroy = dashboard.getByRole("dialog", { name: "destroy worktree preview" });
  await expect(destroy.getByText(`Slot ${ordinal}'s owner no longer references it; Recover it instead.`)).toBeVisible();
  await expect(destroy.getByText("A dependency seed holds this slot")).toHaveCount(0);
  await expect(destroy.getByRole("button", { name: "Execute" })).toBeDisabled();
  await expectContentClearsBorder(destroy);
  await card.scrollIntoViewIfNeeded();
  await shoot(dashboard, "dead-seed-01-destroy-points-at-recover");
  await destroy.getByRole("button", { name: "Cancel" }).click();
  await expect(destroy).toHaveCount(0);

  await card.getByRole("button", { name: "Recover", exact: true }).click();
  const recover = dashboard.getByRole("dialog", { name: "recover worktree preview" });
  await expect(recover.getByRole("heading", { name: "Recover worktree" })).toBeVisible();
  await recover.getByRole("button", { name: "Execute" }).click();
  await expect(recover).toHaveCount(0);
  await expect(card.getByText("available", { exact: true })).toBeVisible({ timeout: EXECUTES_MS });
  await shoot(dashboard, "dead-seed-02-recovered");
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

test("a stray process in an available slot is listed on its card with Kill, and the slot stays available", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "stray process" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };
  const returned = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, {
    data: { leaseId: lease.leaseId },
  });
  expect(returned.ok()).toBe(true);

  let stray: ChildProcess | null = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: lease.path, stdio: "ignore",
  });
  await once(stray, "spawn");
  const pid = stray.pid!;
  stray.once("exit", () => { stray = null; });

  try {
    await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
    const problem = dashboard.getByRole("list", { name: "Storage problems" })
      .getByRole("listitem").filter({ hasText: `Process ${pid}` });
    await expect(problem.getByText("Orphan process", { exact: true })).toBeVisible();
    await expect(problem).toContainText(`${lease.path}, which no task or check owns`);
    await problem.getByRole("button", { name: "Open slot" }).click();

    const slot = dashboard.locator(".wt-slot", { hasText: lease.path });
    await expect(slot).toBeInViewport();
    await expect(slot.getByText("available", { exact: true })).toBeVisible();
    const orphans = slot.getByRole("region", { name: /Orphan processes in slot/ });
    await expect(orphans).toContainText(`PID ${pid}`);
    await shoot(dashboard, "09-available-slot-orphan");

    const kill = orphans.getByRole("button", { name: `Kill process ${pid}` });
    await expect(kill).toHaveAccessibleDescription(/keeps this slot from being leased/);
    await kill.click();
    const confirm = dashboard.getByRole("dialog", { name: "Kill orphan process" });
    await expect(confirm).toContainText(lease.path);
    await shoot(dashboard, "10-available-slot-kill-confirmation");
    const killed = dashboard.waitForResponse((response) => response.url().endsWith("/api/worktrees/processes/kill"));
    await confirm.getByRole("button", { name: "Kill process" }).click();
    expect((await killed).status()).toBe(200);
    await expect(confirm).toHaveCount(0);
    await expect.poll(() => alive(pid)).toBe(false);
    await expect(orphans).toHaveCount(0);
    await expect(slot.getByRole("region", { name: /^Processes in slot/ })).toHaveCount(0);
    await expect(slot.getByText("available", { exact: true })).toBeVisible();
    await shoot(dashboard, "11-available-slot-orphan-killed");
  } finally {
    stray?.kill("SIGKILL");
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

test("an unowned tree's discard preview treats its pool's seed path as regenerable, not as work", async ({
  dashboard,
  daemon,
}) => {
  // A restart and a real sweep of the tree.
  test.setTimeout(120_000);
  const commonDirectory = realpathSync(execFileSync(
    "git", ["-C", daemon.repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" },
  ).trim());
  // The repository ignores the yarn install state, and its pool's claim seeds it.
  appendFileSync(join(commonDirectory, "info", "exclude"), "\n.yarn/install-state.gz\n");
  const saved = await dashboard.request.put(`${daemon.baseURL}/api/worktrees/config`, {
    data: {
      repositories: {
        [commonDirectory]: {
          claim: { steps: [{ argv: ["true"] }], seed: { paths: ["node_modules", ".yarn/install-state.gz"] } },
        },
      },
    },
  });
  expect(saved.status()).toBe(200);

  // An overflow tree a crash left behind: kept for a commit it never pushed, and holding the
  // install state its pool would seed.
  const tree = join(daemon.home, "worktrees", "seeded-left-behind");
  mkdirSync(join(daemon.home, "worktrees"), { recursive: true });
  execFileSync("git", ["-C", daemon.repo, "worktree", "add", "-q", "-b", "harness/seeded-left-behind", tree]);
  writeFileSync(join(tree, "local.md"), "A commit nobody pushed.\n");
  execFileSync("git", ["-C", tree, "add", "local.md"]);
  execFileSync("git", ["-C", tree, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "local only"]);
  mkdirSync(join(tree, ".yarn"));
  writeFileSync(join(tree, ".yarn", "install-state.gz"), "install state\n");
  const hoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
  utimesSync(tree, hoursAgo, hoursAgo);
  utimesSync(join(tree, ".git"), hoursAgo, hoursAgo);

  // The fixture switches maintenance off, which skips the startup sweep too, so this daemon
  // comes back with an hour's interval: the startup pass runs, and no other does here.
  await daemon.crash();
  await daemon.restart({ MISSION_WORKTREE_SWEEP_MS: String(60 * 60_000) });
  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const row = dashboard.getByRole("article", { name: `Unowned tree ${tree}` });
  // Kept for the commit alone: the install state is not the work that kept it.
  await expect(row).toContainText(`Unowned tree ${tree} was kept: checkout has unpublished commits`, { timeout: 60_000 });

  await row.getByRole("button", { name: "Discard and remove" }).click();
  const preview = dashboard.getByRole("dialog", { name: "removeUnowned worktree preview" });
  await expect(preview.getByText(`Discards the work in ${tree}: checkout has unpublished commits.`)).toBeVisible();
  await expect(preview.getByText("Files it deletes include: .yarn/install-state.gz (regenerable).")).toBeVisible();
  await expect(preview).not.toContainText("uncommitted, untracked or ignored work");
  await shoot(dashboard, "13-discard-preview-seed-path-regenerable");

  await preview.getByRole("button", { name: "Cancel" }).click();
  await expect(preview).toHaveCount(0);
  expect(existsSync(join(tree, ".yarn", "install-state.gz"))).toBe(true);
});
