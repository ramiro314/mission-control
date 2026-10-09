import { powerShellArgs } from "../platform/executable-environment.ts";
import {
  loadNativeProcessInspectionBinding,
  type NativeProcessInspectionBinding,
} from "../process-inspection-native.ts";
import type { RunResult } from "../util/exec.ts";
import type { ProcessInspector, ProcessRow } from "./contract.ts";
import { defaultCommandRunner, type CommandRunner } from "./runner.ts";

/**
 * Windows has no `ps` and no `lsof`. The listing and the port read are one Windows PowerShell
 * call each, over CIM (`Win32_Process`) or the TCP/IP module, answering in JSON so a command
 * line carrying quotes, tabs or non-ASCII text arrives intact.
 *
 * Two reads come from the native addon in `native/process-inspection`, because no documented
 * interface answers them and a PowerShell start per read is far too slow for the daemon:
 *
 * - **Owners.** Windows has no uid. The addon compares each process token's user SID with the
 *   daemon's own (`OpenProcessToken`, `GetTokenInformation(TokenUser)`, `EqualSid`), and that is
 *   the `ownedByDaemonUser` POSIX gets from comparing a uid with `geteuid()`. `win32OwnerInScope`
 *   is the policy over its answers.
 * - **Working directories.** `Win32_Process` carries no cwd. The addon reads it out of the
 *   process's own memory, PEB -> RTL_USER_PROCESS_PARAMETERS -> CurrentDirectory.DosPath, the
 *   route psutil's `Process.cwd()` takes, with the 32-bit layout for a WOW64 process. Those
 *   structures are undocumented, so a read that breaks an invariant the real structures always
 *   hold (a normalized parameter block long enough to contain CURDIR, a DosPath whose lengths are
 *   even and consistent, two consecutive reads that agree, an absolute path ending in the
 *   backslash Windows always stores) is a failed read for that pid, never a path. Checked on
 *   Windows 11 25H2 (build 26200), x64, against every process of a 478-process desktop session:
 *   every same-user process the addon could open, native and WOW64, answered a well-formed path,
 *   and a WOW64 `cmd.exe` that changed directory answered the new one.
 *
 * Without the addon (a checkout that never ran `npm run build:native`) both reads answer as they
 * did before it existed: `userScopeUnavailable` names the reason, so every snapshot is
 * unusable, and `readCwds` fails, so `readProcCwdsSnapshot` reports an `unknownReason`.
 *
 * **Open files** still have no source: another process's open handles are only reachable through
 * an elevated handle enumeration. Only Codex rollout discovery reads them, and Codex is
 * unavailable on win32.
 *
 * And the two SYNCHRONOUS reads answer "unreadable" without running anything. A synchronous
 * read blocks the daemon's event loop for as long as it runs, and the only source is starting
 * Windows PowerShell, which alone takes most of a second: every call would freeze the dashboard.
 * A per-pid cache is no way out, because Windows reuses pids and a stale start time is a wrong
 * identity. Unreadable is the answer both callers already handle. `processStartIdentity`
 * (`workflows/check-identity.ts`) refuses every platform but Linux and macOS before reading, and
 * a Pi generation lease (`pi/generation-lease.ts`) exists only where Pi runs, which win32
 * refuses (plan D20). A win32 caller that needs a start identity needs an asynchronous read.
 */

/** The system-wide listing, sized like the POSIX `ps` it replaces: see `PS_TIMEOUT_MS`. */
const LIST_TIMEOUT_MS = 30_000;
/**
 * The port read. Windows PowerShell takes most of a second to start before the TCP/IP module
 * answers, so the four seconds POSIX gives `lsof` would turn a slow start into "nothing listens".
 */
const PORT_READ_TIMEOUT_MS = 10_000;

export const WIN32_OWNERS_UNAVAILABLE =
  "process owners are unreadable without the native process inspection addon";
export const WIN32_CWD_UNAVAILABLE =
  "working directories are unreadable without the native process inspection addon";
export const WIN32_OPEN_FILES_UNAVAILABLE =
  "Windows exposes no supported way to list another process's open files";

