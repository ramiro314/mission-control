import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { Registry } from "../src/server/registry.ts";
import { ReviewManager } from "../src/server/reviews.ts";
import { TaskManager } from "../src/server/tasks.ts";
import { QueueManager } from "../src/server/queue.ts";
import { buildApp } from "../src/server/routes.ts";
import { WorktreeManager } from "../src/server/worktrees/manager.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import type { TerminalLaunchSpec } from "../src/server/terminal/targets.ts";
import type { TerminalBackendId } from "../src/shared/terminal.ts";
import { WorktreeActionRequestSchema } from "../src/shared/protocol.ts";
import { WORKTREE_INVENTORY_LIMITS } from "../src/shared/worktrees.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

const db = openDb();
const registry = new Registry();
const tasks = new TaskManager(registry);
const occupied = new Set<string>();
const manager = new WorktreeManager(db, {
  occupancy: (paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> =>
    Promise.resolve(new Map(paths.map((path) => [path, {
      status: "known",
      occupants: occupied.has(path)
        ? [{ pid: 4242, ppid: 1, startRaw: "s", startMs: 0, command: "node", cwd: path, knownOwner: null }]
        : [],
    }]))),
  resolvePolicy: () => ({ enabled: true, maxSlots: 2, setupArgv: null }),
});
const checks = new CheckLeaseManager(db, { manager, legacy: new LegacyTreehouseService(db) });
const operations = new WorktreeOperationsService(manager, {
  legacy: new LegacyTreehouseService(db),
  tasks: { get: () => null, reclaim: (id) => tasks.reclaim(id) },
  checks,
  checkRecovery: async () => "unknown",
  notifyChanged: () => registry.emitWorktreesChanged(),
  diskBytes: async () => 0,
});
const launched: TerminalLaunchSpec[] = [];
let launchError: string | null = null;
const launch = async (_backend: TerminalBackendId, spec: TerminalLaunchSpec) => {
  launched.push(spec);
  return launchError
    ? { ok: false, label: "Test terminal", homeName: null, status: 502, error: launchError }
    : { ok: true, label: "Test terminal", homeName: null, status: 200 };
};
const app = buildApp({
  registry,
  reviews: new ReviewManager(registry),
  tasks,
  queues: new QueueManager(registry),
  launchSessionTerminal: launch,
  worktrees: manager,
  worktreeOperations: operations,
});
const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

after(() => db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools; DELETE FROM app_config WHERE key = 'worktrees';"));

test("inventory/config routes are bounded, validated, future-only, and content-free invalidated", async () => {
  const { clone } = mkOriginAndClone("mission-worktree-route-");
  const acquired = await manager.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "manual", key: "manual-route" },
  });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;

  const inventory = await app.request("/api/worktrees", { headers: HEADERS });
  assert.equal(inventory.status, 200);
  const body = await inventory.json() as { repositories: Array<{ slots: Array<{ id: string }> }>; revision: string };
  assert.equal(body.repositories[0]?.slots[0]?.id, acquired.lease.slotId);
  assert.match(body.revision, /^[a-f0-9]{64}$/);

  const events: unknown[] = [];
  registry.subscribe((event) => events.push(event));
  const update = await app.request("/api/worktrees/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ maxSlots: 1, repositories: { [manager.store.pool(acquired.lease.poolId)!.gitCommonDirectory]: { setupArgv: ["npm", "install"] } } }),
  });
  assert.equal(update.status, 200);
  assert.equal(manager.store.slot(acquired.lease.slotId)?.state, "leased", "capacity reduction has no cleanup side effect");
  assert.deepEqual(events.at(-1), { type: "worktrees_changed" });

  const invalid = await app.request("/api/worktrees/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ maxSlots: 0 }),
  });
  assert.equal(invalid.status, 400);
});

test("preview/execute status vocabulary and injected terminal launcher stay exact", async () => {
  const inventory = await app.request("/api/worktrees", { headers: HEADERS });
  const body = await inventory.json() as { repositories: Array<{ slots: Array<{ id: string }> }> };
  const slotId = body.repositories[0]!.slots[0]!.id;

  const unknown = await app.request("/api/worktrees/actions/preview", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ action: "destroy", target: { kind: "slot", slotId: "missing" } }),
  });
  assert.equal(unknown.status, 404);

  const opened = await app.request(`/api/worktrees/${slotId}/open`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ backend: "wezterm" }),
  });
  assert.equal(opened.status, 200);
  assert.equal(launched.at(-1)?.cwd, await operations.slotPath(slotId));
  assert.deepEqual(launched.at(-1)?.argv.slice(-1), ["-l"]);

  const expired = await app.request("/api/worktrees/actions/execute", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ token: "00000000-0000-4000-8000-000000000000", acknowledgements: [] }),
  });
  assert.equal(expired.status, 409);

  // A valid Execute answers 202 as soon as the token is claimed; the work finishes behind it.
  const preview = await app.request("/api/worktrees/actions/preview", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ action: "return", slotId }),
  });
  assert.equal(preview.status, 200);
  const { token } = await preview.json() as { token: string };
  const accepted = await app.request("/api/worktrees/actions/execute", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ token, acknowledgements: [] }),
  });
  assert.equal(accepted.status, 202);
  const submitted = await accepted.json() as { operation: { id: string; state: string; request: { action: string } } };
  assert.equal(submitted.operation.state, "queued");
  assert.equal(submitted.operation.request.action, "return");
  await operations.idle();

  const dismissed = await app.request(`/api/worktrees/operations/${submitted.operation.id}/dismiss`, {
    method: "POST",
    headers: HEADERS,
    body: "{}",
  });
  assert.equal(dismissed.status, 404, "a finished operation leaves nothing to dismiss");
});

