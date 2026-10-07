import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The Diff view of a task with a non-default base branch shows that task's own changes only.
 *
 * The fixture repo's origin gets a `release/windows` branch carrying a commit `main` never had,
 * and the task is dispatched from it. Measured against origin's default, the Diff view would
 * list the release branch's own file as this task's work; measured against `origin/<base>`, it
 * lists only the file the task changed.
 */

const TASK = "show only this task's own changes";
const EVIDENCE = artifactsDir("diff-task-base-branch");

const git = (repo: string, ...args: string[]): void => {
  execFileSync("git", ["-C", repo, "-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], {
    stdio: "pipe",
  });
};

test("a task with a non-default base branch shows only its own changes in the Diff view", async ({
  dashboard,
  daemon,
}) => {
  git(daemon.repo, "checkout", "-qb", "release/windows");
  writeFileSync(join(daemon.repo, "release-only.txt"), "carried by the release branch\n");
  git(daemon.repo, "add", "-A");
  git(daemon.repo, "commit", "-qm", "release work");
  git(daemon.repo, "push", "-q", "origin", "release/windows");
  git(daemon.repo, "checkout", "-q", "main");

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // RepoCombobox portals its list over the form. Close it before reaching fields below.
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog.getByRole("button", { name: /^Backlog details/ }).click();
  await dialog.getByLabel("Base branch").fill("release/windows");
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  // The worktree lands a beat after the modal closes.
  let cwd: string | null = null;
  await expect
    .poll(async () => {
      const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as { cwd: string | null }[];
      cwd = sessions[0]?.cwd ?? null;
      return cwd;
    }, { message: "the dispatched session never reported a working directory" })
    .not.toBeNull();
  writeFileSync(join(cwd!, "own-change.txt"), "this task's work\n");

  // Console layout, where the Diff tab lives. Written to the daemon, which the page hydrates from.
  const layout = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  expect(layout.ok, "the daemon accepted the Console layout").toBe(true);
  await dashboard.reload();
  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Show Only This Task/i })
    .click();
  await dashboard.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Diff$/ }).click();

  const pane = dashboard.getByLabel("Diff pane");
  await expect(pane.getByText(/vs\s*release\/windows/)).toBeVisible();
  const changed = dashboard.getByRole("navigation", { name: "Changed files" });
  await expect(changed.getByRole("button", { name: /own-change\.txt/ })).toBeVisible();
  await expect(changed.getByRole("button")).toHaveCount(1);
  await expect(changed.getByRole("button", { name: /release-only\.txt/ })).toHaveCount(0);

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await pane.screenshot({ path: `${EVIDENCE}diff-own-changes.png`, animations: "disabled" });
    // eslint-disable-next-line no-console
    console.log(`CAPTURED e2e/.artifacts/diff-task-base-branch/diff-own-changes.png`);
  }
});
