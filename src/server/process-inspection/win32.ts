import { powerShellArgs } from "../platform/executable-environment.ts";
import type { RunResult } from "../util/exec.ts";
import { flattenProcessText, type ProcessInspector, type ProcessRow } from "./contract.ts";
import { defaultCommandRunner, type CommandRunner } from "./runner.ts";

/**
 * Windows has no `ps` and no `lsof`. Every read here is one Windows PowerShell call over CIM
 * (`Win32_Process`) or the TCP/IP module, answering in JSON so a command line carrying quotes,
 * tabs or non-ASCII text arrives intact.
 *
 * Two reads have no supported source on Windows, and answer as a failed read rather than as an
 * empty one:
 *
 * - **Working directories.** `Win32_Process` carries no cwd, and neither does any other
 *   documented interface. The only routes are reading another process's PEB through
 *   undocumented, version-specific structures, or the separately installed Sysinternals
 *   `handle.exe`. Neither is reliable, so `readCwds` reports that it could not read, and
 *   `readProcCwdsSnapshot` turns that into its `unknownReason`, which worktree occupancy
 *   already treats as a refusal.
 * - **Open files.** The same is true of another process's open handles. Only Codex rollout
 *   discovery reads them, and Codex is unavailable on win32.
 */

/** The system-wide listing, sized like the POSIX `ps` it replaces: see `PS_TIMEOUT_MS`. */
const LIST_TIMEOUT_MS = 30_000;
/**
 * The port read. Windows PowerShell takes most of a second to start before the TCP/IP module
 * answers, so the four seconds POSIX gives `lsof` would turn a slow start into "nothing listens".
 */
const PORT_READ_TIMEOUT_MS = 10_000;

/**
 * A synchronous single-pid read, which BLOCKS the daemon's event loop for as long as it runs:
 * most of a second on win32, where POSIX's `ps` takes milliseconds. Its two callers do not
 * reach it on win32 today. `processStartIdentity` (`workflows/check-identity.ts`) answers null
 * on every platform but Linux and macOS before reading anything, and Pi generation leases
 * (`pi/generation-lease.ts`) exist only where Pi runs, which win32 refuses (plan D20). A new
 * win32 caller on a hot path needs an asynchronous read instead. The budget is POSIX's largest
 * synchronous one, so even a stalled CIM freezes the daemon for no longer than `ps` could.
 */
const SYNC_READ_TIMEOUT_MS = 5_000;

export const WIN32_CWD_UNAVAILABLE =
  "Windows exposes no supported way to read another process's working directory";
export const WIN32_OPEN_FILES_UNAVAILABLE =
  "Windows exposes no supported way to list another process's open files";

/**
 * One `Win32_Process` as a row. `CreationDate` is printed the way macOS prints `lstart`
 * (`Fri Jul 3 15:15:37 2026`, local time), so discovery's `Date.parse` and every identity
 * comparison read it exactly as they read `ps`. `CommandLine` is null for a process this user
 * may not inspect, which becomes "" like a pid `ps` did not cover.
 */
const ROW_FUNCTION = [
  "function ConvertTo-MissionRow($p) {",
  "  $start = ''",
  "  if ($p.CreationDate) { $start = $p.CreationDate.ToString('ddd MMM d HH:mm:ss yyyy', [Globalization.CultureInfo]::InvariantCulture) }",
  "  [pscustomobject]@{ pid = [int64]$p.ProcessId; ppid = [int64]$p.ParentProcessId; start = $start; command = [string]$p.CommandLine }",
  "}",
].join("\n");

export const WIN32_LIST_PROCESSES_SCRIPT = [
  ROW_FUNCTION,
  "$rows = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object { ConvertTo-MissionRow $_ })",
  "[Console]::Out.Write((ConvertTo-Json -InputObject $rows -Compress))",
].join("\n");

