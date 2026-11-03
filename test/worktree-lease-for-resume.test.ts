import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openDb } from "../src/server/db.ts";
import { isCheckoutBranchName, NativeWorktreeGit, parseWorktreePorcelain } from "../src/server/worktrees/git.ts";
import { WorktreeManager, type NativeWorktreeLease, type WorktreeManagerDeps } from "../src/server/worktrees/manager.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { historyResumeOwnerKey } from "../src/server/worktrees/owners.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

/**
 * `leaseForResume`: the worktree manager operation a History Resume leases a slot through. It
 * leases only an idle, detached slot, reads `git worktree list` before touching it, and checks
 * the session's recorded branch out attached, tracking origin's, or detached at its tip when
 * another worktree holds it. Real Git throughout, so every checkout is the one Git makes.
 */

const db = openDb();

afterEach(() => {
  db.exec("DELETE FROM worktree_slot_history; DELETE FROM worktree_slots; DELETE FROM worktree_pools; DELETE FROM app_config WHERE key = 'worktrees';");
});

function manager(deps: Partial<WorktreeManagerDeps> = {}): WorktreeManager {
  return new WorktreeManager(db, {
    occupancy: (paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> =>
      Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants: [] }]))),
    fileHolders: async () => [],
    resolvePolicy: () => ({ enabled: true, maxSlots: 4, setupArgv: null }),
    ...deps,
  });
}

/** A clone with one idle slot in its pool: acquired, then returned. */
async function idleSlot(prefix: string) {
  const { origin, clone } = mkOriginAndClone(prefix);
  const m = manager();
  const acquired = await m.acquire({ repositoryPath: clone, baseSha: gitIn(clone, "rev-parse", "HEAD"), owner: { kind: "task", key: "task-seed" } });
  assert.equal(acquired.outcome, "acquired", JSON.stringify(acquired));
  if (acquired.outcome !== "acquired") throw new Error("not acquired");
  assert.equal((await m.release(acquired.lease, { ownerAuthorized: true })).outcome, "released");
  assert.equal(m.store.slot(acquired.lease.slotId)?.state, "available");
  return { m, origin, clone, slotId: acquired.lease.slotId, path: acquired.lease.path, head: gitIn(acquired.lease.path, "rev-parse", "HEAD") };
}

/** A commit on `branch` in `dir`, returning its sha, leaving `dir` back where it was. */
function commitOn(dir: string, branch: string): string {
  const before = gitIn(dir, "rev-parse", "--abbrev-ref", "HEAD");
  gitIn(dir, "checkout", "-qb", branch);
  writeFileSync(join(dir, "feature.txt"), `${branch}\n`);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-qm", branch);
  const sha = gitIn(dir, "rev-parse", "HEAD");
  gitIn(dir, "checkout", "-q", before);
  return sha;
}

const OWNER = { kind: "manual" as const, key: historyResumeOwnerKey("00000000-0000-4000-8000-000000000001") };

function symbolicHead(path: string): string | null {
  try {
    return gitIn(path, "symbolic-ref", "--quiet", "HEAD");
  } catch {
    return null;
  }
}

function leased(result: Awaited<ReturnType<WorktreeManager["leaseForResume"]>>): NativeWorktreeLease {
  assert.equal(result.outcome, "leased", JSON.stringify(result));
  return (result as { lease: NativeWorktreeLease }).lease;
}

test("an idle slot is leased to the History resume owner with its recorded local branch checked out", async () => {
  const s = await idleSlot("mission-resume-lease-local-");
  const tip = commitOn(s.clone, "feature/local");

  const result = await s.m.leaseForResume(s.slotId, OWNER, "feature/local");
  const lease = leased(result);
  assert.deepEqual(result.outcome === "leased" && result.checkout, { state: "branch", branch: "feature/local" });
  assert.equal(symbolicHead(s.path), "refs/heads/feature/local");
  assert.equal(gitIn(s.path, "rev-parse", "HEAD"), tip);
  assert.equal(lease.baseSha, tip, "the lease records the commit the checkout landed on");
  const slot = s.m.store.slot(s.slotId)!;
  assert.deepEqual([slot.state, slot.activeOwnerKind, slot.activeOwnerKey, slot.activeLeaseId], ["leased", "manual", OWNER.key, lease.leaseId]);
});

test("a branch only origin has is checked out as a new local branch tracking it", async () => {
  const s = await idleSlot("mission-resume-lease-remote-");
  const tip = commitOn(s.origin, "feature/remote");
  gitIn(s.clone, "fetch", "-q", "origin");

  const result = await s.m.leaseForResume(s.slotId, OWNER, "feature/remote");
  leased(result);
  assert.deepEqual(result.outcome === "leased" && result.checkout, { state: "branch", branch: "feature/remote" });
  assert.equal(symbolicHead(s.path), "refs/heads/feature/remote");
  assert.equal(gitIn(s.path, "rev-parse", "HEAD"), tip);
  assert.equal(gitIn(s.path, "rev-parse", "--abbrev-ref", "feature/remote@{upstream}"), "origin/feature/remote");
});