test("Open terminal leases an idle available slot as it stands, and refuses one that is not idle", async () => {
  const { clone } = mkOriginAndClone("mission-worktree-open-");
  appendFileSync(join(clone, ".git/info/exclude"), "local-cache/\n");
  const head = gitIn(clone, "rev-parse", "HEAD");
  const acquired = await manager.acquire({ repositoryPath: clone, baseSha: head, owner: { kind: "manual", key: "open-route" } });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  const { slotId, path } = acquired.lease;
  const open = () => app.request(`/api/worktrees/${slotId}/open`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ backend: "wezterm" }),
  });
  const hand = async (leaseId: string) => {
    const returned = await app.request("/api/worktrees/manual/return", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ leaseId }),
    });
    assert.equal(returned.status, 200);
  };
  await hand(acquired.lease.leaseId);
  const row = () => manager.store.slot(slotId)!;
  assert.equal(row().state, "available");

  // Idle: leased with nothing touched. An ignored file proves the reset really did not run.
  mkdirSync(join(path, "local-cache"));
  writeFileSync(join(path, "local-cache/warm"), "kept\n");
  const before = statSync(join(path, "local-cache/warm")).ino;
  const launches = launched.length;
  assert.equal((await open()).status, 200);
  assert.equal(launched.length, launches + 1);
  assert.equal(launched.at(-1)?.cwd, path);
  assert.equal(row().state, "leased");
  assert.equal(row().activeOwnerKind, "manual");
  assert.match(row().activeOwnerKey ?? "", /^terminal-/);
  assert.equal(row().currentHeadSha, head);
  assert.equal(gitIn(path, "rev-parse", "HEAD"), head);
  assert.equal(gitIn(path, "status", "--porcelain"), "");
  assert.equal(statSync(join(path, "local-cache/warm")).ino, before);

  const inventory = await (await app.request("/api/worktrees", { headers: HEADERS })).json() as {
    repositories: Array<{ slots: Array<{ id: string; actions: string[]; owner: { kind: string; label: string } | null }> }>;
  };
  const card = inventory.repositories.flatMap((pool) => pool.slots).find((slot) => slot.id === slotId)!;
  assert.deepEqual(card.owner && { kind: card.owner.kind, label: card.owner.label }, {
    kind: "manual",
    label: "Terminal from Settings",
  });
  assert.ok(card.actions.includes("return"));

  // Leased: a shell opens and the lease stays the one it was.
  const leaseId = row().activeLeaseId!;
  assert.equal((await open()).status, 200);
  assert.equal(launched.length, launches + 2);
  assert.equal(row().activeLeaseId, leaseId);
  await hand(leaseId);

  // Two clicks at once take one lease between them.
  const both = await Promise.all([open(), open()]);
  assert.deepEqual(both.map((response) => response.status), [200, 200]);
  assert.equal(row().state, "leased");
  await hand(row().activeLeaseId!);

  // Occupied: refused with acquisition's reason, nothing opened, and still available.
  occupied.add(path);
  const launchesBefore = launched.length;
  const busy = await open();
  occupied.delete(path);
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { error: "the slot is not idle: an available slot has process occupancy" });
  assert.equal(row().state, "available");
  assert.equal(row().activeLeaseId, null);

  // Mid-reservation: neither available nor held by an owner, so it is refused without a shell.
  const reserved = manager.store.reserveAvailable({
    slotId,
    version: row().version,
    leaseId: "reserved",
    ownerKind: "manual",
    ownerKey: "reserved",
    requestedHeadSha: head,
    now: Date.now(),
  })!;
  const provisioning = await open();
  assert.equal(provisioning.status, 409);
  assert.deepEqual(await provisioning.json(), { error: "the slot is provisioning" });
  manager.store.releaseReservation({
    slotId,
    version: reserved.version,
    leaseId: "reserved",
    requestedHeadSha: head,
    lastError: null,
    now: Date.now(),
  });

  // Attached to a branch: no reset would repair it, so it is not leased as it stands.
  gitIn(path, "checkout", "-qb", "left-attached");
  const attached = await open();
  assert.equal(attached.status, 409);
  assert.match((await attached.json() as { error: string }).error, /attached to a branch/);
  assert.equal(row().state, "available");
  gitIn(path, "checkout", "-q", "--detach");
  gitIn(path, "branch", "-qD", "left-attached");

  // A launcher that failed may still have opened a shell, so the lease stands and says so.
  launchError = "terminal did not answer";
  const failed = await open();
  launchError = null;
  assert.equal(failed.status, 502);
  assert.equal(
    (await failed.json() as { error: string }).error,
    "terminal did not answer. The slot stays leased, so Return it from its card.",
  );
  assert.equal(row().state, "leased");
  await hand(row().activeLeaseId!);

  // Dirty: a proven fault, quarantined as acquisition would. A quarantined slot then still opens.
  writeFileSync(join(path, "stray.txt"), "work\n");
  const dirty = await open();
  assert.equal(dirty.status, 409);
  assert.match((await dirty.json() as { error: string }).error, /^the slot was quarantined: available slot has dirty/);
  assert.equal(launched.length, launchesBefore + 1, "only the failed launcher's attempt reached the launcher");
  assert.equal(row().state, "quarantined");
  assert.equal((await open()).status, 200);
  assert.equal(row().state, "quarantined");
  assert.equal(row().activeLeaseId, null);
});

