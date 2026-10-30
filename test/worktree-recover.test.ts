import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { openDb } from "../src/server/db.ts";
import {
  WorktreeManager,
  type NativeWorktreeLease,
  type WorktreeManagerDeps,
} from "../src/server/worktrees/manager.ts";
import {
  INDEX_LOCK_STALE_MS,
  isGitProcess,
  lockCausedQuarantine,
  slotGitDirectory,
} from "../src/server/worktrees/index-lock.ts";
import type { WorktreeOccupancy, WorktreeOccupant } from "../src/server/worktrees/occupancy.ts";
import { REGISTRATION_OR_IDENTITY_REASONS } from "../src/server/worktrees/quarantine-reasons.ts";
import { quarantinedSlotProblems } from "../src/server/worktrees/storage-problems.ts";
import { describeWorktreeWork } from "../src/server/git/worktree-return-safety.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import { NativeWorktreeGit, type GitResult, type WorktreeGit } from "../src/server/worktrees/git.ts";
import { WORKTREE_INVENTORY_LIMITS } from "../src/shared/worktrees.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

const db = openDb();

afterEach(() => {
  db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools; DELETE FROM app_config WHERE key = 'worktrees';");
});

/** Processes the fake occupancy reports in every slot; empty unless a test plants one. */
let occupants: WorktreeOccupant[] = [];
/** When set, the fake reports occupancy as unknown, for this reason, instead. */
let occupancyUnknown: string | null = null;

function occupancy(paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> {
  const observed: WorktreeOccupancy = occupancyUnknown === null
    ? { status: "known", occupants }
    : { status: "unknown", reason: occupancyUnknown };
  return Promise.resolve(new Map(paths.map((path) => [path, observed])));
}

function manager(deps: Partial<WorktreeManagerDeps> = {}): WorktreeManager {
  return new WorktreeManager(db, {
    occupancy,
    fileHolders: async () => [],
    resolvePolicy: () => ({ enabled: true, maxSlots: 4, setupArgv: null }),
    ...deps,
  });
}

afterEach(() => {
  occupants = [];
  occupancyUnknown = null;
});

/** An origin whose `.gitignore` covers a regenerable cache and an operator-only file. */
function repository(prefix: string, ignore = "node_modules/\n.env\n"): { origin: string; clone: string; sha: string } {
  const { origin, clone } = mkOriginAndClone(prefix);
  writeFileSync(join(origin, ".gitignore"), ignore);
  gitIn(origin, "add", ".gitignore");
  gitIn(origin, "commit", "-qm", "ignore");
  gitIn(clone, "fetch", "-q", "origin");
  gitIn(clone, "reset", "-q", "--hard", "origin/main");
  return { origin, clone, sha: gitIn(clone, "rev-parse", "HEAD") };
}

async function leased(m: WorktreeManager, clone: string, sha: string, key: string): Promise<NativeWorktreeLease> {
  const result = await m.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "task", key } });
  assert.equal(result.outcome, "acquired");
  return (result as { outcome: "acquired"; lease: NativeWorktreeLease }).lease;
}

