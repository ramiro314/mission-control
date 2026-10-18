import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  COMMAND_DOCUMENT_VERSION,
  canonicalTestingSettings,
  commandDocumentPathLabel,
  type CommandDocument,
  type CommandDocumentBasis,
  type CommandDocumentCommandChange,
  type CommandDocumentPreview,
  type CommandDocumentTestingChange,
} from "@shared/command-document.ts";
import { storedTestingSettingsKeys, type StoredTestingSettings, type TestingSettingsView } from "@shared/testing-config.ts";
import {
  WORKFLOW_CHECK_SLOTS,
  WORKFLOW_LIMITS,
  type WorkflowCheckSlot,
  type WorkflowCommandOverride,
  type WorkflowCommandView,
} from "@shared/workflow.ts";
import { crossesRepositoryBoundary, type TestingSettingsCatalog } from "./testing-settings.ts";
import { realpathOr } from "./util/repo-doc.ts";
import {
  WorkflowCommandsTogetherConflict,
  type WorkflowCommandManager,
  type WorkflowCommandOverridesWrite,
} from "./workflows/commands.ts";

// Command documents: one repository's Command overrides and stored testing settings, previewed,
// applied in one transaction, and exported back out (`src/shared/command-document.ts` holds the
// format). Nothing here owns a row. Commands are written through `WorkflowCommandManager`, which
// keeps each slot's compare-and-swap and its one event per committed slot, and testing settings
// through the store's own compare-and-swap - both on the one workflow store connection, so a
// document lands whole or not at all.
//
// A repository's rows are found the way the gate finds them: a row is this repository's when it
// is keyed at the main checkout or a folder below it (under either spelling of the root) and no
// folder on the way holds a `.git`, because a nested repository or submodule owns its own rows.

/** One of this repository's rows in a slot: the folder it applies to and the key it is stored under. */
interface CommandRow {
  key: string;
  command: string[];
}

interface SlotState {
  view: WorkflowCommandView;
  /** This repository's rows, by repository-relative path. */
  rows: Map<string, CommandRow>;
}

/** What is stored for one repository, as a document is merged against it. */
export interface CommandDocumentState {
  repoRoot: string;
  slots: Map<WorkflowCheckSlot, SlotState>;
  /** Every testing row of this repository, by path, including rows that set no key. */
  testing: Map<string, TestingSettingsView>;
}

/** Why a path cannot take a new or changed row in this repository, or null when it can. */
export type FolderProblem = (path: string) => string | null;

export interface CommandDocumentPlan {
  preview: CommandDocumentPreview;
  commandWrites: WorkflowCommandOverridesWrite[];
  testingWrites: Array<{ key: string; expectedRevision: number; settings: StoredTestingSettings }>;
}

function scopeOf(roots: readonly string[], key: string): string | null {
  for (const root of roots) {
    if (key === root) return "";
    if (key.startsWith(`${root}/`)) {
      const scope = key.slice(root.length + 1);
      if (!crossesRepositoryBoundary(root, scope)) return scope;
    }
  }
  return null;
}

/** Read what one repository has stored, in every slot and in the testing catalog. */
export function commandDocumentState(
  repoRoot: string,
  commands: Pick<WorkflowCommandManager, "list">,
  testing: Pick<TestingSettingsCatalog, "rowsForRepository">,
): CommandDocumentState {
  const roots = [...new Set([repoRoot, realpathOr(repoRoot)])];
  const slots = new Map<WorkflowCheckSlot, SlotState>();
  for (const view of commands.list()) {
    const rows = new Map<string, CommandRow>();
    for (const override of view.overrides) {
      const scope = scopeOf(roots, override.repoRoot);
      if (scope !== null && !rows.has(scope)) rows.set(scope, { key: override.repoRoot, command: override.command });
    }
    slots.set(view.slot, { view, rows });
  }
  return {
    repoRoot,
    slots,
    testing: new Map(testing.rowsForRepository(repoRoot).map(({ scope, view }) => [scope, view])),
  };
}

function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((arg, index) => arg === b[index]);
}

function sameSettings(a: StoredTestingSettings, b: StoredTestingSettings): boolean {
  return JSON.stringify(canonicalTestingSettings(a)) === JSON.stringify(canonicalTestingSettings(b));
}

function byPath<T extends { path: string }>(a: T, b: T): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** The key a new row at `path` is stored under: the main checkout, or a folder below it. */
function keyFor(repoRoot: string, path: string): string {
  return path === "" ? repoRoot : `${repoRoot}/${path}`;
}

/**
 * Merge a document with what is stored: the preview an operator reviews, and the writes apply
 * makes. Pure, so the merge rules are tested without a database.
 *
 * - A row the document does not mention is untouched, in this repository and every other.
 * - A listed row is added or replaced; an entry matching what is stored is unchanged.
 * - Only a `remove` entry removes, and removing a row that is not there changes nothing.
 * - A slot that would end up over its override cap, and a new or changed row at a path that is
 *   not a folder of this repository, are problems: the preview lists them and apply refuses.
 */
