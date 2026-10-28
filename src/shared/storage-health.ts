import { z } from "zod";
import {
  DatabaseBackupsConfigSchema,
  DatabaseBackupStatusSchema,
  RECORDED_DATABASE_BACKUP_KINDS,
  type DatabaseBackupStatus,
} from "./database-backups.ts";

/**
 * Every kind of storage problem the daemon can report. Settings > Storage lists each one;
 * `STORAGE_PROBLEM_BANNERED` decides which also raise the dashboard banner.
 */
export const STORAGE_PROBLEM_KINDS = [
  "backup-failed",
  "stuck-return",
  "quarantined-slot",
  "orphan-process",
  "dirty-orphan-folder",
  "dirty-settled-tree",
  "stale-lease",
] as const;

export type StorageProblemKind = (typeof STORAGE_PROBLEM_KINDS)[number];

/**
 * Which kinds raise the banner (D25). A dirty settled task tree and a stale live lease are
 * kept by policy rather than by a fault, so they are listed in Storage only.
 */
export const STORAGE_PROBLEM_BANNERED: Readonly<Record<StorageProblemKind, boolean>> = {
  "backup-failed": true,
  "stuck-return": true,
  "quarantined-slot": true,
  "orphan-process": true,
  "dirty-orphan-folder": true,
  "dirty-settled-tree": false,
  "stale-lease": false,
};

/** Where a problem's fix lives: Storage's own Backups band, a slot card, or an unowned tree. */
export const StorageProblemLinkSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("backups") }),
  z.object({ target: z.literal("slot"), slotId: z.string().min(1) }),
  z.object({ target: z.literal("unowned-tree"), path: z.string().min(1) }),
  /** A tree with no slot card of its own, such as one a non-native provider holds. */
  z.object({ target: z.literal("worktrees") }),
]);

export type StorageProblemLink = z.output<typeof StorageProblemLinkSchema>;

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
  bannered: z.boolean(),
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
  bytes: z.number().int().nonnegative(),
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