async function lockPath(slotPath: string): Promise<string> {
  const common = gitIn(slotPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const gitDirectory = await slotGitDirectory(slotPath, common);
  assert.ok(gitDirectory, "a pool slot's .git file names a directory under <common>/worktrees/");
  return join(gitDirectory, "index.lock");
}

/**
 * The field incident, reproduced rather than written into the row: a stale `index.lock` sits in
 * the slot's Git directory, the owner's Return runs, and Git's own refusal quarantines the slot.
 */
async function lockQuarantined(m: WorktreeManager, clone: string, sha: string, key: string) {
  const held = await leased(m, clone, sha, key);
  const lock = await lockPath(held.path);
  writeFileSync(lock, "");
  const released = await m.release(held, { ownerAuthorized: true });
  assert.equal(released.outcome, "outcomeUnknown", "the reset cannot take the index lock");
  const slot = m.store.slot(held.slotId)!;
  assert.equal(slot.state, "quarantined");
  assert.ok(lockCausedQuarantine(slot.lastError), `recorded Git's lock refusal: ${slot.lastError}`);
  return { held, lock, slot };
}

function occupant(path: string, command: string): WorktreeOccupant {
  return {
    pid: 4242,
    ppid: 1,
    startRaw: "Mon Oct 26 09:00:00 2026",
    startMs: 0,
    command,
    cwd: path,
    knownOwner: null,
  };
}

function gitOccupant(path: string): WorktreeOccupant {
  return occupant(path, `git -C ${path} status`);
}

test("a lock-caused quarantine is recognized from Git's stable refusal text alone", () => {
  assert.equal(
    lockCausedQuarantine("git checkout failed: fatal: Unable to create '/pool/5/repo/.git/worktrees/repo4/index.lock': File exists.\n\nAnother git process seems to be running"),
    true,
  );
  assert.equal(lockCausedQuarantine("slot process occupancy is unknown"), false);
  assert.equal(lockCausedQuarantine(null), false);
  assert.equal(isGitProcess("git -C /pool/5/repo status"), true);
  assert.equal(isGitProcess("/usr/bin/git status"), true);
  assert.equal(isGitProcess("/opt/homebrew/libexec/git-core/git-remote-https origin"), true);
  assert.equal(isGitProcess("node /pool/5/repo/node_modules/.bin/gitleaks"), false);
});

test("Recover removes index.lock and returns the slot to available, and refuses a live owner", async () => {
  const { clone, sha } = repository("mission-recover-manual-");
  let referenced = false;
  const m = manager({ ownerReferenced: async () => referenced });
  const { held, lock, slot } = await lockQuarantined(m, clone, sha, "task-recover-manual");

  referenced = true;
  const refused = await m.recoverSlot({ slotId: slot.id, allowDirty: false, automatic: false });
  assert.deepEqual(refused, { outcome: "refused", reason: "a live task owner references this slot" });
  assert.equal(existsSync(lock), true, "a refused Recover touches nothing");
  assert.equal(m.store.slot(slot.id)?.state, "quarantined");

  referenced = false;
  assert.deepEqual(
    await m.recoverSlot({ slotId: slot.id, allowDirty: false, automatic: false }),
    { outcome: "recovered", removedLock: lock },
  );
  assert.equal(existsSync(lock), false);
  const recovered = m.store.slot(slot.id)!;
  assert.equal(recovered.state, "available");
  assert.equal(recovered.activeLeaseId, null);
  assert.equal(recovered.quarantineReason, null);
  assert.equal(gitIn(held.path, "rev-parse", "HEAD"), sha);
  assert.deepEqual(quarantinedSlotProblems(m.store.slots()), [], "the problem clears with the quarantine");
});

test("Recover never removes index.lock while a Git process works in the slot or lsof sees a holder", async () => {
  const { clone, sha } = repository("mission-recover-git-process-");
  let holders: number[] | null = [];
  const m = manager({ fileHolders: async () => holders });
  const { held, lock, slot } = await lockQuarantined(m, clone, sha, "task-recover-git-process");

  occupants = [gitOccupant(held.path)];
  const busy = await m.recoverSlot({ slotId: slot.id, allowDirty: false, automatic: false });
  assert.equal(busy.outcome, "refused");
  assert.match((busy as { reason: string }).reason, /a Git process is using the worktree \(pid 4242/);
  assert.equal(existsSync(lock), true);

  occupants = [];
  holders = [5150];
  assert.deepEqual(
    await m.recoverSlot({ slotId: slot.id, allowDirty: false, automatic: false }),
    { outcome: "refused", reason: "index.lock is held open by pid 5150", blocking: { kind: "lock", path: lock } },
  );
  holders = null;
  assert.deepEqual(
    await m.recoverSlot({ slotId: slot.id, allowDirty: false, automatic: false }),
    { outcome: "refused", reason: "lsof could not tell whether a process holds index.lock", blocking: { kind: "lock", path: lock } },
  );
  assert.equal(existsSync(lock), true);
  assert.equal(m.store.slot(slot.id)?.state, "quarantined");
});

test("Recover fails closed on unknown occupancy, any other process, and an unprovable Git directory", async () => {
  const { clone, sha } = repository("mission-recover-fail-closed-");
  const m = manager();
  const { held, lock, slot } = await lockQuarantined(m, clone, sha, "task-recover-fail-closed");
  // A lock refusal names the lock it judged; the others have no single path to name.
  const refusal = async (reason: string, blocking?: { kind: "lock"; path: string }) => {
    assert.deepEqual(
      await m.recoverSlot({ slotId: slot.id, allowDirty: false, automatic: false }),
      blocking ? { outcome: "refused", reason, blocking } : { outcome: "refused", reason },
    );
    assert.equal(existsSync(lock), true, `${reason}: the lock stays`);
    assert.equal(m.store.slot(slot.id)?.state, "quarantined", `${reason}: the slot stays quarantined`);
  };

  // Unknown occupancy cannot prove that no Git process is still writing the index.
  occupancyUnknown = "cwd listing failed: exit 1";
  await refusal("process occupancy is unknown, so a Git process may still be using the worktree", { kind: "lock", path: lock });
  occupancyUnknown = null;

  // A process that is not Git does not hold the lock, but the reset would pull the tree out
  // from under it, so Recover still refuses while it is there.
  occupants = [occupant(held.path, "node server.js")];
  await refusal("one or more processes still occupy the worktree");
  occupants = [];

  // A `.git` file naming a directory outside `<common>/worktrees/` is not this slot's own
  // Git directory, so no lock under it is one Recover may remove.
  const dotGit = join(held.path, ".git");
  const original = readFileSync(dotGit, "utf8");
  writeFileSync(dotGit, `gitdir: ${join(clone, "..", "elsewhere")}\n`);
  await refusal("the slot's Git directory could not be proven, so its index.lock cannot be located");
  writeFileSync(dotGit, original);
});

test("the automatic pass recovers a clean slot once its lock is gone or older than 10 minutes", async () => {
  const { clone, sha } = repository("mission-recover-automatic-");
  let now = Date.now();
  const m = manager({ now: () => now });
  const fresh = await lockQuarantined(m, clone, sha, "task-auto-fresh");
  const gone = await lockQuarantined(m, clone, sha, "task-auto-gone");
  // A regenerable cache is not work: the slot is clean with it, and the reset keeps it.
  mkdirSync(join(gone.held.path, "node_modules"), { recursive: true });
  writeFileSync(join(gone.held.path, "node_modules", "cache.txt"), "warm\n");

  // A lock younger than 10 minutes may belong to a Git command that is about to finish.
  assert.deepEqual(
    await m.recoverSlot({ slotId: fresh.slot.id, allowDirty: false, automatic: true }),
    { outcome: "refused", reason: "index.lock is younger than 10 minutes", blocking: { kind: "lock", path: fresh.lock } },
  );
  await m.recoverQuarantines();
  assert.equal(m.store.slot(fresh.slot.id)?.state, "quarantined");
  // The pass records each refusal with the lock path that blocked it, for the slot card.
  assert.deepEqual(m.recoveryRefusal(m.store.slot(fresh.slot.id)!), {
    at: now,
    reason: "index.lock is younger than 10 minutes",
    blocking: { kind: "lock", path: fresh.lock },
  });
  assert.equal(existsSync(fresh.lock), true);
  assert.equal(m.store.slot(gone.slot.id)?.state, "quarantined", "both locks are still there");

  // The lock disappears on its own (slot 5 in the audit): the next pass recovers at once.
  unlinkSync(gone.lock);
  await m.recoverQuarantines();
  assert.equal(m.store.slot(gone.slot.id)?.state, "available");
  assert.equal(m.recoveryRefusal(m.store.slot(gone.slot.id)!), null, "a recovered slot keeps no refusal");
  assert.equal(existsSync(join(gone.held.path, "node_modules", "cache.txt")), true);
  assert.equal(m.store.slot(fresh.slot.id)?.state, "quarantined");

  // Ten minutes on, nothing holds the fresh lock and no Git process uses the slot.
  now += INDEX_LOCK_STALE_MS + 1_000;
  await m.recoverQuarantines();
  assert.equal(m.store.slot(fresh.slot.id)?.state, "available");
  assert.equal(existsSync(fresh.lock), false);
});

test("the automatic pass leaves a slot holding work quarantined with that work intact", async () => {
  const { clone, sha } = repository("mission-recover-work-");
  const m = manager();
  const old = (Date.now() - INDEX_LOCK_STALE_MS * 2) / 1_000;
  const cases: Array<{
    name: string;
    plant: (path: string) => void;
    intact: (path: string) => boolean;
    blocking: { kind: "tracked" | "untracked" | "ignored" | "unpushed"; path: string };
  }> = [
    {
      name: "an uncommitted change",
      blocking: { kind: "tracked", path: "keep.txt" },
      plant: (path) => writeFileSync(join(path, "keep.txt"), "edited\n"),
      intact: (path) => readFileSync(join(path, "keep.txt"), "utf8") === "edited\n",
    },
    {
      name: "an untracked file",
      blocking: { kind: "untracked", path: "notes.md" },
      plant: (path) => writeFileSync(join(path, "notes.md"), "draft\n"),
      intact: (path) => existsSync(join(path, "notes.md")),
    },
    {
      name: "an unpushed commit",
      blocking: { kind: "unpushed", path: "HEAD" },
      plant: (path) => {
        writeFileSync(join(path, "keep.txt"), "committed\n");
        gitIn(path, "-c", "user.email=t@test", "-c", "user.name=t", "commit", "-qam", "local only");
      },
      intact: (path) => readFileSync(join(path, "keep.txt"), "utf8") === "committed\n",
    },
  ];
  const planted = [];
  for (const [index, each] of cases.entries()) {
    const quarantined = await lockQuarantined(m, clone, sha, `task-work-${index}`);
    // The plant needs the index, so the stale lock goes and comes back aged.
    unlinkSync(quarantined.lock);
    each.plant(quarantined.held.path);
    writeFileSync(quarantined.lock, "");
    utimesSync(quarantined.lock, old, old);
    planted.push({ ...each, ...quarantined });
  }

  await m.recoverQuarantines();
  const inventory = (await m.status()).flatMap((pool) => pool.slots);
  for (const each of planted) {
    // The pass recorded the entry that blocked it, and inventory carries it to the slot card.
    const recorded = m.recoveryRefusal(m.store.slot(each.slot.id)!);
    assert.deepEqual(recorded?.blocking, each.blocking, each.name);
    assert.equal(recorded?.reason, `the slot holds work Recover would discard: ${describeWorktreeWork(each.blocking)}`);
    assert.deepEqual(inventory.find((entry) => entry.slot.id === each.slot.id)?.recoveryRefusal, recorded);
    const refused = await m.recoverSlot({ slotId: each.slot.id, allowDirty: false, automatic: true });
    assert.equal(refused.outcome, "refused");
    assert.match((refused as { reason: string }).reason, /^the slot holds work Recover would discard: /, each.name);
    assert.deepEqual((refused as { blocking?: unknown }).blocking, each.blocking, each.name);
    assert.equal(m.store.slot(each.slot.id)?.state, "quarantined", `${each.name} keeps the slot quarantined`);
    assert.equal(each.intact(each.held.path), true, `${each.name} is intact`);
    assert.equal(existsSync(each.lock), true, `${each.name}: the automatic pass removes nothing`);
  }

  // Only the operator's Recover, having acknowledged the discard, resets one.
  const [first] = planted;
  assert.equal(
    (await m.recoverSlot({ slotId: first!.slot.id, allowDirty: false, automatic: false })).outcome,
    "refused",
  );
  assert.equal(
    (await m.recoverSlot({ slotId: first!.slot.id, allowDirty: true, automatic: false })).outcome,
    "recovered",
  );
  // Leaving the quarantine retires its refusal: a later quarantine is judged afresh.
  assert.equal(m.recoveryRefusal(m.store.slot(first!.slot.id)!), null);
  assert.equal(readFileSync(join(first!.held.path, "keep.txt"), "utf8"), "base\n");
});

test("a quarantined slot raises one bannered problem keyed by its durable entry time", async () => {
  const { clone, sha } = repository("mission-recover-problem-");
  const m = manager();
  const { slot } = await lockQuarantined(m, clone, sha, "task-problem");
  assert.ok(slot.quarantinedAt);
  const [problem] = quarantinedSlotProblems(m.store.slots());
  assert.deepEqual(problem, {
    id: `quarantined-slot:${slot.id}:${slot.quarantinedAt}`,
    kind: "quarantined-slot",
    bannered: true,
    message: `Slot ${slot.ordinal} of clone is quarantined: a stale index.lock blocked its reset`,
    link: { target: "slot", slotId: slot.id },
  });

  // Quarantining an already quarantined slot continues the same occurrence.
  m.store.quarantine(slot.id, "slot Git state is unknown", null, slot.quarantinedAt! + 60_000);
  assert.equal(m.store.slot(slot.id)?.quarantinedAt, slot.quarantinedAt);
  assert.equal(quarantinedSlotProblems(m.store.slots())[0]?.id, problem!.id);

  // Leaving quarantine ends that occurrence. Nothing clears the column on the way out, so a
  // later quarantine is a new occurrence only because the slot was no longer quarantined, and
  // a banner dismissed for the first one comes back for the second.
  assert.equal((await m.recoverSlot({ slotId: slot.id, allowDirty: false, automatic: false })).outcome, "recovered");
  assert.equal(m.store.slot(slot.id)?.state, "available");
  assert.deepEqual(quarantinedSlotProblems(m.store.slots()), []);
  const reentered = slot.quarantinedAt! + 120_000;
  m.store.quarantine(slot.id, "slot Git state is unknown", null, reentered);
  assert.equal(m.store.slot(slot.id)?.quarantinedAt, reentered);
  const [again] = quarantinedSlotProblems(m.store.slots());
  assert.equal(again?.id, `quarantined-slot:${slot.id}:${reentered}`);
  assert.notEqual(again?.id, problem!.id);
});

/** The slot as the Settings inventory serves it: the view the card renders, after every bound. */
async function inventorySlot(m: WorktreeManager, slotId: string) {
  const operations = new WorktreeOperationsService(m, {
    legacy: new LegacyTreehouseService(db),
    tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
    checks: new CheckLeaseManager(db, { manager: m, legacy: new LegacyTreehouseService(db) }),
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => 1024,
  });
  const inventory = await operations.inventory();
  const slot = inventory.repositories.flatMap((repo) => repo.slots).find((each) => each.id === slotId);
  assert.ok(slot, "the slot is in the inventory");
  return slot;
}

/** A lock-caused quarantine whose stale lock is old enough for the automatic pass to judge its work. */
async function agedLockQuarantine(m: WorktreeManager, clone: string, sha: string, key: string, plant: (path: string) => void) {
  const quarantined = await lockQuarantined(m, clone, sha, key);
  unlinkSync(quarantined.lock);
  plant(quarantined.held.path);
  writeFileSync(quarantined.lock, "");
  const old = (Date.now() - INDEX_LOCK_STALE_MS * 2) / 1_000;
  utimesSync(quarantined.lock, old, old);
  return quarantined;
}

test("the inventory carries a recorded refusal to the slot view, with its blocking path exactly as Git listed it", async () => {
  const { clone, sha } = repository("mission-recover-view-");
  const m = manager();
  const { slot } = await agedLockQuarantine(m, clone, sha, "task-view", (path) => {
    mkdirSync(join(path, "notes"));
    writeFileSync(join(path, "notes", "draft  one.md"), "draft\n");
  });
  await m.recoverQuarantines();
  const recorded = m.recoveryRefusal(m.store.slot(slot.id)!);
  assert.ok(recorded);
  const view = await inventorySlot(m, slot.id);
  assert.deepEqual(view.recoveryRefusal, {
    at: recorded.at,
    // The reason is prose and is compacted like every other inventory sentence...
    reason: "the slot holds work Recover would discard: untracked notes/draft one.md",
    // ...but the path is what an operator goes to find, so its whitespace is never collapsed.
    blocking: { kind: "untracked", path: "notes/draft  one.md" },
  });
});

test("the inventory lists at most 16 occupants per slot, clips each command to 512 bytes, and lists none when occupancy is unknown", async () => {
  const { clone, sha } = repository("mission-recover-occupants-");
  const m = manager();
  const held = await leased(m, clone, sha, "task-occupants");
  // A two-byte character straddles byte 512, so a clip that is not character-aware would split it.
  const straddling = `${"a".repeat(511)}é and the rest`;
  const exact = "b".repeat(512);
  occupants = Array.from({ length: 17 }, (_, index) => ({
    ...occupant(held.path, index === 0 ? straddling : index === 1 ? exact : `node worker-${index}.js`),
    pid: 6000 + index,
    startMs: 1_000 + index,
  }));
  const view = await inventorySlot(m, held.slotId);
  assert.equal(WORKTREE_INVENTORY_LIMITS.occupantsPerSlot, 16);
  assert.equal(WORKTREE_INVENTORY_LIMITS.occupantCommandBytes, 512);
  assert.equal(view.occupants.length, 16, "the 17th occupant is counted, not listed");
  assert.deepEqual(view.processes, { state: "known", count: 17, reason: null });
  assert.deepEqual(view.occupants.map((each) => each.pid), Array.from({ length: 16 }, (_, index) => 6000 + index));
  assert.deepEqual(view.occupants[2], { pid: 6002, command: "node worker-2.js", startedAt: 1_002 });
  assert.equal(view.occupants[0]!.command, "a".repeat(511), "the straddling character is dropped whole");
  assert.equal(view.occupants[1]!.command, exact, "a command of exactly 512 bytes is kept whole");
  for (const each of view.occupants) assert.ok(Buffer.byteLength(each.command, "utf8") <= 512);

  occupants = [];
  occupancyUnknown = "process listing timed out";
  const unknown = await inventorySlot(m, held.slotId);
  assert.deepEqual(unknown.occupants, []);
  assert.deepEqual(unknown.processes, { state: "unknown", count: null, reason: "process listing timed out" });
});

test("a recorded refusal is shown only for the quarantine it judged", async () => {
  const { clone, sha } = repository("mission-recover-refusal-version-");
  const m = manager();
  const { slot } = await agedLockQuarantine(m, clone, sha, "task-refusal-version", (path) => {
    writeFileSync(join(path, "notes.md"), "draft\n");
  });
  await m.recoverQuarantines();
  const judged = m.store.slot(slot.id)!;
  assert.deepEqual(m.recoveryRefusal(judged)?.blocking, { kind: "untracked", path: "notes.md" });

  // Still quarantined, but quarantined again: the version moved, so the old refusal no longer
  // describes it, and neither the manager nor the inventory shows it.
  const requarantined = m.store.quarantine(slot.id, "slot Git registration is bare, locked, or prunable", null, Date.now(), judged.version);
  assert.ok(requarantined);
  assert.equal(requarantined.state, "quarantined");
  assert.equal(m.recoveryRefusal(requarantined), null);
  assert.equal((await inventorySlot(m, slot.id)).recoveryRefusal, null);
  assert.equal((await m.status()).flatMap((pool) => pool.slots).find((each) => each.slot.id === slot.id)?.recoveryRefusal, null);

  // A row carrying the judged version still matches the record, so the version alone retired it;
  // the next pass, for which this slot is no longer a candidate, then drops the record itself.
  assert.ok(m.recoveryRefusal(judged));
  await m.recoverQuarantines();
  assert.equal(m.recoveryRefusal(judged), null, "a slot that is no longer a candidate keeps no record");
});

test("a work check that cannot read the slot refuses Recover as unreadable, never as work, and names no path", async () => {
  const { clone, sha } = repository("mission-recover-unreadable-");
  const m = manager();
  const { held, lock, slot } = await lockQuarantined(m, clone, sha, "task-unreadable");
  unlinkSync(lock);
  // A corrupt index makes `git status` fail while the checkout's identity still reads.
  writeFileSync(join(dirname(lock), "index"), "not an index");
  assert.equal(gitIn(held.path, "rev-parse", "--show-toplevel"), held.path);

  const reason = "the slot's work could not be read: working tree could not be read";
  // An operator's Recover reads its work once the reset has fetched and validated its target,
  // and that validation is the first read to find the index unreadable.
  const manual = await m.recoverSlot({ slotId: slot.id, allowDirty: false, automatic: false });
  assert.equal(manual.outcome, "refused");
  assert.match((manual as { reason: string }).reason, /git status failed: .*index/);
  assert.equal("blocking" in manual, false);
  await m.recoverQuarantines();
  assert.deepEqual(m.recoveryRefusal(m.store.slot(slot.id)!), { at: m.recoveryRefusal(m.store.slot(slot.id)!)!.at, reason, blocking: null });
  assert.equal(m.store.slot(slot.id)?.state, "quarantined");
});

test("each quarantine, recovery and automatic-recovery refusal logs one line, and a repeated refusal none", async (t) => {
  const { clone, sha } = repository("mission-recover-log-");
  let now = Date.now();
  const m = manager({ now: () => now });
  const warned = t.mock.method(console, "warn", () => {});
  const logged = t.mock.method(console, "log", () => {});
  const lines = () => [...warned.mock.calls, ...logged.mock.calls]
    .map((call) => String(call.arguments[0]))
    .filter((line) => line.startsWith("[worktrees] "));

  const { slot, lock } = await lockQuarantined(m, clone, sha, "task-log");
  assert.equal(lines().length, 1);
  assert.match(lines()[0]!, /^\[worktrees\] quarantined clone slot 1: return reset failed \(git checkout --force --detach failed: fatal: Unable to create .*index\.lock.: File exists\. Another git process .*\)$/);

  await m.recoverQuarantines();
  assert.equal(lines().length, 2);
  assert.equal(
    lines()[1],
    `[worktrees] automatic recovery of clone slot 1 refused: index.lock is younger than 10 minutes (blocked by ${lock})`,
  );
  await m.recoverQuarantines();
  await m.recoverQuarantines();
  assert.equal(lines().length, 2, "the same refusal on later passes is not logged again");

  now += INDEX_LOCK_STALE_MS + 1_000;
  await m.recoverQuarantines();
  assert.equal(m.store.slot(slot.id)?.state, "available");
  assert.equal(lines().length, 3);
  assert.equal(
    lines()[2],
    `[worktrees] recovered clone slot 1 automatically from its quarantine (return reset failed), removing a stale ${lock}`,
  );
});

/** A slot that went back to the pool, then quarantined for `reason`, its owner gone. */
async function quarantinedSlot(
  m: WorktreeManager,
  clone: string,
  sha: string,
  key: string,
  reason: string,
  detail: string | null = null,
) {
  const held = await leased(m, clone, sha, key);
  assert.equal((await m.release(held, { ownerAuthorized: true })).outcome, "released");
  const available = m.store.slot(held.slotId)!;
  assert.equal(available.state, "available");
  assert.ok(m.store.quarantine(held.slotId, reason, detail, Date.now(), available.version));
  return { path: held.path, slotId: held.slotId };
}

function write(root: string, file: string, body = "installed\n"): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), body);
}

