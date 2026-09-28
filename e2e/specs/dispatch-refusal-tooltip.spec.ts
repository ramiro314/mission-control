import { expect, test } from "../fixtures/test.ts";

/**
 * A refused dispatch must not leave the Dispatch button's tooltip printed over the refusal.
 *
 * Pressing the button disables it for the request, which makes `Tooltip` swap the button for
 * its `.tt-anchor` wrapper; the refusal re-enables it and swaps it back. The bubble opened
 * under the resting pointer used to survive that second swap at the coordinates it measured,
 * while the error paragraph pushed the button further down - so the bubble sat on the error.
 */
test("a refused dispatch leaves no stale tooltip over the error", async ({ dashboard, daemon }) => {
  // With the grill skill off, the daemon refuses a shape dispatch before anything exists.
  const res = await fetch(`${daemon.baseURL}/api/skills/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, skills: { grill: false, "html-plans": true, tickets: true } }),
  });
  expect(res.ok).toBeTruthy();

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Shape how exports should work");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("shape");
  await dialog.getByRole("combobox", { name: "After work", exact: true }).selectOption("__none");

  const go = dialog.getByRole("button", { name: "Dispatch now" });
  const tooltip = dashboard.locator(".tooltip");
  // The pointer rests on the button, so its tooltip is open when it is pressed.
  await go.hover();
  await expect(tooltip).toHaveText("Provision a worktree and launch the agent now (⌘/Ctrl+Enter)");
  await go.click();

  await expect(dialog.locator(".dispatch-error")).toContainText("Enable Skills and the grill skill");
  await expect(go).toBeEnabled();
  await expect(tooltip).toHaveCount(0);

  // Hover still works afterwards, and the bubble it opens is anchored to where the button is now.
  await dashboard.mouse.move(0, 0);
  await go.hover();
  await expect(tooltip).toBeVisible();
  const [tip, button] = await Promise.all([tooltip.boundingBox(), go.boundingBox()]);
  expect(tip && button, "both the tooltip and the button are laid out").toBeTruthy();
  expect(Math.abs(tip!.y + tip!.height - button!.y)).toBeLessThan(16);
});
