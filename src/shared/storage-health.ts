import { z } from "zod";
import {
  DatabaseBackupsConfigSchema,
  DatabaseBackupStatusSchema,
  RECORDED_DATABASE_BACKUP_KINDS,
  type DatabaseBackupStatus,
} from "./database-backups.ts";
import { formatBytes } from "./format-bytes.ts";
import {
  StorageLimitsConfigSchema,
  storageWarnAtBytes,
  type StorageAlertState,
  type StorageLimitsConfig,
} from "./storage-limits.ts";

/**
 * What Settings > Storage measures, in the order it lists them, and which state-directory
 * entries each one owns. Roots are relative to the state directory; an entry no category names
 * is counted under `other`, so the categories always add up to the measured total.
 *
 * `cleanup` names the Storage tab whose limit can shrink the category, or null when nothing in
 * Storage removes any of it.
 */
export const STORAGE_CATEGORIES = [
  {
    id: "pools",
    label: "Native worktree pools",
    roots: ["worktree-pools"],
    description: "Warm checkouts kept between leases, with their installed dependencies and build output",
    policy: "Idle-cache budget",
    cleanup: "pools",
  },
  {
    id: "backups",
    label: "Database backups",
    roots: ["backups/database"],
    description: "Full copies of the database",
    policy: "Count, age and size limits",
    cleanup: "backups",
  },
  {
    id: "updates",
    label: "App updates",
    roots: ["app-src", "update-runtimes", "update-downloads", "install-attempts"],
    description: "The updater's source clone, runtimes and downloads",
    policy: "Managed by the updater",
    cleanup: null,
  },
  {
    id: "database",
    label: "Live database",
    roots: ["harness.db", "harness.db-wal", "harness.db-shm"],
    description: "Open by the daemon",
    policy: "Never removed",
    cleanup: null,
  },
  {
    id: "evidence",
    label: "Workflow evidence and output",
    roots: ["workflow-evidence", "workflow-command-output"],
    description: "Kept with the runs that produced it",
    policy: "Follows its run",
    cleanup: null,
  },
  {
    id: "worktrees",
    label: "Disposable and check worktrees",
    roots: ["worktrees", "check-worktrees"],
    description: "Each removed with the task or check that made it",
    policy: "Removed with its owner",
    cleanup: null,
  },
  {
    id: "archives",
    label: "Archives",
    roots: ["archives", "scouts"],
    description: "Portable archive bundles",
    policy: "Not cleaned here",
    cleanup: null,
  },
  {
    id: "other",
    label: "Everything else",
    roots: [],
    description: "Logs, uploads, plans, settings snapshots and the rest of the state directory",
    policy: "Not cleaned here",
    cleanup: null,
  },
] as const;

export type StorageCategoryId = (typeof STORAGE_CATEGORIES)[number]["id"];
export const STORAGE_CATEGORY_IDS = STORAGE_CATEGORIES.map((category) => category.id) as [
  StorageCategoryId,
  ...StorageCategoryId[],
];

/** The most pools one aggregate lists, largest first; the rest are still in the category total. */
export const STORAGE_USAGE_POOL_LIMIT = 64;

/**
 * Every kind of storage problem the daemon can report. Settings > Storage lists each one;
 * `STORAGE_PROBLEM_BANNERED` decides which also raise the dashboard banner.
 */
export const STORAGE_PROBLEM_KINDS = [
  "backup-failed",
  "low-free-space",
  "storage-limit",
  "stuck-return",
  "quarantined-slot",
  "orphan-process",
  "dirty-orphan-folder",
  "dirty-settled-tree",
  "stale-lease",
] as const;

export type StorageProblemKind = (typeof STORAGE_PROBLEM_KINDS)[number];

/**
 * Which kinds raise the storage banner (D25), beside the Problems list that shows every one. A
 * failed backup has its own surfaces, the rail and the Backups tab. A dirty settled task tree
 * and a stale live lease are kept by policy rather than by a fault, so they are listed in
 * Storage only.
 */
export const STORAGE_PROBLEM_BANNERED: Readonly<Record<StorageProblemKind, boolean>> = {
  "backup-failed": false,
  "low-free-space": true,
  "storage-limit": true,
  "stuck-return": true,
  "quarantined-slot": true,
  "orphan-process": true,
  "dirty-orphan-folder": true,
  "dirty-settled-tree": false,
  "stale-lease": false,
};

