import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { processInspectorFor } from "../src/server/process-inspection/index.ts";
import {
  createPosixProcessInspector,
  defaultCommandRunner,
  posixProcessInspector,
  type CommandRunner,
} from "../src/server/process-inspection/posix.ts";
import {
  createWin32ProcessInspector,
  WIN32_CWD_UNAVAILABLE,
  WIN32_LIST_PROCESSES_SCRIPT,
  WIN32_OPEN_FILES_UNAVAILABLE,
  WIN32_OWNERS_UNAVAILABLE,
  win32CwdFromDosPath,
  win32ListeningPidScript,
  win32OwnerInScope,
  win32ProcessInspector,
} from "../src/server/process-inspection/win32.ts";
import { windowsPowerShellPath } from "../src/server/platform/executable-environment.ts";
import { readProcCwdsSnapshot } from "../src/server/discovery/proc-cwd.ts";
import { listProcessesSnapshot } from "../src/server/discovery/processes.ts";
import type {
  NativeProcessCwd,
  NativeProcessInspectionBinding,
  NativeProcessOwner,
} from "../src/server/process-inspection-native.ts";
import { inspectWorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { stubRun, type RunResult } from "../src/server/util/exec.ts";
import { skipOnWin32 } from "./helpers/win32-skip.ts";

interface Call {
  sync: boolean;
  bin: string;
  args: string[];
  opts: { timeoutMs: number; maxBuffer?: number };
}

/** A runner that records every command and answers from a script keyed by argv. */
function recordingRunner(answers: Record<string, RunResult | string | null> = {}) {
  const calls: Call[] = [];
  const key = (bin: string, args: string[]) => [bin, ...args].join(" ");
  const runner: CommandRunner = {
    async run(bin, args, opts) {
      calls.push({ sync: false, bin, args, opts });
      const answer = answers[key(bin, args)];
      return typeof answer === "object" && answer !== null ? answer : stubRun({ stdout: "", stderr: "", code: 0 });
    },
    runSync(bin, args, opts) {
      calls.push({ sync: true, bin, args, opts });
      const answer = answers[key(bin, args)];
      return typeof answer === "string" ? answer : null;
    },
  };
  return { runner, calls };
}

test("the POSIX inspector issues exactly the commands its call sites issued before", async () => {
  const { runner, calls } = recordingRunner();
  const inspector = createPosixProcessInspector(runner);
  await inspector.listProcesses();
  await inspector.readCwds([11, 12]);
  await inspector.readOpenFiles([21, 22]);
  inspector.readStartAndCommandSync(31);
  inspector.readStartTimeSync(41);
  await inspector.findListeningPid(4317);

  assert.deepEqual(calls, [
    // discovery/processes.ts: two system-wide passes, joined on pid.
    { sync: false, bin: "ps", args: ["-Ao", "uid=,pid=,ppid=,state=,tty=,lstart="], opts: { timeoutMs: 30_000 } },
    { sync: false, bin: "ps", args: ["-Ao", "pid=,command="], opts: { timeoutMs: 30_000 } },
    // discovery/proc-cwd.ts
    { sync: false, bin: "lsof", args: ["-a", "-d", "cwd", "-p", "11,12", "-Fpn"], opts: { timeoutMs: 30_000 } },
    // discovery/codex-rollouts.ts
    { sync: false, bin: "lsof", args: ["-a", "-p", "21,22", "-Fn"], opts: { timeoutMs: 3000, maxBuffer: 2 * 1024 * 1024 } },
    // workflows/check-identity.ts
    { sync: true, bin: "ps", args: ["-ww", "-o", "lstart=,command=", "-p", "31"], opts: { timeoutMs: 5_000, maxBuffer: 1024 * 1024 } },
    // pi/generation-lease.ts
    { sync: true, bin: "ps", args: ["-o", "lstart=", "-p", "41"], opts: { timeoutMs: 1000, maxBuffer: 4096 } },
    // New with the seam: no call site read a port's listener before.
    { sync: false, bin: "lsof", args: ["-nP", "-iTCP:4317", "-sTCP:LISTEN", "-t"], opts: { timeoutMs: 4000 } },
  ]);
});

test("the process listing joins both ps passes on pid and reports the first incomplete read", async () => {
  const failed = { ...stubRun({ stdout: "", stderr: "", code: null }), outcomeUnknown: true, childPid: 902 };
  const { runner } = recordingRunner({
    "ps -Ao uid=,pid=,ppid=,state=,tty=,lstart=": {
      ...stubRun({
        stdout: "  501   100     1 Ss   ttys001  Fri Jul  3 15:15:37 2026\n  501   200   100 Z    ??       Fri Jul 31 09:00:00 2026\n",
        stderr: "",
        code: 0,
      }),
      childPid: 901,
    },
    "ps -Ao pid=,command=": { ...failed, stdout: "  100 /bin/zsh -l\n" },
  });
  const table = await createPosixProcessInspector(runner, () => 501).listProcesses();
  assert.deepEqual(table.rows, [
    { ownedByDaemonUser: true, pid: 100, ppid: 1, state: "Ss", tty: "ttys001", start: "Fri Jul  3 15:15:37 2026", command: "/bin/zsh -l" },
    { ownedByDaemonUser: true, pid: 200, ppid: 100, state: "Z", tty: "??", start: "Fri Jul 31 09:00:00 2026", command: "" },
  ]);
  assert.equal(table.failure?.childPid, 902);
  assert.deepEqual(table.collectorPids, [901, 902]);
});

test("lsof field records pair each path with the pid before it", async () => {
  const { runner } = recordingRunner({
    "lsof -a -d cwd -p 7,8 -Fpn": stubRun({ stdout: "p7\nfcwd\nn/work/a\np8\nfcwd\nn/work/b\n", stderr: "", code: 0 }),
    "lsof -a -p 7 -Fn": stubRun({ stdout: "p7\nn/dev/null\nn/tmp/x.jsonl\n", stderr: "", code: 0 }),
  });
  const inspector = createPosixProcessInspector(runner);
  assert.deepEqual((await inspector.readCwds([7, 8])).cwds, new Map([[7, "/work/a"], [8, "/work/b"]]));
  assert.deepEqual((await inspector.readOpenFiles([7])).files, new Map([[7, ["/dev/null", "/tmp/x.jsonl"]]]));
});

test("a start-and-command read splits the five lstart tokens from a flattened command", () => {
  const { runner } = recordingRunner({
    "ps -ww -o lstart=,command= -p 5": "Fri Jul  3 15:15:37 2026     node  -e\tshim\n",
    "ps -ww -o lstart=,command= -p 6": "Fri Jul  3 15:15:37 2026\n",
  });
  const inspector = createPosixProcessInspector(runner);
  assert.deepEqual(inspector.readStartAndCommandSync(5), { start: "Fri Jul 3 15:15:37 2026", command: "node -e shim" });
  assert.equal(inspector.readStartAndCommandSync(6), null, "a row with no command is not half an identity");
  assert.equal(inspector.readStartAndCommandSync(7), null, "an unreadable pid has no identity");
});

test("the listening pid is the first pid lsof prints, and nothing listening is null", async () => {
  const { runner } = recordingRunner({
    "lsof -nP -iTCP:80 -sTCP:LISTEN -t": stubRun({ stdout: "4242\n4243\n", stderr: "", code: 0 }),
  });
  const inspector = createPosixProcessInspector(runner);
  assert.equal(await inspector.findListeningPid(80), 4242);
  assert.equal(await inspector.findListeningPid(81), null);
});

test("win32 gets the win32 inspector, and every other platform gets the POSIX one", () => {
  assert.equal(processInspectorFor("win32"), win32ProcessInspector);
  for (const platform of ["darwin", "linux", "freebsd"] as const) {
    assert.equal(processInspectorFor(platform), posixProcessInspector, platform);
  }
});

test("the default runner reads through the catalog's ps, and answers null when it cannot", {
  skip: skipOnWin32("pins the POSIX inspector's live ps read; win32 reads through PowerShell, covered below"),
}, () => {
  const live = defaultCommandRunner.runSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { timeoutMs: 5000, maxBuffer: 4096 });
  assert.match(live ?? "", /\d{4}\s*$/, "a live pid prints its start time");

  const dead = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
  assert.equal(dead.status, 0);
  assert.equal(
    defaultCommandRunner.runSync("ps", ["-o", "lstart=", "-p", String(dead.pid)], { timeoutMs: 5000, maxBuffer: 4096 }),
    null,
    "ps exits non-zero for a pid that is gone",
  );

  const previous = process.env.MISSION_PS_BIN;
  process.env.MISSION_PS_BIN = join(tmpdir(), "mission-no-such-ps", "ps");
  try {
    assert.equal(
      defaultCommandRunner.runSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { timeoutMs: 5000, maxBuffer: 4096 }),
      null,
      "a configured ps that does not exist is unreadable, not an error",
    );
  } finally {
    if (previous === undefined) delete process.env.MISSION_PS_BIN; else process.env.MISSION_PS_BIN = previous;
  }
});

