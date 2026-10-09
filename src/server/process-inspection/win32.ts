import { powerShellArgs } from "../platform/executable-environment.ts";
import {
  loadNativeProcessInspectionBinding,
  type NativeProcessInspectionBinding,
} from "../process-inspection-native.ts";
import type { RunResult } from "../util/exec.ts";
import { flattenProcessText, type ProcessInspector, type ProcessRow } from "./contract.ts";
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
 *   is the policy over its answers, including the ones where Windows refuses to say: it uses the
 *   logon session the listing reports to tell a service's refused token from a refusal in the
 *   daemon's own session.
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
 * The two SYNCHRONOUS reads come from the addon too, one `OpenProcess` each: the creation time
 * (`GetProcessTimes`) and the command line (`ProcessCommandLineInformation`). A synchronous read
 * blocks the daemon's event loop for as long as it runs, so starting Windows PowerShell, which
 * alone takes most of a second, was never an option for them. The start time is the creation
 * time in 100-nanosecond ticks rather than a printed one: `processStartIdentity`
 * (`workflows/check-identity.ts`) compares it as an opaque string, and a whole-second time would
 * throw away the resolution that tells a reused pid apart. Without the addon both answer
 * "unreadable", which both callers handle, and a process that has exited answers "unreadable"
 * even while a handle to it keeps its pid from being reused.
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
 * Whether one process belongs in the daemon's cwd scope, from the addon's owner read and whether
 * the process runs in the daemon's own logon session (`null` when the listing could not say).
 *
 * In scope: a process this user owns, and any answer this policy does not recognize, so that
 * its cwd read decides and a failure there leaves occupancy unknown rather than empty.
 *
 * Out of scope, as another uid is on POSIX:
 * - a process another user owns;
 * - one that has exited (`exited`, or `ERROR_INVALID_PARAMETER` for a pid that no longer
 *   names a process), which holds no working directory, as a zombie holds none on POSIX;
 * - one the system refuses to open at all (`OpenProcess` and `ERROR_ACCESS_DENIED`). Windows
 *   grants a user limited information on its own processes across integrity levels, elevated
 *   ones included, so a refusal is a process of SYSTEM, a service account or another user. That
 *   cannot be proven, because Windows names no owner for a process it will not open, so this is
 *   the one judgment call: a process of this user that hardens its own DACL against even
 *   limited information would be missed. On a measured desktop session the refusals were 156
 *   system and service processes, and counting them would leave occupancy unknown for every
 *   daemon that is not elevated;
 * - one that opens but refuses its token (`OpenProcessToken` and `ERROR_ACCESS_DENIED`) and runs
 *   in another logon session than the daemon's, such as `audiodg.exe` under LOCAL SERVICE in
 *   the services session.
 *
 * A process that refuses its token in the daemon's own session stays in scope: nothing proves
 * another user owns it, and on the measured session two such processes ran beside two copies of
 * the same program this user owned. So does a same-user process whose cwd cannot be read (an
 * elevated process, or one whose own DACL refuses memory reads): it stays unresolved and
 * occupancy stays unknown.
 */
export function win32OwnerInScope(owner: unknown, sameSession: boolean | null = null): boolean {
  if (!owner || typeof owner !== "object") return true;
  const answer = owner as Record<string, unknown>;
  if (typeof answer.sameUser === "boolean") return answer.sameUser;
  if (answer.failed === "exited") return false;
  if (answer.failed === "OpenProcess") {
    return !(answer.code === ERROR_INVALID_PARAMETER || answer.code === ERROR_ACCESS_DENIED);
  }
  if (answer.failed === "OpenProcessToken" && answer.code === ERROR_ACCESS_DENIED) return sameSession !== false;
  return true;
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
 * may not inspect, which becomes "" like a pid `ps` did not cover. `SessionId` is the logon
 * session, which CIM reports for every process, opened or not; `win32OwnerInScope` uses it.
 */
const ROW_FUNCTION = [
  "function ConvertTo-MissionRow($p) {",
  "  $start = ''",
  "  if ($p.CreationDate) { $start = $p.CreationDate.ToString('ddd MMM d HH:mm:ss yyyy', [Globalization.CultureInfo]::InvariantCulture) }",
  "  [pscustomobject]@{ pid = [int64]$p.ProcessId; ppid = [int64]$p.ParentProcessId; session = $p.SessionId; start = $start; command = [string]$p.CommandLine }",
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
  /** The logon session, or null when CIM did not report one. */
  session: number | null;
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
  const session = typeof row.session === "number" && Number.isSafeInteger(row.session) && row.session >= 0 ? row.session : null;
  return {
    pid: row.pid,
    ppid,
    session,
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
  daemonPid: number = process.pid,
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

  /** The addon's identity read for one pid, or null for any pid or answer it cannot vouch for. */
  const identity = (pid: number): { start: string; command: string } | null => {
    if (!positiveInteger(pid) || pid > 0xffff_ffff) return null;
    const load = native();
    if ("unavailable" in load) return null;
    let answer: unknown;
    try {
      answer = load.binding.identity(pid);
    } catch {
      return null;
    }
    const { start, command } = (answer ?? {}) as Record<string, unknown>;
    return typeof start === "string" && /^[1-9]\d*$/.test(start) && typeof command === "string"
      ? { start, command }
      : null;
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
      const sessions: Array<number | null> = [];
      for (const value of Array.isArray(parsed) ? parsed : []) {
        const row = asRow(value);
        if (!row) continue;
        sessions.push(row.session);
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
          // The daemon is in its own listing. Without its row, or a session for either side,
          // nothing proves a process is in another session.
          const daemonSession = sessions[rows.findIndex((row) => row.pid === daemonPid)] ?? null;
          rows.forEach((row, index) => {
            const session = sessions[index] ?? null;
            const sameSession = daemonSession === null || session === null ? null : session === daemonSession;
            row.ownedByDaemonUser = win32OwnerInScope(owners[index], sameSession);
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

    // From the addon, without running anything: see the synchronous reads above.
    readStartAndCommandSync(pid) {
      const read = identity(pid);
      if (!read) return null;
      const command = flattenProcessText(read.command);
      return command ? { start: read.start, command } : null;
    },

    readStartTimeSync(pid) {
      return identity(pid)?.start ?? null;
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
