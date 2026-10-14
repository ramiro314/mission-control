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
 * It edits a repository root's STORED testing settings: `tests.patterns`,
 * `tests.includeImporters` and `tests.smokeSet`, kept in Mission Control for a repository that
 * will not commit `.mission/testing.json`. They overlay the committed file key by key, and the
 * local file overlays them, so the order is committed, then stored, then local.
 *
 * One row per repository root that has stored settings or an affected-tests override at its
 * root, plus an add row for a root that has neither. Each row saves on its own, under the
 * revision it loaded; a save another window beat is refused with 409 and the row reloads what
 * is stored. The rows are read over HTTP when the section opens: nothing else edits them, and
 * the refusal is how this window learns of another one.
 */

/** A list field as typed: one glob per line. Blank means the key is not stored. */
export interface TestingSettingsDraft {
  patterns: string;
  includeImporters: "inherit" | "on" | "off";
  smokeSet: string;
}

export function testingSettingsDraftFrom(view: TestingSettingsView | null): TestingSettingsDraft {
  const tests = view?.settings.tests ?? {};
  return {
    patterns: (tests.patterns ?? []).join("\n"),
    includeImporters: tests.includeImporters === undefined ? "inherit" : tests.includeImporters ? "on" : "off",
    smokeSet: (tests.smokeSet ?? []).join("\n"),
  };
}

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

/**
 * The draft as the settings the route takes, or the schema's first refusal as one sentence.
 *
 * A blank list leaves its key unset, so the layer below decides; there is no way to store an
 * explicitly empty list from here, which the local file still expresses for the one checkout
 * that wants it.
 */
export function testingSettingsFromDraft(
  draft: TestingSettingsDraft,
): { ok: true; settings: StoredTestingSettings } | { ok: false; error: string } {
  const tests: Record<string, unknown> = {};
  const patterns = lines(draft.patterns);
  const smokeSet = lines(draft.smokeSet);
  if (patterns.length > 0) tests.patterns = patterns;
  if (draft.includeImporters !== "inherit") tests.includeImporters = draft.includeImporters === "on";
  if (smokeSet.length > 0) tests.smokeSet = smokeSet;
  const parsed = StoredTestingSettingsSchema.safeParse(Object.keys(tests).length > 0 ? { tests } : {});
  if (parsed.success) return { ok: true, settings: parsed.data };
  const issue = parsed.error.issues[0]!;
  return { ok: false, error: `tests.${issue.path.slice(1).join(".")}: ${issue.message}` };
}

export function testingSettingsDraftDirty(draft: TestingSettingsDraft, view: TestingSettingsView | null): boolean {
  const stored = testingSettingsDraftFrom(view);
  return lines(draft.patterns).join("\n") !== stored.patterns
    || draft.includeImporters !== stored.includeImporters
    || lines(draft.smokeSet).join("\n") !== stored.smokeSet;
}

/** The revision line under a row's path. */
export function testingSettingsRevisionLine(view: TestingSettingsView | null): string {
  if (!view) return "Nothing stored yet";
  return `Stored revision ${view.revision}`;
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
  /** Override paths that resolved to a repository root, canonical. */
  const [overrideRepoRoots, setOverrideRepoRoots] = useState<string[]>([]);
  /** Roots the operator added in this visit that have nothing stored yet. */
  const [added, setAdded] = useState<string[]>([]);
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

  // Which override paths are repository roots. A subdirectory override has no root row here:
  // stored settings apply at a repository root.
  const overrideKey = overrideRoots.join("\n");
  useEffect(() => {
    let alive = true;
    void Promise.all(overrideKey.split("\n").filter(Boolean).map(async (path) => {
      const resolved = await resolveRepo(path);
      return resolved.ok && resolved.path === resolved.repoRoot ? resolved.repoRoot : null;
    })).then((roots) => {
      if (alive) setOverrideRepoRoots(roots.filter((root): root is string => root !== null));
    });
    return () => { alive = false; };
  }, [overrideKey]);

  const byRoot = useMemo(() => new Map((stored ?? []).map((view) => [view.repoRoot, view])), [stored]);
  const roots = useMemo(
    () => [...new Set([...byRoot.keys(), ...overrideRepoRoots, ...added])].sort(),
    [added, byRoot, overrideRepoRoots],
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

  async function addRoot(): Promise<void> {
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
      if (resolved.path !== resolved.repoRoot) {
        setAddError(`Testing settings are stored for a repository root. Use ${resolved.repoRoot}, not a folder inside it.`);
        return;
      }
      setAdded((current) => (current.includes(resolved.repoRoot) ? current : [...current, resolved.repoRoot]));
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
        order is committed, then stored, then local. Leave a field blank or on Inherit to let
        the committed file decide. The gate runs when the repository commits the file or sets
        a key here.
      </p>
      {loadError && <p className="wf-error" role="alert">{loadError}</p>}
      {stored === null && !loadError && <p className="wf-command-hint">Loading testing settings…</p>}
      {stored !== null && roots.map((root) => (
        <TestingSettingsRow
          key={root}
          root={root}
          view={byRoot.get(root) ?? null}
          onSaved={onSaved}
          onDirty={onRowDirty}
        />
      ))}
      {stored !== null && (
        <div className="wf-testing-settings-add">
          <label htmlFor="wf-testing-settings-add">Add a repository</label>
          <RepoCombobox
            id="wf-testing-settings-add"
            inputRef={addRef}
            onEscape={() => addRef.current?.blur()}
            repos={repos}
            value={addPath}
            onChange={setAddPath}
            disabled={adding}
            placeholder="/path/to/repository"
          />
          <Tooltip label="Add a row for this repository's testing settings - Save on the row stores them">
            <button className="btn" disabled={adding || !addPath.trim()} onClick={() => void addRoot()}>
              Add repository
            </button>
          </Tooltip>
          {addError && <p className="wf-error" role="alert">{addError}</p>}
        </div>
      )}
    </section>
  );
}

function TestingSettingsRow({
  root,
  view,
  onSaved,
  onDirty,
}: {
  root: string;
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
        <RepositoryName path={root} className="wf-command-rule-name" />
      </legend>
      <p className="wf-testing-settings-path">
        <span className="wf-command-rule-path">{root}</span>
        <span className="wf-command-revision">{testingSettingsRevisionLine(baseline)}</span>
      </p>
      <div className="wf-testing-settings-fields">
        <label htmlFor={`${id}-patterns`}>Test patterns</label>
        <textarea
          id={`${id}-patterns`}
          className="field-input"
          rows={3}
          spellCheck={false}
          placeholder="test/**/*.test.ts"
          value={draft.patterns}
          onChange={(event) => setDraft((current) => ({ ...current, patterns: event.target.value }))}
        />
        <p className="wf-command-hint">tests.patterns: one repository-relative glob per line.</p>
        <label htmlFor={`${id}-importers`}>Include importers</label>
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
        <p className="wf-command-hint">tests.includeImporters: also select tests that import a changed file.</p>
        <label htmlFor={`${id}-smoke`}>Smoke set</label>
        <textarea
          id={`${id}-smoke`}
          className="field-input"
          rows={2}
          spellCheck={false}
          placeholder="test/smoke.test.ts"
          value={draft.smokeSet}
          onChange={(event) => setDraft((current) => ({ ...current, smokeSet: event.target.value }))}
        />
        <p className="wf-command-hint">tests.smokeSet: globs that always run, one per line.</p>
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
