import assert from "node:assert/strict";
import test from "node:test";
import { lockCausedQuarantine } from "../src/server/worktrees/index-lock.ts";
import {
  clearableQuarantineReason,
  isObservationFailure,
  OBSERVATION_FAILURE,
  OBSERVATION_FAILURE_REASONS,
  REGISTRATION_OR_IDENTITY_REASONS,
  registrationOrIdentityQuarantine,
  RESERVATION_NOT_HANDED_BACK,
  splitObservationFailure,
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
