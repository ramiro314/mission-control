import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
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
import { quarantinedSlotProblems } from "../src/server/worktrees/storage-problems.ts";
import { describeWorktreeWork } from "../src/server/git/worktree-return-safety.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
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
function repository(prefix: string): { clone: string; sha: string } {
  const { origin, clone } = mkOriginAndClone(prefix);
  writeFileSync(join(origin, ".gitignore"), "node_modules/\n.env\n");
  gitIn(origin, "add", ".gitignore");
  gitIn(origin, "commit", "-qm", "ignore");
  gitIn(clone, "fetch", "-q", "origin");
  gitIn(clone, "reset", "-q", "--hard", "origin/main");
  return { clone, sha: gitIn(clone, "rev-parse", "HEAD") };
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
  await m.recoverLockQuarantines();
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
  await m.recoverLockQuarantines();
  assert.equal(m.store.slot(gone.slot.id)?.state, "available");
  assert.equal(m.recoveryRefusal(m.store.slot(gone.slot.id)!), null, "a recovered slot keeps no refusal");
  assert.equal(existsSync(join(gone.held.path, "node_modules", "cache.txt")), true);
  assert.equal(m.store.slot(fresh.slot.id)?.state, "quarantined");

  // Ten minutes on, nothing holds the fresh lock and no Git process uses the slot.
  now += INDEX_LOCK_STALE_MS + 1_000;
  await m.recoverLockQuarantines();
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
    {
      name: "a non-regenerable ignored file",
      blocking: { kind: "ignored", path: ".env" },
      plant: (path) => writeFileSync(join(path, ".env"), "TOKEN=1\n"),
      intact: (path) => existsSync(join(path, ".env")),
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

  await m.recoverLockQuarantines();
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

test("the automatic pass leaves a quarantine that index.lock did not cause", async () => {
  const { clone, sha } = repository("mission-recover-other-cause-");
  const m = manager();
  const held = await leased(m, clone, sha, "task-other-cause");
  m.store.quarantine(held.slotId, "slot process occupancy is unknown", "cwd listing failed: exit 1", Date.now(), held.slotVersion);
  await m.recoverLockQuarantines();
  assert.equal(m.store.slot(held.slotId)?.state, "quarantined");
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
  await m.recoverLockQuarantines();
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
    writeFileSync(join(path, ".env"), "TOKEN=1\n");
  });
  await m.recoverLockQuarantines();
  const judged = m.store.slot(slot.id)!;
  assert.deepEqual(m.recoveryRefusal(judged)?.blocking, { kind: "ignored", path: ".env" });

  // Still quarantined, but quarantined again: the version moved, so the old refusal no longer
  // describes it, and neither the manager nor the inventory shows it.
  const requarantined = m.store.quarantine(slot.id, "slot Git state is unknown", "git status timed out", Date.now(), judged.version);
  assert.ok(requarantined);
  assert.equal(requarantined.state, "quarantined");
  assert.equal(m.recoveryRefusal(requarantined), null);
  assert.equal((await inventorySlot(m, slot.id)).recoveryRefusal, null);
  assert.equal((await m.status()).flatMap((pool) => pool.slots).find((each) => each.slot.id === slot.id)?.recoveryRefusal, null);

  // A row carrying the judged version still matches the record, so the version alone retired it;
  // the next pass, for which this slot is no longer a candidate, then drops the record itself.
  assert.ok(m.recoveryRefusal(judged));
  await m.recoverLockQuarantines();
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
  await m.recoverLockQuarantines();
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

  await m.recoverLockQuarantines();
  assert.equal(lines().length, 2);
  assert.equal(
    lines()[1],
    `[worktrees] automatic recovery of clone slot 1 refused: index.lock is younger than 10 minutes (blocked by ${lock})`,
  );
  await m.recoverLockQuarantines();
  await m.recoverLockQuarantines();
  assert.equal(lines().length, 2, "the same refusal on later passes is not logged again");

  now += INDEX_LOCK_STALE_MS + 1_000;
  await m.recoverLockQuarantines();
  assert.equal(m.store.slot(slot.id)?.state, "available");
  assert.equal(lines().length, 3);
  assert.equal(
    lines()[2],
    `[worktrees] recovered clone slot 1 automatically from its quarantine (return reset failed), removing a stale ${lock}`,
  );
});