/**
 * Where a problem's fix lives: one of Storage's own tabs (Backups, Cleanup, Limits), a slot
 * card, or an unowned tree.
 */
export const StorageProblemLinkSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("backups") }),
  z.object({ target: z.literal("cleanup") }),
  z.object({ target: z.literal("limits") }),
  z.object({ target: z.literal("slot"), slotId: z.string().min(1) }),
  z.object({ target: z.literal("unowned-tree"), path: z.string().min(1) }),
  /** A tree with no slot card of its own, such as one a non-native provider holds. */
  z.object({ target: z.literal("worktrees") }),
]);

export type StorageProblemLink = z.output<typeof StorageProblemLinkSchema>;

/** The live Mission Control session a process belongs to. Such a process is never offered Kill. */
export const ProcessSessionSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export type ProcessSession = z.output<typeof ProcessSessionSchema>;

/**
 * The process an `orphan-process` problem names, exactly as the occupancy inspection saw it.
 * `startedAt` and `command` are what a Kill request must repeat, so a PID that was reused by
 * another program since the listing is never signalled.
 */
export const OrphanProcessSchema = z.object({
  /** The tree's real path, the same one a Kill request's `path` must resolve to. */
  tree: z.string().min(1),
  pid: z.number().int().positive(),
  ppid: z.number().int().nonnegative(),
  command: z.string(),
  /** Epoch milliseconds of the process's start, as `ps` reports it. */
  startedAt: z.number().int().nonnegative(),
  /** What the process is, when something names it. Absent from a report that predates names. */
  knownOwner: z.string().nullable().optional(),
  /** Set when a live session owns the process, so it ends from that session. */
  session: ProcessSessionSchema.nullable().optional(),
});

export type OrphanProcess = z.output<typeof OrphanProcessSchema>;

/** `POST /api/worktrees/processes/kill`: one reported process, named the way it was reported. */
export const OrphanProcessKillRequestSchema = z.object({
  path: z.string().min(1),
  pid: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  command: z.string().min(1),
}).strict();

export type OrphanProcessKillRequest = z.output<typeof OrphanProcessKillRequestSchema>;

/**
 * One occurrence of a problem. The id joins the subject with the moment this occurrence
 * began, and every part of it comes from durable state, so a daemon restart never changes
 * it and a problem that clears and later recurs gets a new one.
 */
export const StorageProblemSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(STORAGE_PROBLEM_KINDS),
  /**
   * Whether it raises the storage banner, `STORAGE_PROBLEM_BANNERED[kind]`, which the banner
   * reads itself; kept on the wire for the fork's own producers. Absent from a problem built
   * without `storageProblem`.
   */
  bannered: z.boolean().optional(),
  message: z.string(),
  link: StorageProblemLinkSchema,
  /** Set on `orphan-process` problems only. */
  process: OrphanProcessSchema.optional(),
});

export type StorageProblem = z.output<typeof StorageProblemSchema>;

/** `<kind>:<subject>:<when the occurrence began>`. A subject may itself contain colons. */
export function storageProblemId(
  kind: StorageProblemKind,
  subject: string,
  occurrence: number | string,
): string {
  return `${kind}:${subject}:${occurrence}`;
}

export function storageProblem(
  kind: StorageProblemKind,
  subject: string,
  occurrence: number | string,
  message: string,
  link: StorageProblemLink,
): StorageProblem {
  return {
    id: storageProblemId(kind, subject, occurrence),
    kind,
    bannered: STORAGE_PROBLEM_BANNERED[kind],
    message,
    link,
  };
}

const KIND_LABEL = { scheduled: "Scheduled", manual: "Manual" } as const;

/**
 * `backup-failed:<kind>:<failingSince>`, present exactly while that kind's `failingSince` is
 * set, so its id is never built from an empty value and a success clears it.
 */
export function backupFailedProblems(status: DatabaseBackupStatus): StorageProblem[] {
  return RECORDED_DATABASE_BACKUP_KINDS.flatMap((kind) => {
    const { failingSince, lastFailure } = status[kind];
    if (failingSince === null) return [];
    const reason = lastFailure?.message ? `: ${lastFailure.message}` : "";
    return [storageProblem(
      "backup-failed",
      kind,
      failingSince,
      `${KIND_LABEL[kind]} database backup failed${reason}`,
      { target: "backups" },
    )];
  });
}

