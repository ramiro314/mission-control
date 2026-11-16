import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { databaseBackupStatusFrom, type DatabaseBackupStatus } from "@shared/database-backups.ts";
import { taskRepoRefs, type TaskRepoSource } from "@shared/task-repos.ts";
import {
  backupFailedProblems,
  STORAGE_PROBLEM_KINDS,
  stuckReturnProblems,
  StorageFirstSeenSchema,
  storageAlertConditions,
  storageAlertProblems,
  type StorageBackupCopy,
  type StorageFirstSeen,
  type StorageHealth,
  type StorageProblem,
  type StorageUsage,
  type StorageVolume,
  type WorktreeReturnRefusal,
} from "@shared/storage-health.ts";
import {
  DEFAULT_STORAGE_LIMITS_CONFIG,
  storageAlertStateFrom,
  type StorageAlertState,
  type StorageLimitsConfig,
} from "@shared/storage-limits.ts";
import { getAppConfig, setAppConfig } from "./db.ts";

/**
 * How long a first-seen entry outlives its problem. A pass that misses a problem it should
 * have seen, such as one whose `ps` or `lsof` timed out, therefore keeps the same id.
 */
export const STORAGE_FIRST_SEEN_GRACE_MS = 60 * 60 * 1_000;

/**
 * What one source of storage problems saw on one pass.
 *
 *  - `problems` already carry ids built from durable state of their own.
 *  - `firstSeen` problems have no timestamp of their own, so the service stamps one: the
 *    first time their subject was seen, kept in the operational `storage.firstSeen` record.
 *  - `goneSubjects` no longer exist at all, so their first-seen entries are dropped at once
 *    instead of waiting out the grace.
 */
export interface StorageProblemObservation {
  problems?: StorageProblem[];
  firstSeen?: Array<{ subject: string; problem: (firstSeenAt: number) => StorageProblem }>;
  goneSubjects?: string[];
}

/** One source of storage problems, read with the pass's clock. */
export type StorageProblemSource = (now: number) => StorageProblemObservation;

/**
 * Advance the first-seen record by one pass. A subject seen now keeps its first-seen time,
 * or gets `now` on first appearance; one not seen is kept until it has been absent for the
 * grace, and a gone one is dropped at once.
 */
export function advanceFirstSeen(
  record: StorageFirstSeen,
  present: Iterable<string>,
  gone: Iterable<string>,
  now: number,
): StorageFirstSeen {
  const next: StorageFirstSeen = {};
  const seen = new Set(present);
  const removed = new Set(gone);
  for (const [subject, entry] of Object.entries(record)) {
    if (removed.has(subject) || seen.has(subject)) continue;
    if (now - entry.lastSeenAt <= STORAGE_FIRST_SEEN_GRACE_MS) next[subject] = entry;
  }
  for (const subject of seen) {
    next[subject] = { firstSeenAt: record[subject]?.firstSeenAt ?? now, lastSeenAt: now };
  }
  return next;
}

interface RefusalRow {
  firstRefusedAt: number;
  refusal: WorktreeReturnRefusal;
}

/**
 * `stuck-return` problems, from the refusal columns task returns and check-lease returns
 * record. Each links to the native slot holding the owner's tree, read from its lease id, so
 * the Storage row opens that slot card.
 */
export function stuckReturnSource(deps: {
  taskRefusals: () => Array<RefusalRow & { taskId: string }>;
  task: (id: string) => (TaskRepoSource & { title: string }) | undefined;
  checkRefusals: () => Array<RefusalRow & { attemptId: string; nodeId: string; leaseId: string | null }>;
  slotForLease: (leaseId: string) => string | null;
}): StorageProblemSource {
  const slotFor = (leaseIds: Array<string | null>): string | null => {
    for (const leaseId of leaseIds) {
      const slotId = leaseId ? deps.slotForLease(leaseId) : null;
      if (slotId) return slotId;
    }
    return null;
  };
  return (now) => {
    const tasks = deps.taskRefusals().map((row) => {
      const task = deps.task(row.taskId);
      return {
        owner: "task" as const,
        ownerId: row.taskId,
        label: task ? `Task "${task.title}"` : `Task ${row.taskId}`,
        firstRefusedAt: row.firstRefusedAt,
        refusal: row.refusal,
        slotId: task ? slotFor(taskRepoRefs(task).map((ref) => ref.worktreeLeaseId)) : null,
      };
    });
    const checks = deps.checkRefusals().map((row) => ({
      owner: "check" as const,
      ownerId: row.attemptId,
      label: `Check "${row.nodeId}"`,
      firstRefusedAt: row.firstRefusedAt,
      refusal: row.refusal,
      slotId: slotFor([row.leaseId]),
    }));
    return { problems: stuckReturnProblems([...tasks, ...checks], now) };
  };
}

