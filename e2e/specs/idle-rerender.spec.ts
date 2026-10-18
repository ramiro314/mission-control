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
 * so this one test runs the development dashboard.
 */
test("an idle dashboard does not re-render App", async ({ dashboard, daemon }) => {
  test.setTimeout(240_000);
  await idleSession(daemon);
  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  const dev = await startDevDashboard(daemon);
  try {
    await dashboard.addInitScript(() => {
      const w = window as unknown as { __appRenders: number };
      w.__appRenders = 0;
      const count = (name: unknown): void => {
        if (name === "App" || name === "​App") w.__appRenders += 1;
      };
      const timeStamp = console.timeStamp.bind(console);
      console.timeStamp = ((name: string, ...rest: unknown[]) => {
        if (rest[2] === "Components ⚛") count(name);
        return (timeStamp as (...args: unknown[]) => void)(name, ...rest);
      }) as typeof console.timeStamp;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) count(entry.name);
      }).observe({ entryTypes: ["measure"] });
    });
    await dashboard.goto(`${dev.origin}/#/fleet`);
    await expect(dashboard.locator("main.board .tile")).toHaveCount(1);
    // Every hook's first read has landed by now, and the count proves the track is being
    // read at all - a React upgrade that moved it would otherwise pass this test vacuously.
    await dashboard.waitForTimeout(6_000);
    const atLoad = await dashboard.evaluate(() => (window as unknown as { __appRenders: number }).__appRenders);
    expect(atLoad, "React's component track should have reported App's first renders").toBeGreaterThan(0);

    // Three of the four-second polls and two of the five-second ones. Before the fix this
    // window held about six App renders, each one re-rendering the whole board.
    await dashboard.evaluate(() => {
      (window as unknown as { __appRenders: number }).__appRenders = 0;
    });
    await dashboard.waitForTimeout(12_000);
    const idle = await dashboard.evaluate(() => (window as unknown as { __appRenders: number }).__appRenders);
    expect(idle, "App should not re-render while nothing changes").toBeLessThanOrEqual(1);
  } finally {
    dev.stop();
  }
});