/** Every file's bytes and inode, so "unchanged" means unchanged. */
function snapshot(root: string, files: readonly string[]): Array<[string, string, number]> {
  return files.map((file) => [file, readFileSync(join(root, file), "utf8"), statSync(join(root, file)).ino]);
}

const CLEARED = [
  "slot process occupancy is unknown",
  "slot occupancy is unknown",
  "slot occupancy became unknown before reset",
  "slot Git state is unknown",
  "slot Git state could not be inspected",
  "Git worktree registrations are unknown: exit 1",
  "last-released domain ownership is unknown",
  "available slot is occupied or dirty",
  "available slot is dirty",
];

for (const reason of CLEARED) {
  test(`the automatic pass clears an empty, ownerless slot quarantined as "${reason}", keeping its warm install`, async () => {
    const { clone, sha } = repository("mission-recover-clears-", ".yarn/install-state.gz\nnode_modules/\n.idea/\n.env\n");
    const m = manager();
    const { path, slotId } = await quarantinedSlot(m, clone, sha, "task-clears", reason, "git status timed out after 15 s");
    const kept = [".yarn/install-state.gz", "node_modules/pkg/index.js", ".idea/workspace.xml", ".env"];
    for (const file of kept) write(path, file);
    const before = snapshot(path, kept);

    await m.recoverQuarantines();
    const slot = m.store.slot(slotId)!;
    assert.equal(slot.state, "available");
    assert.equal(slot.quarantineReason, null);
    assert.equal(slot.lastError, null);
    assert.equal(m.recoveryRefusal(slot), null);
    assert.deepEqual(snapshot(path, kept), before, "the reset keeps every ignored file, inode included");
  });
}

