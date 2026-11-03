import { realpath, stat } from "node:fs/promises";
import {
  historyResumeNeedsPicker,
  isHistoryConversationKind,
  type HistoryResumeBody,
  type HistoryResumeCheckout,
  type HistoryResumeLaunch,
  type HistoryResumeOptions,
  type HistoryResumeRefusal,
  type HistoryResumeRefusalCode,
  type HistoryResumeSlot,
  type HistorySessionSummary,
} from "@shared/history.ts";
import type { Session } from "@shared/types.ts";
import type { TerminalBackendId } from "@shared/terminal.ts";
import { isInside } from "../archives/paths.ts";
import { resumeFor } from "../harness/index.ts";
import type { PreparedResume } from "../harness/resume.ts";
import { TerminalLaunchError } from "../terminal/launch-error.ts";
import type { ManagedResumeLaunch } from "../terminal/resume-launch.ts";
import type { TerminalLaunchOutcome } from "../terminal/targets.ts";
import { canonical } from "../worktrees/git.ts";
import type { NativeWorktreeLease } from "../worktrees/manager.ts";
import { historyResumeOwnerKey } from "../worktrees/owners.ts";
import type { HistoryReader } from "./reconciler.ts";
import type { HistoryResumeLaunches } from "./resume-launches.ts";
import { sameRepository, type HistoryResumeObservedSlot, type HistoryResumeSlots } from "./resume-slots.ts";
import type { HistoryLiveLookup } from "./service.ts";
import type { HistoryStore } from "./store.ts";

/**
 * History Resume (`docs/history.md`): reopen a cataloged conversation in a new unmanaged
 * terminal, with no task context and no Mission Control tools. Discovery then registers the
 * agent like any other terminal session, which makes the row Live.
 *
 * Targets are the original directory and worktree pool slots. A pool slot is never idle on a
 * branch, so an original directory that is a slot is a slot target on that same slot: leased
 * and its recorded branch checked out when it is idle, and counted as reused when it is not.
 * A directory gone or reused opens the picker, which offers idle slots of the same repository.
 */

/** The fields of a session a managed terminal resume is prepared from. */
export type HistoryResumeSession = Pick<Session, "id" | "agent" | "agentSessionId" | "permissionMode" | "cwd" | "runtime">;

/** The terminal half of a Resume, supplied by the routes so this file never opens a window itself. */
export interface HistoryResumeLauncher {
  /** Why `backend` cannot host an agent, or null when it can. */
  hostUnavailable(backend: TerminalBackendId): string | null;
  /**
   * Provision the launch: argv, disposable home and wrapper, recorded under `session.id`,
   * which a History Resume sets to `historyResumeOwner(launchId)`. Throws when it cannot.
   */
  prepare(session: HistoryResumeSession): Promise<PreparedResume>;
  launch(backend: TerminalBackendId, input: ManagedResumeLaunch): Promise<TerminalLaunchOutcome>;
  /**
   * Revoke what `prepare` provisioned under `owner` (the `session.id` it was given), when no
   * terminal has claimed it yet, so a window that opens late finds nothing to start.
   */
  abandon(owner: string): void;
}

/** The `session.id` a launch's environment is prepared, and later revoked, under. */
export function historyResumeOwner(launchId: string): string {
  return `history-resume:${launchId}`;
}

export interface HistoryResumeDeps {
  store: HistoryStore;
  launches: HistoryResumeLaunches;
  find(agent: string, id: string): { reader: HistoryReader; entry: { summary: HistorySessionSummary; transcriptPath: string } } | null;
  now?: () => number;
}

export type HistoryResumeOptionsRead =
  | { ok: true; options: HistoryResumeOptions }
  | { ok: false; status: 404; error: string };

export type HistoryResumeOutcome =
  | { ok: true; status: 200; launch: HistoryResumeLaunch; label: string; checkout: HistoryResumeCheckout | null }
  | { ok: false; status: 404 | 409 | 410 | 504; refusal: HistoryResumeRefusal; launch?: HistoryResumeLaunch };

