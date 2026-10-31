/**
 * The reasons that mean only "a read failed": a Git listing or inspection, a process listing,
 * an owner lookup or the pool marker could not be read, even after its one retry
 * (`observation-retry.ts`). None of them proves anything about the slot, so none quarantines
 * it any more. The slot keeps its state and records the reason in `last_error` as
 * "Last observation failed: <reason>".
 *
 * The labels this build writes, as the reason a failed read records.
 */
export const OBSERVATION_FAILURE = {
  registrations: "Git worktree registrations are unknown",
  marker: "pool marker could not be read",
  git: "slot Git state is unknown",
  occupancy: "slot process occupancy is unknown",
  lastOwner: "last-released domain ownership is unknown",
  activeOwner: "leased domain ownership is unknown",
} as const;

/**
 * Every quarantine reason that is an observation failure: the labels above, and the reasons
 * older builds quarantined with for the same failed reads, so rows already in the database
 * qualify without a migration. The writer and every matcher read this one set.
 *
 * "pool marker is missing, unreadable, or belongs to another pool" is deliberately absent:
 * older builds wrote it for a missing or foreign marker too, which is a proven fault. The
 * "slot occupancy became unknown before ..." reasons are only ever older builds' quarantines of
 * a failed occupancy read; this build hands such a reservation back instead, and quarantines one
 * it cannot hand back under a reason of its own that is not in this set.
 */
export const OBSERVATION_FAILURE_REASONS: ReadonlySet<string> = new Set([
  ...Object.values(OBSERVATION_FAILURE),
  "Git registrations could not be read",
  "slot Git state could not be inspected",
  "slot occupancy is unknown",
  "last-released domain ownership could not be read",
  "slot occupancy became unknown before reset",
  "slot occupancy became unknown before it was warmed",
  "slot occupancy became unknown before it was seeded from",
]);

/**
 * Whether a quarantine reason is an observation failure. Older builds suffixed the pool-wide
 * listing failure with its cause ("Git worktree registrations are unknown: <cause>").
 */
export function isObservationFailure(reason: string | null): boolean {
  return reasonIn(OBSERVATION_FAILURE_REASONS, reason);
}

/** Whether a reason is in this set, on its own or suffixed with its cause. */
function reasonIn(reasons: ReadonlySet<string>, reason: string | null): boolean {
  if (reason === null) return false;
  if (reasons.has(reason)) return true;
  const colon = reason.indexOf(": ");
  return colon > 0 && reasons.has(reason.slice(0, colon));
}

/**
 * The reasons that say a slot's registration, its path, its pool, its lease identity or the
 * commit the allocator recorded for it is wrong. A later read that succeeds repairs none of
 * these, so automatic recovery never judges one, whatever else `last_error` holds. Every
 * writer uses these labels, so this is the one copy of each.
 */
export const REGISTRATION_OR_IDENTITY = {
  inexactPath: "slot path is not the exact path owned by its native pool",
  missingRegistration: "slot path or Git registration is missing",
  unsafeRegistration: "slot Git registration is bare, locked, or prunable",
  noSafeRegistration: "slot has no safe Git worktree registration",
  commonDirectory: "slot belongs to a different Git common directory",
  poolIdentity: "pool repository identity no longer matches its durable row",
  poolMarker: "pool marker is missing, malformed, or belongs to another pool",
  incompleteAvailableIdentity: "available slot has incomplete active lease identity",
  availableIdentity: "available slot still carries active lease identity",
  incompleteLastIdentity: "last-released lease identity is incomplete",
  incompleteLeasedIdentity: "leased slot has incomplete active identity",
  incompleteReturnIdentity: "interrupted return has incomplete active lease identity",
  noDomainOwner: "leased slot has no matching domain owner reference",
  headMoved: "available slot HEAD moved outside an allocator transition",
  /** Repair fixed the registration, and the slot holds work only a manual Recover may discard. */
  repairedHoldsWork: "registration repaired; holds work",
} as const;

/** Every registration or identity reason: the labels above, and an older build's marker wording. */
export const REGISTRATION_OR_IDENTITY_REASONS: ReadonlySet<string> = new Set([
  ...Object.values(REGISTRATION_OR_IDENTITY),
  "pool marker is missing, unreadable, or belongs to another pool",
]);

