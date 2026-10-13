import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { UpdateController } from "../../src/main/updater.ts";
import type { UpdateSnapshot } from "../../src/shared/update.ts";
import { expect, test } from "../fixtures/test.ts";

test("on Linux, Application updates says the packaged app is macOS only and offers no check", async ({ dashboard }) => {
  // The real controller, on a Linux port. A Linux checkout is never packaged, so this is the
  // shape `make start` gives the updater there; nothing past the platform refusal is reached.
  let queries = 0;
  const unreachable = () => { throw new Error("the Linux updater reached past its refusal"); };
  const controller = new UpdateController({
    packaged: false, platform: "linux", arch: "x64", currentVersion: () => "1.2.3", currentCommit: () => null,
    readAlpha: () => false, writeAlpha: () => {},
    installSnapshot: () => ({ receipt: null, problem: null }),
    latestRelease: async () => (queries += 1, unreachable()),
    latestMainCommit: async () => (queries += 1, unreachable()),
    runtime: async () => ({ ok: true, node: process.execPath }),
    stage: async () => unreachable(), stagedBundleIdentity: () => ({ version: null, revision: null }),
    handoff: async () => {}, requestQuit: () => {},
    helperSource: () => "", stateDirectory: () => "", readOutcome: () => null, clearOutcome: () => {},
    now: Date.now, random: () => 0, log: () => {},
    dialogs: { available: async () => "defer", upToDate: async () => {}, preparing: async () => {}, ready: async () => "defer", applying: async () => {}, error: async () => {}, outcome: async () => {} },
  });
  await controller.start();
  const snapshot = controller.getSnapshot();
  controller.stop();

  await dashboard.addInitScript((initial: UpdateSnapshot) => {
    Object.defineProperty(window, "missionDesktop", { value: {
      isDesktop: true, version: async () => "1.2.3", onOpenSettings: () => () => {},
      updates: {
        getState: async () => initial, setAlpha: async () => initial, check: async () => initial,
        apply: async () => initial, install: async () => initial, defer: async () => initial,
        onState: () => () => {},
      },
    } });
  }, snapshot);
  await dashboard.reload();
  await dashboard.getByRole("button", { name: "Settings" }).click();
  await dashboard.getByRole("tab", { name: "Setup" }).click();
  const panel = dashboard.getByRole("region", { name: "Application updates" });
  await expect(panel).toContainText(
    "The packaged app is macOS only; on Linux run from a checkout (see docs/setup.md).",
  );
  await expect(panel).not.toContainText("Updates are available only in the packaged app.");
  await expect(panel.getByRole("button", { name: "Check for updates" })).toBeDisabled();
  expect(queries).toBe(0);

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const dir = join(process.cwd(), "e2e/.artifacts/update-linux-reason");
    await mkdir(dir, { recursive: true });
    await dashboard.mouse.move(1, 1);
    await dashboard.screenshot({ path: join(dir, "linux-update-reason.png"), fullPage: true });
  }
});