// ---- win32 ----

const POWERSHELL_FLAGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"];
const PRELUDE = "$ErrorActionPreference = 'Stop'\ntry { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}\n";

interface PowerShellCall {
  sync: boolean;
  bin: string;
  flags: string[];
  script: string;
  opts: { timeoutMs: number; maxBuffer?: number };
}

/** Decode the `-EncodedCommand` payload back into the script PowerShell will run. */
function decodeScript(args: string[]): string {
  const script = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
  assert.ok(script.startsWith(PRELUDE), "every script stops on error and writes UTF-8");
  return script.slice(PRELUDE.length);
}

/** A runner that records each PowerShell script and answers from a table keyed by script. */
function powerShellRunner(answers: Record<string, RunResult | string | null> = {}) {
  const calls: PowerShellCall[] = [];
  const record = (sync: boolean, bin: string, args: string[], opts: PowerShellCall["opts"]): string => {
    const script = decodeScript(args);
    calls.push({ sync, bin, flags: args.slice(0, -1), script, opts });
    return script;
  };
  const runner: CommandRunner = {
    async run(bin, args, opts) {
      const answer = answers[record(false, bin, args, opts)];
      return typeof answer === "object" && answer !== null ? answer : stubRun({ stdout: "", stderr: "", code: 0 });
    },
    runSync(bin, args, opts) {
      const answer = answers[record(true, bin, args, opts)];
      return typeof answer === "string" ? answer : null;
    },
  };
  return { runner, calls };
}

