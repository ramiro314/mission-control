import type { ForemanConfig } from "@shared/protocol.ts";
import type { BlockedPr, BlockedPrReason, PrMergeable, Session } from "@shared/types.ts";
import { foremanCannotDrive } from "./foreman/review-followup.ts";
import { foremanMayActLive } from "./foreman/verdict.ts";
import { parsePrUrl } from "./inspector/github.ts";

// The daemon's single owner of "is this pull request's conflict handled?".
//
// A CONFLICT EPISODE is one stretch of a pull request conflicting with its base. It is keyed by
// the PR URL alone and lives in memory: a restart re-derives it from the first poll. The PR
// poller feeds it every read it makes, from either path, and it answers two things:
//
//  - which URLs the by-URL poller must keep asking about (`urls`), so an exited session's PR
//    is still polled and its episode can still close when the fix lands;
//  - which open episodes nothing is handling (`blockedPrs`), which the attention inbox draws.
//
// Foreman marks an episode escalated (`escalate`) when its nudges did not resolve the conflict.
// That flag lives and dies with the episode: it re-arms when the PR is observed mergeable.
//
// See docs/plans/pr-merge-conflicts/plan.md, section 2.

/** One poll read of a pull request, as the episode state machine needs it. */
export interface ConflictObservation {
  /** `closed` is closed without merging. */
  state: "open" | "merged" | "closed";
  /**
   * The CURRENT head's mergeability, read through `currentMergeability`, or null while it is
   * unknown for that head. Null never opens, advances or closes an episode.
   */
  mergeable: PrMergeable | null;
  baseRef: string | null;
  headSha: string | null;
}

export interface ConflictEpisode {
  url: string;
  /** When the episode opened: the first conflicting read. */
  since: number;
  baseRef: string | null;
  /** The latest head observed conflicting. A display field, never part of the identity. */
  headSha: string | null;
  /** Foreman escalated this episode: its nudges did not resolve the conflict. */
  escalated: boolean;
  /** The head Foreman escalated on, for display and the log. Null until it escalates. */
  escalatedHead: string | null;
}

/**
 * Open conflict episodes, keyed by PR URL. A pure state machine: it is fed reads and the set
 * of URLs still referenced, and decides nothing about who is handling a conflict.
 */
export class PrConflictEpisodes {
  private readonly open = new Map<string, ConflictEpisode>();

  /**
   * Fold one read in. A conflicting current head opens the episode, or advances its head and
   * base. Mergeable, merged or closed closes it. An unknown current head leaves it as it is,
   * so a fix push GitHub has not answered for yet neither closes nor re-opens anything.
   */
  observe(url: string, read: ConflictObservation, now: number): void {
    if (read.state !== "open" || read.mergeable === "mergeable") {
      this.open.delete(url);
      return;
    }
    if (read.mergeable !== "conflicting") return;
    const current = this.open.get(url);
    this.open.set(url, {
      url,
      since: current?.since ?? now,
      baseRef: read.baseRef ?? current?.baseRef ?? null,
      headSha: read.headSha ?? current?.headSha ?? null,
      escalated: current?.escalated ?? false,
      escalatedHead: current?.escalatedHead ?? null,
    });
  }

  /**
   * Mark the open episode for `url` escalated, whichever head it is on now: identity is the
   * URL alone, so an escalation on a later conflicting head still lands. Returns false, and
   * does nothing, when no episode is open for it. Idempotent, so Foreman can re-send it.
   */
  escalate(url: string, headSha: string): boolean {
    const current = this.open.get(url);
    if (!current) return false;
    this.open.set(url, { ...current, escalated: true, escalatedHead: headSha });
    return true;
  }

  /** Close every episode whose PR no session and no task references any longer. */
  retain(referenced: (url: string) => boolean): void {
    for (const url of this.open.keys()) {
      if (!referenced(url)) this.open.delete(url);
    }
  }

  /** Every open episode's URL, for the by-URL poller's harvest. */
  urls(): string[] {
    return [...this.open.keys()];
  }

  list(): ConflictEpisode[] {
    return [...this.open.values()];
  }

  /** The URLs of every open episode Foreman escalated, for `Session.prConflictEscalated`. */
  escalatedUrls(): Set<string> {
    return new Set([...this.open.values()].filter((e) => e.escalated).map((e) => e.url));
  }
}

