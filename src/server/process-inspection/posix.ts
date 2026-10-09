import { flattenProcessText, type ProcessInspector, type ProcessRow } from "./contract.ts";
import { defaultCommandRunner, type CommandRunner } from "./runner.ts";

export { defaultCommandRunner, type CommandRunner } from "./runner.ts";

/**
 * How long a SYSTEM-WIDE `ps` may take before we stop believing its answer.
 *
 * `run`'s four-second default is sized for the small, targeted discovery commands it was
 * written for. These two are neither: their cost grows with the machine's whole process
 * table and with the argv length of everything on it, and the answer is consumed by
 * `unknownReason`, which destructive worktree decisions correctly treat as a refusal.
 *
 * So impatience here does not degrade gracefully - it becomes "native worktree release
 * refused: process listing failed", an operator watching Clean up decline to release a
 * checkout that nothing is actually holding. Measured, `ps -A` answers in about 40ms on a
 * thousand-process machine and stays under 300ms with forty of these running at once, so
 * the four seconds was never about `ps` being slow. It is about the DAEMON: under real
 * load its event loop stalls, and a timer that fires during the stall kills a read that had
 * already finished. A wider window costs nothing on the normal path and takes that whole
 * class of false refusal off the table, while leaving the fail-closed rule intact.
 */
const PS_TIMEOUT_MS = 30_000;

/**
 * The cwd listing is a system-wide read over every process the daemon user owns. The
 * four-second default turned host contention into a permanent worktree quarantine. Match the
 * process snapshot budget: uncertainty still fails closed, but ordinary load gets time to
 * produce the evidence cleanup requires.
 */
const CWD_LIST_TIMEOUT_MS = 30_000;

/** Pair `lsof -F` records: `p<pid>` opens a process, each following `n<path>` belongs to it. */
function parseLsofNames(text: string): Map<number, string[]> {
  const found = new Map<number, string[]>();
  let pid: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) {
      const n = Number(line.slice(1));
      pid = Number.isSafeInteger(n) && n > 0 ? n : null;
    } else if (pid && line.startsWith("n")) {
      const list = found.get(pid) ?? [];
      list.push(line.slice(1));
      found.set(pid, list);
    }
  }
  return found;
}

const NO_EFFECTIVE_UID = "effective user identity is unavailable";

export function createPosixProcessInspector(
  runner: CommandRunner = defaultCommandRunner,
  geteuid: (() => number) | null = process.geteuid ?? null,
): ProcessInspector {
  return {
    userScopeUnavailable() {
      return typeof geteuid === "function" ? null : NO_EFFECTIVE_UID;
    },

    /**
     * Two `ps` passes because macOS `ps` has no field delimiter: pass A puts the
     * multi-token `lstart` at the tail (uid, pid, ppid, state, and tty are single tokens
     * before it); pass B puts the multi-token `command` at the tail. We join on pid.
     */
    async listProcesses() {
      const [a, b] = await Promise.all([
        runner.run("ps", ["-Ao", "uid=,pid=,ppid=,state=,tty=,lstart="], { timeoutMs: PS_TIMEOUT_MS }),
        runner.run("ps", ["-Ao", "pid=,command="], { timeoutMs: PS_TIMEOUT_MS }),
      ]);

      const commands = new Map<number, string>();
      for (const line of b.stdout.split("\n")) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        if (!m) continue;
        commands.set(Number(m[1]), (m[2] ?? "").trim());
      }

      const effectiveUid = typeof geteuid === "function" ? geteuid() : null;
      const rows: ProcessRow[] = [];
      for (const line of a.stdout.split("\n")) {
        // uid pid ppid state tty <lstart: Www Mmm DD HH:MM:SS YYYY>
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
        if (!m) continue;
        const pid = Number(m[2]);
        rows.push({
          ownedByDaemonUser: effectiveUid !== null && Number(m[1]) === effectiveUid,
          pid,
          ppid: Number(m[3]),
          state: m[4] ?? "",
          tty: m[5] ?? "",
          start: (m[6] ?? "").trim(),
          command: commands.get(pid) ?? "",
        });
      }
      const failure = [a, b].find(
        (result) => result.code !== 0 || result.outcomeUnknown || result.overflowed,
      ) ?? null;
      return {
        rows,
        failure,
        collectorPids: [a.childPid, b.childPid].filter(
          (pid): pid is number => Number.isInteger(pid) && (pid ?? 0) > 0,
        ),
      };
    },

    /**
     * One batched `lsof`. `-Fpn` prints `p<pid>` then `n<path>` records; we pair them.
     * lsof may exit non-zero when some pids vanish mid-call, but still prints the survivors.
     */
    async readCwds(pids) {
      const result = await runner.run("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], {
        timeoutMs: CWD_LIST_TIMEOUT_MS,
      });
      const cwds = new Map<number, string>();
      let pid: number | null = null;
      for (const line of result.stdout.split("\n")) {
        if (line.startsWith("p")) {
          const n = Number(line.slice(1));
          pid = Number.isNaN(n) ? null : n;
        } else if (line.startsWith("n") && pid !== null) {
          cwds.set(pid, line.slice(1));
        }
      }
      return { cwds, result };
    },

    async readOpenFiles(pids) {
      const result = await runner.run("lsof", ["-a", "-p", pids.join(","), "-Fn"], {
        timeoutMs: 3000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return { files: parseLsofNames(result.stdout), result };
    },

    /**
     * `ps -ww -o lstart=,command=` - ONE subprocess for both halves.
     *
     * `-ww` is not optional: without it macOS clips the line to the terminal width, which
     * would silently truncate the command line. `lstart` is printed to a fixed width and
     * `command` renders control characters as escape TEXT, both of which are deterministic.
     */
    readStartAndCommandSync(pid) {
      const raw = runner.runSync("ps", ["-ww", "-o", "lstart=,command=", "-p", String(pid)], {
        timeoutMs: 5_000,
        maxBuffer: 1024 * 1024,
      });
      if (raw === null) return null;
      // `lstart` is five whitespace-separated tokens (`Fri Jul 31 15:15:37 2026`); a line with
      // nothing after them is not a row we understand, and guessing at a half-read one is
      // exactly what an identity must not do.
      const tokens = flattenProcessText(raw).split(" ");
      if (tokens.length < 6) return null;
      const start = tokens.slice(0, 5).join(" ");
      const command = tokens.slice(5).join(" ");
      if (!start || !command) return null;
      return { start, command };
    },

    readStartTimeSync(pid) {
      return runner.runSync("ps", ["-o", "lstart=", "-p", String(pid)], { timeoutMs: 1000, maxBuffer: 4096 });
    },

    /** `lsof -t` prints bare pids, one per line, for the sockets in LISTEN on that port. */
    async findListeningPid(port) {
      const result = await runner.run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
        timeoutMs: 4000,
      });
      const pid = Number(result.stdout.split("\n")[0]?.trim());
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    },
  };
}

export const posixProcessInspector = createPosixProcessInspector();
