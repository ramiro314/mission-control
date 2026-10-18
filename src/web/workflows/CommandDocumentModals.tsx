import { useEffect, useRef, useState } from "react";
import {
  commandDocumentChangeCount,
  commandDocumentChangeSummary,
  commandDocumentPathLabel,
  parseCommandDocumentText,
  type CommandDocument,
  type CommandDocumentApplied,
  type CommandDocumentChangeKind,
  type CommandDocumentExport,
  type CommandDocumentPreview,
  type CommandDocumentProposal,
} from "@shared/command-document.ts";
import type { StoredTestingSettings } from "@shared/testing-config.ts";
import { WORKFLOW_CHECK_SLOTS, formatCheckCommand } from "@shared/workflow.ts";
import { Overlay, OVERLAY_IDS } from "../components/Overlay.tsx";
import { RepoCombobox } from "../components/RepoCombobox.tsx";
import { RepositoryName } from "../components/RepositoryName.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { useCopyFeedback } from "../lib/clipboard.ts";
import { workflowRequest, WorkflowApiError } from "./workflowApi.ts";

/**
 * Command documents in Library › Commands: one repository's Command overrides and stored testing
 * settings as one versioned JSON file (`src/shared/command-document.ts`).
 *
 * Import takes a pasted or uploaded document and a repository, asks the daemon for a preview of
 * every add, change and removal, and applies it in one step. Apply is checked against the
 * revisions the preview was computed from, so a preview another window made stale comes back as
 * a fresh preview to review rather than writing over that window's save. Export reads a
 * repository's rows back out as a document; importing it again changes nothing.
 */

const KIND_LABEL: Record<CommandDocumentChangeKind, string> = { add: "Add", change: "Change", remove: "Remove" };

/** A stored testing row as one line: `patterns: a, b · includeImporters: off · smokeSet: (none)`. */
export function testingSettingsReadout(settings: StoredTestingSettings | null): string {
  const tests = settings?.tests ?? {};
  const list = (globs: string[]) => (globs.length > 0 ? globs.join(", ") : "(none)");
  const parts: string[] = [];
  if (tests.patterns !== undefined) parts.push(`patterns: ${list(tests.patterns)}`);
  if (tests.includeImporters !== undefined) parts.push(`includeImporters: ${tests.includeImporters ? "on" : "off"}`);
  if (tests.smokeSet !== undefined) parts.push(`smokeSet: ${list(tests.smokeSet)}`);
  return parts.length > 0 ? parts.join(" · ") : "nothing stored";
}

/** Every reason a request was refused, from the route's `problems` when it sent them. */
function refusalLines(caught: unknown, fallback: string): string[] {
  if (caught instanceof WorkflowApiError) {
    const problems = caught.body?.problems;
    if (Array.isArray(problems) && problems.every((line) => typeof line === "string") && problems.length > 0) {
      return problems as string[];
    }
    return [caught.message];
  }
  return [caught instanceof Error ? caught.message : fallback];
}

function ChangeValue({ before, after }: { before: string | null; after: string | null }): React.JSX.Element {
  if (before !== null && after !== null) {
    return (
      <span className="command-document-value">
        <code>{before}</code> <span aria-hidden="true">→</span><span className="sr-only">becomes</span> <code>{after}</code>
      </span>
    );
  }
  return <span className="command-document-value"><code>{after ?? before}</code></span>;
}

