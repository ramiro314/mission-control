import { useEffect, useState } from "react";
import type { StorageHealth } from "@shared/storage-health.ts";
import {
  dismissStorageProblems,
  observeStorageProblems,
  readStorageDismissals,
  subscribeStorageDismissals,
  undismissedStorageProblems,
  updateStorageDismissals,
  type StorageDismissals,
} from "../lib/storageBannerDismissals.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The dashboard's storage warning (D15): shown while any bannered problem is one this viewer
 * has not dismissed, linking to Settings > Storage. `health` is `MissionState.storageHealth`,
 * which the reconnect snapshot and every `storage_health` event replace whole.
 */
export function StorageBanner({ health }: { health: StorageHealth | null }): React.JSX.Element | null {
  const [dismissals, setDismissals] = useState<StorageDismissals>(readStorageDismissals);

  // Another tab's dismissal hides the banner here too.
  useEffect(() => subscribeStorageDismissals(() => setDismissals(readStorageDismissals())), []);

  // Before the first aggregate there is nothing to judge absence against, so no entry ages.
  useEffect(() => {
    if (!health) return;
    const present = health.problems.map((problem) => problem.id);
    setDismissals(updateStorageDismissals((entries) => observeStorageProblems(entries, present, Date.now())));
  }, [health]);

  const problems = undismissedStorageProblems(health, dismissals);
  if (problems.length === 0) return null;

  const summary = problems.length === 1
    ? problems[0]!.message
    : `${problems.length} storage problems need attention.`;

  return (
    <section className="app-banner app-banner-error" role="status" aria-label="Storage needs attention">
      <div className="app-banner-copy">
        <strong>{summary}</strong>
        <p>Settings &gt; Storage lists each problem and links to where it is fixed.</p>
      </div>
      <div className="app-banner-actions">
        <Tooltip label="Open Settings > Storage">
          <a className="btn btn-primary" href="#/settings/storage">Open Storage</a>
        </Tooltip>
        <Tooltip label="Hide this warning until a new storage problem appears">
          <button
            type="button"
            className="btn btn-ghost"
            aria-label="Dismiss storage warning"
            onClick={() => setDismissals(updateStorageDismissals((entries) =>
              dismissStorageProblems(entries, problems.map((problem) => problem.id), Date.now())))}
          >
            Dismiss
          </button>
        </Tooltip>
      </div>
    </section>
  );
}
