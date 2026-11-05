import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { pipeline } from "node:stream/promises";
import { createReadStream } from "node:fs";
import {
  isHistoryConversationKind,
  type HistoryResumeBody,
  type HistoryResumeCheckout,
  type HistoryResumeLaunch,
  type HistoryResumeOptions,
  type HistoryResumeRefusal,
  type HistoryResumeTarget,
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
 * Three targets: the original directory, a worktree pool slot, and a directory the operator
 * typed. A pool slot is never idle on a branch, so an original directory that is a slot is a
 * slot target on that same slot: leased and its recorded branch checked out when it is idle,
 * and counted as reused when it is not. When the original cannot be used, the picker offers
 * idle slots of the same repository and a typed directory.
 *
 * A typed directory runs a FORK. The transcript is copied into that directory's project folder
 * as an exclusive create, never over an existing file, and the agent starts with a fork id
 * Mission Control minted, so the fork's identity is known before launch and the original is
 * never touched. That copy is History's only write into the agent's store, and an unofficial
 * workaround that may break with an agent format change.
 */

/** The fields of a session a managed terminal resume is prepared from. */
export type HistoryResumeSession = Pick<Session, "id" | "agent" | "agentSessionId" | "permissionMode" | "cwd" | "runtime"> & {
  /** Set for a fork: the id Mission Control minted for it, which the agent starts under. */
  forkSessionId?: string | null;
};

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
  | { ok: false; status: 400 | 404 | 409 | 410 | 504; refusal: HistoryResumeRefusal; launch?: HistoryResumeLaunch };

/**
 * A target resolved once, through symlinks: that one `cwd` is the copy folder's encoding, the
 * launch row's directory, the terminal's working directory and the binding key. A fork also
 * carries where its transcript copy goes and the id minted for it.
 */
interface ResolvedTarget {
  cwd: string;
  fork: { copyPath: string; forkSessionId: string } | null;
  /** The slot a slot target leases; the lease decides, after the claim, whether it is still idle. */
  slot: HistoryResumeSlot | null;
}

type Original = Omit<HistoryResumeOptions["original"], "refusal">;

type TargetRead = { ok: true; target: ResolvedTarget } | { ok: false; refusal: HistoryResumeRefusal };

export type HistoryResumeCancelOutcome =
  | { ok: true; launch: HistoryResumeLaunch }
  | { ok: false; status: 404 | 409; code: HistoryResumeRefusalCode; error: string; launch?: HistoryResumeLaunch };

const NOT_FOUND = "no such history session";

function refusal(code: HistoryResumeRefusalCode, error: string): HistoryResumeRefusal {
  return { code, error };
}

/** The status a refusal answers with. */
function refusalStatus(code: HistoryResumeRefusalCode): 400 | 409 | 410 | 504 {
  if (code === "directory_relative") return 400;
  if (code === "transcript_gone") return 410;
  if (code === "launch_unknown") return 504;
  return 409;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function copyExistsRefusal(copyPath: string): HistoryResumeRefusal {
  return refusal(
    "copy_exists",
    `${copyPath} already exists and is not a copy History made of this conversation, so nothing was written. Choose another directory.`,
  );
}

function copyChangedRefusal(copyPath: string): HistoryResumeRefusal {
  return refusal(
    "copy_exists",
    `${copyPath} was copied by History, but something has written to it since (a resume run in that directory), so it is no longer a copy of this conversation. Nothing was written. Choose another directory.`,
  );
}

/** What already lies at a fork's copy destination. */
type ExistingCopy = "absent" | "copy" | "changed" | "foreign";

/**
 * Whether every byte of `copyPath` is the start of `sourcePath`. The source only ever grows
 * by appending, so a recorded copy that is still a prefix of it is one nothing has written to
 * since it was made (a fork leaves its source untouched); one that is not was resumed in place.
 */
async function isPrefixOf(copyPath: string, sourcePath: string): Promise<boolean> {
  const copy = await open(copyPath, "r");
  try {
    const source = await open(sourcePath, "r");
    try {
      const size = (await copy.stat()).size;
      if (size > (await source.stat()).size) return false;
      const left = Buffer.alloc(64 * 1024);
      const right = Buffer.alloc(64 * 1024);
      for (let at = 0; at < size;) {
        const length = Math.min(left.length, size - at);
        const [a, b] = await Promise.all([copy.read(left, 0, length, at), source.read(right, 0, length, at)]);
        if (a.bytesRead !== length || b.bytesRead !== length) return false;
        if (!left.subarray(0, length).equals(right.subarray(0, length))) return false;
        at += length;
      }
      return true;
    } finally {
      await source.close();
    }
  } finally {
    await copy.close();
  }
}

function existingRefusal(existing: ExistingCopy, copyPath: string): HistoryResumeRefusal | null {
  if (existing === "foreign") return copyExistsRefusal(copyPath);
  if (existing === "changed") return copyChangedRefusal(copyPath);
  return null;
}

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
    const openLaunch = this.deps.launches.open(summary.agent, summary.agentSessionId);
    const refused = this.sessionRefusal(summary, openLaunch);
    const originalRefusal = directoryRefusal(summary.cwd, original, observed);
    return {
      ok: true,
      options: {
        original: { ...original, refusal: originalRefusal },
        openLaunch,
        refusal: refused,
        picker: refused || !originalRefusal
          ? null
          : { directory: canFork(summary.agent), slots: await this.picker(summary, observed) },
      },
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
    const refused = this.sessionRefusal(summary, this.deps.launches.open(summary.agent, summary.agentSessionId));
    if (refused) return this.refuse(refused, summary);
    // The target, resolved once: the copy, the launch row, the binding and the terminal all
    // use this value, never the spelling the transcript recorded or the operator typed.
    const resolved = await this.target(body.target, summary, reader, entry.transcriptPath, new SlotObservation(slots));
    if (!resolved.ok) return this.refuse(resolved.refusal, summary);
    const { cwd, fork, slot } = resolved.target;
    const hostRefusal = launcher.hostUnavailable(body.backend);
    if (hostRefusal) return this.refuse(refusal("host_unavailable", hostRefusal), summary);

    const claimed = this.deps.launches.claim(
      {
        agent: summary.agent,
        sourceSessionId: summary.agentSessionId,
        // A fork is discovered under the id minted for it; `resumed_from` reads this row.
        expectedAgentSessionId: fork?.forkSessionId ?? summary.agentSessionId,
        cwd,
        slotId: slot?.slotId ?? null,
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
    if (slot && slots) {
      const owner = { kind: "manual" as const, key: historyResumeOwnerKey(launch.launchId) };
      const taken = await slots.lease(slot.slotId, owner, summary.branch).catch((error: unknown) => ({
        outcome: "outcomeUnknown" as const,
        reason: error instanceof Error ? error.message : String(error),
      }));
      if (taken.outcome !== "leased") {
        // Nothing was granted: a refused lease left the slot as it was, and one whose outcome
        // is unknown quarantined it, which its card Returns.
        return failed(`Slot ${slot.ordinal} could not be leased: ${taken.reason}`, "slot_unavailable");
      }
      lease = taken.lease;
      checkout = taken.checkout;
      this.deps.launches.attachLease(launch.launchId, lease.leaseId, this.now());
      launch = this.deps.launches.get(launch.launchId) ?? launch;
    }

    if (fork) {
      const copied = await this.copy(launch, entry.transcriptPath, fork.copyPath);
      if (!copied.ok) {
        this.deps.launches.release(launch.launchId, this.now());
        return { ok: false, status: 409, refusal: copied.refusal, launch: this.deps.launches.get(launch.launchId) ?? launch };
      }
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
        forkSessionId: fork?.forkSessionId ?? null,
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

  /** The first refusal that blocks every target, in the order the page reads them, or null. */
  private sessionRefusal(summary: HistorySessionSummary, openLaunch: HistoryResumeLaunch | null): HistoryResumeRefusal | null {
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
    return null;
  }

  /** The target a request names, resolved once, or why it cannot be used. Touches nothing. */
  private async target(
    target: HistoryResumeTarget,
    summary: HistorySessionSummary,
    reader: HistoryReader,
    transcriptPath: string,
    observed: SlotObservation,
  ): Promise<TargetRead> {
    if (target.kind === "original") {
      const original = await this.original(summary.cwd, observed);
      // The original's own slot, whatever it was observed as: its lease decides whether it is
      // still idle, after the claim, so one taken meanwhile is refused and the claim released.
      if (original.slot) return { ok: true, target: { cwd: await canonical(original.slot.path), fork: null, slot: original.slot } };
      const refused = directoryRefusal(summary.cwd, original, observed);
      return refused ? { ok: false, refusal: refused } : { ok: true, target: { cwd: original.resolved!, fork: null, slot: null } };
    }
    if (target.kind === "slot") {
      const original = await this.original(summary.cwd, observed);
      const offered = original.slot?.slotId === target.slotId
        ? original.slot
        : directoryRefusal(summary.cwd, original, observed)
          ? (await this.picker(summary, observed, true)).find((slot) => slot.slotId === target.slotId) ?? null
          : null;
      if (!offered) {
        return { ok: false, refusal: refusal("slot_not_offered", "That slot is not one this Resume offers: it belongs to another repository, or is gone.") };
      }
      return { ok: true, target: { cwd: await canonical(offered.path), fork: null, slot: offered } };
    }
    if (!canFork(summary.agent)) {
      return { ok: false, refusal: refusal("not_resumable", `${summary.agent} cannot fork a conversation into another directory.`) };
    }
    if (!isAbsolute(target.path)) {
      return { ok: false, refusal: refusal("directory_relative", `${target.path} is a relative path: type the directory's absolute path.`) };
    }
    const typed = await this.resolveDirectory(target.path);
    if (typed.state === "missing") {
      return { ok: false, refusal: refusal("directory_missing", `The directory ${target.path} does not exist.`) };
    }
    if (typed.state === "pool_slot") {
      return {
        ok: false,
        refusal: refusal("pool_slot", `${target.path} is inside a worktree pool, which another task may be using: choose one of the offered slots instead.`),
      };
    }
    const copyPath = reader.spec.copyDestination(typed.resolved, summary.agentSessionId);
    // Advisory, so a refusal costs no launch row; the exclusive create after the claim decides.
    // A check that cannot read its files leaves the decision, and the error, to the copy.
    const existing = await this.existing(summary.agent, summary.agentSessionId, transcriptPath, copyPath).catch((): ExistingCopy => "absent");
    const refused = existingRefusal(existing, copyPath);
    if (refused) return { ok: false, refusal: refused };
    return { ok: true, target: { cwd: typed.resolved, fork: { copyPath, forkSessionId: randomUUID() }, slot: null } };
  }

  /**
   * What lies at `copyPath`: nothing; a History copy of this session nothing has written to
   * since (`copy`); a recorded copy something resumed in place (`changed`); or any other file,
   * the canonical transcript included (`foreign`). A path alone never makes a file reusable.
   */
  private async existing(
    agent: HistorySessionSummary["agent"],
    sourceSessionId: string,
    sourcePath: string,
    copyPath: string,
  ): Promise<ExistingCopy> {
    try {
      await lstat(copyPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return "absent";
      throw error;
    }
    if (!this.deps.launches.isCopyOf(agent, sourceSessionId, copyPath)) return "foreign";
    return (await isPrefixOf(copyPath, sourcePath)) ? "copy" : "changed";
  }

  /**
   * Put the transcript at `copyPath` for a fork, and record it on the launch. An existing
   * History copy of this session that is still a prefix of the source is reused as it stands,
   * with no write: a fork never changes its source. A recorded copy something has written to
   * since, and anything else at that path, the canonical transcript included, refuse with
   * nothing written: the copy is an exclusive create (`O_EXCL`), so it never writes over a
   * file, whoever made it.
   */
  private async copy(
    launch: HistoryResumeLaunch,
    source: string,
    copyPath: string,
  ): Promise<{ ok: true } | { ok: false; refusal: HistoryResumeRefusal }> {
    try {
      const existing = await this.existing(launch.agent, launch.sourceSessionId, source, copyPath);
      const refused = existingRefusal(existing, copyPath);
      if (refused) return { ok: false, refusal: refused };
      if (existing === "copy") {
        this.deps.launches.recordCopy(launch.launchId, copyPath, this.now());
        return { ok: true };
      }
      await mkdir(dirname(copyPath), { recursive: true });
      let created = false;
      try {
        const handle = await open(copyPath, "wx", 0o600);
        created = true;
        await pipeline(createReadStream(source), handle.createWriteStream());
      } catch (error) {
        if (!created && isErrno(error, "EEXIST")) {
          // Lost to a file that appeared since the check: reuse it only if it is our own
          // untouched copy.
          const raced = await this.existing(launch.agent, launch.sourceSessionId, source, copyPath);
          if (raced === "copy") {
            this.deps.launches.recordCopy(launch.launchId, copyPath, this.now());
            return { ok: true };
          }
          return { ok: false, refusal: existingRefusal(raced, copyPath) ?? copyExistsRefusal(copyPath) };
        }
        // A partial copy this request created is removed, so it never blocks the next Resume.
        if (created) await unlink(copyPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      return { ok: false, refusal: refusal("launch_failed", `Could not copy the transcript to ${copyPath}: ${error instanceof Error ? error.message : String(error)}`) };
    }
    this.deps.launches.recordCopy(launch.launchId, copyPath, this.now());
    return { ok: true };
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

  /**
   * The recorded directory, resolved once through symlinks, and whether Resume can use it. A
   * pool directory is a slot target on its own slot when that slot is idle; held by another
   * owner, or not provably idle, it counts as reused.
   */
  private async original(cwd: string | null, observed: SlotObservation): Promise<Original> {
    if (!cwd) return { cwd, resolved: null, state: "unrecorded", slot: null };
    const directory = await this.resolveDirectory(cwd);
    if (directory.state !== "pool_slot") return { cwd, ...directory, slot: null };
    const slot = (await observed.slots()).find((entry) => isInside(entry.canonicalPath, directory.resolved)) ?? null;
    return { cwd, resolved: directory.resolved, state: slot?.idle ? "pool_slot" : "slot_reused", slot: slot?.slot ?? null };
  }

  /** A directory resolved once through symlinks, and whether it exists outside every worktree pool. */
  private async resolveDirectory(path: string): Promise<
    { resolved: null; state: "missing" } | { resolved: string; state: "usable" | "pool_slot" }
  > {
    let resolved: string;
    try {
      resolved = await realpath(path);
      if (!(await stat(resolved)).isDirectory()) return { resolved: null, state: "missing" };
    } catch {
      return { resolved: null, state: "missing" };
    }
    const pools = await Promise.all(this.deps.store.worktreePools().map(({ poolPath }) => canonical(poolPath)));
    if (pools.some((pool) => isInside(pool, resolved))) return { resolved, state: "pool_slot" };
    return { resolved, state: "usable" };
  }
}

/** Whether this agent's CLI can start a fork under an id Mission Control mints. */
function canFork(agent: HistorySessionSummary["agent"]): boolean {
  return typeof resumeFor(agent)?.forkArgv === "function";
}

/**
 * Why the original directory cannot be resumed in, or null when it can (an idle slot can). A
 * pool directory whose pool could not be read is not called reused: the refusal says the pool
 * was unreadable, and why.
 */
function directoryRefusal(cwd: string | null, original: Original, observed: SlotObservation): HistoryResumeRefusal | null {
  const { state } = original;
  if (state === "unrecorded") return refusal("no_directory", "This transcript recorded no working directory to resume in.");
  if (state === "missing") return refusal("directory_missing", `The original directory ${cwd} no longer exists.`);
  if (state === "slot_reused" && original.slot === null && observed.error !== null) {
    return refusal(
      "pool_unavailable",
      `The original directory ${cwd} is in a worktree pool that could not be read (${observed.error}), so whether its slot is idle is unknown.`,
    );
  }
  if (state === "slot_reused") {
    return refusal("slot_reused", `The original directory ${cwd} is a worktree slot that is in use or not idle.`);
  }
  return null;
}

/**
 * One observation of the pool per request, read only when something asks for it. A read that
 * fails offers no slot, and is logged and kept as `error`, so a refusal can say why rather than
 * call a slot it never saw reused.
 */
class SlotObservation {
  private observed: Promise<HistoryResumeObservedSlot[]> | null = null;
  /** Why the pool could not be read, once a read has failed; null otherwise. */
  error: string | null = null;

  constructor(private readonly source: HistoryResumeSlots | null) {}

  slots(): Promise<HistoryResumeObservedSlot[]> {
    this.observed ??= this.source
      ? this.source.observe().catch((error: unknown) => {
        this.error = error instanceof Error ? error.message : String(error);
        console.error(`[history] could not read the worktree pools for Resume: ${this.error}`);
        return [];
      })
      : Promise.resolve([]);
    return this.observed;
  }
}
