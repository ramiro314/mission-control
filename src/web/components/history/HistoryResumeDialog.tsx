import { useCallback, useEffect, useState } from "react";
import {
  historyResumeCancellable,
  type HistoryResumeDirectoryState,
  type HistoryResumeLaunch,
  type HistoryResumeOptions,
  type HistoryResumeRefusal,
  type HistoryResumeRefusalCode,
  type HistoryResumeTarget,
  type HistorySessionSummary,
} from "@shared/history.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import type { TerminalTargetView } from "@shared/terminal.ts";
import { api } from "../../lib/api.ts";
import { useTerminalTargets } from "../../lib/terminalTargets.ts";
import { agentRowUnavailable, LaunchList } from "../LaunchMenu.tsx";
import { Overlay, OVERLAY_IDS } from "../Overlay.tsx";
import { Tooltip } from "../Tooltip.tsx";

/**
 * Resume one History conversation in a new terminal, in the directory it was recorded in, or,
 * when that directory is gone or reused, in a directory the operator types.
 *
 * The daemon decides everything: whether the directory is still usable, whether a launch of
 * this session is already open, and which terminals can host an agent. The dialog reads
 * `resume-options` when it opens and shows its refusal as it stands, so a person never picks
 * a terminal for a Resume that would be refused. A launch that started waits for discovery to
 * register its agent, which turns the session Live; until then it can be cancelled.
 *
 * A typed directory runs a fork: the daemon copies the transcript into that directory's
 * project folder and starts the fork under an id it minted, so the fork appears in History as
 * its own session. A refusal about the typed directory keeps the field and the terminals up,
 * so the person can correct the path rather than reopen the dialog.
 */

/** Refusals about a typed directory, which leave the picker up for another path. */
const DIRECTORY_REFUSALS: ReadonlySet<HistoryResumeRefusalCode> = new Set([
  "directory_relative",
  "directory_missing",
  "pool_slot",
  "copy_exists",
]);

const DIRECTORY_LABELS: Record<HistoryResumeDirectoryState, string> = {
  usable: "Still there",
  missing: "No longer exists",
  pool_slot: "A worktree pool slot",
  unrecorded: "Not recorded",
};

type View =
  | { state: "loading" }
  | { state: "error"; error: string }
  | { state: "ready"; options: HistoryResumeOptions };