test("a bulk destroy selection accepts up to the bulk limit and rejects one more", async () => {
  assert.equal(WORKTREE_INVENTORY_LIMITS.bulkSlots, 128);
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `slot-${index}`);
  const body = (count: number) => ({ action: "destroy", target: { kind: "slots", slotIds: ids(count) } });

  assert.equal(WorktreeActionRequestSchema.safeParse(body(1)).success, true);
  assert.equal(WorktreeActionRequestSchema.safeParse(body(128)).success, true);
  assert.equal(WorktreeActionRequestSchema.safeParse(body(129)).success, false);
  assert.equal(WorktreeActionRequestSchema.safeParse(body(0)).success, false);

  const preview = (count: number) => app.request("/api/worktrees/actions/preview", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body(count)),
  });
  // 128 unknown ids pass validation and reach the service, which answers with a blocked
  // preview naming the lost selection rather than a 404.
  const accepted = await preview(128);
  assert.equal(accepted.status, 200);
  const blocked = await accepted.json() as { allowed: boolean; blockers: string[] };
  assert.equal(blocked.allowed, false);
  assert.match(blocked.blockers.join("\n"), /128 selected slots no longer exist/);
  // 129 is refused at the boundary, before any observation runs.
  assert.equal((await preview(129)).status, 400);
  assert.equal((await preview(0)).status, 400);
});

test("worktree routes fail with 503 when the singleton operation service is absent", async () => {
  const bare = buildApp({
    registry,
    reviews: new ReviewManager(registry),
    tasks,
    queues: new QueueManager(registry),
  });
  assert.equal((await bare.request("/api/worktrees", { headers: HEADERS })).status, 503);
});

test("legacy observation changes invalidate once and unexpected outages stay explicit", async () => {
  let version = "v2.1.1";
  let unavailable = false;
  const legacy = {
    capabilities: async () => ({ kind: "conditional-json" as const, version }),
    inventory: async () => {
      if (unavailable) throw new Error("provider read failed");
      return [];
    },
  } as unknown as LegacyTreehouseService;
  const events: unknown[] = [];
  const observer = new WorktreeOperationsService(manager, {
    legacy,
    tasks: { get: () => null, reclaim: (id) => tasks.reclaim(id) },
    checks,
    checkRecovery: async () => "unknown",
    notifyChanged: () => events.push({ type: "worktrees_changed" }),
    diskBytes: async () => 0,
  });
  await observer.inventory();
  await observer.inventory();
  assert.deepEqual(events, [], "restating the same legacy view emits nothing");
  version = "v2.2.0";
  await observer.inventory();
  assert.deepEqual(events, [{ type: "worktrees_changed" }]);
  unavailable = true;
  await assert.rejects(
    observer.inventory(),
    (error: unknown) => error instanceof Error && /legacy worktree inventory unavailable/.test(error.message),
  );
});

test("Stop reaches a running claim through the claim registry, by slot and claim id only", async () => {
  const control = manager.claims.register("slot-claiming", { kind: "task", key: "task-stop-route:0" }, 0)!;
  const claimId = manager.claims.get("slot-claiming")!.id;
  const stop = (slotId: string, body: unknown) => app.request(`/api/worktrees/${slotId}/claim/stop`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await stop("slot-claiming", {})).status, 400, "the claim id is required");
    assert.equal((await stop("slot-claiming", { claimId, extra: true })).status, 400, "the body is strict");
    const stale = await stop("slot-claiming", { claimId: "another-claim" });
    assert.equal(stale.status, 404);
    assert.deepEqual(await stale.json(), { error: "that dependency claim is no longer running" });
    assert.equal((await stop("another-slot", { claimId })).status, 404);
    assert.equal(control.signal.aborted, false, "no refused Stop touched the claim");

    const stopped = await stop("slot-claiming", { claimId });
    assert.equal(stopped.status, 200);
    assert.deepEqual(await stopped.json(), { ok: true });
    assert.equal(control.signal.aborted, true);
  } finally {
    manager.claims.unregister("slot-claiming", control);
  }
  assert.equal((await stop("slot-claiming", { claimId })).status, 404, "a finished claim cannot be stopped");
});