interface StorageHealthDeps {
  backups: {
    status(): DatabaseBackupStatus;
    keptCopies(): StorageBackupCopy[];
    /**
     * The kept copies' allocated bytes, the basis the walk measured in. Absent: their file sizes,
     * which match it only for copies that are not sparse.
     */
    keptDiskBytes?(): number;
  };
  /** The state directory's last measurement and its volume. Absent: nothing measured. */
  usage?: {
    usage(): StorageUsage;
    volume(): StorageVolume | null;
  };
  /** The saved limits. Absent: the shipped defaults. */
  limits?: () => StorageLimitsConfig;
  /** Where each warning's occurrence start is kept across restarts. Absent: memory only. */
  alerts?: {
    read(): StorageAlertState;
    write(state: StorageAlertState): void;
  };
  now?: () => number;
  /** Called with each recomputed aggregate that differs from the last one published. */
  publish(health: StorageHealth): void;
  /** Problem kinds beyond the backups' own, in the order they were registered. */
  sources?: StorageProblemSource[];
  readFirstSeen?: () => StorageFirstSeen;
  writeFirstSeen?: (record: StorageFirstSeen) => void;
}

function storedFirstSeen(): StorageFirstSeen {
  const parsed = StorageFirstSeenSchema.safeParse(getAppConfig(APP_CONFIG_ENTRIES.storageFirstSeen));
  return parsed.success ? parsed.data : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const KIND_ORDER = new Map(STORAGE_PROBLEM_KINDS.map((kind, index) => [kind, index]));

const UNMEASURED: StorageUsage = {
  root: "",
  measuredAt: null,
  durationMs: null,
  measuring: false,
  error: null,
  totalBytes: null,
  categories: [],
  pools: [],
};

/**
 * The backups category moved by however much the kept copies changed since the last walk, so
 * saving a lower backup limit shows in the totals at once. Only the change is applied: the walk
 * also measured what is not a kept copy (a capture's temporary file, a sidecar), and replacing
 * the category with the kept copies alone would drop those bytes from the total and from the
 * limit warning. The total moves by the same difference, which keeps the categories adding up.
 */
function withLiveBackups(usage: StorageUsage, rawDelta: number): StorageUsage {
  if (usage.totalBytes === null || rawDelta === 0) return usage;
  const measured = usage.categories.find((category) => category.id === "backups")?.bytes ?? 0;
  // Never take away more than the category held: anything past that belongs to other
  // categories, and removing it would understate the total and could clear a real warning.
  const delta = Math.max(rawDelta, -measured);
  return {
    ...usage,
    totalBytes: Math.max(0, usage.totalBytes + delta),
    categories: usage.categories.map((category) => category.id === "backups"
      ? { ...category, bytes: measured + delta }
      : category),
  };
}

/**
 * The one storage aggregate behind Settings > Storage and both banners. It recomputes after
 * every capture and maintenance pass, prune, measurement and volume check, and limits save, and
 * publishes only when the result changed, so a quiet machine wakes no browser.
 */
export class StorageHealthService {
  private readonly sources: StorageProblemSource[];
  private readonly now: () => number;
  private readonly readFirstSeen: () => StorageFirstSeen;
  private readonly writeFirstSeen: (record: StorageFirstSeen) => void;
  private last: { health: StorageHealth; serialized: string } | null = null;
  /**
   * Each warning's current occurrence. Read from `deps.alerts` once, then held here as the source
   * of truth: the persisted copy only carries it across a restart. A write can fail exactly when
   * this matters most, on a full disk, and reading the older row back would start the standing
   * warning again under a new id, re-showing a dismissed banner and repeating the notification.
   */
  private alertState: StorageAlertState | null = null;
  /** The last write of `alertState` failed, so it is written again on the next recompute. */
  private alertsUnsaved = false;
  /**
   * The kept copies' on-disk bytes when this service first saw the current walk: the baseline a
   * change in them is measured from, in the walk's own allocated-block basis.
   */
  private backupBaseline: { measuredAt: number; keptBytes: number } | null = null;

  constructor(private readonly deps: StorageHealthDeps) {
    this.sources = deps.sources ?? [];
    this.now = deps.now ?? Date.now;
    this.readFirstSeen = deps.readFirstSeen ?? storedFirstSeen;
    this.writeFirstSeen = deps.writeFirstSeen
      ?? ((record) => setAppConfig(APP_CONFIG_ENTRIES.storageFirstSeen, record));
  }

  /** The last published aggregate, computing one if none has been yet. */
  current(): StorageHealth {
    return this.last?.health ?? this.recompute();
  }

  recompute(): StorageHealth {
    const now = this.now();
    const status = this.attempt(
      "backup status", () => this.deps.backups.status(), databaseBackupStatusFrom(undefined),
    );
    const copies = this.attempt("kept copies", () => this.deps.backups.keptCopies(), []);
    const backupBytes = copies.reduce((total, copy) => total + copy.bytes, 0);
    const limits = this.attempt("storage limits", () => this.deps.limits?.() ?? DEFAULT_STORAGE_LIMITS_CONFIG, DEFAULT_STORAGE_LIMITS_CONFIG);
    const measuredUsage = this.attempt("storage usage", () => this.deps.usage?.usage() ?? UNMEASURED, UNMEASURED);
    const backupDiskBytes = this.attempt(
      "backup disk bytes", () => this.deps.backups.keptDiskBytes?.() ?? backupBytes, backupBytes,
    );
    if (measuredUsage.measuredAt !== null && this.backupBaseline?.measuredAt !== measuredUsage.measuredAt) {
      this.backupBaseline = { measuredAt: measuredUsage.measuredAt, keptBytes: backupDiskBytes };
    }
    const usage = withLiveBackups(
      measuredUsage,
      this.backupBaseline && measuredUsage.measuredAt !== null ? backupDiskBytes - this.backupBaseline.keptBytes : 0,
    );
    const volume = this.attempt("storage volume", () => this.deps.usage?.volume() ?? null, null);
    const alerts = this.advanceAlerts(storageAlertConditions({ limits, totalBytes: usage.totalBytes, volume }));

    const problems: StorageProblem[] = [
      ...backupFailedProblems(status),
      ...storageAlertProblems({ limits, totalBytes: usage.totalBytes, volume, alerts }),
    ];

    const firstSeen: NonNullable<StorageProblemObservation["firstSeen"]> = [];
    const gone: string[] = [];
    for (const source of this.sources) {
      const observation = this.attempt("problem source", () => source(now), {});
      problems.push(...(observation.problems ?? []));
      firstSeen.push(...(observation.firstSeen ?? []));
      gone.push(...(observation.goneSubjects ?? []));
    }
    problems.push(...this.stampFirstSeen(firstSeen, gone, now));
    problems.sort((left, right) =>
      KIND_ORDER.get(left.kind)! - KIND_ORDER.get(right.kind)! || left.id.localeCompare(right.id));

    const health: StorageHealth = {
      backups: { status, copies, totalBytes: backupBytes },
      usage,
      volume,
      limits: { ...limits },
      problems,
    };
    const serialized = JSON.stringify(health);
    if (serialized !== this.last?.serialized) {
      this.last = { health, serialized };
      this.deps.publish(health);
    }
    return health;
  }

  private stampFirstSeen(
    observed: NonNullable<StorageProblemObservation["firstSeen"]>,
    gone: string[],
    now: number,
  ): StorageProblem[] {
    const before = this.attempt("first-seen record", this.readFirstSeen, {});
    const after = advanceFirstSeen(before, observed.map((each) => each.subject), gone, now);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      this.attempt("first-seen record", () => this.writeFirstSeen(after), undefined);
    }
    return observed.map((each) => each.problem(after[each.subject]!.firstSeenAt));
  }

  /**
   * Start an occurrence when its condition begins and end it when the condition clears. A
   * condition with no reading to judge (nothing measured yet) neither starts nor ends one.
   */
  private advanceAlerts(conditions: { lowFreeSpace: boolean | null; storageLimit: boolean | null }): StorageAlertState {
    const current = this.alertState ??= this.attempt(
      "storage alerts", () => this.deps.alerts?.read() ?? storageAlertStateFrom(undefined), storageAlertStateFrom(undefined),
    );
    const now = this.now();
    const since = (holds: boolean | null, started: number | null): number | null =>
      holds === null ? started : holds ? started ?? now : null;
    const next: StorageAlertState = {
      lowFreeSpaceSince: since(conditions.lowFreeSpace, current.lowFreeSpaceSince),
      storageLimitSince: since(conditions.storageLimit, current.storageLimitSince),
    };
    const changed = next.lowFreeSpaceSince !== current.lowFreeSpaceSince || next.storageLimitSince !== current.storageLimitSince;
    this.alertState = next;
    if (changed || this.alertsUnsaved) {
      try {
        this.deps.alerts?.write(next);
        this.alertsUnsaved = false;
      } catch (error) {
        this.alertsUnsaved = true;
        console.warn(`[mission-control] storage health could not save storage alerts, will retry: ${errorMessage(error)}`);
      }
    }
    return next;
  }

  /** One input that fails is reported and left out; the rest of the aggregate still lands. */
  private attempt<T>(what: string, read: () => T, fallback: T): T {
    try {
      return read();
    } catch (error) {
      console.warn(`[mission-control] storage health could not read ${what}: ${errorMessage(error)}`);
      return fallback;
    }
  }
}