export function HistoryResumeDialog({
  session,
  onClose,
}: {
  session: HistorySessionSummary;
  onClose: () => void;
}): React.JSX.Element {
  const { agent, agentSessionId } = session;
  const [view, setView] = useState<View>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  /** A refusal the last Resume came back with, over what the options said. */
  const [refused, setRefused] = useState<(HistoryResumeRefusal & { launch?: HistoryResumeLaunch }) | null>(null);
  /**
   * Why the last Cancel pending resume was refused. Its own state, so it never stands in for
   * the options: once they are read again, they alone decide whether a Resume can run.
   */
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ launch: HistoryResumeLaunch; label: string } | null>(null);
  const [cancelled, setCancelled] = useState(false);
  /** The directory typed into the picker, sent as typed: the daemon checks and resolves it. */
  const [directory, setDirectory] = useState("");
  const terminals = useTerminalTargets();

  const read = useCallback((signal?: AbortSignal) => {
    setView({ state: "loading" });
    void api.historyResumeOptions(agent, agentSessionId, signal).then((result) => {
      if (signal?.aborted) return;
      setView(result.ok ? { state: "ready", options: result.value } : { state: "error", error: result.error });
    });
  }, [agent, agentSessionId]);

  useEffect(() => {
    const controller = new AbortController();
    read(controller.signal);
    return () => controller.abort();
  }, [read]);

  async function launch(target: TerminalTargetView): Promise<void> {
    setBusy(true);
    setRefused(null);
    setCancelError(null);
    setCancelled(false);
    const where: HistoryResumeTarget = picker ? { kind: "directory", path: directory.trim() } : { kind: "original" };
    const result = await api.historyResume(agent, agentSessionId, { backend: target.id, target: where });
    setBusy(false);
    if (result.ok) setStarted({ launch: result.launch, label: result.label });
    else setRefused(result);
  }

  async function cancel(launch: HistoryResumeLaunch): Promise<void> {
    setBusy(true);
    setCancelError(null);
    const result = await api.historyResumeCancel(agent, agentSessionId, launch.launchId);
    setBusy(false);
    // Either way, what was started or refused before no longer describes the launch: show why a
    // refused cancel was refused, and let the options read now say whether a Resume can run.
    setStarted(null);
    setRefused(null);
    if (!result.ok) {
      setCancelError(result.error);
      read();
      return;
    }
    setCancelled(true);
    read();
  }

  const options = view.state === "ready" ? view.options : null;
  const picker = options?.picker?.directory ? options.picker : null;
  // A typed directory the daemon refused is the field's error; every other refusal is the dialog's.
  const directoryError = picker && refused && DIRECTORY_REFUSALS.has(refused.code) ? refused : null;
  const refusal = (directoryError ? null : refused) ?? options?.refusal ?? (picker ? null : options?.original.refusal) ?? null;
  // The launch a Cancel would close: the one just started, or the open one a refusal named.
  const pending = started?.launch ?? refused?.launch ?? options?.openLaunch ?? null;

  return (
    <Overlay
      id={OVERLAY_IDS.historyResume}
      onClose={onClose}
      className="modal history-resume-modal"
      role="dialog"
      ariaLabel="Resume this conversation"
      closable={!busy}
    >
      <header className="modal-head">
        <h2>Resume this conversation</h2>
        <Tooltip label="Close without resuming (Escape)">
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
            ✕
          </button>
        </Tooltip>
      </header>

      <div className="history-resume-body">
        <p className="history-resume-lead">
          Opens a new terminal that reopens this conversation in {AGENT_IDENTITY[agent].label},{" "}
          {picker ? "in a directory you choose, because the original cannot be used" : "in the directory it was recorded in"}.
          It runs outside Mission Control: no task, and no Mission Control tools.
        </p>
        <dl className="history-resume-place">
          <div>
            <dt>Original directory</dt>
            <dd className="mono">{session.cwd ?? "Not recorded"}</dd>
          </div>
          {options ? (
            <div>
              <dt>Status</dt>
              <dd>{DIRECTORY_LABELS[options.original.state]}</dd>
            </div>
          ) : null}
        </dl>

        {view.state === "loading" ? <p className="history-resume-note">Checking the directory…</p> : null}
        {view.state === "error" ? <p className="history-resume-error" role="alert">{view.error}</p> : null}

        {started && started.launch.expectedAgentSessionId === started.launch.sourceSessionId ? (
          <p className="history-resume-started" role="status">
            Started in {started.label}, in <span className="mono">{started.launch.cwd}</span>. This session turns Live
            here once Mission Control finds the agent.
          </p>
        ) : null}
        {started && started.launch.expectedAgentSessionId !== started.launch.sourceSessionId ? (
          <p className="history-resume-started" role="status">
            Started a fork in {started.label}, in <span className="mono">{started.launch.cwd}</span>, from the transcript
            copied to <span className="mono">{started.launch.copyPath}</span>. The fork appears in History as its own
            session once Mission Control finds the agent.
          </p>
        ) : null}
        {cancelled ? <p className="history-resume-note" role="status">The pending resume was cancelled.</p> : null}
        {cancelError ? <p className="history-resume-error" role="alert">{cancelError}</p> : null}
        {refusal && !started ? <p className="history-resume-error" role="alert">{refusal.error}</p> : null}

        {picker && !refusal && !started && options?.original.refusal ? (
          <>
            <p className="history-resume-note">{options.original.refusal.error}</p>
            <label className="history-resume-directory">
              <span className="field-label">Resume in another directory</span>
              <input
                className="field-input mono"
                type="text"
                value={directory}
                onChange={(event) => {
                  setDirectory(event.target.value);
                  setRefused(null);
                }}
                placeholder="/absolute/path/to/a/directory"
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
              />
            </label>
            <p className="history-resume-note">
              The transcript is copied into this directory&apos;s {AGENT_IDENTITY[agent].label} project folder and resumed
              as a fork with a new id. The original is left as it is.
            </p>
            {directoryError ? <p className="history-resume-error" role="alert">{directoryError.error}</p> : null}
          </>
        ) : null}

        {pending && historyResumeCancellable(pending) && (started || refusal?.code === "open_launch" || refusal?.code === "launch_unknown") ? (
          <Tooltip label="Close this launch now, so the conversation can be resumed again. A terminal that already opened is not closed.">
            <button type="button" className="btn" onClick={() => void cancel(pending)} disabled={busy}>
              Cancel pending resume
            </button>
          </Tooltip>
        ) : null}

        {options && !refusal && !started && (!picker || directory.trim() !== "") ? (
          <div className="history-resume-targets" role="menu" aria-label="Resume in">
            <span className="launch-head">Resume in</span>
            <LaunchList
              targets={terminals.targets}
              failed={terminals.failed}
              verb="Resume this conversation in"
              rowUnavailable={agentRowUnavailable}
              onChoose={(target) => void launch(target)}
            />
          </div>
        ) : null}
      </div>

      <footer className="modal-foot">
        <span className="actions-spacer" />
        <Tooltip label="Close this dialog (Escape)">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
        </Tooltip>
      </footer>
    </Overlay>
  );
}
