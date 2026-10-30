import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { lockCausedQuarantine } from "../src/server/worktrees/index-lock.ts";
import {
  clearableQuarantineReason,
  INTERRUPTED_PRUNE,
  isObservationFailure,
  OBSERVATION_FAILURE,
  OBSERVATION_FAILURE_REASONS,
  REGISTRATION_OR_IDENTITY,
  REGISTRATION_OR_IDENTITY_REASONS,
  registrationOrIdentityQuarantine,
  RESERVATION_NOT_HANDED_BACK,
  splitObservationFailure,
  UNVERIFIED_REMOVAL,
  withObservationFailure,
  withoutObservationFailure,
} from "../src/server/worktrees/quarantine-reasons.ts";

test("every reason this build writes for a failed read is in the one set", () => {
  for (const label of Object.values(OBSERVATION_FAILURE)) assert.ok(OBSERVATION_FAILURE_REASONS.has(label), label);
});

test("the reasons older builds quarantined with for a failed read qualify without a migration", () => {
  for (const reason of [
    "slot Git state is unknown",
    "slot process occupancy is unknown",
    "slot occupancy is unknown",
    "slot Git state could not be inspected",
    "Git registrations could not be read",
    "last-released domain ownership is unknown",
    "last-released domain ownership could not be read",
    "leased domain ownership is unknown",
    "slot occupancy became unknown before reset",
    "slot occupancy became unknown before it was warmed",
    "slot occupancy became unknown before it was seeded from",
    "Git worktree registrations are unknown: git worktree list failed: exit 1",
  ]) assert.equal(isObservationFailure(reason), true, reason);
});

test("a proven fault, or a reason that mixed one in, is not an observation failure", () => {
  for (const reason of [
    null,
    "available slot is occupied or dirty",
    "available slot is dirty",
    "slot Git registration is bare, locked, or prunable",
    "pool marker is missing, unreadable, or belongs to another pool",
    "return reset failed",
    "native worktree materialization outcome is unknown",
    RESERVATION_NOT_HANDED_BACK,
    "slot Git state is unknown, really",
  ]) assert.equal(isObservationFailure(reason), false, String(reason));
});

test("the failed-read note sits in front of a quarantine's detail, is replaced in place, and clears to it", () => {
  const detail = "git checkout failed: fatal: Unable to create '/x/index.lock': File exists.";
  const noted = withObservationFailure(detail, "slot Git state is unknown (git status timed out after 15 s)");
  assert.equal(noted, `Last observation failed: slot Git state is unknown (git status timed out after 15 s)\n${detail}`);
  assert.deepEqual(splitObservationFailure(noted), {
    failure: "slot Git state is unknown (git status timed out after 15 s)",
    rest: detail,
  });
  assert.equal(lockCausedQuarantine(noted), true, "a lock-caused quarantine is still recognized under the note");
  const replaced = withObservationFailure(noted, "slot process occupancy is unknown\n(lsof timed out)");
  assert.equal(replaced, `Last observation failed: slot process occupancy is unknown (lsof timed out)\n${detail}`);
  assert.equal(withoutObservationFailure(replaced), detail);
  assert.equal(withoutObservationFailure(withObservationFailure(null, "x")), null);
  assert.equal(withoutObservationFailure(detail), detail);
  assert.deepEqual(splitObservationFailure(null), { failure: null, rest: null });
});

test("a registration or identity reason is never one automatic recovery may clear, suffixed or not", () => {
  for (const reason of REGISTRATION_OR_IDENTITY_REASONS) {
    assert.equal(clearableQuarantineReason(reason), false, reason);
    assert.equal(registrationOrIdentityQuarantine(reason), true, reason);
    assert.equal(registrationOrIdentityQuarantine(`${reason}: cause`), true, reason);
  }
  assert.equal(registrationOrIdentityQuarantine("slot Git state is unknown"), false);
  assert.equal(registrationOrIdentityQuarantine("return reset failed"), false);
  assert.equal(registrationOrIdentityQuarantine(null), false);
});

test("every registration or identity reason this build writes is in the one set", () => {
  for (const label of Object.values(REGISTRATION_OR_IDENTITY)) {
    assert.ok(REGISTRATION_OR_IDENTITY_REASONS.has(label), label);
  }
});

/**
 * Every other literal reason the manager quarantines with, each classified by being listed
 * here: a reset or proof that failed, an interrupted transition, or a dirty slot. None of them
 * is a registration or identity fault, so Git's lock text may still make one a candidate.
 */
const OTHER_QUARANTINE_REASONS = new Set([
  "Warm reset failed",
  "an interrupted warm lease could not be returned",
  "available slot has dirty or untracked work",
  "dependency claim state could not be recorded",
  "interrupted return did not reach its requested exact HEAD",
  "interrupted return is occupied or dirty",
  "return reset failed",
  "return verification failed",
  "startup found an interrupted provisioning intent",
  "warmed slot verification failed",
]);

/** The same kind of reason, written through a constant because Forget reads them back. */
const NAMED_QUARANTINE_REASONS = { INTERRUPTED_PRUNE, UNVERIFIED_REMOVAL };

test("no quarantine reason in the manager escapes classification", () => {
  const source = readFileSync(new URL("../src/server/worktrees/manager.ts", import.meta.url), "utf8");
  const written = [
    ...source.matchAll(/\b(?:reject|refuse|failPool)\(\s*"([^"]+)"/g),
    ...source.matchAll(/this\.quarantine\(\s*\w+,\s*"([^"]+)"/g),
  ].map((match) => match[1]!);
  assert.ok(written.length >= OTHER_QUARANTINE_REASONS.size, "the patterns still find the writers");
  // A registration or identity reason goes through the constants, so a literal that is not
  // listed above is a new reason nobody has decided about yet.
  for (const reason of written) assert.ok(OTHER_QUARANTINE_REASONS.has(reason), `unclassified: ${reason}`);
  for (const reason of OTHER_QUARANTINE_REASONS) assert.ok(written.includes(reason), `no longer written: ${reason}`);
  for (const [name, reason] of Object.entries(NAMED_QUARANTINE_REASONS)) {
    assert.match(source, new RegExp(`(?:reject\\(|this\\.quarantine\\(\\w+, )${name}\\)`), `no longer written: ${name}`);
    assert.equal(registrationOrIdentityQuarantine(reason), false, reason);
  }
});
