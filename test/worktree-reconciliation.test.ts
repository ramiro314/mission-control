import assert from "node:assert/strict";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { openDb } from "../src/server/db.ts";
import {
  WorktreeManager,
  type NativeWorktreeLease,
  type WorktreeManagerDeps,
} from "../src/server/worktrees/manager.ts";
import { NativeWorktreeGit, type WorktreeGit } from "../src/server/worktrees/git.ts";
import { run, type RunResult } from "../src/server/util/exec.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

const db = openDb();

afterEach(() => {
  db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools; DELETE FROM app_config WHERE key = 'worktrees';");
});

function repo(prefix: string): { clone: string; sha: string } {
  const { clone } = mkOriginAndClone(prefix);
  return { clone, sha: gitIn(clone, "rev-parse", "HEAD") };
}

function acquired(
  result: Awaited<ReturnType<WorktreeManager["acquire"]>>,
): NativeWorktreeLease {
  assert.equal(result.outcome, "acquired");
  return (result as { outcome: "acquired"; lease: NativeWorktreeLease }).lease;
}

function harness(options: {
  referenced?: Set<string>;
  occupancy?: Map<string, WorktreeOccupancy>;
  policy?: () => { enabled: boolean; maxSlots: number; setupArgv: readonly string[] | null };
  git?: WorktreeGit;
} = {}): WorktreeManager {
  const referenced = options.referenced ?? new Set<string>();
  const deps: Partial<WorktreeManagerDeps> = {
    ownerReferenced: async (reference) => referenced.has(reference.leaseId),
    resolvePolicy: options.policy ?? (() => ({ enabled: true, maxSlots: 16, setupArgv: null })),
    occupancy: async (paths) =>
      new Map(
        paths.map((path) => [
          path,
          options.occupancy?.get(path) ?? { status: "known" as const, occupants: [] },
        ]),
      ),
    ...(options.git ? { git: options.git } : {}),
  };
  return new WorktreeManager(db, deps);
}

test("startup preserves a referenced active lease even when it is dirty and occupied", async () => {
  const repository = repo("mission-reconcile-live-");
  const referenced = new Set<string>();
  const occupancy = new Map<string, WorktreeOccupancy>();
  const manager = harness({ referenced, occupancy });
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-live" },
    }),
  );
  referenced.add(lease.leaseId);
  writeFileSync(`${lease.path}/in-progress.txt`, "work\n");
  occupancy.set(lease.path, {
    status: "known",
    occupants: [
      {
        pid: 77,
        ppid: 1,
        startRaw: "now",
        startMs: 1,
        command: "codex",
        cwd: lease.path,
        knownOwner: "terminal:session-live",
      },
    ],
  });

  await manager.reconcile();
  assert.equal(manager.store.slot(lease.slotId)?.state, "leased");
  assert.equal(manager.store.slot(lease.slotId)?.currentHeadSha, repository.sha);
});

test("startup quarantines stale leases and interrupted provisioning, and leaves unknown occupancy as it was", async () => {
  const staleRepo = repo("mission-reconcile-stale-");
  const stale = harness();
  const staleLease = acquired(
    await stale.acquire({
      repositoryPath: staleRepo.clone,
      baseSha: staleRepo.sha,
      owner: { kind: "task", key: "task-stale" },
    }),
  );
  await stale.reconcile();
  assert.equal(stale.store.slot(staleLease.slotId)?.state, "quarantined");
  assert.match(stale.store.slot(staleLease.slotId)?.quarantineReason ?? "", /no matching domain owner/);

  const interruptedRepo = repo("mission-reconcile-provisioning-");
  const refs = new Set<string>();
  const interrupted = harness({ referenced: refs });
  const interruptedLease = acquired(
    await interrupted.acquire({
      repositoryPath: interruptedRepo.clone,
      baseSha: interruptedRepo.sha,
      owner: { kind: "check", key: "attempt-1" },
    }),
  );
  refs.add(interruptedLease.leaseId);
  db.prepare(`UPDATE worktree_slots SET state = 'provisioning' WHERE id = ?`).run(
    interruptedLease.slotId,
  );
  await interrupted.reconcile();
  assert.equal(interrupted.store.slot(interruptedLease.slotId)?.state, "quarantined");
  assert.match(
    interrupted.store.slot(interruptedLease.slotId)?.quarantineReason ?? "",
    /interrupted provisioning/,
  );

  const unknownRepo = repo("mission-reconcile-unknown-");
  const occupancy = new Map<string, WorktreeOccupancy>();
  const unknown = harness({ occupancy });
  const unknownLease = acquired(
    await unknown.acquire({
      repositoryPath: unknownRepo.clone,
      baseSha: unknownRepo.sha,
      owner: { kind: "manual", key: "manual-1" },
    }),
  );
  occupancy.set(unknownLease.path, { status: "unknown", reason: "lsof timed out" });
  await unknown.reconcile();
  // A failed read proves nothing, so the lease is not judged at all this pass.
  assert.equal(unknown.store.slot(unknownLease.slotId)?.state, "leased");
  assert.equal(
    unknown.store.slot(unknownLease.slotId)?.lastError,
    "Last observation failed: slot process occupancy is unknown (lsof timed out)",
  );
});