const epochMs = z.number().int().nonnegative();
const byteCount = z.number().int().nonnegative();


/** One category's measured size. */
export const StorageCategoryUsageSchema = z.object({
  id: z.enum(STORAGE_CATEGORY_IDS),
  bytes: byteCount,
});

/** One native pool directory's measured size. */
export const StoragePoolUsageSchema = z.object({
  /** The pool directory's name beneath `worktree-pools/`. */
  name: z.string(),
  bytes: byteCount,
});

/**
 * The last measurement of the state directory. Measuring walks every file, which takes minutes
 * on a large pool, so it runs in the background on a schedule and on request, and the page
 * shows when it last finished. `measuredAt` is null until the first one does.
 */
export const StorageUsageSchema = z.object({
  /** The state directory measured, as an absolute path. */
  root: z.string(),
  measuredAt: epochMs.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  /** A measurement is running now. */
  measuring: z.boolean(),
  /**
   * When the most recent walk started, or null/absent before the first. What orders two answers
   * about the measurement: `measuredAt` does not move when a walk starts, or when one fails, so
   * it cannot tell a stale idle answer from the newer "measuring" one (`mergeStorageHealth`).
   */
  startedAt: epochMs.nullable().optional(),
  /** Why the last measurement failed or came back partial, or null. */
  error: z.string().nullable(),
  totalBytes: byteCount.nullable(),
  /** Every category in `STORAGE_CATEGORIES` order, once measured; empty before. */
  categories: z.array(StorageCategoryUsageSchema).max(STORAGE_CATEGORIES.length),
  /** Largest first, at most `STORAGE_USAGE_POOL_LIMIT`. */
  pools: z.array(StoragePoolUsageSchema).max(STORAGE_USAGE_POOL_LIMIT),
});

export type StorageUsage = z.output<typeof StorageUsageSchema>;

/** The volume holding the state directory, checked often because checking it is cheap. */
export const StorageVolumeSchema = z.object({
  checkedAt: epochMs,
  totalBytes: byteCount,
  /** Space an unprivileged process can still write. */
  freeBytes: byteCount,
});

export type StorageVolume = z.output<typeof StorageVolumeSchema>;

/**
 * The size and free-space warnings, each present exactly while its condition holds, under an
 * id built from when that occurrence began.
 */
export function storageAlertProblems(input: {
  limits: StorageLimitsConfig;
  totalBytes: number | null;
  volume: StorageVolume | null;
  alerts: StorageAlertState;
}): StorageProblem[] {
  const { limits, totalBytes, volume, alerts } = input;
  const problems: StorageProblem[] = [];
  if (volume && limits.freeFloorBytes !== null && alerts.lowFreeSpaceSince !== null &&
    volume.freeBytes < limits.freeFloorBytes) {
    problems.push(storageProblem(
      "low-free-space",
      "volume",
      alerts.lowFreeSpaceSince,
      `The volume holding Mission Control has ${formatBytes(volume.freeBytes)} free, below your ${formatBytes(limits.freeFloorBytes)} floor.`,
      { target: "cleanup" },
    ));
  }
  const warnAt = storageWarnAtBytes(limits);
  if (warnAt !== null && limits.limitBytes !== null && totalBytes !== null &&
    alerts.storageLimitSince !== null && totalBytes >= warnAt) {
    const share = Math.round((totalBytes / limits.limitBytes) * 100);
    const message = totalBytes >= limits.limitBytes
      ? `Mission Control uses ${formatBytes(totalBytes)}, over your ${formatBytes(limits.limitBytes)} limit.`
      : `Mission Control uses ${formatBytes(totalBytes)}, ${share}% of your ${formatBytes(limits.limitBytes)} limit.`;
    problems.push(storageProblem("storage-limit", "state", alerts.storageLimitSince, message, { target: "cleanup" }));
  }
  return problems;
}

/**
 * Whether each warning's condition holds now, which is what advances `StorageAlertState`.
 * `null` is "no reading to judge": a limit is set but nothing has been measured or checked yet,
 * as right after a restart. It neither starts nor ends an occurrence, so a restart keeps the
 * one already standing under the same id. A limit that is switched off is `false`: it ends one.
 */
