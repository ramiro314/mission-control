import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TerminalTargetView } from "../../src/shared/terminal.ts";
import type { WorktreeActionPreview, WorktreeInventory } from "../../src/shared/worktrees.ts";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

const EVIDENCE = artifactsDir("settings-worktrees");

/**
 * How long an executed cleanup may take to finish in the background.
 *
 * Execute itself answers once the preview is claimed, so the dialog closes at once. The work
 * behind it is real git - a return is a fetch, then a reset of a checkout on disk to the
 * fetched remote default - so this window is about the disk, not about the dialog. Measured
 * at six to eight seconds on a developer's machine.
 */
const EXECUTES_MS = 30_000;

async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-worktrees/${name}.png`);
}

test("safe prune removes conductor scratch while preserving unknown pipeline work", async ({ dashboard, daemon }) => {
  const acquire = async () => {
    const response = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
      data: { repositoryPath: daemon.repo, label: "pipeline scratch regression" },
    });
    expect(response.status()).toBe(201);
    return await response.json() as { path: string; leaseId: string };
  };
  const scratch = await acquire();
  const work = await acquire();
  for (const target of [scratch, work]) {
    const returned = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, {
      data: { leaseId: target.leaseId },
    });
    expect(returned.ok()).toBe(true);
    mkdirSync(join(target.path, ".pipeline"));
    writeFileSync(join(target.path, ".pipeline/.memory-count-at-start"), "0\n");
  }
  writeFileSync(join(work.path, ".pipeline/notes.txt"), "unfinished work\n");

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const pool = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = pool.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const response = dashboard.waitForResponse((result) => result.url().endsWith("/api/worktrees/actions/preview"));
  await pool.getByRole("button", { name: "Preview safe prune" }).click();
  const result = await (await response).json() as WorktreeActionPreview;
  expect(result.affected.map((item) => item.path)).toEqual([scratch.path]);
  expect(result.requiredAcknowledgements).toEqual([]);
  const preview = dashboard.getByRole("dialog", { name: "prune worktree preview" });
  await expect(preview.getByRole("button", { name: "Execute" })).toBeEnabled();
  await expectContentClearsBorder(preview);
  await shoot(dashboard, "12-scratch-safe-prune-preview");
  await preview.getByRole("button", { name: "Execute" }).click();
  await expect(preview).toHaveCount(0);
  await expect(pool.locator(".wt-slot", { hasText: scratch.path })).toHaveCount(0, { timeout: EXECUTES_MS });
  await expect(pool.locator(".wt-slot", { hasText: work.path })).toBeVisible();
  expect(existsSync(scratch.path)).toBe(false);
  expect(existsSync(join(work.path, ".pipeline/notes.txt"))).toBe(true);
  await shoot(dashboard, "13-scratch-pruned-real-work-preserved");

  // With only real work left, the next preview must explain why pruning is unavailable.
  await pool.getByRole("button", { name: "Preview safe prune" }).click();
  await expect(preview.getByText("No clean, merged, process-free, unreferenced slots are safe to prune.")).toBeVisible();
  await expect(preview.getByRole("button", { name: "Execute" })).toBeDisabled();
  await expectContentClearsBorder(preview);
  await shoot(dashboard, "14-real-work-blocks-safe-prune");
});

for (const action of ["destroy", "prune"] as const) {
  test(`${action} executes an idle slot after sibling process churn without refreshing`, async ({ dashboard, daemon }) => {
    const acquire = async (label: string) => {
      const response = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
        data: { repositoryPath: daemon.repo, label },
      });
      expect(response.status()).toBe(201);
      return await response.json() as { path: string; leaseId: string };
    };
    const target = await acquire("idle cleanup target");
    const sibling = await acquire("busy sibling");
    const returned = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, {
      data: { leaseId: target.leaseId },
    });
    expect(returned.ok()).toBe(true);
    const inventory = async () => await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
    const occupants: ReturnType<typeof spawn>[] = [];
    const addOccupant = async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: sibling.path, stdio: "ignore",
      });
      occupants.push(child);
      await once(child, "spawn");
      await expect.poll(async () => (await inventory()).repositories.flatMap((pool) => pool.slots)
        .find((slot) => slot.path === sibling.path)?.processes.count).toBe(occupants.length);
    };
    try {
      await addOccupant();
      await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
      const pool = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
      const disclosure = pool.getByRole("button", { name: /demo-repo/ });
      if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
      const previewResponse = dashboard.waitForResponse((response) => response.url().endsWith("/api/worktrees/actions/preview"));
      if (action === "destroy") {
        await pool.locator(".wt-slot", { hasText: target.path }).getByRole("button", { name: /^Destroy$/ }).click();
      } else {
        await pool.getByRole("button", { name: "Preview safe prune" }).click();
      }
      const original = await (await previewResponse).json() as WorktreeActionPreview;
      expect(original.affected.map((item) => item.path)).toEqual([target.path]);
      const preview = dashboard.getByRole("dialog", { name: `${action} worktree preview` });
      await expect(preview.getByRole("button", { name: "Execute" })).toBeEnabled();
      await expectContentClearsBorder(preview);

      // Force a real occupancy change AFTER the token is minted. Holding both processes
      // alive makes this deterministic, without racing a short-lived child against Git.
      await addOccupant();
      expect((await inventory()).revision).not.toBe(original.inventoryRevision);
      await shoot(dashboard, `10-${action}-sibling-churn-preview`);
      const executed = dashboard.waitForResponse((response) => response.url().endsWith("/api/worktrees/actions/execute"));
      await preview.getByRole("button", { name: "Execute" }).click();
      expect((await executed).status()).toBe(202);
      await expect(preview).toHaveCount(0);
      await expect(pool.locator(".wt-slot", { hasText: target.path })).toHaveCount(0, { timeout: EXECUTES_MS });
      await expect(pool.locator(".wt-slot", { hasText: sibling.path })).toBeVisible();
      expect(existsSync(target.path)).toBe(false);
      expect(existsSync(sibling.path)).toBe(true);
      const remaining = (await inventory()).repositories.flatMap((entry) => entry.slots);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toMatchObject({ path: sibling.path, state: "leased", processes: { count: 2 } });
      await shoot(dashboard, `11-${action}-sibling-churn-complete`);
    } finally {
      await Promise.all(occupants.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }));
    }
  });
}

test("Open terminal refuses a slot that is not idle, leases an idle one as it stands, and offers Return", async ({ dashboard, daemon }) => {
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "open terminal target" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string; baseSha: string };
  const returned = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, {
    data: { leaseId: lease.leaseId },
  });
  expect(returned.ok()).toBe(true);
  const observed = async () => (await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory)
    .repositories.flatMap((pool) => pool.slots).find((slot) => slot.path === lease.path);
  const launches = () => readdirSync(daemon.recordDir).filter((name) => name.startsWith("cmux-")).length;

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const pool = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = pool.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const slot = pool.getByRole("article", { name: "Slot 1" });
  await expect(slot.getByText("available", { exact: true })).toBeVisible();
  await slot.getByLabel("Terminal backend for slot 1").selectOption("cmux");
  const openTerminal = slot.getByRole("button", { name: "Open terminal" });

  // The tooltip warns about the lease only where Open terminal would take one.
  const LEASE_SENTENCE = /Takes a manual lease on this slot as it stands; Return gives it back\./;
  await openTerminal.hover();
  await expect(openTerminal).toHaveAccessibleDescription(LEASE_SENTENCE);

  // An occupied slot is not idle. It is refused with acquisition's reason and nothing opens.
  const occupant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: lease.path, stdio: "ignore" });
  try {
    await once(occupant, "spawn");
    await expect.poll(async () => (await observed())?.processes.count).toBe(1);
    await openTerminal.click();
    await expect(slot.getByText("the slot is not idle: an available slot has process occupancy")).toBeVisible();
    expect(launches()).toBe(0);
    await expect(slot.getByText("available", { exact: true })).toBeVisible();
    await shoot(dashboard, "16-open-terminal-refused");
  } finally {
    const exited = once(occupant, "exit");
    occupant.kill("SIGKILL");
    await exited;
  }
  await expect.poll(async () => (await observed())?.processes.count).toBe(0);

  await openTerminal.click();
  await expect(slot.getByText("leased", { exact: true })).toBeVisible();
  await expect(slot.getByText("Terminal from Settings")).toBeVisible();
  await openTerminal.hover();
  await expect(openTerminal).toHaveAccessibleDescription(/\S/);
  await expect(openTerminal).not.toHaveAccessibleDescription(LEASE_SENTENCE);
  await expect(slot.getByText("the slot is not idle: an available slot has process occupancy")).toHaveCount(0);
  await expect.poll(launches).toBe(1);
  expect((await observed())?.head).toBe(lease.baseSha);
  await shoot(dashboard, "17-open-terminal-leased");

  // The lease goes back the way any manual lease does.
  await slot.getByRole("button", { name: "Return", exact: true }).click();
  const preview = dashboard.getByRole("dialog", { name: "return worktree preview" });
  await expect(preview.getByText(lease.path)).toBeVisible();
  await preview.getByRole("button", { name: "Execute" }).click();
  await expect(preview).toHaveCount(0);
  await expect(slot.getByText("available", { exact: true })).toBeVisible({ timeout: EXECUTES_MS });
  await expect(slot.getByText("Terminal from Settings")).toHaveCount(0);
});

test("a terminal that went away after the page cached it gives the slot back as it was", async ({ dashboard, daemon }) => {
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "stale terminal target" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string; baseSha: string };
  const returned = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, {
    data: { leaseId: lease.leaseId },
  });
  expect(returned.ok()).toBe(true);

  // Only the page's cached list is stale. The daemon that refuses the launch is the real one.
  const { targets } = await (await dashboard.request.get(`${daemon.baseURL}/api/terminal-targets`)).json() as {
    targets: TerminalTargetView[];
  };
  const gone = targets.find((target) => target.unavailable !== null);
  if (!gone?.unavailable) throw new Error("the fixture daemon reports no unavailable terminal to go stale");
  await dashboard.route("**/api/terminal-targets", (route) => route.fulfill({
    json: { targets: targets.map((target) => target.id === gone.id ? { ...target, unavailable: null } : target) },
  }));

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const pool = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = pool.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const slot = pool.getByRole("article", { name: "Slot 1" });
  await slot.getByLabel("Terminal backend for slot 1").selectOption(gone.id);
  const opened = dashboard.waitForResponse((response) => response.url().endsWith("/open"));
  await slot.getByRole("button", { name: "Open terminal" }).click();
  expect((await opened).status()).toBe(409);

  await expect(slot.getByText(gone.unavailable, { exact: true })).toBeVisible();
  await expect(slot.getByText("available", { exact: true })).toBeVisible();
  await expect(slot.getByText("Terminal from Settings")).toHaveCount(0);
  await expect(slot.getByRole("button", { name: "Return", exact: true })).toHaveCount(0);
  const inventory = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
  expect(inventory.repositories.flatMap((entry) => entry.slots).find((entry) => entry.path === lease.path))
    .toMatchObject({ state: "available", owner: null, head: lease.baseSha });
  await shoot(dashboard, "18-open-terminal-launcher-refused");
});

test("Settings Worktrees configures, inventories, previews, blocks, launches, and stays bounded", async ({
  dashboard,
  daemon,
  context,
}) => {
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "settings evidence" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };

  // Search is one route into the same registered category. The result lands on the native
  // inventory anchor, while the direct hash below proves the bookmark grammar too.
  await dashboard.keyboard.press("ControlOrMeta+k");
  await dashboard.getByRole("combobox", { name: "Search everything" }).fill("native worktree pools");
  await dashboard.getByRole("option", { name: /Native worktree pools/ }).click();
  await expect(dashboard).toHaveURL(/#\/settings\/worktrees$/);
  await expect(dashboard.getByRole("tab", { name: /Worktrees/ })).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.getByText(/Mission Control owns these checkouts/)).toBeVisible();

  const repo = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  await expect(repo).toBeVisible();
  await repo.getByRole("button", { name: /demo-repo/ }).click();
  await expect(repo.getByText(lease.path)).toBeVisible();
  await expect(repo.getByText("leased", { exact: true })).toBeVisible();

  // Capacity edits are future-only. The saved one-slot maximum leaves this live lease in
  // place, and a second open dashboard converges through the content-free SSE invalidation.
  const second = await context.newPage();
  await second.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const secondMax = second.getByLabel("Default maximum native slots");

  // This page can only converge through an invalidation it is SUBSCRIBED to, and `goto`
  // resolves long before the stream is up. Editing in the gap sends the one event this
  // page needed while nothing is listening, after which it sits on the value it first
  // fetched and the assertion below waits out its timeout - a race in the fixture, not a
  // regression, and the one that made this spec fail under a loaded machine.
  //
  // Two readiness facts, because they are different claims and only both together close
  // the gap: the value proves this page's own fetch has LANDED (so a pass cannot be it
  // simply never having shown the old number), and the connection segment proves the
  // stream is UP - it is the app's own published state, and it names "reconnecting" for
  // exactly the window in which an invalidation would be dropped.
  const before = (await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json()) as {
    config: { maxSlots: number };
  };
  await expect(secondMax).toHaveValue(String(before.config.maxSlots));
  await expect(
    second.getByRole("button", { name: /^Keep awake - (?!Mission Control is reconnecting)/ }),
  ).toBeVisible();

  const defaultMax = dashboard.getByLabel("Default maximum native slots");
  await defaultMax.fill("4");
  await expect.poll(async () => (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json())
    .toMatchObject({ config: { maxSlots: 4 } });
  await expect(secondMax).toHaveValue("4");
  await second.close();

  // The capacity bar is the pane's answer to "do I have room". Its track width is the
  // configured maximum, so raising it to four leaves this one live lease holding a quarter
  // of the track - and every count on it is restated as text beside it, never by fill alone.
  const bar = repo.getByRole("img");
  await expect(bar).toHaveAttribute("aria-label", "1 leased, 0 available, 0 quarantined, 3 more may be created, maximum 4");
  // All four lifecycle counts are readable as text, zeroes included: the track has no
  // width to draw "0 quarantined" with, and that is exactly why the legend has to say it.
  for (const words of ["1 leased", "0 available", "0 quarantined", "3 more may be created"]) {
    await expect(repo.getByText(words, { exact: true })).toBeVisible();
  }
  await expect(repo.getByText("1 of 4 slots", { exact: true })).toBeVisible();
  await dashboard.getByText(/Mission Control owns these checkouts/).scrollIntoViewIfNeeded();
  await shoot(dashboard, "00-pools-populated");

  // Clipboard feedback and terminal opening both use their established abstractions. The
  // daemon's fake cmux records the latter, so no real external window opens in this suite.
  await repo.getByRole("button", { name: "Copy path" }).click();
  await expect(repo.getByRole("button", { name: "Copied" })).toBeVisible();
  await repo.getByLabel("Terminal backend for slot 1").selectOption("cmux");
  await repo.getByRole("button", { name: "Open terminal" }).click();
  await expect.poll(() => readdirSync(daemon.recordDir).filter((name) => name.startsWith("cmux-")).length).toBe(1);

  // A clean manual lease has an actionable preview, with focus inside the dialog and the
  // fixed server-resolved path visible before execution.
  await repo.getByRole("button", { name: "Return", exact: true }).click();
  const preview = dashboard.getByRole("dialog", { name: "return worktree preview" });
  await expect(preview).toBeVisible();
  await expect(preview.getByText(lease.path)).toBeVisible();
  await expect(preview.getByRole("button", { name: "Execute" })).toBeEnabled();
  await expect(preview.locator(":focus")).toBeVisible();
  // Its Execute/Cancel footer used to carry `.modal-actions`, a class with no CSS rule, so
  // both buttons rendered flush against the panel border.
  await expectContentClearsBorder(preview);
  await shoot(dashboard, "02-actionable-return-preview");
  const staleFile = join(lease.path, "appeared-after-preview.txt");
  writeFileSync(staleFile, "state changed\n");
  // Execute is accepted at once and rechecked in the background. The recheck sees the new
  // file, refuses, and reports it above the pools with the remedy a person needs.
  await preview.getByRole("button", { name: "Execute" }).click();
  await expect(preview).toHaveCount(0);
  const background = dashboard.getByRole("region", { name: "Background cleanup" });
  await expect(background.getByText("State changed after this preview.")).toBeVisible({ timeout: EXECUTES_MS });
  await shoot(dashboard, "15-stale-preview-reported-in-background");
  await background.getByRole("button", { name: "Preview again" }).click();
  await expect(preview.getByText(/Dirty or untracked work will be discarded/)).toBeVisible();
  // The report survives the retry until that retry is executed: cancelling it loses nothing.
  await expect(background.getByText("State changed after this preview.")).toBeVisible();
  await preview.getByRole("button", { name: "Cancel" }).click();
  await expect(background.getByText("State changed after this preview.")).toBeVisible();

  // A dismissal the daemon refuses leaves the report where it was and says so.
  await dashboard.route("**/api/worktrees/operations/*/dismiss", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "worktree operations unavailable" }),
  }));
  // With no confirmed removal the tooltip stays neutral: an owner may already have been recovered.
  await expect(background.getByRole("button", { name: "Dismiss" }))
    .toHaveAccessibleDescription("Hide this report; dismissing it does not undo or retry anything");
  await background.getByRole("button", { name: "Dismiss" }).click();
  await expect(dashboard.getByText("That cleanup report could not be dismissed: worktree operations unavailable")).toBeVisible();
  await expect(background.getByText("State changed after this preview.")).toBeVisible();
  await dashboard.unroute("**/api/worktrees/operations/*/dismiss");
  await background.getByRole("button", { name: "Dismiss" }).click();
  await expect(background).toHaveCount(0);
  unlinkSync(staleFile);

  // A process whose cwd is the leased path is an unacknowledgeable blocker. The preview
  // may name the count, never its command line, and Execute remains unavailable.
  const occupant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: lease.path,
    stdio: "ignore",
  });
  try {
    await dashboard.waitForTimeout(200);
    await repo.getByRole("button", { name: "Return", exact: true }).click();
    const blocked = dashboard.getByRole("dialog", { name: "return worktree preview" });
    await expect(blocked.getByText("Cannot execute")).toBeVisible();
    await expect(blocked.getByText(/Known processes must exit/)).toBeVisible();
    await expect(blocked.getByRole("button", { name: "Execute" })).toBeDisabled();
    await shoot(dashboard, "03-process-blocker");
    await blocked.getByRole("button", { name: "Cancel" }).click();
  } finally {
    occupant.kill("SIGKILL");
  }

  // Legacy capability is isolated from native inventory, which stays fully usable whether
  // this machine has the compatibility binary or not.
  await expect(dashboard.getByRole("heading", { name: "Treehouse", exact: true })).toBeVisible();
  await shoot(dashboard, "01-desktop-inventory-and-legacy", true);

  // A missing binary has a direct remediation and does not erase the native ledger.
  const current = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
  const missingPage = await context.newPage();
  await missingPage.route("**/api/worktrees", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ...current,
      legacy: {
        capability: { kind: "missing", version: null, diagnostic: "Treehouse is not installed; install v2.1.1 or newer to drain historical leases." },
        totals: { ownedExact: 0, identityUnverifiable: 0, foreign: 0, unreadable: 0 },
        items: [],
      },
    } satisfies WorktreeInventory),
  }));
  await missingPage.goto(`${daemon.baseURL}/#/settings/worktrees`);
  await expect(missingPage.getByText(/Treehouse is not installed/)).toBeVisible();
  await expect(missingPage.getByRole("heading", { name: "Pools", exact: true })).toBeVisible();
  await missingPage.close();

  // The built panel renders the complete legacy classification vocabulary. Only an exact
  // persisted owner gets an action; unverifiable, foreign, and unreadable rows stay diagnostic.
  const legacyPage = await context.newPage();
  await legacyPage.route("**/api/worktrees", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ...current,
      legacy: {
        capability: { kind: "conditional-json", version: "v2.1.1", diagnostic: null },
        totals: { ownedExact: 1, identityUnverifiable: 1, foreign: 1, unreadable: 1 },
        items: [
          { id: "legacy-exact", classification: "ownedExact", repoRoot: daemon.repo, path: `${daemon.repo}/.trees/exact`, owner: { kind: "task", id: "task-exact", position: 0 }, leaseId: "lease-exact", holder: "mission-control", acquiredAt: "2026-08-16T12:00:00Z", processes: { state: "known", count: 0, reason: null }, dirty: false, canReturn: true, diagnostic: null },
          { id: "legacy-unverifiable", classification: "identityUnverifiable", repoRoot: daemon.repo, path: `${daemon.repo}/.trees/unverifiable`, owner: { kind: "task", id: "task-old", position: 0 }, leaseId: null, holder: "mission-control", acquiredAt: null, processes: { state: "unknown", count: null, reason: "identity unavailable" }, dirty: null, canReturn: false, diagnostic: "Treehouse cannot prove the historical lease identity." },
          { id: "legacy-foreign", classification: "foreign", repoRoot: daemon.repo, path: `${daemon.repo}/.trees/foreign`, owner: null, leaseId: "lease-foreign", holder: "someone-else", acquiredAt: "2026-08-16T12:00:00Z", processes: { state: "known", count: 0, reason: null }, dirty: false, canReturn: false, diagnostic: "This lease belongs to another holder." },
          { id: "legacy-unreadable", classification: "unreadable", repoRoot: daemon.repo, path: daemon.repo, owner: null, leaseId: null, holder: null, acquiredAt: null, processes: { state: "unknown", count: null, reason: "status unavailable" }, dirty: null, canReturn: false, diagnostic: "Treehouse status could not be read." },
        ],
      },
    } satisfies WorktreeInventory),
  }));
  await legacyPage.goto(`${daemon.baseURL}/#/settings/worktrees`);
  await expect(legacyPage.getByRole("button", { name: "Return legacy lease" })).toHaveCount(1);
  for (const classification of ["identityUnverifiable", "foreign", "unreadable"]) {
    await expect(legacyPage.getByText(classification, { exact: true })).toBeVisible();
  }
  await expect(legacyPage.getByText("Force", { exact: true })).toHaveCount(0);
  await shoot(legacyPage, "05-legacy-classification-gates", true);
  await legacyPage.close();

  // The page itself never overflows sideways. Slot detail owns the bounded horizontal
  // scroll at a narrow viewport, and every policy/legacy card stacks within the pane.
  await dashboard.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => dashboard.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }))).toEqual({ client: 390, scroll: 390 });
  await expect(repo).toBeVisible();
  await shoot(dashboard, "04-narrow-inventory", true);
});