const STAYS_QUARANTINED: Array<{
  name: string;
  refusal: RegExp;
  deps?: Partial<WorktreeManagerDeps>;
  arrange?: (path: string) => void;
}> = [
  { name: "a live owner", refusal: /^a live task owner references this slot$/, deps: { ownerReferenced: async () => true } },
  {
    name: "an owner that cannot be read",
    refusal: /^domain ownership is unknown: /,
    deps: { ownerReferenced: async () => { throw new Error("registry unreadable"); }, pause: async () => {} },
  },
  {
    name: "an occupant",
    refusal: /^one or more processes still occupy the worktree$/,
    arrange: (path) => { occupants = [occupant(path, "node server.js")]; },
  },
  {
    name: "occupancy that cannot be read",
    refusal: /^process listing timed out$/,
    arrange: () => { occupancyUnknown = "process listing timed out"; },
  },
];

for (const { name, refusal, deps, arrange } of STAYS_QUARANTINED) {
  test(`the automatic pass leaves a slot with ${name} exactly as it was, and records why`, async () => {
    const { clone, sha } = repository("mission-recover-stays-");
    const m = manager(deps);
    const held = await leased(m, clone, sha, "task-stays");
    assert.ok(m.store.quarantine(held.slotId, "slot process occupancy is unknown", null, Date.now(), held.slotVersion));
    write(held.path, "notes.md", "draft\n");
    arrange?.(held.path);
    const judged = m.store.slot(held.slotId)!;

    await m.recoverQuarantines();
    assert.deepEqual(m.store.slot(held.slotId), judged, "the row did not move");
    assert.equal(readFileSync(join(held.path, "notes.md"), "utf8"), "draft\n");
    assert.match(m.recoveryRefusal(judged)?.reason ?? "", refusal);
    assert.equal(m.recoveryRefusal(judged)?.blocking, null);
  });
}

