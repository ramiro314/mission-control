import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { startDevDashboard } from "../fixtures/dev-dashboard.ts";

/**
 * An idle dashboard stays still, and what should move still moves.
 *
 * The App-level polls (Foreman, cost, LLM, away mode) used to hand React a freshly parsed
 * object every few seconds even when the daemon said nothing new, and that re-rendered the
 * whole tree - every tile, card and tooltip - on a screen where nothing had changed. Those
 * re-renders were also, by accident, the only clock the "6s ago" labels had. So the fix is
 * two claims, and this file holds both: the labels keep advancing on their own clock, and a
 * poll that DID read something new still reaches the page.
 *
 * No model tokens: the dispatched agent is `e2e/fixtures/fake-agents.ts`.
 */

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/** One idle session on the board, over `POST /api/tasks` - the dispatch form has its own spec. */
async function idleSession(daemon: DaemonHandle): Promise<void> {
  await api(daemon, "/api/tasks", {
    repoRoot: daemon.repo,
    title: "sit idle",
    intent: "stay idle on the board",
    workflowId: null,
  });
  await expect.poll(async () => {
    const sessions = await api<Array<{ state: string; cwd: string | null }>>(daemon, "/api/sessions");
    return sessions.filter((s) => s.state === "idle" && s.cwd).length;
  }, { timeout: 120_000, message: "the dispatched session should settle idle" }).toBe(1);
}

async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  // A reload, because the web store reads the layout at boot.
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

test.describe("an idle board", () => {
  test.setTimeout(240_000);

  test("keeps its tile and backlog clocks advancing without anything else happening", async ({
    dashboard,
    daemon,
  }) => {
    await idleSession(daemon);
    // Filed last, right before the page loads, so its age starts at "just now" and has to
    // move within seconds - nothing else on the page is changing to carry it along.
    await api(daemon, "/api/tasks", {
      repoRoot: daemon.repo,
      title: "waiting its turn",
      intent: "sit in the backlog",
      backlog: true,
      workflowId: null,
    });
    await useBoardLayout(dashboard, daemon);

    const filed = dashboard.locator(".bl-card", { hasText: "waiting its turn" }).locator(".bl-added");
    await expect(filed).toHaveText("just now");
    await expect(filed).toHaveText(/^\d+s ago$/, { timeout: 15_000 });
    const firstAge = await filed.textContent();
    await expect(filed).not.toHaveText(firstAge!, { timeout: 5_000 });

    // The Backlog drawer's ages tick on their own too: it is handed no clock by App any more.
    await dashboard.getByRole("button", { name: /^Backlog, / }).click();
    const drawerAge = dashboard.locator(".line-bl-meta", { hasText: /\d+s ago$/ }).first();
    await expect(drawerAge).toBeVisible();
    const firstDrawerAge = await drawerAge.textContent();
    await expect(dashboard.locator(".line-bl-meta").first()).not.toHaveText(firstDrawerAge!, { timeout: 5_000 });
    // And the planner's "filed …" fact, which the popover now clocks for itself.
    await dashboard.getByRole("button", { name: "Next up: waiting its turn - why, and launch it now" }).click();
    const planner = dashboard.getByRole("dialog", { name: "Why waiting its turn is next up" });
    const filedFact = planner.locator(".bl-planner-why li", { hasText: /filed \d+s ago/ });
    await expect(filedFact).toBeVisible();
    const firstFact = await filedFact.textContent();
    await expect(planner.locator(".bl-planner-why li", { hasText: "filed " })).not.toHaveText(firstFact!, {
      timeout: 5_000,
    });
    await dashboard.keyboard.press("Escape");
    await dashboard.keyboard.press("Escape");

    // The tile's "last seen" reads seconds for its first minute and minutes after, so it moves
    // within a minute whichever side of that line the session settled on.
    const seen = dashboard.locator("main.board .tile .tile-seen");
    await expect(seen).toHaveText(/ago$|^just now$|^up /);
    const firstSeen = await seen.textContent();
    await expect(seen).not.toHaveText(firstSeen!, { timeout: 70_000 });
  });

  test("still opens a tile's tooltip with its own content", async ({ dashboard, daemon }) => {
    await idleSession(daemon);
    await useBoardLayout(dashboard, daemon);

    // Not `.tile-open`: it is the card-wide click target, laid out under the card's content.
    const trigger = dashboard.locator("main.board .tile [aria-describedby]:not(.tile-open)")
      .filter({ visible: true })
      .first();
    const described = await trigger.getAttribute("aria-describedby");
    expect(described, "a tile control carries a tooltip").not.toBeNull();
    const text = (await dashboard.locator(`[id="${described}"]`).textContent())!.trim();
    expect(text.length, "the tooltip has words in it").toBeGreaterThan(0);

    await trigger.hover();
    const bubble = dashboard.locator(".tooltip", { hasText: text });
    await expect(bubble).toBeVisible();
    // Across more than one poll of every App-level hook: the bubble neither closes nor
    // changes while nothing about its trigger does.
    await dashboard.waitForTimeout(6_000);
    await expect(bubble).toBeVisible();
    await expect(bubble).toHaveText(text);
  });

  test("still hears a poll that read something new", async ({ dashboard, daemon }) => {
    const alerts = dashboard.getByRole("button", { name: /^Alerts & away mode/ });
    await expect(alerts).toHaveAccessibleName(/ - (on|muted)$/);
    // Out of band, as another window or the tray would: only the five-second away poll can
    // carry this to the page, so it landing is the poll's answer getting through.
    await api(daemon, "/api/away", { away: true }, "PUT");
    await expect(alerts).toHaveAccessibleName("Alerts & away mode - away", { timeout: 15_000 });
    await api(daemon, "/api/away", { away: false }, "PUT");
    await expect(alerts).toHaveAccessibleName(/ - (on|muted)$/, { timeout: 15_000 });
  });
});

