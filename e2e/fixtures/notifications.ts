import type { Page } from "@playwright/test";

import type { DaemonHandle } from "./daemon.ts";
import { expect } from "./test.ts";

const NOTIFICATIONS = "__e2eNotifications";

/** One desktop notification the dashboard raised, as `new Notification(title, { body, tag })` saw it. */
export interface RecordedNotification {
  title: string;
  body: string;
  tag: string;
}

/**
 * Replace `window.Notification` with a recorder that reports permission granted.
 *
 * The log lives in `sessionStorage` so it outlasts the spec's reload: a recorder rebuilt
 * empty by every navigation could not tell "the reloaded page stayed quiet" from "it alerted
 * again". `alerts.notifications` ships off, so it is switched on here too.
 */
export async function recordNotifications(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.addInitScript((key) => {
    class FakeNotification {
      onclick: (() => void) | null = null;
      static permission = "granted";
      static requestPermission = async (): Promise<string> => "granted";
      constructor(title: string, options?: { body?: string; tag?: string }) {
        const log = JSON.parse(sessionStorage.getItem(key) ?? "[]") as RecordedNotification[];
        log.push({ title, body: options?.body ?? "", tag: options?.tag ?? "" });
        sessionStorage.setItem(key, JSON.stringify(log));
      }
      close(): void {}
    }
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
  }, NOTIFICATIONS);
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alerts: { notifications: true, sound: false } }),
  });
  expect(response.ok, "the daemon accepted the alert settings").toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
}

/** Every notification the page raised since `recordNotifications`, oldest first. */
export async function recordedNotifications(page: Page): Promise<RecordedNotification[]> {
  return await page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key) ?? "[]") as RecordedNotification[],
    NOTIFICATIONS,
  );
}