test("refreshing a preview drops acknowledgements that the new token does not require", async ({
  dashboard,
  daemon,
}) => {
  // Two previews and a real return, and a return is `git fetch` plus a reset to the fetched
  // remote default on a checkout on disk. That is seconds of git per Execute, so the default
  // thirty is a budget for the browser and not for the work underneath it.
  test.setTimeout(120_000);
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "acknowledgement refresh" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string };
  const dirtyFile = join(lease.path, "dirty-before-preview.txt");
  writeFileSync(dirtyFile, "preview this risk\n");

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const repo = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  await repo.getByRole("button", { name: /demo-repo/ }).click();
  await repo.getByRole("button", { name: "Return", exact: true }).click();
  const preview = dashboard.getByRole("dialog", { name: "return worktree preview" });
  const dirtyAcknowledgement = preview.getByRole("checkbox", {
    name: /Dirty or untracked work will be discarded/,
  });
  await dirtyAcknowledgement.check();

  unlinkSync(dirtyFile);
  await preview.getByRole("button", { name: "Execute" }).click();
  await expect(preview).toHaveCount(0);
  const background = dashboard.getByRole("region", { name: "Background cleanup" });
  const stale = background.getByText("State changed after this preview.");
  await expect(stale).toBeVisible({ timeout: EXECUTES_MS });
  await background.getByRole("button", { name: "Preview again" }).click();
  await expect(preview.getByRole("button", { name: "Execute" })).toBeEnabled();
  await expect(dirtyAcknowledgement).toHaveCount(0);
  // Revalidation is deliberately conservative. Under full-suite host contention, one of
  // the bounded Git reads can temporarily degrade and produce another honest "changed" even
  // when the checkout did not materially change. Follow the exact recovery offered to a
  // person, while keeping the retry bound low so persistent instability still fails this.
  const slot = repo.locator(".wt-slot", { hasText: lease.path });
  const returned = slot.getByText("available", { exact: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await preview.getByRole("button", { name: "Execute" }).click();
    await expect(preview).toHaveCount(0);
    await expect.poll(async () => {
      if (await returned.isVisible()) return "returned";
      return await stale.isVisible() ? "changed" : "waiting";
    }, { timeout: EXECUTES_MS }).not.toBe("waiting");
    if (await returned.isVisible()) break;
    await background.getByRole("button", { name: "Preview again" }).click();
    await expect(dirtyAcknowledgement).toHaveCount(0);
    await expect(preview.getByRole("button", { name: "Execute" })).toBeEnabled();
  }
  await expect(returned).toBeVisible();
});