test("startup completes only a returning intent whose reset result is positively proven", async () => {
  const repository = repo("mission-reconcile-returning-");
  const referenced = new Set<string>();
  const manager = harness({
    referenced,
    policy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }),
  });
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-returning" },
    }),
  );
  const returning = manager.store.markReturning(
    lease.slotId,
    lease.slotVersion,
    repository.sha,
    Date.now(),
  );
  assert.ok(returning);
  referenced.add(lease.leaseId);

  await manager.reconcile();
  const available = manager.store.slot(lease.slotId)!;
  assert.equal(available.state, "available");
  assert.equal(available.lastReleasedLeaseId, lease.leaseId);
  assert.equal(available.lastReleasedOwnerKind, "task");
  assert.equal(available.lastReleasedOwnerKey, "task-returning");

  // The caller can retry after its domain row failed to clear and still prove completion.
  assert.deepEqual(await manager.release(lease), { outcome: "alreadyReleased" });
  const blocked = await manager.acquire({
    repositoryPath: repository.clone,
    baseSha: repository.sha,
    owner: { kind: "task", key: "task-next" },
  });
  assert.equal(blocked.outcome, "notAcquired");
  assert.equal(manager.store.slot(lease.slotId)?.state, "available");

  referenced.delete(lease.leaseId);
  const next = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-next" },
    }),
  );
  assert.equal(next.slotId, lease.slotId);
  assert.equal((await manager.release(next)).outcome, "released");
});

test("startup keeps safe available/quarantined states and rejects dirty availability", async () => {
  const safeRepo = repo("mission-reconcile-available-");
  const safe = harness();
  const lease = acquired(
    await safe.acquire({
      repositoryPath: safeRepo.clone,
      baseSha: safeRepo.sha,
      owner: { kind: "task", key: "task-available" },
    }),
  );
  assert.equal((await safe.release(lease)).outcome, "released");
  await safe.reconcile();
  assert.equal(safe.store.slot(lease.slotId)?.state, "available");

  writeFileSync(`${lease.path}/scratch.txt`, "not safe\n");
  await safe.reconcile();
  const quarantined = safe.store.slot(lease.slotId)!;
  assert.equal(quarantined.state, "quarantined");
  const version = quarantined.version;
  await safe.reconcile();
  assert.equal(safe.store.slot(lease.slotId)?.state, "quarantined");
  assert.equal(safe.store.slot(lease.slotId)?.version, version, "quarantine is not repeatedly transitioned");
});

test("startup removes only a pruning intent whose path and registration are both absent", async () => {
  const repository = repo("mission-reconcile-pruning-");
  const manager = harness();
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-prune" },
    }),
  );
  db.prepare(`UPDATE worktree_slots SET state = 'pruning', version = version + 1 WHERE id = ?`).run(
    lease.slotId,
  );
  gitIn(repository.clone, "worktree", "remove", "--force", lease.path);
  await manager.reconcile();
  assert.equal(manager.store.slot(lease.slotId), null);
});

test("startup quarantines incomplete active identity instead of treating it as absent", async () => {
  const repository = repo("mission-reconcile-incomplete-identity-");
  const manager = harness();
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-incomplete" },
    }),
  );
  assert.equal((await manager.release(lease)).outcome, "released");
  db.prepare(`UPDATE worktree_slots SET active_lease_id = 'dangling' WHERE id = ?`).run(lease.slotId);

  await manager.reconcile();
  assert.equal(manager.store.slot(lease.slotId)?.state, "quarantined");
  assert.match(manager.store.slot(lease.slotId)?.quarantineReason ?? "", /incomplete active/);
});

test("maintenance planning requires the exact native pool marker", async () => {
  const repository = repo("mission-maintenance-marker-");
  const manager = harness();
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-marker" },
    }),
  );
  assert.equal((await manager.release(lease)).outcome, "released");
  const pool = manager.store.poolForSlot(lease.slotId)!;
  writeFileSync(
    `${pool.poolPath}/.mission-control-worktree-pool`,
    '{"schemaVersion":1,"poolId":"somebody-else"}\n',
  );

  const plan = await manager.planMaintenance();
  assert.equal(plan[0]?.safe, false);
  assert.match(plan[0]?.reason ?? "", /marker/);
});

