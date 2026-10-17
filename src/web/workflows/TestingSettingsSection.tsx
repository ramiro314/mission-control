import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  StoredTestingSettingsSchema,
  TESTING_CONFIG_PATH,
  TESTING_LOCAL_CONFIG_PATH,
  type StoredTestingSettings,
  type TestingSettingsView,
} from "@shared/testing-config.ts";
import { resolveRepo } from "../lib/api.ts";
import { RepoCombobox } from "../components/RepoCombobox.tsx";
import { RepositoryName } from "../components/RepositoryName.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { workflowRequest, WorkflowApiError } from "./workflowApi.ts";

/**
 * The "Testing settings" section of the affected-tests page in Library › Commands.
 *
 * It edits STORED testing settings: `tests.patterns`, `tests.includeImporters` and
 * `tests.smokeSet`, kept in Mission Control for a repository that will not commit
 * `.mission/testing.json`. At a repository root they overlay the committed file key by key, and
 * the local file overlays them, so the order is committed, then stored, then local. A row for a
 * subdirectory (one app of a monorepo) is a scope: its keys replace the root's for the files
 * inside it, its globs are relative to it, and a key it leaves to Inherit falls through.
 *
 * One row per path that has stored settings or an affected-tests override, the root and every
 * subdirectory, plus an add row for a path that has neither. Each row saves on its own, under the
 * revision it loaded; a save another window beat is refused with 409 and the row reloads what is
 * stored. The rows are read over HTTP when the section opens: nothing else edits them, and the
 * refusal is how this window learns of another one.
 */

/**
 * Whether a list key is stored by this row. `inherit` leaves the key unset, so the committed
 * file or the default decides (the root's settings, for a subdirectory row); `set` stores the
 * typed list, and a `set` list with no globs stores an empty list - which REPLACES the inherited
 * one, the way the local file can.
 */
export type TestingListMode = "inherit" | "set";

/** A row as typed. A list field is one glob per line. */
export interface TestingSettingsDraft {
  patternsMode: TestingListMode;
  patterns: string;
  includeImporters: "inherit" | "on" | "off";
  smokeSetMode: TestingListMode;
  smokeSet: string;
}

/** Where a row's path sits: its repository, and the subdirectory inside it (`""` at the root). */
export interface TestingSettingsLocation {
  repoRoot: string;
  subpath: string;
}

/** A resolved path as a location, or null when the daemon's answer does not place it in its repository. */
export function testingSettingsLocationOf(resolved: { repoRoot: string; path: string }): TestingSettingsLocation | null {
  if (resolved.path === resolved.repoRoot) return { repoRoot: resolved.repoRoot, subpath: "" };
  const prefix = `${resolved.repoRoot}/`;
  return resolved.path.startsWith(prefix)
    ? { repoRoot: resolved.repoRoot, subpath: resolved.path.slice(prefix.length) }
    : null;
}

/**
 * The rows in display order: grouped by repository, the root before its subdirectories. A path
 * whose repository could not be resolved (its folder is gone) sorts by its own path.
 */
