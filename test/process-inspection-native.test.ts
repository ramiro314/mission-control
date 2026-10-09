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
import { createWin32ProcessInspector, win32CwdFromDosPath, win32OwnerInScope } from "../src/server/process-inspection/win32.ts";
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

  const inspector = createWin32ProcessInspector();
  assert.equal(inspector.userScopeUnavailable(), null);
  const snapshot = await listProcessesSnapshot(inspector);
  assert.equal(snapshot.unknownReason, null);
  for (const pid of [process.pid, ...pids]) assert.ok(snapshot.cwdScopePids.includes(pid), `${pid} is in scope`);
  // pid 4 is the System process, in the services session: refused or another SID, never in scope.
  assert.ok(!snapshot.cwdScopePids.includes(4), "the System process is out of scope");

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

// ---- the addon's own failures ----

/** Win32 errors the addon reports. */
const ERROR_ACCESS_DENIED = 5;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_INVALID_DATA = 13;
const ERROR_PARTIAL_COPY = 299;
const ERROR_NOACCESS = 998;

/** Where the fake address space starts, and where each structure sits in it. */
const BASE = 0x7ff6_0000;
const PEB = BASE;
const PARAMS = BASE + 0x100;
const TEXT = BASE + 0x200;
const SIZE = 0x400;

interface Layout {
  wow64: boolean;
  paramsInPeb: number;
  curdirInParams: number;
  pointer: number;
}
const LAYOUT_64: Layout = { wow64: false, paramsInPeb: 0x20, curdirInParams: 0x38, pointer: 8 };
const LAYOUT_32: Layout = { wow64: true, paramsInPeb: 0x10, curdirInParams: 0x24, pointer: 4 };

interface Image {
  bytes: Uint8Array;
  view: DataView;
  /** Overwrite a pointer-sized field at an absolute address. */
  pointer(address: number, value: number): void;
  /** Absolute address of a field of CurrentDirectory.DosPath. */
  dosPath: { length: number; maximum: number; buffer: number };
}

/**
 * One snapshot of a healthy address space: a PEB pointing at a normalized parameter block whose
 * CurrentDirectory.DosPath names `path`, laid out as `layout` lays it out. Each case below then
 * breaks exactly one thing.
 */
function image(layout: Layout, path: string): Image {
  const bytes = new Uint8Array(SIZE);
  const view = new DataView(bytes.buffer);
  const at = (address: number) => address - BASE;
  const pointer = (address: number, value: number) => {
    if (layout.pointer === 8) view.setBigUint64(at(address), BigInt(value), true);
    else view.setUint32(at(address), value, true);
  };
  pointer(PEB + layout.paramsInPeb, PARAMS);
  view.setUint32(at(PARAMS), 0x300, true); // MaximumLength
  view.setUint32(at(PARAMS + 4), 0x300, true); // Length
  view.setUint32(at(PARAMS + 8), 0x1, true); // Flags: RTL_USER_PROC_PARAMS_NORMALIZED
  const curdir = PARAMS + layout.curdirInParams;
  const text = Buffer.from(path, "utf16le");
  view.setUint16(at(curdir), text.length, true);
  view.setUint16(at(curdir + 2), 0x208, true);
  pointer(curdir + layout.pointer, TEXT);
  bytes.set(text, at(TEXT));
  return { bytes, view, pointer, dosPath: { length: curdir, maximum: curdir + 2, buffer: curdir + layout.pointer } };
}

const SLOT = "C:\\pool\\1\\repo\\";
const OTHER = "D:\\elsewhere\\";

