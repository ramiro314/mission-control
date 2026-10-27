import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { databaseBackupStatusFrom } from "../../src/shared/database-backups.ts";
import { storageProblem, type StorageHealth, type StorageProblem } from "../../src/shared/storage-health.ts";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Settings > Storage, driven the way a person drives it.
 *
 * What only this layer proves: that the Backups band reads the daemon's real copies and config,
 * that Save reaches the route and its prune comes back to the page over `storage_health`, that
 * Back up now writes a manual copy the list then shows, and that a failed capture appears in the
 * Problems list and clears when a capture succeeds, and that the dashboard banner raised by a
 * bannered problem dismisses per occurrence and keeps that dismissal across a reload, a daemon
 * restart and a clock moved weeks ahead. No agent is launched, so no model tokens are spent.
 */

const EVIDENCE = artifactsDir("storage");

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/storage/${name}.png`);
}

function backupRoot(daemon: DaemonHandle): string {
  return join(daemon.home, "backups", "database");
}

function copiesOnDisk(daemon: DaemonHandle, prefix: string): string[] {
  return readdirSync(backupRoot(daemon)).filter((name) => name.startsWith(`${prefix}-`));
}

/** Copies an earlier daemon generation left, above today's default count of 3. */
function seedScheduledCopies(daemon: DaemonHandle, count: number): void {
  mkdirSync(backupRoot(daemon), { recursive: true });
  for (let hour = 1; hour <= count; hour += 1) {
    const stamp = `20260101T0${hour}0000000Z`;
    writeFileSync(join(backupRoot(daemon), `scheduled-${stamp}-${String(hour).padStart(32, "a")}.sqlite3`), "seeded copy");
  }
}

test("Storage shows backup config, status and kept copies, saves counts that prune, and Back up now adds a manual copy", async ({
  dashboard,
  daemon,
}) => {
  seedScheduledCopies(daemon, 4);
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await expect(dashboard.getByRole("tab", { name: "Storage" })).toHaveAttribute("aria-selected", "true");

  const interval = dashboard.getByLabel("Backup interval");
  const scheduledCount = dashboard.getByLabel("Scheduled copies kept");
  const preMigrationCount = dashboard.getByLabel("Pre-migration copies kept");
  await expect(interval).toHaveValue("1");
  await expect(scheduledCount).toHaveValue("3");
  await expect(preMigrationCount).toHaveValue("2");

  const copies = dashboard.getByRole("table", { name: "Kept copies, newest first" });
  const scheduledRows = copies.getByRole("row").filter({ hasText: "Scheduled" });
  const manualRows = copies.getByRole("row").filter({ hasText: "Manual" });
  await expect(scheduledRows).toHaveCount(4);
  await expect(dashboard.getByRole("article", { name: "Manual backups" })).toContainText("Last success: Never");
  await expect(dashboard.getByText("No storage problems.")).toBeVisible();
  await shoot(dashboard, "01-backups");

  // Save lowered counts and a longer interval: the prune lands on the page and on disk.
  await scheduledCount.fill("2");
  await interval.selectOption("6");
  await dashboard.getByRole("button", { name: "Save" }).click();
  await expect(dashboard.getByText("Backup settings saved.", { exact: false })).toBeVisible();
  await expect(scheduledRows).toHaveCount(2);
  expect(copiesOnDisk(daemon, "scheduled")).toHaveLength(2);
  const stored = await (await dashboard.request.get(`${daemon.baseURL}/api/storage`)).json() as {
    config: { scheduledCount: number; preMigrationCount: number; intervalHours: number };
  };
  expect(stored.config).toEqual({ scheduledCount: 2, preMigrationCount: 2, intervalHours: 6 });

  // The saved values are what a fresh load reads back.
  await dashboard.reload();
  await expect(scheduledCount).toHaveValue("2");
  await expect(interval).toHaveValue("6");
  await expect(preMigrationCount).toHaveValue("2");

  // Back up now adds one manual copy, and a second keeps exactly one.
  const backUpNow = dashboard.getByRole("button", { name: "Back up now" });
  await backUpNow.click();
  await expect(dashboard.getByText("Backup taken.", { exact: false })).toBeVisible();
  await expect(manualRows).toHaveCount(1);
  await expect(dashboard.getByRole("article", { name: "Manual backups" })).not.toContainText("Last success: Never");
  const first = copiesOnDisk(daemon, "manual");
  expect(first).toHaveLength(1);
  await backUpNow.click();
  await expect.poll(() => copiesOnDisk(daemon, "manual").join()).not.toBe(first.join());
  await expect(manualRows).toHaveCount(1);
  expect(copiesOnDisk(daemon, "manual")).toHaveLength(1);
  await expect(scheduledRows).toHaveCount(2);
  await shoot(dashboard, "02-saved-and-backed-up");
});

test("a failed Back up now appears in Problems and clears on the next success", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await expect(dashboard.getByText("No storage problems.")).toBeVisible();

  // A backup root the daemon refuses to write into: a symlink in place of the directory.
  const elsewhere = mkdtempSync(join(tmpdir(), "mission-storage-elsewhere-"));
  try {
    rmSync(backupRoot(daemon), { recursive: true, force: true });
    symlinkSync(elsewhere, backupRoot(daemon));
    await dashboard.getByRole("button", { name: "Back up now" }).click();
    await expect(dashboard.getByRole("alert").filter({ hasText: "Manual database backup failed" })).toBeVisible();

    const problems = dashboard.getByRole("list", { name: "Storage problems" });
    await expect(problems.getByRole("listitem")).toHaveCount(1);
    await expect(problems).toContainText("Backup failed");
    await expect(problems).toContainText("Manual database backup failed: Database backup root must be a real directory");
    await expect(dashboard.getByRole("article", { name: "Manual backups" })).toContainText("Last failure:");
    await shoot(dashboard, "03-backup-failed");

    // Its link lands on the Backups band, where Back up now lives.
    await problems.getByRole("button", { name: "Open backups" }).click();
    await expect(dashboard.getByRole("button", { name: "Back up now" })).toBeInViewport();

    rmSync(backupRoot(daemon), { force: true });
    mkdirSync(backupRoot(daemon), { mode: 0o700 });
    await dashboard.getByRole("button", { name: "Back up now" }).click();
    await expect(dashboard.getByText("No storage problems.")).toBeVisible();
    await expect(dashboard.getByRole("article", { name: "Manual backups" })).toContainText("No failures recorded");
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

/** The daemon's real connect-time snapshot, read once off its event stream. */
async function realSnapshot(daemon: DaemonHandle): Promise<Record<string, unknown>> {
  const stream = await fetch(`${daemon.baseURL}/events`);
  expect(stream.ok).toBe(true);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE closed before its snapshot");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  const data = text.split("\n").find((line) => line.startsWith("data: "))!;
  return JSON.parse(data.slice(6)) as Record<string, unknown>;
}

test("with the stream down after its snapshot, Back up now still shows the copy it took", async ({
  dashboard,
  daemon,
}) => {
  // The stream delivers one real snapshot, which carries a storage aggregate, and then never
  // reconnects: no `storage_health` frame can reach this page. The panel's re-read after the
  // write is the only way it can learn about the new copy, and it must not be outranked by the
  // older stream value.
  const snapshot = await realSnapshot(daemon);
  expect(snapshot.storageHealth).toBeTruthy();
  let streams = 0;
  await dashboard.route("**/events", (route) => {
    streams += 1;
    if (streams > 1) return route.abort();
    return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify(snapshot)}\n\n` });
  });
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await dashboard.reload();
  await expect(dashboard.getByRole("tab", { name: "Storage" })).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.getByText("No copies are kept yet.", { exact: false })).toBeVisible();

  await dashboard.getByRole("button", { name: "Back up now" }).click();
  await expect(dashboard.getByText("Backup taken.", { exact: false })).toBeVisible();
  const copies = dashboard.getByRole("table", { name: "Kept copies, newest first" });
  await expect(copies.getByRole("row").filter({ hasText: "Manual" })).toHaveCount(1);
  await expect(dashboard.getByRole("article", { name: "Manual backups" })).not.toContainText("Last success: Never");
  expect(streams).toBeGreaterThanOrEqual(1);
});

