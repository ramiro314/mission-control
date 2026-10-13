import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeepAwakeStatus } from "../src/shared/types.ts";
import { KeepAwakeManager } from "../src/server/keep-awake.ts";

/**
 * The Linux provider against real processes: the manager's own spawn, the real
 * process-lifetime seam and the real GNU `tail --pid`, with only `systemd-inhibit` faked,
 * because CI has no logind session to hold a lock for. The fake does what the real one does
 * with its command - runs it as a child and exits when it does - and records that child's
 * PID, so each test can prove the `tail` itself is gone and not only its parent.
 */

const FAKE_INHIBIT = `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --*) shift ;; *) break ;; esac; done
"$@" &
echo $! > "$0.child"
wait $!
`;

const linuxOnly = { skip: process.platform !== "linux" && "systemd-inhibit is Linux-only" };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "keep-awake-linux-"));
  const bin = join(dir, "systemd-inhibit");
  writeFileSync(bin, FAKE_INHIBIT);
  chmodSync(bin, 0o755);
  return { dir, bin, childPidFile: `${bin}.child` };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(what: string, check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function tailPid(childPidFile: string): Promise<number> {
  await until("the inhibitor's command to start", () => existsSync(childPidFile) && readFileSync(childPidFile, "utf8").trim() !== "");
  return Number(readFileSync(childPidFile, "utf8").trim());
}

test("Linux off ends systemd-inhibit and its tail together", linuxOnly, async () => {
  const { dir, bin, childPidFile } = fixture();
  const manager = new KeepAwakeManager({
    platform: "linux",
    override: null,
    locateInhibitor: () => bin,
  });
  try {
    assert.equal((await manager.setEnabled(true)).state, "on");
    const tail = await tailPid(childPidFile);
    assert.ok(alive(tail), "tail runs while keep awake is on");

    assert.equal((await manager.setEnabled(false)).state, "off");
    await until("the tail to exit with its tree", () => !alive(tail));
  } finally {
    await manager.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Linux daemon death ends the inhibitor without any call from the daemon", linuxOnly, async () => {
  const { dir, bin, childPidFile } = fixture();
  // A stand-in daemon whose PID the inhibitor's command watches.
  const daemon = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
  await new Promise((resolve) => daemon.once("spawn", resolve));
  const statuses: KeepAwakeStatus[] = [];
  const manager = new KeepAwakeManager({
    platform: "linux",
    override: null,
    locateInhibitor: () => bin,
    daemonPid: daemon.pid!,
    onStatus: (status) => statuses.push(status),
  });
  try {
    assert.equal((await manager.setEnabled(true)).state, "on");
    const tail = await tailPid(childPidFile);

    daemon.kill("SIGKILL");
    // GNU tail checks `--pid` about once a second; nothing here signals the inhibitor.
    await until("the inhibitor to exit after the daemon", () => manager.status().state === "error");
    assert.ok(!alive(tail), "tail exited with the daemon");
    assert.match(manager.status().error ?? "", /systemd-inhibit process exited unexpectedly \(code 0/);
    assert.deepEqual(statuses.map((s) => s.state), ["starting", "on", "error"]);
  } finally {
    daemon.kill("SIGKILL");
    await manager.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
