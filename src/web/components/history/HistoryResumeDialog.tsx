import { useCallback, useEffect, useState } from "react";
import {
  historyResumeCancellable,
  historyResumeCheckoutWarning,
  historyResumeNeedsPicker,
  type HistoryResumeCheckout,
  type HistoryResumeDirectoryState,
  type HistoryResumeLaunch,
  type HistoryResumeOptions,
  type HistoryResumeRefusal,
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
 * Resume one History conversation in a new terminal, in the directory it was recorded in, or
 * in a worktree slot of its repository when that directory is gone or reused.
 *
 * The daemon decides everything: whether the directory is still usable, which slots are idle,
 * whether a launch of this session is already open, and which terminals can host an agent. The
 * dialog reads `resume-options` when it opens and shows its refusal as it stands, so a person
 * never picks a terminal for a Resume that would be refused. A launch that started waits for
 * discovery to register its agent, which turns the session Live; until then a slotless one can
 * be cancelled, and one in a slot closes when that slot is Returned from its card.
 */

const DIRECTORY_LABELS: Record<HistoryResumeDirectoryState, string> = {
  usable: "Still there",
  missing: "No longer exists",
  pool_slot: "An idle worktree slot: this Resume leases it and checks out the recorded branch",
  unrecorded: "Not recorded",
  slot_reused: "A worktree slot that is in use or not idle",
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
  const [started, setStarted] = useState<{ launch: HistoryResumeLaunch; label: string; checkout: HistoryResumeCheckout | null } | null>(null);
  /** The slot the picker has selected, when the original directory is gone or reused. */
  const [slotId, setSlotId] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const terminals = useTerminalTargets();

  const read = useCallback((signal?: AbortSignal) => {
    setView({ state: "loading" });
    void api.historyResumeOptions(agent, agentSessionId, signal).then((result) => {
      if (signal?.aborted) return;
      setView(result.ok ? { state: "ready", options: result.value } : { state: "error", error: result.error });
      // A fresh read offers its own slots; keep the selection only while it is still offered.
      if (result.ok) {
        setSlotId((current) => result.value.slots.some((slot) => slot.slotId === current) ? current : result.value.slots[0]?.slotId ?? null);
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
    const where = picking && slotId ? { kind: "slot" as const, slotId } : { kind: "original" as const };
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
  // The original is gone or reused, and the daemon offered slots to resume in instead.
  const picking = options !== null && historyResumeNeedsPicker(options.original.state) && options.slots.length > 0;
  const warning = started?.checkout ? historyResumeCheckoutWarning(started.checkout) : null;
  const refusal = refused ?? options?.refusal ?? null;
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
          Opens a new terminal that reopens this conversation in {AGENT_IDENTITY[agent].label}, in the directory it
          was recorded in, or in a worktree slot of its repository when that directory is gone or in use. It runs
          outside Mission Control: no task, and no Mission Control tools.
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

        {started ? (
          <p className="history-resume-started" role="status">
            Started in {started.label}, in <span className="mono">{started.launch.cwd}</span>. This session turns Live
            here once Mission Control finds the agent.
            {started.launch.slotId !== null
              ? " The slot stays leased to this Resume until you Return it from its card in Settings, Worktrees."
              : null}
          </p>
        ) : null}
        {warning ? <p className="history-resume-warning" role="alert">{warning}</p> : null}
        {cancelled ? <p className="history-resume-note" role="status">The pending resume was cancelled.</p> : null}
        {cancelError ? <p className="history-resume-error" role="alert">{cancelError}</p> : null}
        {refusal && !started ? <p className="history-resume-error" role="alert">{refusal.error}</p> : null}

        {pending && historyResumeCancellable(pending) && (started || refusal?.code === "open_launch" || refusal?.code === "launch_unknown") ? (
          <Tooltip label="Close this launch now, so the conversation can be resumed again. A terminal that already opened is not closed.">
            <button type="button" className="btn" onClick={() => void cancel(pending)} disabled={busy}>
              Cancel pending resume
            </button>
          </Tooltip>
        ) : null}

        {picking && !refusal && !started ? (
          <fieldset className="history-resume-slots">
            <legend>Choose an idle slot of this repository</legend>
            {options.slots.map((slot) => (
              <label key={slot.slotId} className="history-resume-slot">
                <input
                  type="radio"
                  name="history-resume-slot"
                  value={slot.slotId}
                  checked={slotId === slot.slotId}
                  onChange={() => setSlotId(slot.slotId)}
                  disabled={busy}
                />
                <span>Slot {slot.ordinal}</span>
                <span className="mono">{slot.path}</span>
              </label>
            ))}
          </fieldset>
        ) : null}

        {options && !refusal && !started && (!picking || slotId) ? (
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