export function planCommandDocument(
  document: CommandDocument,
  state: CommandDocumentState,
  folderProblem: FolderProblem,
): CommandDocumentPlan {
  const commands: CommandDocumentCommandChange[] = [];
  const testing: CommandDocumentTestingChange[] = [];
  const problems: string[] = [];
  const basis: CommandDocumentBasis = { commands: {}, testing: {} };
  const commandWrites: WorkflowCommandOverridesWrite[] = [];
  const testingWrites: CommandDocumentPlan["testingWrites"] = [];
  let unchanged = 0;
  const checkFolder = (where: string, path: string): void => {
    const problem = folderProblem(path);
    if (problem) problems.push(`${where} · ${commandDocumentPathLabel(path)}: ${problem}`);
  };

  for (const slot of WORKFLOW_CHECK_SLOTS) {
    const entries = document.commands?.[slot];
    if (entries === undefined) continue;
    const slotState = state.slots.get(slot);
    if (!slotState) {
      problems.push(`${slot}: the Command catalog has no such slot`);
      continue;
    }
    basis.commands[slot] = slotState.view.revision;
    // The slot's whole list, other repositories' rows included, keyed by stored key.
    const next = new Map<string, string[]>(slotState.view.overrides.map((entry) => [entry.repoRoot, entry.command]));
    const changes: CommandDocumentCommandChange[] = [];
    for (const entry of entries) {
      const existing = slotState.rows.get(entry.path) ?? null;
      if (entry.remove) {
        if (!existing) {
          unchanged += 1;
          continue;
        }
        next.delete(existing.key);
        changes.push({ slot, path: entry.path, kind: "remove", before: existing.command, after: null });
        continue;
      }
      const argv = entry.argv!;
      if (existing && sameArgv(existing.command, argv)) {
        unchanged += 1;
        continue;
      }
      checkFolder(slot, entry.path);
      next.set(existing?.key ?? keyFor(state.repoRoot, entry.path), argv);
      changes.push({ slot, path: entry.path, kind: existing ? "change" : "add", before: existing?.command ?? null, after: argv });
    }
    if (changes.length === 0) continue;
    if (next.size > WORKFLOW_LIMITS.commandOverrides) {
      problems.push(
        `${slot}: would hold ${next.size} overrides across every repository, and a Command holds at most `
          + `${WORKFLOW_LIMITS.commandOverrides}`,
      );
    }
    commands.push(...changes.sort(byPath));
    const overrides: WorkflowCommandOverride[] = [...next]
      .map(([repoRoot, command]) => ({ repoRoot, command }))
      .sort((a, b) => (a.repoRoot < b.repoRoot ? -1 : a.repoRoot > b.repoRoot ? 1 : 0));
    commandWrites.push({ slot, expectedRevision: slotState.view.revision, overrides });
  }

  for (const entry of document.testing ?? []) {
    const existing = state.testing.get(entry.path) ?? null;
    basis.testing[entry.path] = existing?.revision ?? 0;
    const stored = existing && storedTestingSettingsKeys(existing.settings).length > 0
      ? canonicalTestingSettings(existing.settings)
      : null;
    const key = existing?.repoRoot ?? keyFor(state.repoRoot, entry.path);
    const expectedRevision = existing?.revision ?? 0;
    if (entry.remove) {
      if (!stored) {
        unchanged += 1;
        continue;
      }
      // A row is never deleted, only emptied, so a window holding its old revision is still refused.
      testingWrites.push({ key, expectedRevision, settings: {} });
      testing.push({ path: entry.path, kind: "remove", before: stored, after: null });
      continue;
    }
    const settings = canonicalTestingSettings(entry.settings!);
    if (stored && sameSettings(stored, settings)) {
      unchanged += 1;
      continue;
    }
    checkFolder("testing", entry.path);
    testingWrites.push({ key, expectedRevision, settings });
    testing.push({ path: entry.path, kind: stored ? "change" : "add", before: stored, after: settings });
  }
  testing.sort(byPath);

  return {
    preview: { repoRoot: state.repoRoot, commands, testing, unchanged, problems, basis },
    commandWrites,
    testingWrites,
  };
}

/**
 * Whether a folder of this repository can take a new or changed row: it exists in the main
 * checkout, is reached by its own path rather than through a symlink (rows are keyed by
 * canonical path, and a row under another spelling would never be found), and is not inside a
 * nested repository or submodule, which owns its own rows. The root always can.
 */