test("maintenance planning reads the observed remote default without fetching", async () => {
  const repository = repo("mission-maintenance-read-only-");
  class TrackingGit extends NativeWorktreeGit {
    fetchCalls = 0;
    observedCalls = 0;

    override async fetchDefaultSha(identity: Parameters<WorktreeGit["fetchDefaultSha"]>[0]) {
      this.fetchCalls++;
      return super.fetchDefaultSha(identity);
    }

    override async observedDefaultSha(identity: Parameters<WorktreeGit["observedDefaultSha"]>[0]) {
      this.observedCalls++;
      return super.observedDefaultSha(identity);
    }
  }
  const git = new TrackingGit();
  const manager = harness({ git });
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-read-only-plan" },
    }),
  );
  assert.equal((await manager.release(lease)).outcome, "released");
  const fetchCallsBeforePlan = git.fetchCalls;
  const observedCallsBeforePlan = git.observedCalls;

  const plan = await manager.planMaintenance();
  assert.equal(plan[0]?.safe, true);
  assert.equal(git.fetchCalls, fetchCallsBeforePlan, "preview planning must not fetch");
  assert.equal(git.observedCalls, observedCallsBeforePlan + 1);
});

test("maintenance planning refuses every unsafe class and identifies safe right-size work", async () => {
  const repository = repo("mission-maintenance-plan-");
  const referenced = new Set<string>();
  const occupancy = new Map<string, WorktreeOccupancy>();
  let maxSlots = 7;
  const manager = harness({
    referenced,
    occupancy,
    policy: () => ({ enabled: true, maxSlots, setupArgv: null }),
  });
  const leases: NativeWorktreeLease[] = [];
  for (let index = 0; index < 7; index++) {
    leases.push(
      acquired(
        await manager.acquire({
          repositoryPath: repository.clone,
          baseSha: repository.sha,
          owner: { kind: "task", key: `task-${index}` },
        }),
      ),
    );
  }
  // Keep one leased. Return the others, then make each one unsafe in a distinct way.
  for (const lease of leases.slice(0, 6)) assert.equal((await manager.release(lease)).outcome, "released");
  referenced.add(leases[1]!.leaseId);
  writeFileSync(`${leases[2]!.path}/dirty.txt`, "dirty\n");
  occupancy.set(leases[3]!.path, {
    status: "known",
    occupants: [{
      pid: 81,
      ppid: 1,
      startRaw: "now",
      startMs: 1,
      command: "node",
      cwd: leases[3]!.path,
      knownOwner: null,
    }],
  });
  writeFileSync(`${leases[4]!.path}/keep.txt`, "base\nunmerged\n");
  gitIn(leases[4]!.path, "add", "keep.txt");
  gitIn(leases[4]!.path, "commit", "-qm", "unmerged local work");
  occupancy.set(leases[5]!.path, { status: "unknown", reason: "cwd scan failed" });
  maxSlots = 1;

  const plan = await manager.planMaintenance();
  const bySlot = new Map(plan.map((candidate) => [candidate.slotId, candidate]));
  assert.equal(bySlot.get(leases[0]!.slotId)?.safe, true);
  assert.match(bySlot.get(leases[1]!.slotId)?.reason ?? "", /domain ownership/);
  assert.match(bySlot.get(leases[2]!.slotId)?.reason ?? "", /cleanliness/);
  assert.match(bySlot.get(leases[3]!.slotId)?.reason ?? "", /occupied/);
  assert.match(bySlot.get(leases[4]!.slotId)?.reason ?? "", /not merged/);
  assert.match(bySlot.get(leases[5]!.slotId)?.reason ?? "", /cwd scan failed/);
  assert.match(bySlot.get(leases[6]!.slotId)?.reason ?? "", /leased/);
  assert.equal(plan.filter((candidate) => candidate.rightSize).length, 6);
});

test("reconcile withdraws a quarantined slot's active owner only when non-reference is proven", async () => {
  const cases = [
    { name: "unreferenced", withdrawn: true },
    { name: "referenced", withdrawn: false },
    { name: "unknown", withdrawn: false },
  ] as const;
  for (const entry of cases) {
    const repository = repo(`mission-reconcile-orphan-${entry.name}-`);
    let leaseId = "";
    const manager = new WorktreeManager(db, {
      resolvePolicy: () => ({ enabled: true, maxSlots: 16, setupArgv: null }),
      occupancy: async (paths) => new Map(paths.map((path) => [path, { status: "known" as const, occupants: [] }])),
      ownerReferenced: async (reference) => {
        if (reference.leaseId !== leaseId) return false;
        if (entry.name === "unknown") throw new Error("tasks table is unreadable");
        return entry.name === "referenced";
      },
      pause: async () => {},
    });
    const lease = acquired(
      await manager.acquire({
        repositoryPath: repository.clone,
        baseSha: repository.sha,
        owner: { kind: "task", key: `task-orphan-${entry.name}:0` },
      }),
    );
    leaseId = lease.leaseId;
    // What an earlier build left after a failed materialization: quarantined, owner stamped.
    db.prepare(`UPDATE worktree_slots SET state = 'quarantined', quarantine_reason = 'setup failed' WHERE id = ?`)
      .run(lease.slotId);

    await manager.reconcile();
    const slot = manager.store.slot(lease.slotId)!;
    assert.equal(slot.state, "quarantined", `${entry.name}: the slot stays quarantined`);
    assert.equal(slot.quarantineReason, "setup failed", `${entry.name}: the quarantine reason is kept`);
    if (entry.withdrawn) {
      assert.equal(slot.activeLeaseId, null);
      assert.equal(slot.activeOwnerKind, null);
      assert.equal(slot.activeOwnerKey, null);
      assert.equal((await manager.removeSlot({ slotId: slot.id, allowDirty: false, allowUnmerged: false })).outcome, "removed");
    } else {
      assert.equal(slot.activeLeaseId, lease.leaseId, `${entry.name}: the active identity is untouched`);
      assert.equal(slot.activeOwnerKey, `task-orphan-${entry.name}:0`);
    }
  }
});

