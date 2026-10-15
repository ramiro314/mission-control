import type { UpdateTestingSettings } from "@shared/protocol.ts";
import type { StoredTestingSettings, TestingSettingsView } from "@shared/testing-config.ts";
import { realpathOr } from "./util/repo-doc.ts";
import type { TestingSettingsStoreWrite, WorkflowStore } from "./workflows/store.ts";

// Stored testing settings: the affected-tests selection keys a repository can have without
// committing `.mission/testing.json`, edited on the affected-tests page of Library › Commands.
//
// The rows live in the workflow store's connection, beside the Command catalog they configure,
// so a settings backup captures and restores them in the same transaction as the Commands. This
// module is the one place the route and the check runtime reach them: the route writes through
// `replace`, and the affected-tests gate reads a repository root's row through `forRepoRoot`.
//
// No server event: the only surface that edits them reads them over HTTP when it opens and
// learns of another window's save from the 409 compare-and-swap refusal.

export class TestingSettingsCatalog {
  constructor(readonly store: WorkflowStore) {}

  list(): TestingSettingsView[] {
    return this.store.listTestingSettings();
  }

  /**
   * The settings stored for a repository root, or null.
   *
   * A row is keyed by the main checkout's canonical path, which is what a task's repository
   * already is. A caller holding the path as spelled through a symlink still finds its row, by
   * asking again under the realpath.
   */
  forRepoRoot(repoRoot: string): StoredTestingSettings | null {
    const exact = this.store.getTestingSettings(repoRoot);
    if (exact) return exact.settings;
    const canonical = realpathOr(repoRoot);
    return canonical === repoRoot ? null : this.store.getTestingSettings(canonical)?.settings ?? null;
  }

  /** Replace one row under its expected revision. The route has validated and resolved the path. */
  replace(input: UpdateTestingSettings, now = Date.now()): TestingSettingsStoreWrite {
    return this.store.replaceTestingSettingsCas(input.repoRoot, input.expectedRevision, input.settings, now);
  }
}
