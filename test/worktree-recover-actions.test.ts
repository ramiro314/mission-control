import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { openDb } from "../src/server/db.ts";
import { WorktreeManager, type NativeWorktreeLease } from "../src/server/worktrees/manager.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { slotGitDirectory } from "../src/server/worktrees/index-lock.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import type { WorktreeOccupancy, WorktreeOccupant } from "../src/server/worktrees/occupancy.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import { RESET_WORK_LIMIT, worktreeResetWorkKey } from "../src/server/git/worktree-return-safety.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

const db = openDb();
let occupants: WorktreeOccupant[] = [];
let referenced = false;
/** One answer per lock inspection, in order; none left means nothing holds the lock. */
let lockHolders: number[][] = [];
const manager = new WorktreeManager(db, {
  occupancy: (paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> =>
    Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants }]))),
  ownerReferenced: async () => referenced,
  fileHolders: async () => lockHolders.shift() ?? [],
  resolvePolicy: () => ({ enabled: true, maxSlots: 2, setupArgv: null }),
});
const operations = new WorktreeOperationsService(manager, {
  legacy: new LegacyTreehouseService(db),
  tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
  checks: new CheckLeaseManager(db, { manager, legacy: new LegacyTreehouseService(db) }),
  checkRecovery: async () => "unknown",
  notifyChanged: () => {},
  diskBytes: async () => 1024,
});

after(() => db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools; DELETE FROM app_config WHERE key = 'worktrees';"));

async function slotActions(slotId: string) {
  const inventory = await operations.inventory();
  return inventory.repositories.flatMap((repo) => repo.slots).find((slot) => slot.id === slotId)?.actions;
}

test("Recover is offered on an unowned quarantine and its preview names the lock, a Git process and the discard", async () => {
  const { clone } = mkOriginAndClone("mission-recover-preview-");
  const acquired = await manager.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "task", key: "task-recover-preview:0" },
  });
  assert.equal(acquired.outcome, "acquired");
  const lease = (acquired as { lease: NativeWorktreeLease }).lease;
  const common = gitIn(lease.path, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const lock = join((await slotGitDirectory(lease.path, common))!, "index.lock");
  writeFileSync(lock, "");
  assert.equal((await manager.release(lease, { ownerAuthorized: true })).outcome, "outcomeUnknown");
  assert.equal(manager.store.slot(lease.slotId)?.state, "quarantined");

  // Its task still references it: the owner's Return is the way out, not Recover.
  referenced = true;
  assert.equal((await slotActions(lease.slotId))?.includes("recover"), false);
  const owned = await operations.preview({ action: "recover", slotId: lease.slotId });
  assert.equal(owned.allowed, false);
  assert.ok(owned.blockers.some((blocker) => /A live owner still references slot/.test(blocker)), owned.blockers.join("; "));
  referenced = false;
  assert.equal((await slotActions(lease.slotId))?.includes("recover"), true);

  occupants = [{
    pid: 4242,
    ppid: 1,
    startRaw: "Mon Oct 26 09:00:00 2026",
    startMs: 0,
    command: `git -C ${lease.path} status`,
    cwd: lease.path,
    knownOwner: null,
  }];
  const busy = await operations.preview({ action: "recover", slotId: lease.slotId });
  assert.equal(busy.allowed, false);
  assert.ok(busy.consequences.includes(`Git process 4242 is using the worktree: git -C ${lease.path} status`));
  assert.ok(busy.blockers.some((blocker) => /index\.lock cannot be removed: a Git process is using the worktree/.test(blocker)));
  occupants = [];

  const scratch = join(lease.path, "notes.md");
  writeFileSync(scratch, "draft\n");
  const preview = await operations.preview({ action: "recover", slotId: lease.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.deepEqual(preview.requiredAcknowledgements, ["dirty"]);
  assert.ok(preview.consequences.includes(`Removes the stale lock ${lock}.`), preview.consequences.join("\n"));
  assert.ok(preview.consequences.includes("Discards the slot's work: untracked notes.md."), preview.consequences.join("\n"));
  await assert.rejects(operations.execute(preview.token, []), /missing acknowledgement: dirty/);

  const accepted = await operations.preview({ action: "recover", slotId: lease.slotId });
  assert.deepEqual(await operations.execute(accepted.token, ["dirty"]), {
    ok: true,
    action: "recover",
    message: "Quarantined worktree recovered to warm capacity.",
  });
  assert.equal(manager.store.slot(lease.slotId)?.state, "available");
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(scratch), false, "the acknowledged work was discarded by the reset");
  assert.equal((await slotActions(lease.slotId))?.includes("recover"), false);
});