test("the addon's cwd parser answers a path only for a structure that holds every layout invariant", { skip: noAddon }, () => {
  const native = ensureNativeProcessInspectionAddon();
  const read = (images: Image[], layout: Layout, peb = PEB) =>
    native.readCwdFromImages(images.map((one) => one.bytes), BASE, peb, layout.wow64);
  const broken = (layout: Layout, mutate: (one: Image) => void) => {
    const one = image(layout, SLOT);
    mutate(one);
    return read([one], layout);
  };
  const invalid = { failed: "layout", code: ERROR_INVALID_DATA };

  for (const layout of [LAYOUT_64, LAYOUT_32]) {
    const name = layout.wow64 ? "32-bit" : "64-bit";
    assert.deepEqual(read([image(layout, SLOT)], layout), { cwd: SLOT }, `${name}: the healthy structure reads`);

    const cases: Array<[string, (one: Image) => void, object]> = [
      ["a DosPath Length above its MaximumLength", (one) => one.view.setUint16(one.dosPath.maximum - BASE, 4, true), invalid],
      ["an odd DosPath Length", (one) => one.view.setUint16(one.dosPath.length - BASE, 7, true), invalid],
      ["an empty DosPath", (one) => one.view.setUint16(one.dosPath.length - BASE, 0, true), invalid],
      ["a null DosPath buffer", (one) => one.pointer(one.dosPath.buffer, 0), invalid],
      ["a DosPath buffer outside the address space", (one) => one.pointer(one.dosPath.buffer, 0x1000), { failed: "ReadProcessMemory", code: ERROR_NOACCESS }],
      ["a DosPath buffer running off the end", (one) => one.pointer(one.dosPath.buffer, BASE + SIZE - 4), { failed: "ReadProcessMemory", code: ERROR_PARTIAL_COPY }],
      ["a parameter block that is not normalized", (one) => one.view.setUint32(PARAMS + 8 - BASE, 0, true), invalid],
      ["a parameter block too short to hold CURDIR", (one) => one.view.setUint32(PARAMS + 4 - BASE, layout.curdirInParams, true), invalid],
      ["a parameter block longer than its allocation", (one) => one.view.setUint32(PARAMS - BASE, 0x10, true), invalid],
      ["a null ProcessParameters", (one) => one.pointer(PEB + layout.paramsInPeb, 0), invalid],
      ["a ProcessParameters outside the address space", (one) => one.pointer(PEB + layout.paramsInPeb, 0x1000), { failed: "ReadProcessMemory", code: ERROR_NOACCESS }],
    ];
    for (const [label, mutate, expected] of cases) {
      assert.deepEqual(broken(layout, mutate), expected, `${name}: ${label} fails, never a path`);
    }
    assert.deepEqual(read([image(layout, SLOT)], layout, 0), invalid, `${name}: a null PEB fails`);

    // A cwd that keeps changing under the reader is never half of one path and half of another,
    // and one that settles answers the settled path, not the first one seen.
    const flapping = [SLOT, OTHER, SLOT, OTHER, SLOT, OTHER].map((path) => image(layout, path));
    assert.deepEqual(read(flapping, layout), { failed: "stable read", code: ERROR_INVALID_DATA }, `${name}: a cwd that never settles fails`);
    assert.deepEqual(read([image(layout, SLOT), image(layout, OTHER)], layout), { cwd: OTHER }, `${name}: a cwd that settles reads the settled path`);
  }

  // The wrong layout is a layout surprise too: each finds no parameter block where it looks.
  assert.deepEqual(read([image(LAYOUT_32, SLOT)], LAYOUT_64), invalid, "a 32-bit PEB read as 64-bit fails");
  assert.deepEqual(read([image(LAYOUT_64, SLOT)], LAYOUT_32), invalid, "a 64-bit PEB read as 32-bit fails");

  // Text the structure carries intact but that is no cwd: the addon hands it over, and the
  // inspector's shape check (`win32CwdFromDosPath`) is what refuses it.
  for (const text of ["pool\\1\\", "C:\\pool\\1", "\\\\.\\pipe\\x\\"]) {
    const answer = read([image(LAYOUT_64, text)], LAYOUT_64);
    assert.deepEqual(answer, { cwd: text });
    assert.equal(win32CwdFromDosPath(text), null, `${JSON.stringify(text)} is not a cwd`);
  }

  assert.throws(() => native.readCwdFromImages([], BASE, PEB, false), /expected images, base, peb and wow64/);
});

test("the addon refuses an impossible pid, and reports a refused open and an exited process as failed reads", { skip: noAddon, timeout: 60_000 }, async (t) => {
  const native = ensureNativeProcessInspectionAddon();
  for (const read of [native.owners, native.cwds]) {
    for (const pid of [0, -1, 1.5, 2 ** 32, Number.NaN]) {
      assert.throws(() => read([pid]), /every pid must be a positive 32-bit integer/, `pid ${pid}`);
    }
    assert.throws(() => read(["7" as unknown as number]), /every pid must be a positive 32-bit integer/);
    assert.throws(() => (read as (value: unknown) => unknown)(7), /expected one array of pids/);
  }

  // pid 4 is the System process: protected, so no caller without kernel help may read its memory.
  assert.deepEqual(native.cwds([4]), [{ failed: "OpenProcess", code: ERROR_ACCESS_DENIED }]);

  // An exited process whose handle is still held, as this process holds its child's until the
  // exit event is delivered. Polling synchronously keeps the event loop from delivering it, so
  // the pid cannot be released, let alone reused, while the addon looks at it.
  const child = spawn(join(SYSTEM_ROOT, "System32", "cmd.exe"), ["/d", "/q", "/k"], { stdio: ["pipe", "ignore", "ignore"] });
  await once(child, "spawn");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  });
  const pid = child.pid!;
  assert.deepEqual(native.owners([pid]), [{ sameUser: true }]);
  child.kill();
  const deadline = Date.now() + 10_000;
  let owner = native.owners([pid])[0];
  while ((owner as { failed?: string }).failed !== "exited" && Date.now() < deadline) owner = native.owners([pid])[0];
  assert.deepEqual(owner, { failed: "exited", code: 0 });
  assert.deepEqual(native.cwds([pid]), [{ failed: "exited", code: 0 }]);
  assert.equal(win32OwnerInScope(owner), false, "an exited process is out of scope");
});

