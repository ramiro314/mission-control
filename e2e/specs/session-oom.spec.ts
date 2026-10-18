import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { scopeArgvs } from "../fixtures/records.ts";

/**
 * A session whose systemd scope was stopped for an OOM kill fails its task with that reason.
 *
 * Linux-only, because the session scope exists only there. Nothing here reaches a real systemd:
 * `systemd-run` and `choom` are the suite's pass-through fakes, which record and exec in place,
 * and this file swaps in a `systemctl` that answers every `show` as a scope systemd stopped for
 * an OOM kill at a 1.5 GiB peak. The runtime directory holds listening `systemd/private` and
 * `bus` sockets, so the daemon reads a user manager as reachable and wraps for real, through the
 * fakes. The fake `claude` SIGKILLs itself on `E2E_OOM_KILLED`, as the kernel would.
 *
 * What travels for real: the spawn hook's exit listener reads the scope's verdict, the driver
 * awaits it before `exited`, the registry carries it through `beginEviction` past
 * `session_remove`, and `settleAgentGone` writes the text the Sitrep shows.
 */

const TASK = "E2E_OOM_KILLED build the thing";
const OOM_TEXT = "stopped: the session ran out of memory (peak 1.5 GB)";
const EVIDENCE = artifactsDir("session-oom");

// Short, because a Unix socket path is capped near 108 bytes.
const runtimeDir = mkdtempSync(join(tmpdir(), "mc-oom-"));
mkdirSync(join(runtimeDir, "systemd"));
const sockets: Server[] = [join(runtimeDir, "systemd", "private"), join(runtimeDir, "bus")].map((path) =>
  createServer((client) => client.end()).listen(path),
);
const systemctl = join(runtimeDir, "fake-systemctl");
writeFileSync(systemctl, `#!/bin/sh
[ "$1" = "--user" ] && shift
case "$1" in
  show) printf 'ActiveState=failed\\nResult=oom-kill\\nMemoryPeak=1610612736\\n' ;;
  reset-failed) ;;
  *) exit 1 ;;
esac
`);
chmodSync(systemctl, 0o755);

test.afterAll(() => {
  for (const server of sockets) server.close();
  rmSync(runtimeDir, { recursive: true, force: true });
});

test.use({
  daemonEnv: {
    XDG_RUNTIME_DIR: runtimeDir,
    MISSION_SYSTEMCTL_BIN: systemctl,
  },
});

interface TaskSnapshot {
  id: string;
  title: string;
  intent: string;
  status: string;
  error: string | null;
}

async function taskFor(daemon: DaemonHandle, intent: string): Promise<TaskSnapshot | undefined> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`);
  if (!response.ok) return undefined;
  return ((await response.json()) as TaskSnapshot[]).find((task) => task.intent === intent);
}

test("a session stopped for an OOM kill fails its task with the out-of-memory text", async ({ dashboard, daemon }) => {
  test.skip(process.platform !== "linux", "the session scope exists only on Linux");

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // Closes the repo combobox's listbox, which covers the Task field, not the modal.
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog.getByLabel("Kind").selectOption("ship");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  // The session went through the scope: the recorded systemd-run argv names the sessions slice.
  const isClaude = (argv: string[]) => argv.some((arg) => arg.endsWith("fake-claude"));
  await expect
    .poll(() => scopeArgvs(daemon.recordDir, "systemd-run-").filter(isClaude).length, {
      message: "the session never reached systemd-run",
    })
    .toBe(1);
  const [argv] = scopeArgvs(daemon.recordDir, "systemd-run-").filter(isClaude);
  expect(argv).toContain("--slice=app-mission\\x2dcontrol\\x2dsessions.slice");
  expect(argv).toContain("OOMPolicy=stop");

  await expect.poll(async () => (await taskFor(daemon, TASK))?.status, { timeout: 30_000 }).toBe("failed");
  const task = (await taskFor(daemon, TASK))!;
  expect(task.error).toContain(OOM_TEXT);

  // What a person reads: the Sitrep's recent outcome for the task.
  await expect(async () => {
    await dashboard.keyboard.press("Shift+P");
    await expect(dashboard.getByRole("dialog", { name: "Sitrep" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  const row = dashboard.getByRole("dialog", { name: "Sitrep" }).locator(".report-row", { hasText: task.title });
  await expect(row).toContainText("failed");
  await expect(row).toContainText(OOM_TEXT);
  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(EVIDENCE, { recursive: true });
    await row.screenshot({ path: join(EVIDENCE, "sitrep-oom-row.png") });
  }

  // And the daemon logged the stop once, where the seam read the scope.
  const logged = daemon.readLog().split("\n").filter((line) => line.includes("ran out of memory: systemd stopped"));
  expect(logged).toHaveLength(1);
  expect(logged[0]).toContain("(peak 1.5 GB)");
});
