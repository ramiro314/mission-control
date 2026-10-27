import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  databaseBackupsConfigFrom,
  DatabaseBackupsConfigSchema,
  type DatabaseBackupsConfig,
  type DatabaseBackupsConfigPatch,
} from "@shared/database-backups.ts";
import { getAppConfig, setAppConfig } from "../db.ts";
import type { DatabaseBackupService } from "./service.ts";

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.backups;

/** The current config, with defaults for anything missing or malformed. */
export function getDatabaseBackupsConfig(): DatabaseBackupsConfig {
  return databaseBackupsConfigFrom(getAppConfig(CONFIG_ENTRY));
}

/**
 * Merge a patch over the current config, persist it, and prune at once, so a lowered count
 * frees its copies on save rather than at the next capture.
 */
export function setDatabaseBackupsConfig(
  patch: DatabaseBackupsConfigPatch,
  backups: Pick<DatabaseBackupService, "prune">,
): DatabaseBackupsConfig {
  const next = DatabaseBackupsConfigSchema.parse({ ...getDatabaseBackupsConfig(), ...patch });
  setAppConfig(CONFIG_ENTRY, next);
  backups.prune();
  return next;
}