/**
 * The native process inspection addon, answering from tables keyed by pid. A pid with no entry
 * answers the way a process of SYSTEM does: refused at `OpenProcess`.
 */
function fakeNative(answers: {
  owners?: Record<number, NativeProcessOwner>;
  cwds?: Record<number, NativeProcessCwd>;
} = {}) {
  const calls: Array<{ read: "owners" | "cwds"; pids: number[] }> = [];
  const refused = { failed: "OpenProcess", code: 5 };
  const binding: NativeProcessInspectionBinding = {
    owners(pids) {
      calls.push({ read: "owners", pids: [...pids] });
      return pids.map((pid) => answers.owners?.[pid] ?? refused);
    },
    cwds(pids) {
      calls.push({ read: "cwds", pids: [...pids] });
      return pids.map((pid) => answers.cwds?.[pid] ?? refused);
    },
  };
  return Object.assign(binding, { calls });
}

/** The loader of a checkout that never ran `npm run build:native`. */
function missingNative(): never {
  throw new Error("Cannot find module 'dist/native/process-inspection.node'\nRequire stack:\n- win32.ts");
}

/** A CIM listing that answered these rows. */
function cimListing(
  rows: Array<{ pid: number; ppid?: number; session?: number | null; start?: string; command?: string }>,
): RunResult {
  const json = JSON.stringify(rows.map((row) => ({ ppid: 1, session: 1, start: "Fri Jul 3 15:15:37 2026", command: "cmd.exe", ...row })));
  return stubRun({ stdout: json, stderr: "", code: 0 });
}

