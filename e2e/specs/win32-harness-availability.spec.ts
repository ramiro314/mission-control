import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import { expectRowStatus, openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";

/**
 * On win32 Mission Control runs Claude Code only (D10, D20 in
 * `docs/plans/windows-support/plan.md`): Codex and Pi are unavailable with a stated reason.
 *
 * `MC_E2E_WIN32_HOST` builds the production daemon with only its host-platform answer
 * replaced (`e2e/fixtures/win32-host-build.ts`), so this runs on every runner, a real
 * Windows one included.
 */
test.use({ daemonEnv: { MC_E2E_WIN32_HOST: "1" } });

const EVIDENCE = artifactsDir("win32-harness-availability");

/** Behind `MC_E2E_EVIDENCE` like every other capture in this suite; an ordinary run writes nothing. */
async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
}

const reason = (label: string): string =>
  `Mission Control does not support ${label} on Windows yet, so ${label} tasks cannot be dispatched on this machine.`;

test("Settings > Setup shows why Codex and Pi are unavailable on win32", async ({ page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "agents");

  await expectRowStatus(page, "dependency-claude-cli", "Ready");
  for (const [anchor, label] of [["dependency-codex-cli", "Codex"], ["dependency-pi-cli", "Pi"]] as const) {
    await expectRowStatus(page, anchor, "Needs setup");
    await expect(setupRow(page, anchor).locator(".setup-why")).toHaveText(reason(label));
  }
  await shoot(page, "setup-agents");
});

test("a Codex dispatch on win32 is refused with the reason and acquires no worktree", async ({ dashboard, daemon }) => {
  const worktrees = (): string => execFileSync("git", ["-C", daemon.repo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  const before = worktrees();

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Fix the flaky export test");
  await dialog.getByRole("combobox", { name: "Agent", exact: true }).selectOption("codex");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();

  await expect(dialog.locator(".dispatch-error")).toHaveText(reason("Codex"));
  await expect(dialog.getByRole("button", { name: "Dispatch now" })).toBeEnabled();
  expect(worktrees()).toBe(before);
  await shoot(dashboard, "dispatch-refused");
});
