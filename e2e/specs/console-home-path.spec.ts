import { mkdirSync } from "node:fs";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The console writes the DAEMON's home as `~`, whatever shape that home has.
 *
 * `shortenCwd` used to match `/Users/<name>` only, so on a Linux daemon a session's path showed
 * in full. The fixture daemon's home is a temp directory, which is neither shape, so a `~` here
 * can only come from the home the daemon named in its snapshot. `test/shorten-cwd.test.ts` pins
 * `/Users/<name>` and `/home/<name>` themselves.
 *
 * No model tokens: every agent binary is redirected by `e2e/fixtures/fake-agents.ts`.
 */

const EVIDENCE = artifactsDir("console-home-path");

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

test("a session under the daemon's home shows its path from ~ in the console", async ({
  dashboard: page,
  daemon,
}) => {
  test.setTimeout(120_000);
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("shorten the home path");
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let cwd = "";
  await expect
    .poll(async () => {
      const sessions = await api<Array<{ cwd: string; state: string }>>(daemon, "/api/sessions");
      cwd = sessions.find((s) => s.state !== "exited")?.cwd ?? "";
      return cwd;
    }, { message: "the dispatch settled with a checkout" })
    .not.toBe("");
  // The precondition the claim rests on: the checkout really is under the daemon's home.
  expect(cwd.startsWith(`${daemon.home}/`)).toBe(true);

  const layout = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  expect(layout.ok).toBe(true);
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.reload();

  await page
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Shorten the Home Path/i })
    .click();
  const path = page.locator(".cdetail .detail-sub dd.mono").first();
  await expect(path).toHaveText(/^~\//);
  await expect(path).not.toContainText(daemon.home);
  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(EVIDENCE, { recursive: true });
    await page.locator(".cdetail .detail-sub").screenshot({ path: `${EVIDENCE}path-from-home.png` });
  }
  // The full path is still a hover away.
  await path.hover();
  await expect(page.locator(".tooltip")).toContainText(daemon.home);
});
