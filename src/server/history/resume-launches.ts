import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { historyResumeCancellable, type HistoryResumeLaunch } from "@shared/history.ts";
import type { AgentType, ServerEvent, Session } from "@shared/types.ts";
import { openDb } from "../db.ts";

/**
 * History Resume's launch records (`history_resume_launches`, `docs/history.md`): the claim a
 * Resume takes before it does anything, the binding to the session discovery later registers,
 * and every way an open launch closes. The daemon is the only writer.
 *
 * A launch is OPEN while it is `pending` or `expired`, and a session has at most one open
 * launch: the partial unique index enforces it, so the insert in `claim` is the claim.
 */

/** The fields a launch is created with. */
export interface HistoryResumeClaim {
  agent: AgentType;
  sourceSessionId: string;
  expectedAgentSessionId: string;
  /** Already resolved through symlinks: the one value the launch and its binding use. */
  cwd: string;
  slotId?: string | null;
  leaseKey?: string | null;
  copyPath?: string | null;
}

/** A Registry session as binding reads it. */
export type HistoryResumeCandidate = Pick<Session, "id" | "agent" | "agentSessionId" | "cwd">;

export type HistoryResumeClaimResult =
  | { ok: true; launch: HistoryResumeLaunch }
  | { ok: false; open: HistoryResumeLaunch };

export type HistoryResumeCancelResult =
  | { ok: true; launch: HistoryResumeLaunch }
  | { ok: false; reason: "not_found" | "not_pending" | "has_slot"; launch?: HistoryResumeLaunch };

interface Row {
  launch_id: string;
  agent: string;
  source_session_id: string;
  expected_agent_session_id: string;
  cwd: string;
  slot_id: string | null;
  launched_at: number;
  mc_session_id: string | null;
  state: string;
}

