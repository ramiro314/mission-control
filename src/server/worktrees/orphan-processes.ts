import { realpath } from "node:fs/promises";
import {
  storageProblem,
  type OrphanProcessKillRequest,
  type StorageProblem,
} from "@shared/storage-health.ts";
import { CHECK_WORKTREES_DIR, WORKTREES_DIR } from "../config.ts";
import { flattenProcessText, processInspector } from "../process-inspection/index.ts";
import {
  inspectWorktreeOccupancy,
  pathContains,
  type WorktreeOccupancy,
  type WorktreeOccupant,
} from "./occupancy.ts";
import type { WorktreeSlotRow } from "./store.ts";

/** How long a SIGTERM gets before the SIGKILL (D19). */
export const ORPHAN_KILL_GRACE_MS = 5_000;
const POLL_MS = 100;

/** Whose return a tree is waiting on, so a Kill can retry exactly that return. */
export type FinishedTreeOwner =
  | { kind: "task"; taskId: string }
  | { kind: "check"; attemptId: string }
  | { kind: "slot"; slotId: string }
  /** An available slot with no lease has no owner at all, and no return to wait on. */
  | { kind: "available-slot"; slotId: string }
  /** An unreferenced folder the orphan tree sweep left in place. Its "return" is the next sweep. */
  | { kind: "unowned" };

/** A tree whose owner has finished or is gone, or that has none, so any process still inside it is an orphan. */
export interface FinishedTree {
  path: string;
  /** The pool slot at this path, or null for a tree under `worktrees/` or `check-worktrees/`. */
  slotId: string | null;
  owner: FinishedTreeOwner;
}

/**
 * Every tree whose owner has finished: a task's pending return, a check lease stuck in
 * `returning`, a quarantined slot, an available slot with no lease, and an unreferenced folder
 * under `worktrees/` or `check-worktrees/` that the orphan tree sweep left in place. One path
 * can be several of these; the scan merges them.
 *
 * A pool slot is a finished tree for an owner only while it holds that owner's own lease, or no
 * lease at all and is quarantined. A completed task can keep owing a return after its slot was
 * reset and leased to a live task (the return is then retained as "task ownership changed"), and
 * a quarantine can keep a live lease. Inspecting either would offer a live owner's processes for
 * Kill. A Warm holds its slot under a lease, so only a claim can be running in an available slot
 * with none, and only for the moment before it unregisters; that slot is skipped.
 */
export function finishedTrees(input: {
  /** The worktree manager: its slot rows, and the dependency claims running in them right now. */
  pool: {
    store: { slots: () => readonly WorktreeSlotRow[] };
    claims: { has: (slotId: string) => boolean };
  };
  taskReturns: ReadonlyArray<{ taskId: string; trees: ReadonlyArray<{ path: string; leaseId: string | null }> }>;
  returningChecks: ReadonlyArray<{ attemptId: string; path: string; leaseId: string | null }>;
  /** Unreferenced folders, which no slot, task or check owns. */
  unownedTrees?: readonly string[];
}): FinishedTree[] {
  const slots = input.pool.store.slots();
  const slotAt = new Map(slots.map((slot) => [slot.path, slot]));
  const finishedFor = (path: string, leaseId: string | null): boolean => {
    const slot = slotAt.get(path);
    if (!slot) return true;
    return slot.activeLeaseId === null ? slot.state === "quarantined" : slot.activeLeaseId === leaseId;
  };
  return [
    ...input.taskReturns.flatMap(({ taskId, trees }) => trees
      .filter(({ path, leaseId }) => finishedFor(path, leaseId))
      .map(({ path }) => ({
        path, slotId: slotAt.get(path)?.id ?? null, owner: { kind: "task", taskId } as const,
      }))),
    ...input.returningChecks
      .filter(({ path, leaseId }) => finishedFor(path, leaseId))
      .map(({ attemptId, path }) => ({
        path, slotId: slotAt.get(path)?.id ?? null, owner: { kind: "check", attemptId } as const,
      })),
    ...slots.filter((slot) => slot.state === "quarantined" && slot.activeLeaseId === null).map((slot) => ({
      path: slot.path, slotId: slot.id, owner: { kind: "slot", slotId: slot.id } as const,
    })),
    ...slots
      .filter((slot) => slot.state === "available" && slot.activeLeaseId === null && !input.pool.claims.has(slot.id))
      .map((slot) => ({
        path: slot.path, slotId: slot.id, owner: { kind: "available-slot", slotId: slot.id } as const,
      })),
    ...(input.unownedTrees ?? []).filter((path) => !slotAt.has(path)).map((path) => ({
      path, slotId: null, owner: { kind: "unowned" } as const,
    })),
  ];
}