/** One pid's row, or exit 1 when no process has it. `pid` must already be a positive integer. */
export function win32ProcessScript(pid: number): string {
  return [
    ROW_FUNCTION,
    `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}'`,
    "if (-not $p) { exit 1 }",
    "[Console]::Out.Write((ConvertTo-Json -InputObject (ConvertTo-MissionRow $p) -Compress))",
  ].join("\n");
}

/** The pid owning the first listening socket on `port`, or nothing. `port` must be valid. */
export function win32ListeningPidScript(port: number): string {
  return [
    `$c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1`,
    "if ($c) { [Console]::Out.Write([string]$c.OwningProcess) }",
  ].join("\n");
}

interface Win32Row {
  pid: number;
  ppid: number;
  start: string;
  command: string;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function asRow(value: unknown): Win32Row | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!positiveInteger(row.pid)) return null;
  const ppid = typeof row.ppid === "number" && Number.isSafeInteger(row.ppid) && row.ppid >= 0 ? row.ppid : 0;
  return {
    pid: row.pid,
    ppid,
    start: typeof row.start === "string" ? row.start : "",
    command: typeof row.command === "string" ? row.command : "",
  };
}

/** PowerShell's JSON, BOM tolerated, or undefined when it is not JSON at all. */
function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout.replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

/** A read that never ran, shaped as the failed command it stands in for. */
function unreadable(reason: string): RunResult {
  return { stdout: "", stderr: reason, code: 1, childPid: null, outcomeUnknown: false, overflowed: false };
}

export function createWin32ProcessInspector(runner: CommandRunner = defaultCommandRunner): ProcessInspector {
  const readRow = (pid: number): Win32Row | null => {
    if (!positiveInteger(pid)) return null;
    const raw = runner.runSync("powershell", powerShellArgs(win32ProcessScript(pid)), {
      timeoutMs: SYNC_READ_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    if (raw === null) return null;
    const row = asRow(parseJson(raw));
    return row?.pid === pid ? row : null;
  };

  return {
    async listProcesses() {
      const result = await runner.run("powershell", powerShellArgs(WIN32_LIST_PROCESSES_SCRIPT), {
        timeoutMs: LIST_TIMEOUT_MS,
      });
      const parsed = result.code === 0 ? parseJson(result.stdout) : undefined;
      const rows: ProcessRow[] = [];
      for (const value of Array.isArray(parsed) ? parsed : []) {
        const row = asRow(value);
        if (!row) continue;
        // Windows has no numeric uid, no process state letter and no controlling terminal.
        // `-1` matches no effective uid, and `?` is the "no terminal" `normTty` already knows.
        rows.push({ uid: -1, pid: row.pid, ppid: row.ppid, state: "", tty: "?", start: row.start, command: row.command });
      }
      const incomplete = result.code !== 0 || result.outcomeUnknown || result.overflowed;
      const failure = incomplete
        ? result
        : Array.isArray(parsed)
          ? null
          : { ...result, code: 1, stderr: "the process listing did not answer with a JSON array" };
      return {
        rows,
        failure,
        collectorPids: positiveInteger(result.childPid) ? [result.childPid] : [],
      };
    },

    async readCwds() {
      return { cwds: new Map<number, string>(), result: unreadable(WIN32_CWD_UNAVAILABLE) };
    },

    async readOpenFiles() {
      return { files: new Map<number, string[]>(), result: unreadable(WIN32_OPEN_FILES_UNAVAILABLE) };
    },

    readStartAndCommandSync(pid) {
      const row = readRow(pid);
      if (!row) return null;
      const start = flattenProcessText(row.start);
      const command = flattenProcessText(row.command);
      return start && command ? { start, command } : null;
    },

    readStartTimeSync(pid) {
      return readRow(pid)?.start || null;
    },

    async findListeningPid(port) {
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
      const result = await runner.run("powershell", powerShellArgs(win32ListeningPidScript(port)), {
        timeoutMs: PORT_READ_TIMEOUT_MS,
      });
      if (result.code !== 0) return null;
      const pid = Number(result.stdout.trim());
      return positiveInteger(pid) ? pid : null;
    },
  };
}

export const win32ProcessInspector = createWin32ProcessInspector();
