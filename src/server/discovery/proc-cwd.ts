import { processInspector, type ProcessInspector } from "../process-inspection/index.ts";

export interface ProcCwdSnapshot {
  cwds: Map<number, string>;
  /** Non-null when lsof failed without a usable, bounded process answer. */
  unknownReason: string | null;
  /**
   * Omitted pids the system refused to open for this user at all (`ProcessInspector.readCwds`).
   * Absent where the system does not say, which is every platform but win32.
   */
  refused?: ReadonlySet<number>;
}

/**
 * Resolve the real working directory of each pid via one batched `lsof`.
 *
 * This is authoritative for a session's cwd. Unlike a tmux/wezterm pane path
 * (which tracks where the pane's launcher was invoked) or a wrapper launcher's
 * own cwd, it reflects where the agent process itself runs - and therefore where
 * Claude writes its transcript (`~/.claude/projects/<encoded-cwd>/<id>.jsonl`).
 *
 * `inspector` defaults to this platform's; a test passes another platform's to see what it
 * reports here.
 *
 * Never throws: lsof may exit non-zero when some pids vanish mid-call, but still prints the
 * survivors. The partial map remains available to discovery callers; destructive callers
 * independently recheck an omitted PID before treating it as gone.
 */
export async function readProcCwdsSnapshot(
  pids: number[],
  inspector: ProcessInspector = processInspector(),
): Promise<ProcCwdSnapshot> {
  const uniq = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  if (uniq.length === 0) return { cwds: new Map(), unknownReason: null };

  const { cwds, result: res, refused } = await inspector.readCwds(uniq);
  // lsof exits 1 when one PID vanishes during a batched read, while still printing the
  // survivors. A partial answer is usable evidence, but omission is not proof of exit;
  // destructive callers compare unresolved PIDs against a fresh process snapshot.
  const failure = res.overflowed
    ? "the cwd listing was too large to buffer"
    : res.outcomeUnknown
      ? "the cwd listing was killed before it answered (timed out, or stopped from outside)"
      : res.stderr.trim() || `exit ${res.code}`;
  const unknown =
    res.outcomeUnknown || res.overflowed || (res.code !== 0 && cwds.size === 0)
      ? `cwd listing failed: ${failure}`
      : null;
  return refused && refused.size > 0 ? { cwds, unknownReason: unknown, refused } : { cwds, unknownReason: unknown };
}

export async function readProcCwds(pids: number[]): Promise<Map<number, string>> {
  return (await readProcCwdsSnapshot(pids)).cwds;
}
