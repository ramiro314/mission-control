import { realpath, stat } from "node:fs/promises";
import {
  isHistoryConversationKind,
  type HistoryResumeBody,
  type HistoryResumeDirectoryState,
  type HistoryResumeLaunch,
  type HistoryResumeOptions,
  type HistoryResumeRefusal,
  type HistoryResumeRefusalCode,
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
import type { HistoryReader } from "./reconciler.ts";
import type { HistoryResumeLaunches } from "./resume-launches.ts";
import type { HistoryLiveLookup } from "./service.ts";
import type { HistoryStore } from "./store.ts";

/**
 * History Resume (`docs/history.md`): reopen a cataloged conversation in a new unmanaged
 * terminal, with no task context and no Mission Control tools. Discovery then registers the
 * agent like any other terminal session, which makes the row Live.
 *
 * Only the original directory is a target here, and only when it is outside every worktree
 * pool: a pool slot is never idle on a branch, so resuming into one is the slot target's job.
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
  | { ok: true; status: 200; launch: HistoryResumeLaunch; label: string }
  | { ok: false; status: 404 | 409 | 410 | 504; refusal: HistoryResumeRefusal; launch?: HistoryResumeLaunch };

export type HistoryResumeCancelOutcome =
  | { ok: true; launch: HistoryResumeLaunch }
  | { ok: false; status: 404 | 409; error: string; launch?: HistoryResumeLaunch };

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

function openLaunchRefusal(launch: HistoryResumeLaunch): HistoryResumeRefusal {
  return refusal(
    "open_launch",
    `This conversation is already being resumed in ${launch.cwd}, and its agent may still appear there.`,
  );
}

export class HistoryResume {
  private readonly now: () => number;

  constructor(private readonly deps: HistoryResumeDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** What a Resume of this session would do now: its original directory, open launch, and refusal. */
  async options(agent: string, id: string, live: HistoryLiveLookup): Promise<HistoryResumeOptionsRead> {
    const found = this.deps.find(agent, id);
    if (!found) return { ok: false, status: 404, error: NOT_FOUND };
    const summary = { ...found.entry.summary, liveSessionId: live(found.entry.summary.agent, found.entry.summary.agentSessionId) };
    const original = await this.original(summary.cwd);
    const openLaunch = this.deps.launches.open(summary.agent, summary.agentSessionId);
    return {
      ok: true,
      options: { original, openLaunch, refusal: this.refusal(summary, original.state, openLaunch) },
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
  ): Promise<HistoryResumeOutcome> {
    const found = this.deps.find(agent, id);
    if (!found) return { ok: false, status: 404, refusal: refusal("not_resumable", NOT_FOUND) };
    const { reader, entry } = found;
    const summary = { ...entry.summary, liveSessionId: live(entry.summary.agent, entry.summary.agentSessionId) };
    // The one target this build offers, resolved once: the launch row, the binding and the
    // terminal all use this value, never the spelling the transcript recorded.
    const original = await this.original(summary.cwd);
    const refused = this.refusal(summary, original.state, this.deps.launches.open(summary.agent, summary.agentSessionId));
    if (refused) return this.refuse(refused, summary);
    const hostRefusal = launcher.hostUnavailable(body.backend);
    if (hostRefusal) return this.refuse(refusal("host_unavailable", hostRefusal), summary);
    const cwd = original.resolved!;

    const claimed = this.deps.launches.claim(
      { agent: summary.agent, sourceSessionId: summary.agentSessionId, expectedAgentSessionId: summary.agentSessionId, cwd },
      this.now(),
    );
    if (!claimed.ok) return { ok: false, status: 409, refusal: openLaunchRefusal(claimed.open), launch: claimed.open };
    const { launch } = claimed;
    const failed = (error: string): HistoryResumeOutcome => {
      this.deps.launches.release(launch.launchId, this.now());
      return { ok: false, status: 409, refusal: refusal("launch_failed", error), launch: this.deps.launches.get(launch.launchId) ?? launch };
    };

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
      return failed(error instanceof Error ? error.message : String(error));
    }

    let result: TerminalLaunchOutcome;
    try {
      result = await launcher.launch(body.backend, { name: `resume-${summary.agentSessionId.slice(0, 8)}`, prepared });
    } catch (error) {
      if (error instanceof TerminalLaunchError && !error.outcomeUnknown) return failed(error.message);
      return this.unknown(launch, error instanceof Error ? error.message : String(error));
    }
    if (result.ok) return { ok: true, status: 200, launch, label: result.label };
    if (result.status === 504) return this.unknown(launch, result.error ?? `${result.label} did not report back`);
    return failed(result.error ?? `${result.label} could not open a window`);
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
      return { ok: false, status: 404, error: "no such resume launch for this session" };
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
      return { ok: false, status: 409, error: "This launch holds a worktree slot: Return the slot to close it.", launch: result.launch };
    }
    return { ok: false, status: 409, error: "This launch is no longer pending.", ...(result.launch ? { launch: result.launch } : {}) };
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

  /** The first refusal that applies, in the order the page reads them, or null. */
  private refusal(
    summary: HistorySessionSummary,
    directory: HistoryResumeDirectoryState,
    openLaunch: HistoryResumeLaunch | null,
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
    if (directory === "unrecorded") return refusal("no_directory", "This transcript recorded no working directory to resume in.");
    if (directory === "missing") {
      return refusal("directory_missing", `The original directory ${summary.cwd} no longer exists.`);
    }
    if (directory === "pool_slot") {
      return refusal(
        "pool_slot",
        `The original directory ${summary.cwd} is a worktree pool slot, which another task may be using. Resuming into a slot is not available yet.`,
      );
    }
    return null;
  }

  /** The recorded directory, resolved once through symlinks, and whether Resume can use it. */
  private async original(cwd: string | null): Promise<HistoryResumeOptions["original"]> {
    if (!cwd) return { cwd, resolved: null, state: "unrecorded" };
    let resolved: string;
    try {
      resolved = await realpath(cwd);
      if (!(await stat(resolved)).isDirectory()) return { cwd, resolved: null, state: "missing" };
    } catch {
      return { cwd, resolved: null, state: "missing" };
    }
    const pools = await Promise.all(this.deps.store.worktreePools().map(({ poolPath }) => realpath(poolPath).catch(() => poolPath)));
    if (pools.some((pool) => isInside(pool, resolved))) return { cwd, resolved, state: "pool_slot" };
    return { cwd, resolved, state: "usable" };
  }
}
