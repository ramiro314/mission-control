import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { after, afterEach, test } from "node:test";
import { openDb } from "../src/server/db.ts";
import { WorktreeManager, type NativeWorktreeLease } from "../src/server/worktrees/manager.ts";
import { NativeWorktreeGit, type WorktreeRegistration } from "../src/server/worktrees/git.ts";
import { slotGitDirectory } from "../src/server/worktrees/index-lock.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import { WORKTREE_POOL_MARKER } from "../src/server/worktrees/marker.ts";
import type { WorktreeOccupancy, WorktreeOccupant } from "../src/server/worktrees/occupancy.ts";
import { WorktreeOperationError, WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import {
  INTERRUPTED_PRUNE,
  REGISTRATION_OR_IDENTITY,
  registrationRepairQuarantine,
} from "../src/server/worktrees/quarantine-reasons.ts";
import { diagnoseRegistration } from "../src/server/worktrees/registration-repair.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import { run } from "../src/server/util/exec.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

const db = openDb();
let occupants: WorktreeOccupant[] = [];
let occupancyUnknown: string | null = null;
let ownerReferenced: () => Promise<boolean> = async () => false;

const deps = {
  occupancy: (paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> =>
    Promise.resolve(new Map(paths.map((path) => [path, occupancyUnknown === null
      ? { status: "known" as const, occupants }
      : { status: "unknown" as const, reason: occupancyUnknown }]))),
  ownerReferenced: () => ownerReferenced(),
  fileHolders: async () => [],
  resolvePolicy: () => ({ enabled: true, maxSlots: 8, setupArgv: null }),
};

function managerWith(git?: NativeWorktreeGit): WorktreeManager {
  return new WorktreeManager(db, git ? { ...deps, git } : deps);
}

afterEach(() => {
  occupants = [];
  occupancyUnknown = null;
  ownerReferenced = async () => false;
  db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools; DELETE FROM app_config WHERE key = 'worktrees';");
});
after(() => db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools;"));

/** An origin that ignores a warm install, and a clone of it. */
function repository(prefix: string, ignore = "node_modules/\n"): { origin: string; clone: string; sha: string } {
  const { origin, clone } = mkOriginAndClone(prefix);
  writeFileSync(join(origin, ".gitignore"), ignore);
  gitIn(origin, "add", ".gitignore");
  gitIn(origin, "commit", "-qm", "ignore");
  gitIn(clone, "fetch", "-q", "origin");
  gitIn(clone, "reset", "-q", "--hard", "origin/main");
  return { origin, clone, sha: gitIn(clone, "rev-parse", "HEAD") };
}

/** A slot quarantined for its registration, with a warm install and no owner left. */
async function quarantinedSlot(m: WorktreeManager, clone: string, sha: string, key: string, reason: string = REGISTRATION_OR_IDENTITY.unsafeRegistration) {
  const acquired = await m.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "task", key } });
  assert.equal(acquired.outcome, "acquired");
  const held = (acquired as { lease: NativeWorktreeLease }).lease;
  assert.equal((await m.release(held, { ownerAuthorized: true })).outcome, "released");
  const install = join(held.path, "node_modules", "dep", "index.js");
  mkdirSync(join(held.path, "node_modules", "dep"), { recursive: true });
  writeFileSync(install, "warm\n");
  assert.ok(m.store.quarantine(held.slotId, reason, null, Date.now()));
  const common = gitIn(held.path, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const administrative = (await slotGitDirectory(held.path, common))!;
  assert.ok(administrative);
  return { path: held.path, slotId: held.slotId, install, inode: statSync(install).ino, administrative, common };
}

function occupant(path: string, command: string): WorktreeOccupant {
  return { pid: 4242, ppid: 1, startRaw: "Mon Oct 26 09:00:00 2026", startMs: 0, command, cwd: path, knownOwner: null };
}

/** The registration `git worktree add` leaves when it is cut off before it finishes. */
function lockInitializing(administrative: string): void {
  writeFileSync(join(administrative, "locked"), "initializing\n");
}

function assertRecovered(m: WorktreeManager, slot: { slotId: string; install: string; inode: number; path: string }) {
  const row = m.store.slot(slot.slotId)!;
  assert.equal(row.state, "available");
  assert.equal(row.quarantineReason, null);
  assert.equal(statSync(slot.install).ino, slot.inode, "the warm install kept its inode");
  assert.equal(gitIn(slot.path, "status", "--porcelain"), "");
}

test("a pass unlocks a slot left locked initializing and recovers it with its install", async () => {
  const { clone, sha } = repository("mission-repair-locked-");
  const m = managerWith();
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-locked");
  lockInitializing(slot.administrative);

  await m.recoverQuarantines();

  assert.equal(existsSync(join(slot.administrative, "locked")), false);
  assertRecovered(m, slot);
});

test("a pass rewrites a missing .git file while its administrative directory names the slot", async () => {
  const { clone, sha } = repository("mission-repair-missing-");
  const m = managerWith();
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-missing");
  rmSync(join(slot.path, ".git"));

  await m.recoverQuarantines();

  assert.equal(readFileSync(join(slot.path, ".git"), "utf8").trim(), `gitdir: ${slot.administrative}`);
  assertRecovered(m, slot);
});

test("a pass rewrites a wrong .git file", async () => {
  const { clone, sha } = repository("mission-repair-wrong-");
  const m = managerWith();
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-wrong");
  writeFileSync(join(slot.path, ".git"), "gitdir: /nowhere/at/all\n");

  await m.recoverQuarantines();

  assertRecovered(m, slot);
});

test("a pass points a registration whose gitdir names elsewhere back at the slot, from the main checkout", async () => {
  const { clone, sha } = repository("mission-repair-elsewhere-");
  const m = managerWith();
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-elsewhere", REGISTRATION_OR_IDENTITY.missingRegistration);
  writeFileSync(join(slot.administrative, "gitdir"), "/gone/from/here/.git\n");
  assert.equal(gitIn(clone, "worktree", "list", "--porcelain").includes(`worktree ${slot.path}\n`), false);

  await m.recoverQuarantines();

  assert.equal(readFileSync(join(slot.administrative, "gitdir"), "utf8").trim(), join(slot.path, ".git"));
  assertRecovered(m, slot);
});

test("a registration with several faults takes every fix", async () => {
  const { clone, sha } = repository("mission-repair-both-");
  const m = managerWith();
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-both");
  lockInitializing(slot.administrative);
  rmSync(join(slot.path, ".git"));

  await m.recoverQuarantines();

  assertRecovered(m, slot);
});

test("a slot that holds work is repaired, stays quarantined with its work, and takes a manual Recover", async () => {
  const { clone, sha } = repository("mission-repair-work-");
  const m = managerWith();
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-work");
  lockInitializing(slot.administrative);
  writeFileSync(join(slot.path, "notes.txt"), "keep me\n");

  await m.recoverQuarantines();

  const row = m.store.slot(slot.slotId)!;
  assert.equal(row.state, "quarantined");
  assert.equal(row.quarantineReason, "registration repaired; holds work");
  assert.match(row.lastError ?? "", /notes\.txt/);
  assert.equal(existsSync(join(slot.administrative, "locked")), false, "the registration stays repaired");
  assert.equal(readFileSync(join(slot.path, "notes.txt"), "utf8"), "keep me\n");

  // No later pass touches it: only an operator may discard that work.
  await m.recoverQuarantines();
  assert.deepEqual(m.store.slot(slot.slotId), row);

  const recovered = await m.recoverSlot({ slotId: slot.slotId, allowDirty: true, automatic: false });
  assert.equal(recovered.outcome, "recovered");
  assert.equal(m.store.slot(slot.slotId)?.state, "available");
});

test("an add interrupted before its checkout holds nothing provable, so it is never reset unattended", async () => {
  const { clone, sha } = repository("mission-repair-interrupted-");
  const m = managerWith();
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-interrupted");
  lockInitializing(slot.administrative);
  rmSync(join(slot.administrative, "index"));

  await m.recoverQuarantines();

  const row = m.store.slot(slot.slotId)!;
  assert.equal(row.quarantineReason, "registration repaired; holds work");
  assert.equal(existsSync(slot.install), true);
  assert.equal((await m.recoverSlot({ slotId: slot.slotId, allowDirty: true, automatic: false })).outcome, "recovered");
  assertRecovered(m, slot);
});

test("Repair refuses an occupant, a live or unknown owner and a running claim, and changes nothing", async () => {
  const { clone, sha } = repository("mission-repair-refuse-");
  const m = managerWith();
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-refuse");
  lockInitializing(slot.administrative);
  const row = m.store.slot(slot.slotId)!;
  const untouched = () => {
    assert.deepEqual(m.store.slot(slot.slotId), row);
    assert.equal(existsSync(join(slot.administrative, "locked")), true);
  };

  occupants = [occupant(slot.path, `git -C ${slot.path} status`)];
  assert.deepEqual(await m.repairSlot({ slotId: slot.slotId }), {
    outcome: "refused", reason: "one or more processes still occupy the worktree",
  });
  untouched();
  occupants = [occupant(slot.path, "node dev-server.js")];
  assert.equal((await m.repairSlot({ slotId: slot.slotId })).outcome, "refused");
  untouched();
  occupants = [];

  occupancyUnknown = "process listing timed out after 15 s";
  assert.deepEqual(await m.repairSlot({ slotId: slot.slotId }), {
    outcome: "refused", reason: "process listing timed out after 15 s",
  });
  untouched();
  occupancyUnknown = null;

  ownerReferenced = async () => true;
  assert.deepEqual(await m.repairSlot({ slotId: slot.slotId }), {
    outcome: "refused", reason: "a live task owner references this slot",
  });
  untouched();
  ownerReferenced = async () => { throw new Error("tasks table is unreadable"); };
  assert.match(
    (await m.repairSlot({ slotId: slot.slotId }) as { reason: string }).reason,
    /^domain ownership is unknown: .*tasks table is unreadable/,
  );
  untouched();
  ownerReferenced = async () => false;

  const claim = m.claims.register(slot.slotId, { kind: "task", key: "claiming" }, Date.now())!;
  assert.deepEqual(await m.repairSlot({ slotId: slot.slotId }), {
    outcome: "refused", reason: "a dependency claim is running in this slot",
  });
  untouched();
  await m.recoverQuarantines();
  untouched();
  assert.equal(m.recoveryRefusal(row), null, "a pass skips a slot whose claim runs");
  m.claims.unregister(slot.slotId, claim);
});

test("a pass records why it could not repair, and does not touch what only an operator may", async () => {
  const { clone, sha } = repository("mission-repair-operator-");
  const m = managerWith();
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-operator");
  writeFileSync(join(slot.administrative, "locked"), "keep this slot for the audit\n");
  const row = m.store.slot(slot.slotId)!;

  await m.recoverQuarantines();

  assert.deepEqual(m.store.slot(slot.slotId), row);
  assert.equal(readFileSync(join(slot.administrative, "locked"), "utf8"), "keep this slot for the audit\n");
  assert.deepEqual(m.recoveryRefusal(row)?.reason, "the registration is locked (keep this slot for the audit), and only Git's own initializing lock is cleared here");
});

test("Repair leaves re-registration and every other cause to the operator", async () => {
  const { clone, sha } = repository("mission-repair-unfixable-");
  const m = managerWith();
  const refuses = async (slot: { slotId: string }, reason: RegExp) => {
    const row = m.store.slot(slot.slotId)!;
    const result = await m.repairSlot({ slotId: slot.slotId });
    assert.equal(result.outcome, "refused");
    assert.match((result as { reason: string }).reason, reason);
    assert.deepEqual(m.store.slot(slot.slotId), row);
  };

  const unregistered = await quarantinedSlot(m, clone, sha, "task-repair-gone", REGISTRATION_OR_IDENTITY.missingRegistration);
  rmSync(unregistered.administrative, { recursive: true });
  await refuses(unregistered, /no Git registration names this path/);
  assert.equal(existsSync(unregistered.install), true);

  const noFile = await quarantinedSlot(m, clone, sha, "task-repair-nofile", REGISTRATION_OR_IDENTITY.missingRegistration);
  rmSync(noFile.administrative, { recursive: true });
  rmSync(join(noFile.path, ".git"));
  await refuses(noFile, /no Git registration names this path/);

  const directory = await quarantinedSlot(m, clone, sha, "task-repair-directory");
  rmSync(join(directory.path, ".git"));
  mkdirSync(join(directory.path, ".git"));
  await refuses(directory, /\.git is not a file/);

  const stolen = await quarantinedSlot(m, clone, sha, "task-repair-stolen", REGISTRATION_OR_IDENTITY.missingRegistration);
  const other = join(clone, "..", "still-there");
  mkdirSync(other);
  writeFileSync(join(other, ".git"), `gitdir: ${stolen.administrative}\n`);
  writeFileSync(join(stolen.administrative, "gitdir"), `${join(other, ".git")}\n`);
  await refuses(stolen, /names .*still-there, which still exists/);

  // A checkout that lost only its `.git` is still the one registered, and Git would take it over.
  const orphaned = await quarantinedSlot(m, clone, sha, "task-repair-orphaned", REGISTRATION_OR_IDENTITY.missingRegistration);
  const checkout = join(clone, "..", "lost-its-dot-git");
  mkdirSync(checkout);
  writeFileSync(join(orphaned.administrative, "gitdir"), `${join(checkout, ".git")}\n`);
  await refuses(orphaned, /names .*lost-its-dot-git, which still exists/);

  const missing = await quarantinedSlot(m, clone, sha, "task-repair-folder");
  rmSync(missing.path, { recursive: true });
  await refuses(missing, /folder is gone/);

  const dirty = await quarantinedSlot(m, clone, sha, "task-repair-reason", "available slot is dirty");
  await refuses(dirty, /not about the slot's Git registration/);
});

test("a healthy registration under a registration reason, and a repair whose recovery failed, finish on a pass", async () => {
  const { clone, sha } = repository("mission-repair-finish-");
  let failFetch = false;
  class FlakyFetch extends NativeWorktreeGit {
    override async fetchDefaultSha(identity: Parameters<NativeWorktreeGit["fetchDefaultSha"]>[0]) {
      return failFetch
        ? { ok: false as const, reason: "origin could not be reached", outcomeUnknown: false }
        : super.fetchDefaultSha(identity);
    }
  }
  const m = managerWith(new FlakyFetch());
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-finish");
  rmSync(join(slot.path, ".git"));

  failFetch = true;
  await m.recoverQuarantines();
  const row = m.store.slot(slot.slotId)!;
  assert.equal(row.quarantineReason, REGISTRATION_OR_IDENTITY.unsafeRegistration, "a failed fetch says nothing about work");
  assert.equal(existsSync(join(slot.path, ".git")), true, "the fix stands");
  assert.match(m.recoveryRefusal(row)?.reason ?? "", /origin could not be reached/);

  failFetch = false;
  await m.recoverQuarantines();
  assertRecovered(m, slot);
});

test("a Git that reports a fix but leaves the registration unsafe is refused, not trusted", async () => {
  const { clone, sha } = repository("mission-repair-unproven-");
  class NoOpRepair extends NativeWorktreeGit {
    override async repair() { return { ok: true as const, value: undefined }; }
  }
  const m = managerWith(new NoOpRepair());
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-unproven");
  rmSync(join(slot.path, ".git"));
  const row = m.store.slot(slot.slotId)!;

  assert.deepEqual(await m.repairSlot({ slotId: slot.slotId }), {
    outcome: "refused", reason: "Git's repair did not leave the registration healthy",
  });
  assert.deepEqual(m.store.slot(slot.slotId), row);
});

test("a killed repair reports an unknown outcome and the slot stays as it was", async () => {
  const { clone, sha } = repository("mission-repair-killed-");
  class KilledUnlock extends NativeWorktreeGit {
    override async unlock() {
      return { ok: false as const, reason: "git worktree unlock timed out after 30 s", outcomeUnknown: true };
    }
  }
  const m = managerWith(new KilledUnlock());
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-killed");
  lockInitializing(slot.administrative);
  const row = m.store.slot(slot.slotId)!;

  await m.recoverQuarantines();

  assert.deepEqual(m.store.slot(slot.slotId), row);
  assert.equal(m.recoveryRefusal(row)?.reason, "git worktree unlock timed out after 30 s");
});

test("a repair blocked by index.lock keeps its fix and its reason, and a later pass finishes it", async () => {
  const { clone, sha } = repository("mission-repair-lock-");
  const m = managerWith();
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-lock");
  const lock = join(slot.administrative, "index.lock");
  writeFileSync(lock, "");
  const lockText = `git checkout failed: fatal: Unable to create '${lock}': File exists.`;
  assert.ok(m.store.quarantine(slot.slotId, REGISTRATION_OR_IDENTITY.unsafeRegistration, lockText, Date.now()));
  rmSync(join(slot.path, ".git"));
  const row = m.store.slot(slot.slotId)!;

  await m.recoverQuarantines();

  // A lock says nothing about work, so the slot is not relabelled and later passes still judge it.
  assert.deepEqual(m.store.slot(slot.slotId), row);
  assert.equal(existsSync(join(slot.path, ".git")), true, "the fix stands");
  assert.equal(existsSync(lock), true, "a young lock is left where it was");
  assert.deepEqual(m.recoveryRefusal(row)?.blocking, { kind: "lock", path: lock });
  assert.equal(m.recoveryRefusal(row)?.reason, "index.lock is younger than 10 minutes");

  rmSync(lock);
  await m.recoverQuarantines();
  assertRecovered(m, slot);
});

test("a repair removes a stale index.lock when the slot's quarantine was caused by one", async () => {
  const { clone, sha } = repository("mission-repair-stale-lock-");
  const m = managerWith();
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-stale-lock");
  const lock = join(slot.administrative, "index.lock");
  writeFileSync(lock, "");
  const longAgo = new Date(Date.now() - 60 * 60_000);
  utimesSync(lock, longAgo, longAgo);
  const lockText = `git checkout failed: fatal: Unable to create '${lock}': File exists.`;
  assert.ok(m.store.quarantine(slot.slotId, REGISTRATION_OR_IDENTITY.unsafeRegistration, lockText, Date.now()));
  lockInitializing(slot.administrative);

  await m.recoverQuarantines();

  assert.equal(existsSync(lock), false);
  assertRecovered(m, slot);
});

function registration(path: string, facts: Partial<WorktreeRegistration> = {}): WorktreeRegistration {
  return { path, head: null, bare: false, detached: true, locked: false, prunable: false, ...facts };
}

test("a bare registration is refused before any of Git's fixes", async () => {
  const { clone, sha } = repository("mission-repair-bare-");
  class BareListing extends NativeWorktreeGit {
    override async list(identity: Parameters<NativeWorktreeGit["list"]>[0]) {
      const listed = await super.list(identity);
      return listed.ok
        ? { ...listed, value: listed.value.map((entry) => ({ ...entry, bare: entry.path === bareSlot })) }
        : listed;
    }
  }
  let bareSlot = "";
  const m = managerWith(new BareListing());
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-bare");
  bareSlot = slot.path;
  lockInitializing(slot.administrative);
  const row = m.store.slot(slot.slotId)!;

  assert.deepEqual(await m.repairSlot({ slotId: slot.slotId }), {
    outcome: "refused", reason: "Git lists this path as a bare repository",
  });
  assert.deepEqual(m.store.slot(slot.slotId), row);
  assert.equal(existsSync(join(slot.administrative, "locked")), true);
});

test("a registration Git calls unsafe is never read as healthy from its files alone", async () => {
  const { clone, sha } = repository("mission-repair-unsafe-");
  const slot = await quarantinedSlot(managerWith(), clone, sha, "task-repair-unsafe");
  const diagnose = (entry: WorktreeRegistration | null) =>
    diagnoseRegistration({ slotPath: slot.path, commonDirectory: slot.common, registration: entry });
  const unsafe = {
    status: "refused",
    reason: "Git lists the registration as unsafe, and none of its own fixes applies",
  };

  assert.deepEqual(await diagnose(registration(slot.path)), { status: "healthy" });
  assert.deepEqual(await diagnose(registration(slot.path, { prunable: true })), unsafe);
  assert.deepEqual(await diagnose(registration(slot.path, { locked: true })), unsafe);
  assert.deepEqual(await diagnose(null), unsafe);
});

test("what cannot be traced to one registration, or is not Git's own to fix, is refused by name", async () => {
  const { clone, sha } = repository("mission-repair-refusals-");
  const slot = await quarantinedSlot(managerWith(), clone, sha, "task-repair-refusals");
  const entry = registration(slot.path);
  const diagnose = (slotPath = slot.path) =>
    diagnoseRegistration({ slotPath, commonDirectory: slot.common, registration: entry });

  const twin = join(slot.common, "worktrees", "twin");
  mkdirSync(twin);
  writeFileSync(join(twin, "gitdir"), `${join(slot.path, ".git")}\n`);
  assert.deepEqual(await diagnose(), { status: "refused", reason: "more than one Git registration names this path" });
  rmSync(twin, { recursive: true });

  const locked = join(slot.administrative, "locked");
  mkdirSync(locked);
  const unreadable = await diagnose();
  assert.equal(unreadable.status, "refused");
  assert.match((unreadable as { reason: string }).reason, /^the registration's lock could not be read: .*EISDIR/);
  rmSync(locked, { recursive: true });

  writeFileSync(locked, "");
  assert.deepEqual(await diagnose(), {
    status: "refused", reason: "the registration is locked, and only Git's own initializing lock is cleared here",
  });
  rmSync(locked);

  const dotGit = join(slot.path, ".git");
  renameSync(dotGit, `${dotGit}.real`);
  symlinkSync(`${dotGit}.real`, dotGit);
  assert.deepEqual(await diagnose(), {
    status: "refused", reason: "the slot's .git is not a file, and Git repairs only a .git file",
  });
  rmSync(dotGit);
  renameSync(`${dotGit}.real`, dotGit);

  const link = join(slot.path, "..", "linked-slot");
  symlinkSync(slot.path, link);
  assert.deepEqual(await diagnose(link), {
    status: "refused", reason: "the slot's folder is gone, so Git has nothing to repair",
  });
  rmSync(link);

  assert.deepEqual(await diagnose(), { status: "healthy" }, "each case above was the only fault");
});

test("a gitdir written relative to its administrative directory still names the slot", async () => {
  const { clone, sha } = repository("mission-repair-relative-");
  const slot = await quarantinedSlot(managerWith(), clone, sha, "task-repair-relative");
  writeFileSync(join(slot.administrative, "gitdir"), `${relative(slot.administrative, join(slot.path, ".git"))}\n`);

  assert.deepEqual(
    await diagnoseRegistration({ slotPath: slot.path, commonDirectory: slot.common, registration: registration(slot.path) }),
    { status: "healthy" },
  );
});

test("only the reasons about Git's registration are Repair's", () => {
  assert.equal(registrationRepairQuarantine(REGISTRATION_OR_IDENTITY.unsafeRegistration), true);
  assert.equal(registrationRepairQuarantine(REGISTRATION_OR_IDENTITY.noSafeRegistration), true);
  assert.equal(registrationRepairQuarantine(`${REGISTRATION_OR_IDENTITY.missingRegistration}: cause`), true);
  assert.equal(registrationRepairQuarantine(REGISTRATION_OR_IDENTITY.repairedHoldsWork), false);
  assert.equal(registrationRepairQuarantine(REGISTRATION_OR_IDENTITY.commonDirectory), false);
  assert.equal(registrationRepairQuarantine("slot Git state is unknown"), false);
  assert.equal(registrationRepairQuarantine(null), false);
});

function operationsFor(owner: WorktreeManager): WorktreeOperationsService {
  return new WorktreeOperationsService(owner, {
    legacy: new LegacyTreehouseService(db),
    tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
    checks: new CheckLeaseManager(db, { manager: owner, legacy: new LegacyTreehouseService(db) }),
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => 1024,
  });
}

const manager = managerWith();
const operations = operationsFor(manager);

async function slotActions(slotId: string) {
  const inventory = await operations.inventory();
  return inventory.repositories.flatMap((repo) => repo.slots).find((slot) => slot.id === slotId)?.actions;
}

test("the card offers Repair, its preview names Git's fix, and execute repairs and recovers", async () => {
  const { clone, sha } = repository("mission-repair-preview-");
  const slot = await quarantinedSlot(manager, clone, sha, "task-repair-preview");
  rmSync(join(slot.path, ".git"));
  assert.equal((await slotActions(slot.slotId))?.includes("repair"), true);
  assert.equal((await slotActions(slot.slotId))?.includes("recover"), false, "Recover needs a proven registration");

  const preview = await operations.preview({ action: "repair", slotId: slot.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.deepEqual(preview.requiredAcknowledgements, []);
  assert.equal(preview.affected[0]?.path, slot.path);
  assert.ok(preview.consequences.some((line) => line === "Rewrites the slot's .git file with git worktree repair."));
  assert.ok(preview.consequences.some((line) => line.includes("any other worktree's broken .git file")));
  assert.ok(preview.consequences.some((line) => line.includes("registration repaired; holds work")));

  assert.equal((await operations.execute(preview.token, [])).ok, true);
  assertRecovered(manager, slot);
  assert.equal((await slotActions(slot.slotId))?.includes("repair"), false);
});

test("a preview blocks an occupant, a live or unknown owner, a claim and a fix Git does not have", async () => {
  const { clone, sha } = repository("mission-repair-blocked-");
  const slot = await quarantinedSlot(manager, clone, sha, "task-repair-blocked");
  lockInitializing(slot.administrative);
  const blockers = async () => (await operations.preview({ action: "repair", slotId: slot.slotId })).blockers.join("; ");

  occupants = [occupant(slot.path, "node dev-server.js")];
  assert.match(await blockers(), /Known processes must exit before Repair/);
  occupants = [];

  ownerReferenced = async () => true;
  assert.equal((await slotActions(slot.slotId))?.includes("repair"), false);
  assert.match(await blockers(), /A live owner still references slot/);
  ownerReferenced = async () => { throw new Error("unreadable"); };
  assert.match(await blockers(), /owner could not be read/);
  ownerReferenced = async () => false;

  const claim = manager.claims.register(slot.slotId, { kind: "task", key: "claiming" }, Date.now())!;
  assert.match(await blockers(), /A dependency claim is running/);
  manager.claims.unregister(slot.slotId, claim);

  writeFileSync(join(slot.administrative, "locked"), "held on purpose\n");
  assert.match(await blockers(), /Git has no fix for this slot: the registration is locked \(held on purpose\), and only Git's own/);
});

test("execute refuses a registration that changed after its preview", async () => {
  const { clone, sha } = repository("mission-repair-stale-");
  const slot = await quarantinedSlot(manager, clone, sha, "task-repair-stale");
  lockInitializing(slot.administrative);
  const preview = await operations.preview({ action: "repair", slotId: slot.slotId });
  assert.equal(preview.allowed, true);

  rmSync(join(slot.path, ".git"));
  await assert.rejects(operations.execute(preview.token, []), /changed after preview/);
  assert.equal(manager.store.slot(slot.slotId)?.state, "quarantined");
  assert.equal(readdirSync(slot.path).includes(".git"), false, "nothing ran");
});

for (const failure of [
  { name: "refused", outcomeUnknown: false, reason: "git worktree unlock failed: fatal: not a working tree", status: 409, code: "changed" },
  { name: "of unknown outcome", outcomeUnknown: true, reason: "git worktree unlock timed out after 30 s", status: 503, code: "unavailable" },
]) {
  test(`execute reports a Git fix ${failure.name} after an allowed preview, and the slot stays as it was`, async () => {
    const { clone, sha } = repository("mission-repair-execute-");
    class FailingUnlock extends NativeWorktreeGit {
      override async unlock() {
        return { ok: false as const, reason: failure.reason, outcomeUnknown: failure.outcomeUnknown };
      }
    }
    const m = managerWith(new FailingUnlock());
    const service = operationsFor(m);
    const slot = await quarantinedSlot(m, clone, sha, `task-repair-execute-${failure.code}`);
    lockInitializing(slot.administrative);
    const preview = await service.preview({ action: "repair", slotId: slot.slotId });
    assert.equal(preview.allowed, true, preview.blockers.join("; "));
    const row = m.store.slot(slot.slotId)!;

    await assert.rejects(service.execute(preview.token, []), (error: unknown) => {
      assert.ok(error instanceof WorktreeOperationError);
      assert.equal(error.status, failure.status);
      assert.equal(error.code, failure.code);
      assert.equal(error.message, failure.reason);
      return true;
    });

    assert.deepEqual(m.store.slot(slot.slotId), row);
    assert.equal(existsSync(join(slot.administrative, "locked")), true);
  });
}

/** A real Git whose `git worktree list` fails on one chosen call once armed, or on every call. */
class FailingListing extends NativeWorktreeGit {
  private calls = 0;
  private failsOn: number | "every" | null = null;
  constructor(private readonly shape: "killed" | "exited" | "threw") {
    super();
  }

  arm(failsOn: number | "every" | null): void {
    this.calls = 0;
    this.failsOn = failsOn;
  }

  override async list(identity: Parameters<NativeWorktreeGit["list"]>[0]) {
    this.calls += 1;
    if (this.failsOn !== "every" && this.calls !== this.failsOn) return super.list(identity);
    if (this.shape === "threw") throw new Error(LISTING_FAILED);
    return { ok: false as const, reason: LISTING_FAILED, outcomeUnknown: this.shape === "killed" };
  }
}

const LISTING_FAILED = "git worktree list timed out after 30 s";

for (const shape of ["killed", "exited", "threw"] as const) {
  test(`a listing that ${shape} before any fix runs none, and the outcome is unknown`, async () => {
    const { clone, sha } = repository("mission-repair-list-first-");
    const git = new FailingListing(shape);
    const m = managerWith(git);
    const slot = await quarantinedSlot(m, clone, sha, `task-repair-list-first-${shape}`);
    lockInitializing(slot.administrative);
    rmSync(join(slot.path, ".git"));
    const row = m.store.slot(slot.slotId)!;

    git.arm(1);
    const result = await m.repairSlot({ slotId: slot.slotId });

    assert.equal(result.outcome, "outcomeUnknown");
    assert.match((result as { reason: string }).reason, /git worktree list timed out after 30 s/);
    assert.deepEqual(m.store.slot(slot.slotId), row);
    assert.equal(existsSync(join(slot.administrative, "locked")), true, "no fix runs on an unread registration");
    assert.equal(existsSync(join(slot.path, ".git")), false, "no fix runs on an unread registration");
  });

  test(`a listing that ${shape} after a fix keeps the fix and the quarantine, and a later pass finishes`, async () => {
    const { clone, sha } = repository("mission-repair-list-again-");
    const git = new FailingListing(shape);
    const m = managerWith(git);
    const slot = await quarantinedSlot(m, clone, sha, `task-repair-list-again-${shape}`);
    lockInitializing(slot.administrative);
    const row = m.store.slot(slot.slotId)!;

    git.arm(2);
    const result = await m.repairSlot({ slotId: slot.slotId });

    assert.equal(result.outcome, "outcomeUnknown");
    assert.match((result as { reason: string }).reason, /git worktree list timed out after 30 s/);
    assert.deepEqual(m.store.slot(slot.slotId), row, "the read proved nothing, so the reason stands");
    assert.equal(existsSync(join(slot.administrative, "locked")), false, "the fix stands");

    git.arm(null);
    await m.recoverQuarantines();
    assertRecovered(m, slot);
  });
}

test("a preview taken while the listing fails is blocked and names the failed read", async () => {
  const { clone, sha } = repository("mission-repair-list-preview-");
  const git = new FailingListing("killed");
  const m = managerWith(git);
  const service = operationsFor(m);
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-list-preview");
  lockInitializing(slot.administrative);

  git.arm("every");
  const preview = await service.preview({ action: "repair", slotId: slot.slotId });

  assert.equal(preview.allowed, false);
  assert.ok(
    preview.blockers.includes(`The slot's Git registration could not be read; try again: ${LISTING_FAILED}.`),
    preview.blockers.join("; "),
  );
  assert.equal(preview.blockers.some((line) => line.startsWith("Git has no fix")), false, "a failed read is not Git's answer");
  assert.equal(existsSync(join(slot.administrative, "locked")), true);
});

test("execute reports a listing that failed after an allowed preview as unavailable, not changed", async () => {
  const { clone, sha } = repository("mission-repair-list-execute-");
  const git = new FailingListing("exited");
  const m = managerWith(git);
  const service = operationsFor(m);
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-list-execute");
  lockInitializing(slot.administrative);
  const preview = await service.preview({ action: "repair", slotId: slot.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  const row = m.store.slot(slot.slotId)!;

  // Execute's own rebuild of the preview reads the listing too, so it fails only once Repair runs.
  const repairSlot = m.repairSlot.bind(m);
  m.repairSlot = (input) => {
    git.arm(1);
    return repairSlot(input);
  };

  await assert.rejects(service.execute(preview.token, []), (error: unknown) => {
    assert.ok(error instanceof WorktreeOperationError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "unavailable");
    assert.equal(error.message, LISTING_FAILED);
    return true;
  });
  assert.deepEqual(m.store.slot(slot.slotId), row);
  assert.equal(existsSync(join(slot.administrative, "locked")), true);
});

for (const fix of ["unlock", "repair"] as const) {
  test(`a git worktree ${fix} that throws is an unknown outcome, in a pass and through execute`, async () => {
    const { clone, sha } = repository(`mission-repair-throws-${fix}-`);
    class ThrowingFix extends NativeWorktreeGit {
      override async unlock(): Promise<never> {
        throw new Error("spawn git EAGAIN");
      }

      override async repair(): Promise<never> {
        throw new Error("spawn git EAGAIN");
      }
    }
    const m = managerWith(new ThrowingFix());
    const service = operationsFor(m);
    const slot = await quarantinedSlot(m, clone, sha, `task-repair-throws-${fix}`);
    const broken = fix === "unlock" ? join(slot.administrative, "locked") : join(slot.path, ".git");
    if (fix === "unlock") lockInitializing(slot.administrative);
    else rmSync(broken);
    const before = existsSync(broken);
    const row = m.store.slot(slot.slotId)!;
    const preview = await service.preview({ action: "repair", slotId: slot.slotId });
    assert.equal(preview.allowed, true, preview.blockers.join("; "));

    assert.deepEqual(await m.repairSlot({ slotId: slot.slotId }), {
      outcome: "outcomeUnknown", reason: "Error: spawn git EAGAIN",
    });
    await m.recoverQuarantines();
    assert.equal(m.recoveryRefusal(row)?.reason, "Error: spawn git EAGAIN");
    await assert.rejects(service.execute(preview.token, []), (error: unknown) => {
      assert.ok(error instanceof WorktreeOperationError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "unavailable");
      return true;
    });

    assert.deepEqual(m.store.slot(slot.slotId), row);
    assert.equal(existsSync(broken), before);
  });
}

test("a registration that already reads healthy runs no Git fix, and Execute still recovers the slot", async () => {
  const { clone, sha } = repository("mission-repair-preview-healthy-");
  const slot = await quarantinedSlot(manager, clone, sha, "task-repair-preview-healthy");

  const preview = await operations.preview({ action: "repair", slotId: slot.slotId });

  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.ok(preview.consequences.includes("Git's registration of this slot already reads healthy, so no Git fix runs."));
  assert.equal(preview.consequences.some((line) => line.includes("git worktree")), false, preview.consequences.join("; "));
  assert.equal((await operations.execute(preview.token, [])).ok, true);
  assertRecovered(manager, slot);
});

test("a preview blocks unknown occupancy, and names the reason", async () => {
  const { clone, sha } = repository("mission-repair-preview-unknown-");
  const slot = await quarantinedSlot(manager, clone, sha, "task-repair-preview-unknown");
  occupancyUnknown = "process listing timed out after 15 s";

  const preview = await operations.preview({ action: "repair", slotId: slot.slotId });

  assert.equal(preview.allowed, false);
  assert.ok(preview.blockers.includes("process listing timed out after 15 s"), preview.blockers.join("; "));
});

test("a preview blocks a slot quarantined for something else, and one not quarantined at all", async () => {
  const { clone, sha } = repository("mission-repair-preview-other-");
  const slot = await quarantinedSlot(manager, clone, sha, "task-repair-preview-other", "available slot is dirty");
  const ordinal = manager.store.slot(slot.slotId)!.ordinal;

  assert.equal((await slotActions(slot.slotId))?.includes("repair"), false);
  const elsewhere = await operations.preview({ action: "repair", slotId: slot.slotId });
  assert.equal(elsewhere.allowed, false);
  assert.ok(elsewhere.blockers.includes(`Slot ${ordinal}'s quarantine is not about its Git registration.`), elsewhere.blockers.join("; "));

  const recovered = await manager.recoverSlot({ slotId: slot.slotId, allowDirty: false, automatic: false });
  assert.equal(recovered.outcome, "recovered");
  const available = await operations.preview({ action: "repair", slotId: slot.slotId });
  assert.equal(available.allowed, false);
  assert.ok(available.blockers.includes(`Slot ${ordinal} is available, not quarantined.`), available.blockers.join("; "));
});

test("a pool whose marker cannot be proven blocks the preview, and is not offered on the card", async () => {
  const { clone, sha } = repository("mission-repair-preview-marker-");
  const slot = await quarantinedSlot(manager, clone, sha, "task-repair-preview-marker");
  rmSync(join(dirname(dirname(slot.path)), WORKTREE_POOL_MARKER));

  assert.equal((await slotActions(slot.slotId))?.includes("repair"), false);
  const preview = await operations.preview({ action: "repair", slotId: slot.slotId });
  assert.equal(preview.allowed, false);
  assert.ok(preview.blockers.includes("Exact native pool, marker and slot path are not all proven."), preview.blockers.join("; "));
  assert.deepEqual(await manager.repairSlot({ slotId: slot.slotId }), {
    outcome: "refused", reason: "native pool marker is missing or does not match",
  });
});

test("a preview waits for an operation already queued on the slot", async () => {
  const { clone, sha } = repository("mission-repair-preview-queued-");
  const m = managerWith();
  const service = operationsFor(m);
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-preview-queued");
  const ordinal = m.store.slot(slot.slotId)!.ordinal;
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const repairSlot = m.repairSlot.bind(m);
  let started = () => {};
  const running = new Promise<void>((resolve) => { started = resolve; });
  m.repairSlot = async (input) => {
    started();
    await held;
    return repairSlot(input);
  };

  service.submit((await service.preview({ action: "repair", slotId: slot.slotId })).token, []);
  await running;
  const preview = await service.preview({ action: "repair", slotId: slot.slotId });
  release();
  await service.idle();

  assert.equal(preview.allowed, false);
  assert.ok(preview.blockers.includes(`Slot ${ordinal} already has an operation queued; wait for it to finish.`), preview.blockers.join("; "));
  assertRecovered(m, slot);
});

test("Repair answers for the slot it was given: one that is gone, moved on, or changed since it was read", async () => {
  const { clone, sha } = repository("mission-repair-guards-");
  const m = managerWith();
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-guards");
  const row = m.store.slot(slot.slotId)!;

  assert.deepEqual(await m.repairSlot({ slotId: "no-such-slot" }), {
    outcome: "refused", reason: "native slot no longer exists",
  });
  assert.deepEqual(await m.repairSlot({ slotId: slot.slotId, expectedVersion: row.version - 1 }), {
    outcome: "refused", reason: "slot changed after it was observed",
  });
  assert.equal((await m.repairSlot({ slotId: slot.slotId, expectedVersion: row.version })).outcome, "recovered");
  assert.deepEqual(await m.repairSlot({ slotId: slot.slotId }), {
    outcome: "refused", reason: "slot is available, not quarantined",
  });
});

test("a default that moves onto ignored work between the check and the reset leaves it in place", async () => {
  const { origin, clone, sha } = repository("mission-repair-moved-", "node_modules/\n.idea/\n");
  let fetches = 0;
  let armed = false;
  class MovingDefaultGit extends NativeWorktreeGit {
    override async fetchDefaultSha(identity: Parameters<NativeWorktreeGit["fetchDefaultSha"]>[0]) {
      // The first fetch is the check's. The second is the reset's own, after the check passed.
      if (armed && (fetches += 1) === 2) {
        mkdirSync(join(origin, ".idea"));
        writeFileSync(join(origin, ".idea", "workspace.xml"), "<shared/>\n");
        gitIn(origin, "add", "-f", ".idea/workspace.xml");
        gitIn(origin, "commit", "-qm", "share the workspace");
      }
      return super.fetchDefaultSha(identity);
    }
  }
  const m = managerWith(new MovingDefaultGit());
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-moved");
  lockInitializing(slot.administrative);
  const ignored = join(slot.path, ".idea", "workspace.xml");
  mkdirSync(join(slot.path, ".idea"));
  writeFileSync(ignored, "precious\n");

  armed = true;
  await m.recoverQuarantines();

  assert.equal(fetches, 2, "the check passed, so the reset fetched");
  const row = m.store.slot(slot.slotId)!;
  assert.equal(row.state, "quarantined");
  assert.equal(row.quarantineReason, "registration repaired; holds work");
  assert.match(row.lastError ?? "", /\.idea\//);
  assert.equal(readFileSync(ignored, "utf8"), "precious\n");
  assert.equal(gitIn(slot.path, "rev-parse", "HEAD"), sha);
});

test("execute reports a repair that holds work as done, and the slot keeps it for Recover", async () => {
  const { clone, sha } = repository("mission-repair-execute-work-");
  const slot = await quarantinedSlot(manager, clone, sha, "task-repair-execute-work");
  lockInitializing(slot.administrative);
  writeFileSync(join(slot.path, "notes.txt"), "keep me\n");
  const preview = await operations.preview({ action: "repair", slotId: slot.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));

  assert.deepEqual(await operations.execute(preview.token, []), {
    ok: true,
    action: "repair",
    message: "Registration repaired. A slot that holds work stays quarantined for Recover.",
  });

  assert.equal(manager.store.slot(slot.slotId)?.quarantineReason, "registration repaired; holds work");
  assert.equal(readFileSync(join(slot.path, "notes.txt"), "utf8"), "keep me\n");
  assert.equal((await slotActions(slot.slotId))?.includes("recover"), true);
  assert.equal((await slotActions(slot.slotId))?.includes("repair"), false);
});

test("execute refuses an occupant that arrived after the preview", async () => {
  const { clone, sha } = repository("mission-repair-execute-occupied-");
  const slot = await quarantinedSlot(manager, clone, sha, "task-repair-execute-occupied");
  lockInitializing(slot.administrative);
  const preview = await operations.preview({ action: "repair", slotId: slot.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  const row = manager.store.slot(slot.slotId)!;

  occupants = [occupant(slot.path, "node dev-server.js")];
  await assert.rejects(operations.execute(preview.token, []), /changed after preview/);

  assert.deepEqual(manager.store.slot(slot.slotId), row);
  assert.equal(existsSync(join(slot.administrative, "locked")), true);
});

test("a preview names a repository whose identity can no longer be proven", async () => {
  const { clone, sha } = repository("mission-repair-preview-identity-");
  const slot = await quarantinedSlot(manager, clone, sha, "task-repair-preview-identity");
  renameSync(clone, `${clone}-moved`);

  const preview = await operations.preview({ action: "repair", slotId: slot.slotId });

  assert.equal(preview.allowed, false);
  assert.ok(preview.blockers.includes("The pool's repository identity cannot be proven."), preview.blockers.join("; "));
});

test("the card repairs a registration whose gitdir names elsewhere, through its preview and Execute", async () => {
  const { clone, sha } = repository("mission-repair-card-elsewhere-");
  const slot = await quarantinedSlot(manager, clone, sha, "task-repair-card-elsewhere", REGISTRATION_OR_IDENTITY.missingRegistration);
  writeFileSync(join(slot.administrative, "gitdir"), "/gone/from/here/.git\n");
  assert.equal(gitIn(clone, "worktree", "list", "--porcelain").includes(`worktree ${slot.path}\n`), false);
  assert.equal((await slotActions(slot.slotId))?.includes("repair"), true);

  const preview = await operations.preview({ action: "repair", slotId: slot.slotId });

  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.ok(preview.consequences.includes("Points the registration back at this path with git worktree repair <path>."));
  assert.ok(preview.consequences.some((line) => line.includes("any other worktree's broken .git file")));
  assert.equal((await operations.execute(preview.token, [])).ok, true);
  assert.equal(readFileSync(join(slot.administrative, "gitdir"), "utf8").trim(), join(slot.path, ".git"));
  assertRecovered(manager, slot);
});

test("git worktree repair <path> reaches every broken .git file, so its preview warns and an unlock's does not", async () => {
  const { clone, sha } = repository("mission-repair-whole-repository-");
  const slot = await quarantinedSlot(manager, clone, sha, "task-repair-whole-target", REGISTRATION_OR_IDENTITY.missingRegistration);
  const sibling = await quarantinedSlot(manager, clone, sha, "task-repair-whole-sibling");
  lockInitializing(sibling.administrative);

  const unlocking = await operations.preview({ action: "repair", slotId: sibling.slotId });
  assert.equal(unlocking.consequences.some((line) => line.includes("any other worktree's broken .git file")), false);

  rmSync(join(sibling.path, ".git"));
  writeFileSync(join(slot.administrative, "gitdir"), "/gone/from/here/.git\n");
  const repaired = await manager.repairSlot({ slotId: slot.slotId });

  assert.equal(repaired.outcome, "recovered");
  assert.equal(readFileSync(join(sibling.path, ".git"), "utf8").trim(), `gitdir: ${sibling.administrative}`);
});

test("a slot is added with Git's messages untranslated, so an interrupted add's lock reads initializing", async () => {
  const { clone, sha } = repository("mission-repair-add-language-");
  let added: NodeJS.ProcessEnv | undefined;
  const git = new NativeWorktreeGit((bin, args, opts) => {
    if (args.includes("add")) added = opts?.env;
    return run(bin, args, opts);
  });
  const m = managerWith(git);

  assert.equal((await m.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "task", key: "task-repair-add-language" } })).outcome, "acquired");

  assert.equal(added?.LANGUAGE, "C");
  assert.equal(added?.LC_ALL, process.env.LC_ALL, "a hook keeps the daemon's locale");
  assert.equal(added?.PATH, process.env.PATH);
});

test("a lock an earlier build left in another language is refused, and is not called deliberate", async () => {
  const { clone, sha } = repository("mission-repair-translated-");
  const m = managerWith();
  const slot = await quarantinedSlot(m, clone, sha, "task-repair-translated");
  writeFileSync(join(slot.administrative, "locked"), "initialisiere\n");
  const row = m.store.slot(slot.slotId)!;

  assert.deepEqual(await m.repairSlot({ slotId: slot.slotId }), {
    outcome: "refused",
    reason: "the registration is locked (initialisiere), and only Git's own initializing lock is cleared here",
  });
  assert.deepEqual(m.store.slot(slot.slotId), row);
  assert.equal(readFileSync(join(slot.administrative, "locked"), "utf8"), "initialisiere\n");
});

const FORGET_ACK = ["dirty"] as const;

async function forgetActions(owner: WorktreeOperationsService, slotId: string) {
  const inventory = await owner.inventory();
  return inventory.repositories.flatMap((repo) => repo.slots).find((slot) => slot.id === slotId)?.actions ?? [];
}

function registered(clone: string, path: string): boolean {
  return gitIn(clone, "worktree", "list", "--porcelain").split("\n").includes(`worktree ${path}`);
}

test("Forget clears a slot whose folder is gone: the row and registration go, and the ordinal is never reused", async () => {
  const { clone, sha } = repository("mission-forget-gone-");
  const slot = await quarantinedSlot(manager, clone, sha, "task-forget-gone", REGISTRATION_OR_IDENTITY.missingRegistration);
  const { ordinal, poolId } = manager.store.slot(slot.slotId)!;
  rmSync(slot.path, { recursive: true });
  assert.equal(registered(clone, slot.path), true);
  assert.equal((await forgetActions(operations, slot.slotId)).includes("forget"), true);

  const preview = await operations.preview({ action: "forget", slotId: slot.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.equal(preview.affected[0]?.path, slot.path);
  assert.deepEqual(preview.requiredAcknowledgements, ["dirty"]);
  assert.ok(preview.consequences.includes(`The folder ${slot.path} is already gone.`), preview.consequences.join("\n"));
  assert.ok(preview.consequences.includes("Removes the Git registration that names this path."));
  assert.ok(preview.consequences.some((line) => line.startsWith(`Deletes slot ${ordinal}'s row.`)));

  await assert.rejects(operations.execute(preview.token, []), /missing acknowledgement: dirty/);
  assert.ok(manager.store.slot(slot.slotId), "nothing ran without the acknowledgement");

  const again = await operations.preview({ action: "forget", slotId: slot.slotId });
  assert.equal((await operations.execute(again.token, [...FORGET_ACK])).action, "forget");
  assert.equal(manager.store.slot(slot.slotId), null);
  assert.equal(registered(clone, slot.path), false);
  assert.equal(manager.store.pool(poolId)?.ordinalHighWater, ordinal, "the high-water mark stays");

  const next = await manager.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "task", key: "task-forget-next" } });
  assert.equal(next.outcome, "acquired");
  assert.equal(manager.store.slot((next as { lease: NativeWorktreeLease }).lease.slotId)?.ordinal, ordinal + 1);
});

test("Forget deletes a folder whose common directory differs, and leaves that other repository alone", async () => {
  const { clone, sha } = repository("mission-forget-common-");
  const other = repository("mission-forget-common-other-");
  const slot = await quarantinedSlot(manager, clone, sha, "task-forget-common", REGISTRATION_OR_IDENTITY.commonDirectory);
  const foreign = join(dirname(other.clone), "foreign-tree");
  gitIn(other.clone, "worktree", "add", "-q", "--detach", foreign);
  gitIn(clone, "worktree", "remove", "--force", slot.path);
  mkdirSync(slot.path, { recursive: true });
  writeFileSync(join(slot.path, ".git"), readFileSync(join(foreign, ".git")));
  writeFileSync(join(slot.path, "left-behind.txt"), "work\n");

  assert.equal((await forgetActions(operations, slot.slotId)).includes("forget"), true);
  const preview = await operations.preview({ action: "forget", slotId: slot.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.ok(preview.consequences.includes(`Repair has no answer here: ${REGISTRATION_OR_IDENTITY.commonDirectory}.`), preview.consequences.join("\n"));
  await operations.execute(preview.token, [...FORGET_ACK]);

  assert.equal(existsSync(slot.path), false);
  assert.equal(manager.store.slot(slot.slotId), null);
  assert.equal(existsSync(foreign), true);
  assert.equal(registered(other.clone, foreign), true);
});

test("Forget deletes a folder whose registration belongs to another path, and keeps that registration", async () => {
  const { clone, sha } = repository("mission-forget-elsewhere-");
  const slot = await quarantinedSlot(manager, clone, sha, "task-forget-elsewhere", REGISTRATION_OR_IDENTITY.missingRegistration);
  const elsewhere = join(dirname(clone), "still-here");
  gitIn(clone, "worktree", "add", "-q", "--detach", elsewhere);
  rmSync(slot.administrative, { recursive: true });
  writeFileSync(join(slot.path, ".git"), readFileSync(join(elsewhere, ".git")));

  assert.equal((await manager.repairSlot({ slotId: slot.slotId })).outcome, "refused");
  const preview = await operations.preview({ action: "forget", slotId: slot.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.ok(preview.consequences.some((line) => line.includes(`names ${elsewhere}, which still exists`)), preview.consequences.join("\n"));
  await operations.execute(preview.token, [...FORGET_ACK]);

  assert.equal(existsSync(slot.path), false);
  assert.equal(manager.store.slot(slot.slotId), null);
  assert.equal(registered(clone, elsewhere), true, "that registration is the other checkout's");
  assert.equal(gitIn(elsewhere, "rev-parse", "HEAD"), sha);
});

test("a prune cut off with files present is quarantined for it whether or not Git still registers it, and Forget lists up to ten files", async () => {
  const { clone, sha } = repository("mission-forget-prune-");
  const m = managerWith();
  const service = operationsFor(m);
  const slot = await quarantinedSlot(m, clone, sha, "task-forget-prune");
  gitIn(clone, "worktree", "remove", "--force", slot.path);
  mkdirSync(slot.path, { recursive: true });
  for (let index = 0; index < 12; index += 1) writeFileSync(join(slot.path, `left-${index}.txt`), "half deleted\n");
  assert.ok(m.store.markPruning(slot.slotId, m.store.slot(slot.slotId)!.version, Date.now()));

  await m.reconcile();
  assert.equal(m.store.slot(slot.slotId)?.quarantineReason, INTERRUPTED_PRUNE);
  assert.equal((await forgetActions(service, slot.slotId)).includes("forget"), true);

  const preview = await service.preview({ action: "forget", slotId: slot.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  const files = preview.consequences.find((line) => line.startsWith("Files it deletes include: "));
  assert.equal(files?.match(/left-\d+\.txt/g)?.length, 10, files);
  assert.match(files!, /, and more\.$/);
  await service.execute(preview.token, [...FORGET_ACK]);
  assert.equal(existsSync(slot.path), false);
  assert.equal(m.store.slot(slot.slotId), null);
});

test("Forget's preview applies the delete rule with the pool's seed paths when Git can read the tree", async () => {
  const { clone, sha } = repository("mission-forget-seed-", "node_modules/\n.yarn/install-state.gz\n.env\n");
  const m = new WorktreeManager(db, {
    ...deps,
    resolvePolicy: () => ({
      enabled: true,
      maxSlots: 8,
      setupArgv: null,
      claim: { steps: [{ argv: ["true"] }], seed: { paths: [".yarn/install-state.gz"], exclude: [] }, fingerprintPaths: [] } as never,
    }),
  });
  const service = operationsFor(m);
  const slot = await quarantinedSlot(m, clone, sha, "task-forget-seed", INTERRUPTED_PRUNE);
  mkdirSync(join(slot.path, ".yarn"));
  writeFileSync(join(slot.path, ".yarn", "install-state.gz"), "state\n");

  const seededOnly = await service.preview({ action: "forget", slotId: slot.slotId });
  assert.equal(seededOnly.allowed, true, seededOnly.blockers.join("; "));
  assert.deepEqual(seededOnly.requiredAcknowledgements, ["dirty"]);
  assert.equal(seededOnly.consequences.some((line) => line.startsWith("Discards the slot's work")), false, seededOnly.consequences.join("\n"));
  assert.ok(seededOnly.consequences.some((line) => line.includes(".yarn/install-state.gz (regenerable)")), seededOnly.consequences.join("\n"));

  writeFileSync(join(slot.path, ".env"), "SECRET=1\n");
  const withWork = await service.preview({ action: "forget", slotId: slot.slotId });
  assert.ok(withWork.consequences.includes("Discards the slot's work: checkout has uncommitted, untracked or ignored work."), withWork.consequences.join("\n"));
  assert.ok(withWork.consequences.some((line) => line.includes(".env (ignored)")), withWork.consequences.join("\n"));
});

test("Forget refuses an occupant, a live or unknown owner and a running claim, in its preview and its execute", async () => {
  const { clone, sha } = repository("mission-forget-refuse-");
  const m = managerWith();
  const service = operationsFor(m);
  const slot = await quarantinedSlot(m, clone, sha, "task-forget-refuse", INTERRUPTED_PRUNE);
  const row = m.store.slot(slot.slotId)!;
  const refuses = async (blocker: string | RegExp, reason: string | RegExp) => {
    const preview = await service.preview({ action: "forget", slotId: slot.slotId });
    assert.equal(preview.allowed, false);
    assert.ok(preview.blockers.some((line) => line.match(blocker)), preview.blockers.join("; "));
    const result = await m.forgetSlot({ slotId: slot.slotId });
    assert.equal(result.outcome, "refused");
    assert.match((result as { reason: string }).reason, reason instanceof RegExp ? reason : new RegExp(reason));
    assert.deepEqual(m.store.slot(slot.slotId), row);
    assert.equal(readFileSync(slot.install, "utf8"), "warm\n");
  };

  occupants = [occupant(slot.path, "node dev-server.js")];
  await refuses("Known processes must exit before Forget can delete the slot.", "one or more processes still occupy the worktree");
  occupants = [];

  occupancyUnknown = "process listing timed out after 15 s";
  await refuses("process listing timed out after 15 s", "process listing timed out after 15 s");
  occupancyUnknown = null;

  ownerReferenced = async () => true;
  await refuses("still references slot", "a live task owner references this slot");
  assert.equal((await forgetActions(service, slot.slotId)).includes("forget"), false);
  ownerReferenced = async () => { throw new Error("tasks table is unreadable"); };
  await refuses("could not be read", /^domain ownership is unknown/);
  ownerReferenced = async () => false;

  const claim = m.claims.register(slot.slotId, { kind: "task", key: "claiming" }, Date.now())!;
  await refuses("A dependency claim is running", "a dependency claim is running in this slot");
  m.claims.unregister(slot.slotId, claim);
});

test("execute refuses a preview that changed, even for a write the preview's list does not show", async () => {
  const { clone, sha } = repository("mission-forget-stale-");
  const m = managerWith();
  const service = operationsFor(m);
  const slot = await quarantinedSlot(m, clone, sha, "task-forget-stale", INTERRUPTED_PRUNE);
  for (let index = 0; index < 12; index += 1) writeFileSync(join(slot.path, `note-${index}.txt`), "work\n");
  const preview = await service.preview({ action: "forget", slotId: slot.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));

  writeFileSync(join(slot.path, "note-0.txt"), "changed since the preview\n");
  await assert.rejects(service.execute(preview.token, [...FORGET_ACK]), /changed after preview/);
  assert.equal(readFileSync(join(slot.path, "note-0.txt"), "utf8"), "changed since the preview\n");
  assert.ok(m.store.slot(slot.slotId));
});

test("Forget is offered only where Repair has no answer, and no pass ever runs it", async () => {
  const { clone, sha } = repository("mission-forget-offer-");
  const m = managerWith();
  const service = operationsFor(m);
  const locked = await quarantinedSlot(m, clone, sha, "task-forget-fixable");
  const held = await quarantinedSlot(m, clone, sha, "task-forget-held", REGISTRATION_OR_IDENTITY.missingRegistration);
  const operatorLock = await quarantinedSlot(m, clone, sha, "task-forget-reregister", REGISTRATION_OR_IDENTITY.missingRegistration);
  lockInitializing(locked.administrative);
  writeFileSync(join(held.path, "notes.md"), "not committed\n");
  rmSync(operatorLock.administrative, { recursive: true });
  rmSync(join(operatorLock.path, ".git"));
  occupancyUnknown = "held by the test";

  assert.equal((await forgetActions(service, locked.slotId)).includes("forget"), false, "Git's own fix answers this one");
  assert.equal((await forgetActions(service, held.slotId)).includes("forget"), false, "a healthy registration has Recover");
  assert.equal((await forgetActions(service, operatorLock.slotId)).includes("forget"), false, "registering it again keeps the install");
  occupancyUnknown = null;
  const preview = await service.preview({ action: "forget", slotId: locked.slotId });
  assert.equal(preview.allowed, false);
  assert.ok(preview.blockers.some((line) => line.includes("has a way out that keeps its folder")), preview.blockers.join("; "));
  assert.equal((await m.forgetSlot({ slotId: operatorLock.slotId })).outcome, "refused");

  const gone = await quarantinedSlot(m, clone, sha, "task-forget-pass", REGISTRATION_OR_IDENTITY.missingRegistration);
  rmSync(gone.path, { recursive: true });
  await m.recoverQuarantines();
  assert.equal(m.store.slot(gone.slotId)?.state, "quarantined", "a pass leaves it for the operator");
  assert.equal(registered(clone, gone.path), true);
});

test("Forget never follows a symlink, in the tree or at the slot's path", async () => {
  const { clone, sha } = repository("mission-forget-symlink-");
  const m = managerWith();
  const service = operationsFor(m);
  const outside = join(dirname(clone), "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "not the slot's\n");

  const inner = await quarantinedSlot(m, clone, sha, "task-forget-inner", INTERRUPTED_PRUNE);
  symlinkSync(outside, join(inner.path, "linked"));
  await service.execute((await service.preview({ action: "forget", slotId: inner.slotId })).token, [...FORGET_ACK]);
  assert.equal(existsSync(inner.path), false);
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "not the slot's\n");

  const top = await quarantinedSlot(m, clone, sha, "task-forget-top", REGISTRATION_OR_IDENTITY.missingRegistration);
  rmSync(top.path, { recursive: true });
  symlinkSync(outside, top.path);
  const preview = await service.preview({ action: "forget", slotId: top.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.ok(preview.consequences.includes(`Removes what stands at ${top.path} without following it. It is not a folder.`), preview.consequences.join("\n"));
  await service.execute(preview.token, [...FORGET_ACK]);
  assert.equal(existsSync(top.path), false);
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "not the slot's\n");
  assert.equal(m.store.slot(top.slotId), null);
});

test("Forget refuses a parent that resolves outside its pool, and removes nothing", async () => {
  const { clone, sha } = repository("mission-forget-parent-");
  const m = managerWith();
  const slot = await quarantinedSlot(m, clone, sha, "task-forget-parent", INTERRUPTED_PRUNE);
  const parent = dirname(slot.path);
  const moved = `${parent}-moved`;
  renameSync(parent, moved);
  symlinkSync(moved, parent);

  const result = await m.forgetSlot({ slotId: slot.slotId });
  assert.deepEqual(result, { outcome: "refused", reason: `${parent} resolves outside its pool` });
  assert.equal(existsSync(join(moved, relative(parent, slot.install))), true);
});

test("Forget removes a locked registration, even when the lock is an operator's", async () => {
  const { clone, sha } = repository("mission-forget-locked-");
  const m = managerWith();
  const service = operationsFor(m);
  const slot = await quarantinedSlot(m, clone, sha, "task-forget-locked", REGISTRATION_OR_IDENTITY.unsafeRegistration);
  gitIn(clone, "worktree", "lock", "--reason", "keep this", slot.path);
  rmSync(slot.path, { recursive: true });

  const preview = await service.preview({ action: "forget", slotId: slot.slotId });
  assert.ok(preview.consequences.includes("Removes the Git registration that names this path, and its lock."), preview.consequences.join("\n"));
  await service.execute(preview.token, [...FORGET_ACK]);
  assert.equal(registered(clone, slot.path), false);
  assert.equal(m.store.slot(slot.slotId), null);
});

test("a Forget cut off after its folder went stays quarantined, offers itself again and finishes", async () => {
  const { clone, sha } = repository("mission-forget-retry-");
  let failRemove = true;
  class FailingRemove extends NativeWorktreeGit {
    override async remove(...args: Parameters<NativeWorktreeGit["remove"]>) {
      if (failRemove) return { ok: false as const, reason: "git worktree remove timed out after 60 s", outcomeUnknown: true };
      return super.remove(...args);
    }
  }
  const m = managerWith(new FailingRemove());
  const service = operationsFor(m);
  const slot = await quarantinedSlot(m, clone, sha, "task-forget-retry", INTERRUPTED_PRUNE);

  const preview = await service.preview({ action: "forget", slotId: slot.slotId });
  await assert.rejects(service.execute(preview.token, [...FORGET_ACK]), (error: unknown) => {
    assert.ok(error instanceof WorktreeOperationError);
    assert.equal(error.status, 503);
    assert.equal(error.message, "git worktree remove timed out after 60 s");
    return true;
  });
  assert.equal(existsSync(slot.path), false);
  assert.equal(m.store.slot(slot.slotId)?.state, "quarantined");

  failRemove = false;
  assert.equal((await forgetActions(service, slot.slotId)).includes("forget"), true);
  await service.execute((await service.preview({ action: "forget", slotId: slot.slotId })).token, [...FORGET_ACK]);
  assert.equal(registered(clone, slot.path), false);
  assert.equal(m.store.slot(slot.slotId), null);
});

test("a folder that cannot be deleted keeps the row and the registration", async () => {
  const { clone, sha } = repository("mission-forget-rm-");
  const m = new WorktreeManager(db, { ...deps, removeTree: async () => { throw new Error("EACCES: permission denied"); } });
  const slot = await quarantinedSlot(m, clone, sha, "task-forget-rm", INTERRUPTED_PRUNE);
  const row = m.store.slot(slot.slotId)!;

  const result = await m.forgetSlot({ slotId: slot.slotId });
  assert.equal(result.outcome, "outcomeUnknown");
  assert.match((result as { reason: string }).reason, /could not be removed: .*EACCES/);
  assert.deepEqual(m.store.slot(slot.slotId), row);
  assert.equal(registered(clone, slot.path), true);
});

test("a listing that fails blocks Forget's preview and its execute, because a registration may name the path", async () => {
  const { clone, sha } = repository("mission-forget-listing-");
  let failing = false;
  class FailingList extends NativeWorktreeGit {
    override async list(...args: Parameters<NativeWorktreeGit["list"]>) {
      if (!failing) return super.list(...args);
      return { ok: false as const, reason: "git worktree list timed out after 30 s", outcomeUnknown: true };
    }
  }
  const m = managerWith(new FailingList());
  const service = operationsFor(m);
  const slot = await quarantinedSlot(m, clone, sha, "task-forget-listing", INTERRUPTED_PRUNE);
  failing = true;

  const preview = await service.preview({ action: "forget", slotId: slot.slotId });
  assert.equal(preview.allowed, false);
  assert.ok(preview.blockers.some((line) => line.includes("git worktree list timed out after 30 s")), preview.blockers.join("; "));
  assert.deepEqual(await m.forgetSlot({ slotId: slot.slotId }), { outcome: "outcomeUnknown", reason: "git worktree list timed out after 30 s" });
  assert.equal(existsSync(slot.path), true);
});

test("the store forgets only the quarantined row at the version it judged", async () => {
  const { clone, sha } = repository("mission-forget-store-");
  const m = managerWith();
  const slot = await quarantinedSlot(m, clone, sha, "task-forget-store");
  const version = m.store.slot(slot.slotId)!.version;
  assert.equal(m.store.forget(slot.slotId, version + 1), false);
  assert.ok(m.store.markPruning(slot.slotId, version, Date.now()));
  assert.equal(m.store.forget(slot.slotId, version + 1), false, "a slot in another state is not forgotten");
  assert.ok(m.store.quarantine(slot.slotId, INTERRUPTED_PRUNE, null, Date.now()));
  assert.equal(m.store.forget(slot.slotId, version + 2), true);
  assert.equal(m.store.slot(slot.slotId), null);
});
