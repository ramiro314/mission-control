import type { UpdateTestingSettings } from "@shared/protocol.ts";
import {
  testingScopePath,
  type StoredTestingLayer,
  type StoredTestingSettings,
  type TestingSettingsView,
} from "@shared/testing-config.ts";
import { realpathOr } from "./util/repo-doc.ts";
import type { TestingSettingsStoreWrite, WorkflowStore } from "./workflows/store.ts";

// Stored testing settings: the affected-tests selection keys a repository can have without
// committing `.mission/testing.json`, edited on the affected-tests page of Library › Commands.
//
// The rows live in the workflow store's connection, beside the Command catalog they configure,
// so a settings backup captures and restores them in the same transaction as the Commands. This
// module is the one place the route and the check runtime reach them: the route writes through
// `replace`, and the affected-tests gate reads a repository's rows, its root's and every
// subdirectory's, through `forRepository`.
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

  /**
   * Every row stored for a repository, as layers: the root's with scope `""`, and each
   * subdirectory's with its repository-relative path, sorted by scope.
   *
   * Rows are keyed by canonical path, the main checkout's realpath or a subdirectory below it.
   * A caller holding the root as spelled through a symlink still finds them, by also matching
   * under the realpath, and a row both spellings reach is returned once.
   */
  forRepository(repoRoot: string): StoredTestingLayer[] {
    const roots = [...new Set([repoRoot, realpathOr(repoRoot)])];
    const layers = new Map<string, StoredTestingLayer>();
    for (const view of this.store.listTestingSettings()) {
      for (const root of roots) {
        const scope = view.repoRoot === root
          ? ""
          : view.repoRoot.startsWith(`${root}/`) ? testingScopePath(view.repoRoot.slice(root.length + 1)) : null;
        if (scope === null || layers.has(scope)) continue;
        layers.set(scope, { settings: view.settings, scope });
      }
    }
    return [...layers.values()].sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
  }

  /** Replace one row under its expected revision. The route has validated and resolved the path. */
  replace(input: UpdateTestingSettings, now = Date.now()): TestingSettingsStoreWrite {
    return this.store.replaceTestingSettingsCas(input.repoRoot, input.expectedRevision, input.settings, now);
  }
}