test("the identity read answers a creation time and a command line, and nothing for an exited process", { skip: noAddon, timeout: 60_000 }, async (t) => {
  const native = ensureNativeProcessInspectionAddon();
  for (const pid of [0, -1, 1.5, 2 ** 32, Number.NaN]) {
    assert.throws(() => native.identity(pid), /expected one pid, a positive 32-bit integer/, `pid ${pid}`);
  }

  const own = native.identity(process.pid) as { start: string; command: string };
  assert.match(own.start, /^[1-9]\d*$/, "100-nanosecond ticks, not a printed time");
  assert.match(own.command, /node/i);
  assert.deepEqual(native.identity(process.pid), own, "the same process reads the same both times");

  const child = spawn(join(SYSTEM_ROOT, "System32", "cmd.exe"), ["/d", "/q", "/k"], { stdio: ["pipe", "ignore", "ignore"] });
  await once(child, "spawn");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  });
  const pid = child.pid!;
  const started = native.identity(pid) as { start: string; command: string };
  assert.ok(BigInt(started.start) > BigInt(own.start), "a process started later was created later");
  assert.match(started.command, /cmd\.exe/i);

  // Held and polled synchronously, as in the exited-process case above, so the pid cannot be
  // reused while the addon looks at it: a handle outliving its process never reads as alive.
  child.kill();
  const deadline = Date.now() + 10_000;
  let answer = native.identity(pid);
  while ((answer as { failed?: string }).failed !== "exited" && Date.now() < deadline) answer = native.identity(pid);
  assert.deepEqual(answer, { failed: "exited", code: 0 });
});

test("a check job holds what its process starts, outlives the process, and ends with one call", { skip: noAddon, timeout: 60_000 }, async (t) => {
  const native = ensureNativeProcessInspectionAddon();
  // Waits to be told, then starts a grandchild that outlives it: the `server & exit 0` shape a
  // parent-pid tree forgets the moment its parent goes. Detached, or Node's own job would end it
  // with the leader; detaching leaves Node's job and never the check's, which allows no breakaway.
  const leader = spawn(
    process.execPath,
    [
      "-e",
      "process.stdin.once('data', () => {" +
        " const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });" +
        " process.stdout.write(String(c.pid), () => process.exit(0)); })",
    ],
    { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
  );
  await once(leader, "spawn");
  const pid = leader.pid!;
  t.after(() => {
    native.jobRelease(pid);
  });

  assert.equal(native.jobAssign(pid), true);
  assert.equal(native.jobActive(pid), 1);
  assert.deepEqual(native.jobAssign(pid), { failed: "existing job", code: ERROR_ALREADY_EXISTS }, "one job per pid");

  let printed = "";
  leader.stdout!.setEncoding("utf8").on("data", (text: string) => {
    printed += text;
  });
  const exited = once(leader, "exit");
  leader.stdin!.end("go");
  await exited;
  const grandchild = Number(printed);
  assert.ok(grandchild > 0, `the leader reported its child: ${JSON.stringify(printed)}`);
  // The job counts the leader out a moment after its exit is signalled, so wait for that.
  const counted = Date.now() + 10_000;
  while (native.jobActive(pid) !== 1 && Date.now() < counted) await new Promise((r) => setTimeout(r, 20));
  assert.equal(native.jobActive(pid), 1, "the grandchild is still in the job its parent left");
  assert.doesNotThrow(() => process.kill(grandchild, 0));

  assert.equal(native.jobTerminate(pid), true);
  const deadline = Date.now() + 10_000;
  while (native.jobActive(pid) !== 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(native.jobActive(pid), 0);
  assert.throws(() => process.kill(grandchild, 0), { code: "ESRCH" }, "terminating the job ended the grandchild");

  assert.equal(native.jobRelease(pid), true);
  assert.equal(native.jobActive(pid), null, "a released job is no longer held");
  assert.equal(native.jobTerminate(pid), false);
  assert.equal(native.jobRelease(pid), false);

  // pid 4 is the System process, which no job may take.
  assert.deepEqual(native.jobAssign(4), { failed: "OpenProcess", code: ERROR_ACCESS_DENIED });
});