const IGNORE = ".yarn/install-state.gz\n.idea/\n*.tsbuildinfo\n.env\n.evidence/\nnode_modules/\n.local/\n";
const KEPT = [".yarn/install-state.gz", ".idea/workspace.xml", "apps/web/tsconfig.tsbuildinfo", ".env", ".evidence/shot.png", "node_modules/pkg/index.js", "apps/foo/.local/notes.md"];

/**
 * A slot quarantined by a stale `index.lock` with no live owner, whose origin ignores what a
 * uwf slot holds, and which holds each of those ignored files. `advance` moves origin's
 * default: each value is a file's content, a symlink's target, or null to delete it.
 */
async function quarantinedSlot(prefix: string) {
  const { root, origin, clone } = mkOriginAndClone(prefix);
  after(() => rmSync(root, { recursive: true, force: true }));
  const advance = (changes: Record<string, string | { symlink: string } | null>) => {
    for (const [file, content] of Object.entries(changes)) {
      const full = join(origin, file);
      rmSync(full, { recursive: true, force: true });
      if (content === null) continue;
      mkdirSync(join(full, ".."), { recursive: true });
      if (typeof content === "string") writeFileSync(full, content);
      else symlinkSync(content.symlink, full);
    }
    gitIn(origin, "add", "-A", "-f");
    gitIn(origin, "commit", "-qm", "advance");
  };
  advance({ ".gitignore": IGNORE });
  gitIn(clone, "fetch", "-q", "origin");
  const acquired = await manager.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "origin/main"),
    owner: { kind: "task", key: `${prefix}:0` },
  });
  assert.equal(acquired.outcome, "acquired");
  const lease = (acquired as { lease: NativeWorktreeLease }).lease;
  const common = gitIn(lease.path, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const lock = join((await slotGitDirectory(lease.path, common))!, "index.lock");
  writeFileSync(lock, "");
  assert.equal((await manager.release(lease, { ownerAuthorized: true })).outcome, "outcomeUnknown");
  assert.equal(manager.store.slot(lease.slotId)?.state, "quarantined");
  for (const file of KEPT) {
    mkdirSync(join(lease.path, file, ".."), { recursive: true });
    writeFileSync(join(lease.path, file), "local\n");
  }
  return { lease, advance, clone, lock };
}