test("Destroy reclaims an exactly owned lease that a transient observation quarantined", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "quarantined destroy" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };

  // This is the state from the field failure: an exact active lease remains in the row,
  // but a transient process observation moved the slot to quarantine. The Settings panel
  // deliberately offers Destroy for that state, so Execute must be able to finish it.
  withDaemonDb(daemon, (db) => {
    const changed = db.prepare(
      `UPDATE worktree_slots
          SET state = 'quarantined', version = version + 1,
              quarantine_reason = 'slot process occupancy is unknown',
              last_error = 'cwd listing failed: exit 1'
        WHERE active_lease_id = ? AND state = 'leased'`,
    ).run(lease.leaseId);
    expect(Number(changed.changes)).toBe(1);
  });

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const repo = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = repo.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const slot = repo.locator(".wt-slot", { hasText: lease.path });
  await expect(slot.getByText("quarantined", { exact: true })).toBeVisible();
  await expect(slot.getByText("size unknown", { exact: true })).toBeVisible();
  await slot.getByRole("button", { name: "Destroy", exact: true }).click();

  const preview = dashboard.getByRole("dialog", { name: "destroy worktree preview" });
  await expect(preview.getByText(lease.path)).toBeVisible();
  await expect(preview.getByRole("button", { name: "Execute" })).toBeEnabled();
  await shoot(dashboard, "08-quarantined-destroy-preview");
  await preview.getByRole("button", { name: "Execute" }).click();

  await expect(preview).toHaveCount(0);
  await expect.poll(() => existsSync(lease.path), { timeout: EXECUTES_MS }).toBe(false);
  await expect(repo.getByText("0 of 16 slots", { exact: true })).toBeVisible({ timeout: EXECUTES_MS });
  await shoot(dashboard, "09-quarantined-destroy-complete");
});

/** The executable name is all that names an IDE helper, so `argv0` is the whole fixture. */
test("a slot card names a known occupant and still counts it", async ({ dashboard, daemon }) => {
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "named occupant" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string };
  const script = ["-e", "setInterval(() => {}, 1000)"];
  const named = spawn(process.execPath, script, { cwd: lease.path, stdio: "ignore", argv0: "gopls" });
  const plain = spawn(process.execPath, script, { cwd: lease.path, stdio: "ignore" });
  await Promise.all([once(named, "spawn"), once(plain, "spawn")]);

  try {
    await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
    const repo = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
    const disclosure = repo.getByRole("button", { name: /demo-repo/ });
    if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
    const slot = repo.locator(".wt-slot", { hasText: lease.path });

    const processes = slot.getByRole("region", { name: /^Processes in slot \d+$/ });
    await expect(processes.getByRole("listitem").filter({ hasText: `PID ${named.pid}` }))
      .toContainText("IDE language server");
    const unnamed = processes.getByRole("listitem").filter({ hasText: `PID ${plain.pid}` });
    await expect(unnamed).toBeVisible();
    await expect(unnamed).not.toContainText("IDE language server");
    await unnamed.scrollIntoViewIfNeeded();
    await shoot(dashboard, "16-named-occupant");

    // The name changes nothing the daemon decides: both still count as occupancy.
    const inventory = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
    const row = inventory.repositories.flatMap((repository) => repository.slots).find((one) => one.path === lease.path);
    expect(row?.processes.count).toBe(2);
  } finally {
    named.kill("SIGKILL");
    plain.kill("SIGKILL");
  }
});

/**
 * The card says why a slot is stuck, one fact per line: the quarantine reason and Git's detail
 * (the detail used to be hidden whenever a reason existed), the last automatic-recovery refusal
 * with the exact path that blocked it, and the processes inside the slot with PID, command and
 * start time.
 *
 * The slot, its reason, its detail and its occupant are real: a live manual lease quarantined in
 * the row, and a process started with its working directory in the slot. The refusal is spliced
 * into the daemon's own inventory response, because the e2e daemon runs no maintenance pass and
 * automatic recovery runs nowhere else; `test/worktree-recover.test.ts` proves the pass records
 * it and that inventory carries it.
 */
