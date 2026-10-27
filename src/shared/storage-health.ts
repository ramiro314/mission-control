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
]);

export type StorageProblemLink = z.output<typeof StorageProblemLinkSchema>;

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