/** What `run` reports for a child it killed at its timeout. */
function timedOut(timeoutMs: number | undefined): RunResult {
  return {
    stdout: "",
    stderr: "",
    code: 1,
    outcomeUnknown: true,
    overflowed: false,
    timedOut: true,
    signal: "SIGTERM",
    timeoutMs,
  };
}

test("a Git read killed at its timeout on both attempts records both, never `exit 1`", async () => {
  const repository = repo("mission-reconcile-git-timeout-");
  const referenced = new Set<string>();
  let failStatus = false;
  const statusTimeouts: Array<number | undefined> = [];
  const pauses: number[] = [];
  const git = new NativeWorktreeGit(
    async (bin, args, opts) => {
      if (failStatus && args.includes("status")) {
        statusTimeouts.push(opts?.timeoutMs);
        return timedOut(opts?.timeoutMs);
      }
      return run(bin, args, opts);
    },
    async (ms) => {
      pauses.push(ms);
    },
  );
  const manager = harness({ referenced, git });
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-git-timeout" },
    }),
  );
  referenced.add(lease.leaseId);
  failStatus = true;

  await manager.reconcile();
  assert.deepEqual(statusTimeouts, [15_000, 30_000], "the retry runs with double the timeout");
  assert.deepEqual(pauses, [2_000], "2 s after the first failure");
  const slot = manager.store.slot(lease.slotId)!;
  assert.equal(slot.state, "leased", "a failed read leaves the slot in its state");
  assert.equal(slot.quarantineReason, null);
  assert.equal(
    slot.lastError,
    "Last observation failed: slot Git state is unknown (git status timed out after 15 s, and after 30 s on retry)",
  );

  failStatus = false;
  await manager.reconcile();
  assert.equal(manager.store.slot(lease.slotId)?.state, "leased");
  assert.equal(manager.store.slot(lease.slotId)?.lastError, null, "the next good read clears it");
});

test("a worktree listing that fails once and then succeeds changes nothing", async () => {
  const repository = repo("mission-reconcile-list-retry-");
  const referenced = new Set<string>();
  let failNextList = false;
  let lists = 0;
  const git = new NativeWorktreeGit(
    async (bin, args, opts) => {
      if (args.includes("list")) {
        lists++;
        if (failNextList) {
          failNextList = false;
          return timedOut(opts?.timeoutMs);
        }
      }
      return run(bin, args, opts);
    },
    async () => {},
  );
  const manager = harness({ referenced, git });
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-list-retry" },
    }),
  );
  referenced.add(lease.leaseId);
  const before = manager.store.slot(lease.slotId)!;
  lists = 0;
  failNextList = true;

  await manager.reconcile();
  assert.equal(lists, 2, "the failed listing was read once more");
  const after = manager.store.slot(lease.slotId)!;
  assert.equal(after.state, "leased");
  assert.equal(after.quarantineReason, null);
  assert.equal(after.lastError, before.lastError);
  assert.equal(after.activeLeaseId, lease.leaseId);
});

test("an owner lookup that throws once is retried before it counts as unknown", async () => {
  const repository = repo("mission-reconcile-owner-retry-");
  let leaseId = "";
  let throws = 1;
  const pauses: number[] = [];
  const manager = new WorktreeManager(db, {
    resolvePolicy: () => ({ enabled: true, maxSlots: 16, setupArgv: null }),
    occupancy: async (paths) => new Map(paths.map((path) => [path, { status: "known" as const, occupants: [] }])),
    ownerReferenced: async (reference) => {
      if (reference.leaseId !== leaseId) return false;
      if (throws-- > 0) throw new Error("database is locked");
      return false;
    },
    pause: async (ms) => {
      pauses.push(ms);
    },
  });
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-owner-retry:0" },
    }),
  );
  leaseId = lease.leaseId;
  db.prepare(`UPDATE worktree_slots SET state = 'quarantined', quarantine_reason = 'setup failed' WHERE id = ?`)
    .run(lease.slotId);

  await manager.reconcile();
  assert.deepEqual(pauses, [2_000]);
  // The retry proved the owner gone, so the stale identity is withdrawn as for any proven absence.
  assert.equal(manager.store.slot(lease.slotId)?.activeLeaseId, null);
});