test("a quarantined slot card shows its reason, detail, last automatic-recovery refusal and occupants on separate lines", async ({
  dashboard,
  daemon,
}) => {
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "quarantine diagnosis" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };
  withDaemonDb(daemon, (db) => {
    const changed = db.prepare(
      `UPDATE worktree_slots
          SET state = 'quarantined', version = version + 1,
              quarantine_reason = 'worktree reset failed',
              last_error = 'git checkout failed: fatal: Unable to create index.lock: File exists'
        WHERE active_lease_id = ? AND state = 'leased'`,
    ).run(lease.leaseId);
    expect(Number(changed.changes)).toBe(1);
  });
  const occupant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: lease.path, stdio: "ignore" });
  await once(occupant, "spawn");
  const pid = occupant.pid!;

  try {
    await dashboard.route("**/api/worktrees", async (route) => {
      const response = await route.fetch();
      const inventory = await response.json() as WorktreeInventory;
      for (const repository of inventory.repositories) {
        for (const slot of repository.slots) {
          if (slot.path !== lease.path) continue;
          slot.recoveryRefusal = {
            at: Date.now(),
            reason: "the slot holds work Recover would discard: untracked notes/draft.md",
            blocking: { kind: "untracked", path: "notes/draft.md" },
          };
        }
      }
      await route.fulfill({ response, json: inventory });
    });
    await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
    const repo = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
    const disclosure = repo.getByRole("button", { name: /demo-repo/ });
    if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
    const slot = repo.locator(".wt-slot", { hasText: lease.path });
    await expect(slot.getByText("quarantined", { exact: true })).toBeVisible();

    const why = slot.getByRole("region", { name: /^Why slot \d+ is quarantined$/ });
    const lines = why.getByRole("definition");
    await expect(lines.filter({ hasText: "worktree reset failed" })).toHaveText("worktree reset failed");
    await expect(lines.filter({ hasText: "git checkout failed" }))
      .toHaveText("git checkout failed: fatal: Unable to create index.lock: File exists");
    await expect(lines.filter({ hasText: /^Refused / }))
      .toContainText("the slot holds work Recover would discard: untracked notes/draft.md");
    await expect(lines.filter({ hasText: /^Blocked by / })).toHaveText("Blocked by untracked file notes/draft.md");
    await expect(why.getByRole("term")).toHaveText(["Reason", "Detail", "Last automatic recovery"]);

    const processes = slot.getByRole("region", { name: /^Processes in slot \d+$/ });
    const row = processes.getByRole("listitem").filter({ hasText: `PID ${pid}` });
    await expect(row).toContainText("setInterval");
    await expect(row).toContainText(`PID ${pid} · started `);
    await row.scrollIntoViewIfNeeded();
    await shoot(dashboard, "15-quarantined-slot-diagnosis");
  } finally {
    occupant.kill("SIGKILL");
    await dashboard.unroute("**/api/worktrees");
  }
});

/**
 * A read that fails, even after its retry, never quarantines: the slot keeps its state and its
 * card says "Last observation failed" with the reason, until a read succeeds.
 *
 * The failure is written into the live lease's row, because a Git read cannot be made to time
 * out under the e2e daemon; `test/worktree-reconciliation.test.ts` proves reconcile writes it
 * there for a listing or a Git read that failed twice. What this proves is the rest of the path:
 * the daemon's inventory carries the note to the card on its own line, beside a state that is
 * still `leased`, and the pool's Reconcile, a real pass whose reads succeed, clears it.
 */
test("a slot whose last observation failed stays leased, says why on its card, and Reconcile clears it", async ({
  dashboard,
  daemon,
}) => {
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "failed observation" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };
  const failure = "slot Git state is unknown (git status timed out after 15 s, and after 30 s on retry)";
  withDaemonDb(daemon, (db) => {
    const changed = db.prepare(
      `UPDATE worktree_slots SET last_error = ? WHERE active_lease_id = ? AND state = 'leased'`,
    ).run(`Last observation failed: ${failure}`, lease.leaseId);
    expect(Number(changed.changes)).toBe(1);
  });

  try {
    await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
    const repo = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
    const disclosure = repo.getByRole("button", { name: /demo-repo/ });
    if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
    const slot = repo.locator(".wt-slot", { hasText: lease.path });
    await expect(slot.getByText("leased", { exact: true })).toBeVisible();
    await expect(slot.getByText("quarantined", { exact: true })).toHaveCount(0);

    const why = slot.getByRole("region", { name: /^Why slot \d+ is leased$/ });
    await expect(why.getByRole("term")).toHaveText(["Last observation failed"]);
    await expect(why.getByRole("definition")).toHaveText(failure);
    await why.scrollIntoViewIfNeeded();
    await shoot(dashboard, "16-last-observation-failed");

    await repo.getByRole("button", { name: "Reconcile", exact: true }).click();
    const preview = dashboard.getByRole("dialog", { name: "reconcile worktree preview" });
    await expect(preview.getByText(/a read that fails leaves each slot as it was/)).toBeVisible();
    await preview.getByRole("button", { name: "Execute" }).click();
    await expect(preview).toHaveCount(0);

    await expect(why).toHaveCount(0, { timeout: EXECUTES_MS });
    await expect(slot.getByText("leased", { exact: true })).toBeVisible();
    await slot.scrollIntoViewIfNeeded();
    await shoot(dashboard, "17-last-observation-cleared");
  } finally {
    await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, { data: { leaseId: lease.leaseId } });
  }
});

/**
 * A slot's History is what the store wrote in the same transaction as each change, so everything
 * here but the paged rows comes from real transitions: a lease and its return, a real Reconcile
 * quarantining a slot that was made dirty, and a new lease while the disclosure is open. The
 * rows that prove paging are written directly, because reaching 50 entries for real would mean
 * dozens of real resets; `test/worktree-history.test.ts` proves the page bounds at the route.
 */
test("a slot card's History lists what happened to the slot, newest first, and pages back", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  const acquire = async (label: string) => {
    const response = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
      data: { repositoryPath: daemon.repo, label },
    });
    expect(response.status()).toBe(201);
    return await response.json() as { path: string; leaseId: string };
  };
  const lease = await acquire("history");
  const returned = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, {
    data: { leaseId: lease.leaseId },
  });
  expect(returned.ok()).toBe(true);

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const repo = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = repo.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const slot = repo.locator(".wt-slot", { hasText: lease.path });
  const history = slot.getByRole("region", { name: /^Slot \d+ history$/ });
  const toggle = history.getByRole("button", { name: "History" });
  const entries = history.getByRole("listitem");

  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAccessibleDescription("Show what happened to this slot, newest first");
  await expect(entries).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAccessibleDescription("Hide this slot's history");

  await expect(entries).toHaveCount(5);
  await expect(entries.nth(0)).toContainText("returning → available");
  await expect(entries.nth(0)).toContainText("returned to the pool");
  await expect(entries.nth(0)).toContainText("by its owner");
  await expect(entries.nth(1)).toContainText("leased → returning");
  await expect(entries.nth(2)).toContainText("Provisioned: new slot in");
  await expect(entries.nth(3)).toContainText("provisioning → leased");
  await expect(entries.nth(3)).toContainText("lease granted to manual:");
  await expect(entries.nth(4)).toContainText("new → provisioning");

  // A real fault, from a real pass: the open list follows the slot without being reopened.
  writeFileSync(join(lease.path, "stray.txt"), "left behind in an available slot\n");
  await repo.getByRole("button", { name: "Reconcile", exact: true }).click();
  const preview = dashboard.getByRole("dialog", { name: "reconcile worktree preview" });
  await preview.getByRole("button", { name: "Execute" }).click();
  await expect(preview).toHaveCount(0);
  await expect(slot.getByText("quarantined", { exact: true })).toBeVisible({ timeout: EXECUTES_MS });
  await expect(entries).toHaveCount(6);
  await expect(entries.nth(0)).toContainText("available → quarantined");
  await expect(entries.nth(0)).toContainText("available slot is dirty");
  await expect(entries.nth(0)).toContainText("automatic");
  await history.scrollIntoViewIfNeeded();
  await shoot(dashboard, "25-slot-history");

  withDaemonDb(daemon, (db) => {
    const row = db.prepare(`SELECT id, pool_id, ordinal FROM worktree_slots WHERE path = ?`).get(lease.path) as
      { id: string; pool_id: string; ordinal: number };
    const insert = db.prepare(
      `INSERT INTO worktree_slot_history (pool_id, slot_id, ordinal, at, kind, reason, actor)
       VALUES (?, ?, ?, ?, 'observation', ?, 'automatic')`,
    );
    for (let index = 1; index <= 60; index += 1) insert.run(row.pool_id, row.id, row.ordinal, Date.now(), `paged row ${index}`);
  });
  await toggle.click();
  await toggle.click();
  await expect(entries).toHaveCount(50);
  await expect(entries.nth(0)).toContainText("paged row 60");
  await expect(history.getByRole("button", { name: "Show older" }))
    .toHaveAccessibleDescription("Load the next older entries of this slot's history");
  await history.getByRole("button", { name: "Show older" }).click();
  await expect(entries).toHaveCount(66);
  await expect(entries.nth(65)).toContainText("new → provisioning");
  await expect(history.getByRole("button", { name: "Show older" })).toHaveCount(0);
});

/**
 * A failed read raises no version, so this is the only change an open list hears about through
 * the slot's failed-read note. The failure is real: a slot whose `.git` file no longer points at
 * a repository cannot be read, and Reconcile's Git inspection fails twice and keeps the lease.
 */