/** Who still references one pull request. */
export interface PrReference {
  /**
   * Every session naming the PR, exited ones included. A session stops referencing it only
   * when it is removed (`session_remove`).
   */
  sessions: readonly Session[];
  /** The task whose work carries the PR, or null. */
  task: { id: string; title: string } | null;
  /**
   * Whether a non-terminal workflow run owns this PR's work: any session naming it, exited
   * ones included, or the task's work-episode binding, which outlives the session. A
   * workflow step's agent often exits while its run is still active.
   */
  workflowOwned: boolean;
}

/**
 * Why nothing is handling this conflict, or null when something is.
 *
 * Work an active workflow owns is the workflow's to classify (not reported here), whether or
 * not its session is still live. Otherwise no live session means `session-gone`. A live one
 * is `nudges-exhausted` once Foreman escalated the episode, and otherwise
 * `foreman-cannot-nudge` exactly when Foreman's follow-through would refuse to type into it,
 * read through the same predicates `decideReviewFollowup` uses, plus `trackMergeConflicts`
 * being off.
 */
export function unhandledReason(
  ref: PrReference,
  foreman: ForemanConfig,
  escalated = false,
): BlockedPrReason | null {
  if (ref.workflowOwned) return null;
  const live = liveOwner(ref);
  if (!live) return "session-gone";
  if (escalated) return "nudges-exhausted";
  if (
    !foreman.trackMergeConflicts ||
    foremanCannotDrive(live) !== null ||
    !foremanMayActLive(foreman, live.cwd, live.repoRoot)
  ) {
    return "foreman-cannot-nudge";
  }
  return null;
}

/** The session owning a PR that has not exited, or null when every owner has. */
function liveOwner(ref: PrReference): Session | null {
  return ref.sessions.find((s) => s.state !== "exited") ?? null;
}

/** The blocked pull requests: every open episode nothing is handling, oldest first. Pure. */
export function blockedPrs(
  episodes: readonly ConflictEpisode[],
  references: ReadonlyMap<string, PrReference>,
  foreman: ForemanConfig,
): BlockedPr[] {
  const out: BlockedPr[] = [];
  for (const episode of episodes) {
    const ref = references.get(episode.url);
    if (!ref) continue;
    const reason = unhandledReason(ref, foreman, episode.escalated);
    if (reason === null) continue;
    // The session the row names: the live owner, else the exited one the daemon still holds.
    const shown = liveOwner(ref) ?? ref.sessions[0] ?? null;
    const parsed = parsePrUrl(episode.url);
    out.push({
      url: episode.url,
      repo: parsed ? `${parsed.owner}/${parsed.repo}` : null,
      number: parsed?.number ?? null,
      baseRef: episode.baseRef,
      headSha: episode.headSha,
      since: episode.since,
      reason,
      taskId: ref.task?.id ?? null,
      taskTitle: ref.task?.title ?? null,
      sessionId: shown?.id ?? null,
      sessionName: shown?.name ?? null,
    });
  }
  return out.sort((a, b) => a.since - b.since || (a.url < b.url ? -1 : 1));
}

/** The registry surface the tracker reads and publishes through. */
export interface PrConflictHost {
  prReferences(): Map<string, PrReference>;
  setBlockedPrs(prs: BlockedPr[]): void;
  /** The PR URLs whose open episode is escalated, for `prConflictEscalated` on snapshots. */
  setEscalatedPrUrls(urls: ReadonlySet<string>): void;
}

/**
 * The episodes plus the glue the PR poller calls once per tick: fold the tick's reads in,
 * drop episodes nothing references, and publish the blocked set. Foreman's escalation route
 * goes through it too, so an escalation is published at once rather than on the next tick.
 */
export class PrConflictTracker {
  readonly episodes = new PrConflictEpisodes();

  constructor(
    private readonly host: PrConflictHost,
    private readonly foremanConfig: () => ForemanConfig,
  ) {}

  reconcile(reads: ReadonlyMap<string, ConflictObservation>, now: number): void {
    const references = this.host.prReferences();
    for (const [url, read] of reads) this.episodes.observe(url, read, now);
    // After the reads, so a read of a PR nothing references never leaves an episode behind.
    this.episodes.retain((url) => references.has(url));
    this.publish(references);
  }

  /** Mark `url`'s open episode escalated and publish it. False when no episode is open. */
  escalate(url: string, headSha: string): boolean {
    if (!this.episodes.escalate(url, headSha)) return false;
    this.publish(this.host.prReferences());
    return true;
  }

  private publish(references: ReadonlyMap<string, PrReference>): void {
    this.host.setEscalatedPrUrls(this.episodes.escalatedUrls());
    this.host.setBlockedPrs(
      blockedPrs(this.episodes.list(), references, this.foremanConfig()),
    );
  }
}