test("the automatic pass refuses a slot holding reset-rule work, naming the entry and leaving it intact", async () => {
  const { clone, sha } = repository("mission-recover-reset-work-");
  const m = manager();
  const cases: Array<{ reason: string; plant: (path: string) => void; blocking: { kind: string; path: string } }> = [
    {
      reason: "available slot is dirty",
      plant: (path) => writeFileSync(join(path, "keep.txt"), "edited\n"),
      blocking: { kind: "tracked", path: "keep.txt" },
    },
    {
      reason: "slot Git state is unknown",
      plant: (path) => writeFileSync(join(path, "notes.md"), "draft\n"),
      blocking: { kind: "untracked", path: "notes.md" },
    },
    {
      reason: "slot process occupancy is unknown",
      plant: (path) => {
        writeFileSync(join(path, "keep.txt"), "committed\n");
        gitIn(path, "-c", "user.email=t@test", "-c", "user.name=t", "commit", "-qam", "local only");
      },
      blocking: { kind: "unpushed", path: "HEAD" },
    },
  ];
  const planted = [];
  for (const [index, each] of cases.entries()) {
    const quarantined = await quarantinedSlot(m, clone, sha, `task-reset-work-${index}`, each.reason);
    each.plant(quarantined.path);
    planted.push({ ...each, ...quarantined, head: gitIn(quarantined.path, "rev-parse", "HEAD"), row: m.store.slot(quarantined.slotId)! });
  }

  await m.recoverQuarantines();
  for (const each of planted) {
    assert.deepEqual(m.store.slot(each.slotId), each.row, each.reason);
    assert.deepEqual(m.recoveryRefusal(each.row)?.blocking, each.blocking, each.reason);
    assert.equal(gitIn(each.path, "rev-parse", "HEAD"), each.head);
  }
});