interface ReportedTree {
  /** The real path, which is also the key and what a Kill's `path` must resolve to. */
  tree: string;
  slotId: string | null;
  owners: FinishedTreeOwner[];
  occupants: WorktreeOccupant[];
}

export type OrphanKillResult =
  | { ok: true; signal: "SIGTERM" | "SIGKILL" }
  | { ok: false; error: string };

export interface OrphanProcessDeps {
  trees: () => FinishedTree[];
  /** Retry the return a finished owner is waiting on. A slot, in either state, has none. */
  retryReturn: (owner: FinishedTreeOwner) => unknown;
  /** After a scan or a kill, so the storage aggregate recomputes. */
  changed?: () => void;
  /** Where a tree that is not a pool slot may sit. Children only, never the root itself. */
  unpooledRoots?: readonly string[];
  occupancy?: (paths: readonly string[]) => Promise<Map<string, WorktreeOccupancy>>;
  signal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
}

/** Whether the pid is still alive, under any identity. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid's start time as `ps` prints it, or null when it is gone. */
function startOf(pid: number): string | null {
  const raw = processInspector().readStartTimeSync(pid);
  return raw === null ? null : flattenProcessText(raw) || null;
}

async function realPath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Orphan processes: a process still inside a tree whose owner has finished, or that has no
 * owner (D8). Each maintenance pass scans every such tree with the existing occupancy inspection and reports
 * each process as an `orphan-process` storage problem.
 *
 * Kill only signals a process this monitor reported, and only after a fresh inspection still
 * finds it in that tree with the same start time and command (D19). The guard is the
 * reported list itself: it only ever names pool slots and children of `worktrees/` and
 * `check-worktrees/`, so a request naming any other directory is refused before a single
 * process is inspected.
 *
 * That same fresh inspection refuses a process of a live session, and one it could not check
 * against the sessions (S15). The report still lists such a process, because it still occupies
 * the tree, but a session only ever leaves through `Registry.beginEviction`. Reading this from
 * the fresh inspection rather than the report is what stops a stale list.
 */
export class OrphanProcessMonitor {
  private reported = new Map<string, ReportedTree>();
  private scanning: Promise<void> | null = null;
  private readonly unpooledRoots: readonly string[];
  private readonly occupancy: (paths: readonly string[]) => Promise<Map<string, WorktreeOccupancy>>;
  private readonly signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;

  constructor(private readonly deps: OrphanProcessDeps) {
    this.unpooledRoots = deps.unpooledRoots ?? [WORKTREES_DIR, CHECK_WORKTREES_DIR];
    this.occupancy = deps.occupancy ?? inspectWorktreeOccupancy;
    this.signal = deps.signal ?? ((pid, signal) => process.kill(pid, signal));
  }

