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
    resetRow.getByRole("button", { name: /^Change shortcut for Reset checkout \(currently Ctrl\+Shift\+R\)/ }),
  ).toBeVisible();
  await expect(dashboard.locator(".settings-error")).toHaveCount(0);

  // Settings search still answers Ctrl+K from inside Settings.
  await dashboard.keyboard.press("Control+k");
  await expect(palette(dashboard)).toBeVisible();
});

test("keycaps and shortcut copy name Ctrl on Linux, never the Mac glyphs", async ({ dashboard, daemon }) => {
  // The gear's tooltip, which used to print "Settings (⌘,)" on every platform.
  await dashboard.getByRole("button", { name: /^Settings/ }).hover();
  await expect(dashboard.locator(".tooltip")).toHaveText(/^Settings \(Ctrl\+,\)/);
  await dashboard.mouse.move(0, 0);

  await dashboard.goto(`${daemon.baseURL}/#/settings/keyboard`);
  // The rail box's keycap for the palette, and the row that binds it.
  await expect(dashboard.locator(".settings-rail-search-kbd")).toHaveText("Ctrl+K");
  await expect(
    dashboard.getByRole("button", { name: "Change shortcut for Search everything (currently Ctrl+K)" }),
  ).toBeVisible();
  // A default stored as `ctrl+g` is the same Ctrl key, not a second modifier.
  const expandRow = dashboard.locator('[data-anchor="keyboard/composerEditor"]');
  await expect(
    expandRow.getByRole("button", { name: /^Change shortcut for Expand the message box \(currently Ctrl\+G\)/ }),
  ).toBeVisible();
  await expect(expandRow).toContainText("Ctrl+Enter puts the result back in the send box");
  const panel = dashboard
    .locator("section.settings-section")
    .filter({ has: dashboard.getByRole("heading", { name: "Shortcuts", exact: true }) });
  await expect(panel).toContainText("fleet's Ctrl+1 … Ctrl+0, Ctrl+-, Ctrl+= session jump keys");
  for (const glyph of ["⌘", "⌃", "⌥", "⇧"]) await expect(panel).not.toContainText(glyph);
  await shoot(dashboard, "03-keyboard-settings-name-ctrl");

  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const jumpItem = dashboard.locator("label").filter({ hasText: "Jump shortcut" }).first();
  await expect(jumpItem).toContainText("The Ctrl+1 … Ctrl+0, Ctrl+-, Ctrl+= keycap on the card");
  await expect(jumpItem).toContainText("gives up Ctrl+0/Ctrl+-/Ctrl+=");
  await expect(jumpItem).not.toContainText("⌘");

  // Settings search finds the jump keys by the name a Linux keyboard gives them.
  await dashboard.keyboard.press("Control+k");
  await dashboard.getByRole("combobox", { name: "Search everything" }).fill("ctrl 1");
  await expect(dashboard.getByRole("option", { name: /Board card/ }).first()).toBeVisible();
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

test("the rail keycap reads Ctrl+1, and the action bar's reset names no key while Reset checkout is unbound", async ({
  dashboard,
  daemon,
}) => {
  const card = await openOneSession(dashboard, daemon);
  // The rail row's jump keycap is Ctrl+1, the key that opens it here.
  const row = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first();
  await expect(row.locator(".rail-state-line .kb-hint")).toHaveText("Ctrl+1");
  // And it is announced as Control, not as the Meta key the desktop owns.
  await expect(row).toHaveAttribute("aria-keyshortcuts", "Control+1");
  await shoot(dashboard, "04-rail-keycap-ctrl-1");
  // The action stays reachable from the session it acts on, and its description no longer
  // ends in an empty "()" where the ⌃R it used to print would have been.
  await expect(card.getByRole("button", { name: "reset", exact: true })).toHaveAccessibleDescription(
    "Reset checkout to origin's default branch and clear context",
  );
});