/** The Win32 errors the owner policy names. */
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_PARAMETER = 87;
/** How many unread pids a failed cwd read names before it counts the rest. */
const SHOWN_CWD_FAILURES = 8;

/**
 * Whether one process belongs in the daemon's cwd scope, from the addon's owner read.
 *
 * In scope: a process this user owns, and any answer this policy does not recognize, so that
 * its cwd read decides and a failure there leaves occupancy unknown rather than empty.
 *
 * Out of scope, as another uid is on POSIX:
 * - a process another user owns;
 * - one the system refuses to let this user open or query the token of (`ERROR_ACCESS_DENIED`).
 *   Limited information is granted across integrity levels, so this is a process of SYSTEM, a
 *   service account or another user, outside the boundary the daemon can observe;
 * - one that has exited (`exited`, or `ERROR_INVALID_PARAMETER` for a pid that no longer
 *   names a process), which holds no working directory, as a zombie holds none on POSIX.
 *
 * A same-user process whose cwd cannot be read (an elevated process, or one whose own DACL
 * refuses memory reads) is in scope: it stays unresolved and occupancy stays unknown.
 */
export function win32OwnerInScope(owner: unknown): boolean {
  if (!owner || typeof owner !== "object") return true;
  const answer = owner as Record<string, unknown>;
  if (typeof answer.sameUser === "boolean") return answer.sameUser;
  if (answer.failed === "exited") return false;
  if (answer.failed === "OpenProcess" && answer.code === ERROR_INVALID_PARAMETER) return false;
  const refused = answer.failed === "OpenProcess" || answer.failed === "OpenProcessToken";
  return !(refused && answer.code === ERROR_ACCESS_DENIED);
}

/**
 * The working directory a process's DosPath names, or null when the text is not one.
 *
 * Windows stores the current directory as an absolute drive or UNC path that always ends in a
 * backslash. Text that does not is not a cwd at all, and is what a read through a misread
 * layout would produce. The trailing backslash is dropped except on a root, so the path reads
 * the way `path.resolve` writes one.
 */
export function win32CwdFromDosPath(raw: string): string | null {
  let path = raw;
  if (/^\\\\\?\\UNC\\/i.test(path)) path = `\\\\${path.slice(8)}`;
  else if (/^\\\\\?\\[A-Za-z]:\\/.test(path)) path = path.slice(4);
  // Characters no Windows path component may hold, and a colon anywhere but after the drive.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f"*<>|?]/.test(path) || path.indexOf(":", 2) !== -1 || !path.endsWith("\\")) {
    return null;
  }
  const root = /^[A-Za-z]:\\/.exec(path) ?? /^\\\\[^\\.:][^\\]*\\[^\\]+\\/.exec(path);
  if (!root) return null;
  return path.length === root[0].length ? path : path.slice(0, -1);
}

function describeCwdFailure(answer: unknown): string {
  if (!answer || typeof answer !== "object") return "no answer";
  const { failed, code, cwd } = answer as Record<string, unknown>;
  if (typeof cwd === "string") return "not a working directory path";
  if (failed === "exited") return "exited";
  return `${typeof failed === "string" ? failed : "read"} failed with code ${String(code)}`;
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0] ?? "";
}

type NativeLoad = { binding: NativeProcessInspectionBinding } | { unavailable: string };

/**
 * One `Win32_Process` as a row. `CreationDate` is printed the way macOS prints `lstart`
 * (`Fri Jul 3 15:15:37 2026`, local time), so discovery's `Date.parse` and the occupancy
 * recheck's start comparison read it exactly as they read `ps`. `CommandLine` is null for a process this user
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

/** A read that did not answer completely, shaped as the failed command it stands in for. */
function unreadable(reason: string): RunResult {
  return { stdout: "", stderr: reason, code: 1, childPid: null, outcomeUnknown: false, overflowed: false };
}

/**
 * `loadNative` loads the addon, or throws when it cannot. It is called at most once per
 * inspector, on the first read that needs it, and its outcome is kept: a daemon is started after
 * `npm run build:native`, never before it.
 */