function toLaunch(row: Row): HistoryResumeLaunch {
  return {
    launchId: row.launch_id,
    agent: row.agent as AgentType,
    sourceSessionId: row.source_session_id,
    expectedAgentSessionId: row.expected_agent_session_id,
    cwd: row.cwd,
    slotId: row.slot_id,
    launchedAt: row.launched_at,
    mcSessionId: row.mc_session_id,
    state: row.state,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}

/**
 * A directory as a launch compares it: resolved through symlinks when it still resolves, so
 * a session discovered under another spelling of the launch directory still matches it.
 */
export function canonicalResumeCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

export class HistoryResumeLaunches {
  constructor(private readonly db: DatabaseSync = openDb()) {}

  /**
   * Insert a `pending` launch in its own transaction. Losing the insert to the open-launch
   * index answers with the launch that holds the session instead, and writes nothing.
   */
  claim(input: HistoryResumeClaim, now: number): HistoryResumeClaimResult {
    const launchId = randomUUID();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare(
          `INSERT INTO history_resume_launches (
             launch_id, agent, source_session_id, expected_agent_session_id, cwd, slot_id, lease_key,
             copy_path, launched_at, mc_session_id, state, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?)`,
        ).run(
          launchId,
          input.agent,
          input.sourceSessionId,
          input.expectedAgentSessionId,
          input.cwd,
          input.slotId ?? null,
          input.leaseKey ?? null,
          input.copyPath ?? null,
          now,
          now,
        );
        this.db.exec("COMMIT");
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const open = this.open(input.agent, input.sourceSessionId);
      // The index refused, so an open launch existed at that instant. One that closed since
      // is a retry the caller can make; reporting it as a collision would be wrong.
      if (!open) throw error;
      return { ok: false, open };
    }
    return { ok: true, launch: this.get(launchId)! };
  }

  get(launchId: string): HistoryResumeLaunch | null {
    const row = this.db.prepare("SELECT * FROM history_resume_launches WHERE launch_id = ?").get(launchId) as
      | Row
      | undefined;
    return row ? toLaunch(row) : null;
  }

  /** The session's open launch, or null. */
  open(agent: AgentType, sourceSessionId: string): HistoryResumeLaunch | null {
    const row = this.db.prepare(
      `SELECT * FROM history_resume_launches
        WHERE agent = ? AND source_session_id = ? AND state IN ('pending', 'expired')`,
    ).get(agent, sourceSessionId) as Row | undefined;
    return row ? toLaunch(row) : null;
  }

  /** Every launch in one of `states`, oldest first. */
  inStates(states: readonly string[]): HistoryResumeLaunch[] {
    if (states.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT * FROM history_resume_launches WHERE state IN (${states.map(() => "?").join(", ")})
        ORDER BY launched_at, launch_id`,
    ).all(...states) as unknown as Row[];
    return rows.map(toLaunch);
  }

  /**
   * Free a launch whose later step failed, or one with nothing left to hold. An open or ended
   * launch becomes `released`; a launch already bound or released is left as it is.
   */
  release(launchId: string, now: number): boolean {
    return this.transition(launchId, ["pending", "expired", "ended"], "released", now);
  }

  /**
   * Cancel pending resume: close a `pending` launch with no slot at once. A launch with a
   * slot is closed by Returning that slot instead, so the pool never resets it under a late
   * agent.
   */
  cancel(launchId: string, now: number): HistoryResumeCancelResult {
    const launch = this.get(launchId);
    if (!launch) return { ok: false, reason: "not_found" };
    if (!historyResumeCancellable(launch)) {
      return { ok: false, reason: launch.slotId !== null ? "has_slot" : "not_pending", launch };
    }
    if (!this.transition(launchId, ["pending"], "released", now)) {
      return { ok: false, reason: "not_pending", launch: this.get(launchId) ?? launch };
    }
    return { ok: true, launch: this.get(launchId)! };
  }

  /**
   * Bind every open launch this session is the resumed agent of: its agent session id is the
   * launch's expected id AND its directory, resolved through symlinks, is the launch's `cwd`.
   * The id alone is not enough - a plain resume keeps the source id - so a session with the
   * right id in any other directory binds nothing. Returns the launches bound.
   */
  bind(session: HistoryResumeCandidate, now: number): HistoryResumeLaunch[] {
    if (!session.agentSessionId || !session.cwd) return [];
    const rows = this.db.prepare(
      `SELECT * FROM history_resume_launches
        WHERE agent = ? AND expected_agent_session_id = ? AND state IN ('pending', 'expired')`,
    ).all(session.agent, session.agentSessionId) as unknown as Row[];
    if (rows.length === 0) return [];
    const cwd = canonicalResumeCwd(session.cwd);
    const bound: HistoryResumeLaunch[] = [];
    const statement = this.db.prepare(
      `UPDATE history_resume_launches SET state = 'bound', mc_session_id = ?, updated_at = ?
        WHERE launch_id = ? AND state IN ('pending', 'expired')`,
    );
    for (const row of rows) {
      if (row.cwd !== cwd) continue;
      if (Number(statement.run(session.id, now, row.launch_id).changes) > 0) bound.push(this.get(row.launch_id)!);
    }
    return bound;
  }

  /**
   * The bound launch's session left the Registry: the launch is `ended`. A launch with a slot
   * then waits for that slot's release; one without has nothing left to hold.
   */
  sessionRemoved(mcSessionId: string, now: number): HistoryResumeLaunch[] {
    const rows = this.db.prepare(
      "SELECT * FROM history_resume_launches WHERE mc_session_id = ? AND state = 'bound'",
    ).all(mcSessionId) as unknown as Row[];
    const ended: HistoryResumeLaunch[] = [];
    for (const row of rows) {
      if (this.transition(row.launch_id, ["bound"], "ended", now)) ended.push(this.get(row.launch_id)!);
    }
    return ended;
  }

  /**
   * Close every `pending` launch whose agent has not appeared within `graceMs`. One with a
   * slot becomes `expired` and keeps its slot, because a slow terminal can still produce the
   * agent; one without has no slot to protect and becomes `released`, so it never holds the
   * session's one open launch past its window. Returns the launches changed.
   */
  expire(now: number, graceMs: number): HistoryResumeLaunch[] {
    const rows = this.db.prepare(
      "SELECT * FROM history_resume_launches WHERE state = 'pending' AND launched_at + ? <= ?",
    ).all(graceMs, now) as unknown as Row[];
    return rows.flatMap((row) => this.closeUnbound(row, now));
  }

  /**
   * The startup twin, run once the first discovery sweep after startup has finished. Launches
   * whose agent is running bind first, on the same id-and-cwd key. Then a `bound` launch with
   * no live session carrying its expected id in its directory ended while the daemon was
   * down, and a `pending` one whose agent never appeared closes as `expire` closes it.
   *
   * Only launches made before `before` (this daemon's start) are judged: one this daemon made
   * while its first sweep ran has had no chance to be discovered yet.
   */
  startup(live: readonly HistoryResumeCandidate[], now: number, before: number = now): HistoryResumeLaunch[] {
    for (const session of live) this.bind(session, now);
    const running = new Set<string>();
    for (const session of live) {
      if (session.agentSessionId && session.cwd) {
        running.add(`${session.agent}:${session.agentSessionId}:${canonicalResumeCwd(session.cwd)}`);
      }
    }
    const key = (launch: HistoryResumeLaunch) => `${launch.agent}:${launch.expectedAgentSessionId}:${launch.cwd}`;
    const changed: HistoryResumeLaunch[] = [];
    for (const launch of this.inStates(["bound"])) {
      if (launch.launchedAt >= before || running.has(key(launch))) continue;
      if (this.transition(launch.launchId, ["bound"], "ended", now)) changed.push(this.get(launch.launchId)!);
    }
    const pending = this.db.prepare("SELECT * FROM history_resume_launches WHERE state = 'pending'").all() as unknown as Row[];
    for (const row of pending) {
      if (row.launched_at < before && !running.has(key(toLaunch(row)))) changed.push(...this.closeUnbound(row, now));
    }
    return changed;
  }

  private closeUnbound(row: Row, now: number): HistoryResumeLaunch[] {
    const next = row.slot_id === null ? "released" : "expired";
    return this.transition(row.launch_id, ["pending"], next, now) ? [this.get(row.launch_id)!] : [];
  }

  private transition(launchId: string, from: readonly string[], to: string, now: number): boolean {
    const result = this.db.prepare(
      `UPDATE history_resume_launches SET state = ?, updated_at = ?
        WHERE launch_id = ? AND state IN (${from.map(() => "?").join(", ")})`,
    ).run(to, now, launchId, ...from);
    return Number(result.changes) > 0;
  }
}

/** What the tracker needs from the Registry. */
export interface HistoryResumeRegistry {
  subscribe(fn: (event: ServerEvent) => void): () => void;
  onSessionsObserved(fn: () => void): () => void;
  liveSessions(): HistoryResumeCandidate[];
}

/**
 * Keep launch records in step with the Registry: bind a launch when discovery registers its
 * agent, end it when that session leaves, run the startup twin after the first sweep, and
 * close unbound launches past their grace window on every tick. Returns the stop function.
 */
export function trackHistoryResumeLaunches(
  launches: HistoryResumeLaunches,
  registry: HistoryResumeRegistry,
  options: { graceMs: number; tickMs: number; now?: () => number },
): () => void {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const guarded = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      console.error(`[history] resume launch ${what} failed: ${String(error)}`);
    }
  };
  const unsubscribe = registry.subscribe((event) => {
    if (event.type === "session_upsert") guarded("binding", () => launches.bind(event.session, now()));
    else if (event.type === "session_remove") guarded("end", () => launches.sessionRemoved(event.id, now()));
  });
  const unobserved = registry.onSessionsObserved(() =>
    guarded("startup check", () => launches.startup(registry.liveSessions(), now(), startedAt)));
  const timer = setInterval(() => guarded("expiry", () => launches.expire(now(), options.graceMs)), options.tickMs);
  timer.unref?.();
  return () => {
    unsubscribe();
    unobserved();
    clearInterval(timer);
  };
}