test("a fresh Git read that fails leaves the slot quarantined, records it for the card, and logs it once", async (t) => {
  const { clone, sha } = repository("mission-recover-fresh-read-");
  let failing = false;
  class FlakyGit extends NativeWorktreeGit {
    override async inspect(path: string): ReturnType<WorktreeGit["inspect"]> {
      return failing ? { ok: false, reason: "git status timed out after 15 s", outcomeUnknown: true } : super.inspect(path);
    }
  }
  const m = manager({ git: new FlakyGit() });
  const warned = t.mock.method(console, "warn", () => {});
  const { path, slotId } = await quarantinedSlot(m, clone, sha, "task-fresh-read", "slot Git state is unknown");
  const judged = m.store.slot(slotId)!;

  failing = true;
  await m.recoverQuarantines();
  await m.recoverQuarantines();
  assert.deepEqual(m.store.slot(slotId), judged);
  assert.equal(m.recoveryRefusal(judged)?.reason, "git status timed out after 15 s");
  assert.equal(warned.mock.calls.filter((call) => String(call.arguments[0]).includes("refused")).length, 1);

  failing = false;
  await m.recoverQuarantines();
  assert.equal(m.store.slot(slotId)?.state, "available");
  assert.equal(existsSync(path), true);
});

const NEVER_CLEARED = [
  "slot path or Git registration is missing",
  "slot Git registration is bare, locked, or prunable",
  "slot path is not the exact path owned by its native pool",
  "slot belongs to a different Git common directory",
  "pool repository identity no longer matches its durable row",
  "pool marker is missing, malformed, or belongs to another pool",
  "last-released lease identity is incomplete",
  "available slot still carries active lease identity",
  "available slot HEAD moved outside an allocator transition",
  "leased slot has no matching domain owner reference",
  "return verification failed",
];

