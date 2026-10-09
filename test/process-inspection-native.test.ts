import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hasNativeAddonSources } from "../scripts/native-addon-sources.mjs";
import { readProcCwdsSnapshot } from "../src/server/discovery/proc-cwd.ts";
import { listProcessesSnapshot, type ProcessSnapshot } from "../src/server/discovery/processes.ts";
import { createWin32ProcessInspector, win32OwnerInScope } from "../src/server/process-inspection/win32.ts";
import { inspectWorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { ensureNativeProcessInspectionAddon } from "./helpers/native-process-inspection.ts";

/**
 * The real `native/process-inspection` addon against real processes. Everything else about the
 * win32 inspector is pinned with the addon faked, in `process-inspection.test.ts`; this is the
 * part a fake cannot say: that the PEB read finds the directory a process actually sits in, for a
 * native and a WOW64 process, and that the owner read recognizes this user.
 */
const noAddon = hasNativeAddonSources("process-inspection", process.platform)
  ? false
  : `process inspection has no native addon on ${process.platform}, where ps and lsof answer`;

const SYSTEM_ROOT = process.env.SystemRoot ?? "C:\\Windows";

/** A `cmd.exe` that waits for input in `cwd`, so it holds that directory until it is killed. */
async function shellIn(cmd: string, cwd: string): Promise<ChildProcess> {
  const shell = spawn(cmd, ["/d", "/q", "/k"], { cwd, stdio: ["pipe", "ignore", "ignore"] });
  await once(shell, "spawn");
  return shell;
}

/** The one real snapshot, narrowed to the processes this test owns. */
function only(snapshot: ProcessSnapshot, pids: readonly number[]): ProcessSnapshot {
  const keep = new Set(pids);
  return {
    ...snapshot,
    processes: snapshot.processes.filter((proc) => keep.has(proc.pid)),
    cwdScopePids: snapshot.cwdScopePids.filter((pid) => keep.has(pid)),
  };
}

test("the addon reads the owner and working directory of real native and WOW64 processes", { skip: noAddon, timeout: 120_000 }, async (t) => {
  const native = ensureNativeProcessInspectionAddon();
  const root = mkdtempSync(join(tmpdir(), "mission-process-inspection-"));
  const deep = join(root, "pool", "1", "repo", "src", "deep");
  const slot = join(root, "pool", "1", "repo");
  const wowSlot = join(root, "pool", "2", "repo");
  const idle = join(root, "pool", "3", "repo");
  for (const dir of [deep, wowSlot, idle]) mkdirSync(dir, { recursive: true });

  const shells: ChildProcess[] = [];
  t.after(async () => {
    // A process's cwd holds its directory open on Windows, so the shells go before the tree.
    for (const shell of shells) {
      if (shell.exitCode === null && shell.signalCode === null) {
        shell.kill();
        await once(shell, "exit");
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const shell = await shellIn(join(SYSTEM_ROOT, "System32", "cmd.exe"), deep);
  shells.push(shell);
  const wow = await shellIn(join(SYSTEM_ROOT, "SysWOW64", "cmd.exe"), wowSlot);
  shells.push(wow);
  const pids = [shell.pid!, wow.pid!];

  assert.deepEqual(native.owners([process.pid, ...pids]), [{ sameUser: true }, { sameUser: true }, { sameUser: true }]);
  // pid 4 is the System process: SYSTEM's, refused or another SID, and never in scope.
  assert.equal(win32OwnerInScope(native.owners([4])[0]), false);

  const inspector = createWin32ProcessInspector();
  assert.equal(inspector.userScopeUnavailable(), null);
  const snapshot = await listProcessesSnapshot(inspector);
  assert.equal(snapshot.unknownReason, null);
  for (const pid of [process.pid, ...pids]) assert.ok(snapshot.cwdScopePids.includes(pid), `${pid} is in scope`);

  const occupancy = await inspectWorktreeOccupancy([slot, wowSlot, idle], {
    listProcesses: async () => only(snapshot, pids),
    readCwds: (read) => readProcCwdsSnapshot(read, inspector),
    ownProcesses: () => new Set(),
  });
  const occupants = (target: string) => {
    const answer = occupancy.get(target);
    assert.equal(answer?.status, "known", JSON.stringify(answer));
    return answer.status === "known" ? answer.occupants.map((occupant) => [occupant.pid, occupant.cwd]) : [];
  };
  assert.deepEqual(occupants(slot), [[shell.pid, await realpath(deep)]], "a shell in a slot subdirectory occupies the slot");
  assert.deepEqual(occupants(wowSlot), [[wow.pid, await realpath(wowSlot)]], "a WOW64 shell is read through the 32-bit PEB");
  assert.deepEqual(occupants(idle), [], "an idle slot is known and empty");

  // The cwd is read live, not cached: a shell that changes directory is found in the new one.
  wow.stdin!.write(`cd /d "${idle}"\r\n`);
  const target = await realpath(idle);
  let moved: string | undefined;
  for (let attempt = 0; attempt < 100 && moved !== target; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cwd = (await inspector.readCwds([wow.pid!])).cwds.get(wow.pid!);
    moved = cwd === undefined ? undefined : await realpath(cwd);
  }
  assert.equal(moved, target);
});