test("an open History picks up a failed read as it starts and as it clears", async ({ dashboard, daemon }) => {
  test.setTimeout(120_000);
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "history failed read" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };
  const dotGit = join(lease.path, ".git");
  const original = readFileSync(dotGit, "utf8");

  try {
    await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
    const repo = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
    const disclosure = repo.getByRole("button", { name: /demo-repo/ });
    if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
    const slot = repo.locator(".wt-slot", { hasText: lease.path });
    const history = slot.getByRole("region", { name: /^Slot \d+ history$/ });
    const entries = history.getByRole("listitem");
    const reconcile = async () => {
      await repo.getByRole("button", { name: "Reconcile", exact: true }).click();
      const preview = dashboard.getByRole("dialog", { name: "reconcile worktree preview" });
      await preview.getByRole("button", { name: "Execute" }).click();
      await expect(preview).toHaveCount(0);
    };

    await history.getByRole("button", { name: "History" }).click();
    await expect(entries).toHaveCount(3);

    writeFileSync(dotGit, "not a gitdir pointer\n");
    await reconcile();
    await expect(entries).toHaveCount(4, { timeout: EXECUTES_MS });
    await expect(entries.nth(0)).toContainText("Failed read");
    await expect(entries.nth(0)).toContainText("slot Git state is unknown");
    await expect(slot.getByText("leased", { exact: true })).toBeVisible();

    writeFileSync(dotGit, original);
    await reconcile();
    await expect(entries).toHaveCount(5, { timeout: EXECUTES_MS });
    await expect(entries.nth(0)).toContainText("Failed read cleared");
  } finally {
    writeFileSync(dotGit, original);
    await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, { data: { leaseId: lease.leaseId } });
  }
});

/**
 * Two facts about one real Return, clicked in Settings. A closed card asks the daemon for nothing,
 * even as its slot changes under it, so a pool of closed cards costs no reads. The rows then name
 * the operator who clicked, not the manual owner the lease belongs to.
 */
test("a closed History reads nothing, and a Return from Settings is recorded as the operator's", async ({
  dashboard,
  daemon,
}) => {
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "history operator return" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };
  let reads = 0;
  dashboard.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/history")) reads += 1;
  });

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const repo = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = repo.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const slot = repo.locator(".wt-slot", { hasText: lease.path });
  await expect(slot.getByText("leased", { exact: true })).toBeVisible();

  await slot.getByRole("button", { name: "Return", exact: true }).click();
  const preview = dashboard.getByRole("dialog", { name: "return worktree preview" });
  await preview.getByRole("button", { name: "Execute" }).click();
  await expect(preview).toHaveCount(0);
  await expect(slot.getByText("available", { exact: true })).toBeVisible({ timeout: EXECUTES_MS });
  expect(reads, "the slot changed while its History was closed").toBe(0);

  const history = slot.getByRole("region", { name: /^Slot \d+ history$/ });
  const entries = history.getByRole("listitem");
  await history.getByRole("button", { name: "History" }).click();
  await expect(entries).toHaveCount(5);
  expect(reads).toBe(1);
  await expect(entries.nth(0)).toContainText("returning → available");
  await expect(entries.nth(0)).toContainText("by the operator");
  await expect(entries.nth(1)).toContainText("leased → returning");
  await expect(entries.nth(1)).toContainText("by the operator");
});

/**
 * The timings a card and its pool row show, from a real claim and a real new slot. The rows that
 * prove a seed hit and the ten-slot window are written directly: an idle sibling is leased in
 * preference to a new slot, so a real hit is a race, and copy-on-write needs a volume that can
 * clone. `test/worktree-history.test.ts` drives a real seed, and proves the summary's arithmetic.
 */
