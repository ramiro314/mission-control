import { useEffect, useMemo, useRef, useState } from "react";
import { WORKTREES_CONFIG_LIMITS, type WorktreeClaim, type WorktreesConfigPatch } from "@shared/protocol.ts";
import type { OrphanProcess, ProcessSession, StorageHealth, StorageProblem } from "@shared/storage-health.ts";
import type { TerminalBackendId } from "@shared/terminal.ts";
import type {
  NativeWorktreeSlotView,
  WorktreeActionPreview,
  WorktreeActionRequest,
  WorktreeClaimVariableSource,
  WorktreeClaimVariableView,
  WorktreeOperationView,
  WorktreeRecoveryRefusalView,
  WorktreeRepositoryView,
  WorktreeRiskKey,
  WorktreeSlotDependenciesView,
  WorktreeSlotDependencyState,
  WorktreeWarmTargetOutcome,
} from "@shared/worktrees.ts";
import { worktreeOperationPending, worktreeRetryRequest } from "@shared/worktrees.ts";
import type { WorktreesConfigUpdate, WorktreesState } from "../useWorktrees.ts";
import { COPY_FEEDBACK_LABEL, useCopyFeedback } from "../lib/clipboard.ts";
import { api, openWorktreeTerminal, worktreeWarmLogUrl } from "../lib/api.ts";
import { useTerminalTargets } from "../lib/terminalTargets.ts";
import { capacityGeometry, type CapacityGeometry } from "../lib/worktree-capacity.ts";
import { BULK_SELECTION_LIMIT, changeSelection } from "../lib/worktree-selection.ts";
import {
  claimErrorsFrom,
  claimFromDraft,
  draftFromClaim,
  draftLines,
  draftNames,
  emptyClaimErrors,
  hasClaimErrors,
  hasClaimFieldErrors,
  withoutStepErrors,
  type ClaimDraft,
  type ClaimDraftErrors,
  type ClaimStepDraft,
} from "../lib/worktree-claim-draft.ts";
import { ClaimStopButton, formatElapsed, useNow } from "./ClaimProgress.tsx";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