export function repositoryFolderProblem(repoRoot: string): FolderProblem {
  const canonicalRoot = realpathOr(repoRoot);
  return (path) => {
    if (path === "") return null;
    let real: string;
    try {
      real = realpathSync(join(repoRoot, path));
    } catch {
      return "no such folder in this repository";
    }
    if (!statSync(real).isDirectory()) return "not a folder";
    if (real !== join(canonicalRoot, path)) {
      return "reached through a symlink; name the folder by its own path";
    }
    if (crossesRepositoryBoundary(repoRoot, path)) {
      return "inside a nested repository or submodule, which keeps its own rows";
    }
    return null;
  };
}

/** A repository's stored rows as a document: importing it back changes nothing. */
export function exportCommandDocument(state: CommandDocumentState): CommandDocument {
  const commands: NonNullable<CommandDocument["commands"]> = {};
  for (const slot of WORKFLOW_CHECK_SLOTS) {
    const rows = [...(state.slots.get(slot)?.rows ?? new Map<string, CommandRow>())]
      .map(([path, row]) => ({ path, argv: [...row.command] }))
      .sort(byPath);
    if (rows.length > 0) commands[slot] = rows;
  }
  const testing = [...state.testing]
    .filter(([, view]) => storedTestingSettingsKeys(view.settings).length > 0)
    .map(([path, view]) => ({ path, settings: canonicalTestingSettings(view.settings) }))
    .sort(byPath);
  return { version: COMMAND_DOCUMENT_VERSION, commands, testing };
}

function sameBasis(a: CommandDocumentBasis, b: CommandDocumentBasis): boolean {
  const same = (x: Record<string, number | undefined>, y: Record<string, number | undefined>): boolean => {
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    return [...keys].every((key) => x[key] === y[key]);
  };
  return same(a.commands, b.commands) && same(a.testing, b.testing);
}

export type CommandDocumentApplyResult =
  | { kind: "applied"; preview: CommandDocumentPreview }
  | { kind: "stale"; preview: CommandDocumentPreview }
  | { kind: "invalid"; preview: CommandDocumentPreview };

/**
 * The one place a document is read against, and written to, both catalogs. Both must be on one
 * store connection: two connections are two transactions, and a document could land half.
 */
export class CommandDocuments {
  constructor(
    private readonly commands: WorkflowCommandManager,
    private readonly testing: TestingSettingsCatalog,
    private readonly folderProblem: (repoRoot: string) => FolderProblem = repositoryFolderProblem,
  ) {
    if (commands.store !== testing.store) {
      throw new Error("Command documents need the Commands and testing settings catalogs on one store");
    }
  }

  state(repoRoot: string): CommandDocumentState {
    return commandDocumentState(repoRoot, this.commands, this.testing);
  }

  preview(repoRoot: string, document: CommandDocument): CommandDocumentPreview {
    return planCommandDocument(document, this.state(repoRoot), this.folderProblem(repoRoot)).preview;
  }

  export(repoRoot: string): CommandDocument {
    return exportCommandDocument(this.state(repoRoot));
  }

  /**
   * Apply a document the operator previewed against `basis`.
   *
   * Recomputed from what is stored now, and refused as stale, with the fresh preview, when any
   * slot or testing row the document names has moved since: the operator applies what they
   * reviewed or nothing. Every write then goes through its catalog's compare-and-swap inside
   * one transaction, so a write that loses a race rolls the whole document back as stale.
   *
   * `alongside` runs last inside that same transaction, on this store's connection: clearing the
   * pending proposal a document was applied from is written with the document or not at all. It
   * runs in a transaction of its own when the document changes nothing, and never when the apply
   * is refused. An error it throws rolls every write back and propagates.
   */
  apply(
    repoRoot: string,
    document: CommandDocument,
    basis: CommandDocumentBasis,
    now = Date.now(),
    alongside: () => void = () => undefined,
  ): CommandDocumentApplyResult {
    const plan = planCommandDocument(document, this.state(repoRoot), this.folderProblem(repoRoot));
    if (!sameBasis(plan.preview.basis, basis)) return { kind: "stale", preview: plan.preview };
    if (plan.preview.problems.length > 0) return { kind: "invalid", preview: plan.preview };
    if (plan.commandWrites.length === 0 && plan.testingWrites.length === 0) {
      this.testing.store.transact(alongside);
      return { kind: "applied", preview: plan.preview };
    }
    const result = this.commands.replaceOverridesTogether(plan.commandWrites, () => {
      for (const write of plan.testingWrites) {
        const written = this.testing.store.replaceTestingSettingsCas(write.key, write.expectedRevision, write.settings, now);
        if (!written.ok) throw new WorkflowCommandsTogetherConflict(`the testing settings for ${write.key}`);
      }
      alongside();
    }, now);
    if (!result.ok) return { kind: "stale", preview: this.preview(repoRoot, document) };
    return { kind: "applied", preview: plan.preview };
  }
}
