import { useCallback, useEffect, useState } from "react";
import type { DatabaseBackupsConfigPatch } from "@shared/database-backups.ts";
import type { StorageView } from "@shared/storage-health.ts";
import { api, fetchStorage } from "./lib/api.ts";

// Settings > Storage. The live aggregate arrives over SSE as `storage_health`; this hook owns
// only what the event does not carry - the backup config - and the two writes. It reads the
// route once on open, and again after each write, so the page is right even while the stream
// is down. That read recomputes on the daemon, which is also what publishes a fresh event.

export interface StorageState {
  /** The last `GET /api/storage` answer, or null before it lands. */
  view: StorageView | null;
  loadError: string | null;
  saving: boolean;
  backingUp: boolean;
  /** Why the last write failed, or null. Cleared by the next one that succeeds. */
  error: string | null;
  /** What the last write did, or null. */
  notice: string | null;
}

export interface StorageActions {
  save: (patch: DatabaseBackupsConfigPatch) => Promise<boolean>;
  backUpNow: () => Promise<void>;
}

function failure(result: { error?: string; message?: string }): string {
  return result.message ?? result.error ?? "The daemon refused the request.";
}

export function useStorage(): StorageState & StorageActions {
  const [view, setView] = useState<StorageView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const next = await fetchStorage();
    if (next) {
      setView(next);
      setLoadError(null);
    } else {
      setLoadError("Storage status could not be loaded from the daemon.");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(async (patch: DatabaseBackupsConfigPatch): Promise<boolean> => {
    setSaving(true);
    try {
      const result = await api.setDatabaseBackupsConfig(patch);
      if (!result.ok) {
        setError(`Backup settings were not saved: ${failure(result)}`);
        setNotice(null);
        return false;
      }
      setError(null);
      setNotice("Backup settings saved. Copies above the new counts were removed.");
      await reload();
      return true;
    } finally {
      setSaving(false);
    }
  }, [reload]);

  const backUpNow = useCallback(async (): Promise<void> => {
    setBackingUp(true);
    try {
      const result = await api.backUpDatabase();
      if (result.ok) {
        setError(null);
        setNotice("Backup taken. The newest manual copy replaces the previous one.");
      } else {
        setError(failure(result));
        setNotice(null);
      }
      await reload();
    } finally {
      setBackingUp(false);
    }
  }, [reload]);

  return { view, loadError, saving, backingUp, error, notice, save, backUpNow };
}
