import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  closeBehavior,
  TRAY_HOST_PROBE_ARGS,
  TRAY_HOST_PROBE_TIMEOUT_MS,
  trayHostProbe,
  type TrayHostProbeDeps,
} from "../src/main/tray-host.ts";

const BUSCTL = { path: "/usr/bin/busctl", env: { PATH: "/usr/bin" } };

function timedOut(): Error {
  return Object.assign(new Error("Command failed: busctl"), { killed: true, signal: "SIGKILL", code: null });
}

function exited(): Error {
  return Object.assign(new Error("Failed to connect to bus"), { code: 1 });
}

/** One probe outcome per case the ticket names, each built from what `busctl` would do. */
const OUTCOMES: Record<string, Partial<TrayHostProbeDeps>> = {
  true: { locate: () => BUSCTL, run: async () => "b true\n" },
  false: { locate: () => BUSCTL, run: async () => "b false\n" },
  missing: { locate: () => null, run: async () => assert.fail("a missing busctl is never run") },
  error: { locate: () => BUSCTL, run: async () => { throw exited(); } },
  timeout: { locate: () => BUSCTL, run: async () => { throw timedOut(); } },
};

test("the probe asks the user bus whether the StatusNotifier watcher has an owner, bounded at 1 s", async () => {
  const calls: unknown[] = [];
  const probe = trayHostProbe({
    locate: () => BUSCTL,
    run: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return "b true\n";
    },
  });

  assert.equal(await probe(), true);
  assert.deepEqual(calls, [{
    executable: "/usr/bin/busctl",
    args: [
      "--user", "call",
      "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
      "NameHasOwner", "s", "org.kde.StatusNotifierWatcher",
    ],
    options: { env: { PATH: "/usr/bin" }, timeout: 1_000 },
  }]);
  assert.equal(TRAY_HOST_PROBE_TIMEOUT_MS, 1_000);
});

test("only `b true` is a tray host: false, missing, error and timeout all answer no", async () => {
  const answers = Object.fromEntries(
    await Promise.all(Object.entries(OUTCOMES).map(async ([name, deps]) => [name, await trayHostProbe(deps)()])),
  );
  assert.deepEqual(answers, { true: true, false: false, missing: false, error: false, timeout: false });
});

test("Linux hides only when the probe finds a tray host, and quits on every other outcome", async () => {
  const decisions: Record<string, string> = {};
  for (const [name, deps] of Object.entries(OUTCOMES)) {
    decisions[name] = await closeBehavior("linux", trayHostProbe(deps));
  }
  assert.deepEqual(decisions, { true: "hide", false: "quit", missing: "quit", error: "quit", timeout: "quit" });
});

test("macOS always hides and never probes, whatever the probe would have said", async () => {
  const decisions: Record<string, string> = {};
  for (const name of Object.keys(OUTCOMES)) {
    decisions[name] = await closeBehavior("darwin", async () => assert.fail(`darwin probed (${name})`));
  }
  assert.deepEqual(decisions, { true: "hide", false: "hide", missing: "hide", error: "hide", timeout: "hide" });
});

test("the default runner kills a busctl that hangs past the timeout and answers no", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "tray-host-"));
  try {
    const hang = join(dir, "busctl");
    writeFileSync(hang, "#!/bin/sh\nexec sleep 5\n");
    chmodSync(hang, 0o755);
    const answer = join(dir, "busctl-answers");
    writeFileSync(answer, `#!/bin/sh\n[ "$*" = "${TRAY_HOST_PROBE_ARGS.join(" ")}" ] && echo 'b true'\n`);
    chmodSync(answer, 0o755);

    assert.equal(await trayHostProbe({ locate: () => ({ path: answer, env: process.env }) })(), true);

    const started = Date.now();
    assert.equal(await trayHostProbe({ locate: () => ({ path: hang, env: process.env }) })(), false);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 900 && elapsed < 4_000, `timed out after ${elapsed} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