test("a Git read that exits with its own error is answered at once, without a retry", async () => {
  const repository = repo("mission-reconcile-git-definite-");
  let failStatus = false;
  let statusReads = 0;
  const git = new NativeWorktreeGit(
    async (bin, args, opts) => {
      if (failStatus && args.includes("status")) {
        statusReads++;
        return { stdout: "", stderr: "fatal: index file corrupt\n", code: 128, outcomeUnknown: false, overflowed: false };
      }
      return run(bin, args, opts);
    },
    async () => assert.fail("a Git that reported its own exit would say the same again"),
  );
  const manager = harness({ git });
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-git-definite" },
    }),
  );
  failStatus = true;
  const inspected = await git.inspect(lease.path);
  assert.equal(statusReads, 1);
  assert.deepEqual(inspected, { ok: false, reason: "git status failed: fatal: index file corrupt", outcomeUnknown: false });
});

test("a listing that fails twice leaves every slot in its state, records it on each, and the next good pass clears it", async (t) => {
  const repository = repo("mission-reconcile-list-unknown-");
  const referenced = new Set<string>();
  let failList = false;
  const git = new NativeWorktreeGit(
    async (bin, args, opts) => failList && args.includes("list") ? timedOut(opts?.timeoutMs) : run(bin, args, opts),
    async () => {},
  );
  const manager = harness({ referenced, git });
  const take = async (key: string) => acquired(
    await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha, owner: { kind: "task", key } }),
  );
  const leased = await take("task-list-leased");
  const available = await take("task-list-available");
  const quarantined = await take("task-list-quarantined");
  referenced.add(leased.leaseId);
  referenced.add(quarantined.leaseId);
  assert.equal((await manager.release(available)).outcome, "released");
  manager.store.quarantine(quarantined.slotId, "worktree reset failed", "fatal: unable to write new index file", Date.now(), quarantined.slotVersion);
  const before = new Map(manager.store.slots().map((slot) => [slot.id, slot]));
  const warned = t.mock.method(console, "warn", () => {});

  failList = true;
  await manager.reconcile();
  const failure = "Last observation failed: Git worktree registrations are unknown " +
    "(git worktree list timed out after 30 s, and after 60 s on retry)";
  for (const slot of manager.store.slots()) {
    const prior = before.get(slot.id)!;
    assert.equal(slot.state, prior.state, `slot ${slot.ordinal} keeps its state`);
    assert.equal(slot.version, prior.version, `slot ${slot.ordinal} is not transitioned`);
    assert.equal(slot.quarantineReason, prior.quarantineReason);
  }
  assert.deepEqual(
    [leased, available, quarantined].map((lease) => manager.store.slot(lease.slotId)?.state),
    ["leased", "available", "quarantined"],
  );
  assert.equal(manager.store.slot(leased.slotId)?.lastError, failure);
  assert.equal(manager.store.slot(available.slotId)?.lastError, failure);
  // A quarantine's own detail is kept under the note, never replaced by it.
  assert.equal(manager.store.slot(quarantined.slotId)?.lastError, `${failure}\nfatal: unable to write new index file`);
  const lines = () => warned.mock.calls.map((call) => String(call.arguments[0]))
    .filter((line) => line.includes("after a failed read"));
  assert.equal(lines().length, 3, "one line per slot");
  assert.match(lines()[0]!, /^\[worktrees\] left clone slot 1 leased after a failed read: Git worktree registrations are unknown/);

  await manager.reconcile();
  assert.equal(lines().length, 3, "the same failure on a later pass is not logged again");

  failList = false;
  await manager.reconcile();
  assert.equal(manager.store.slot(leased.slotId)?.state, "leased");
  assert.equal(manager.store.slot(leased.slotId)?.lastError, null);
  assert.equal(manager.store.slot(available.slotId)?.state, "available");
  assert.equal(manager.store.slot(available.slotId)?.lastError, null);
  assert.equal(manager.store.slot(quarantined.slotId)?.state, "quarantined");
  assert.equal(manager.store.slot(quarantined.slotId)?.lastError, "fatal: unable to write new index file");
});