test("a registration or identity quarantine is never a candidate, even once every read would succeed", async () => {
  const { clone, sha } = repository("mission-recover-never-");
  const m = manager();
  const { slotId } = await quarantinedSlot(m, clone, sha, "task-never", NEVER_CLEARED[0]!);
  for (const reason of NEVER_CLEARED) {
    assert.ok(m.store.quarantine(slotId, reason, null, Date.now()));
    const row = m.store.slot(slotId)!;
    await m.recoverQuarantines();
    assert.deepEqual(m.store.slot(slotId), row, reason);
    assert.equal(m.recoveryRefusal(row), null, `${reason}: not judged, so nothing to refuse`);
    assert.deepEqual(
      await m.recoverSlot({ slotId, allowDirty: false, automatic: true }),
      { outcome: "refused", reason: "automatic recovery does not clear this quarantine" },
      reason,
    );
  }
});

test("a registration or identity quarantine carrying Git's lock text is still never a candidate", async () => {
  const { clone, sha } = repository("mission-recover-never-lock-");
  const m = manager();
  const { path, slotId } = await quarantinedSlot(m, clone, sha, "task-never-lock", "slot Git state is unknown");
  const lockText = `git checkout failed: fatal: Unable to create '${await lockPath(path)}': File exists.`;
  for (const reason of [...REGISTRATION_OR_IDENTITY_REASONS, "slot path or Git registration is missing: cause"]) {
    assert.ok(m.store.quarantine(slotId, reason, lockText, Date.now()));
    const row = m.store.slot(slotId)!;
    assert.equal(lockCausedQuarantine(row.lastError), true, "the error alone reads as lock-caused");
    await m.recoverQuarantines();
    assert.deepEqual(m.store.slot(slotId), row, reason);
    assert.equal(m.recoveryRefusal(row), null, `${reason}: not judged, so nothing to refuse`);
    assert.deepEqual(
      await m.recoverSlot({ slotId, allowDirty: false, automatic: true }),
      { outcome: "refused", reason: "automatic recovery does not clear this quarantine" },
      reason,
    );
  }
});

const LAST_RELEASED_OWNERS: Array<{
  name: string;
  reason: string;
  ownerReferenced: () => Promise<boolean>;
  refusal: RegExp;
}> = [
  {
    name: "a live last-released owner",
    reason: "available slot is dirty",
    ownerReferenced: async () => true,
    refusal: /^a live task owner references this slot$/,
  },
  {
    name: "a live last-released owner",
    reason: "last-released domain ownership is unknown",
    ownerReferenced: async () => true,
    refusal: /^a live task owner references this slot$/,
  },
  {
    name: "a last-released owner that cannot be read",
    reason: "available slot is dirty",
    ownerReferenced: async () => { throw new Error("registry unreadable"); },
    refusal: /^domain ownership is unknown: /,
  },
  {
    name: "a last-released owner that cannot be read",
    reason: "last-released domain ownership is unknown",
    ownerReferenced: async () => { throw new Error("registry unreadable"); },
    refusal: /^domain ownership is unknown: /,
  },
];

for (const { name, reason, ownerReferenced, refusal } of LAST_RELEASED_OWNERS) {
  test(`the automatic pass leaves a slot quarantined as "${reason}" with ${name} exactly as it was`, async () => {
    const { clone, sha } = repository("mission-recover-last-owner-");
    let judge: () => Promise<boolean> = async () => false;
    const m = manager({ ownerReferenced: () => judge(), pause: async () => {} });
    const { path, slotId } = await quarantinedSlot(m, clone, sha, "task-last-owner", reason);
    write(path, ".env", "TOKEN=1\n");
    const before = snapshot(path, [".env", "keep.txt"]);
    const row = m.store.slot(slotId)!;
    assert.equal(row.activeLeaseId, null, "only the last-released identity names the owner");
    assert.ok(row.lastReleasedLeaseId);

    judge = ownerReferenced;
    await m.recoverQuarantines();
    assert.deepEqual(m.store.slot(slotId), row);
    assert.deepEqual(snapshot(path, [".env", "keep.txt"]), before);
    assert.match(m.recoveryRefusal(row)?.reason ?? "", refusal);
    assert.equal(m.recoveryRefusal(row)?.blocking, null);
  });
}

const INEXACT_REGISTRATIONS: Array<{
  name: string;
  arrange: (clone: string, path: string) => Promise<void>;
  refusal: RegExp;
}> = [
  {
    name: "locked",
    arrange: async (clone, path) => { gitIn(clone, "worktree", "lock", path); },
    refusal: /^slot has no safe Git worktree registration$/,
  },
  {
    name: "gone from Git's list",
    arrange: async (_clone, path) => { rmSync(dirname(await lockPath(path)), { recursive: true }); },
    refusal: /^the slot's work could not be read: /,
  },
];

