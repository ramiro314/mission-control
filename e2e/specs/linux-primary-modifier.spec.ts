import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Off macOS the dashboard's `cmd` shortcuts answer to Ctrl, not to the Super key the desktop
 * takes (`src/web/lib/keybindings.ts`, `chordFromEvent`).
 *
 * Linux only, and it presses `Control` and `Meta` by name rather than `ControlOrMeta`: the
 * claim is about which PHYSICAL key answers there, so the spec cannot let Playwright pick it.
 * Every other spec presses `ControlOrMeta`, which makes the whole suite the macOS twin on a
 * Mac and this path on Linux CI.
 */

test.skip(process.platform !== "linux", "asserts the Linux keyboard; ControlOrMeta covers macOS");

const EVIDENCE = artifactsDir("linux-primary-modifier");

/** Photograph a state this spec has already asserted on. Behind `MC_E2E_EVIDENCE`. */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/linux-primary-modifier/${name}.png`);
}

const palette = (page: Page) => page.getByRole("dialog", { name: "Search everything" });

test("Ctrl+K opens Settings search on Linux, and Super+K does not", async ({ dashboard }) => {
  // Super first: the desktop owns it, and a `cmd` binding must not answer to it.
  await dashboard.keyboard.press("Meta+k");
  await expect(palette(dashboard)).toBeHidden();

  await dashboard.keyboard.press("Control+k");
  await expect(palette(dashboard)).toBeVisible();
  await dashboard.getByRole("combobox", { name: "Search everything" }).fill("Reset checkout");
  const row = dashboard.getByRole("option", { name: /Reset checkout/ }).first();
  await expect(row).toBeVisible();
  await shoot(dashboard, "01-ctrl-k-opened-search");

  // The settings row it finds is the shortcut that ships unbound off macOS: Ctrl+R is reload
  // there, and a destructive action must not share it.
  await row.click();
  await expect(palette(dashboard)).toBeHidden();
  expect(await dashboard.evaluate(() => location.hash)).toMatch(/^#\/settings\/keyboard/);
  const resetRow = dashboard.locator('[data-anchor="keyboard/reset"]');
  await expect(
    resetRow.getByRole("button", { name: "Change shortcut for Reset checkout (currently unset)" }),
  ).toBeVisible();
  await resetRow.scrollIntoViewIfNeeded();
  await shoot(dashboard, "02-reset-checkout-unbound");

  // And it can be bound: Ctrl+Shift+R records as the primary-modifier chord.
  await resetRow.getByRole("button", { name: /^Change shortcut for Reset checkout/ }).click();
  await dashboard.keyboard.press("Control+Shift+r");
  await expect(
    resetRow.getByRole("button", { name: /^Change shortcut for Reset checkout \(currently ⌘⇧R\)/ }),
  ).toBeVisible();
  await expect(dashboard.locator(".settings-error")).toHaveCount(0);

  // Settings search still answers Ctrl+K from inside Settings.
  await dashboard.keyboard.press("Control+k");
  await expect(palette(dashboard)).toBeVisible();
});

/** Dispatch one session against the fake agent and open its console detail. */
async function openOneSession(page: Page, daemon: DaemonHandle) {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("exercise the Linux keyboard");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = page.locator(".console-detail");
  await expect(card.getByPlaceholder(/^Reply to this session/)).toBeEnabled();
  return card;
}

test("the action bar's reset names no key while Reset checkout is unbound", async ({
  dashboard,
  daemon,
}) => {
  const card = await openOneSession(dashboard, daemon);
  // The action stays reachable from the session it acts on, and its description no longer
  // ends in an empty "()" where the ⌃R it used to print would have been.
  await expect(card.getByRole("button", { name: "reset", exact: true })).toHaveAccessibleDescription(
    "Reset checkout to origin's default branch and clear context",
  );
});