export function storageAlertConditions(input: {
  limits: StorageLimitsConfig;
  totalBytes: number | null;
  volume: StorageVolume | null;
}): { lowFreeSpace: boolean | null; storageLimit: boolean | null } {
  const { limits, totalBytes, volume } = input;
  const warnAt = storageWarnAtBytes(limits);
  return {
    lowFreeSpace: limits.freeFloorBytes === null
      ? false
      : volume === null ? null : volume.freeBytes < limits.freeFloorBytes,
    storageLimit: warnAt === null ? false : totalBytes === null ? null : totalBytes >= warnAt,
  };
}

/** How long a worktree return is refused before it is reported as `stuck-return` (D17). */
export const STUCK_RETURN_AFTER_MS = 60 * 60 * 1_000;

/**
 * The latest refusal of a task's or a check's worktree return, as its `last_refusal` column
 * stores it: why the return was refused, and the processes found blocking it, if any.
 */
export const WorktreeReturnRefusalSchema = z.object({
  reason: z.string(),
  processes: z.array(z.object({ pid: z.number().int(), command: z.string() })),
});

export type WorktreeReturnRefusal = z.output<typeof WorktreeReturnRefusalSchema>;

/** A stored `last_refusal`, or the raw text as the reason when it is not one this build reads. */
export function parseWorktreeReturnRefusal(stored: string): WorktreeReturnRefusal {
  try {
    const parsed = WorktreeReturnRefusalSchema.safeParse(JSON.parse(stored));
    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON at all; fall through to the raw text.
  }
  return { reason: stored, processes: [] };
}

/** One owner whose worktree return is being refused, read from its refusal columns. */
export interface RefusedWorktreeReturn {
  owner: "task" | "check";
  ownerId: string;
  /** How the message names the owner, such as `Task "Fix login"`. */
  label: string;
  firstRefusedAt: number;
  refusal: WorktreeReturnRefusal;
  /** The native slot holding the tree, or null when no slot card shows it. */
  slotId: string | null;
}

export function worktreeReturnRefusalText(refusal: WorktreeReturnRefusal): string {
  if (refusal.processes.length === 0) return refusal.reason;
  const blocking = refusal.processes.map((process) => `${process.pid} (${process.command})`).join(", ");
  return `${refusal.reason}; blocked by ${refusal.processes.length === 1 ? "process" : "processes"} ${blocking}`;
}

/**
 * `stuck-return:<task|check>:<owner id>:<first_refused_at>`, for every return refused for at
 * least `STUCK_RETURN_AFTER_MS`. The message carries the latest refusal, so the slot card that
 * shows it says why the tree is still held.
 */
export function stuckReturnProblems(
  refused: readonly RefusedWorktreeReturn[],
  now: number,
): StorageProblem[] {
  return refused
    .filter((each) => now - each.firstRefusedAt >= STUCK_RETURN_AFTER_MS)
    .map((each) => storageProblem(
      "stuck-return",
      `${each.owner}:${each.ownerId}`,
      each.firstRefusedAt,
      `${each.label} worktree return refused for over an hour: ${worktreeReturnRefusalText(each.refusal)}`,
      each.slotId ? { target: "slot", slotId: each.slotId } : { target: "worktrees" },
    ));
}

export const STORAGE_BACKUP_COPY_KINDS = ["scheduled", "preMigration", "manual"] as const;

/** One kept full-database copy, as the Storage section lists it. */
export const StorageBackupCopySchema = z.object({
  kind: z.enum(STORAGE_BACKUP_COPY_KINDS),
  filename: z.string(),
  /** The capture time its filename names. */
  at: epochMs,
  /** Its file size: what the backup limits' counts and size budget are judged by. */
  bytes: z.number().int().nonnegative(),
  /**
   * What it occupies on disk, in allocated blocks: the space deleting it frees, and the basis a
   * state-directory measurement counts in. Below `bytes` only for a sparse file.
   */
  diskBytes: z.number().int().nonnegative(),
});

export type StorageBackupCopy = z.output<typeof StorageBackupCopySchema>;

/**
 * The one storage aggregate: what the backups did, what they keep, and every current
 * problem. The `storage_health` event and `GET /api/storage` carry this same value.
 */
export const StorageHealthSchema = z.object({
  backups: z.object({
    status: DatabaseBackupStatusSchema,
    /** Newest first. */
    copies: z.array(StorageBackupCopySchema),
    totalBytes: z.number().int().nonnegative(),
  }),
  usage: StorageUsageSchema,
  /** Null until the first check, or while the volume cannot be read. */
  volume: StorageVolumeSchema.nullable(),
  /** The limits the problems were judged against, so every window shows the same thresholds. */
  limits: StorageLimitsConfigSchema,
  problems: z.array(StorageProblemSchema),
});