test("a pool marker that cannot be read leaves every slot as it was; one that is missing quarantines", async () => {
  const repository = repo("mission-reconcile-marker-unknown-");
  const referenced = new Set<string>();
  const manager = harness({ referenced });
  const lease = acquired(
    await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha, owner: { kind: "task", key: "task-marker-unknown" } }),
  );
  referenced.add(lease.leaseId);
  const markerPath = `${manager.store.poolForSlot(lease.slotId)!.poolPath}/.mission-control-worktree-pool`;
  const contents = readFileSync(markerPath);
  chmodSync(markerPath, 0o000);
  try {
    await manager.reconcile();
  } finally {
    chmodSync(markerPath, 0o644);
  }
  const unread = manager.store.slot(lease.slotId)!;
  if (process.getuid?.() !== 0) {
    assert.equal(unread.state, "leased");
    assert.match(unread.lastError ?? "", /^Last observation failed: pool marker could not be read \(.*EACCES/);
  }

  rmSync(markerPath);
  await manager.reconcile();
  assert.equal(manager.store.slot(lease.slotId)?.state, "quarantined");
  assert.equal(manager.store.slot(lease.slotId)?.quarantineReason, "pool marker is missing, malformed, or belongs to another pool");
  writeFileSync(markerPath, contents);
});

test("reconcile quarantines a dirty available slot and leaves an occupied one available, skipped and listed", async () => {
  const repository = repo("mission-reconcile-occupied-dirty-");
  const occupancy = new Map<string, WorktreeOccupancy>();
  const manager = harness({ occupancy, policy: () => ({ enabled: true, maxSlots: 2, setupArgv: null }) });
  const take = async (key: string) => acquired(
    await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha, owner: { kind: "task", key } }),
  );
  const occupied = await take("task-occupied");
  const dirty = await take("task-dirty");
  assert.equal((await manager.release(occupied)).outcome, "released");
  assert.equal((await manager.release(dirty)).outcome, "released");
  const occupant = {
    pid: 4242,
    ppid: 1,
    startRaw: "now",
    startMs: 1_700_000_000_000,
    command: "node vite",
    cwd: occupied.path,
    knownOwner: null,
  };
  occupancy.set(occupied.path, { status: "known", occupants: [occupant] });
  writeFileSync(`${dirty.path}/scratch.txt`, "left behind\n");

  await manager.reconcile();
  assert.equal(manager.store.slot(dirty.slotId)?.state, "quarantined");
  assert.equal(manager.store.slot(dirty.slotId)?.quarantineReason, "available slot is dirty");
  assert.equal(manager.store.slot(occupied.slotId)?.state, "available");
  assert.equal(manager.store.slot(occupied.slotId)?.quarantineReason, null);
  assert.equal(manager.store.slot(occupied.slotId)?.lastError, null);

  // Acquisition passes over the occupied slot, without quarantining it.
  const refused = await manager.acquire({
    repositoryPath: repository.clone,
    baseSha: repository.sha,
    owner: { kind: "task", key: "task-after" },
  });
  assert.equal(refused.outcome, "notAcquired");
  assert.equal(manager.store.slot(occupied.slotId)?.state, "available");
  assert.equal(manager.store.slot(occupied.slotId)?.quarantineReason, null);
  const observed = (await manager.status()).flatMap((pool) => pool.slots).find((entry) => entry.slot.id === occupied.slotId);
  assert.deepEqual(observed?.occupancy, { status: "known", occupants: [occupant] });
});

test("acquisition does not lease a slot whose Git read failed twice, and leaves it available", async () => {
  const repository = repo("mission-acquire-git-unknown-");
  let failPath: string | null = null;
  const git = new NativeWorktreeGit(
    async (bin, args, opts) =>
      failPath !== null && args.includes(failPath) && args.includes("status") ? timedOut(opts?.timeoutMs) : run(bin, args, opts),
    async () => {},
  );
  const manager = harness({ git, policy: () => ({ enabled: true, maxSlots: 2, setupArgv: null }) });
  const first = acquired(
    await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha, owner: { kind: "task", key: "task-git-1" } }),
  );
  assert.equal((await manager.release(first)).outcome, "released");
  const before = manager.store.slot(first.slotId)!;
  failPath = first.path;

  const second = acquired(
    await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha, owner: { kind: "task", key: "task-git-2" } }),
  );
  assert.notEqual(second.slotId, first.slotId, "a new slot, since the first could not be proven idle this pass");
  const after = manager.store.slot(first.slotId)!;
  assert.equal(after.state, "available");
  assert.equal(after.version, before.version);
  assert.equal(
    after.lastError,
    "Last observation failed: slot Git state is unknown (git status timed out after 15 s, and after 30 s on retry)",
  );

  failPath = null;
  assert.equal((await manager.release(second)).outcome, "released");
  const third = acquired(
    await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha, owner: { kind: "task", key: "task-git-3" } }),
  );
  assert.equal(third.slotId, first.slotId, "proven idle once its read answers");
  await manager.release(third);
});

