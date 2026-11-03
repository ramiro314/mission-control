import { useCallback, useEffect, useState } from "react";
import {
  historyResumeCancellable,
  historyResumeCheckoutWarning,
  type HistoryResumeCheckout,
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
 * when that directory is gone or reused, in an idle worktree slot of its repository or a
 * directory the operator types.
 *
 * The daemon decides everything: whether the directory is still usable, whether a launch of
 * this session is already open, and which terminals can host an agent. The dialog reads
 * `resume-options` when it opens and shows its refusal as it stands, so a person never picks
 * a terminal for a Resume that would be refused. A launch that started waits for discovery to
 * register its agent, which turns the session Live; until then it can be cancelled.
 *
 * A slot is leased for the Resume and its recorded branch checked out; it stays leased until it
 * is Returned from its card, and the daemon says what it checked out, with a warning when that
 * is not the recorded branch.
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
  pool_slot: "An idle worktree slot: this Resume leases it and checks out the recorded branch",
  unrecorded: "Not recorded",
  slot_reused: "A worktree slot that is in use or not idle",
};

/** The picker's choice that is not a slot: the typed directory. */
const DIRECTORY_CHOICE = "directory";

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
  const [started, setStarted] = useState<{ launch: HistoryResumeLaunch; label: string; checkout: HistoryResumeCheckout | null } | null>(null);
  /** The picker's selection: a slot id, or `DIRECTORY_CHOICE` for the typed directory. */
  const [choice, setChoice] = useState<string>(DIRECTORY_CHOICE);
  const [cancelled, setCancelled] = useState(false);
  /** The directory typed into the picker, sent as typed: the daemon checks and resolves it. */
  const [directory, setDirectory] = useState("");
  const terminals = useTerminalTargets();

  const read = useCallback((signal?: AbortSignal) => {
    setView({ state: "loading" });
    void api.historyResumeOptions(agent, agentSessionId, signal).then((result) => {
      if (signal?.aborted) return;
      setView(result.ok ? { state: "ready", options: result.value } : { state: "error", error: result.error });
      // A fresh read offers its own slots; keep the selection only while it is still offered.
      if (result.ok) {
        const slots = result.value.picker?.slots ?? [];
        setChoice((current) => slots.some((slot) => slot.slotId === current) ? current : slots[0]?.slotId ?? DIRECTORY_CHOICE);
      }
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
    const where: HistoryResumeTarget = !picker
      ? { kind: "original" }
      : chosenSlot
        ? { kind: "slot", slotId: chosenSlot.slotId }
        : { kind: "directory", path: directory.trim() };
    const result = await api.historyResume(agent, agentSessionId, { backend: target.id, target: where });
    setBusy(false);
    if (result.ok) setStarted({ launch: result.launch, label: result.label, checkout: result.checkout ?? null });
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
  const picker = options?.picker && (options.picker.directory || options.picker.slots.length > 0) ? options.picker : null;
  const chosenSlot = picker?.slots.find((slot) => slot.slotId === choice) ?? null;
  // The typed directory is the target when the picker offers it and no slot is chosen.
  const typing = picker !== null && picker.directory && chosenSlot === null;
  // A typed directory the daemon refused is the field's error; every other refusal is the dialog's.
  const directoryError = typing && refused && DIRECTORY_REFUSALS.has(refused.code) ? refused : null;
  const warning = started?.checkout ? historyResumeCheckoutWarning(started.checkout) : null;
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
          {!picker
            ? "in the directory it was recorded in"
            : picker.slots.length > 0
              ? "in a worktree slot or a directory you choose, because the original cannot be used"
              : "in a directory you choose, because the original cannot be used"}.
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
            {started.launch.slotId !== null
              ? " The slot stays leased to this Resume until you Return it from its card in Settings, Worktrees."
              : null}
          </p>
        ) : null}
        {warning ? <p className="history-resume-warning" role="alert">{warning}</p> : null}
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
            {picker.slots.length > 0 ? (
              <fieldset className="history-resume-slots">
                <legend>Choose an idle slot of this repository</legend>
                {picker.slots.map((slot) => (
                  <Tooltip key={slot.slotId} label={`Lease slot ${slot.ordinal} for this Resume and check out the recorded branch in it`}>
                    <label className="history-resume-slot">
                      <input
                        type="radio"
                        name="history-resume-slot"
                        value={slot.slotId}
                        checked={choice === slot.slotId}
                        onChange={() => {
                          setChoice(slot.slotId);
                          setRefused(null);
                        }}
                        disabled={busy}
                      />
                      <span>Slot {slot.ordinal}</span>
                      <span className="mono">{slot.path}</span>
                    </label>
                  </Tooltip>
                ))}
                {picker.directory ? (
                  <Tooltip label="Type a directory instead: the transcript is copied there and resumed as a fork">
                    <label className="history-resume-slot">
                      <input
                        type="radio"
                        name="history-resume-slot"
                        value={DIRECTORY_CHOICE}
                        checked={choice === DIRECTORY_CHOICE}
                        onChange={() => {
                          setChoice(DIRECTORY_CHOICE);
                          setRefused(null);
                        }}
                        disabled={busy}
                      />
                      <span>Another directory</span>
                    </label>
                  </Tooltip>
                ) : null}
              </fieldset>
            ) : null}
          </>
        ) : null}

        {typing && !refusal && !started && options?.original.refusal ? (
          <>
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

        {options && !refusal && !started && (!picker || chosenSlot || directory.trim() !== "") ? (
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