export function testingSettingsRowOrder(
  paths: readonly string[],
  locations: ReadonlyMap<string, TestingSettingsLocation | null>,
): string[] {
  const keyOf = (path: string): [string, string] => {
    const location = locations.get(path);
    return location ? [location.repoRoot, location.subpath] : [path, ""];
  };
  return [...new Set(paths)].sort((a, b) => {
    const [ra, sa] = keyOf(a);
    const [rb, sb] = keyOf(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}

export function testingSettingsDraftFrom(view: TestingSettingsView | null): TestingSettingsDraft {
  const tests = view?.settings.tests ?? {};
  return {
    patternsMode: tests.patterns === undefined ? "inherit" : "set",
    patterns: (tests.patterns ?? []).join("\n"),
    includeImporters: tests.includeImporters === undefined ? "inherit" : tests.includeImporters ? "on" : "off",
    smokeSetMode: tests.smokeSet === undefined ? "inherit" : "set",
    smokeSet: (tests.smokeSet ?? []).join("\n"),
  };
}

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

/**
 * Typing into a list sets it: a glob typed under Inherit would otherwise be silently dropped
 * on save. Emptying the field does NOT switch back to Inherit, because an empty list is a
 * meaningful value; choosing Inherit is how the key is unset.
 */
export function testingSettingsDraftTyped(
  draft: TestingSettingsDraft,
  key: "patterns" | "smokeSet",
  text: string,
): TestingSettingsDraft {
  const mode = key === "patterns" ? "patternsMode" : "smokeSetMode";
  return { ...draft, [key]: text, [mode]: text.trim() === "" ? draft[mode] : "set" };
}

/** The draft as the settings the route takes, or the schema's first refusal as one sentence. */
export function testingSettingsFromDraft(
  draft: TestingSettingsDraft,
): { ok: true; settings: StoredTestingSettings } | { ok: false; error: string } {
  const tests: Record<string, unknown> = {};
  if (draft.patternsMode === "set") tests.patterns = lines(draft.patterns);
  if (draft.includeImporters !== "inherit") tests.includeImporters = draft.includeImporters === "on";
  if (draft.smokeSetMode === "set") tests.smokeSet = lines(draft.smokeSet);
  const parsed = StoredTestingSettingsSchema.safeParse(Object.keys(tests).length > 0 ? { tests } : {});
  if (parsed.success) return { ok: true, settings: parsed.data };
  const issue = parsed.error.issues[0]!;
  return { ok: false, error: `tests.${issue.path.slice(1).join(".")}: ${issue.message}` };
}

export function testingSettingsDraftDirty(draft: TestingSettingsDraft, view: TestingSettingsView | null): boolean {
  const stored = testingSettingsDraftFrom(view);
  return draft.patternsMode !== stored.patternsMode
    || (draft.patternsMode === "set" && lines(draft.patterns).join("\n") !== stored.patterns)
    || draft.includeImporters !== stored.includeImporters
    || draft.smokeSetMode !== stored.smokeSetMode
    || (draft.smokeSetMode === "set" && lines(draft.smokeSet).join("\n") !== stored.smokeSet);
}

/** The revision line under a row's path. */
export function testingSettingsRevisionLine(view: TestingSettingsView | null): string {
  if (!view) return "Nothing stored yet";
  return `Stored revision ${view.revision}`;
}

/** What a row's glob lists are relative to, and where Inherit takes a key from. */
export function testingSettingsRowScope(location: TestingSettingsLocation | null): {
  globsRelativeTo: string;
  inheritFrom: string;
} {
  if (location && location.subpath !== "") {
    return { globsRelativeTo: location.subpath, inheritFrom: "the repository root's settings" };
  }
  return { globsRelativeTo: "the repository", inheritFrom: "the committed file or the default" };
}

export function TestingSettingsSection({
  overrideRoots,
  repos,
  onDirtyChange,
}: {
  /** The affected-tests slot's stored override paths, as the catalog holds them. */
  overrideRoots: readonly string[];
  /** Repositories to offer in the add row. */
  repos: string[];
  onDirtyChange: (dirty: boolean) => void;
}): React.JSX.Element {
  const [stored, setStored] = useState<TestingSettingsView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Override paths that resolved, canonical: a repository root or a subdirectory inside one. */
  const [overridePaths, setOverridePaths] = useState<string[]>([]);
  /** Paths the operator added in this visit that have nothing stored yet. */
  const [added, setAdded] = useState<string[]>([]);
  /** Each row path's repository and subdirectory, once resolved; null when it does not resolve. */
  const [locations, setLocations] = useState<ReadonlyMap<string, TestingSettingsLocation | null>>(() => new Map());
  const [addPath, setAddPath] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const dirtyRows = useRef(new Set<string>());
  /** The add row's box, so the Escape the combobox swallows can hand the caret back, as on the rules table. */
  const addRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setStored(await workflowRequest<TestingSettingsView[]>("/api/testing-settings"));
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "Could not load testing settings");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const remember = useCallback((entries: ReadonlyArray<readonly [string, TestingSettingsLocation | null]>): void => {
    setLocations((current) => {
      const next = new Map(current);
      for (const [path, location] of entries) next.set(path, location);
      return next;
    });
  }, []);

  // Every override path gets a row, the root's and each subdirectory's, under its canonical
  // spelling: the key a stored row for it is saved by. A path that no longer resolves has none.
  const overrideKey = overrideRoots.join("\n");
  useEffect(() => {
    let alive = true;
    void Promise.all(overrideKey.split("\n").filter(Boolean).map(async (path) => {
      const resolved = await resolveRepo(path);
      return resolved.ok ? resolved : null;
    })).then((results) => {
      if (!alive) return;
      const found = results.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      setOverridePaths(found.map((entry) => entry.path));
      remember(found.map((entry) => [entry.path, testingSettingsLocationOf(entry)] as const));
    });
    return () => { alive = false; };
  }, [overrideKey, remember]);

  const byRoot = useMemo(() => new Map((stored ?? []).map((view) => [view.repoRoot, view])), [stored]);

  // Where each stored row sits, so a subdirectory row can say which repository it belongs to.
  const storedKey = [...byRoot.keys()].sort().join("\n");
  useEffect(() => {
    let alive = true;
    void Promise.all(storedKey.split("\n").filter(Boolean).map(async (path) => {
      const resolved = await resolveRepo(path);
      return [path, resolved.ok && resolved.path === path ? testingSettingsLocationOf(resolved) : null] as const;
    })).then((entries) => {
      if (alive) remember(entries);
    });
    return () => { alive = false; };
  }, [remember, storedKey]);

  const rows = useMemo(
    () => testingSettingsRowOrder([...byRoot.keys(), ...overridePaths, ...added], locations),
    [added, byRoot, locations, overridePaths],
  );

  const onSaved = useCallback((root: string, view: TestingSettingsView | null): void => {
    setStored((current) => {
      const rest = (current ?? []).filter((entry) => entry.repoRoot !== root);
      return view ? [...rest, view] : rest;
    });
  }, []);
  const onRowDirty = useCallback((root: string, dirty: boolean): void => {
    if (dirty) dirtyRows.current.add(root);
    else dirtyRows.current.delete(root);
    onDirtyChange(dirtyRows.current.size > 0);
  }, [onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  async function addRow(): Promise<void> {
    const typed = addPath.trim();
    if (!typed || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const resolved = await resolveRepo(typed);
      if (!resolved.ok) {
        setAddError(resolved.error);
        return;
      }
      // A folder inside a repository is a subdirectory scope, kept under its canonical path.
      remember([[resolved.path, testingSettingsLocationOf(resolved)]]);
      setAdded((current) => (current.includes(resolved.path) ? current : [...current, resolved.path]));
      setAddPath("");
    } finally {
      setAdding(false);
    }
  }

  return (
    <section className="wf-testing-settings" aria-labelledby="wf-testing-settings-title">
      <h4 id="wf-testing-settings-title">Testing settings</h4>
      <p className="wf-command-hint">
        Which tests this Command is given, for a repository that does not commit{" "}
        <code>{TESTING_CONFIG_PATH}</code>. Each key set here overrides the committed file&apos;s,
        and <code>{TESTING_LOCAL_CONFIG_PATH}</code> in your checkout overrides both, so the
        order is committed, then stored, then local. Choose Inherit to let the committed file or
        the default decide. The gate runs when any of the three exists.
      </p>
      <p className="wf-command-hint">
        A row for a folder inside a repository, such as one app of a monorepo, applies to the files
        inside it: a key it sets replaces the root&apos;s there, its globs are relative to the
        folder, and a key left to Inherit comes from the repository root. The selected tests still
        run through the one Command the session&apos;s folder picks.
      </p>
      {loadError && <p className="wf-error" role="alert">{loadError}</p>}
      {stored === null && !loadError && <p className="wf-command-hint">Loading testing settings…</p>}
      {stored !== null && rows.map((path) => (
        <TestingSettingsRow
          key={path}
          root={path}
          location={locations.get(path) ?? null}
          view={byRoot.get(path) ?? null}
          onSaved={onSaved}
          onDirty={onRowDirty}
        />
      ))}
      {stored !== null && (
        <div className="wf-testing-settings-add">
          <label htmlFor="wf-testing-settings-add">Add a repository or folder</label>
          <RepoCombobox
            id="wf-testing-settings-add"
            inputRef={addRef}
            onEscape={() => addRef.current?.blur()}
            repos={repos}
            value={addPath}
            onChange={setAddPath}
            disabled={adding}
            placeholder="/path/to/repository or a folder inside it"
          />
          <Tooltip label="Add a row for this repository's or folder's testing settings - Save on the row stores them">
            <button className="btn" disabled={adding || !addPath.trim()} onClick={() => void addRow()}>
              Add row
            </button>
          </Tooltip>
          {addError && <p className="wf-error" role="alert">{addError}</p>}
        </div>
      )}
    </section>
  );
}

/** Whether a list key comes from the layer below or from this row. */
function ListModeSelect({
  id,
  label,
  inheritFrom,
  value,
  onChange,
}: {
  id: string;
  label: string;
  inheritFrom: string;
  value: TestingListMode;
  onChange: (mode: TestingListMode) => void;
}): React.JSX.Element {
  return (
    <Tooltip label={`Inherit leaves this key to ${inheritFrom}. This row stores the list below, even when it is empty.`}>
      <select
        id={id}
        aria-label={label}
        className="field-input"
        value={value}
        onChange={(event) => onChange(event.target.value as TestingListMode)}
      >
        <option value="inherit">Inherit</option>
        <option value="set">This row</option>
      </select>
    </Tooltip>
  );
}

function TestingSettingsRow({
  root,
  location,
  view,
  onSaved,
  onDirty,
}: {
  root: string;
  location: TestingSettingsLocation | null;
  view: TestingSettingsView | null;
  onSaved: (root: string, view: TestingSettingsView | null) => void;
  onDirty: (root: string, dirty: boolean) => void;
}): React.JSX.Element {
  const id = useId();
  const [baseline, setBaseline] = useState<TestingSettingsView | null>(view);
  const [draft, setDraft] = useState<TestingSettingsDraft>(() => testingSettingsDraftFrom(view));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dirty = testingSettingsDraftDirty(draft, baseline);
  const scope = testingSettingsRowScope(location);
  const subdirectory = location !== null && location.subpath !== "";

  const adopt = useCallback((next: TestingSettingsView | null): void => {
    setBaseline(next);
    setDraft(testingSettingsDraftFrom(next));
  }, []);
  // A clean row follows the stored row; a dirty one keeps the operator's typing until Save.
  useEffect(() => {
    if (!dirty && (view?.revision ?? 0) !== (baseline?.revision ?? 0)) adopt(view);
  }, [adopt, baseline, dirty, view]);
  useEffect(() => onDirty(root, dirty), [dirty, onDirty, root]);
  useEffect(() => () => onDirty(root, false), [onDirty, root]);

  async function save(): Promise<void> {
    if (saving) return;
    const body = testingSettingsFromDraft(draft);
    if (!body.ok) {
      setError(body.error);
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await workflowRequest<TestingSettingsView>("/api/testing-settings", {
        method: "PUT",
        body: JSON.stringify({ repoRoot: root, expectedRevision: baseline?.revision ?? 0, settings: body.settings }),
      });
      adopt(saved);
      onSaved(root, saved);
      setNotice("Saved.");
    } catch (caught) {
      if (caught instanceof WorkflowApiError && caught.status === 409) {
        // Reload what is stored: the refusal carries it, so the row shows the winner at once.
        const current = (caught.body?.current ?? null) as TestingSettingsView | null;
        adopt(current);
        onSaved(root, current);
        setError(
          "Another window saved these testing settings first. This row now shows what is stored; "
          + "make your change again.",
        );
      } else {
        setError(caught instanceof Error ? caught.message : "Could not save these testing settings");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <fieldset className="wf-testing-settings-row" aria-label={`Testing settings for ${root}`}>
      <legend>
        <RepositoryName path={location?.repoRoot ?? root} className="wf-command-rule-name" />
        {subdirectory && <> <code className="wf-testing-settings-subpath">{location.subpath}</code></>}
      </legend>
      <p className="wf-testing-settings-path">
        <span className="wf-command-rule-path">{root}</span>
        <span className="wf-command-revision">{testingSettingsRevisionLine(baseline)}</span>
      </p>
      {subdirectory && (
        <p className="wf-command-hint">
          Applies to files inside <code>{location.subpath}</code>. A key set here replaces the
          repository root&apos;s for them; Inherit takes it from the root.
        </p>
      )}
      <div className="wf-testing-settings-fields">
        <label htmlFor={`${id}-patterns`}>Test patterns</label>
        <ListModeSelect
          id={`${id}-patterns-mode`}
          label="Patterns come from"
          inheritFrom={scope.inheritFrom}
          value={draft.patternsMode}
          onChange={(mode) => setDraft((current) => ({ ...current, patternsMode: mode }))}
        />
        <textarea
          id={`${id}-patterns`}
          className="field-input"
          rows={3}
          spellCheck={false}
          placeholder={draft.patternsMode === "set" ? "No globs: an empty list" : subdirectory ? "src/**/*.test.ts" : "test/**/*.test.ts"}
          value={draft.patterns}
          onChange={(event) => setDraft((current) => testingSettingsDraftTyped(current, "patterns", event.target.value))}
        />
        <p className="wf-command-hint">
          tests.patterns: one glob per line, relative to {subdirectory ? <code>{scope.globsRelativeTo}</code> : scope.globsRelativeTo}.
          This row with no globs stores an empty list, replacing the inherited one.
        </p>
        <label htmlFor={`${id}-importers`}>Include importers</label>
        <Tooltip label={`Also select tests that import a changed file. Inherit lets ${scope.inheritFrom} decide.`}>
          <select
            id={`${id}-importers`}
            className="field-input"
            value={draft.includeImporters}
            onChange={(event) => setDraft((current) => ({
              ...current,
              includeImporters: event.target.value as TestingSettingsDraft["includeImporters"],
            }))}
          >
            <option value="inherit">Inherit</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </Tooltip>
        <p className="wf-command-hint">tests.includeImporters: also select tests that import a changed file.</p>
        <label htmlFor={`${id}-smoke`}>Smoke set</label>
        <ListModeSelect
          id={`${id}-smoke-mode`}
          label="Smoke globs come from"
          inheritFrom={scope.inheritFrom}
          value={draft.smokeSetMode}
          onChange={(mode) => setDraft((current) => ({ ...current, smokeSetMode: mode }))}
        />
        <textarea
          id={`${id}-smoke`}
          className="field-input"
          rows={2}
          spellCheck={false}
          placeholder={draft.smokeSetMode === "set" ? "No globs: an empty list" : subdirectory ? "src/smoke.test.ts" : "test/smoke.test.ts"}
          value={draft.smokeSet}
          onChange={(event) => setDraft((current) => testingSettingsDraftTyped(current, "smokeSet", event.target.value))}
        />
        <p className="wf-command-hint">
          tests.smokeSet: globs that always run, one per line, relative to{" "}
          {subdirectory ? <code>{scope.globsRelativeTo}</code> : scope.globsRelativeTo}. This row with no
          globs stores an empty list, so no smoke test runs{subdirectory ? " here" : ""}.
        </p>
      </div>
      {error && <p className="wf-error" role="alert">{error}</p>}
      {notice && !error && <p className="wf-command-hint" role="status">{notice}</p>}
      <Tooltip label={dirty ? `Store these testing settings for ${root}` : "No unsaved changes"}>
        <button className="btn btn-primary" disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? "Saving…" : "Save testing settings"}
        </button>
      </Tooltip>
    </fieldset>
  );
}