test("idle screening leaves available slots in place when `git worktree list` fails twice", async () => {
  const repository = repo("mission-screen-list-unknown-");
  let failList = false;
  const git = new NativeWorktreeGit(
    async (bin, args, opts) => failList && args.includes("list") ? timedOut(opts?.timeoutMs) : run(bin, args, opts),
    async () => {},
  );
  const manager = harness({ git, policy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }) });
  const first = acquired(
    await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha, owner: { kind: "task", key: "task-screen-list-1" } }),
  );
  assert.equal((await manager.release(first)).outcome, "released");
  const before = manager.store.slot(first.slotId)!;
  failList = true;

  const refused = await manager.acquire({
    repositoryPath: repository.clone,
    baseSha: repository.sha,
    owner: { kind: "task", key: "task-screen-list-2" },
  });
  assert.equal(refused.outcome, "notAcquired");
  const after = manager.store.slot(first.slotId)!;
  assert.equal(after.state, "available", "not leased, and not quarantined");
  assert.equal(after.version, before.version);
  assert.equal(after.quarantineReason, null);
  assert.equal(after.activeLeaseId, null);
  assert.match(after.lastError ?? "", /^Last observation failed: Git worktree registrations are unknown \(git worktree list timed out/);

  failList = false;
  const third = acquired(
    await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha, owner: { kind: "task", key: "task-screen-list-3" } }),
  );
  assert.equal(third.slotId, first.slotId, "leased once its listing answers");
  await manager.release(third);
});

test("idle screening leaves an available slot in place when its occupancy is unknown", async () => {
  const repository = repo("mission-screen-occupancy-unknown-");
  const occupancy = new Map<string, WorktreeOccupancy>();
  const manager = harness({ occupancy, policy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }) });
  const first = acquired(
    await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha, owner: { kind: "task", key: "task-screen-occ-1" } }),
  );
  assert.equal((await manager.release(first)).outcome, "released");
  const before = manager.store.slot(first.slotId)!;
  occupancy.set(first.path, { status: "unknown", reason: "lsof timed out" });

  const refused = await manager.acquire({
    repositoryPath: repository.clone,
    baseSha: repository.sha,
    owner: { kind: "task", key: "task-screen-occ-2" },
  });
  assert.equal(refused.outcome, "notAcquired");
  const after = manager.store.slot(first.slotId)!;
  assert.equal(after.state, "available");
  assert.equal(after.version, before.version);
  assert.equal(after.quarantineReason, null);
  assert.equal(after.lastError, "Last observation failed: slot process occupancy is unknown (lsof timed out)");

  occupancy.delete(first.path);
  await manager.reconcile();
  assert.equal(manager.store.slot(first.slotId)?.lastError, null, "the next good pass clears it");
});

test("an owner lookup that throws on both attempts leaves leased and available slots in their state", async () => {
  const repository = repo("mission-reconcile-owner-unknown-");
  const throwing = new Set<string>();
  const referenced = new Set<string>();
  const manager = new WorktreeManager(db, {
    resolvePolicy: () => ({ enabled: true, maxSlots: 2, setupArgv: null }),
    occupancy: async (paths) => new Map(paths.map((path) => [path, { status: "known" as const, occupants: [] }])),
    ownerReferenced: async (reference) => {
      if (throwing.has(reference.leaseId)) throw new Error("database is locked");
      return referenced.has(reference.leaseId);
    },
    pause: async () => {},
  });
  const take = async (key: string) => acquired(
    await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha, owner: { kind: "task", key } }),
  );
  const leased = await take("task-owner-unknown-leased");
  const released = await take("task-owner-unknown-released");
  referenced.add(leased.leaseId);
  assert.equal((await manager.release(released)).outcome, "released");
  throwing.add(leased.leaseId);
  throwing.add(released.leaseId);
  const before = new Map([leased, released].map((lease) => [lease.slotId, manager.store.slot(lease.slotId)!]));

  await manager.reconcile();
  const failure = "database is locked, and again on retry";
  const leasedRow = manager.store.slot(leased.slotId)!;
  assert.equal(leasedRow.state, "leased");
  assert.equal(leasedRow.version, before.get(leased.slotId)!.version);
  assert.equal(leasedRow.quarantineReason, null);
  assert.equal(leasedRow.lastError, `Last observation failed: leased domain ownership is unknown (Error: ${failure})`);
  const availableRow = manager.store.slot(released.slotId)!;
  assert.equal(availableRow.state, "available");
  assert.equal(availableRow.version, before.get(released.slotId)!.version);
  assert.equal(availableRow.quarantineReason, null);
  assert.equal(availableRow.lastError, `Last observation failed: last-released domain ownership is unknown (Error: ${failure})`);

  // Acquisition screens the same available slot, cannot prove its last owner gone, and does not
  // lease it; capacity is full, so nothing is leased at all.
  const refused = await manager.acquire({
    repositoryPath: repository.clone,
    baseSha: repository.sha,
    owner: { kind: "task", key: "task-owner-unknown-next" },
  });
  assert.equal(refused.outcome, "notAcquired");
  assert.equal(manager.store.slot(released.slotId)?.state, "available");
  assert.equal(manager.store.slot(released.slotId)?.quarantineReason, null);
  assert.equal(manager.store.slot(released.slotId)?.activeLeaseId, null);

  throwing.clear();
  await manager.reconcile();
  assert.equal(manager.store.slot(leased.slotId)?.state, "leased");
  assert.equal(manager.store.slot(leased.slotId)?.lastError, null, "the next good pass clears it");
  assert.equal(manager.store.slot(released.slotId)?.state, "available");
  assert.equal(manager.store.slot(released.slotId)?.lastError, null);
  await manager.release(leased);
});