test("the win32 inspector issues one encoded PowerShell script per asynchronous read, and none otherwise", async () => {
  const { runner, calls } = powerShellRunner();
  const inspector = createWin32ProcessInspector(runner, () => fakeNative());
  await inspector.listProcesses();
  await inspector.readCwds([11, 12]);
  await inspector.readOpenFiles([21, 22]);
  inspector.readStartAndCommandSync(31);
  inspector.readStartTimeSync(41);
  await inspector.findListeningPid(4317);

  assert.deepEqual(calls, [
    { sync: false, bin: "powershell", flags: POWERSHELL_FLAGS, script: WIN32_LIST_PROCESSES_SCRIPT, opts: { timeoutMs: 30_000 } },
    // No synchronous read, cwd or open-file read spawns anything.
    { sync: false, bin: "powershell", flags: POWERSHELL_FLAGS, script: win32ListeningPidScript(4317), opts: { timeoutMs: 10_000 } },
  ]);
});

test("the win32 scripts ask CIM and the TCP/IP module the questions ps and lsof answered", () => {
  assert.match(WIN32_LIST_PROCESSES_SCRIPT, /Get-CimInstance -ClassName Win32_Process/);
  assert.match(WIN32_LIST_PROCESSES_SCRIPT, /session = \$p\.SessionId/, "the logon session, which scope reads");
  // `lstart`'s shape, in invariant English, so `Date.parse` and the occupancy recheck read it as they read ps.
  assert.match(WIN32_LIST_PROCESSES_SCRIPT, /\$p\.CreationDate\.ToString\('ddd MMM d HH:mm:ss yyyy', \[Globalization\.CultureInfo\]::InvariantCulture\)/);
  assert.match(WIN32_LIST_PROCESSES_SCRIPT, /ConvertTo-Json -InputObject \$rows -Compress/);
  assert.match(WIN32_LIST_PROCESSES_SCRIPT, /\$rows = @\(/, "an array even when one process answers");
  assert.equal(
    win32ListeningPidScript(4317),
    "$c = Get-NetTCPConnection -State Listen -LocalPort 4317 -ErrorAction SilentlyContinue | Select-Object -First 1\n"
      + "if ($c) { [Console]::Out.Write([string]$c.OwningProcess) }",
  );
});

test("the win32 listing parses CIM's JSON into rows with no state or terminal", async () => {
  const listing = JSON.stringify([
    { pid: 100, ppid: 4, start: "Fri Jul 3 15:15:37 2026", command: "\"C:\\Program Files\\nodejs\\node.exe\" server.js" },
    { pid: 200, ppid: 100, start: "Fri Jul 31 09:00:00 2026", command: "" },
    { pid: 0, ppid: 0, start: "", command: "" },
    { pid: "x" },
  ]);
  const { runner } = powerShellRunner({
    [WIN32_LIST_PROCESSES_SCRIPT]: { ...stubRun({ stdout: `\uFEFF${listing}`, stderr: "", code: 0 }), childPid: 901 },
  });
  const table = await createWin32ProcessInspector(runner, () => fakeNative({ owners: { 100: { sameUser: true } } })).listProcesses();
  assert.deepEqual(table.rows, [
    { ownedByDaemonUser: true, pid: 100, ppid: 4, state: "", tty: "?", start: "Fri Jul 3 15:15:37 2026", command: "\"C:\\Program Files\\nodejs\\node.exe\" server.js" },
    { ownedByDaemonUser: false, pid: 200, ppid: 100, state: "", tty: "?", start: "Fri Jul 31 09:00:00 2026", command: "" },
  ], "the System Idle Process (pid 0) and a malformed row are dropped");
  assert.equal(table.failure, null);
  assert.deepEqual(table.collectorPids, [901]);
});

test("a win32 listing that failed or did not answer JSON is reported as the listing's failure", async () => {
  const timedOut = { ...stubRun({ stdout: "", stderr: "", code: null }), outcomeUnknown: true, childPid: 902 };
  const killed = await createWin32ProcessInspector(powerShellRunner({ [WIN32_LIST_PROCESSES_SCRIPT]: timedOut }).runner, () => fakeNative()).listProcesses();
  assert.deepEqual(killed.rows, []);
  assert.equal(killed.failure, timedOut);
  assert.deepEqual(killed.collectorPids, [902]);

  const garbled = await createWin32ProcessInspector(
    powerShellRunner({ [WIN32_LIST_PROCESSES_SCRIPT]: stubRun({ stdout: "Get-CimInstance : Access denied", stderr: "", code: 0 }) }).runner,
    () => fakeNative(),
  ).listProcesses();
  assert.deepEqual(garbled.rows, []);
  assert.equal(garbled.failure?.code, 1);
  assert.equal(garbled.failure?.stderr, "the process listing did not answer with a JSON array");
});

test("without the native addon, win32 owners and cwds answer as failed reads, never as an empty success", async () => {
  const { runner, calls } = powerShellRunner({ [WIN32_LIST_PROCESSES_SCRIPT]: cimListing([{ pid: 7 }, { pid: 8 }]) });
  let loads = 0;
  const inspector = createWin32ProcessInspector(runner, () => {
    loads += 1;
    return missingNative();
  });
  const missing = "(Cannot find module 'dist/native/process-inspection.node')";

  assert.equal(inspector.userScopeUnavailable(), `${WIN32_OWNERS_UNAVAILABLE} ${missing}`);
  const snapshot = await listProcessesSnapshot(inspector);
  assert.deepEqual(snapshot.processes.map((proc) => proc.pid), [7, 8], "discovery still gets the rows");
  assert.deepEqual(snapshot.cwdScopePids, []);
  assert.equal(snapshot.unknownReason, `process listing failed: ${WIN32_OWNERS_UNAVAILABLE} ${missing}`);

  const cwd = await inspector.readCwds([7, 8]);
  assert.deepEqual(cwd.cwds, new Map());
  assert.deepEqual(cwd.result, {
    stdout: "", stderr: `${WIN32_CWD_UNAVAILABLE} ${missing}`, code: 1, childPid: null, outcomeUnknown: false, overflowed: false,
  });
  // `readProcCwdsSnapshot` reports a non-zero read with no cwds as `cwd listing failed: <stderr>`,
  // which worktree occupancy refuses on.
  assert.deepEqual(await readProcCwdsSnapshot([7, 8, 7], inspector), {
    cwds: new Map(),
    unknownReason: `cwd listing failed: ${WIN32_CWD_UNAVAILABLE} ${missing}`,
  });
  assert.deepEqual(
    await readProcCwdsSnapshot([], inspector),
    { cwds: new Map(), unknownReason: null },
    "with no pid to read there is nothing to be unsure about",
  );

  const open = await inspector.readOpenFiles([7]);
  assert.deepEqual(open.files, new Map());
  assert.equal(open.result.code, 1);
  assert.equal(open.result.stderr, WIN32_OPEN_FILES_UNAVAILABLE);
  assert.equal(calls.length, 1, "only the listing ran a script");
  assert.equal(loads, 1, "a failed load is not retried on every read");
});

test("win32 scope is the processes whose token carries the daemon's own user SID", async () => {
  const DAEMON = 900;
  const refusedToken = { failed: "OpenProcessToken", code: 5 };
  const native = fakeNative({
    owners: {
      100: { sameUser: true },
      200: { sameUser: false }, // another user, signed in to this machine
      300: { failed: "OpenProcess", code: 5 }, // SYSTEM or a service account
      400: refusedToken, // in the daemon's session: nothing proves another user owns it
      410: refusedToken, // in the services session, like audiodg.exe under LOCAL SERVICE
      420: refusedToken, // CIM gave no session, so nothing proves it is elsewhere
      500: { failed: "exited", code: 0 }, // exited, kept alive only by someone's handle
      600: { failed: "OpenProcess", code: 87 }, // gone between the listing and this read
      700: { failed: "GetTokenInformation", code: 8 }, // a failure the policy does not recognize
      800: {} as NativeProcessOwner,
      [DAEMON]: { sameUser: true },
    },
  });
  const listing = cimListing([
    ...[100, 200, 300, 400].map((pid) => ({ pid })),
    { pid: 410, session: 0 },
    { pid: 420, session: null },
    ...[500, 600, 700, 800, DAEMON].map((pid) => ({ pid })),
  ]);
  const inspector = createWin32ProcessInspector(
    powerShellRunner({ [WIN32_LIST_PROCESSES_SCRIPT]: listing }).runner,
    () => native,
    DAEMON,
  );

  assert.equal(inspector.userScopeUnavailable(), null);
  const snapshot = await listProcessesSnapshot(inspector);
  assert.equal(snapshot.unknownReason, null);
  // An unrecognized answer stays in scope, so its cwd read decides and a failure there leaves
  // occupancy unknown instead of quietly dropping the process.
  assert.deepEqual(snapshot.cwdScopePids, [100, 400, 420, 700, 800, DAEMON]);
  assert.deepEqual(
    native.calls,
    [{ read: "owners", pids: [100, 200, 300, 400, 410, 420, 500, 600, 700, 800, DAEMON] }],
    "one owner read per listing",
  );

  // Without the daemon's own row there is no session to compare with, so a refused token stays.
  const headless = createWin32ProcessInspector(
    powerShellRunner({ [WIN32_LIST_PROCESSES_SCRIPT]: cimListing([{ pid: 410, session: 0 }]) }).runner,
    () => native,
    DAEMON,
  );
  assert.deepEqual((await listProcessesSnapshot(headless)).cwdScopePids, [410]);
});

test("the win32 owner policy drops a process only where another owner, an exit or a refused open says so", () => {
  const cases: Array<[unknown, boolean | null, boolean, string]> = [
    [{ sameUser: true }, null, true, "this user's"],
    [{ sameUser: false }, true, false, "another user's, even in this session"],
    [{ failed: "exited", code: 0 }, true, false, "exited"],
    [{ failed: "OpenProcess", code: 87 }, true, false, "gone"],
    [{ failed: "OpenProcess", code: 5 }, true, false, "refused at open: SYSTEM or a service"],
    [{ failed: "OpenProcessToken", code: 5 }, true, true, "token refused in this session"],
    [{ failed: "OpenProcessToken", code: 5 }, null, true, "token refused, session unknown"],
    [{ failed: "OpenProcessToken", code: 5 }, false, false, "token refused in another session"],
    [{ failed: "OpenProcessToken", code: 6 }, false, true, "a token failure that is not a refusal"],
    [{ failed: "OpenProcess", code: 1450 }, false, true, "an open failure that is not a refusal"],
    [undefined, null, true, "no answer"],
  ];
  for (const [owner, sameSession, inScope, label] of cases) {
    assert.equal(win32OwnerInScope(owner, sameSession), inScope, label);
  }
});

test("a win32 owner read that throws is the listing's failure, and no row is in scope", async () => {
  const native = fakeNative();
  native.owners = () => {
    throw new Error("could not read this process's own user: OpenProcessToken failed with code 5");
  };
  const listing = cimListing([{ pid: 100 }]);
  const inspector = createWin32ProcessInspector(powerShellRunner({ [WIN32_LIST_PROCESSES_SCRIPT]: listing }).runner, () => native);
  const snapshot = await listProcessesSnapshot(inspector);
  assert.deepEqual(snapshot.cwdScopePids, []);
  assert.equal(
    snapshot.unknownReason,
    "process listing failed: the process owner read failed: could not read this process's own user: OpenProcessToken failed with code 5",
  );
});

test("win32 cwds keep every well-formed path and report the rest as a partial read", async () => {
  const native = fakeNative({
    cwds: {
      10: { cwd: "C:\\pool\\1\\repo\\src\\" },
      11: { cwd: "C:\\" },
      12: { cwd: "\\\\server\\share\\dir\\" },
      13: { failed: "OpenProcess", code: 5 }, // elevated, or a DACL that refuses memory reads
      14: { failed: "exited", code: 0 },
      15: { cwd: "pool\\1\\" }, // what a misread layout looks like: not a cwd at all
      16: { failed: "layout", code: 13 },
    },
  });
  const inspector = createWin32ProcessInspector(powerShellRunner().runner, () => native);
  const read = await inspector.readCwds([10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(read.cwds, new Map([[10, "C:\\pool\\1\\repo\\src"], [11, "C:\\"], [12, "\\\\server\\share\\dir"]]));
  assert.equal(read.result.code, 1);
  assert.equal(
    read.result.stderr,
    "could not read the working directory of 4 of 7 processes: 13 (OpenProcess failed with code 5), 14 (exited), "
      + "15 (not a working directory path), 16 (layout failed with code 13)",
  );
  // Partial, like an lsof that lost a pid: the paths it has are evidence, and occupancy rechecks
  // every pid it omitted.
  assert.deepEqual(await readProcCwdsSnapshot([10, 13], inspector), {
    cwds: new Map([[10, "C:\\pool\\1\\repo\\src"]]),
    unknownReason: null,
  });

  const complete = await inspector.readCwds([10, 11]);
  assert.equal(complete.result.code, 0);
  assert.equal(complete.result.stderr, "");

  const many = await createWin32ProcessInspector(powerShellRunner().runner, () => fakeNative()).readCwds([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.match(many.result.stderr, /^could not read the working directory of 10 of 10 processes: 1 \(OpenProcess failed with code 5\), .*8 \(OpenProcess failed with code 5\) and 2 more$/);

  native.cwds = () => {
    throw new TypeError("every pid must be a positive 32-bit integer");
  };
  assert.deepEqual(await readProcCwdsSnapshot([10], inspector), {
    cwds: new Map(),
    unknownReason: "cwd listing failed: the working directory read failed: every pid must be a positive 32-bit integer",
  });
});

test("a win32 DosPath is a cwd only when it is the absolute, backslash-terminated path Windows stores", () => {
  const cases: Array<[string, string | null]> = [
    ["C:\\Users\\dev\\repo\\", "C:\\Users\\dev\\repo"],
    ["c:\\", "c:\\"],
    ["D:\\a b\\ünïcode\\", "D:\\a b\\ünïcode"],
    ["\\\\server\\share\\", "\\\\server\\share\\"],
    ["\\\\server\\share\\dir\\", "\\\\server\\share\\dir"],
    ["\\\\?\\C:\\very\\long\\", "C:\\very\\long"],
    ["\\\\?\\UNC\\server\\share\\dir\\", "\\\\server\\share\\dir"],
    // Not a cwd: what a read through a misread structure produces instead.
    ["C:\\Users\\dev\\repo", null],
    ["", null],
    ["\\", null],
    ["repo\\", null],
    ["C:repo\\", null],
    ["\\\\server\\", null],
    ["\\\\.\\pipe\\x\\", null],
    ["C:\\a\u0000b\\", null],
    ["C:\\a\nb\\", null],
    ["C:\\a:b\\", null],
    ["C:\\a?b\\", null],
    ["C:\\a|b\\", null],
  ];
  for (const [raw, expected] of cases) assert.equal(win32CwdFromDosPath(raw), expected, JSON.stringify(raw));
});

test("win32 occupancy names a same-user occupant, ignores other users, and goes unknown on an unreadable same-user cwd", async () => {
  // The slot's own path as Windows prints a cwd, so the target and the occupant's cwd resolve to
  // the same path on any host this runs on.
  const slot = "C:\\fixture-pool\\1\\repo";
  const idle = "C:\\fixture-pool\\2\\repo";
  const owners: Record<number, NativeProcessOwner> = {
    100: { sameUser: true }, // a shell sitting in the slot
    200: { sameUser: true }, // an editor somewhere else
    300: { failed: "OpenProcess", code: 5 }, // a service; its cwd is never asked for
    400: { sameUser: false }, // another user's shell
  };
  const cwds: Record<number, NativeProcessCwd> = {
    100: { cwd: `${slot}\\` },
    200: { cwd: "C:\\Users\\dev\\" },
  };
  const listing = cimListing([
    { pid: 100, command: "cmd.exe /k" },
    { pid: 200, command: "Code.exe" },
    { pid: 300, command: "svchost.exe -k netsvcs" },
    { pid: 400, command: "cmd.exe /k" },
  ]);
  const native = fakeNative({ owners, cwds });
  const inspector = createWin32ProcessInspector(powerShellRunner({ [WIN32_LIST_PROCESSES_SCRIPT]: listing }).runner, () => native);
  const deps = {
    listProcesses: () => listProcessesSnapshot(inspector),
    readCwds: (pids: number[]) => readProcCwdsSnapshot(pids, inspector),
    ownProcesses: () => new Set<number>(),
  };

  const known = await inspectWorktreeOccupancy([slot, idle], deps);
  assert.deepEqual(known.get(slot), {
    status: "known",
    occupants: [{
      pid: 100, ppid: 1, startRaw: "Fri Jul 3 15:15:37 2026", startMs: Date.parse("Fri Jul 3 15:15:37 2026"),
      command: "cmd.exe /k", cwd: resolve(slot), knownOwner: null,
    }],
  });
  assert.deepEqual(known.get(idle), { status: "known", occupants: [] }, "an idle slot is known, not merely unknown");
  assert.deepEqual(native.calls.filter((call) => call.read === "cwds"), [{ read: "cwds", pids: [100, 200] }], "only in-scope cwds are read");

  // An elevated process of the same user: its token says it is ours, but it refuses memory
  // reads. It is alive in the recheck listing too, so nothing can say where it sits.
  owners[500] = { sameUser: true };
  cwds[500] = { failed: "OpenProcess", code: 5 };
  const withElevated = cimListing([{ pid: 100 }, { pid: 200 }, { pid: 500, command: "pwsh.exe" }]);
  const elevated = createWin32ProcessInspector(powerShellRunner({ [WIN32_LIST_PROCESSES_SCRIPT]: withElevated }).runner, () => native);
  const unknown = await inspectWorktreeOccupancy([slot, idle], {
    ...deps,
    listProcesses: () => listProcessesSnapshot(elevated),
    readCwds: (pids) => readProcCwdsSnapshot(pids, elevated),
  });
  const reason = "cwd listing omitted 1 ps-listed PID: 500";
  assert.deepEqual(unknown.get(slot), { status: "unknown", reason });
  assert.deepEqual(unknown.get(idle), { status: "unknown", reason }, "never empty while a same-user cwd is unread");
});

test("win32 synchronous reads answer unreadable without blocking the daemon on PowerShell", () => {
  const { runner, calls } = powerShellRunner();
  const inspector = createWin32ProcessInspector(runner);
  for (const pid of [process.pid, 1, 0, -1, 1.5]) {
    assert.equal(inspector.readStartAndCommandSync(pid), null);
    assert.equal(inspector.readStartTimeSync(pid), null);
  }
  assert.deepEqual(calls, [], "no synchronous read starts a process");
});

test("the win32 listening pid is the one PowerShell prints, and nothing listening is null", async () => {
  const { runner, calls } = powerShellRunner({
    [win32ListeningPidScript(80)]: stubRun({ stdout: "4242", stderr: "", code: 0 }),
    [win32ListeningPidScript(82)]: stubRun({ stdout: "4242", stderr: "boom", code: 1 }),
  });
  const inspector = createWin32ProcessInspector(runner);
  assert.equal(await inspector.findListeningPid(80), 4242);
  assert.equal(await inspector.findListeningPid(81), null);
  assert.equal(await inspector.findListeningPid(82), null);
  const before = calls.length;
  for (const port of [0, 65_536, 1.5]) assert.equal(await inspector.findListeningPid(port), null);
  assert.equal(calls.length, before, "an impossible port never reaches a script");
});

const noPowerShell = existsSync(windowsPowerShellPath(process.env)) ? false : "Windows PowerShell is not installed";

test("the win32 inspector reads this process through the real Windows PowerShell", { skip: noPowerShell }, async () => {
  const inspector = createWin32ProcessInspector();
  const table = await inspector.listProcesses();
  assert.equal(table.failure, null, table.failure?.stderr);
  const own = table.rows.find((row) => row.pid === process.pid);
  assert.ok(own, "this test's own process is listed");
  assert.equal(own.ppid, process.ppid);
  assert.ok(!Number.isNaN(Date.parse(own.start)), `discovery can parse ${own.start}`);
  assert.match(own.command, /node/i);

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    assert.equal(await inspector.findListeningPid(address.port), process.pid);
  } finally {
    server.close();
  }
});
