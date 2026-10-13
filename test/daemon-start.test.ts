import assert from "node:assert/strict";
import test from "node:test";

import type { DaemonCompatibility } from "../src/shared/daemon-protocol.ts";
import {
  afterDaemonExit,
  DAEMON_UNIT,
  decideDaemonStart,
  STATE_CONTENTION_EXIT_STATUS,
  UNIT_ADOPT_POLL_MS,
  UNIT_ADOPT_TIMEOUT_MS,
  UNIT_STATE_TIMEOUT_MS,
  unitStateProbe,
  type DaemonStartDeps,
} from "../src/main/daemon-start.ts";
import { STATE_CONTENTION_EXIT_STATUS as DAEMON_CONTENTION_EXIT_STATUS } from "../src/server/state-ownership.ts";

/**
 * A fake clock that only moves when the decision sleeps, a health probe that answers from a
 * script (repeating its last answer), and a `systemctl` that answers one state.
 */
function harness(platform: NodeJS.Platform, unit: string, answers: DaemonCompatibility[]) {
  let now = 0;
  const calls = { probes: 0, unit: 0, sleeps: [] as number[] };
  const deps: DaemonStartDeps = {
    platform,
    probe: async () => answers[Math.min(calls.probes++, answers.length - 1)]!,
    unitState: async () => {
      calls.unit++;
      return unit;
    },
    sleep: async (ms) => {
      calls.sleeps.push(ms);
      now += ms;
    },
    now: () => now,
  };
  return { deps, calls, elapsed: () => now };
}

test("a daemon that answers is adopted, or refused as incompatible, without asking systemd, on both platforms", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    const adopt = harness(platform, "active", []);
    assert.equal(await decideDaemonStart("compatible", adopt.deps), "adopt", platform);
    assert.equal(adopt.calls.unit, 0, platform);
    const older = harness(platform, "active", []);
    assert.equal(await decideDaemonStart("incompatible", older.deps), "incompatible", platform);
    assert.equal(older.calls.unit, 0, platform);
  }
});

test("macOS supervises its own daemon when nothing answers, and never asks systemd", async () => {
  const mac = harness("darwin", "active", ["compatible"]);
  assert.equal(await decideDaemonStart("unreachable", mac.deps), "supervise");
  assert.deepEqual(mac.calls, { probes: 0, unit: 0, sleeps: [] });
});

test("Linux supervises its own daemon when the unit is not running or cannot be asked", async () => {
  // "" is what the probe reports for no systemctl, a timeout or any other failure.
  for (const state of ["inactive", "failed", "deactivating", "maintenance", "unknown", ""]) {
    const h = harness("linux", state, ["compatible"]);
    assert.equal(await decideDaemonStart("unreachable", h.deps), "supervise", state);
    assert.equal(h.calls.unit, 1, state);
    assert.equal(h.calls.probes, 0, `${state}: no wait`);
  }
});

test("Linux waits for a running or starting unit's health at 500 ms polls and adopts it instead of spawning", async () => {
  for (const state of ["active", "activating", "reloading"]) {
    const h = harness("linux", state, ["unreachable", "unreachable", "unreachable", "compatible"]);
    assert.equal(await decideDaemonStart("unreachable", h.deps), "adopt", state);
    assert.deepEqual(h.calls.sleeps, [500, 500, 500, 500], state);
    assert.equal(h.calls.probes, 4, state);
  }
  assert.equal(UNIT_ADOPT_POLL_MS, 500);
});

test("Linux gives up on a unit that never answers after 30 s and reports it as unresponsive", async () => {
  const h = harness("linux", "active", ["unreachable"]);
  assert.equal(await decideDaemonStart("unreachable", h.deps), "unit-unresponsive");
  assert.equal(UNIT_ADOPT_TIMEOUT_MS, 30_000);
  assert.equal(h.elapsed(), 30_000);
  assert.equal(h.calls.probes, 60);
});

test("Linux refuses a unit daemon from an older build the way it refuses one that already answered", async () => {
  const h = harness("linux", "activating", ["unreachable", "incompatible"]);
  assert.equal(await decideDaemonStart("unreachable", h.deps), "incompatible");
});

test("only a Linux daemon that lost the state lock decides again; macOS restarts on 75 as on any exit", async () => {
  let decisions = 0;
  const decide = (answer: Awaited<ReturnType<typeof decideDaemonStart>>) => async () => {
    decisions++;
    return answer;
  };
  assert.equal(await afterDaemonExit("darwin", 75, decide("adopt")), "restart");
  assert.equal(await afterDaemonExit("linux", 1, decide("adopt")), "restart");
  assert.equal(await afterDaemonExit("linux", 0, decide("adopt")), "restart");
  assert.equal(decisions, 0);
  assert.equal(await afterDaemonExit("linux", 75, decide("adopt")), "adopt");
  assert.equal(await afterDaemonExit("linux", 75, decide("unit-unresponsive")), "unit-unresponsive");
  assert.equal(await afterDaemonExit("linux", 75, decide("incompatible")), "incompatible");
  // The owner went away before the re-probe: nothing else will start a daemon, so restart.
  assert.equal(await afterDaemonExit("linux", 75, decide("supervise")), "restart");
  assert.equal(decisions, 4);
});

test("the shell's contention status is the one the daemon exits with", () => {
  assert.equal(STATE_CONTENTION_EXIT_STATUS, DAEMON_CONTENTION_EXIT_STATUS);
  assert.equal(STATE_CONTENTION_EXIT_STATUS, 75);
});

test("the unit probe asks systemctl --user is-active for the installed unit, bounded at 1 s", async () => {
  const calls: unknown[] = [];
  const probe = unitStateProbe({
    locate: () => ({ path: "/usr/bin/systemctl", env: { PATH: "/usr/bin" } }),
    run: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return "activating\n";
    },
  });
  assert.equal(await probe(), "activating");
  assert.equal(DAEMON_UNIT, "mission-control.service");
  assert.deepEqual(calls, [{
    executable: "/usr/bin/systemctl",
    args: ["--user", "is-active", "mission-control.service"],
    options: { env: { PATH: "/usr/bin" }, timeout: UNIT_STATE_TIMEOUT_MS },
  }]);
  assert.equal(UNIT_STATE_TIMEOUT_MS, 1_000);
});

test("a missing systemctl or a failed call reads as no state, which supervises", async () => {
  assert.equal(await unitStateProbe({ locate: () => null, run: async () => assert.fail("never run") })(), "");
  const failing = unitStateProbe({
    locate: () => ({ path: "/usr/bin/systemctl", env: {} }),
    run: async () => { throw new Error("killed at the timeout"); },
  });
  assert.equal(await failing(), "");
});

test("the default runner reads the state systemctl prints even when it exits non-zero", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX shell fixture");
  const { mkdtempSync, rmSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mission-systemctl-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, "systemctl");
  // `is-active` prints the state and exits 3 for an inactive unit.
  writeFileSync(fake, "#!/bin/sh\necho inactive\nexit 3\n");
  chmodSync(fake, 0o755);
  const probe = unitStateProbe({ locate: () => ({ path: fake, env: { PATH: "/usr/bin:/bin" } }) });
  assert.equal(await probe(), "inactive");
});
