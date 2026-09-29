import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { recordsIn } from "../fixtures/records.ts";

/**
 * A GitHub Issues source filtered by "all of" and "none of" labels - the flake cleanup
 * recipe - configured in Settings and swept.
 *
 * `test/github-issues-map.test.ts` pins the argv these filters become, and
 * `test/task-sources-panel.test.ts` pins that the fields render what is stored. Only this layer
 * connects typing into the two new fields to the config the daemon stores, and that stored
 * config to the `gh issue list` search a sweep actually runs.
 *
 * Nothing reaches GitHub: `MISSION_GH_BIN` points every `gh` call at `FAKE_GH`, which records
 * its argv and answers `issue list` from `MC_E2E_GH_ISSUES`. No agent is dispatched.
 */

const EVIDENCE = artifactsDir("task-source-label-filters");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/task-source-label-filters/${name}.png`);
}

test("all-of and none-of labels are saved from Settings and reach the gh search", async ({
  page,
  daemon,
}) => {
  writeFileSync(
    join(daemon.home, "gh-issues.json"),
    JSON.stringify([
      {
        number: 12,
        title: "Flaky test: sweeps a source (test/sweep.test.ts)",
        body: "<!-- mission-flake:v1 key=abc -->\nFlaky.",
        url: "https://github.com/acme/demo-repo/issues/12",
        labels: [{ name: "flaky-test" }, { name: "flaky-test:actionable" }],
        assignees: [],
        updatedAt: "2026-09-01T00:00:00Z",
        state: "OPEN",
        stateReason: null,
        blockedBy: { nodes: [], totalCount: 0 },
        parent: null,
      },
    ]),
  );

  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByRole("combobox", { name: "What kind of source to add" }).selectOption("github-issues");
  await page.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // Both new fields sit beside the existing any-of field.
  await expect(page.getByLabel("Labels (any of)")).toBeVisible();
  const all = page.getByLabel("Labels (all of)");
  const none = page.getByLabel("Labels (none of)");
  await all.fill("flaky-test, flaky-test:actionable");
  await none.fill("wontfix");
  await page.keyboard.press("Tab");

  await expect
    .poll(
      async () => {
        const res = await page.request.get(`${daemon.baseURL}/api/task-sources/config`);
        const body = (await res.json()) as { sources?: { config?: Record<string, unknown> }[] };
        return body.sources?.[0]?.config ?? {};
      },
      { message: "the daemon should have stored both label filters" },
    )
    .toMatchObject({ labelsAll: ["flaky-test", "flaky-test:actionable"], labelsNone: ["wontfix"] });

  // A fresh page reads them back from the daemon, not from component state.
  await page.reload();
  await expect(page.getByLabel("Labels (all of)")).toHaveValue("flaky-test, flaky-test:actionable");
  await expect(page.getByLabel("Labels (none of)")).toHaveValue("wontfix");
  await shoot(page, "label-filters-configured");

  await page.getByRole("button", { name: "Sweep now" }).click();
  await expect(page.getByText(/Swept: filed 1/)).toBeVisible();

  const list = recordsIn<{ argv: string[] }>(daemon.recordDir, (f) => f.startsWith("gh-")).find(
    (r) => r.argv[0] === "issue" && r.argv[1] === "list",
  );
  expect(list, "the sweep should have run gh issue list").toBeTruthy();
  const argv = list!.argv;
  expect(argv).not.toContain("--label");
  expect(argv[argv.indexOf("--search") + 1]).toBe(
    'label:flaky-test label:"flaky-test:actionable" -label:wontfix',
  );
});