test("a missing recorded branch, or none at all, leaves the slot detached where it was", async () => {
  const s = await idleSlot("mission-resume-lease-missing-");
  const missing = await s.m.leaseForResume(s.slotId, OWNER, "feature/gone");
  const lease = leased(missing);
  assert.deepEqual(missing.outcome === "leased" && missing.checkout, { state: "missing", branch: "feature/gone" });
  assert.equal(symbolicHead(s.path), null);
  assert.equal(gitIn(s.path, "rev-parse", "HEAD"), s.head);
  assert.equal((await s.m.release(lease, { ownerAuthorized: true })).outcome, "released");

  for (const branch of [null, "HEAD", "-f", "a..b"]) {
    const result = await s.m.leaseForResume(s.slotId, OWNER, branch);
    const taken = leased(result);
    assert.deepEqual(result.outcome === "leased" && result.checkout, { state: "missing", branch }, String(branch));
    assert.equal(symbolicHead(s.path), null);
    assert.equal((await s.m.release(taken, { ownerAuthorized: true })).outcome, "released");
  }
});

test("a branch attached to another worktree is checked out detached at its tip, naming that worktree", async () => {
  const s = await idleSlot("mission-resume-lease-elsewhere-");
  // The main checkout sits on the branch: a checkout outside the pool.
  const tip = commitOn(s.clone, "feature/held");
  gitIn(s.clone, "checkout", "-q", "feature/held");

  const result = await s.m.leaseForResume(s.slotId, OWNER, "feature/held");
  leased(result);
  assert.deepEqual(result.outcome === "leased" && result.checkout, { state: "elsewhere", branch: "feature/held", path: s.clone });
  assert.equal(symbolicHead(s.path), null, "the slot holds no branch");
  assert.equal(gitIn(s.path, "rev-parse", "HEAD"), tip);
  assert.equal(symbolicHead(s.clone), "refs/heads/feature/held", "the other worktree keeps its branch");
});

test("a slot attached to a branch is refused, and left exactly as it was", async () => {
  const s = await idleSlot("mission-resume-lease-attached-");
  gitIn(s.path, "checkout", "-qb", "left-behind");
  const before = s.m.store.slot(s.slotId)!;

  const result = await s.m.leaseForResume(s.slotId, OWNER, "main");
  assert.deepEqual(result, { outcome: "refused", reason: "the slot is attached to a branch, which only a reset can undo" });
  const after = s.m.store.slot(s.slotId)!;
  assert.deepEqual([after.state, after.version, after.activeLeaseId], [before.state, before.version, null]);
  assert.equal(symbolicHead(s.path), "refs/heads/left-behind");
});

test("a slot another owner holds is refused, and its lease stands", async () => {
  const s = await idleSlot("mission-resume-lease-held-");
  const held = await s.m.leaseAsIs(s.slotId, { kind: "manual", key: "terminal-other" });
  assert.equal(held.outcome, "leased");

  const result = await s.m.leaseForResume(s.slotId, OWNER, "main");
  assert.equal(result.outcome, "refused");
  assert.equal(s.m.store.slot(s.slotId)?.activeOwnerKey, "terminal-other");
});

test("a checkout that failed and left the slot untouched hands the reservation back; one that may have moved it quarantines", async () => {
  for (const outcomeUnknown of [false, true]) {
    const s = await idleSlot(`mission-resume-lease-failed-${outcomeUnknown}-`);
    commitOn(s.clone, "feature/blocked");
    const real = new NativeWorktreeGit();
    const failing = Object.assign(Object.create(real) as NativeWorktreeGit, {
      checkoutBranch: async () => ({ ok: false as const, reason: "git checkout failed: refused", outcomeUnknown }),
    });
    const m = manager({ git: failing });

    const result = await m.leaseForResume(s.slotId, OWNER, "feature/blocked");
    const slot = m.store.slot(s.slotId)!;
    if (outcomeUnknown) {
      assert.equal(result.outcome, "outcomeUnknown", JSON.stringify(result));
      assert.equal(slot.state, "quarantined");
    } else {
      assert.deepEqual(result, { outcome: "refused", reason: "git checkout failed: refused" });
      assert.deepEqual([slot.state, slot.activeLeaseId], ["available", null]);
    }
    assert.equal(gitIn(s.path, "rev-parse", "HEAD"), s.head);
  }
});

test("registrations carry the branch checked out in them, and recorded names that are not one are refused", () => {
  assert.deepEqual(
    parseWorktreePorcelain("worktree /a\nHEAD 1111\nbranch refs/heads/main\n\nworktree /b\nHEAD 2222\ndetached\n").map((entry) => entry.branch),
    ["refs/heads/main", null],
  );
  for (const name of ["main", "feature/x", "ramiro314/session-history-resume"]) assert.equal(isCheckoutBranchName(name), true, name);
  for (const name of [null, "", "HEAD", "-b", "a..b", "a b", "a~1", "x.lock", "/a", "a/", "a@{1}"]) {
    assert.equal(isCheckoutBranchName(name), false, String(name));
  }
});