test("a slot card shows its last timings and seed outcome, and the pool row its median and hit rate", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  const firstLease = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "timings before a claim" },
  });
  expect(firstLease.status()).toBe(201);
  const inventory = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
  const saved = await dashboard.request.put(`${daemon.baseURL}/api/worktrees/config`, {
    data: {
      repositories: {
        [inventory.repositories.find((pool) => pool.name === "demo-repo")!.commonDirectory]: {
          claim: { steps: [{ argv: [process.execPath, "-e", "process.exit(0)"], env: [] }], timeoutMinutes: 5, fingerprintPaths: [] },
        },
      },
    },
  });
  expect(saved.status()).toBe(200);

  // The first slot is still held, so this lease makes a new one and runs the claim in it.
  const accepted = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "timings" },
  });
  expect(accepted.status()).toBe(202);
  const { requestId } = await accepted.json() as { requestId: string };
  let leasePath = "";
  await expect.poll(async () => {
    const view = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees/manual/requests/${requestId}`)).json() as
      { state: string; lease?: { path: string } };
    leasePath = view.lease?.path ?? "";
    return view.state;
  }, { timeout: EXECUTES_MS }).toBe("granted");

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const repo = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  const slot = repo.locator(".wt-slot", { hasText: leasePath });
  const disclosure = repo.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const timings = slot.getByLabel(/^Slot \d+ timings$/);
  await expect(timings.getByRole("definition").nth(0)).toHaveText(/^new slot in \d+/);
  await expect(timings.getByRole("definition").nth(1)).toHaveText(/^succeeded in \d+/);
  await expect(timings.getByRole("definition").nth(2)).toHaveText("none: the pool's claim configures no seed");
  await expect(repo.getByText(/^Median new slot \d+.* · seed hit rate 0% \(0 of last 2 new slots\)$/)).toBeVisible();

  const history = slot.getByRole("region", { name: /^Slot \d+ history$/ });
  await history.getByRole("button", { name: "History" }).click();
  const entries = history.getByRole("listitem");
  await expect(entries.nth(0)).toContainText(/Provisioned: new slot in \d+/);
  await expect(entries.nth(0)).toContainText("by its owner");
  await expect(entries.filter({ hasText: /Claim: succeeded in \d+/ })).toHaveCount(1);
  const noSeed = entries.filter({ hasText: "Seed: none" });
  await expect(noSeed).toContainText("the pool's claim configures no seed");

  withDaemonDb(daemon, (db) => {
    const row = db.prepare(`SELECT id, pool_id, ordinal FROM worktree_slots WHERE path = ?`).get(leasePath) as
      { id: string; pool_id: string; ordinal: number };
    const insert = db.prepare(
      `INSERT INTO worktree_slot_history (pool_id, slot_id, ordinal, at, kind, outcome, actor, duration_ms, meta)
       VALUES (?, ?, ?, ?, ?, ?, 'owner', ?, ?)`,
    );
    const now = Date.now();
    for (let index = 1; index <= 10; index += 1) {
      const slotId = `written-slot-${index}`;
      if (index <= 3) insert.run(row.pool_id, slotId, 50 + index, now, "seed", "placed", 1_000, null);
      insert.run(row.pool_id, slotId, 50 + index, now, "provisioning", "new", index * 60_000, null);
    }
    insert.run(row.pool_id, row.id, row.ordinal, now, "seed", "placed", 12_000, JSON.stringify({ sourceOrdinal: 7 }));
  });
  await dashboard.reload();
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  await expect(timings.getByRole("definition").nth(2)).toHaveText("from slot 7 in 12s");
  await expect(repo.getByText("Median new slot 5m 30s · seed hit rate 30% (3 of last 10 new slots)")).toBeVisible();
  await history.getByRole("button", { name: "History" }).click();
  await expect(entries.nth(0)).toContainText("Seed: from slot 7 in 12s");
  await slot.scrollIntoViewIfNeeded();
  await shoot(dashboard, "26-slot-timings");
  await repo.getByText("Median new slot 5m 30s").scrollIntoViewIfNeeded();
  await shoot(dashboard, "27-pool-timings");
});

/**
 * History open at 60 written rows with its older page held in flight, for the two ways a refresh
 * can land under it. The refresh in each is real: a Return, whose two rows push the row at the
 * cursor off the end of the newest page. Only the rows that give the list more pages are written
 * directly.
 */
async function historyWithOlderPageHeld(dashboard: Page, daemon: DaemonHandle) {
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "history refresh race" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };
  const seed = (from: number, to: number) => withDaemonDb(daemon, (db) => {
    const row = db.prepare(`SELECT id, pool_id, ordinal FROM worktree_slots WHERE path = ?`).get(lease.path) as
      { id: string; pool_id: string; ordinal: number };
    const insert = db.prepare(
      `INSERT INTO worktree_slot_history (pool_id, slot_id, ordinal, at, kind, reason, actor)
       VALUES (?, ?, ?, ?, 'observation', ?, 'automatic')`,
    );
    for (let index = from; index <= to; index += 1) insert.run(row.pool_id, row.id, row.ordinal, Date.now(), `paged row ${index}`);
  });
  seed(1, 60);

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const repo = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = repo.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const history = repo.locator(".wt-slot", { hasText: lease.path }).getByRole("region", { name: /^Slot \d+ history$/ });
  const entries = history.getByRole("listitem");
  await history.getByRole("button", { name: "History" }).click();
  await expect(entries).toHaveCount(50);

  const olderPage = (url: URL) => url.pathname.endsWith("/history") && url.searchParams.has("before");
  let openRoute = () => {};
  const opened = new Promise<void>((resolve) => { openRoute = resolve; });
  await dashboard.route(olderPage, async (route) => {
    await opened;
    await route.continue();
  });
  const older = history.getByRole("button", { name: "Show older" });
  const held = dashboard.waitForRequest((request) => olderPage(new URL(request.url())));
  await older.click();
  await held;

  return {
    entries,
    older,
    seed,
    /** The real Return, and the refresh it causes reaching the open list. */
    refresh: async () => {
      const returned = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, {
        data: { leaseId: lease.leaseId },
      });
      expect(returned.ok()).toBe(true);
      await expect(entries.nth(0)).toContainText("returning → available", { timeout: EXECUTES_MS });
    },
    /** Let the held older page answer, and wait until the card has dealt with it. */
    answerOlder: async () => {
      const answered = dashboard.waitForResponse((response) => olderPage(new URL(response.url())));
      openRoute();
      await answered;
      await dashboard.unroute(olderPage);
    },
    pagedRows: async () => (await entries.allTextContents())
      .flatMap((text) => /paged row (\d+)/.exec(text)?.[1] ?? [])
      .map(Number),
  };
}

test("a refresh that lands during Show older leaves every row in the list once, in order", async ({
  dashboard,
  daemon,
}) => {
  const held = await historyWithOlderPageHeld(dashboard, daemon);
  await held.refresh();
  await held.answerOlder();

  await expect(held.entries).toHaveCount(65);
  expect(await held.pagedRows()).toEqual(Array.from({ length: 60 }, (_, index) => 60 - index));
  await expect(held.entries.nth(64)).toContainText("new → provisioning");
  await expect(held.older).toHaveCount(0);
});

test("an older page that answers after a refresh started the list again is dropped, not spliced in", async ({
  dashboard,
  daemon,
}) => {
  const held = await historyWithOlderPageHeld(dashboard, daemon);
  // More new rows than a page holds, so the refreshed page cannot reach the list it replaces.
  held.seed(61, 120);
  await held.refresh();
  await expect(held.entries).toHaveCount(50);
  await held.answerOlder();

  await expect(held.older).toBeEnabled();
  await expect(held.entries).toHaveCount(50);
  const downFrom = (first: number, length: number) => Array.from({ length }, (_, index) => first - index);
  expect(await held.pagedRows()).toEqual(downFrom(120, 48));

  await held.older.click();
  await expect(held.entries).toHaveCount(100);
  expect(await held.pagedRows()).toEqual(downFrom(120, 98));
});

/**
 * The states of History that hold no list of real rows. A slot that predates the table is real:
 * its rows are deleted, as a slot leased before this shipped never had any. A read that fails
 * cannot be produced from the daemon, so those replies are routed, and each is judged by what the
 * browser's own schema check and the card do with it.
 */
test("History says when a slot has no entries, and when its read or an older page fails", async ({
  dashboard,
  daemon,
}) => {
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "history states" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };
  const { id: slotId, pool_id: poolId, ordinal } = withDaemonDb(daemon, (db) => {
    const row = db.prepare(`SELECT id, pool_id, ordinal FROM worktree_slots WHERE path = ?`).get(lease.path) as
      { id: string; pool_id: string; ordinal: number };
    db.prepare(`DELETE FROM worktree_slot_history WHERE slot_id = ?`).run(row.id);
    return row;
  });

  try {
    await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
    const repo = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
    const disclosure = repo.getByRole("button", { name: /demo-repo/ });
    if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
    const slot = repo.locator(".wt-slot", { hasText: lease.path });
    const history = slot.getByRole("region", { name: /^Slot \d+ history$/ });
    const toggle = history.getByRole("button", { name: "History" });
    const entries = history.getByRole("listitem");
    const unreadable = history.getByText("This slot's history could not be read.");
    const empty = history.getByText("Nothing recorded for this slot yet.");
    const reading = history.getByText("Reading this slot's history…");
    const reopen = async () => {
      await toggle.click();
      await toggle.click();
    };
    const firstPage = (url: URL) => url.pathname.endsWith("/history") && !url.searchParams.has("before");

    // The first read of all fails: only the failure shows, with nothing to imply a read or a result.
    await dashboard.route(firstPage, (route) => route.fulfill({ status: 500, json: { error: "database is busy" } }));
    await toggle.click();
    await expect(unreadable).toBeVisible();
    await expect(reading).toHaveCount(0);
    await expect(empty).toHaveCount(0);
    await dashboard.unroute(firstPage);

    await reopen();
    await expect(empty).toBeVisible();
    await expect(unreadable).toHaveCount(0);

    // A re-read that fails must not keep saying the slot has no history: that is no longer known.
    await dashboard.route(firstPage, (route) => route.fulfill({ status: 500, json: { error: "database is busy" } }));
    await reopen();
    await expect(unreadable).toBeVisible();
    await expect(empty).toHaveCount(0);
    await dashboard.unroute(firstPage);

    await dashboard.route(firstPage, (route) => route.fulfill({ json: { entries: "not a list", nextBefore: null } }));
    await reopen();
    await expect(unreadable).toBeVisible();
    await expect(empty).toHaveCount(0);
    await dashboard.unroute(firstPage);

    await reopen();
    await expect(empty).toBeVisible();
    await expect(unreadable).toHaveCount(0, { timeout: 5_000 });

    // An older page that fails keeps what is shown, says so, and can be asked for again.
    withDaemonDb(daemon, (db) => {
      const insert = db.prepare(
        `INSERT INTO worktree_slot_history (pool_id, slot_id, ordinal, at, kind, reason, actor)
         VALUES (?, ?, ?, ?, 'observation', ?, 'automatic')`,
      );
      for (let index = 1; index <= 51; index += 1) insert.run(poolId, slotId, ordinal, Date.now(), `paged row ${index}`);
    });
    await reopen();
    await expect(entries).toHaveCount(50);
    const olderPage = (url: URL) => url.pathname.endsWith("/history") && url.searchParams.has("before");
    await dashboard.route(olderPage, (route) => route.fulfill({ status: 500, json: { error: "database is busy" } }));
    const older = history.getByRole("button", { name: "Show older" });
    await older.click();
    await expect(unreadable).toBeVisible();
    await expect(entries).toHaveCount(50);
    await dashboard.unroute(olderPage);
    await expect(older).toBeEnabled();
    await older.click();
    await expect(entries).toHaveCount(51);
    await expect(entries.nth(50)).toContainText("paged row 1");
    await expect(unreadable).toHaveCount(0);
    await expect(older).toHaveCount(0);
  } finally {
    await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, { data: { leaseId: lease.leaseId } });
  }
});

/**
 * The three states the pane used to render as a heading over nothing, plus the one state
 * a number input cannot express.
 *
 * Loading, empty, and unavailable are three distinguishable conditions on the wire and
 * must look like three different things: an outage and an empty machine especially must
 * never read alike. Over capacity is driven from a routed inventory rather than the live
 * one because the only way to reach it for real is a maximum below the live slot count,
 * and the input's floor is one - which is the point, since lowering the maximum is allowed
 * to make the state visible and is never allowed to prune to fix it.
 *
 * The right-size preview at the end goes to the real daemon with the real pool id, so the
 * unchanged preview-first protocol is proved under the new presentation.
 */
test("Settings Worktrees gives loading, empty, unavailable, and over capacity real copy", async ({
  dashboard,
  daemon,
  context,
}) => {
  // A pool exists only once something has needed a checkout, which is the empty state's
  // whole point - so acquire one lease first and read the real inventory back.
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "capacity states" },
  });
  expect(acquired.status()).toBe(201);
  const current = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
  const pool = current.repositories[0];
  expect(pool).toBeDefined();

  // Loading: the group has shape - skeleton rows and a sentence - before the fetch lands.
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slowPage = await context.newPage();
  await slowPage.route("**/api/worktrees", async (route) => {
    await gate;
    await route.continue();
  });
  await slowPage.goto(`${daemon.baseURL}/#/settings/worktrees`);
  await expect(slowPage.getByRole("heading", { name: "Pools", exact: true })).toBeVisible();
  await expect(slowPage.getByText("Observing Git, process, and provider state…")).toBeVisible();
  await expect(slowPage.locator(".wt-skeleton")).toHaveCount(2);
  await shoot(slowPage, "06-pools-loading");
  release();
  await expect(slowPage.getByText("Observing Git, process, and provider state…")).toHaveCount(0);
  await slowPage.close();

  // Empty: an invitation to act, not a report of absence.
  const emptyPage = await context.newPage();
  await emptyPage.route("**/api/worktrees", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ ...current, repositories: [] } satisfies WorktreeInventory),
  }));
  await emptyPage.goto(`${daemon.baseURL}/#/settings/worktrees`);
  await expect(emptyPage.getByText("No pools yet.")).toBeVisible();
  await expect(emptyPage.getByText(/the first time something needs a checkout in a repository/)).toBeVisible();
  await shoot(emptyPage, "07-pools-empty");
  await emptyPage.close();

  // Unavailable: says the state could not be observed and offers Refresh. It must not
  // claim zero pools, which is what an operator would act on by creating one.
  const downPage = await context.newPage();
  await downPage.route("**/api/worktrees", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await downPage.goto(`${daemon.baseURL}/#/settings/worktrees`);
  await expect(downPage.getByText("Pool capacity could not be observed.")).toBeVisible();
  await expect(downPage.getByText(/This is an outage, not an empty machine/)).toBeVisible();
  await expect(downPage.getByRole("button", { name: "Refresh" })).toBeEnabled();
  await expect(downPage.getByText("No pools yet.")).toHaveCount(0);
  await shoot(downPage, "09-pools-unavailable");
  await downPage.close();

  // Over capacity: labelled in words on the bar, in the legend, and in the row's sentence.
  const overPage = await context.newPage();
  await overPage.route("**/api/worktrees", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ...current,
      repositories: [{
        ...pool!,
        status: "attention",
        policy: { ...pool!.policy, maxSlots: 16 },
        counts: { total: 18, leased: 17, available: 0, quarantined: 1, overCapacity: 2 },
      }],
    } satisfies WorktreeInventory),
  }));
  await overPage.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const overRow = overPage.locator(".wt-pool", { hasText: "demo-repo" });
  await expect(overRow.getByRole("img", { name: "17 leased, 0 available, 1 quarantined, 0 more may be created, 2 over the maximum, maximum 16" })).toBeVisible();
  for (const words of ["17 leased", "0 available", "1 quarantined", "0 more may be created", "2 over the maximum"]) {
    await expect(overRow.getByText(words, { exact: true })).toBeVisible();
  }
  await expect(overRow.getByText(/2 slots are over the maximum of 16\. Nothing was pruned to say so\./)).toBeVisible();
  await shoot(overPage, "08-pool-over-capacity");

  // The track is the configured maximum, so 17 leased against a ceiling of 16 saturates it
  // rather than rescaling it to the 18 slots that exist. The spill is the fixed-width cap
  // at the track's end plus the counts in words above - never a wider bar.
  await expect.poll(() => overRow.locator(".wt-bar-seg").evaluateAll(
    (nodes) => nodes.map((node) => (node as HTMLElement).style.width),
  )).toEqual(["100%"]);
  await expect(overRow.locator(".wt-bar-over")).toHaveCSS("width", "13px");

  // The row's own remedy is preview-first against the real pool, and cancelling changes
  // nothing - the same protocol the rest of this pane has always used.
  await overRow.getByRole("button", { name: "Preview right-size" }).click();
  const rightSize = overPage.getByRole("dialog", { name: "prune worktree preview" });
  await expect(rightSize).toBeVisible();
  await expect(rightSize.getByRole("heading", { name: /Prune worktree/ })).toBeVisible();
  await rightSize.getByRole("button", { name: "Cancel" }).click();
  await expect(rightSize).toHaveCount(0);
  await expect(overRow.getByRole("button", { name: "Preview right-size" })).toBeFocused();
  await overPage.close();
});

