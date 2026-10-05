// Whether a pull request conflicts with its base, as the PR poller observed it. Browser-safe.
//
// One normalisation of GitHub's `mergeable`, one reconciliation rule for a new read, and one
// reading rule for every consumer, so the chip and every later conflict reaction cannot
// disagree about whether a pull request conflicts right now.

import type { PrMergeable, PrMergeability } from "./types.ts";

/**
 * GitHub's `mergeable` as a `PrMergeable`, or null for no observation.
 *
 * `UNKNOWN` is null, not a state: GitHub computes mergeability lazily, so the first read after
 * a push is usually `UNKNOWN`, and treating it as an answer would clear a real conflict every
 * time the agent pushed.
 */
export function prMergeableFromGitHub(raw: unknown): PrMergeable | null {
  if (raw === "MERGEABLE") return "mergeable";
  if (raw === "CONFLICTING") return "conflicting";
  return null;
}

/** One read of a pull request, as `nextMergeability` reconciles it. */
export interface MergeabilityRead {
  /** False for a merged or closed pull request, which has no mergeability to report. */
  open: boolean;
  /** Null when GitHub answered `UNKNOWN`. */
  mergeable: PrMergeable | null;
  baseRef: string | null;
  headSha: string | null;
}

/**
 * Reconcile one read onto what was last known about the SAME pull request (pass null when the
 * previous fields described a different one, or nothing).
 *
 * A definitive read is bound to the head it came back with. An unknown read advances
 * `prHeadSha` and keeps the previous observation whole, old head included, so a kept
 * observation never claims to describe a head GitHub did not report it for. A merged or
 * closed pull request clears the observation: there is nothing left to conflict with.
 */
export function nextMergeability(
  prev: PrMergeability | null,
  read: MergeabilityRead,
): PrMergeability {
  const prMergeable = !read.open
    ? null
    : read.mergeable !== null && read.headSha !== null
      ? { state: read.mergeable, headSha: read.headSha }
      : (prev?.prMergeable ?? null);
  return {
    prMergeable,
    prBaseRef: read.baseRef ?? prev?.prBaseRef ?? null,
    prHeadSha: read.headSha ?? prev?.prHeadSha ?? null,
  };
}

/**
 * The pull request's mergeability for its CURRENT head, or null while that head's is not yet
 * known. The one reading rule: an observation made on an earlier head says nothing about this
 * one, so "conflicting on A, push B, `UNKNOWN`" reads as unknown on B, never conflicting.
 */
export function currentMergeability(
  pr: Pick<PrMergeability, "prMergeable" | "prHeadSha">,
): PrMergeable | null {
  const observed = pr.prMergeable;
  return observed !== null && observed.headSha === pr.prHeadSha ? observed.state : null;
}

/** Field-wise equality, for the reconcilers' "did anything move" checks. */
export function mergeabilityEqual(a: PrMergeability, b: PrMergeability): boolean {
  return (
    a.prBaseRef === b.prBaseRef &&
    a.prHeadSha === b.prHeadSha &&
    a.prMergeable?.state === b.prMergeable?.state &&
    a.prMergeable?.headSha === b.prMergeable?.headSha
  );
}