export type HistoryResumeCancelOutcome =
  | { ok: true; launch: HistoryResumeLaunch }
  | { ok: false; status: 404 | 409; code: HistoryResumeRefusalCode; error: string; launch?: HistoryResumeLaunch };

const NOT_FOUND = "no such history session";

function refusal(code: HistoryResumeRefusalCode, error: string): HistoryResumeRefusal {
  return { code, error };
}

/** The status a refusal answers with. */
function refusalStatus(code: HistoryResumeRefusalCode): 409 | 410 | 504 {
  if (code === "transcript_gone") return 410;
  if (code === "launch_unknown") return 504;
  return 409;
}

type Original = HistoryResumeOptions["original"];

/** Where a launch runs, resolved: a directory outside the pool, or a slot to lease. */
type Target = { cwd: string; slot: HistoryResumeSlot | null };

function openLaunchRefusal(launch: HistoryResumeLaunch): HistoryResumeRefusal {
  const close = launch.slotId === null ? "" : " It holds that worktree slot: Return the slot from its card to close it.";
  return refusal(
    "open_launch",
    `This conversation is already being resumed in ${launch.cwd}, and its agent may still appear there.${close}`,
  );
}

export class HistoryResume {
  private readonly now: () => number;

  constructor(private readonly deps: HistoryResumeDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** What a Resume of this session would do now: its original directory, open launch, and refusal. */
  async options(
    agent: string,
    id: string,
    live: HistoryLiveLookup,
    slots: HistoryResumeSlots | null = null,
  ): Promise<HistoryResumeOptionsRead> {
    const found = this.deps.find(agent, id);
    if (!found) return { ok: false, status: 404, error: NOT_FOUND };
    const summary = { ...found.entry.summary, liveSessionId: live(found.entry.summary.agent, found.entry.summary.agentSessionId) };
    const observed = new SlotObservation(slots);
    const original = await this.original(summary.cwd, observed);
    const picker = historyResumeNeedsPicker(original.state) ? await this.picker(summary, observed) : [];
    const openLaunch = this.deps.launches.open(summary.agent, summary.agentSessionId);
    return {
      ok: true,
      options: { original, slots: picker, openLaunch, refusal: this.refusal(summary, original, openLaunch, picker.length > 0) },
    };
  }

  /**
   * Launch a Resume. Every check that reads state runs first and touches nothing; then the
   * launch row is inserted, and only the request that wins that insert prepares or opens a
   * terminal. A later step that fails releases the row, so it never blocks the next Resume; a
   * terminal whose outcome is unknown keeps it, because an agent may still appear.
   */
  async resume(
    agent: string,
    id: string,
    body: HistoryResumeBody,
    live: HistoryLiveLookup,
    launcher: HistoryResumeLauncher,
    slots: HistoryResumeSlots | null = null,
  ): Promise<HistoryResumeOutcome> {
    const found = this.deps.find(agent, id);
    if (!found) return { ok: false, status: 404, refusal: refusal("not_resumable", NOT_FOUND) };
    const { reader, entry } = found;
    const summary = { ...entry.summary, liveSessionId: live(entry.summary.agent, entry.summary.agentSessionId) };
    // The target, resolved once: the launch row, the binding and the terminal all use this
    // value, never the spelling the transcript recorded.
    const observed = new SlotObservation(slots);
    const original = await this.original(summary.cwd, observed);
    const openLaunch = this.deps.launches.open(summary.agent, summary.agentSessionId);
    const resolved = await this.target(summary, original, body, observed, openLaunch);
    if (!resolved.ok) return this.refuse(resolved.refusal, summary);
    const hostRefusal = launcher.hostUnavailable(body.backend);
    if (hostRefusal) return this.refuse(refusal("host_unavailable", hostRefusal), summary);
    const { target } = resolved;
    const { cwd } = target;

    const claimed = this.deps.launches.claim(
      {
        agent: summary.agent,
        sourceSessionId: summary.agentSessionId,
        expectedAgentSessionId: summary.agentSessionId,
        cwd,
        slotId: target.slot?.slotId ?? null,
      },
      this.now(),
    );
    if (!claimed.ok) return { ok: false, status: 409, refusal: openLaunchRefusal(claimed.open), launch: claimed.open };
    let { launch } = claimed;
    // The lease a slot target took, handed back when a later step fails so the slot is never
    // left held by a launch that started nothing.
    let lease: NativeWorktreeLease | null = null;
    const failed = async (error: string, code: HistoryResumeRefusalCode = "launch_failed"): Promise<HistoryResumeOutcome> => {
      if (lease && slots && !(await slots.giveBack(lease).catch(() => false))) {
        error = `${error}. The slot stays leased, so Return it from its card.`;
      }
      this.deps.launches.release(launch.launchId, this.now());
      return { ok: false, status: 409, refusal: refusal(code, error), launch: this.deps.launches.get(launch.launchId) ?? launch };
    };

    let checkout: HistoryResumeCheckout | null = null;
    if (target.slot && slots) {
      const owner = { kind: "manual" as const, key: historyResumeOwnerKey(launch.launchId) };
      const taken = await slots.lease(target.slot.slotId, owner, summary.branch).catch((error: unknown) => ({
        outcome: "outcomeUnknown" as const,
        reason: error instanceof Error ? error.message : String(error),
      }));
      if (taken.outcome !== "leased") {
        // Nothing was granted: a refused lease left the slot as it was, and one whose outcome
        // is unknown quarantined it under this launch's owner, which its card Returns.
        return failed(`Slot ${target.slot.ordinal} could not be leased: ${taken.reason}`, "slot_unavailable");
      }
      lease = taken.lease;
      checkout = taken.checkout;
      this.deps.launches.attachLease(launch.launchId, lease.leaseId, this.now());
      launch = this.deps.launches.get(launch.launchId) ?? launch;
    }

    let prepared: PreparedResume;
    try {
      // The recorded mode is carried when there is one; an unreadable record renders no flag
      // rather than a guess, as for every other resume.
      const permissionMode = await reader.spec.permissionMode(entry.transcriptPath).catch(() => null);
      prepared = await launcher.prepare({
        id: historyResumeOwner(launch.launchId),
        agent: summary.agent,
        agentSessionId: summary.agentSessionId,
        permissionMode,
        cwd,
        runtime: "terminal",
      });
    } catch (error) {
      return await failed(error instanceof Error ? error.message : String(error));
    }
    // Cancel pending resume can land while this request is still preparing. Its revocation
    // finds no lease to revoke then, because the lease is not pending until the launch begins,
    // so the cancel is honoured here: nothing opens, and the environment is revoked.
    if (this.cancelled(launch)) {
      try {
        prepared.dispose();
      } catch (error) {
        console.error(`[history] could not revoke cancelled resume ${launch.launchId}'s environment: ${String(error)}`);
      }
      return this.cancelledOutcome(launch, "Cancel pending resume closed this launch before its terminal opened.");
    }

    let result: TerminalLaunchOutcome;
    try {
      result = await launcher.launch(body.backend, { name: `resume-${summary.agentSessionId.slice(0, 8)}`, prepared });
    } catch (error) {
      if (error instanceof TerminalLaunchError && !error.outcomeUnknown) return await failed(error.message);
      return this.unknown(launch, error instanceof Error ? error.message : String(error));
    }
    // A cancel during the launch itself revoked the lease the terminal's wrapper was about to
    // claim, so report the launch as the cancel left it rather than as started.
    if (result.ok && this.cancelled(launch)) {
      return this.cancelledOutcome(
        launch,
        `Cancel pending resume closed this launch while ${result.label} was opening. If its agent had already started, it runs as an ordinary session.`,
      );
    }
    if (result.ok) return { ok: true, status: 200, launch, label: result.label, checkout };
    if (result.status === 504) return this.unknown(launch, result.error ?? `${result.label} did not report back`);
    return await failed(result.error ?? `${result.label} could not open a window`);
  }

  /**
   * Cancel pending resume: close a pending launch with no slot, at once, and revoke its
   * prepared environment if no terminal has claimed it. A terminal that already started its
   * agent is not closed; that agent is then an ordinary unmanaged session.
   */
  cancel(agent: string, id: string, launchId: string, launcher: HistoryResumeLauncher): HistoryResumeCancelOutcome {
    const found = this.deps.find(agent, id);
    const launch = this.deps.launches.get(launchId);
    if (!found || !launch || launch.agent !== found.entry.summary.agent || launch.sourceSessionId !== found.entry.summary.agentSessionId) {
      return { ok: false, status: 404, code: "launch_not_found", error: "no such resume launch for this session" };
    }
    const result = this.deps.launches.cancel(launchId, this.now());
    if (result.ok) {
      try {
        launcher.abandon(historyResumeOwner(launchId));
      } catch (error) {
        // The launch is closed either way; an environment left behind is revoked at its deadline.
        console.error(`[history] could not revoke resume ${launchId}'s environment: ${String(error)}`);
      }
      return { ok: true, launch: result.launch };
    }
    if (result.reason === "has_slot") {
      return { ok: false, status: 409, code: "launch_has_slot", error: "This launch holds a worktree slot: Return the slot to close it.", launch: result.launch };
    }
    return { ok: false, status: 409, code: "launch_not_pending", error: "This launch is no longer pending.", ...(result.launch ? { launch: result.launch } : {}) };
  }

  /** Whether this request's launch was released from under it: Cancel pending resume, or its grace window. */
  private cancelled(launch: HistoryResumeLaunch): boolean {
    return this.deps.launches.get(launch.launchId)?.state === "released";
  }

  private cancelledOutcome(launch: HistoryResumeLaunch, error: string): HistoryResumeOutcome {
    return { ok: false, status: 409, refusal: refusal("cancelled", error), launch: this.deps.launches.get(launch.launchId) ?? launch };
  }

  private unknown(launch: HistoryResumeLaunch, detail: string): HistoryResumeOutcome {
    return {
      ok: false,
      status: 504,
      refusal: refusal(
        "launch_unknown",
        `The terminal may have opened (${detail}). The launch stays pending in ${launch.cwd} until its agent appears or its grace window passes.`,
      ),
      launch,
    };
  }

  private refuse(found: HistoryResumeRefusal, summary: HistorySessionSummary): HistoryResumeOutcome {
    const launch = found.code === "open_launch" ? this.deps.launches.open(summary.agent, summary.agentSessionId) : null;
    return { ok: false, status: refusalStatus(found.code), refusal: found, ...(launch ? { launch } : {}) };
  }

  /**
   * The first refusal that applies, in the order the page reads them, or null. `offered` is
   * whether the picker has a slot to offer when the original directory is gone or reused.
   */
  private refusal(
    summary: HistorySessionSummary,
    original: Original,
    openLaunch: HistoryResumeLaunch | null,
    offered: boolean,
  ): HistoryResumeRefusal | null {
    if (!isHistoryConversationKind(summary.kind)) {
      return refusal("not_conversation", "Background runs (one-shot and reviewer) are readable here but cannot be resumed.");
    }
    if (summary.transcriptState === "gone") {
      return refusal("transcript_gone", "This transcript was removed by Claude Code's retention, so there is nothing to resume.");
    }
    if (summary.liveSessionId !== null) {
      return refusal("live", "This conversation is running now: open it in the Fleet instead.");
    }
    if (!resumeFor(summary.agent)) {
      return refusal("not_resumable", `${summary.agent} cannot reopen a conversation in a terminal.`);
    }
    if (openLaunch) return openLaunchRefusal(openLaunch);
    if (original.state === "unrecorded") return refusal("no_directory", "This transcript recorded no working directory to resume in.");
    if (offered) return null;
    const noSlot = summary.repoRoot === null
      ? "no repository could be resolved for it, so there is no slot to offer"
      : "no idle, clean slot of its repository is free";
    if (original.state === "missing") {
      return refusal("directory_missing", `The original directory ${summary.cwd} no longer exists, and ${noSlot}.`);
    }
    if (original.state === "slot_reused") {
      return refusal(
        "slot_reused",
        `The original directory ${summary.cwd} is a worktree slot that is in use or not idle, and ${noSlot}.`,
      );
    }
    return null;
  }

  /**
   * The body's target, resolved, or the refusal it meets. Every check here reads state and
   * touches nothing; whether a slot is still idle is decided by its lease, after the claim.
   */
  private async target(
    summary: HistorySessionSummary,
    original: Original,
    body: HistoryResumeBody,
    observed: SlotObservation,
    openLaunch: HistoryResumeLaunch | null,
  ): Promise<{ ok: true; target: Target } | { ok: false; refusal: HistoryResumeRefusal }> {
    const general = this.refusal(summary, original, openLaunch, true);
    if (general) return { ok: false, refusal: general };
    if (body.target.kind === "original") {
      if (original.state === "usable") return { ok: true, target: { cwd: original.resolved!, slot: null } };
      // The original's own slot, whatever it was observed as: its lease decides whether it is
      // still idle, after the claim, so one taken meanwhile is refused and the claim released.
      if (original.slot) return { ok: true, target: { cwd: await canonical(original.slot.path), slot: original.slot } };
      return {
        ok: false,
        refusal: original.state === "missing"
          ? refusal("directory_missing", `The original directory ${summary.cwd} no longer exists: choose a slot instead.`)
          : refusal("slot_reused", `The original directory ${summary.cwd} is in a worktree pool but is no slot this Resume can lease: choose a slot instead.`),
      };
    }
    const { slotId } = body.target;
    const offered = original.slot?.slotId === slotId
      ? original.slot
      : historyResumeNeedsPicker(original.state)
        ? (await this.picker(summary, observed, true)).find((slot) => slot.slotId === slotId) ?? null
        : null;
    if (!offered) {
      return { ok: false, refusal: refusal("slot_not_offered", "That slot is not one this Resume offers: it belongs to another repository, or is gone.") };
    }
    return { ok: true, target: { cwd: await canonical(offered.path), slot: offered } };
  }

  /**
   * The picker's slots: idle, clean slots of the session's repository. `includeBusy` keeps the
   * slots that are not idle now, for a launch whose lease decides that itself, so a slot taken
   * since the dialog read its options is refused by the lease, and its claim released.
   */
  private async picker(summary: HistorySessionSummary, observed: SlotObservation, includeBusy = false): Promise<HistoryResumeSlot[]> {
    if (summary.repoRoot === null) return [];
    const slots: HistoryResumeSlot[] = [];
    for (const entry of await observed.slots()) {
      if ((includeBusy || entry.idle) && await sameRepository(entry.repository, summary.repoRoot)) slots.push(entry.slot);
    }
    return slots;
  }

  /** The recorded directory, resolved once through symlinks, and whether Resume can use it. */
  private async original(cwd: string | null, observed: SlotObservation): Promise<Original> {
    if (!cwd) return { cwd, resolved: null, state: "unrecorded", slot: null };
    let resolved: string;
    try {
      resolved = await realpath(cwd);
      if (!(await stat(resolved)).isDirectory()) return { cwd, resolved: null, state: "missing", slot: null };
    } catch {
      return { cwd, resolved: null, state: "missing", slot: null };
    }
    const pools = await Promise.all(this.deps.store.worktreePools().map(({ poolPath }) => canonical(poolPath)));
    if (!pools.some((pool) => isInside(pool, resolved))) return { cwd, resolved, state: "usable", slot: null };
    // A pool directory is a slot target on its own slot when that slot is idle. Held by another
    // owner, or not provably idle, it counts as reused.
    const slot = (await observed.slots()).find((entry) => isInside(entry.canonicalPath, resolved)) ?? null;
    return { cwd, resolved, state: slot?.idle ? "pool_slot" : "slot_reused", slot: slot?.slot ?? null };
  }
}

/** One observation of the pool per request, read only when something asks for it. */
class SlotObservation {
  private observed: Promise<HistoryResumeObservedSlot[]> | null = null;

  constructor(private readonly source: HistoryResumeSlots | null) {}

  slots(): Promise<HistoryResumeObservedSlot[]> {
    this.observed ??= this.source ? this.source.observe().catch(() => []) : Promise.resolve([]);
    return this.observed;
  }
}
