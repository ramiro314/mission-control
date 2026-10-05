import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

import type { Locator, Page, Response } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * A task's base branch, set, refused, shown and cleared from the dashboard.
 *
 * The daemon checks the branch against the repository's real `origin` (`resolveBaseBranch`,
 * one `ls-remote`), so the fixture repo's bare origin is given a second branch here rather than
 * faked. Nothing is dispatched, so no agent runs and no model tokens are spent.
 */

const EVIDENCE = artifactsDir("task-base-branch");

async function shoot(page: Page, name: string, target: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Grown for the capture and put straight back, so the assertions run at the default size.
  const restore = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  if (restore) await page.setViewportSize(restore);
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/task-base-branch/${name}.png`);
}

async function useBoard(page: Page, baseURL: string): Promise<void> {
  const response = await fetch(`${baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(response.ok, "the daemon should accept the Board layout").toBe(true);
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

function taskWrite(page: Page, path: RegExp): Promise<Response> {
  return page.waitForResponse(
    (response) => response.request().method() === "POST" && path.test(new URL(response.url()).pathname),
  );
}

test("a base branch is set, refused, labelled on the card, and edited back to the default", async ({ dashboard, daemon }) => {
  const title = "Port the lock to release";
  execFileSync("git", ["-C", daemon.repo, "push", "-q", "origin", "main:refs/heads/release/next"], {
    stdio: "pipe",
  });

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // RepoCombobox portals its list over the form. Close it before reaching fields below.
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Port the state lock to the release branch.");
  await dialog.getByRole("button", { name: /^Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(title);
  const base = dialog.getByLabel("Base branch");

  // A branch origin does not have is refused by the daemon, and the refusal is printed on the
  // form the operator is still standing in, with nothing created.
  await base.fill("release/gone");
  const refused = taskWrite(dashboard, /^\/api\/tasks$/);
  await dialog.getByRole("button", { name: "Add to backlog" }).click();
  expect((await refused).status()).toBe(400);
  await expect(dialog.getByText(/base branch release\/gone does not exist on .*'s origin/)).toBeVisible();
  await expect(dialog).toBeVisible();
  await expectContentClearsBorder(dialog);
  await shoot(dashboard, "01-refusal-in-form", dialog);

  await base.fill("release/next");
  const created = taskWrite(dashboard, /^\/api\/tasks$/);
  await dialog.getByRole("button", { name: "Add to backlog" }).click();
  const createdResponse = await created;
  expect(createdResponse.ok(), `creating the task answered ${createdResponse.status()}`).toBe(true);
  expect(await createdResponse.json()).toMatchObject({ title, baseBranch: "release/next" });
  await expect(dialog).toBeHidden();

  // Board only once a task exists: an empty dashboard draws the no-sessions screen instead.
  await useBoard(dashboard, daemon.baseURL);
  const card = dashboard.locator(".bl-card", { hasText: title });
  await expect(card.getByText("base release/next", { exact: true })).toBeVisible();
  await shoot(dashboard, "02-card-label", card);

  // The editor reads the stored base back, and clearing it returns the task to the default.
  await card.getByRole("button", { name: title, exact: true }).click();
  const editor = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  const editBase = editor.getByLabel("Base branch");
  await expect(editBase).toHaveValue("release/next");
  await expectContentClearsBorder(editor);
  await shoot(dashboard, "03-editor-field", editor);
  await editBase.fill("");
  const cleared = taskWrite(dashboard, /^\/api\/tasks\/[^/]+\/update$/);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  expect((await cleared).ok()).toBe(true);
  await expect(editor).toBeHidden();
  await expect(card).toBeVisible();
  await expect(card.locator(".bl-base")).toHaveCount(0);
  await shoot(dashboard, "04-card-default", card);

  // Naming origin's default explicitly is the same as leaving it empty: no label, and the
  // editor reopens on an empty field.
  await card.getByRole("button", { name: title, exact: true }).click();
  await editBase.fill("main");
  const toDefault = taskWrite(dashboard, /^\/api\/tasks\/[^/]+\/update$/);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  expect((await toDefault).ok()).toBe(true);
  await expect(editor).toBeHidden();
  await expect(card.locator(".bl-base")).toHaveCount(0);
  await card.getByRole("button", { name: title, exact: true }).click();
  await expect(editBase).toHaveValue("");
});