function bytes(value: number | null): string {
  if (value === null) return "size unknown";
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

function shortSha(value: string | null): string {
  return value?.slice(0, 9) ?? "unknown";
}

/** A typed threshold the daemon accepts, or null for an empty, fractional or out-of-range one. */
export function parseStaleLeaseDays(text: string): number | null {
  const value = Number(text);
  return text.trim() !== "" && Number.isInteger(value) &&
    value >= WORKTREES_CONFIG_LIMITS.minStaleLeaseDays &&
    value <= WORKTREES_CONFIG_LIMITS.maxStaleLeaseDays
    ? value
    : null;
}

/**
 * The stale-lease threshold, saved on blur or Enter rather than on every keystroke: typing 15
 * over 7 must not first save 1, which would flag every lease a day old and republish Storage.
 * A value the daemon would refuse snaps back to the saved one instead of being sent.
 */
function StaleLeaseDaysInput({
  saved,
  onSave,
}: {
  saved: number | null;
  onSave: (days: number) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(saved === null ? "" : String(saved));
  useEffect(() => {
    setDraft(saved === null ? "" : String(saved));
  }, [saved]);
  const commit = () => {
    const days = parseStaleLeaseDays(draft);
    if (days === null) setDraft(saved === null ? "" : String(saved));
    else if (days !== saved) onSave(days);
  };
  return (
    <input
      className="wt-number"
      aria-label="Stale lease threshold in days"
      type="number"
      min={WORKTREES_CONFIG_LIMITS.minStaleLeaseDays}
      max={WORKTREES_CONFIG_LIMITS.maxStaleLeaseDays}
      disabled={saved === null}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}

function StateChip({ label, tone = "neutral" }: { label: string; tone?: string }): React.JSX.Element {
  return <span className={`wt-chip wt-chip-${tone}`}>{label}</span>;
}

const ACTION_VERBS: Record<WorktreeActionRequest["action"], string> = {
  return: "Return",
  recover: "Recover",
  repair: "Repair",
  prune: "Prune",
  reconcile: "Reconcile",
  destroy: "Destroy",
  legacyReturn: "Legacy return",
  warm: "Warm",
  removeUnowned: "Discard and remove",
};

/**
 * One line naming what an accepted cleanup is for. A removal is counted by its removal set,
 * never by every path it touches: destroying or returning one task-owned slot also affects
 * the task's other resources, and those are named as affected paths, not as more worktrees.
 */
function operationSubject(operation: WorktreeOperationView): string {
  if (operation.removals.length === 1) return operation.removals[0]!.path;
  if (operation.removals.length > 1) return `${operation.removals.length} worktrees`;
  if (operation.targets.length === 0) return "pool";
  const request = operation.request;
  const primary = (request.action === "return"
    ? operation.targets.find((target) => target.id === request.slotId)
    : undefined) ?? operation.targets[0]!;
  const others = operation.targets.length - 1;
  return others > 0 ? `${primary.path} (+${others} affected ${others === 1 ? "path" : "paths"})` : primary.path;
}

/**
 * Accepted cleanups that have not finished, and failures nobody has read yet.
 *
 * Execute answers as soon as the preview is claimed, so this is where the rest of the work
 * is reported. A stale preview is the ordinary failure and gets the ordinary remedy: preview
 * the same request again from current state.
 */
function OperationList({
  operations,
  onRetry,
  onDismiss,
}: {
  operations: WorktreeOperationView[];
  onRetry: (operation: WorktreeOperationView, request: WorktreeActionRequest, trigger: HTMLButtonElement) => void;
  onDismiss: (operation: WorktreeOperationView) => void;
}): React.JSX.Element | null {
  if (operations.length === 0) return null;
  const pending = operations.filter(worktreeOperationPending);
  const failed = operations.filter((operation) => operation.state === "failed");
  return (
    <section className="wt-operations" aria-label="Background cleanup">
      {pending.length > 0 && (
        <ul className="wt-operation-list" role="status">
          {pending.map((operation) => (
            <li key={operation.id} className="wt-operation">
              <StateChip label={operation.state === "running" ? "in progress" : "queued"} tone="working" />
              <span><strong>{ACTION_VERBS[operation.request.action]}</strong> <code>{operationSubject(operation)}</code></span>
            </li>
          ))}
        </ul>
      )}
      {failed.length > 0 && (
        <ul className="wt-operation-list">
          {failed.map((operation) => {
            const retry = worktreeRetryRequest(operation);
            const removed = operation.completed.length;
            const remaining = retry?.action === "destroy" && retry.target.kind === "slots" ? retry.target.slotIds.length : null;
            return (
              <li key={operation.id} className="wt-operation wt-operation-failed">
                <StateChip label={removed > 0 ? "partly done" : "failed"} tone="danger" />
                <span>
                  <strong>{ACTION_VERBS[operation.request.action]}</strong> <code>{operationSubject(operation)}</code>
                  {operation.changed ? <em>State changed after this preview.</em> : null}
                  {removed > 0 && (
                    <em>
                      {removed} {removed === 1 ? "worktree was" : "worktrees were"} removed before this stopped
                      {remaining !== null ? `; ${remaining} left in place` : ""}.
                    </em>
                  )}
                  {removed > 0 && (
                    <ul className="wt-operation-removed" aria-label="Already removed">
                      {operation.completed.map((target) => <li key={target.id}><code>{target.path}</code></li>)}
                    </ul>
                  )}
                  <span className="wt-operation-error">{operation.error}</span>
                </span>
                <span className="wt-operation-actions">
                  {retry && (
                    <Tooltip label={removed > 0 ? "Build a new safety preview for only what this left in place" : "Build a new safety preview for the same request from current state"}>
                      <button className="btn btn-secondary" type="button" onClick={(event) => onRetry(operation, retry, event.currentTarget)}>Preview again</button>
                    </Tooltip>
                  )}
                  <Tooltip label={removed > 0
                    ? "Hide this report; the worktrees listed as removed stay removed"
                    // No confirmed removal is not proof of no change: a task or check owner
                    // may already have been recovered before the failure. Stay neutral.
                    : "Hide this report; dismissing it does not undo or retry anything"}>
                    <button className="btn btn-ghost" type="button" onClick={() => onDismiss(operation)}>Dismiss</button>
                  </Tooltip>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const WARM_TARGET_CHIPS: Record<WorktreeWarmTargetOutcome, { label: string; tone: string }> = {
  pending: { label: "waiting", tone: "neutral" },
  running: { label: "warming", tone: "working" },
  warmed: { label: "warmed", tone: "ready" },
  claimFailed: { label: "claim failed", tone: "danger" },
  skipped: { label: "skipped", tone: "attention" },
  cancelled: { label: "cancelled", tone: "attention" },
  failed: { label: "failed", tone: "danger" },
};

function warmTitle(operation: WorktreeOperationView): string {
  const request = operation.request;
  if (request.action === "warm" && request.target.kind === "pool") return "Warm idle slots";
  const target = operation.warm?.targets[0];
  return target ? `Warm slot ${target.ordinal}` : "Warm";
}

function warmStateChip(operation: WorktreeOperationView): { label: string; tone: string } {
  switch (operation.state) {
    case "queued":
      return { label: operation.warm?.cancelRequested ? "cancelled" : "queued", tone: "working" };
    case "running":
      return { label: operation.warm?.cancelRequested ? "cancelling" : "in progress", tone: "working" };
    case "failed":
      return { label: "failed", tone: "danger" };
    case "finished":
      return { label: "finished", tone: "ready" };
  }
}

/**
 * One Warm: its slots and what happened to each, the live output tail while it runs, Cancel,
 * and the full log. A finished Warm stays listed until it is dismissed, so a slot it skipped
 * is still listed as skipped after the Warm moves on.
 */
function WarmOperation({
  operation,
  onCancel,
  onDismiss,
}: {
  operation: WorktreeOperationView;
  onCancel: (operation: WorktreeOperationView) => void;
  onDismiss: (operation: WorktreeOperationView) => void;
}): React.JSX.Element {
  const warm = operation.warm;
  const pending = worktreeOperationPending(operation);
  const title = warmTitle(operation);
  const chip = warmStateChip(operation);
  const tail = useRef<HTMLPreElement>(null);
  // The tail follows the newest output, as a terminal does.
  useEffect(() => {
    const node = tail.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [warm?.tail]);
  return (
    <li className="wt-operation wt-warm" aria-label={title}>
      <div className="wt-warm-head">
        <StateChip label={chip.label} tone={chip.tone} />
        <strong>{title}</strong>
        <span className="wt-operation-actions">
          {warm?.log && (
            <Tooltip label={`Download this Warm's full log, kept at ${warm.log.path}`}>
              <a
                className="btn btn-ghost"
                aria-label={`Download the full log of ${title}`}
                href={worktreeWarmLogUrl(warm.log.id)}
                download={`worktree-warm-${warm.log.id}.log`}
              >
                Full log
              </a>
            </Tooltip>
          )}
          {pending && (
            <Tooltip label="Stop the running step's process group and return the slot to the pool; slots not reached yet are left alone">
              <button className="btn btn-secondary" type="button" disabled={warm?.cancelRequested} onClick={() => onCancel(operation)}>
                {warm?.cancelRequested ? "Cancelling…" : "Cancel"}
              </button>
            </Tooltip>
          )}
          {!pending && (
            <Tooltip label="Hide this Warm's report; the slots keep their dependencies and their last log">
              <button className="btn btn-ghost" type="button" onClick={() => onDismiss(operation)}>Dismiss</button>
            </Tooltip>
          )}
        </span>
      </div>
      {warm && (
        <ul className="wt-warm-targets" aria-label={`${title} slots`}>
          {warm.targets.map((target) => {
            const outcome = WARM_TARGET_CHIPS[target.outcome];
            return (
              <li key={target.slotId}>
                <StateChip label={outcome.label} tone={outcome.tone} />
                <span>Slot {target.ordinal}</span>
                <Tooltip label={target.path}><code className="wt-warm-path">{target.path}</code></Tooltip>
                {target.detail && <span className="wt-warm-detail">{target.detail}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {warm && (pending || warm.tail) && (
        <pre ref={tail} className="wt-deps-tail wt-warm-tail" aria-label={`${title} output`} tabIndex={0}>
          {warm.tail ? warm.tail.replace(/\n+$/, "") : pending ? "Waiting for output…" : ""}
        </pre>
      )}
      {warm && warm.truncatedBytes > 0 && (
        <p className="wt-warm-note">Showing the last part of the output; the full log has the rest.</p>
      )}
      {operation.error && <span className="wt-operation-error">{operation.error}</span>}
    </li>
  );
}

function WarmOperations({
  operations,
  onCancel,
  onDismiss,
}: {
  operations: WorktreeOperationView[];
  onCancel: (operation: WorktreeOperationView) => void;
  onDismiss: (operation: WorktreeOperationView) => void;
}): React.JSX.Element | null {
  if (operations.length === 0) return null;
  return (
    <section className="wt-operations wt-warm-operations" aria-label="Warm operations">
      <ul className="wt-operation-list">
        {operations.map((operation) => (
          <WarmOperation key={operation.id} operation={operation} onCancel={onCancel} onDismiss={onDismiss} />
        ))}
      </ul>
    </section>
  );
}

/**
 * The pane's one new primitive, and the only place its boldness is spent.
 *
 * The track's width is the pool's configured maximum, so the hatched remainder reads as
 * room to grow and lowering `Default maximum` visibly reflows every bar. All of the
 * arithmetic lives in `capacityGeometry`; this only paints it.
 *
 * Nothing here is carried by colour, or by the absence of it. Every lifecycle count is
 * restated as text in the legend beneath the bar - zeroes included, since a state the
 * track cannot paint is still a state the operator asked about - and the bar itself is a
 * `role="img"` with a composed label naming all four counts and the maximum. Over capacity
 * is spelled out in words; the amber hatching is a second cue, never the only one.
 *
 * The track is the configured maximum and nothing else, so 100% of it is `maxSlots` on
 * every bar and lowering `Default maximum` rewidths every segment drawn against it. An
 * over-capacity pool therefore fills its ceiling and spills: the excess cannot be laid out
 * inside a track that by definition has no room for it, so it is carried by the hatched cap
 * pinned to the track's end, by `N over the maximum` in the legend, and by the sentence and
 * right-size preview below. The cap is a fixed width because it marks that there IS spill,
 * not how much - the count says how much.
 */
function CapacityBar({ geometry }: { geometry: CapacityGeometry }): React.JSX.Element {
  return (
    <div className="wt-bar" role="img" aria-label={geometry.label}>
      {geometry.segments.map((segment) => (
        <span
          key={segment.key}
          className={`wt-bar-seg wt-bar-${segment.key}`}
          style={{ width: `${segment.percent}%` }}
        />
      ))}
      {geometry.overflow && <span className="wt-bar-over" />}
    </div>
  );
}

/**
 * Reads `geometry.legend`, never `geometry.segments`: the track drops a zero-count state
 * because it has no width, but "0 available" is precisely what an operator asking "do I
 * have room" needs told. All four lifecycle counts appear here in every state.
 */
function CapacityLegend({ geometry }: { geometry: CapacityGeometry }): React.JSX.Element {
  return (
    <ul className="wt-legend">
      {geometry.legend.map((entry) => (
        <li key={entry.key} className={`wt-legend-item wt-legend-${entry.key}${entry.count === 0 ? " wt-legend-zero" : ""}`}>
          <span className="wt-swatch" aria-hidden />
          {entry.label}
        </li>
      ))}
      {geometry.overflow && (
        <li className="wt-legend-item wt-legend-over">
          <span className="wt-swatch" aria-hidden />
          {geometry.overflow.label}
        </li>
      )}
    </ul>
  );
}

const DEPENDENCY_CHIPS: Record<WorktreeSlotDependencyState, { label: string; tone: string }> = {
  never: { label: "never installed", tone: "neutral" },
  current: { label: "current", tone: "ready" },
  stale: { label: "stale", tone: "attention" },
  installing: { label: "installing", tone: "working" },
  failed: { label: "failed", tone: "danger" },
  interrupted: { label: "interrupted", tone: "attention" },
};

/** What one dependency state says beneath its chip. Exhaustive over the view's states. */
function DependencyDetail({
  slotId,
  ordinal,
  dependencies,
  now,
}: {
  slotId: string;
  ordinal: number;
  dependencies: WorktreeSlotDependenciesView;
  now: number;
}): React.JSX.Element {
  switch (dependencies.state) {
    case "never":
      return <p className="wt-deps-detail">No claim has run in this slot. Its next task lease runs every step.</p>;
    case "current":
      return (
        <p className="wt-deps-detail">
          {dependencies.defaultSha
            ? <>Matches the fetched default branch at <code>{shortSha(dependencies.defaultSha)}</code>.</>
            : "The last claim succeeded."}
        </p>
      );
    case "stale":
      return (
        <p className="wt-deps-detail">
          The fetched default branch at <code>{shortSha(dependencies.defaultSha)}</code> needs different
          dependencies. The next lease runs the claim again.
        </p>
      );
    case "installing":
      return (
        <>
          <p className="wt-deps-detail">
            {dependencies.step ? `Step ${dependencies.step.step} of ${dependencies.step.stepCount}` : "Reading the fingerprint"}
            {" · "}
            <span>{formatElapsed(now - dependencies.startedAt)} elapsed</span>
          </p>
          {dependencies.step && (
            <Tooltip label={dependencies.step.command}>
              <code className="wt-deps-clamp" aria-label={`Running command: ${dependencies.step.command}`}>{dependencies.step.command}</code>
            </Tooltip>
          )}
          <div className="wt-deps-actions">
            <ClaimStopButton
              slotId={slotId}
              claimId={dependencies.claimId}
              label={`Stop slot ${ordinal} dependency claim`}
            />
          </div>
        </>
      );
    case "failed": {
      const { failure } = dependencies;
      return (
        <>
          <p className="wt-deps-detail">
            {failure.step !== null ? `Step ${failure.step} of ${failure.stepCount} ${failure.reason}.` : failure.reason}
          </p>
          {failure.command && (
            <Tooltip label={failure.command}>
              <code className="wt-deps-clamp" aria-label={`Failed command: ${failure.command}`}>{failure.command}</code>
            </Tooltip>
          )}
          <p className="wt-deps-detail">The next lease runs the claim again.</p>
          {failure.tailWithheld && (
            <p className="wt-deps-detail">
              This failure was recorded by an earlier version, before claim variable values were
              redacted from step output, so its output is not shown.
            </p>
          )}
          {failure.tail && (
            <pre className="wt-deps-tail" aria-label={`Slot ${ordinal} dependency output tail`} tabIndex={0}>{failure.tail.replace(/\n+$/, "")}</pre>
          )}
        </>
      );
    }
    case "interrupted":
      return (
        <p className="wt-deps-detail">
          A restart, or a stop during a seed, cut off this slot&rsquo;s last claim. Its next claim
          removes the seed paths and starts cold.
        </p>
      );
    default: {
      const unreachable: never = dependencies;
      return unreachable;
    }
  }
}

/**
 * The slot's dependency claim state. Every state is said in words beside its chip, so none of
 * them is carried by colour. Stale is judged against the last fetched default ref; this view
 * never asks the daemon to fetch.
 */
function SlotDependencies({
  slotId,
  ordinal,
  dependencies,
}: {
  slotId: string;
  ordinal: number;
  dependencies: WorktreeSlotDependenciesView;
}): React.JSX.Element {
  const now = useNow(dependencies.state === "installing");
  const chip = DEPENDENCY_CHIPS[dependencies.state];
  return (
    <section className="wt-deps" aria-label={`Slot ${ordinal} dependencies`}>
      <div className="wt-deps-head">
        <span className="wt-deps-title">Dependencies</span>
        <StateChip label={chip.label} tone={chip.tone} />
        {dependencies.fingerprintSha && (
          <span className="wt-deps-commit">at <code>{shortSha(dependencies.fingerprintSha)}</code></span>
        )}
      </div>
      <DependencyDetail slotId={slotId} ordinal={ordinal} dependencies={dependencies} now={now} />
    </section>
  );
}

/** The settings anchor of one slot card, which a Storage problem links to. */
export function worktreeSlotAnchor(slotId: string): string {
  return `worktrees/slot/${slotId}`;
}

/** The settings anchor of one Unowned trees row, which a Storage problem links to. */
export function worktreeUnownedTreeAnchor(path: string): string {
  return `worktrees/unowned/${path}`;
}

/** The way to a process a live session owns, offered instead of Kill: it ends from there. */
function OpenSession({
  session,
  onOpenSession,
}: {
  session: ProcessSession;
  onOpenSession?: (sessionId: string) => void;
}): React.JSX.Element {
  return (
    <Tooltip label="Focus the session this process belongs to; end it from there">
      <button className="btn btn-ghost" type="button" onClick={() => onOpenSession?.(session.id)}>
        Open session
      </button>
    </Tooltip>
  );
}

/**
 * Processes still running in a tree with no live owner, each with a guarded Kill, and a Kill all
 * that confirms every killable process at once when there is more than one. A live session's
 * process stays listed, because it still holds the tree, but it offers Open session instead.
 */
function OrphanList({
  label,
  orphans,
  killHint,
  onKill,
  onOpenSession,
}: {
  label: string;
  orphans: readonly OrphanProcess[];
  killHint: string;
  onKill: (orphans: readonly OrphanProcess[], trigger: HTMLButtonElement) => void;
  onOpenSession?: (sessionId: string) => void;
}): React.JSX.Element | null {
  if (orphans.length === 0) return null;
  const killable = orphans.filter((orphan) => !orphan.session);
  return (
    <section className="wt-orphans" aria-label={label}>
      <div className="wt-orphans-head">
        <h5>Orphan processes</h5>
        {killable.length > 1 && (
          <Tooltip label={`Confirm stopping the ${killable.length} processes here that offer Kill`}>
            <button className="btn btn-danger" type="button" onClick={(event) => onKill(killable, event.currentTarget)}>
              Kill all
            </button>
          </Tooltip>
        )}
      </div>
      <ul>
        {orphans.map((orphan) => (
          <li key={`${orphan.pid}:${orphan.startedAt}`} className="wt-orphan">
            <div>
              {orphan.knownOwner && <strong>{orphan.knownOwner}</strong>}
              <code>{orphan.command}</code>
              <span>PID {orphan.pid} · parent {orphan.ppid} · started {startedLabel(orphan.startedAt)}</span>
            </div>
            {orphan.session ? <OpenSession session={orphan.session} onOpenSession={onOpenSession} /> : (
              <Tooltip label={killHint}>
                <button className="btn btn-danger" type="button" aria-label={`Kill process ${orphan.pid}`} onClick={(event) => onKill([orphan], event.currentTarget)}>
                  Kill
                </button>
              </Tooltip>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A tree outside the pools, under `worktrees/` or `check-worktrees/`, as Storage reports it. */
export interface UnownedTreeEntry {
  path: string;
  /** The `dirty-orphan-folder` problem when the sweep kept this tree for its work. */
  kept: StorageProblem | null;
  orphans: OrphanProcess[];
}

/** Every tree a Storage problem links to as an unowned tree, in the order Storage lists them. */
export function unownedTreeEntries(health: StorageHealth | null): UnownedTreeEntry[] {
  const byPath = new Map<string, UnownedTreeEntry>();
  for (const problem of health?.problems ?? []) {
    if (problem.link.target !== "unowned-tree") continue;
    const path = problem.link.path;
    const entry = byPath.get(path) ?? { path, kept: null, orphans: [] };
    if (problem.kind === "dirty-orphan-folder") entry.kept = problem;
    if (problem.kind === "orphan-process" && problem.process) entry.orphans.push(problem.process);
    byPath.set(path, entry);
  }
  return [...byPath.values()];
}

function UnownedTreeRow({
  entry,
  pending,
  onAction,
  onKill,
  onOpenSession,
}: {
  entry: UnownedTreeEntry;
  pending: boolean;
  onAction: (request: WorktreeActionRequest, trigger: HTMLButtonElement) => void;
  onKill: (orphans: readonly OrphanProcess[], trigger: HTMLButtonElement) => void;
  onOpenSession?: (sessionId: string) => void;
}): React.JSX.Element {
  const copy = useCopyFeedback({ resetOn: entry.path });
  return (
    <article className="wt-unowned" aria-label={`Unowned tree ${entry.path}`} data-anchor={worktreeUnownedTreeAnchor(entry.path)}>
      <div className="wt-unowned-head">
        <code>{entry.path}</code>
        {entry.kept && <StateChip label="kept" tone="attention" />}
        {pending && <StateChip label="queued" />}
      </div>
      {entry.kept && <p className="wt-diagnostic">{entry.kept.message}</p>}
      <OrphanList
        label={`Orphan processes in ${entry.path}`}
        orphans={entry.orphans}
        killHint="Confirm stopping this process, which keeps the unowned tree from being swept"
        onKill={onKill}
        onOpenSession={onOpenSession}
      />
      <div className="wt-slot-actions">
        <Tooltip label={copy.copied ? COPY_FEEDBACK_LABEL : "Copy exact tree path"}>
          <button className="btn btn-ghost" type="button" onClick={() => void copy.copy(entry.path)}>
            {copy.copied ? "Copied" : "Copy path"}
          </button>
        </Tooltip>
        {entry.kept && !pending && (
          <Tooltip label="Preview discarding this tree's work and removing the folder">
            <button className="btn btn-danger" type="button" onClick={(event) => onAction({ action: "removeUnowned", path: entry.path }, event.currentTarget)}>
              Discard and remove
            </button>
          </Tooltip>
        )}
      </div>
      {copy.error && <p className="settings-error">{copy.error}</p>}
    </article>
  );
}

function SlotCard({
  slot,
  pending,
  stuckReturn,
  selected,
  selectionFull,
  onSelect,
  onAction,
  orphans,
  onKill,
  onOpenSession,
}: {
  slot: NativeWorktreeSlotView;
  /** A queued or running cleanup already covers this slot; no second one may be started. */
  pending: WorktreeOperationView | null;
  /** The `stuck-return` storage problem of the owner holding this slot, if its return is stuck. */
  stuckReturn: StorageProblem | null;
  selected: boolean;
  /** The bulk selection holds its maximum; an unticked slot cannot join it. */
  selectionFull: boolean;
  onSelect: (slotId: string, selected: boolean) => void;
  onAction: (request: WorktreeActionRequest, trigger: HTMLButtonElement) => void;
  /** Processes still running in this slot with no live owner, from the storage report. */
  orphans: readonly OrphanProcess[];
  onKill: (orphans: readonly OrphanProcess[], trigger: HTMLButtonElement) => void;
  onOpenSession?: (sessionId: string) => void;
}): React.JSX.Element {
  const copy = useCopyFeedback({ resetOn: slot.path });
  const terminals = useTerminalTargets();
  const [openError, setOpenError] = useState<string | null>(null);
  const [terminalId, setTerminalId] = useState<TerminalBackendId | null>(null);
  const terminal = terminals.targets?.find((target) => target.id === terminalId && target.unavailable === null)
    ?? terminals.targets?.find((target) => target.unavailable === null)
    ?? null;
  useEffect(() => {
    if (terminal && terminal.id !== terminalId) setTerminalId(terminal.id);
  }, [terminal, terminalId]);
  const tone = slot.state === "available"
    ? "ready"
    : slot.state === "quarantined"
      ? "danger"
      : slot.state === "leased"
        ? "working"
        : "attention";

  async function openTerminal(): Promise<void> {
    if (!terminal) return;
    setOpenError(null);
    const result = await openWorktreeTerminal(slot.id, terminal.id);
    if (!result.ok) setOpenError(result.error);
  }

  return (
    <article className={`wt-slot wt-slot-${tone}`} aria-label={`Slot ${slot.ordinal}`} data-anchor={worktreeSlotAnchor(slot.id)}>
      <div className="wt-slot-head">
        {slot.actions.includes("destroy") && (
          <Tooltip label={pending
            ? "A cleanup for this slot is already queued"
            : selectionFull && !selected
              ? `Bulk destroy is limited to ${BULK_SELECTION_LIMIT} slots; untick one to add this`
              : "Include this slot in the next bulk destroy preview"}>
            <input
              className="wt-slot-select"
              type="checkbox"
              aria-label={`Select slot ${slot.ordinal} for bulk destroy`}
              checked={selected}
              // A pending slot cannot be newly added, but one already in the selection can
              // still be unticked: the selection is only ever changed by the operator.
              disabled={!selected && (pending !== null || selectionFull)}
              onChange={(event) => onSelect(slot.id, event.target.checked)}
            />
          </Tooltip>
        )}
        <strong>Slot {slot.ordinal}</strong>
        <StateChip label={slot.state} tone={tone} />
        {pending && <StateChip label={`${ACTION_VERBS[pending.request.action].toLowerCase()} ${pending.state === "running" ? "in progress" : "queued"}`} tone="working" />}
        {slot.dirty === true && <StateChip label="dirty" tone="danger" />}
        {slot.staleSince !== null && (
          <Tooltip label={`Still leased, with no Git-visible change since ${new Date(slot.staleSince).toLocaleDateString()}. Listed in Settings > Storage; never reclaimed automatically.`}>
            <StateChip label="stale" tone="attention" />
          </Tooltip>
        )}
        {slot.defaultRelation === "unmerged" && <StateChip label="unlanded" tone="attention" />}
        {slot.processes.state === "unknown" && <StateChip label="processes unknown" tone="danger" />}
        {stuckReturn && <StateChip label="return stuck" tone="danger" />}
      </div>
      <Tooltip label={slot.path}>
        <code className="wt-path">{slot.path}</code>
      </Tooltip>
      <dl className="wt-facts">
        <div><dt>HEAD</dt><dd><code>{shortSha(slot.head)}</code></dd></div>
        <div><dt>Default</dt><dd>{slot.defaultRelation}</dd></div>
        <div><dt>Processes</dt><dd>{slot.processes.count ?? "unknown"}</dd></div>
        <div><dt>Disk</dt><dd>{bytes(slot.diskBytes)}</dd></div>
      </dl>
      {slot.dependencies && <SlotDependencies slotId={slot.id} ordinal={slot.ordinal} dependencies={slot.dependencies} />}
      {slot.warmLog && (
        <p className="wt-warm-log">
          <Tooltip label={`Download the full log of the last Warm that held this slot, kept at ${slot.warmLog.path}`}>
            <a
              aria-label={`Download slot ${slot.ordinal}'s last Warm log`}
              href={worktreeWarmLogUrl(slot.warmLog.id)}
              download={`worktree-warm-${slot.warmLog.id}.log`}
            >
              Last Warm log
            </a>
          </Tooltip>
        </p>
      )}
      {slot.owner && <p className="wt-owner"><span>{slot.owner.kind}</span> {slot.owner.label}</p>}
      {/* The daemon offers Return on a quarantine only while its owner still references it. */}
      {slot.state === "quarantined" && slot.owner && slot.actions.includes("return") && (
        <p className="wt-owner">Its owner's return brings this slot back.</p>
      )}
      {stuckReturn && <p className="wt-diagnostic wt-stuck-return">{stuckReturn.message}</p>}
      <SlotDiagnosis slot={slot} orphans={orphans} onOpenSession={onOpenSession} />
      <OrphanList
        label={`Orphan processes in slot ${slot.ordinal}`}
        orphans={orphans}
        killHint={slot.state === "available"
          ? "Confirm stopping this process, which keeps this slot from being leased"
          : "Confirm stopping this process, which outlived the slot's owner and blocks its return"}
        onKill={onKill}
        onOpenSession={onOpenSession}
      />
      <div className="wt-slot-actions">
        <Tooltip label={copy.copied ? COPY_FEEDBACK_LABEL : "Copy exact worktree path"}>
          <button className="btn btn-ghost" type="button" onClick={() => void copy.copy(slot.path)}>
            {copy.copied ? "Copied" : "Copy path"}
          </button>
        </Tooltip>
        <Tooltip label="Choose the terminal application that opens this exact worktree path">
          <select
            aria-label={`Terminal backend for slot ${slot.ordinal}`}
            value={terminal?.id ?? ""}
            disabled={!terminals.targets}
            onChange={(event) => setTerminalId(event.target.value as TerminalBackendId)}
          >
            {!terminals.targets && <option value="">Checking terminals…</option>}
            {terminals.targets?.map((target) => <option key={target.id} value={target.id} disabled={target.unavailable !== null}>{target.label}{target.unavailable ? `: ${target.unavailable}` : ""}</option>)}
          </select>
        </Tooltip>
        <Tooltip label={!terminal
          ? "No terminal backend is currently available"
          : slot.state === "available"
            ? `${terminal.blurb} Takes a manual lease on this slot as it stands; Return gives it back.`
            : terminal.blurb}>
          <button className="btn btn-ghost" type="button" disabled={!terminal} onClick={() => void openTerminal()}>Open terminal</button>
        </Tooltip>
        {!pending && slot.actions.includes("warm") && (
          <Tooltip label="Preview preparing this idle slot ahead of time: fetch, reset to origin's default branch, and seed or run the pool's claim">
            <button className="btn btn-ghost" type="button" onClick={(event) => onAction({ action: "warm", target: { kind: "slot", slotId: slot.id } }, event.currentTarget)}>
              Warm
            </button>
          </Tooltip>
        )}
        {!pending && slot.actions.includes("recover") && (
          <Tooltip label="Preview recovering this quarantined slot: remove a stale index.lock when no Git process uses it, then reset it to the remote default">
            <button className="btn btn-secondary" type="button" onClick={(event) => onAction({ action: "recover", slotId: slot.id }, event.currentTarget)}>
              Recover
            </button>
          </Tooltip>
        )}
        {!pending && slot.actions.includes("repair") && (
          <Tooltip label="Preview repairing this slot's Git registration with Git's own fixes, then recovering it. Work is never discarded">
            <button className="btn btn-secondary" type="button" onClick={(event) => onAction({ action: "repair", slotId: slot.id }, event.currentTarget)}>
              Repair
            </button>
          </Tooltip>
        )}
        {!pending && slot.actions.includes("return") && (
          <Tooltip label="Preview returning this slot through its current task, check, or manual lease owner">
            <button className="btn btn-ghost" type="button" onClick={(event) => onAction({ action: "return", slotId: slot.id }, event.currentTarget)}>
              Return
            </button>
          </Tooltip>
        )}
        {!pending && slot.actions.includes("destroy") && (
          <Tooltip label="Preview permanently removing this manager-owned slot">
            <button className="btn btn-danger" type="button" onClick={(event) => onAction({ action: "destroy", target: { kind: "slot", slotId: slot.id } }, event.currentTarget)}>
              Destroy
            </button>
          </Tooltip>
        )}
      </div>
      {(copy.error || openError) && <p className="settings-error">{copy.error ?? openError}</p>}
    </article>
  );
}

/** How a recovery refusal's blocking path is introduced, by the kind of entry it is. */
const BLOCKING_KIND: Record<NonNullable<WorktreeRecoveryRefusalView["blocking"]>["kind"], string> = {
  tracked: "uncommitted change",
  untracked: "untracked file",
  ignored: "ignored file",
  unpushed: "unpushed commits on",
  lock: "lock file",
};

/**
 * Why a slot is in its state, one fact per line, so no fact hides another: the reason, the
 * detail behind it, why its last observation failed, why its processes are unknown, the last
 * automatic-recovery refusal with the exact path that blocked it, and the processes inside it. A process the orphan list already
 * names, with its Kill or Open session, is not listed twice.
 */
function SlotDiagnosis({
  slot,
  orphans,
  onOpenSession,
}: {
  slot: NativeWorktreeSlotView;
  orphans: readonly OrphanProcess[];
  onOpenSession?: (sessionId: string) => void;
}): React.JSX.Element | null {
  const detail = slot.diagnostic !== slot.quarantineReason ? slot.diagnostic : null;
  const refusal = slot.recoveryRefusal;
  const inOrphanList = new Set(orphans.map((orphan) => orphan.pid));
  const occupants = slot.occupants.filter((occupant) => !inOrphanList.has(occupant.pid));
  const unlisted = Math.max(0, (slot.processes.count ?? 0) - slot.occupants.length);
  const facts = Boolean(slot.quarantineReason || detail || slot.observationFailure || slot.processes.reason || refusal);
  if (!facts && occupants.length === 0 && unlisted === 0) return null;
  return (
    <>
      {facts && (
        <section className="wt-why" aria-label={`Why slot ${slot.ordinal} is ${slot.state}`}>
          <dl>
            {slot.quarantineReason && <div><dt>Reason</dt><dd>{slot.quarantineReason}</dd></div>}
            {detail && <div><dt>Detail</dt><dd>{detail}</dd></div>}
            {slot.observationFailure && <div><dt>Last observation failed</dt><dd>{slot.observationFailure}</dd></div>}
            {slot.processes.reason && <div><dt>Processes</dt><dd>{slot.processes.reason}</dd></div>}
            {refusal && (
              <div>
                <dt>Last automatic recovery</dt>
                <dd>Refused {startedLabel(refusal.at)}: {refusal.reason}</dd>
                {refusal.blocking && (
                  <dd>Blocked by {BLOCKING_KIND[refusal.blocking.kind]} <code>{refusal.blocking.path}</code></dd>
                )}
              </div>
            )}
          </dl>
        </section>
      )}
      {(occupants.length > 0 || unlisted > 0) && (
        <section className="wt-occupants" aria-label={`Processes in slot ${slot.ordinal}`}>
          <h5>Processes inside</h5>
          <ul>
            {occupants.map((occupant) => (
              <li key={`${occupant.pid}:${occupant.startedAt}`}>
                {occupant.knownOwner && <strong>{occupant.knownOwner}</strong>}
                <code>{occupant.command}</code>
                <span>PID {occupant.pid} · started {startedLabel(occupant.startedAt)}</span>
                {occupant.session && <OpenSession session={occupant.session} onOpenSession={onOpenSession} />}
              </li>
            ))}
            {unlisted > 0 && <li><span>and {unlisted} more not listed</span></li>}
          </ul>
        </section>
      )}
    </>
  );
}

function startedLabel(at: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(at));
}

/**
 * The Kill confirmation: what will be signalled, and what happens after. Kill all opens it with
 * every process its list showed, and each one is still guarded on its own by the daemon.
 */
function KillDialog({
  orphans,
  busy,
  errors,
  onClose,
  onConfirm,
}: {
  orphans: readonly OrphanProcess[];
  busy: boolean;
  errors: readonly string[];
  onClose: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  const [only] = orphans;
  const single = orphans.length === 1 ? only : null;
  const trees = [...new Set(orphans.map((orphan) => orphan.tree))];
  return (
    <Overlay id={OVERLAY_IDS.worktreeKill} onClose={onClose} className="modal wt-action-modal" role="dialog" ariaLabel={single ? "Kill orphan process" : "Kill orphan processes"} closable={!busy}>
      <header className="modal-head">
        <div><span className="wt-eyebrow">Confirm first</span><h3>{single ? `Kill process ${single.pid}` : `Kill ${orphans.length} processes`}</h3></div>
      </header>
      <div className="modal-body wt-action-body">
        {single ? (
          <>
            <dl className="wt-facts wt-kill-facts">
              <div><dt>PID</dt><dd>{single.pid}</dd></div>
              <div><dt>Parent PID</dt><dd>{single.ppid}</dd></div>
              <div><dt>Started</dt><dd>{startedLabel(single.startedAt)}</dd></div>
            </dl>
            <section><h4>Command</h4><code className="wt-kill-text">{single.command}</code></section>
          </>
        ) : (
          <section>
            <h4>Processes</h4>
            <ul className="wt-kill-list" aria-label="Processes to kill">
              {orphans.map((orphan) => (
                <li key={`${orphan.pid}:${orphan.startedAt}`}>
                  <code className="wt-kill-text">{orphan.command}</code>
                  <span>PID {orphan.pid} · parent {orphan.ppid} · started {startedLabel(orphan.startedAt)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section><h4>Tree</h4>{trees.map((tree) => <code key={tree} className="wt-kill-text">{tree}</code>)}</section>
        <section>
          <h4>What happens</h4>
          <ul>
            {single
              ? <li>Mission Control checks that this process is still in the tree with the same start time and command, and refuses otherwise.</li>
              : <li>Mission Control checks each process is still in the tree with the same start time and command, and refuses that one otherwise.</li>}
            <li>It sends SIGTERM, then SIGKILL if {single ? "the process is" : "a process is"} still running 5 seconds later.</li>
            <li>Any return this tree was waiting on is retried at once.</li>
          </ul>
        </section>
        {errors.length > 0 && (
          <div className="settings-error" role="alert">
            {errors.map((error, index) => <p key={index}>{error}</p>)}
          </div>
        )}
      </div>
      <footer className="modal-foot">
        <Tooltip label={single ? "Close without signalling the process" : "Close without signalling any process"}>
          <button className="btn btn-ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </Tooltip>
        <Tooltip label={single
          ? "Send SIGTERM now, and SIGKILL after 5 seconds if it is still running"
          : "Send each process SIGTERM now, and SIGKILL after 5 seconds if it is still running"}>
          <button className="btn btn-danger" type="button" onClick={onConfirm} disabled={busy}>
            {busy ? "Killing…" : single ? "Kill process" : `Kill ${orphans.length} processes`}
          </button>
        </Tooltip>
      </footer>
    </Overlay>
  );
}

function FieldErrors({ id, messages }: { id: string; messages: readonly string[] | undefined }): React.JSX.Element | null {
  if (!messages || messages.length === 0) return null;
  return (
    <ul className="wt-claim-errors" id={id}>
      {messages.map((message, index) => <li key={index} className="settings-error">{message}</li>)}
    </ul>
  );
}

const VARIABLE_SOURCES: Record<WorktreeClaimVariableSource, string> = {
  daemon: "in the daemon environment",
  loginShell: "in the login shell",
};

/**
 * Each name a step lists, with whether a step would receive a value for it. The daemon answers
 * for saved names only, so a name typed since the last save says so instead of guessing.
 */
function VariablePresence({
  step,
  names,
  saved,
}: {
  step: number;
  names: readonly string[];
  saved: ReadonlyMap<string, WorktreeClaimVariableView>;
}): React.JSX.Element | null {
  if (names.length === 0) return null;
  return (
    <ul className="wt-claim-vars" aria-label={`Step ${step} variable presence`}>
      {names.map((name) => {
        const known = saved.get(name);
        return (
          <li key={name}>
            <code>{name}</code>
            {!known
              ? <StateChip label="save to check" />
              : known.present
                ? <StateChip label="present" tone="ready" />
                : <StateChip label="missing" tone="danger" />}
            <span className="wt-claim-var-where">
              {!known
                ? "not checked until saved"
                : known.source
                  ? VARIABLE_SOURCES[known.source]
                  : "in neither the daemon environment nor the login shell"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The pool's dependency claim: ordered steps, each with the variable names it may receive,
 * the timeout and the fingerprint paths. It saves through the worktrees settings route as one
 * whole claim, and whatever the route's schema refuses is shown beside the field it names.
 * Values never appear here: the daemon reports only whether each name has one, and where.
 */
function ClaimEditor({
  repo,
  updateConfig,
}: {
  repo: WorktreeRepositoryView;
  updateConfig: WorktreesState["updateConfig"];
}): React.JSX.Element {
  const savedKey = JSON.stringify(repo.policy.claim);
  const [draft, setDraft] = useState<ClaimDraft>(() => draftFromClaim(repo.policy.claim));
  const [errors, setErrors] = useState<ClaimDraftErrors>(emptyClaimErrors);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  // A save, someone else's save, or a restore replaces the draft with what is now stored.
  useEffect(() => {
    setDraft(draftFromClaim(repo.policy.claim));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);
  const presence = useMemo(
    () => new Map(repo.claimVariables.map((entry) => [entry.name, entry])),
    [repo.claimVariables],
  );
  const base = `wt-claim-${repo.id}`;

  function changeStep(index: number, change: Partial<ClaimStepDraft>): void {
    setSaved(null);
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step, at) => at === index ? { ...step, ...change } : step),
    }));
  }

  async function save(claim: unknown | null): Promise<void> {
    setSaving(true);
    setSaved(null);
    setErrors(emptyClaimErrors());
    let result: WorktreesConfigUpdate;
    try {
      result = await updateConfig(
        { repositories: { [repo.commonDirectory]: { claim: claim as WorktreeClaim | null } } },
        { inline: true },
      );
    } catch (error) {
      // `updateConfig` reports every outcome as a value; this is the editor's own guard, so a
      // future rejection still leaves Save usable and says why.
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      setSaving(false);
    }
    if (result.ok) {
      setSaved(claim === null ? "Claim removed." : "Claim saved.");
      return;
    }
    setErrors(claimErrorsFrom(result.error, draft));
  }

  const invalid = hasClaimErrors(errors);
  return (
    <fieldset className="wt-argv wt-claim" aria-describedby={invalid ? `${base}-general` : undefined}>
      <legend>Dependency claim, run on every task lease</legend>
      <p className="wt-claim-note">
        Each step is an argv, never a shell. A step receives only the variables it names, from the
        daemon&rsquo;s environment or the login shell. Mission Control stores names, never values.
      </p>
      {draft.steps.length === 0 && (
        <p className="wt-claim-note">{repo.policy.claim ? "Every step was removed from this draft." : "No claim is configured. Add a step to set one up."}</p>
      )}
      {draft.steps.map((step, index) => {
        const number = index + 1;
        return (
          <fieldset className="wt-claim-step" key={index}>
            <legend>Step {number}</legend>
            <label htmlFor={`${base}-argv-${index}`}>Step {number} command, one argument per line</label>
            <textarea
              id={`${base}-argv-${index}`}
              rows={Math.min(6, Math.max(2, draftLines(step.argv).length + 1))}
              spellCheck={false}
              value={step.argv}
              aria-invalid={errors.argv[index] ? true : undefined}
              aria-describedby={errors.argv[index] ? `${base}-argv-${index}-errors` : undefined}
              onChange={(event) => changeStep(index, { argv: event.target.value })}
            />
            <FieldErrors id={`${base}-argv-${index}-errors`} messages={errors.argv[index]} />
            <label htmlFor={`${base}-env-${index}`}>Step {number} variable names</label>
            <input
              id={`${base}-env-${index}`}
              spellCheck={false}
              placeholder="ARTIFACTORY_AUTH_TOKEN"
              value={step.env}
              aria-invalid={errors.env[index] ? true : undefined}
              aria-describedby={errors.env[index] ? `${base}-env-${index}-errors` : undefined}
              onChange={(event) => changeStep(index, { env: event.target.value })}
            />
            <FieldErrors id={`${base}-env-${index}-errors`} messages={errors.env[index]} />
            <VariablePresence step={number} names={draftNames(step.env)} saved={presence} />
            <Tooltip label={`Remove step ${number} from this draft`}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setSaved(null);
                  setDraft((current) => ({ ...current, steps: current.steps.filter((_, at) => at !== index) }));
                  // The errors move with their steps, so a refusal stays on the field that caused it.
                  setErrors((current) => withoutStepErrors(current, index));
                }}
              >
                Remove step {number}
              </button>
            </Tooltip>
          </fieldset>
        );
      })}
      <FieldErrors id={`${base}-steps-errors`} messages={errors.steps} />
      <div className="wt-claim-fields">
        <label htmlFor={`${base}-timeout`}>Claim timeout in minutes, for every step together</label>
        <input
          id={`${base}-timeout`}
          className="wt-number"
          inputMode="numeric"
          value={draft.timeoutMinutes}
          aria-invalid={errors.timeoutMinutes.length > 0 ? true : undefined}
          aria-describedby={errors.timeoutMinutes.length > 0 ? `${base}-timeout-errors` : undefined}
          onChange={(event) => {
            setSaved(null);
            setDraft((current) => ({ ...current, timeoutMinutes: event.target.value }));
          }}
        />
        <FieldErrors id={`${base}-timeout-errors`} messages={errors.timeoutMinutes} />
        <label htmlFor={`${base}-fingerprint`}>Fingerprint paths, one repository-relative glob per line</label>
        <textarea
          id={`${base}-fingerprint`}
          rows={Math.min(8, Math.max(2, draftLines(draft.fingerprintPaths).length + 1))}
          spellCheck={false}
          placeholder={"yarn.lock\npackage.json"}
          value={draft.fingerprintPaths}
          aria-invalid={errors.fingerprintPaths.length > 0 ? true : undefined}
          aria-describedby={errors.fingerprintPaths.length > 0 ? `${base}-fingerprint-errors` : undefined}
          onChange={(event) => {
            setSaved(null);
            setDraft((current) => ({ ...current, fingerprintPaths: event.target.value }));
          }}
        />
        <FieldErrors id={`${base}-fingerprint-errors`} messages={errors.fingerprintPaths} />
        <p className="wt-claim-note">With no fingerprint paths the claim runs on every lease.</p>
        <label htmlFor={`${base}-seed-paths`}>Seed paths, one repository-relative glob per line</label>
        <textarea
          id={`${base}-seed-paths`}
          rows={Math.min(8, Math.max(2, draftLines(draft.seedPaths).length + 1))}
          spellCheck={false}
          placeholder={"node_modules\napps/*/node_modules"}
          value={draft.seedPaths}
          aria-invalid={errors.seedPaths.length > 0 ? true : undefined}
          aria-describedby={errors.seedPaths.length > 0 ? `${base}-seed-paths-errors` : undefined}
          onChange={(event) => {
            setSaved(null);
            setDraft((current) => ({ ...current, seedPaths: event.target.value }));
          }}
        />
        <FieldErrors id={`${base}-seed-paths-errors`} messages={errors.seedPaths} />
        <label htmlFor={`${base}-seed-exclude`}>Seed exclusions, one repository-relative glob per line</label>
        <textarea
          id={`${base}-seed-exclude`}
          rows={Math.min(6, Math.max(2, draftLines(draft.seedExclude).length + 1))}
          spellCheck={false}
          placeholder="**/node_modules/.cache"
          value={draft.seedExclude}
          aria-invalid={errors.seedExclude.length > 0 ? true : undefined}
          aria-describedby={errors.seedExclude.length > 0 ? `${base}-seed-exclude-errors` : undefined}
          onChange={(event) => {
            setSaved(null);
            setDraft((current) => ({ ...current, seedExclude: event.target.value }));
          }}
        />
        <FieldErrors id={`${base}-seed-exclude-errors`} messages={errors.seedExclude} />
        <p className="wt-claim-note">
          A cold slot (new, never claimed, failed or interrupted) clones these ignored paths
          copy-on-write from an idle sibling before its steps run. A slot whose last claim succeeded
          seeds only when it is stale and a sibling matches its commit exactly. Where the disk
          cannot clone, there is no seed. With no seed paths, a slot never seeds.
        </p>
      </div>
      <FieldErrors id={`${base}-general`} messages={errors.general} />
      {invalid && (
        <p className="settings-error" role="alert">
          {!hasClaimFieldErrors(errors)
            ? "The claim was not saved."
            : "The claim was not saved. Fix the fields marked above."}
        </p>
      )}
      {saved && <p className="wt-claim-saved" role="status">{saved}</p>}
      <div className="wt-argv-actions">
        <Tooltip label="Add one dependency step after the others">
          <button type="button" className="btn btn-ghost" onClick={() => {
            setSaved(null);
            setDraft((current) => ({ ...current, steps: [...current.steps, { argv: "", env: "" }] }));
          }}>Add step</button>
        </Tooltip>
        <Tooltip label="Save this whole claim for future task leases in this pool">
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => void save(claimFromDraft(draft))}>
            {saving ? "Saving…" : "Save claim"}
          </button>
        </Tooltip>
        <Tooltip label="Remove this pool's claim; future leases run no dependency steps">
          <button type="button" className="btn btn-ghost" disabled={saving || !repo.policy.claim} onClick={() => void save(null)}>Remove claim</button>
        </Tooltip>
      </div>
    </fieldset>
  );
}

/**
 * One pool, one full-width row: the bar needs the width a card grid cannot give it.
 *
 * The disclosure below the bar keeps the per-pool overrides, the maintenance actions, and
 * the bounded slot detail exactly as they were. Only the right-size preview is promoted
 * out of it, onto the over-capacity line, because that line is where the operator learns
 * they need it - and it is rendered exactly once either way.
 */
function PoolRow({
  repo,
  overridden,
  updateConfig,
  pendingBySlot,
  stuckBySlot,
  selected,
  onSelect,
  onAction,
  orphansBySlot,
  onKill,
  onOpenSession,
}: {
  repo: WorktreeRepositoryView;
  overridden: boolean;
  updateConfig: WorktreesState["updateConfig"];
  pendingBySlot: ReadonlyMap<string, WorktreeOperationView>;
  stuckBySlot: ReadonlyMap<string, StorageProblem>;
  selected: ReadonlySet<string>;
  onSelect: (slotIds: string[], selected: boolean) => void;
  onAction: (request: WorktreeActionRequest, trigger: HTMLButtonElement) => void;
  orphansBySlot: ReadonlyMap<string, readonly OrphanProcess[]>;
  onKill: (orphans: readonly OrphanProcess[], trigger: HTMLButtonElement) => void;
  onOpenSession?: (sessionId: string) => void;
}): React.JSX.Element {
  // A slot whose return is stuck, or that holds an orphan process, opens its pool and is always
  // rendered, so the Storage problem that links to its card finds it, with its Kill in view.
  const flagged = (slotId: string) => stuckBySlot.has(slotId) || orphansBySlot.has(slotId);
  const hasFlagged = repo.slots.some((slot) => flagged(slot.id));
  const [open, setOpen] = useState(repo.status !== "ready" || hasFlagged);
  const [setup, setSetup] = useState(repo.policy.setupArgv ?? []);
  const [slotLimit, setSlotLimit] = useState(12);
  useEffect(() => setSetup(repo.policy.setupArgv ?? []), [repo.policy.setupArgv]);
  useEffect(() => {
    if (hasFlagged) setOpen(true);
  }, [hasFlagged]);
  const tone = repo.status === "ready" ? "ready" : repo.status === "attention" ? "attention" : "danger";
  const geometry = capacityGeometry(repo.counts, repo.policy.maxSlots);
  const selectable = repo.slots.filter((slot) => slot.actions.includes("destroy") && !pendingBySlot.has(slot.id));
  const allSelected = selectable.length > 0 && selectable.every((slot) => selected.has(slot.id));

  function repoPatch(value: NonNullable<WorktreesConfigPatch["repositories"]>[string]): WorktreesConfigPatch {
    return { repositories: { [repo.commonDirectory]: value } };
  }

  return (
    <article className={`wt-pool wt-pool-${tone}`}>
      <header className="wt-pool-head">
        <Tooltip label={open ? `Hide ${repo.name} worktree policy and inventory` : `Show ${repo.name} worktree policy and inventory`}>
          <button type="button" className="wt-disclosure" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            <span className="wt-caret" aria-hidden>{open ? "▾" : "▸"}</span>
            <span className="wt-pool-name">
              <strong><span className={`wt-dot wt-dot-${tone}`} aria-hidden />{repo.name}</strong>
              <code>{repo.root}</code>
            </span>
          </button>
        </Tooltip>
        <div className="wt-pool-state">
          <span className="wt-pool-summary">{geometry.summary}</span>
          <StateChip label={overridden ? "override" : "inherited"} />
          <StateChip label={repo.status} tone={tone} />
        </div>
      </header>
      <CapacityBar geometry={geometry} />
      <CapacityLegend geometry={geometry} />
      {repo.status === "unavailable" && (
        <p className="wt-diagnostic">This pool&rsquo;s state could not be observed. The counts above are the last reading Mission Control took.</p>
      )}
      {geometry.overflow && (
        <div className="wt-over">
          <p><strong>{geometry.overflow.count}</strong> {geometry.overflow.count === 1 ? "slot is" : "slots are"} over the maximum of {geometry.maxSlots}. Nothing was pruned to say so.</p>
          <Tooltip label="Preview removing safe unused slots until this pool meets its configured maximum">
            <button className="btn btn-ghost" type="button" onClick={(event) => onAction({ action: "prune", poolId: repo.id, mode: "rightSize" }, event.currentTarget)}>Preview right-size</button>
          </Tooltip>
        </div>
      )}
      {repo.reconciliationError && <p className="wt-diagnostic">{repo.reconciliationError}</p>}
      {open && (
        <div className="wt-pool-detail">
          <div className="wt-policy-grid">
            <Tooltip label="Allow future native worktree acquisitions for this repository">
              <label>
                Repository enabled
                <input
                  type="checkbox"
                  checked={repo.policy.enabled}
                  onChange={(event) => void updateConfig(repoPatch({ enabled: event.target.checked }))}
                />
              </label>
            </Tooltip>
            <label>
              Maximum warm slots
              <input
                type="number"
                min={1}
                max={128}
                value={repo.policy.maxSlots}
                onChange={(event) => void updateConfig(repoPatch({ maxSlots: Number(event.target.value) }))}
              />
            </label>
          </div>
          <Tooltip label="Remove this repository override so future acquisitions use global policy">
            <button className="btn btn-ghost" type="button" disabled={!overridden} onClick={() => void updateConfig({ repositories: { [repo.commonDirectory]: null } })}>Use global defaults</button>
          </Tooltip>
          <fieldset className="wt-argv">
            <legend>Setup argv for newly created slots</legend>
            {setup.map((arg, index) => (
              <div className="wt-argv-row" key={index}>
                <label htmlFor={`wt-setup-${repo.id}-${index}`}>Argument {index + 1}</label>
                <input
                  id={`wt-setup-${repo.id}-${index}`}
                  value={arg}
                  onChange={(event) => setSetup((current) => current.map((value, at) => at === index ? event.target.value : value))}
                />
                <Tooltip label={`Remove setup argument ${index + 1} from this draft`}>
                  <button type="button" className="btn btn-ghost" aria-label={`Remove setup argument ${index + 1}`} onClick={() => setSetup((current) => current.filter((_, at) => at !== index))}>Remove</button>
                </Tooltip>
              </div>
            ))}
            <div className="wt-argv-actions">
              <Tooltip label="Add one setup command argument">
                <button type="button" className="btn btn-ghost" disabled={setup.length >= 32} onClick={() => setSetup((current) => [...current, ""])}>Add argument</button>
              </Tooltip>
              <Tooltip label="Save this exact setup argument vector for future slots">
                <button type="button" className="btn btn-secondary" disabled={setup.some((arg) => !arg)} onClick={() => void updateConfig(repoPatch({ setupArgv: setup.length ? setup : null }))}>Save argv</button>
              </Tooltip>
            </div>
          </fieldset>
          <ClaimEditor repo={repo} updateConfig={updateConfig} />
          <div className="wt-maintenance-actions">
            {repo.policy.claim && repo.policy.enabled && repo.counts.available > 0 && (
              <Tooltip label="Preview warming every available slot in this pool, one at a time, under the pool's claim">
                <button className="btn btn-secondary" type="button" onClick={(event) => onAction({ action: "warm", target: { kind: "pool", poolId: repo.id } }, event.currentTarget)}>Warm idle slots</button>
              </Tooltip>
            )}
            <Tooltip label="Preview reconciling durable slot records with Git and filesystem state">
              <button className="btn btn-ghost" type="button" onClick={(event) => onAction({ action: "reconcile", poolId: repo.id }, event.currentTarget)}>Reconcile</button>
            </Tooltip>
            <Tooltip label="Preview removing only safe, unused native slots">
              <button className="btn btn-ghost" type="button" onClick={(event) => onAction({ action: "prune", poolId: repo.id, mode: "safe" }, event.currentTarget)}>Preview safe prune</button>
            </Tooltip>
            {selectable.length > 0 && (
              <Tooltip label={allSelected ? `Remove every ${repo.name} slot from the bulk destroy selection` : `Add every destroyable ${repo.name} slot to the bulk destroy selection`}>
                <button className="btn btn-ghost" type="button" onClick={() => onSelect(selectable.map((slot) => slot.id), !allSelected)}>
                  {allSelected ? "Deselect all slots" : "Select all slots"}
                </button>
              </Tooltip>
            )}
            {repo.slots.length > 0 && (
              <Tooltip label="Preview destroying the fixed set of slots currently in this pool">
                <button className="btn btn-danger" type="button" onClick={(event) => onAction({ action: "destroy", target: { kind: "pool", poolId: repo.id } }, event.currentTarget)}>Destroy fixed pool set</button>
              </Tooltip>
            )}
          </div>
          <div className="wt-slot-scroll" role="region" aria-label={`${repo.name} native slot details`} tabIndex={0}>
            <div className="wt-slots">
              {repo.slots.filter((slot, index) => index < slotLimit || flagged(slot.id)).map((slot) => (
                <SlotCard
                  key={slot.id}
                  slot={slot}
                  pending={pendingBySlot.get(slot.id) ?? null}
                  stuckReturn={stuckBySlot.get(slot.id) ?? null}
                  selected={selected.has(slot.id)}
                  selectionFull={selected.size >= BULK_SELECTION_LIMIT}
                  onSelect={(slotId, next) => onSelect([slotId], next)}
                  onAction={onAction}
                  orphans={orphansBySlot.get(slot.id) ?? []}
                  onKill={onKill}
                  onOpenSession={onOpenSession}
                />
              ))}
            </div>
          </div>
          {repo.slots.length > slotLimit && (
            <Tooltip label="Render the next twelve slots in this bounded inventory">
              <button className="btn btn-ghost" type="button" onClick={() => setSlotLimit((current) => Math.min(current + 12, repo.slots.length))}>Show more slots ({repo.slots.length - slotLimit} remaining)</button>
            </Tooltip>
          )}
        </div>
      )}
    </article>
  );
}

/** A name-width block and a track-width block per row, so the group has shape while it loads. */
function PoolSkeleton(): React.JSX.Element {
  return (
    <div className="wt-skeletons" aria-hidden>
      {[0, 1].map((row) => (
        <div className="wt-skeleton" key={row}>
          <span className="wt-skeleton-name" />
          <span className="wt-skeleton-bar" />
        </div>
      ))}
    </div>
  );
}

function dialogTitle(request: WorktreeActionRequest): string {
  if (request.action === "legacyReturn") return "Return legacy worktree";
  if (request.action === "warm") return request.target.kind === "pool" ? "Warm idle slots" : "Warm worktree";
  if (request.action === "removeUnowned") return "Discard and remove unowned tree";
  if (request.action === "destroy" && request.target.kind === "slots") {
    const count = request.target.slotIds.length;
    return `Destroy ${count} selected ${count === 1 ? "worktree" : "worktrees"}`;
  }
  return `${ACTION_VERBS[request.action]} worktree`;
}

function ActionDialog({
  preview,
  error,
  changed,
  busy,
  onClose,
  onExecute,
  onRefresh,
}: {
  preview: WorktreeActionPreview;
  error: string | null;
  changed: boolean;
  busy: boolean;
  onClose: () => void;
  onExecute: (acks: WorktreeRiskKey[]) => void;
  onRefresh: () => void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDivElement>(null);
  const [acks, setAcks] = useState<Set<WorktreeRiskKey>>(new Set());
  const acknowledgementSignature = preview.requiredAcknowledgements.join(",");
  useEffect(() => {
    setAcks(new Set());
  }, [preview.token, acknowledgementSignature]);
  useEffect(() => {
    const root = dialog.current;
    if (!root) return;
    const focusable = () => [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')];
    focusable()[0]?.focus();
    function trap(event: KeyboardEvent): void {
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    root.addEventListener("keydown", trap);
    return () => root.removeEventListener("keydown", trap);
  }, []);
  const currentAcks = [...acks].filter((key) => preview.requiredAcknowledgements.includes(key));
  const acknowledged = preview.requiredAcknowledgements.every((key) => acks.has(key));
  return (
    <Overlay id={OVERLAY_IDS.worktreeAction} onClose={onClose} className="modal wt-action-modal" role="dialog" ariaLabel={`${preview.request.action} worktree preview`} closable={!busy}>
      <div ref={dialog}>
        <header className="modal-head">
          <div><span className="wt-eyebrow">Preview first</span><h3>{dialogTitle(preview.request)}</h3></div>
          <Tooltip label="Close this action preview without changing the worktree">
            <button className="btn btn-ghost" type="button" onClick={onClose} disabled={busy}>Close</button>
          </Tooltip>
        </header>
        <div className="modal-body wt-action-body">
          {changed && <div className="wt-changed"><strong>State changed after this preview.</strong><p>{error}</p><Tooltip label="Discard the stale token and build a new safety preview"><button className="btn btn-secondary" type="button" onClick={onRefresh}>Refresh preview</button></Tooltip></div>}
          {!changed && error && <p className="settings-error">{error}</p>}
          {preview.affected.length > 0 && <section><h4>Affected paths</h4><ul className="wt-affected">{preview.affected.map((item) => <li key={`${item.provider}:${item.id}`}><code>{item.path}</code><span>{item.owner?.label ?? item.provider} · {bytes(item.diskBytes)}</span></li>)}</ul></section>}
          {preview.blockers.length > 0 && <section className="wt-blockers"><h4>Cannot execute</h4><ul>{preview.blockers.map((item) => <li key={item}>{item}</li>)}</ul></section>}
          {preview.consequences.length > 0 && <section><h4>What happens</h4><ul>{preview.consequences.map((item) => <li key={item}>{item}</li>)}</ul></section>}
          {preview.requiredAcknowledgements.length > 0 && <fieldset className="wt-acknowledgements"><legend>Required acknowledgements</legend>{preview.risks.filter((item) => item.acknowledgeable).map((item) => <Tooltip key={item.key} label={`Acknowledge this previewed risk: ${item.label}`}><label><input type="checkbox" checked={acks.has(item.key)} onChange={(event) => setAcks((current) => { const next = new Set(current); if (event.target.checked) next.add(item.key); else next.delete(item.key); return next; })} />I understand: {item.label}</label></Tooltip>)}</fieldset>}
        </div>
        <footer className="modal-foot"><Tooltip label="Cancel without changing the worktree"><button className="btn btn-ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button></Tooltip><Tooltip label={preview.request.action === "warm"
                ? "Queue this Warm; each slot is checked again when its turn comes, and one that is no longer idle is skipped"
                : "Queue this exact preview; it is rechecked against current state and runs in the background"}><button className={preview.request.action === "warm" ? "btn btn-primary" : "btn btn-danger"} type="button" disabled={busy || changed || !preview.allowed || !acknowledged} onClick={() => onExecute(currentAcks)}>{busy ? "Queueing…" : "Execute"}</button></Tooltip></footer>
      </div>
    </Overlay>
  );
}

const LEGACY_KINDS = ["ownedExact", "identityUnverifiable", "foreign", "unreadable"] as const;

export function WorktreeSettingsPanel({
  state,
  storageHealth = null,
  onOpenSession,
}: {
  state: WorktreesState;
  /** The live storage aggregate, whose `stuck-return` and `orphan-process` problems the slot cards show. */
  storageHealth?: StorageHealth | null;
  /** Leaves settings for one session on the fleet. */
  onOpenSession?: (sessionId: string) => void;
}): React.JSX.Element {
  const { inventory, loading, error, preview, previewError, previewChanged, busy, operations } = state;
  const orphansBySlot = useMemo(() => {
    const bySlot = new Map<string, OrphanProcess[]>();
    for (const problem of storageHealth?.problems ?? []) {
      if (problem.kind !== "orphan-process" || problem.link.target !== "slot" || !problem.process) continue;
      bySlot.set(problem.link.slotId, [...(bySlot.get(problem.link.slotId) ?? []), problem.process]);
    }
    return bySlot;
  }, [storageHealth]);
  const [killing, setKilling] = useState<{ orphans: readonly OrphanProcess[]; trigger: HTMLButtonElement } | null>(null);
  const [killBusy, setKillBusy] = useState(false);
  const [killErrors, setKillErrors] = useState<readonly string[]>([]);

  function closeKill(): void {
    killing?.trigger.focus();
    setKilling(null);
    setKillErrors([]);
  }

  /** Kills one process, answering why it was not killed, or null when it was. */
  async function killOne(orphan: OrphanProcess): Promise<string | null> {
    // With no answer from the daemon the kill may or may not have been sent, which a bare
    // network error would read as a refusal.
    const unanswered = (reason: string) =>
      `The daemon did not answer (${reason}), so it is not known whether process ${orphan.pid} was signalled. It stays listed until a scan no longer finds it.`;
    try {
      const result = await api.killOrphanProcess({
        path: orphan.tree, pid: orphan.pid, startedAt: orphan.startedAt, command: orphan.command,
      });
      if (result.ok) return null;
      if (result.status === undefined) return unanswered(result.error ?? "no response");
      return result.error ?? "The daemon refused the kill.";
    } catch (error) {
      return unanswered(error instanceof Error ? error.message : String(error));
    }
  }

  async function confirmKill(): Promise<void> {
    if (!killing) return;
    setKillBusy(true);
    try {
      // Each request is guarded on its own, so they run together rather than one grace period
      // after another.
      const outcomes = await Promise.all(killing.orphans.map(async (orphan) => ({ orphan, error: await killOne(orphan) })));
      const failed = outcomes.flatMap(({ orphan, error }) => error === null ? [] : [{ orphan, error }]);
      if (failed.length < outcomes.length) void state.refresh();
      if (failed.length === 0) {
        setKilling(null);
        setKillErrors([]);
      } else {
        // The dialog narrows to what is left, so a retry never re-signals a process already gone.
        setKilling({ ...killing, orphans: failed.map((outcome) => outcome.orphan) });
        setKillErrors(failed.map((outcome) => outcome.error));
      }
    } finally {
      setKillBusy(false);
    }
  }
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const [lastRequest, setLastRequest] = useState<WorktreeActionRequest | null>(null);
  // The failed operation the open preview is retrying. Its report - and the fixed set of
  // slots it left - stays on screen until that retry is accepted, so a cancelled or failed
  // retry never loses it.
  const [retrying, setRetrying] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  // How many slots the last tick or Select all could not add because the selection was full.
  const [refused, setRefused] = useState(0);
  const pendingBySlot = useMemo(() => {
    const pending = new Map<string, WorktreeOperationView>();
    for (const operation of operations) {
      if (!worktreeOperationPending(operation)) continue;
      for (const target of operation.targets) if (target.provider === "mission") pending.set(target.id, operation);
    }
    return pending;
  }, [operations]);
  const unowned = useMemo(() => unownedTreeEntries(storageHealth), [storageHealth]);
  const pendingPaths = useMemo(() => new Set(operations
    .filter(worktreeOperationPending)
    .flatMap((operation) => operation.targets.map((target) => target.path))), [operations]);
  const startKill = (orphans: readonly OrphanProcess[], trigger: HTMLButtonElement): void => {
    setKillErrors([]);
    setKilling({ orphans, trigger });
  };
  const stuckBySlot = useMemo(() => {
    const stuck = new Map<string, StorageProblem>();
    for (const problem of storageHealth?.problems ?? []) {
      if (problem.kind === "stuck-return" && problem.link.target === "slot") stuck.set(problem.link.slotId, problem);
    }
    return stuck;
  }, [storageHealth]);
  // The selection is exactly what the operator ticked, and it is never narrowed behind their
  // back. A slot that vanished or picked up a cleanup of its own stays in it and is counted
  // here, so the bulk preview still names it and the server blocks the changed set; only
  // Clear selection, unticking, or a successful bulk Execute removes an id.
  const selected = chosen;
  const unavailable = useMemo(() => {
    const destroyable = new Set(inventory?.repositories.flatMap((repo) => repo.slots)
      .filter((slot) => slot.actions.includes("destroy") && !pendingBySlot.has(slot.id))
      .map((slot) => slot.id) ?? []);
    return [...chosen].filter((id) => !destroyable.has(id)).length;
  }, [chosen, inventory, pendingBySlot]);

  function select(slotIds: string[], next: boolean): void {
    const change = changeSelection(chosen, slotIds, next);
    setChosen(change.next);
    setRefused(change.refused);
  }
  const config = inventory?.config;
  const exactLegacy = inventory?.legacy.items.filter((item) => item.classification === "ownedExact") ?? [];
  const legacyBlocked = inventory?.legacy.items.filter((item) => item.classification !== "ownedExact") ?? [];
  const legacyTotal = LEGACY_KINDS.reduce((sum, kind) => sum + (inventory?.legacy.totals[kind] ?? 0), 0);

  function request(request: WorktreeActionRequest, source: HTMLButtonElement, retryOf: string | null = null): void {
    setTrigger(source);
    setLastRequest(request);
    setRetrying(retryOf);
    void state.requestPreview(request);
  }

  function close(): void {
    setRetrying(null);
    state.discardPreview();
    trigger?.focus();
    setTrigger(null);
  }

  function execute(acks: WorktreeRiskKey[]): void {
    const submitted = preview?.request;
    const retried = retrying;
    void state.executePreview(acks).then((ok) => {
      if (!ok) return;
      // The retry was accepted and now has its own record; the old report has served its purpose.
      if (retried) void state.dismissOperation(retried);
      setRetrying(null);
      if (submitted?.action === "destroy" && submitted.target.kind === "slots") { setChosen(new Set()); setRefused(0); }
      trigger?.focus();
      setTrigger(null);
    });
  }

  return (
    <section className="settings-section wt-settings">
      <p className="settings-hint settings-blurb">
        Mission Control owns these checkouts, and only these. Every cleanup is{" "}
        <strong>previewed and rechecked</strong> against task, check, manual lease, Git, and
        process ownership before it can mutate a path. Executed cleanups run in the background,
        one after another, so you can keep queueing more.
      </p>

      {inventory && error && <p className="settings-error">{error}</p>}

      <section className="wt-group" data-anchor="worktrees/native-pools">
        <div className="settings-section-head wt-group-head">
          <div>
            <h4>Pools</h4>
            <p className="wt-group-note">One track per repository. The track&rsquo;s full width is that pool&rsquo;s configured maximum.</p>
          </div>
          <Tooltip label="Reobserve Git, filesystem, process, and durable ownership state">
            <button type="button" className="btn btn-ghost" onClick={() => void state.refresh()} disabled={loading}>Refresh</button>
          </Tooltip>
        </div>
        <WarmOperations
          operations={operations.filter((operation) => operation.request.action === "warm")}
          onCancel={(operation) => void state.cancelOperation(operation.id)}
          onDismiss={(operation) => void state.dismissOperation(operation.id)}
        />
        <OperationList
          operations={operations.filter((operation) => operation.request.action !== "warm")}
          onRetry={(operation, retry, source) => request(retry, source, operation.id)}
          onDismiss={(operation) => void state.dismissOperation(operation.id)}
        />
        {selected.size > 0 && (
          <div className="wt-bulk-bar" role="region" aria-label="Bulk destroy selection">
            <span>
              <strong>{selected.size}</strong> {selected.size === 1 ? "slot" : "slots"} selected
              {unavailable > 0 && <em className="wt-bulk-changed">{unavailable} no longer available</em>}
              {selected.size >= BULK_SELECTION_LIMIT && (
                <em className="wt-bulk-changed">
                  Limit of {BULK_SELECTION_LIMIT} reached{refused > 0 ? `; ${refused} ${refused === 1 ? "slot was" : "slots were"} not added` : ""}
                </em>
              )}
            </span>
            <Tooltip label="Preview destroying exactly the selected slots as one fixed set">
              <button className="btn btn-danger" type="button" onClick={(event) => request({ action: "destroy", target: { kind: "slots", slotIds: [...selected] } }, event.currentTarget)}>
                Destroy selected
              </button>
            </Tooltip>
            <Tooltip label="Clear the bulk destroy selection without changing any worktree">
              <button className="btn btn-ghost" type="button" onClick={() => { setChosen(new Set()); setRefused(0); }}>Clear selection</button>
            </Tooltip>
          </div>
        )}
        {!inventory && error && (
          <div className="wt-state wt-state-unavailable">
            <p><strong>Pool capacity could not be observed.</strong> {error}</p>
            <p>This is an outage, not an empty machine - existing pools and their slots are untouched. Refresh above to observe again.</p>
          </div>
        )}
        {!inventory && !error && (
          <>
            <PoolSkeleton />
            <p className="settings-hint">Observing Git, process, and provider state…</p>
          </>
        )}
        {inventory && inventory.repositories.length === 0 && (
          <div className="wt-state">
            <p><strong>No pools yet.</strong> Mission Control creates one the first time something needs a checkout in a repository.</p>
          </div>
        )}
        <div className="wt-pools">{inventory?.repositories.map((repo) => <PoolRow key={repo.id} repo={repo} overridden={Boolean(inventory.config.repositories[repo.commonDirectory])} updateConfig={state.updateConfig} pendingBySlot={pendingBySlot} stuckBySlot={stuckBySlot} selected={selected} onSelect={select} onAction={request} orphansBySlot={orphansBySlot} onKill={startKill} onOpenSession={onOpenSession} />)}</div>
      </section>

      <section className="wt-group" data-anchor="worktrees/unowned-trees">
        <div className="settings-section-head wt-group-head">
          <div>
            <h4>Unowned trees</h4>
            <p className="wt-group-note">Folders under the overflow and check directories that no pool slot shows: ones the sweep kept because they hold work, and ones a process still holds.</p>
          </div>
        </div>
        {unowned.length === 0 ? (
          <p className="settings-hint">No unowned trees. The sweep removes clean ones on its own.</p>
        ) : (
          <div className="wt-unowned-list">
            {unowned.map((entry) => (
              <UnownedTreeRow key={entry.path} entry={entry} pending={pendingPaths.has(entry.path)} onAction={request} onKill={startKill} onOpenSession={onOpenSession} />
            ))}
          </div>
        )}
      </section>

      <section className="wt-group" data-anchor="worktrees/policy">
        <div className="settings-section-head wt-group-head">
          <div>
            <h4>Defaults</h4>
            <p className="wt-group-note">Affects future acquisitions only.</p>
          </div>
        </div>
        <div className="kb-row">
          <div className="kb-row-text">
            <span className="kb-row-label">Use native worktrees</span>
            <span className="kb-row-desc">Repositories without an override acquire native Git worktrees. Disable to send future acquisitions to their isolated fallback; existing slots are preserved either way.</span>
          </div>
          <div className="kb-row-controls">
            <Tooltip label="Set whether repositories without an override use native worktrees for future acquisitions">
              <label className="skill-switch">
                <input
                  type="checkbox"
                  aria-label="Use native worktrees by default"
                  checked={config?.enabled ?? true}
                  disabled={!config}
                  onChange={(event) => void state.updateConfig({ enabled: event.target.checked })}
                />
              </label>
            </Tooltip>
          </div>
        </div>
        <div className="kb-row">
          <div className="kb-row-text">
            <span className="kb-row-label">Default maximum slots</span>
            <span className="kb-row-desc">Every bar above whose pool has not set its own maximum is drawn against this number, and reflows when it changes. Lowering it marks the difference <strong>over the maximum</strong> and offers a right-size preview; it never prunes as a side effect.</span>
          </div>
          <div className="kb-row-controls">
            <input
              className="wt-number"
              aria-label="Default maximum native slots"
              type="number"
              min={1}
              max={128}
              disabled={!config}
              value={config?.maxSlots ?? 16}
              onChange={(event) => void state.updateConfig({ maxSlots: Number(event.target.value) })}
            />
          </div>
        </div>
        <div className="kb-row">
          <div className="kb-row-text">
            <span className="kb-row-label">Stale lease after (days)</span>
            <span className="kb-row-desc">A slot whose owner is still live but whose checkout has had no Git-visible change for this many days shows a <strong>stale</strong> chip and is listed in Settings &gt; Storage. It is never reclaimed automatically.</span>
          </div>
          <div className="kb-row-controls">
            <StaleLeaseDaysInput
              saved={config?.staleLeaseDays ?? null}
              onSave={(staleLeaseDays) => void state.updateConfig({ staleLeaseDays })}
            />
          </div>
        </div>
        <p className="settings-hint">A repository with its own override ignores the first two. Open its pool above to see or clear that override.</p>
      </section>

      <section className="wt-group" data-anchor="worktrees/legacy-drain">
        <div className="settings-section-head wt-group-head">
          <div>
            <h4>Treehouse</h4>
            <p className="wt-group-note">Historical leases only. New work never acquires Treehouse resources.</p>
          </div>
          <StateChip label={inventory?.legacy.capability.kind ?? "unknown"} tone={inventory?.legacy.capability.kind === "conditional-json" ? "ready" : "attention"} />
        </div>
        {inventory?.legacy.capability.diagnostic && <p className="settings-hint wt-group-diagnostic">{inventory.legacy.capability.diagnostic}</p>}
        {legacyTotal > 0 && (
          <ul className="wt-legacy-totals">
            {LEGACY_KINDS.map((kind) => <li key={kind}><b>{inventory?.legacy.totals[kind] ?? 0}</b> {kind}</li>)}
          </ul>
        )}
        <div className="wt-legacy-list">
          {exactLegacy.map((item) => <article className="wt-legacy-row" key={item.id}><div><StateChip label="exact owner" tone="ready" /><code>{item.path}</code><p>{item.owner ? `${item.owner.kind} ${item.owner.id}` : "durable owner unavailable"}</p></div>{item.owner && item.canReturn && <Tooltip label="Preview returning this exact historical lease through its owning task or check"><button className="btn btn-ghost" type="button" onClick={(event) => request({ action: "legacyReturn", owner: item.owner! }, event.currentTarget)}>Return legacy lease</button></Tooltip>}</article>)}
          {legacyBlocked.map((item) => <article className="wt-legacy-row wt-legacy-blocked" key={item.id}><div><StateChip label={item.classification} tone="attention" /><code>{item.path}</code><p>{item.diagnostic ?? "Mission Control has no exact authority over this Treehouse resource."}</p></div></article>)}
          {inventory && inventory.legacy.items.length === 0 && (
            <p className="settings-hint">Nothing left to drain. All historical leases have been returned, and new work never acquires Treehouse resources.</p>
          )}
        </div>
      </section>

      {killing && <KillDialog orphans={killing.orphans} busy={killBusy} errors={killErrors} onClose={closeKill} onConfirm={() => void confirmKill()} />}
      {preview && <ActionDialog preview={preview} error={previewError} changed={previewChanged} busy={busy} onClose={close} onExecute={execute} onRefresh={() => { if (lastRequest) void state.requestPreview(lastRequest); }} />}
      {!preview && busy && <p className="wt-preview-loading" role="status">Building a fresh safety preview…</p>}
      {!preview && previewError && <p className="settings-error">{previewError}</p>}
    </section>
  );
}