/**
 * The render count itself, read from React's development build.
 *
 * React 19.2 reports every component render on its "Components ⚛" performance track -
 * through `console.timeStamp`, or `performance.measure` when the props changed - which is
 * what the original report was read from. `dist/` is a production build with no such track,
 * so these tests run the development dashboard.
 */
async function countRenders(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __renders: Record<string, number> };
    w.__renders = {};
    const count = (name: string): void => {
      const bare = name.replace(/^\u200b/, "");
      w.__renders[bare] = (w.__renders[bare] ?? 0) + 1;
    };
    const timeStamp = console.timeStamp.bind(console);
    console.timeStamp = ((name: string, ...rest: unknown[]) => {
      if (rest[2] === "Components \u269b") count(name);
      return (timeStamp as (...args: unknown[]) => void)(name, ...rest);
    }) as typeof console.timeStamp;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) count(entry.name);
    }).observe({ entryTypes: ["measure"] });
  });
}

async function renders(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => ({ ...(window as unknown as { __renders: Record<string, number> }).__renders }));
}

/**
 * Renders per component across an idle window, after proving the track is being read at
 * all - a React upgrade that moved it would otherwise pass these tests vacuously.
 *
 * Twelve seconds is three of the four-second polls and two of the five-second ones.
 */
async function idleWindow(page: Page, mustHaveRendered: string): Promise<Record<string, number>> {
  // Every hook's first read has landed by now.
  await page.waitForTimeout(6_000);
  expect(
    (await renders(page))[mustHaveRendered] ?? 0,
    `React's component track should have reported ${mustHaveRendered}'s first renders`,
  ).toBeGreaterThan(0);
  // Off every control, so a resting pointer's tooltip is not part of the count.
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    (window as unknown as { __renders: Record<string, number> }).__renders = {};
  });
  await page.waitForTimeout(12_000);
  return renders(page);
}

test("an idle dashboard does not re-render App", async ({ dashboard, daemon }) => {
  test.setTimeout(240_000);
  await idleSession(daemon);
  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  const dev = await startDevDashboard(daemon);
  try {
    await countRenders(dashboard);
    await dashboard.goto(`${dev.origin}/#/fleet`);
    await expect(dashboard.locator("main.board .tile")).toHaveCount(1);
    const idle = await idleWindow(dashboard, "App");
    // Before the fix this window held about eight App renders, each one re-rendering the
    // whole board.
    expect(idle.App ?? 0, "App should not re-render while nothing changes").toBeLessThanOrEqual(1);
  } finally {
    dev.stop();
  }
});

/**
 * The conversation's tool runs, the second- and third-largest counts in the original report.
 *
 * They have no clock of their own - a folded run's span and timestamp are fixed facts - so
 * every render they did was App's poll cascading down. Five runs here rendered 95 times each
 * in thirty seconds before the fix: one per App render.
 */
test("an idle conversation does not re-render its tool runs", async ({ dashboard, daemon }) => {
  test.setTimeout(240_000);
  await api(daemon, "/api/tasks", {
    repoRoot: daemon.repo,
    title: "ran some tools",
    intent: "run some tools",
    workflowId: null,
  });
  type Row = { id: string; state: string; cwd: string | null; agentSessionId: string | null };
  const settled = async (): Promise<Row | undefined> =>
    (await api<Row[]>(daemon, "/api/sessions")).find((s) => s.state === "idle" && s.cwd && s.agentSessionId);
  await expect.poll(async () => Boolean(await settled()), {
    timeout: 120_000,
    message: "the dispatched session should settle idle",
  }).toBe(true);
  // `E2E_TERMINAL_RUN` is the fake agent's folded run of tool-only turns. Delivered on its
  // own, because the daemon wraps a dispatch's goal in context and the fake matches the
  // exact prompt.
  const { id } = (await settled())!;
  await api(daemon, `/api/sessions/${encodeURIComponent(id)}/inject`, {
    text: "E2E_TERMINAL_RUN",
    origin: "foreman",
    buffer: false,
  });
  await api(daemon, "/api/ui/config", { layout: "console", conversationView: "terminal" }, "PUT");
  const dev = await startDevDashboard(daemon);
  try {
    await countRenders(dashboard);
    await dashboard.goto(`${dev.origin}/#/fleet`);
    await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
    await expect(dashboard.locator(".pty-toolrun")).toHaveCount(1);
    const idle = await idleWindow(dashboard, "TerminalToolRun");
    expect(idle.TerminalToolRun ?? 0, "a finished tool run should not re-render").toBe(0);
    expect(idle.ToolChips ?? 0, "its command list should not re-render").toBe(0);
    expect(idle.App ?? 0, "App should not re-render while nothing changes").toBeLessThanOrEqual(1);
  } finally {
    dev.stop();
  }
});