/** The preview: every change grouped by slot, then testing settings, and what blocks apply. */
export function CommandDocumentPreviewList({ preview }: { preview: CommandDocumentPreview }): React.JSX.Element {
  const count = commandDocumentChangeCount(preview);
  return (
    <section className="command-document-preview" aria-label="Preview">
      <p className="command-document-summary">
        <strong>{commandDocumentChangeSummary(preview)}</strong> in{" "}
        <RepositoryName path={preview.repoRoot} />
        {preview.unchanged > 0 && <> · {preview.unchanged} already as the document says</>}
      </p>
      {count === 0 && preview.problems.length === 0 && (
        <p className="command-document-empty">Nothing to apply: this repository already matches the document.</p>
      )}
      {preview.problems.length > 0 && (
        <ul className="command-document-problems wf-error" role="alert" aria-label="Problems">
          {preview.problems.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
      {WORKFLOW_CHECK_SLOTS.map((slot) => {
        const changes = preview.commands.filter((change) => change.slot === slot);
        if (changes.length === 0) return null;
        return (
          <div className="command-document-group" key={slot}>
            <h4>{slot}</h4>
            <ul aria-label={`${slot} changes`}>
              {changes.map((change) => (
                <li key={change.path} className={`command-document-change is-${change.kind}`}>
                  <span className="command-document-kind">{KIND_LABEL[change.kind]}</span>{" "}
                  <span className="command-document-path">{commandDocumentPathLabel(change.path)}</span>{" "}
                  <ChangeValue
                    before={change.before ? formatCheckCommand(change.before) : null}
                    after={change.after ? formatCheckCommand(change.after) : null}
                  />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {preview.testing.length > 0 && (
        <div className="command-document-group">
          <h4>Testing settings</h4>
          <ul aria-label="Testing settings changes">
            {preview.testing.map((change) => (
              <li key={change.path} className={`command-document-change is-${change.kind}`}>
                <span className="command-document-kind">{KIND_LABEL[change.kind]}</span>{" "}
                <span className="command-document-path">{commandDocumentPathLabel(change.path)}</span>{" "}
                <ChangeValue
                  before={change.before ? testingSettingsReadout(change.before) : null}
                  after={change.after ? testingSettingsReadout(change.after) : null}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function RepositoryField({
  id,
  repos,
  value,
  onChange,
  disabled,
}: {
  id: string;
  repos: string[];
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <div className="command-document-field">
      <label htmlFor={id}>Repository</label>
      <RepoCombobox
        id={id}
        repos={repos}
        value={value}
        onChange={onChange}
        disabled={disabled}
        placeholder="/path/to/repository"
      />
    </div>
  );
}

/** Who proposed a document, as one phrase: the task's title, else the session's name. */
export function proposalOrigin(proposal: Pick<CommandDocumentProposal, "taskTitle" | "sessionName">): string {
  return proposal.taskTitle ? `the task "${proposal.taskTitle}"` : proposal.sessionName ? `the session "${proposal.sessionName}"` : "an agent session";
}

export function CommandDocumentImportModal({
  repos,
  onClose,
  onApplied,
  proposal = null,
  proposalPending = true,
  onDismissed,
}: {
  repos: string[];
  onClose: () => void;
  /** Called once a document has been written, with what was written. */
  onApplied: (applied: CommandDocumentApplied) => void;
  /**
   * A pending proposal to review instead of a pasted document. Its repository and document are
   * fixed - what is reviewed is exactly what was proposed - and the preview is computed on open.
   * Applying clears it; Dismiss proposal drops it unapplied.
   */
  proposal?: CommandDocumentProposal | null;
  /** False once the proposal opened here is no longer the repository's pending one. */
  proposalPending?: boolean;
  /** Called once the proposal opened here has been dismissed. */
  onDismissed?: (proposal: CommandDocumentProposal) => void;
}): React.JSX.Element {
  const [repo, setRepo] = useState(proposal?.repoRoot ?? "");
  const [text, setText] = useState(proposal ? commandDocumentText(proposal.document) : "");
  const [problems, setProblems] = useState<string[]>([]);
  /** The preview on screen, and the exact document it was computed for. */
  const [previewed, setPreviewed] = useState<{ preview: CommandDocumentPreview; document: CommandDocument } | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Any edit makes the preview a preview of something else, so it goes. */
  function edited(): void {
    setPreviewed(null);
    setStale(false);
    setProblems([]);
  }

  async function preview(): Promise<void> {
    const parsed = parseCommandDocumentText(text);
    if (!parsed.ok) {
      setProblems(parsed.problems);
      return;
    }
    if (repo.trim() === "") {
      setProblems(["Choose the repository this document configures."]);
      return;
    }
    setBusy(true);
    setProblems([]);
    try {
      const result = await workflowRequest<CommandDocumentPreview>("/api/command-documents/preview", {
        method: "POST",
        body: JSON.stringify({ repoRoot: repo.trim(), document: parsed.document }),
      });
      setPreviewed({ preview: result, document: parsed.document });
      setStale(false);
    } catch (caught) {
      setProblems(refusalLines(caught, "Could not preview this document"));
    } finally {
      setBusy(false);
    }
  }

  async function apply(): Promise<void> {
    if (!previewed) return;
    setBusy(true);
    setProblems([]);
    try {
      const applied = await workflowRequest<CommandDocumentApplied>("/api/command-documents/apply", {
        method: "POST",
        body: JSON.stringify({
          repoRoot: previewed.preview.repoRoot,
          document: previewed.document,
          basis: previewed.preview.basis,
          ...(proposal ? { proposalId: proposal.id } : {}),
        }),
      });
      onApplied(applied);
    } catch (caught) {
      const fresh = caught instanceof WorkflowApiError ? caught.body?.preview as CommandDocumentPreview | undefined : undefined;
      if (caught instanceof WorkflowApiError && caught.status === 409 && fresh) {
        // Another window saved first. The recomputed preview replaces the one that went stale,
        // and nothing was written: the operator reviews what applying now does.
        setPreviewed({ preview: fresh, document: previewed.document });
        setStale(true);
      } else {
        if (fresh) setPreviewed({ preview: fresh, document: previewed.document });
        setProblems(refusalLines(caught, "Could not apply this document"));
      }
    } finally {
      setBusy(false);
    }
  }

  // A proposal is previewed as it opens: the operator came here to review it, and a Preview
  // button over a document they cannot edit would be one click that can only say the same thing.
  const previewedOnOpen = useRef(false);
  useEffect(() => {
    if (!proposal || previewedOnOpen.current) return;
    previewedOnOpen.current = true;
    void preview();
    // Once, for the proposal this modal opened on; `preview` reads the state it was seeded with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal]);

  async function dismiss(): Promise<void> {
    if (!proposal) return;
    setBusy(true);
    setProblems([]);
    try {
      await workflowRequest("/api/command-documents/proposals/dismiss", {
        method: "POST",
        body: JSON.stringify({ repoRoot: proposal.repoRoot, proposalId: proposal.id }),
      });
      onDismissed?.(proposal);
    } catch (caught) {
      setProblems(refusalLines(caught, "Could not dismiss this proposal"));
    } finally {
      setBusy(false);
    }
  }

  const changes = previewed ? commandDocumentChangeCount(previewed.preview) : 0;
  const applicable = previewed !== null && changes > 0 && previewed.preview.problems.length === 0;

  return (
    <Overlay
      id={OVERLAY_IDS.commandDocumentImport}
      onClose={onClose}
      className="modal command-document-modal"
      role="dialog"
      ariaLabel={proposal ? "Review a proposed Command document" : "Import a Command document"}
    >
      <header className="modal-head">
        <h2>{proposal ? "Review a proposed Command document" : "Import a Command document"}</h2>
        <Tooltip label="Close without changing anything (Escape)">
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </Tooltip>
      </header>
      <div className="modal-body command-document-body">
        {proposal && (
          <p className="command-document-lead command-document-proposal-lead">
            Proposed by {proposalOrigin(proposal)} on {new Date(proposal.proposedAt).toLocaleString()}.
            Nothing in it is applied until you apply it here, and dismissing it changes nothing.
          </p>
        )}
        {proposal && !proposalPending && (
          <p className="command-document-stale" role="status">
            This proposal is no longer the repository&apos;s pending one: it was replaced by a newer
            proposal, or applied or dismissed in another window. Applying it still writes exactly
            what this preview lists.
          </p>
        )}
        <p className="command-document-lead">
          One repository&apos;s Command overrides and testing settings. Rows the document does not
          mention stay as they are, and only a <code>&quot;remove&quot;: true</code> entry removes one.
          Global defaults and run budgets are never part of a document.
        </p>
        <RepositoryField
          id="command-document-import-repo"
          repos={repos}
          value={repo}
          disabled={busy || proposal !== null}
          onChange={(value) => {
            setRepo(value);
            edited();
          }}
        />
        <div className="command-document-field">
          <label htmlFor="command-document-import-text">Document</label>
          <textarea
            id="command-document-import-text"
            className="field-input mono command-document-text"
            rows={10}
            spellCheck={false}
            value={text}
            disabled={busy}
            readOnly={proposal !== null}
            placeholder={'{ "version": 1, "commands": { "lint": [{ "path": "", "argv": ["npm", "run", "lint"] }] } }'}
            onChange={(event) => {
              setText(event.target.value);
              edited();
            }}
          />
          {/* A proposal is reviewed as proposed, so it offers no way to load a different document. */}
          {proposal === null && (
            <div className="command-document-upload">
              <Tooltip label="Read a .json document from disk into the box above">
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
                  Upload .json
                </button>
              </Tooltip>
              <input
                ref={fileRef}
                className="command-document-file"
                type="file"
                accept=".json,application/json,text/plain"
                aria-label="Command document file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = "";
                  if (!file) return;
                  void file.text().then((loaded) => {
                    setText(loaded);
                    edited();
                  }, () => setProblems([`Could not read ${file.name}`]));
                }}
              />
            </div>
          )}
        </div>
        {problems.length > 0 && (
          <ul className="command-document-problems wf-error" role="alert" aria-label="Document problems">
            {problems.map((line) => <li key={line}>{line}</li>)}
          </ul>
        )}
        {stale && (
          <p className="command-document-stale" role="status">
            The Commands or testing settings changed since that preview, so nothing was written.
            This is the preview against what is stored now: review it and apply again.
          </p>
        )}
        {previewed && <CommandDocumentPreviewList preview={previewed.preview} />}
      </div>
      <footer className="modal-foot">
        {proposal && (
          <Tooltip label="Drop this proposal without applying any of it">
            <button type="button" className="btn btn-ghost" disabled={busy || !proposalPending} onClick={() => void dismiss()}>
              Dismiss proposal
            </button>
          </Tooltip>
        )}
        <span className="actions-spacer" />
        <Tooltip label={proposal ? "Close and keep the proposal pending" : "Close without changing anything"}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>{proposal ? "Later" : "Cancel"}</button>
        </Tooltip>
        {previewed ? (
          <Tooltip
            label={applicable
              ? "Write every change above in one step"
              : previewed.preview.problems.length > 0
                ? "Fix the problems listed above first"
                : "Nothing to apply"}
          >
            <button type="button" className="btn" disabled={!applicable || busy} onClick={() => void apply()}>
              {busy ? "Applying…" : `Apply ${changes} ${changes === 1 ? "change" : "changes"}`}
            </button>
          </Tooltip>
        ) : (
          <Tooltip label="Check the document and list every change it makes, without writing anything">
            <button type="button" className="btn" disabled={busy} onClick={() => void preview()}>
              {busy ? "Previewing…" : "Preview"}
            </button>
          </Tooltip>
        )}
      </footer>
    </Overlay>
  );
}

/** The exported document as a person reads it and a file holds it. */
export function commandDocumentText(document: CommandDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** `commands-<repository folder name>.json`. */
export function commandDocumentFileName(repoRoot: string): string {
  const leaf = repoRoot.split("/").filter(Boolean).pop() ?? "repository";
  return `commands-${leaf.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`;
}

export function CommandDocumentExportModal({
  repos,
  onClose,
}: {
  repos: string[];
  onClose: () => void;
}): React.JSX.Element {
  const [repo, setRepo] = useState("");
  const [exported, setExported] = useState<CommandDocumentExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const copy = useCopyFeedback({ resetOn: exported?.repoRoot ?? null });
  const text = exported ? commandDocumentText(exported.document) : "";

  async function run(): Promise<void> {
    if (repo.trim() === "") {
      setError("Choose the repository to export.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setExported(await workflowRequest<CommandDocumentExport>(
        `/api/command-documents/export?repoRoot=${encodeURIComponent(repo.trim())}`,
      ));
    } catch (caught) {
      setExported(null);
      setError(caught instanceof Error ? caught.message : "Could not export this repository");
    } finally {
      setBusy(false);
    }
  }

  function download(): void {
    if (!exported) return;
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = commandDocumentFileName(exported.repoRoot);
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Overlay
      id={OVERLAY_IDS.commandDocumentExport}
      onClose={onClose}
      className="modal command-document-modal"
      role="dialog"
      ariaLabel="Export a Command document"
    >
      <header className="modal-head">
        <h2>Export a Command document</h2>
        <Tooltip label="Close (Escape)">
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </Tooltip>
      </header>
      <div className="modal-body command-document-body">
        <p className="command-document-lead">
          One repository&apos;s Command overrides, in every slot, and its stored testing settings, as a
          document. Importing it back changes nothing.
        </p>
        <div className="command-document-export-row">
          <RepositoryField
            id="command-document-export-repo"
            repos={repos}
            value={repo}
            disabled={busy}
            onChange={(value) => {
              setRepo(value);
              setExported(null);
              setError(null);
            }}
          />
          <Tooltip label="Read this repository's overrides and testing settings as a document">
            <button type="button" className="btn" disabled={busy} onClick={() => void run()}>
              {busy ? "Exporting…" : "Export"}
            </button>
          </Tooltip>
        </div>
        {error && <p className="wf-error" role="alert">{error}</p>}
        {exported && (
          <div className="command-document-field">
            <label htmlFor="command-document-export-text">
              Exported document for <RepositoryName path={exported.repoRoot} />
            </label>
            <textarea
              id="command-document-export-text"
              className="field-input mono command-document-text"
              rows={14}
              readOnly
              spellCheck={false}
              value={text}
            />
            {copy.error && <p className="wf-error" role="alert">{copy.error}</p>}
          </div>
        )}
      </div>
      <footer className="modal-foot">
        <span className="actions-spacer" />
        <Tooltip label="Copy the document to the clipboard">
          <button type="button" className="btn btn-ghost" disabled={!exported} onClick={() => void copy.copy(text)}>
            {copy.copied ? "Copied" : "Copy"}
          </button>
        </Tooltip>
        <Tooltip label="Save the document as a .json file">
          <button type="button" className="btn btn-ghost" disabled={!exported} onClick={download}>
            Download .json
          </button>
        </Tooltip>
        <Tooltip label="Close">
          <button type="button" className="btn" onClick={onClose}>Done</button>
        </Tooltip>
      </footer>
    </Overlay>
  );
}