test("a failed read never keeps an interrupted provisioning or prune; an interrupted return waits for a good read", async () => {
  const repository = repo("mission-reconcile-transitional-unknown-");
  const referenced = new Set<string>();
  let failStatus = false;
  const git = new NativeWorktreeGit(
    async (bin, args, opts) => failStatus && args.includes("status") ? timedOut(opts?.timeoutMs) : run(bin, args, opts),
    async () => {},
  );
  const manager = harness({ referenced, git, policy: () => ({ enabled: true, maxSlots: 3, setupArgv: null }) });
  const take = async (key: string) => acquired(
    await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha, owner: { kind: "task", key } }),
  );
  const provisioning = await take("task-transitional-provisioning");
  const pruning = await take("task-transitional-pruning");
  const returning = await take("task-transitional-returning");
  for (const lease of [provisioning, pruning, returning]) referenced.add(lease.leaseId);
  db.prepare(`UPDATE worktree_slots SET state = 'provisioning' WHERE id = ?`).run(provisioning.slotId);
  assert.equal((await manager.release(pruning, { ownerAuthorized: true })).outcome, "released");
  db.prepare(`UPDATE worktree_slots SET state = 'pruning', version = version + 1 WHERE id = ?`).run(pruning.slotId);
  assert.ok(manager.store.markReturning(returning.slotId, returning.slotVersion, repository.sha, Date.now()));
  failStatus = true;

  await manager.reconcile();
  // Both are faults whatever Git says, so a Git read that failed twice does not hold them.
  assert.equal(manager.store.slot(provisioning.slotId)?.state, "quarantined");
  assert.equal(manager.store.slot(provisioning.slotId)?.quarantineReason, "startup found an interrupted provisioning intent");
  assert.equal(manager.store.slot(pruning.slotId)?.state, "quarantined");
  assert.equal(
    manager.store.slot(pruning.slotId)?.quarantineReason,
    "startup found an interrupted prune with filesystem state still present",
  );
  // An interrupted return is completed only once it is proven, so it waits for a read.
  const waiting = manager.store.slot(returning.slotId)!;
  assert.equal(waiting.state, "returning");
  assert.match(waiting.lastError ?? "", /^Last observation failed: slot Git state is unknown \(git status timed out/);

  failStatus = false;
  await manager.reconcile();
  const completed = manager.store.slot(returning.slotId)!;
  assert.equal(completed.state, "available", "the next good read completes the proven return");
  assert.equal(completed.lastError, null);
});

test("a pool-wide failed read still quarantines an interrupted provisioning or prune, and notes the rest", async () => {
  const repository = repo("mission-reconcile-pool-transitional-");
  const referenced = new Set<string>();
  let failList = false;
  const git = new NativeWorktreeGit(
    async (bin, args, opts) => failList && args.includes("list") ? timedOut(opts?.timeoutMs) : run(bin, args, opts),
    async () => {},
  );
  const manager = harness({ referenced, git, policy: () => ({ enabled: true, maxSlots: 3, setupArgv: null }) });
  const take = async (key: string) => acquired(
    await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha, owner: { kind: "task", key } }),
  );
  const provisioning = await take("task-pool-provisioning");
  const pruning = await take("task-pool-pruning");
  const leased = await take("task-pool-leased");
  for (const lease of [provisioning, pruning, leased]) referenced.add(lease.leaseId);
  db.prepare(`UPDATE worktree_slots SET state = 'provisioning' WHERE id = ?`).run(provisioning.slotId);
  assert.equal((await manager.release(pruning, { ownerAuthorized: true })).outcome, "released");
  db.prepare(`UPDATE worktree_slots SET state = 'pruning', version = version + 1 WHERE id = ?`).run(pruning.slotId);
  failList = true;

  await manager.reconcile();
  assert.equal(manager.store.slot(provisioning.slotId)?.state, "quarantined");
  assert.equal(manager.store.slot(provisioning.slotId)?.quarantineReason, "startup found an interrupted provisioning intent");
  assert.equal(manager.store.slot(pruning.slotId)?.state, "quarantined");
  assert.equal(
    manager.store.slot(pruning.slotId)?.quarantineReason,
    "startup found an interrupted prune with filesystem state still present",
  );
  const rest = manager.store.slot(leased.slotId)!;
  assert.equal(rest.state, "leased");
  assert.match(rest.lastError ?? "", /^Last observation failed: Git worktree registrations are unknown/);
});