export function registrationOrIdentityQuarantine(reason: string | null): boolean {
  return reasonIn(REGISTRATION_OR_IDENTITY_REASONS, reason);
}

/**
 * The reasons Repair answers: Git's registration of the slot is unsafe, or names another path.
 * That last one reads as "missing" here, because `git worktree list` shows the registration
 * under the path it names.
 */
const REGISTRATION_REPAIR_REASONS: ReadonlySet<string> = new Set([
  REGISTRATION_OR_IDENTITY.unsafeRegistration,
  REGISTRATION_OR_IDENTITY.noSafeRegistration,
  REGISTRATION_OR_IDENTITY.missingRegistration,
]);

export function registrationRepairQuarantine(reason: string | null): boolean {
  return reasonIn(REGISTRATION_REPAIR_REASONS, reason);
}

/** A removal that began and did not finish: whatever survives of the tree is left at this path. */
export const REMOVAL_UNFINISHED = {
  interrupted: "startup found an interrupted prune with filesystem state still present",
  unverified: "worktree removal could not be verified",
} as const;

/**
 * The reasons that say this tree's files cannot be trusted as an install, whatever `deps_state`
 * reads: part of it may be gone, or it may be another repository's. Rows quarantined before a
 * removal cleared `deps_state` still read `current`, so a seed refuses these by reason.
 */
const UNTRUSTED_TREE_REASONS: ReadonlySet<string> = new Set([
  ...Object.values(REMOVAL_UNFINISHED),
  REGISTRATION_OR_IDENTITY.commonDirectory,
]);

export function untrustedTreeQuarantine(reason: string | null): boolean {
  return reasonIn(UNTRUSTED_TREE_REASONS, reason);
}

/** A dirty available slot, and the reason older builds gave it before occupied was split off. */
export const AVAILABLE_SLOT_DIRTY = "available slot is dirty";
const AVAILABLE_SLOT_OCCUPIED_OR_DIRTY = "available slot is occupied or dirty";

/**
 * Whether automatic recovery may judge a slot quarantined for this reason: a failed read, or a
 * dirty available slot, each of which a fresh read can disprove. An `index.lock` quarantine is
 * recognized by its error instead (`lockCausedQuarantine`).
 */
export function clearableQuarantineReason(reason: string | null): boolean {
  return isObservationFailure(reason) || reason === AVAILABLE_SLOT_DIRTY || reason === AVAILABLE_SLOT_OCCUPIED_OR_DIRTY;
}

/**
 * The quarantine of a reservation refused before anything changed that could not be handed back
 * to available. Whether the hand-back landed is unknown, so it is deliberately not in the set.
 */
export const RESERVATION_NOT_HANDED_BACK = "a refused reservation could not be handed back to available";

const PREFIX = "Last observation failed: ";

/** "<label> (<detail>)", or the label alone. */
export function observationFailureText(label: string, detail: string | null): string {
  return detail ? `${label} (${detail})` : label;
}

/** Whether a recorded failed-read note names this reason, whatever its detail. */
export function sameObservationFailure(note: string | null, label: string): boolean {
  return note === label || Boolean(note?.startsWith(`${label} (`));
}

/**
 * A slot's `last_error` split into its failed-read note, on the first line when present, and
 * whatever else it carries: on a quarantined slot, the detail of its quarantine, which the
 * note never replaces.
 */
export function splitObservationFailure(lastError: string | null): { failure: string | null; rest: string | null } {
  if (lastError === null || !lastError.startsWith(PREFIX)) return { failure: null, rest: lastError };
  const newline = lastError.indexOf("\n");
  return newline < 0
    ? { failure: lastError.slice(PREFIX.length), rest: null }
    : { failure: lastError.slice(PREFIX.length, newline), rest: lastError.slice(newline + 1) || null };
}

/** `last_error` with this failed-read note in front of whatever else it carries. */
export function withObservationFailure(lastError: string | null, failure: string): string {
  const { rest } = splitObservationFailure(lastError);
  const note = `${PREFIX}${failure.replace(/\s*\n\s*/g, " ")}`;
  return rest === null ? note : `${note}\n${rest}`;
}

/** `last_error` without its failed-read note: what a successful read leaves. */
export function withoutObservationFailure(lastError: string | null): string | null {
  return splitObservationFailure(lastError).rest;
}