const DISMISSALS_KEY = "mission-control.storage-banner.dismissed";

function storageBanner(page: Page) {
  return page.getByRole("status", { name: "Storage needs attention" });
}

/** This viewer's dismissal record, as the banner persists it. */
async function dismissals(page: Page): Promise<Record<string, { lastSeenAt: number }>> {
  return page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? "{}"), DISMISSALS_KEY);
}

/**
 * The newest `lastSeenAt` among the dismissals. It moves only when the banner has applied an
 * aggregate that lists a dismissed problem, which is how a step knows the page has seen one.
 */
async function newestSeen(page: Page): Promise<number> {
  return Math.max(0, ...Object.values(await dismissals(page)).map((entry) => entry.lastSeenAt));
}

/** A backup root the daemon refuses to write into: a symlink in place of the directory. */
function breakBackupRoot(daemon: DaemonHandle, elsewhere: string): void {
  rmSync(backupRoot(daemon), { recursive: true, force: true });
  symlinkSync(elsewhere, backupRoot(daemon));
}

function repairBackupRoot(daemon: DaemonHandle): void {
  rmSync(backupRoot(daemon), { force: true });
  mkdirSync(backupRoot(daemon), { mode: 0o700 });
}

test("a failed backup raises the banner, a dismissal holds across a restart, and a recurrence brings it back", async ({
  dashboard,
  daemon,
}) => {
  const banner = storageBanner(dashboard);
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await expect(dashboard.getByText("No storage problems.")).toBeVisible();
  await expect(banner).toHaveCount(0);

  const elsewhere = mkdtempSync(join(tmpdir(), "mission-storage-elsewhere-"));
  try {
    const backUpNow = dashboard.getByRole("button", { name: "Back up now" });
    breakBackupRoot(daemon, elsewhere);
    await backUpNow.click();
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Manual database backup failed");

    // The banner sits over every view, and its link lands on Settings > Storage.
    await dashboard.goto(`${daemon.baseURL}/#/fleet`);
    await expect(banner).toBeVisible();
    await shoot(dashboard, "04-banner");
    await banner.getByRole("link", { name: "Open Storage" }).click();
    await expect(dashboard.getByRole("tab", { name: "Storage" })).toHaveAttribute("aria-selected", "true");

    await banner.getByRole("button", { name: "Dismiss storage warning" }).click();
    await expect(banner).toHaveCount(0);
    const dismissedIds = Object.keys(await dismissals(dashboard));
    expect(dismissedIds).toHaveLength(1);
    expect(dismissedIds[0]).toMatch(/^backup-failed:manual:\d+$/);

    // The same occurrence failing again publishes a new aggregate, which the banner applies
    // and still hides.
    let seen = await newestSeen(dashboard);
    await backUpNow.click();
    await expect.poll(() => newestSeen(dashboard)).toBeGreaterThan(seen);
    await expect(banner).toHaveCount(0);

    // A daemon restart keeps the occurrence id, and a reload keeps the dismissal. The root is
    // repaired first so the restarted scheduler does not fail a capture of its own.
    repairBackupRoot(daemon);
    await daemon.crash();
    await daemon.restart();
    seen = await newestSeen(dashboard);
    await dashboard.reload();
    await expect.poll(() => newestSeen(dashboard)).toBeGreaterThan(seen);
    await expect(dashboard.getByRole("list", { name: "Storage problems" }))
      .toContainText("Manual database backup failed");
    await expect(banner).toHaveCount(0);
    expect(Object.keys(await dismissals(dashboard))).toEqual(dismissedIds);
    await shoot(dashboard, "05-dismissed-after-restart");

    // Succeed, then fail again: a new occurrence, so the banner returns.
    await backUpNow.click();
    await expect(dashboard.getByText("No storage problems.")).toBeVisible();
    breakBackupRoot(daemon, elsewhere);
    await backUpNow.click();
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Manual database backup failed");
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * A stream that delivers one snapshot per connection, carrying whatever storage aggregate the
 * spec set last, and holds each reconnect until the next one is set. `retry` brings the browser
 * straight back after each frame. A connection a reload abandons is not counted as delivered,
 * so a frame is never lost to it.
 */
async function storageFixtureStream(page: Page, daemon: DaemonHandle, first: StorageHealth) {
  const snapshot = await realSnapshot(daemon);
  const view = await (await page.request.get(`${daemon.baseURL}/api/storage`)).json() as { config: unknown };
  let current = first;
  let version = 1;
  let delivered = 0;
  let wakers: Array<() => void> = [];
  await page.route("**/api/storage", (route) => route.fulfill({ json: { health: current, config: view.config } }));
  await page.route("**/events", async (route) => {
    while (version <= delivered) await new Promise<void>((wake) => wakers.push(wake));
    const sending = version;
    delivered = sending;
    try {
      await route.fulfill({
        contentType: "text/event-stream",
        body: `retry: 20\ndata: ${JSON.stringify({ ...snapshot, storageHealth: current })}\n\n`,
      });
    } catch {
      if (delivered === sending) delivered = sending - 1;
    }
  });
  return (next: StorageHealth): void => {
    current = next;
    version += 1;
    const waiting = wakers;
    wakers = [];
    for (const wake of waiting) wake();
  };
}

test("a dismissal survives an omitted pass and weeks of presence, ends after an hour gone, and a new problem returns the banner", async ({
  dashboard,
  daemon,
}) => {
  const quarantined = storageProblem(
    "quarantined-slot", "fixture-slot", 1_000, "Slot fixture-slot is quarantined", { target: "slot", slotId: "fixture-slot" },
  );
  const orphan = storageProblem(
    "orphan-process", "/fixture/tree", "4242:1000", "A process outlived /fixture/tree", { target: "unowned-tree", path: "/fixture/tree" },
  );
  // Each pass carries a non-bannered marker the Problems list shows, so the spec knows the
  // page has applied that pass before it asserts the banner is absent.
  const pass = (step: number, ...problems: StorageProblem[]): StorageHealth => ({
    backups: { status: databaseBackupStatusFrom(undefined), copies: [], totalBytes: 0 },
    problems: [
      ...problems,
      storageProblem("stale-lease", `marker-slot-${step}`, "lease", `Fixture pass ${step}.`, { target: "slot", slotId: `marker-slot-${step}` }),
    ],
  });
  const problems = dashboard.getByRole("list", { name: "Storage problems" });
  const banner = storageBanner(dashboard);
  const t0 = Date.now();

  await dashboard.clock.setFixedTime(t0);
  // Problems listed in Storage only - a stale lease and a dirty settled tree - raise nothing.
  const push = await storageFixtureStream(dashboard, daemon, pass(0, storageProblem(
    "dirty-settled-tree", "fixture-task", 1_000, "Task fixture-task kept a dirty tree", { target: "unowned-tree", path: "/fixture/task" },
  )));
  let step = 0;
  const at = async (time: number, ...current: StorageProblem[]): Promise<void> => {
    step += 1;
    await dashboard.clock.setFixedTime(time);
    push(pass(step, ...current));
    await expect(problems).toContainText(`Fixture pass ${step}.`);
  };

  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await dashboard.reload();
  await expect(problems).toContainText("Fixture pass 0.");
  await expect(problems).toContainText("Task fixture-task kept a dirty tree");
  await expect(banner).toHaveCount(0);

  await at(t0, quarantined);
  await expect(banner).toContainText("Slot fixture-slot is quarantined");
  await banner.getByRole("button", { name: "Dismiss storage warning" }).click();
  await expect(banner).toHaveCount(0);

  // One pass omits it, the next reports it again inside the hour: still hidden.
  await at(t0 + 30 * MINUTE);
  await at(t0 + 59 * MINUTE, quarantined);
  await expect(banner).toHaveCount(0);

  // Present for more than 30 days, by the page's clock: still hidden, its entry still fresh.
  await at(t0 + 15 * DAY, quarantined);
  await at(t0 + 31 * DAY, quarantined);
  await expect(banner).toHaveCount(0);
  expect((await dismissals(dashboard))[quarantined.id]).toEqual({ lastSeenAt: t0 + 31 * DAY });

  // A new problem beside the dismissed one brings the banner back, naming only the new one.
  await at(t0 + 31 * DAY + MINUTE, quarantined, orphan);
  await expect(banner).toContainText("A process outlived /fixture/tree");
  await expect(banner).not.toContainText("Slot fixture-slot is quarantined");
  await shoot(dashboard, "06-new-problem");
  await banner.getByRole("button", { name: "Dismiss storage warning" }).click();
  await expect(banner).toHaveCount(0);

  // Absent for more than an hour, its entry goes, so the same id would raise the banner again.
  await at(t0 + 31 * DAY + 2 * MINUTE, orphan);
  expect(await dismissals(dashboard)).toHaveProperty([quarantined.id]);
  await at(t0 + 31 * DAY + 63 * MINUTE, orphan);
  expect(await dismissals(dashboard)).not.toHaveProperty([quarantined.id]);
  await expect(banner).toHaveCount(0);
  await at(t0 + 31 * DAY + 64 * MINUTE, quarantined, orphan);
  await expect(banner).toContainText("Slot fixture-slot is quarantined");
});
