import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  win32ListeningPidScript,
  win32ProcessInspector,
  win32ProcessScript,
} from "../src/server/process-inspection/win32.ts";
import { windowsPowerShellPath } from "../src/server/platform/executable-environment.ts";
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
  const table = await createPosixProcessInspector(runner).listProcesses();
  assert.deepEqual(table.rows, [
    { uid: 501, pid: 100, ppid: 1, state: "Ss", tty: "ttys001", start: "Fri Jul  3 15:15:37 2026", command: "/bin/zsh -l" },
    { uid: 501, pid: 200, ppid: 100, state: "Z", tty: "??", start: "Fri Jul 31 09:00:00 2026", command: "" },
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

test("the win32 inspector issues one encoded PowerShell script per read, and none for cwd or open files", async () => {
  const { runner, calls } = powerShellRunner();
  const inspector = createWin32ProcessInspector(runner);
  await inspector.listProcesses();
  await inspector.readCwds([11, 12]);
  await inspector.readOpenFiles([21, 22]);
  inspector.readStartAndCommandSync(31);
  inspector.readStartTimeSync(41);
  await inspector.findListeningPid(4317);

  assert.deepEqual(calls, [
    { sync: false, bin: "powershell", flags: POWERSHELL_FLAGS, script: WIN32_LIST_PROCESSES_SCRIPT, opts: { timeoutMs: 30_000 } },
    { sync: true, bin: "powershell", flags: POWERSHELL_FLAGS, script: win32ProcessScript(31), opts: { timeoutMs: 10_000, maxBuffer: 1024 * 1024 } },
    { sync: true, bin: "powershell", flags: POWERSHELL_FLAGS, script: win32ProcessScript(41), opts: { timeoutMs: 10_000, maxBuffer: 1024 * 1024 } },
    { sync: false, bin: "powershell", flags: POWERSHELL_FLAGS, script: win32ListeningPidScript(4317), opts: { timeoutMs: 10_000 } },
  ]);
});

test("the win32 scripts ask CIM and the TCP/IP module the questions ps and lsof answered", () => {
  for (const script of [WIN32_LIST_PROCESSES_SCRIPT, win32ProcessScript(31)]) {
    assert.match(script, /Get-CimInstance -ClassName Win32_Process/);
    // `lstart`'s shape, in invariant English, so `Date.parse` and identities read it as they read ps.
    assert.match(script, /\$p\.CreationDate\.ToString\('ddd MMM d HH:mm:ss yyyy', \[Globalization\.CultureInfo\]::InvariantCulture\)/);
    assert.match(script, /ConvertTo-Json -InputObject .* -Compress/);
  }
  assert.match(WIN32_LIST_PROCESSES_SCRIPT, /\$rows = @\(/, "an array even when one process answers");
  assert.match(win32ProcessScript(31), /-Filter 'ProcessId = 31'\nif \(-not \$p\) \{ exit 1 \}/);
  assert.equal(
    win32ListeningPidScript(4317),
    "$c = Get-NetTCPConnection -State Listen -LocalPort 4317 -ErrorAction SilentlyContinue | Select-Object -First 1\n"
      + "if ($c) { [Console]::Out.Write([string]$c.OwningProcess) }",
  );
});

test("the win32 listing parses CIM's JSON into rows with no uid, state or terminal", async () => {
  const listing = JSON.stringify([
    { pid: 100, ppid: 4, start: "Fri Jul 3 15:15:37 2026", command: "\"C:\\Program Files\\nodejs\\node.exe\" server.js" },
    { pid: 200, ppid: 100, start: "Fri Jul 31 09:00:00 2026", command: "" },
    { pid: 0, ppid: 0, start: "", command: "" },
    { pid: "x" },
  ]);
  const { runner } = powerShellRunner({
    [WIN32_LIST_PROCESSES_SCRIPT]: { ...stubRun({ stdout: `\uFEFF${listing}`, stderr: "", code: 0 }), childPid: 901 },
  });
  const table = await createWin32ProcessInspector(runner).listProcesses();
  assert.deepEqual(table.rows, [
    { uid: -1, pid: 100, ppid: 4, state: "", tty: "?", start: "Fri Jul 3 15:15:37 2026", command: "\"C:\\Program Files\\nodejs\\node.exe\" server.js" },
    { uid: -1, pid: 200, ppid: 100, state: "", tty: "?", start: "Fri Jul 31 09:00:00 2026", command: "" },
  ], "the System Idle Process (pid 0) and a malformed row are dropped");
  assert.equal(table.failure, null);
  assert.deepEqual(table.collectorPids, [901]);
});

test("a win32 listing that failed or did not answer JSON is reported as the listing's failure", async () => {
  const timedOut = { ...stubRun({ stdout: "", stderr: "", code: null }), outcomeUnknown: true, childPid: 902 };
  const killed = await createWin32ProcessInspector(powerShellRunner({ [WIN32_LIST_PROCESSES_SCRIPT]: timedOut }).runner).listProcesses();
  assert.deepEqual(killed.rows, []);
  assert.equal(killed.failure, timedOut);
  assert.deepEqual(killed.collectorPids, [902]);

  const garbled = await createWin32ProcessInspector(
    powerShellRunner({ [WIN32_LIST_PROCESSES_SCRIPT]: stubRun({ stdout: "Get-CimInstance : Access denied", stderr: "", code: 0 }) }).runner,
  ).listProcesses();
  assert.deepEqual(garbled.rows, []);
  assert.equal(garbled.failure?.code, 1);
  assert.equal(garbled.failure?.stderr, "the process listing did not answer with a JSON array");
});

test("win32 cwd and open-file reads answer as failed reads, never as an empty success", async () => {
  const { runner, calls } = powerShellRunner();
  const inspector = createWin32ProcessInspector(runner);
  const cwd = await inspector.readCwds([7, 8]);
  assert.deepEqual(cwd.cwds, new Map());
  // `readProcCwdsSnapshot` reports a non-zero read with no cwds as `cwd listing failed: <stderr>`,
  // which worktree occupancy refuses on.
  assert.deepEqual(cwd.result, {
    stdout: "", stderr: WIN32_CWD_UNAVAILABLE, code: 1, childPid: null, outcomeUnknown: false, overflowed: false,
  });
  const open = await inspector.readOpenFiles([7]);
  assert.deepEqual(open.files, new Map());
  assert.equal(open.result.code, 1);
  assert.equal(open.result.stderr, WIN32_OPEN_FILES_UNAVAILABLE);
  assert.deepEqual(calls, []);
});

test("a win32 single-pid read flattens the command and refuses half an identity", () => {
  const row = (pid: number, command: string | null, start = "Fri Jul 3 15:15:37 2026") =>
    JSON.stringify({ pid, ppid: 1, start, command });
  const { runner, calls } = powerShellRunner({
    [win32ProcessScript(5)]: `\uFEFF${row(5, "node.exe  -e\tshim")}`,
    [win32ProcessScript(6)]: row(6, ""),
    [win32ProcessScript(8)]: row(9, "node.exe"),
    [win32ProcessScript(10)]: "not json",
  });
  const inspector = createWin32ProcessInspector(runner);
  assert.deepEqual(inspector.readStartAndCommandSync(5), { start: "Fri Jul 3 15:15:37 2026", command: "node.exe -e shim" });
  assert.equal(inspector.readStartTimeSync(5), "Fri Jul 3 15:15:37 2026");
  assert.equal(inspector.readStartAndCommandSync(6), null, "a row with no command is not half an identity");
  assert.equal(inspector.readStartTimeSync(6), "Fri Jul 3 15:15:37 2026", "the start alone is still readable");
  assert.equal(inspector.readStartAndCommandSync(7), null, "a pid PowerShell could not find has no identity");
  assert.equal(inspector.readStartAndCommandSync(8), null, "an answer about another pid is not this pid's");
  assert.equal(inspector.readStartTimeSync(10), null, "output that is not JSON is unreadable");

  const before = calls.length;
  for (const pid of [0, -1, 1.5, Number.NaN]) {
    assert.equal(inspector.readStartAndCommandSync(pid), null);
    assert.equal(inspector.readStartTimeSync(pid), null);
  }
  assert.equal(calls.length, before, "an impossible pid never reaches a script");
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

  const read = inspector.readStartAndCommandSync(process.pid);
  assert.equal(read?.start, own.start, "the single-pid read and the listing agree on the start");
  assert.equal(inspector.readStartTimeSync(process.pid), own.start);

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