export type StorageHealth = z.output<typeof StorageHealthSchema>;

/** `GET /api/storage`: the aggregate plus the backup config the Backups band edits. */
export const StorageViewSchema = z.object({
  health: StorageHealthSchema,
  config: DatabaseBackupsConfigSchema,
});

export type StorageView = z.output<typeof StorageViewSchema>;

/**
 * When each problem without a timestamp of its own was first seen, keyed by subject, and when
 * it was last seen present. Operational state of this machine, never part of a snapshot.
 */
export const StorageFirstSeenSchema = z.record(
  z.string(),
  z.object({ firstSeenAt: epochMs, lastSeenAt: epochMs }),
);

export type StorageFirstSeen = z.output<typeof StorageFirstSeenSchema>;

/**
 * Each live lease's Git-visible activity clock, keyed by lease id: the digest of the slot's
 * HEAD, index, tracked changes and untracked files when last probed, and when that digest last
 * changed. A lease absent here has never been probed successfully, so it is never stale.
 * Operational state of this machine, never part of a snapshot.
 */
export const WorktreeLeaseActivitySchema = z.record(
  z.string(),
  z.object({ slotId: z.string(), digest: z.string(), changedAt: epochMs }),
);

export type WorktreeLeaseActivity = z.output<typeof WorktreeLeaseActivitySchema>;

/** One idle native slot in the idle-cache plan. */
export interface IdleCacheSlot {
  slotId: string;
  poolId: string;
  /** The repository folder the pool belongs to. */
  poolName: string;
  path: string;
  /** Measured by the last state-directory measurement, or null if it was not measured. */
  bytes: number | null;
  /** When the slot was last released, which is when it was last used. */
  lastUsedAt: number | null;
}

/** An idle slot the budget would remove but that does not pass the Safe prune bar now. */
export interface IdleCacheBlockedSlot extends IdleCacheSlot {
  reason: string;
}

export interface IdleCachePoolView {
  poolId: string;
  name: string;
  path: string;
  maxSlots: number;
  leased: number;
  idle: number;
  quarantined: number;
  /** Provisioning, returning or pruning: on its way in or out. */
  other: number;
  bytes: number | null;
  /** The measured idle slots' bytes. A lower bound while `unmeasuredIdle` is above 0. */
  idleBytes: number;
  /** Idle slots the last measurement did not size. */
  unmeasuredIdle: number;
  /** Idle slots the plan removes from this pool, and their size. */
  remove: number;
  removeBytes: number;
  blocked: number;
}

/**
 * What the idle-cache budget would remove right now: `GET /api/storage/pool-caches`. Read on
 * demand because it observes every slot through Git, and never acted on by itself.
 *
 * Within each pool the `keepWarm` most recently used idle slots stay. The rest are taken least
 * recently used first, across pools, until the idle total fits the budget. A slot that does
 * not pass the Safe prune bar is listed under `blocked` with its reason and skipped; so is one
 * the last measurement did not size, since removing it proves nothing against the budget.
 */
export interface IdleCachePlan {
  observedAt: number;
  /** When the slot sizes were measured, or null when nothing has been measured yet. */
  sizesMeasuredAt: number | null;
  budgetBytes: number | null;
  keepWarm: number;
  pools: IdleCachePoolView[];
  /** The measured idle slots' bytes. A lower bound while `unmeasuredIdle` is above 0. */
  idleBytes: number;
  /**
   * Idle slots, warm ones included, that the last measurement did not size. While any remain,
   * whether the idle caches fit the budget is unknown, and the page says so rather than reporting
   * a fit it cannot know.
   */
  unmeasuredIdle: number;
  /** Least recently used first. */
  remove: IdleCacheSlot[];
  blocked: IdleCacheBlockedSlot[];
  freesBytes: number;
  /** A lower bound while `unmeasuredIdle` is above 0. */
  afterIdleBytes: number;
  untouched: {
    leased: number;
    leasedBytes: number;
    quarantined: number;
    quarantinedBytes: number;
    warm: number;
    warmBytes: number;
  };
}

/** Why the pool-cache plan could not be built, as `GET /api/storage/pool-caches` answers it. */
export interface IdleCachePlanUnavailable {
  error: "worktrees_unavailable";
  message: string;
}
