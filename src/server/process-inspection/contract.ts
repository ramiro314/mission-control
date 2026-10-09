import type { RunResult } from "../util/exec.ts";

/**
 * Process inspection: the one place the daemon asks the operating system about processes.
 *
 * Every read here used to be a `ps` or `lsof` written at its call site. They answer through
 * this contract instead, so a platform without those commands can supply its own answers
 * without touching discovery, Codex rollouts, check identity or the Pi generation lease.
 *
 * Each read hands back what it parsed together with the `RunResult` of the command behind it.
 * Whether a partial answer is usable is the CALLER's policy (destructive worktree decisions
 * refuse one that discovery happily keeps), so the health of the read travels with the data
 * rather than being decided here.
 */
export interface ProcessInspector {
  /** Every process on the system: identity, owner, parentage, state, terminal, start and argv. */
  listProcesses(): Promise<ProcessTable>;
  /**
   * Why this inspector cannot tell which processes the daemon's own user owns, or null when it
   * can. Known without listing anything, so a caller that needs owners can refuse before paying
   * for a system-wide listing whose `ownedByDaemonUser` would all be false.
   */
  userScopeUnavailable(): string | null;
  /** The working directory of each pid. Omission is not proof a pid exited. */
  readCwds(pids: readonly number[]): Promise<{ cwds: Map<number, string>; result: RunResult }>;
  /** Every path each pid has open, in the order the system reported them. */
  readOpenFiles(pids: readonly number[]): Promise<{ files: Map<number, string[]>; result: RunResult }>;
  /**
   * A process's start time and command line from ONE synchronous read, whitespace-flattened
   * by `flattenProcessText`, or null when either half is unreadable.
   */
  readStartAndCommandSync(pid: number): { start: string; command: string } | null;
  /** A process's start time as the system prints it, or null when it cannot be read. */
  readStartTimeSync(pid: number): string | null;
  /** The pid listening on a local TCP port, or null when nothing is or it cannot be read. */
  findListeningPid(port: number): Promise<number | null>;
}

export interface ProcessRow {
  /**
   * Whether the user this daemon runs as owns the process: the boundary whose working
   * directories the daemon can observe. A uid compared with `geteuid()` on POSIX, the process
   * token's user SID compared with the daemon's own on win32. False when it cannot be told.
   */
  ownedByDaemonUser: boolean;
  pid: number;
  ppid: number;
  state: string;
  /** The controlling terminal as the system names it, before `normTty`. */
  tty: string;
  /** The start time as the system prints it (`Fri Jul 31 15:15:37 2026`). */
  start: string;
  /** Full argv, or "" when the command read did not cover this pid. */
  command: string;
}

export interface ProcessTable {
  rows: ProcessRow[];
  /** The first read that did not answer completely, or null when every read did. */
  failure: RunResult | null;
  /** Helper processes this listing spawned, which may appear in their own snapshot. */
  collectorPids: number[];
}

/**
 * Collapse every control character and whitespace run to single spaces.
 *
 * Linux hands back a NUL-separated argv and macOS's `ps` pads `lstart` to a fixed width;
 * neither difference is information, and flattening both is what lets an identity be
 * compared as one opaque string.
 */
export function flattenProcessText(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}
