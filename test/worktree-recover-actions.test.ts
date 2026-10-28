import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { openDb } from "../src/server/db.ts";
import { WorktreeManager, type NativeWorktreeLease } from "../src/server/worktrees/manager.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { slotGitDirectory } from "../src/server/worktrees/index-lock.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import type { WorktreeOccupancy, WorktreeOccupant } from "../src/server/worktrees/occupancy.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

const db = openDb();
let occupants: WorktreeOccupant[] = [];
let referenced = false;
const manager = new WorktreeManager(db, {
  occupancy: (paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> =>
    Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants }]))),
  ownerReferenced: async () => referenced,
  fileHolders: async () => [],
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
  assert.ok(preview.consequences.some((line) => line.startsWith("Discards the slot's work: checkout has uncommitted, untracked or ignored work.")));
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