test("Recover keeps a warm install: ignored files the default keeps ignored ask no acknowledgement and keep their inodes", async () => {
  const { lease } = await quarantinedSlot("mission-recover-warm-");
  const inodes = new Map(KEPT.map((file) => [file, statSync(join(lease.path, file)).ino]));
  const preview = await operations.preview({ action: "recover", slotId: lease.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.deepEqual(preview.requiredAcknowledgements, []);
  assert.ok(!preview.consequences.some((line) => line.startsWith("Discards")), preview.consequences.join("\n"));
  assert.ok(preview.consequences.includes(
    "Keeps every ignored file the remote default still ignores and does not track, such as node_modules/ and .yarn/install-state.gz.",
  ));
  assert.equal((await operations.execute(preview.token, [])).ok, true);
  assert.equal(manager.store.slot(lease.slotId)?.state, "available");
  for (const [file, inode] of inodes) assert.equal(statSync(join(lease.path, file)).ino, inode, `${file} kept its inode`);
});

test("Recover asks for acknowledgement only for reset-rule work, and names each entry", async () => {
  const cases: Array<{ name: string; changes: Record<string, string | { symlink: string } | null>; named: string }> = [
    {
      name: "a default that un-ignores .env",
      changes: { ".gitignore": IGNORE.replace(".env\n", "") },
      named: "ignored .env (the target's .gitignore files no longer ignore it)",
    },
    {
      name: "a default that tracks a file inside the ignored .idea/",
      changes: { ".idea/codeStyles/Project.xml": "<x/>\n" },
      named: "ignored .idea/ (the target tracks .idea/codeStyles/Project.xml)",
    },
    {
      name: "a default that replaces an ignored file's parent directory with a tracked file",
      changes: { "apps/foo/.local": "file\n" },
      named: "ignored apps/foo/.local/ (the target tracks apps/foo/.local)",
    },
    {
      name: "a default that replaces an ignored file's parent directory with a tracked symlink",
      changes: { "apps/foo/.local": { symlink: "../elsewhere" } },
      named: "ignored apps/foo/.local/ (the target tracks apps/foo/.local)",
    },
    {
      name: "a default that tracks a differently cased path over the ignored .idea/",
      changes: { ".Idea/x": "x\n" },
      named: "ignored .idea/ (the target tracks .Idea/x)",
    },
  ];
  for (const [index, each] of cases.entries()) {
    const { lease, advance } = await quarantinedSlot(`mission-recover-named-${index}-`);
    advance(each.changes);
    const preview = await operations.preview({ action: "recover", slotId: lease.slotId });
    assert.equal(preview.allowed, true, `${each.name}: ${preview.blockers.join("; ")}`);
    assert.deepEqual(preview.requiredAcknowledgements, ["dirty"], each.name);
    assert.ok(preview.consequences.includes(`Discards the slot's work: ${each.named}.`), `${each.name}:\n${preview.consequences.join("\n")}`);
    await assert.rejects(operations.execute(preview.token, []), /missing acknowledgement: dirty/, each.name);
    assert.equal(manager.store.slot(lease.slotId)?.state, "quarantined", each.name);
  }
});

test("Recover's execute refuses when the default moved to a target whose work set differs from the preview's", async () => {
  const { lease, advance, lock } = await quarantinedSlot("mission-recover-moved-");
  const preview = await operations.preview({ action: "recover", slotId: lease.slotId });
  assert.deepEqual(preview.requiredAcknowledgements, []);
  // The default moves after the preview: execute's own rebuild sees the new work and refuses.
  advance({ ".gitignore": IGNORE.replace(".env\n", "") });
  await assert.rejects(operations.execute(preview.token, []), /changed after preview/);
  assert.equal(manager.store.slot(lease.slotId)?.state, "quarantined");
  assert.ok(existsSync(join(lease.path, ".env")));

  // The default moves after that rebuild, between its fetch and the reset's: the reset
  // compares the preview's set with the one at the target it fetched, and refuses.
  const slot = manager.store.slot(lease.slotId)!;
  const refused = await manager.recoverSlot({
    slotId: lease.slotId,
    expectedVersion: slot.version,
    allowDirty: false,
    automatic: false,
    expectedWork: worktreeResetWorkKey({ status: "clean" }),
  });
  assert.equal(refused.outcome, "refused");
  assert.match((refused as { reason: string }).reason, /the slot's work changed since the preview/);
  assert.equal(manager.store.slot(lease.slotId)?.state, "quarantined");
  assert.ok(existsSync(join(lease.path, ".env")), "nothing was discarded");
  assert.ok(existsSync(lock), "a refused Recover leaves the lock where it was");

  // Unacknowledged work refuses the same way, naming the entry and keeping the lock.
  const unacknowledged = await manager.recoverSlot({
    slotId: lease.slotId,
    expectedVersion: slot.version,
    allowDirty: false,
    automatic: false,
  });
  assert.deepEqual(unacknowledged, {
    outcome: "refused",
    reason: "the slot holds work Recover would discard: ignored .env (the target's .gitignore files no longer ignore it)",
    blocking: { kind: "ignored", path: ".env" },
  });
  assert.ok(existsSync(lock), "a refused Recover leaves the lock where it was");

  // A moved default whose work set is the preview's goes ahead.
  advance({ "src/unrelated.ts": "export {};\n" });
  const acknowledged = await operations.preview({ action: "recover", slotId: lease.slotId });
  assert.deepEqual(acknowledged.requiredAcknowledgements, ["dirty"]);
  const previewed = worktreeResetWorkKey(await manager.slotResetWork(manager.store.slot(lease.slotId)!));
  advance({ "src/another.ts": "export {};\n" });
  const recovered = await manager.recoverSlot({
    slotId: lease.slotId,
    expectedVersion: manager.store.slot(lease.slotId)!.version,
    allowDirty: true,
    automatic: false,
    expectedWork: previewed,
  });
  assert.deepEqual(recovered, { outcome: "recovered", removedLock: lock });
  assert.equal(existsSync(lock), false, "the lock goes once nothing refuses");
  assert.equal(existsSync(join(lease.path, ".env")), false, "the acknowledged .env was discarded");
  assert.ok(existsSync(join(lease.path, "node_modules/pkg/index.js")), "the install was kept");
});

test("Recover's execute hands the preview's work set to the reset, which refuses a default that moved after execute's own check", async () => {
  const { lease, advance, lock } = await quarantinedSlot("mission-recover-handoff-");
  advance({ ".gitignore": IGNORE.replace(".env\n", "") });
  const preview = await operations.preview({ action: "recover", slotId: lease.slotId });
  assert.deepEqual(preview.requiredAcknowledgements, ["dirty"]);
  assert.ok(preview.consequences.includes("Discards the slot's work: ignored .env (the target's .gitignore files no longer ignore it)."));

  const previewed = worktreeResetWorkKey(await manager.slotResetWork(manager.store.slot(lease.slotId)!));
  // The default moves once execute has rebuilt the preview, before the reset fetches its target:
  // .env is ignored again, so the reset would discard nothing the operator acknowledged.
  const original = manager.recoverSlot.bind(manager);
  const received: Array<string | undefined> = [];
  manager.recoverSlot = async (input) => {
    received.push(input.expectedWork);
    advance({ ".gitignore": IGNORE });
    return original(input);
  };
  try {
    await assert.rejects(operations.execute(preview.token, ["dirty"]), /the slot's work changed since the preview/);
  } finally {
    manager.recoverSlot = original;
  }
  assert.deepEqual(received, [previewed]);
  assert.equal(manager.store.slot(lease.slotId)?.state, "quarantined");
  assert.ok(existsSync(join(lease.path, ".env")), "nothing was discarded");
  assert.ok(existsSync(lock), "a refused Recover leaves the lock where it was");
});

test("Recover's preview offers an unreadable slot's discard for acknowledgement, naming why its work could not be read", async () => {
  const { lease, clone } = await quarantinedSlot("mission-recover-unread-");
  gitIn(clone, "remote", "set-url", "origin", join(clone, "..", "missing-origin"));
  const preview = await operations.preview({ action: "recover", slotId: lease.slotId });
  assert.ok(preview.requiredAcknowledgements.includes("dirty"), preview.requiredAcknowledgements.join(", "));
  assert.ok(preview.risks.some((entry) => entry.label === "The slot's work could not be read, and whatever it holds will be discarded"));
  assert.ok(
    preview.consequences.some((line) => line.startsWith("Discards whatever the slot holds: its work could not be read (origin's default could not be fetched:")),
    preview.consequences.join("\n"),
  );
});

test("Recover's preview names the first entries of a large work set and says there are more", async () => {
  const { lease } = await quarantinedSlot("mission-recover-many-");
  for (let index = 0; index <= RESET_WORK_LIMIT; index += 1) {
    writeFileSync(join(lease.path, `draft-${String(index).padStart(2, "0")}.md`), "draft\n");
  }
  const preview = await operations.preview({ action: "recover", slotId: lease.slotId });
  const line = preview.consequences.find((entry) => entry.startsWith("Discards the slot's work:"));
  assert.ok(line?.endsWith("untracked draft-19.md; and more."), line);
  assert.equal(line?.includes("draft-20.md"), false);
});

test("Recover judges index.lock again after the fetch, and refuses a holder that appeared meanwhile", async () => {
  const { lease, lock } = await quarantinedSlot("mission-recover-lock-fresh-");
  // The first check, before the fetch, finds nothing holding the lock. The one after it does.
  lockHolders = [[], [4242]];
  const refused = await manager.recoverSlot({ slotId: lease.slotId, allowDirty: true, automatic: false });
  lockHolders = [];
  assert.deepEqual(refused, {
    outcome: "refused",
    reason: "index.lock is held open by pid 4242",
    blocking: { kind: "lock", path: lock },
  });
  assert.ok(existsSync(lock), "a lock with a holder is never removed");
  assert.equal(manager.store.slot(lease.slotId)?.state, "quarantined");
  assert.ok(existsSync(join(lease.path, ".env")), "nothing was discarded");
});