  /** One scan at a time; a caller that arrives mid-scan waits for that one. */
  scan(): Promise<void> {
    this.scanning ??= this.runScan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  /** The current report, one `orphan-process` problem per process. */
  problems(): StorageProblem[] {
    return [...this.reported.values()].flatMap((entry) => entry.occupants.map((occupant) => ({
      ...storageProblem(
        "orphan-process",
        `${entry.tree}:${occupant.pid}`,
        occupant.startMs,
        entry.owners.every((owner) => owner.kind === "unowned" || owner.kind === "available-slot")
          ? `Process ${occupant.pid} (${occupant.command}) is still running in ${entry.tree}, which no task or check owns`
          : `Process ${occupant.pid} (${occupant.command}) is still running in ${entry.tree}, whose owner has finished`,
        entry.slotId ? { target: "slot", slotId: entry.slotId } : { target: "unowned-tree", path: entry.tree },
      ),
      process: {
        tree: entry.tree,
        pid: occupant.pid,
        ppid: occupant.ppid,
        command: occupant.command,
        startedAt: occupant.startMs,
        knownOwner: occupant.knownOwner,
        session: occupant.session ?? null,
      },
    })));
  }

  async kill(request: OrphanProcessKillRequest): Promise<OrphanKillResult> {
    const tree = await realPath(request.path);
    const reported = tree === null ? undefined : this.reported.get(tree);
    if (!reported) return { ok: false, error: "that path is not a tree with a reported orphan process" };
    const listed = reported.occupants.find((occupant) => occupant.pid === request.pid);
    if (!listed) return { ok: false, error: `process ${request.pid} is not reported in that tree` };
    if (listed.startMs !== request.startedAt || listed.command !== request.command) {
      return { ok: false, error: `process ${request.pid} does not match the reported start time and command` };
    }

    const fresh = (await this.occupancy([reported.tree])).get(reported.tree);
    if (!fresh || fresh.status !== "known") {
      return { ok: false, error: `the tree's processes could not be inspected${fresh?.status === "unknown" ? `: ${fresh.reason}` : ""}` };
    }
    const current = fresh.occupants.find((occupant) => occupant.pid === request.pid);
    if (!current) return { ok: false, error: `process ${request.pid} is no longer in that tree` };
    if (current.startRaw !== listed.startRaw || current.command !== listed.command) {
      return { ok: false, error: `process ${request.pid} changed its start time or command since it was reported` };
    }
    if (current.session) {
      return { ok: false, error: `process ${request.pid} belongs to live session ${current.session.name}; end it from the session` };
    }
    if (fresh.namesUnread) {
      return { ok: false, error: `process ${request.pid} could not be checked against the live sessions` };
    }

    let sent: "SIGTERM" | "SIGKILL" = "SIGTERM";
    try {
      if (this.send(request.pid, "SIGTERM")) {
        const exited = await this.waitForExit(request.pid, ORPHAN_KILL_GRACE_MS);
        // Five seconds is long enough for a PID to be reused, so the SIGKILL is for the same
        // process only: same start time, or nothing is sent.
        if (!exited && startOf(request.pid) === flattenProcessText(listed.startRaw)) {
          sent = "SIGKILL";
          if (this.send(request.pid, "SIGKILL")) await this.waitForExit(request.pid, 1_000);
        }
      }
    } catch (error) {
      return { ok: false, error: `process ${request.pid} could not be signalled: ${errorMessage(error)}` };
    }

    for (const owner of reported.owners) {
      void Promise.resolve()
        .then(() => this.deps.retryReturn(owner))
        .catch((error) => {
          console.warn(`[worktrees] retrying the return of ${reported.tree} after a kill failed: ${errorMessage(error)}`);
        });
    }
    // A scan already in flight may have inspected before the signal and would write the dead
    // process back, so wait it out and look again rather than join it.
    await this.scanning;
    await this.scan();
    return { ok: true, signal: sent };
  }

  private async runScan(): Promise<void> {
    const inspected = await this.candidates();
    let occupancy: Map<string, WorktreeOccupancy>;
    try {
      occupancy = await this.occupancy([...inspected.keys()]);
    } catch (error) {
      console.warn(`[worktrees] orphan process scan failed: ${errorMessage(error)}`);
      occupancy = new Map();
    }
    const next = new Map<string, ReportedTree>();
    // Listed again now that the inspection answered: an available slot reserved in the meantime
    // may have a claim running, and whatever the inspection saw there is not an orphan.
    for (const [tree, entry] of await this.candidates()) {
      const state = occupancy.get(tree);
      // A pass that could not see a tree keeps what the last one saw there, so a timed-out
      // `lsof` neither clears a real report nor changes its id.
      const occupants = state?.status === "known" ? state.occupants : this.reported.get(tree)?.occupants ?? [];
      if (occupants.length > 0) next.set(tree, { ...entry, occupants });
    }
    this.reported = next;
    try {
      this.deps.changed?.();
    } catch (error) {
      console.warn(`[worktrees] orphan process change listener failed: ${errorMessage(error)}`);
    }
  }

  /** Finished trees by real path, limited to pool slots and children of the unpooled roots. */
  private async candidates(): Promise<Map<string, Omit<ReportedTree, "occupants">>> {
    let trees: FinishedTree[];
    try {
      trees = this.deps.trees();
    } catch (error) {
      console.warn(`[worktrees] orphan process scan could not list finished trees: ${errorMessage(error)}`);
      return new Map();
    }
    const roots = (await Promise.all(this.unpooledRoots.map(realPath))).filter((root) => root !== null);
    const byTree = new Map<string, Omit<ReportedTree, "occupants">>();
    for (const tree of trees) {
      const real = await realPath(tree.path);
      if (real === null) continue;
      if (tree.slotId === null && !roots.some((root) => root !== real && pathContains(root, real))) continue;
      const entry = byTree.get(real) ?? { tree: real, slotId: null, owners: [] };
      entry.slotId ??= tree.slotId;
      if (!entry.owners.some((owner) => JSON.stringify(owner) === JSON.stringify(tree.owner))) {
        entry.owners.push(tree.owner);
      }
      byTree.set(real, entry);
    }
    return byTree;
  }

  /** False when the process was already gone, so there is nothing to wait for. */
  private send(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
    try {
      this.signal(pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }

  private async waitForExit(pid: number, withinMs: number): Promise<boolean> {
    for (let waited = 0; waited < withinMs; waited += POLL_MS) {
      if (!alive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return !alive(pid);
  }
}