/**
 * A refresh that fails is not an outage, and must not be drawn as one.
 *
 * The panel greys every control on `!config` and falls the maximum-slots box back to a
 * hardcoded 16. So discarding a good inventory because ONE refresh failed does not merely
 * lose detail - it tells an operator whose maximum is 4 that their maximum is 16, in an
 * enabled-looking number field, with no marker saying the value is a placeholder. That is
 * the failure worth a spec: not "the panel went blank", but "the panel lied about a
 * setting". The real outage state - never having observed anything - still has to read as
 * an outage, which is the second half of this test.
 */
test("a failed refresh keeps the observed inventory instead of blanking it to a placeholder", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const maxSlots = dashboard.getByLabel("Default maximum native slots");
  await expect(maxSlots).toBeEnabled();
  await maxSlots.fill("4");
  await expect
    .poll(async () => (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json())
    .toMatchObject({ config: { maxSlots: 4 } });
  await expect(maxSlots).toHaveValue("4");

  // Exactly one refresh fails, the way a busy daemon drops one.
  let failures = 0;
  await dashboard.route("**/api/worktrees", async (route) => {
    if (route.request().method() === "GET" && failures === 0) {
      failures += 1;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  // "Refresh" is the button's own text; the long sentence beside it is a Tooltip, which
  // renders as `aria-describedby` and is deliberately NOT the accessible name.
  await dashboard.getByRole("button", { name: "Refresh", exact: true }).click();

  // The number the operator set is still the number on screen, and still editable. The
  // banner says the refresh failed - above data the panel still trusts, not instead of it.
  await expect(maxSlots).toHaveValue("4");
  await expect(maxSlots).toBeEnabled();
  await expect(dashboard.getByText("Worktree inventory is unavailable.")).toBeVisible();
  await expect(dashboard.getByText("Pool capacity could not be observed.")).toHaveCount(0);
});

/**
 * Bulk cleanup is one selection, one preview, one Execute, and no waiting on the dialog.
 *
 * Execute answers once the preview is claimed, so the dialog closing is not evidence the
 * work happened; the slots disappearing from the pool, and from disk, is. An unselected
 * sibling in the same pool proves the fixed set is exactly what was ticked.
 */
test("bulk destroy removes exactly the selected slots in the background", async ({ dashboard, daemon, context }) => {
  test.setTimeout(120_000);
  const leases: Array<{ path: string; leaseId: string }> = [];
  for (const label of ["bulk one", "bulk two", "bulk kept"]) {
    const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
      data: { repositoryPath: daemon.repo, label },
    });
    expect(acquired.status()).toBe(201);
    leases.push(await acquired.json() as { path: string; leaseId: string });
  }
  for (const lease of leases) {
    const returned = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, {
      data: { leaseId: lease.leaseId },
    });
    expect(returned.ok()).toBe(true);
  }
  const [first, second, kept] = leases;

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const pool = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = pool.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();

  const bulk = dashboard.getByRole("region", { name: "Bulk destroy selection" });
  await expect(bulk).toHaveCount(0);
  for (const lease of [first!, second!]) {
    await pool.locator(".wt-slot", { hasText: lease.path }).getByRole("checkbox", { name: /for bulk destroy/ }).check();
  }
  await expect(bulk.getByText("2 slots selected")).toBeVisible();

  // Select all adds the sibling, and deselecting it again leaves the two chosen slots.
  await pool.getByRole("button", { name: "Select all slots" }).click();
  await expect(bulk.getByText("3 slots selected")).toBeVisible();
  await pool.getByRole("button", { name: "Deselect all slots" }).click();
  await expect(bulk).toHaveCount(0);
  for (const lease of [first!, second!]) {
    await pool.locator(".wt-slot", { hasText: lease.path }).getByRole("checkbox", { name: /for bulk destroy/ }).check();
  }
  await shoot(dashboard, "16-bulk-selection");

  await bulk.getByRole("button", { name: "Destroy selected" }).click();
  const preview = dashboard.getByRole("dialog", { name: "destroy worktree preview" });
  await expect(preview.getByRole("heading", { name: "Destroy 2 selected worktrees" })).toBeVisible();
  await expect(preview.getByText(first!.path)).toBeVisible();
  await expect(preview.getByText(second!.path)).toBeVisible();
  await expect(preview.getByText(kept!.path)).toHaveCount(0);
  await expectContentClearsBorder(preview);
  await shoot(dashboard, "17-bulk-destroy-preview");

  // Hold this page's inventory refreshes for a moment so the accepted work is still on
  // screen when it is captured: the daemon removes two small fixture slots faster than a
  // screenshot. What renders meanwhile is the operation the real 202 returned.
  let releaseInventory = (): void => {};
  const inventoryHeld = new Promise<void>((resolve) => {
    releaseInventory = resolve;
  });
  await dashboard.route("**/api/worktrees", async (route) => {
    if (route.request().method() === "GET") await inventoryHeld;
    await route.continue();
  });
  const executed = dashboard.waitForResponse((response) => response.url().endsWith("/api/worktrees/actions/execute"));
  await preview.getByRole("button", { name: "Execute" }).click();
  expect((await executed).status()).toBe(202);
  await expect(preview).toHaveCount(0);
  await expect(bulk).toHaveCount(0);
  const background = dashboard.getByRole("region", { name: "Background cleanup" });
  await expect(background.getByText("2 worktrees")).toBeVisible();
  await expect(background.getByText(/^(queued|in progress)$/)).toBeVisible();
  for (const lease of [first!, second!]) {
    await expect(pool.locator(".wt-slot", { hasText: lease.path }).getByText(/^destroy (queued|in progress)$/)).toBeVisible();
  }
  await shoot(dashboard, "17b-bulk-destroy-queued-in-background");
  // Released, the route is a pass-through; removing it would orphan the held requests.
  releaseInventory();

  for (const lease of [first!, second!]) {
    await expect(pool.locator(".wt-slot", { hasText: lease.path })).toHaveCount(0, { timeout: EXECUTES_MS });
    expect(existsSync(lease.path)).toBe(false);
  }
  await expect(pool.locator(".wt-slot", { hasText: kept!.path })).toBeVisible();
  expect(existsSync(kept!.path)).toBe(true);
  await expect(dashboard.getByRole("region", { name: "Background cleanup" })).toHaveCount(0);
  await shoot(dashboard, "18-bulk-destroy-complete");

  // While a cleanup is still queued, its slot says so and offers nothing that could race it.
  // The daemon finishes too fast to catch that window reliably, so it is driven from a
  // routed inventory carrying one queued operation against the surviving slot.
  const current = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
  const survivor = current.repositories.flatMap((repo) => repo.slots).find((slot) => slot.path === kept!.path)!;
  const pendingPage = await context.newPage();
  await pendingPage.route("**/api/worktrees", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ...current,
      operations: [{
        id: "queued-destroy",
        request: { action: "destroy", target: { kind: "slot", slotId: survivor.id } },
        state: "queued",
        targets: [{ provider: "mission", id: survivor.id, path: survivor.path }],
        error: null,
        changed: false,
        removals: [{ id: survivor.id, path: survivor.path }],
        completed: [],
        queuedAt: Date.now(),
        finishedAt: null,
      }, {
        // Returning one task-owned slot also touches the task's other repositories.
        id: "queued-task-return",
        request: { action: "return", slotId: "task-owned-slot" },
        state: "queued",
        targets: [
          { provider: "git", id: "task-repo-1", path: "/work/task/secondary-repo" },
          { provider: "mission", id: "task-owned-slot", path: "/work/pool/task-owned" },
        ],
        error: null,
        changed: false,
        removals: [],
        completed: [],
        queuedAt: Date.now(),
        finishedAt: null,
      }],
    } satisfies WorktreeInventory),
  }));
  await pendingPage.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const pendingPool = pendingPage.locator(".wt-pool", { hasText: "demo-repo" });
  const pendingDisclosure = pendingPool.getByRole("button", { name: /demo-repo/ });
  if (await pendingDisclosure.getAttribute("aria-expanded") !== "true") await pendingDisclosure.click();
  const pendingSlot = pendingPool.locator(".wt-slot", { hasText: survivor.path });
  await expect(pendingPage.getByRole("region", { name: "Background cleanup" }).getByText(survivor.path, { exact: true })).toBeVisible();
  await expect(pendingSlot.getByText("destroy queued", { exact: true })).toBeVisible();
  const taskReturn = pendingPage.getByRole("region", { name: "Background cleanup" });
  await expect(taskReturn.getByText("/work/pool/task-owned (+1 affected path)")).toBeVisible();
  await expect(taskReturn.getByText("2 worktrees")).toHaveCount(0);
  await expect(pendingSlot.getByRole("checkbox", { name: /for bulk destroy/ })).toBeDisabled();
  await expect(pendingSlot.getByRole("button", { name: "Destroy", exact: true })).toHaveCount(0);
  await shoot(pendingPage, "19-queued-cleanup-pending");
  await pendingPage.close();

  // A bulk destroy that stopped partway says which worktrees are already gone, and Preview
  // again asks only for what it left in place - never for a slot it removed.
  const partialPage = await context.newPage();
  await partialPage.route("**/api/worktrees", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ...current,
      operations: [{
        id: "partial-destroy",
        request: { action: "destroy", target: { kind: "slots", slotIds: ["already-removed", survivor.id] } },
        state: "failed",
        targets: [
          { provider: "mission", id: "already-removed", path: first!.path },
          { provider: "mission", id: survivor.id, path: survivor.path },
        ],
        error: "git worktree remove failed",
        changed: false,
        removals: [
          { id: "already-removed", path: first!.path },
          { id: survivor.id, path: survivor.path },
        ],
        completed: [{ id: "already-removed", path: first!.path }],
        queuedAt: Date.now(),
        finishedAt: Date.now(),
      }],
    } satisfies WorktreeInventory),
  }));
  await partialPage.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const report = partialPage.getByRole("region", { name: "Background cleanup" });
  await expect(report.getByText("partly done", { exact: true })).toBeVisible();
  await expect(report.getByText("1 worktree was removed before this stopped; 1 left in place.")).toBeVisible();
  await expect(report.getByRole("list", { name: "Already removed" }).getByText(first!.path)).toBeVisible();
  await shoot(partialPage, "22-bulk-destroy-partly-done");
  const retried = partialPage.waitForRequest((request) => request.url().endsWith("/api/worktrees/actions/preview"));
  await report.getByRole("button", { name: "Preview again" }).click();
  expect(((await retried).postDataJSON() as { target: { slotIds: string[] } }).target.slotIds).toEqual([survivor.id]);
  const narrowed = partialPage.getByRole("dialog", { name: "destroy worktree preview" });
  await expect(narrowed.getByRole("heading", { name: "Destroy 1 selected worktree" })).toBeVisible();
  await expect(narrowed.getByText(survivor.path)).toBeVisible();
  await expect(narrowed.getByRole("button", { name: "Execute" })).toBeEnabled();
  await expectContentClearsBorder(narrowed);
  await narrowed.getByRole("button", { name: "Cancel" }).click();
  // Cancelling the retry keeps the report and its fixed remaining set; only Execute or Dismiss retires it.
  await expect(report.getByText("partly done", { exact: true })).toBeVisible();
  await expect(report.getByRole("button", { name: "Preview again" })).toBeVisible();
  await partialPage.close();
});

