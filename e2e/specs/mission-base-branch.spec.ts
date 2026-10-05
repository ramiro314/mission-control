import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * A Recurring Mission's base branch, set in the mission editor and carried by the task a run
 * files.
 *
 * The fixture repository's origin is a real bare repository, so the save-time check below is
 * git's own answer: `release/e2e` is pushed to it here, and `release/missing` never is. Run now
 * files a backlog task and launches nothing, so no agent runs and no model token is spent.
 */

const EVIDENCE = artifactsDir("mission-base-branch");

async function shoot(page: Page, name: string, scrollTo?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  if (scrollTo) await scrollTo.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/mission-base-branch/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

interface StoredSchedule {
  id: string;
  name: string;
  template: { baseBranch?: string | null } | null;
}

interface TaskSnapshot {
  id: string;
  scheduleId: string | null;
  baseBranch?: string | null;
}

const MISSION = "Windows sync";

test("a mission's base branch is set in the editor, checked on save, and carried by the task it files", async ({
  dashboard,
  daemon,
}) => {
  execFileSync("git", ["-C", daemon.repo, "push", "-q", "origin", "main:refs/heads/release/e2e"], {
    stdio: "pipe",
  });

  await dashboard.getByRole("button", { name: "Recurring missions" }).click();
  await dashboard.getByRole("button", { name: "Create mission" }).click();

  await dashboard.getByPlaceholder("e.g. Dependency audit").fill(MISSION);
  await dashboard.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // `RepoCombobox` portals its listbox over the fields below it; close it before reaching them.
  await dashboard.keyboard.press("Escape");
  await dashboard
    .getByPlaceholder("e.g. Run dependency audit and update unsafe packages")
    .fill("Sync release/e2e");
  await dashboard.getByPlaceholder("What should the agent do each run?").fill("Merge main into release/e2e.");

  const baseBranch = dashboard.getByRole("textbox", { name: "Base branch" });
  await expect(baseBranch).toHaveValue("");

  // A branch origin does not have is refused on save, under the field it belongs to.
  await baseBranch.fill("release/missing");
  await dashboard.getByRole("button", { name: "Save paused" }).click();
  const refusal = dashboard.locator(".rm-field-error", { hasText: /base branch release\/missing does not exist/ });
  await expect(refusal).toBeVisible();
  await shoot(dashboard, "01-editor-refuses-missing-branch", refusal);
  expect((await api<StoredSchedule[]>(daemon, "/api/schedules")).some((s) => s.name === MISSION)).toBe(false);

  await baseBranch.fill("release/e2e");
  await dashboard.getByRole("button", { name: "Save paused" }).click();

  let missionId = "";
  await expect
    .poll(
      async () => {
        const saved = (await api<StoredSchedule[]>(daemon, "/api/schedules")).find((s) => s.name === MISSION);
        missionId = saved?.id ?? "";
        return saved ? saved.template?.baseBranch ?? null : "not-saved";
      },
      { message: "the Base branch field should reach the stored template" },
    )
    .toBe("release/e2e");

  await dashboard.getByRole("button", { name: MISSION, exact: false }).first().click();
  await dashboard.getByText(/^Configuration/).first().click();
  const shown = dashboard.locator("dd", { hasText: "release/e2e" });
  await expect(shown).toBeVisible();
  await shoot(dashboard, "02-detail-shows-base-branch", shown);

  await dashboard.getByRole("button", { name: "Run now" }).click();

  await expect
    .poll(
      async () => {
        const filed = (await api<TaskSnapshot[]>(daemon, "/api/tasks")).find((t) => t.scheduleId === missionId);
        return filed ? filed.baseBranch ?? null : "not-filed";
      },
      { message: "the task Run now files should carry the mission's base branch" },
    )
    .toBe("release/e2e");
  await shoot(dashboard, "03-run-now-filed");
});