for (const { name, arrange, refusal } of INEXACT_REGISTRATIONS) {
  test(`the automatic pass leaves a candidate whose registration is ${name} exactly as it was`, async () => {
    const { clone, sha } = repository("mission-recover-registration-");
    const m = manager();
    const { path, slotId } = await quarantinedSlot(m, clone, sha, "task-registration", "slot Git state is unknown");
    write(path, ".env", "TOKEN=1\n");
    const before = snapshot(path, [".env", "keep.txt", ".git"]);
    await arrange(clone, path);
    const row = m.store.slot(slotId)!;

    await m.recoverQuarantines();
    assert.deepEqual(m.store.slot(slotId), row);
    assert.deepEqual(snapshot(path, [".env", "keep.txt", ".git"]), before);
    assert.match(m.recoveryRefusal(row)?.reason ?? "", refusal);
  });
}

test("a quarantine index.lock did not cause leaves a lock alone, and a reset it refuses makes the slot lock-caused", async () => {
  const { clone, sha } = repository("mission-recover-other-lock-");
  const m = manager();
  const { path, slotId } = await quarantinedSlot(m, clone, sha, "task-other-lock", "slot Git state is unknown");
  const lock = await lockPath(path);
  writeFileSync(lock, "");

  await m.recoverQuarantines();
  assert.equal(existsSync(lock), true, "only a lock-caused quarantine ever removes a lock");
  const slot = m.store.slot(slotId)!;
  assert.equal(slot.state, "quarantined");
  assert.equal(lockCausedQuarantine(slot.lastError), true, "the next pass judges it as what it now is");
});

/** A default that discards an ignored entry, and what the entry and the refusal look like. */
const OVERWRITES: Array<{
  name: string;
  ignore: string;
  file: string;
  blocked: string;
  move: (origin: string) => void;
}> = [
  {
    name: "un-ignores .env",
    ignore: "node_modules/\n.env\n",
    file: ".env",
    blocked: ".env",
    move: (origin) => write(origin, ".gitignore", "node_modules/\n"),
  },
  {
    name: "tracks a path inside the ignored .idea/",
    ignore: "node_modules/\n.idea/\n",
    file: ".idea/workspace.xml",
    blocked: ".idea/",
    move: (origin) => write(origin, ".idea/codeStyles/Project.xml", "<code_scheme/>\n"),
  },
  {
    name: "tracks a differently cased .Idea/x over the ignored .idea/",
    ignore: "node_modules/\n.idea/\n",
    file: ".idea/workspace.xml",
    blocked: ".idea/",
    move: (origin) => write(origin, ".Idea/x", "shared\n"),
  },
  {
    name: "replaces an ignored file's parent directory with a tracked file",
    ignore: "node_modules/\napps/foo/.local/\n",
    file: "apps/foo/.local/notes.md",
    blocked: "apps/foo/.local/",
    move: (origin) => write(origin, "apps/foo/.local", "now a file\n"),
  },
  {
    name: "replaces an ignored file's parent directory with a tracked symlink",
    ignore: "node_modules/\napps/foo/.local/\n",
    file: "apps/foo/.local/notes.md",
    blocked: "apps/foo/.local/",
    move: (origin) => {
      mkdirSync(join(origin, "apps", "foo"), { recursive: true });
      symlinkSync("../shared", join(origin, "apps", "foo", ".local"));
    },
  },
];

function moveDefault(origin: string, move: (origin: string) => void): void {
  move(origin);
  gitIn(origin, "add", "-Af");
  gitIn(origin, "commit", "-qm", "the default moves");
}

for (const { name, ignore, file, blocked, move } of OVERWRITES) {
  test(`the automatic pass refuses, files unchanged, a default that ${name}`, async () => {
    const { origin, clone, sha } = repository("mission-recover-overwrite-", ignore);
    const m = manager();
    const { path, slotId } = await quarantinedSlot(m, clone, sha, "task-overwrite", "slot Git state is unknown");
    write(path, file, "precious\n");
    const before = snapshot(path, [file]);
    moveDefault(origin, move);
    const row = m.store.slot(slotId)!;

    await m.recoverQuarantines();
    assert.deepEqual(m.store.slot(slotId), row);
    assert.deepEqual(snapshot(path, [file]), before);
    assert.equal(gitIn(path, "rev-parse", "HEAD"), sha);
    assert.deepEqual(m.recoveryRefusal(row)?.blocking, { kind: "ignored", path: blocked });
  });

  test(`the automatic pass catches a default that ${name} between its check and the reset`, async () => {
    const { origin, clone, sha } = repository("mission-recover-moved-", ignore);
    let fetches = 0;
    let armed = false;
    class MovingDefaultGit extends NativeWorktreeGit {
      override async fetchDefaultSha(identity: Parameters<WorktreeGit["fetchDefaultSha"]>[0]): Promise<GitResult<string>> {
        // The first fetch is the check's. The second is the reset's own, after the check passed.
        if (armed && (fetches += 1) === 2) moveDefault(origin, move);
        return super.fetchDefaultSha(identity);
      }
    }
    const m = manager({ git: new MovingDefaultGit() });
    const { path, slotId } = await quarantinedSlot(m, clone, sha, "task-moved", "slot Git state is unknown");
    write(path, file, "precious\n");
    const before = snapshot(path, [file]);
    const row = m.store.slot(slotId)!;

    armed = true;
    await m.recoverQuarantines();
    assert.equal(fetches, 2, "the check passed, so the reset fetched");
    assert.deepEqual(m.store.slot(slotId), row);
    assert.deepEqual(snapshot(path, [file]), before);
    assert.equal(gitIn(path, "rev-parse", "HEAD"), sha);
    assert.deepEqual(m.recoveryRefusal(row)?.blocking, { kind: "ignored", path: blocked });
  });
}
