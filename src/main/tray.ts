// Menu-bar presence. The tray shows a live one-line session summary and a menu of
// app-level actions. Counts come from polling the daemon's /api/report (the same
// projection the Roundup panel uses) - simple and robust; sub-second latency
// isn't needed for a status glance.

import { Tray, Menu, nativeImage, app } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { existsSync } from "node:fs";
import { BASE_URL } from "@shared/harness-runtime.mjs";
import { trayIcon } from "./platform-icons.ts";
import { startAtLogin } from "./login-item.ts";

interface ReportCounts {
  needsYou: number;
  working: number;
  idle: number;
  backlog: number;
}

export interface TrayHandlers {
  onOpen: () => void;
  onCheckForUpdates: () => void;
  onInstallIntegrations: () => void;
  onRemoveIntegrations: () => void;
  onQuit: () => void;
}

let tray: Tray | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let last: ReportCounts = { needsYou: 0, working: 0, idle: 0, backlog: 0 };
let buildDir = "";
let shownIcon = "";

function trayImage(iconPath: string, template: boolean): Electron.NativeImage {
  if (iconPath && existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) {
      if (template) img.setTemplateImage(true); // recolors for light/dark menu bars
      return img;
    }
  }
  return nativeImage.createEmpty();
}

function summary(c: ReportCounts): string {
  return `${c.needsYou} need you · ${c.working} working · ${c.idle} idle`;
}

function render(handlers: TrayHandlers): void {
  if (!tray) return;
  const c = last;
  tray.setToolTip(`Mission Control - ${summary(c)}`);
  // A short title next to the icon draws the eye when something needs you. It is
  // macOS-only, so elsewhere the icon itself swaps to a badged image.
  tray.setTitle(c.needsYou > 0 ? ` ${c.needsYou}` : "");
  const icon = trayIcon(process.platform, buildDir, c.needsYou);
  if (icon.path !== shownIcon) {
    tray.setImage(trayImage(icon.path, icon.template));
    shownIcon = icon.path;
  }

  const login = startAtLogin(process.platform, {
    get: () => app.getLoginItemSettings().openAtLogin,
    set: (openAtLogin) => app.setLoginItemSettings({ openAtLogin }),
  });
  const template: MenuItemConstructorOptions[] = [
    { label: `Mission Control`, enabled: false },
    { label: summary(c), enabled: false },
    { type: "separator" },
    { label: "Open Dashboard", click: () => handlers.onOpen() },
    { label: "Check for Updates…", click: () => handlers.onCheckForUpdates() },
    { type: "separator" },
    {
      label: "Start at login",
      type: "checkbox",
      checked: login.checked,
      enabled: login.enabled,
      click: (item) => {
        try {
          login.set(item.checked);
        } catch (error) {
          console.error("[mission-control] could not change Start at login:", error);
        }
        // Show what is on disk now, whether or not the change took.
        render(handlers);
      },
    },
    ...(login.hint ? [{ label: login.hint, enabled: false }] : []),
    { label: "Install Claude integrations…", click: () => handlers.onInstallIntegrations() },
    { label: "Remove Claude integrations", click: () => handlers.onRemoveIntegrations() },
    { type: "separator" },
    { label: "Quit Mission Control", click: () => handlers.onQuit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

async function refresh(handlers: TrayHandlers): Promise<void> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${BASE_URL}/api/report`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return;
    const report = (await res.json()) as { counts?: Partial<ReportCounts> };
    const c = report.counts ?? {};
    last = {
      needsYou: c.needsYou ?? 0,
      working: c.working ?? 0,
      idle: c.idle ?? 0,
      backlog: c.backlog ?? 0,
    };
    render(handlers);
  } catch {
    /* daemon momentarily unreachable - keep the last summary */
  }
}

/** `dir` holds the images `scripts/gen-icons.mjs` generates. */
export function createTray(dir: string, handlers: TrayHandlers): Tray {
  buildDir = dir;
  const icon = trayIcon(process.platform, buildDir, last.needsYou);
  tray = new Tray(trayImage(icon.path, icon.template));
  shownIcon = icon.path;
  tray.on("click", () => handlers.onOpen());
  render(handlers);
  void refresh(handlers);
  poll = setInterval(() => void refresh(handlers), 3000);
  return tray;
}

export function destroyTray(): void {
  if (poll) clearInterval(poll);
  poll = null;
  tray?.destroy();
  tray = null;
  shownIcon = "";
}
