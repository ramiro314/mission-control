import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { openDb } from "../src/server/db.ts";
import { WorktreeManager, type NativeWorktreeLease } from "../src/server/worktrees/manager.ts";
import { NativeWorktreeGit } from "../src/server/worktrees/git.ts";
import { slotGitDirectory } from "../src/server/worktrees/index-lock.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import type { WorktreeOccupancy, WorktreeOccupant } from "../src/server/worktrees/occupancy.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import {
  REGISTRATION_OR_IDENTITY,
  registrationRepairQuarantine,
} from "../src/server/worktrees/quarantine-reasons.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
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
function repository(prefix: string): { clone: string; sha: string } {
  const { origin, clone } = mkOriginAndClone(prefix);
  writeFileSync(join(origin, ".gitignore"), "node_modules/\n");
  gitIn(origin, "add", ".gitignore");
  gitIn(origin, "commit", "-qm", "ignore");
  gitIn(clone, "fetch", "-q", "origin");
  gitIn(clone, "reset", "-q", "--hard", "origin/main");
  return { clone, sha: gitIn(clone, "rev-parse", "HEAD") };
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
  assert.deepEqual(m.recoveryRefusal(row)?.reason, "the registration was locked on purpose (keep this slot for the audit)");
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

test("only the reasons about Git's registration are Repair's", () => {
  assert.equal(registrationRepairQuarantine(REGISTRATION_OR_IDENTITY.unsafeRegistration), true);
  assert.equal(registrationRepairQuarantine(REGISTRATION_OR_IDENTITY.noSafeRegistration), true);
  assert.equal(registrationRepairQuarantine(`${REGISTRATION_OR_IDENTITY.missingRegistration}: cause`), true);
  assert.equal(registrationRepairQuarantine(REGISTRATION_OR_IDENTITY.repairedHoldsWork), false);
  assert.equal(registrationRepairQuarantine(REGISTRATION_OR_IDENTITY.commonDirectory), false);
  assert.equal(registrationRepairQuarantine("slot Git state is unknown"), false);
  assert.equal(registrationRepairQuarantine(null), false);
});

const manager = managerWith();
const operations = new WorktreeOperationsService(manager, {
  legacy: new LegacyTreehouseService(db),
  tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
  checks: new CheckLeaseManager(db, { manager, legacy: new LegacyTreehouseService(db) }),
  checkRecovery: async () => "unknown",
  notifyChanged: () => {},
  diskBytes: async () => 1024,
});

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
  assert.match(await blockers(), /Git has no fix for this slot: the registration was locked on purpose \(held on purpose\)/);
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