/**
 * A ticked slot that disappears before Destroy selected must not be quietly dropped.
 *
 * The regression: the selection used to be filtered against the current inventory, so a
 * vanished slot left it silently and the preview covered only the survivor - which an
 * operator could then execute without ever learning their set had changed. The selection is
 * now exactly what was ticked, the bar says how much of it is gone, and the server's
 * missing-slot blocker is what the preview shows.
 */
test("a bulk selection that lost a slot is blocked at preview, not silently narrowed", async ({ dashboard, daemon }) => {
  test.setTimeout(120_000);
  const leases: Array<{ path: string; leaseId: string }> = [];
  for (const label of ["narrowed survivor", "narrowed vanishes"]) {
    const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
      data: { repositoryPath: daemon.repo, label },
    });
    expect(acquired.status()).toBe(201);
    leases.push(await acquired.json() as { path: string; leaseId: string });
  }
  for (const lease of leases) {
    const returned = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, {
      data: { leaseId: lease.leaseId },
    });
    expect(returned.ok()).toBe(true);
  }
  const [survivor, vanishing] = leases;

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const pool = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = pool.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  for (const lease of leases) {
    await pool.locator(".wt-slot", { hasText: lease.path }).getByRole("checkbox", { name: /for bulk destroy/ }).check();
  }
  const bulk = dashboard.getByRole("region", { name: "Bulk destroy selection" });
  await expect(bulk.getByText("2 slots selected")).toBeVisible();

  // Another window destroys one of the ticked slots.
  const inventory = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
  const target = inventory.repositories.flatMap((repo) => repo.slots).find((slot) => slot.path === vanishing!.path)!;
  const outside = await (await dashboard.request.post(`${daemon.baseURL}/api/worktrees/actions/preview`, {
    data: { action: "destroy", target: { kind: "slot", slotId: target.id } },
  })).json() as WorktreeActionPreview;
  const accepted = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/actions/execute`, {
    data: { token: outside.token, acknowledgements: [] },
  });
  expect(accepted.status()).toBe(202);
  await expect(pool.locator(".wt-slot", { hasText: vanishing!.path })).toHaveCount(0, { timeout: EXECUTES_MS });

  // The selection still counts both, and says one of them is gone.
  await expect(bulk.getByText("2 slots selected")).toBeVisible();
  await expect(bulk.getByText("1 no longer available")).toBeVisible();
  await shoot(dashboard, "20-bulk-selection-lost-a-slot");

  const previewed = dashboard.waitForRequest((request) => request.url().endsWith("/api/worktrees/actions/preview"));
  await bulk.getByRole("button", { name: "Destroy selected" }).click();
  const sent = (await previewed).postDataJSON() as { target: { slotIds: string[] } };
  expect(sent.target.slotIds).toHaveLength(2);
  expect(sent.target.slotIds).toContain(target.id);
  const preview = dashboard.getByRole("dialog", { name: "destroy worktree preview" });
  await expect(preview.getByRole("heading", { name: "Destroy 2 selected worktrees" })).toBeVisible();
  await expect(preview.getByText("Cannot execute")).toBeVisible();
  await expect(preview.getByText(/1 selected slot no longer exists/)).toBeVisible();
  await expect(preview.getByRole("button", { name: "Execute" })).toBeDisabled();
  await expectContentClearsBorder(preview);
  await shoot(dashboard, "21-bulk-preview-blocked-by-vanished-slot");
  await preview.getByRole("button", { name: "Cancel" }).click();

  // Nothing was removed on the operator's behalf, and only they clear the selection.
  expect(existsSync(survivor!.path)).toBe(true);
  await expect(pool.locator(".wt-slot", { hasText: survivor!.path })).toBeVisible();
  await expect(bulk.getByText("2 slots selected")).toBeVisible();
  await bulk.getByRole("button", { name: "Clear selection" }).click();
  await expect(bulk).toHaveCount(0);
});

/**
 * The selection controls never build a request the server must refuse.
 *
 * The bulk request allows 128 slot ids. A selection may span pools, so the limit is enforced
 * where the selection is made: Select all fills the remaining room and says what did not
 * fit, and an unticked slot cannot join a full selection. Reaching 129 slots for real means
 * 129 checkouts, so the pool is routed; the preview behind it is the real daemon's, and
 * since none of these ids exist there it also proves a selection that lost every slot gets
 * a blocked dialog rather than an error.
 */
test("bulk selection stops at 128 slots and says so", async ({ dashboard, daemon }) => {
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "selection limit template" },
  });
  expect(acquired.status()).toBe(201);
  const current = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
  const pool = current.repositories[0]!;
  const template = pool.slots[0]!;
  const slots = Array.from({ length: 129 }, (_, index) => ({
    ...template,
    id: `limit-slot-${index + 1}`,
    ordinal: index + 1,
    state: "available",
    owner: null,
    path: `${pool.poolPath}/${index + 1}/demo-repo`,
    actions: ["destroy" as const],
  }));
  await dashboard.route("**/api/worktrees", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ...current,
      repositories: [{
        ...pool,
        policy: { ...pool.policy, maxSlots: 128 },
        counts: { total: 129, leased: 0, available: 129, quarantined: 0, overCapacity: 1 },
        slots,
      }],
      operations: [],
    } satisfies WorktreeInventory),
  }));
  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const row = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = row.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();

  await row.getByRole("button", { name: "Select all slots" }).click();
  const bulk = dashboard.getByRole("region", { name: "Bulk destroy selection" });
  await expect(bulk.getByText("128 slots selected")).toBeVisible();
  await expect(bulk.getByText("Limit of 128 reached; 1 slot was not added")).toBeVisible();
  await shoot(dashboard, "23-bulk-selection-limit");

  // The slot that did not fit is the pool's last; it cannot be ticked while the selection is full.
  const more = row.getByRole("button", { name: /^Show more slots/ });
  while (await more.count() > 0) await more.click();
  const last = row.getByRole("checkbox", { name: "Select slot 129 for bulk destroy" });
  await expect(last).not.toBeChecked();
  await expect(last).toBeDisabled();
  // Unticking frees room, and the freed room can be taken by the slot that was left out.
  await row.getByRole("checkbox", { name: "Select slot 1 for bulk destroy" }).uncheck();
  await expect(bulk.getByText("127 slots selected")).toBeVisible();
  await expect(bulk.getByText(/Limit of 128 reached/)).toHaveCount(0);
  await last.check();
  await expect(bulk.getByText("128 slots selected")).toBeVisible();

  const previewed = dashboard.waitForRequest((request) => request.url().endsWith("/api/worktrees/actions/preview"));
  await bulk.getByRole("button", { name: "Destroy selected" }).click();
  expect(((await previewed).postDataJSON() as { target: { slotIds: string[] } }).target.slotIds).toHaveLength(128);
  const preview = dashboard.getByRole("dialog", { name: "destroy worktree preview" });
  await expect(preview.getByRole("heading", { name: "Destroy 128 selected worktrees" })).toBeVisible();
  await expect(preview.getByText("128 selected slots no longer exist; clear the selection and choose again.")).toBeVisible();
  await expect(preview.getByRole("button", { name: "Execute" })).toBeDisabled();
  await shoot(dashboard, "24-bulk-preview-all-selected-gone");
  await preview.getByRole("button", { name: "Cancel" }).click();
});
