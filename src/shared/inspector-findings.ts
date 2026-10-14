// Reading GitHub Inspector findings: whether each one reached GitHub, and the one order
// every reader lists them in.
//
// Browser-safe, and the only place either answer is derived. The findings route, Foreman's
// relay, the workflow `inspector_feedback` packet and the dashboard's findings table all
// call these functions rather than restating them, so a new state fails the build in every
// consumer instead of reading differently in one of them.

import {
  INSPECTOR_LEGACY_POSTED,
  type InspectorComment,
  type InspectorLegacyPosted,
  type InspectorSeverity,
} from "./types.ts";

export function isInspectorLegacyPosted(value: unknown): value is InspectorLegacyPosted {
  return (INSPECTOR_LEGACY_POSTED as readonly unknown[]).includes(value);
}

/**
 * Whether a finding reached GitHub.
 *
 * - `posted`: confirmed on GitHub, now or before it was resolved.
 * - `posting`: written to the ledger ahead of a POST whose outcome is not yet known.
 * - `not-posted`: never published, so the finding's text exists only in Mission Control.
 * - `unknown`: recorded before posting was tracked, and nothing on the row proves either way.
 */
export type FindingPublicationState = "posted" | "posting" | "not-posted" | "unknown";

export interface FindingPublication {
  state: FindingPublicationState;
  /** This finding's GitHub comment, or for `earlierPost`, the earlier version's. */
  url: string | null;
  /** When the post was confirmed. For `earlierPost`, when the earlier version was. */
  postedAt: number | null;
  /** A drafted row whose earlier version was posted, and is not posted again yet. */
  earlierPost: boolean;
}

export type FindingPublicationInput = Pick<
  InspectorComment,
  "status" | "postedAt" | "githubUrl" | "legacyPosted"
>;

/**
 * Derive a finding's publication state from its row. First match wins:
 *
 * 1. `posting` reads `posting`.
 * 2. `drafted` reads `not-posted`; `earlierPost` is set when the row was posted before,
 *    by `postedAt` or by `legacyPosted = posted`, and `url` is then that earlier comment.
 * 3. `open` reads `posted`.
 * 4. `resolved` reads `posted` when it was posted, `unknown` when the backfill could not
 *    tell, and `not-posted` otherwise.
 *
 * A row whose `postedAt` is ABSENT (as against null) comes from a snapshot taken before
 * the field existed. Where the answer depends on that field, it reads `unknown` rather
 * than claiming the finding was never posted.
 */
export function findingPublication(row: FindingPublicationInput): FindingPublication {
  const postedAt = typeof row.postedAt === "number" ? row.postedAt : null;
  const url = typeof row.githubUrl === "string" && row.githubUrl ? row.githubUrl : null;
  const postedBefore = postedAt !== null || row.legacyPosted === "posted";
  const untracked = row.postedAt === undefined && row.legacyPosted === undefined;
  switch (row.status) {
    case "posting":
      return { state: "posting", url: null, postedAt: null, earlierPost: false };
    case "drafted":
      return postedBefore
        ? { state: "not-posted", url, postedAt, earlierPost: true }
        : { state: "not-posted", url: null, postedAt: null, earlierPost: false };
    case "open":
      return { state: "posted", url, postedAt, earlierPost: false };
    case "resolved":
      if (postedBefore) return { state: "posted", url, postedAt, earlierPost: false };
      if (row.legacyPosted === "unknown" || untracked) {
        return { state: "unknown", url: null, postedAt: null, earlierPost: false };
      }
      return { state: "not-posted", url: null, postedAt: null, earlierPost: false };
    default:
      return { state: "unknown", url: null, postedAt: null, earlierPost: false };
  }
}

const SEVERITY_ORDER: Record<InspectorSeverity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

/** Severity first, then path, line (a body-only finding last) and fingerprint. */
export function compareInspectorFindings(
  a: Pick<InspectorComment, "severity" | "path" | "line" | "fingerprint">,
  b: Pick<InspectorComment, "severity" | "path" | "line" | "fingerprint">,
): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || (a.path ?? "").localeCompare(b.path ?? "")
    || (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER)
    || a.fingerprint.localeCompare(b.fingerprint);
}

/** Every finding on a pull request: unresolved first, then in `compareInspectorFindings` order. */
export function orderInspectorFindings<T extends InspectorComment>(findings: readonly T[]): T[] {
  return [...findings].sort((a, b) =>
    Number(a.status === "resolved") - Number(b.status === "resolved")
    || compareInspectorFindings(a, b));
}
