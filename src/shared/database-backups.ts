import { z } from "zod";

/** The capture intervals an operator may choose, in hours. */
export const DATABASE_BACKUP_INTERVAL_HOURS = [1, 3, 6, 12, 24] as const;

const scheduledCount = z.number().int().min(1).max(48);
const preMigrationCount = z.number().int().min(1).max(10);
const intervalHours = z.union([
  z.literal(1),
  z.literal(3),
  z.literal(6),
  z.literal(12),
  z.literal(24),
]);

/**
 * How many full-database recovery points of each kind are kept, and how often a scheduled one
 * is taken. A count is never 0: every kind always keeps its newest copy. The `manual` kind is
 * not here because it always keeps exactly one copy.
 */
export const DatabaseBackupsConfigSchema = z.object({
  scheduledCount: scheduledCount.default(3),
  preMigrationCount: preMigrationCount.default(2),
  intervalHours: intervalHours.default(1),
});

export type DatabaseBackupsConfig = z.output<typeof DatabaseBackupsConfigSchema>;

export const DatabaseBackupsConfigPatchSchema = z
  .object({ scheduledCount, preMigrationCount, intervalHours })
  .partial()
  .strict();

export type DatabaseBackupsConfigPatch = z.output<typeof DatabaseBackupsConfigPatchSchema>;

export const DEFAULT_DATABASE_BACKUPS_CONFIG: Readonly<DatabaseBackupsConfig> = Object.freeze(
  DatabaseBackupsConfigSchema.parse({}),
);

/**
 * A stored value as the config it means. Anything missing or malformed reads as the default,
 * so a bad row can never block startup or stop a prune.
 */
export function databaseBackupsConfigFrom(stored: unknown): DatabaseBackupsConfig {
  const parsed = DatabaseBackupsConfigSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : { ...DEFAULT_DATABASE_BACKUPS_CONFIG };
}