export function createWin32ProcessInspector(
  runner: CommandRunner = defaultCommandRunner,
  loadNative: () => NativeProcessInspectionBinding = loadNativeProcessInspectionBinding,
): ProcessInspector {
  let loaded: NativeLoad | undefined;
  const native = (): NativeLoad => {
    if (!loaded) {
      try {
        loaded = { binding: loadNative() };
      } catch (error) {
        loaded = { unavailable: firstLine(error) };
      }
    }
    return loaded;
  };

  return {
    userScopeUnavailable() {
      const load = native();
      return "unavailable" in load ? `${WIN32_OWNERS_UNAVAILABLE} (${load.unavailable})` : null;
    },

    async listProcesses() {
      const result = await runner.run("powershell", powerShellArgs(WIN32_LIST_PROCESSES_SCRIPT), {
        timeoutMs: LIST_TIMEOUT_MS,
      });
      const parsed = result.code === 0 ? parseJson(result.stdout) : undefined;
      const rows: ProcessRow[] = [];
      for (const value of Array.isArray(parsed) ? parsed : []) {
        const row = asRow(value);
        if (!row) continue;
        // Windows has no process state letter and no controlling terminal. `?` is the
        // "no terminal" `normTty` already knows. Ownership is filled in below.
        rows.push({
          ownedByDaemonUser: false,
          pid: row.pid,
          ppid: row.ppid,
          state: "",
          tty: "?",
          start: row.start,
          command: row.command,
        });
      }
      const incomplete = result.code !== 0 || result.outcomeUnknown || result.overflowed;
      let failure: RunResult | null = incomplete
        ? result
        : Array.isArray(parsed)
          ? null
          : { ...result, code: 1, stderr: "the process listing did not answer with a JSON array" };

      // Without the addon every row stays unowned, and `userScopeUnavailable` says why.
      const load = native();
      if ("binding" in load && rows.length > 0) {
        try {
          const owners = load.binding.owners(rows.map((row) => row.pid));
          rows.forEach((row, index) => {
            row.ownedByDaemonUser = win32OwnerInScope(owners[index]);
          });
        } catch (error) {
          failure ??= unreadable(`the process owner read failed: ${firstLine(error)}`);
        }
      }
      return {
        rows,
        failure,
        collectorPids: positiveInteger(result.childPid) ? [result.childPid] : [],
      };
    },

    /**
     * Every pid the addon answered with a well-formed path. Any other answer leaves the pid out
     * and the read non-zero, exactly as `lsof` exits 1 while still printing the pids it could
     * read; `readProcCwdsSnapshot` and occupancy's recheck already know what that means.
     */
    async readCwds(pids) {
      const cwds = new Map<number, string>();
      const load = native();
      if ("unavailable" in load) {
        return { cwds, result: unreadable(`${WIN32_CWD_UNAVAILABLE} (${load.unavailable})`) };
      }
      let answers: unknown[];
      try {
        answers = load.binding.cwds(pids);
      } catch (error) {
        return { cwds, result: unreadable(`the working directory read failed: ${firstLine(error)}`) };
      }
      const missed: string[] = [];
      pids.forEach((pid, index) => {
        const answer = answers[index] as { cwd?: unknown } | undefined;
        const cwd = typeof answer?.cwd === "string" ? win32CwdFromDosPath(answer.cwd) : null;
        if (cwd) cwds.set(pid, cwd);
        else missed.push(`${pid} (${describeCwdFailure(answer)})`);
      });
      if (missed.length === 0) {
        return { cwds, result: { stdout: "", stderr: "", code: 0, childPid: null, outcomeUnknown: false, overflowed: false } };
      }
      const remainder = missed.length > SHOWN_CWD_FAILURES ? ` and ${missed.length - SHOWN_CWD_FAILURES} more` : "";
      const reason =
        `could not read the working directory of ${missed.length} of ${pids.length} processes: `
        + `${missed.slice(0, SHOWN_CWD_FAILURES).join(", ")}${remainder}`;
      return { cwds, result: unreadable(reason) };
    },

    async readOpenFiles() {
      return { files: new Map<number, string[]>(), result: unreadable(WIN32_OPEN_FILES_UNAVAILABLE) };
    },

    // Unreadable without running anything: see the synchronous reads above.
    readStartAndCommandSync() {
      return null;
    },

    readStartTimeSync() {
      return null;
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
