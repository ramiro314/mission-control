import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openDb } from "../src/server/db.ts";
import { Registry } from "../src/server/registry.ts";
import { ReviewManager } from "../src/server/reviews.ts";
import { TaskManager } from "../src/server/tasks.ts";
import { QueueManager } from "../src/server/queue.ts";
import { buildApp } from "../src/server/routes.ts";
import { NativeWorktreeGit } from "../src/server/worktrees/git.ts";
import { LeaseActivityObserver } from "../src/server/worktrees/lease-activity.ts";
import { WorktreeManager } from "../src/server/worktrees/manager.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import { nativeWorktreeOwnerReferenced } from "../src/server/worktrees/owners.ts";
import { OBSERVATION_FAILURE, RESERVATION_NOT_HANDED_BACK } from "../src/server/worktrees/quarantine-reasons.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import type { TerminalLaunchSpec } from "../src/server/terminal/targets.ts";
import type { TerminalBackendId } from "../src/shared/terminal.ts";
import { WorktreeActionRequestSchema, WorktreeClaimSchema, type WorktreeClaim } from "../src/shared/protocol.ts";
import type { WorktreeLeaseActivity } from "../src/shared/storage-health.ts";
import { WORKTREE_INVENTORY_LIMITS, type WorktreeInventory } from "../src/shared/worktrees.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

const db = openDb();
const registry = new Registry();
const tasks = new TaskManager(registry);
const occupied = new Set<string>();
const occupant = (path: string) =>
  ({ pid: 4242, ppid: 1, startRaw: "s", startMs: 0, command: "node", cwd: path, knownOwner: null });
/** Answers occupancy reads in order ahead of `occupied`, to stage a change between two reads. */
const occupancyReads: Array<WorktreeOccupancy | null> = [];
let poolClaim: WorktreeClaim | undefined;
const manager = new WorktreeManager(db, {
  occupancy: (paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> =>
    Promise.resolve(new Map(paths.map((path) => [path, occupancyReads.shift() ?? {
      status: "known",
      occupants: occupied.has(path) ? [occupant(path)] : [],
    }]))),
  resolvePolicy: () => ({ enabled: true, maxSlots: 2, setupArgv: null, ...(poolClaim ? { claim: poolClaim } : {}) }),
  ownerReferenced: async (reference) => nativeWorktreeOwnerReferenced(reference, db),
});
// The stale chip's real source, wired as the daemon wires it, with a clock the test can move.
let leaseClock = Date.now();
let leaseClocks: WorktreeLeaseActivity = {};
const leaseActivity = new LeaseActivityObserver({
  slots: () => manager.store.slots(),
  ownerLive: (reference) => nativeWorktreeOwnerReferenced(reference, db),
  staleLeaseDays: () => 7,
  now: () => leaseClock,
  read: () => leaseClocks,
  write: (record) => { leaseClocks = record; },
});
const checks = new CheckLeaseManager(db, { manager, legacy: new LegacyTreehouseService(db) });
const operations = new WorktreeOperationsService(manager, {
  legacy: new LegacyTreehouseService(db),
  tasks: { get: () => null, reclaim: (id) => tasks.reclaim(id) },
  checks,
  checkRecovery: async () => "unknown",
  notifyChanged: () => registry.emitWorktreesChanged(),
  diskBytes: async () => 0,
  staleLeases: () => leaseActivity.staleSinceBySlot(),
});
const launched: TerminalLaunchSpec[] = [];
let launchError: string | null = null;
/** Set to run what the route asked for as a real process and wait for it, as a closed terminal ends. */
let shellExits: Array<number | null> | null = null;
const launch = async (_backend: TerminalBackendId, spec: TerminalLaunchSpec) => {
  launched.push(spec);
  if (shellExits) {
    const shell = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, stdio: "ignore" });
    const [code] = await once(shell, "exit") as [number | null];
    shellExits.push(code);
  }
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

const openSlot = (slotId: string) => app.request(`/api/worktrees/${slotId}/open`, {
  method: "POST",
  headers: HEADERS,
  body: JSON.stringify({ backend: "wezterm" }),
});

async function hand(leaseId: string): Promise<void> {
  const returned = await app.request("/api/worktrees/manual/return", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ leaseId }),
  });
  assert.equal(returned.status, 200);
}

async function waitUntil(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, "timed out waiting for the claim step to start");
    await sleep(20);
  }
}

/** A slot in a pool of its own, leased once and handed back, so it is idle and available. */
async function availableSlot() {
  const { clone } = mkOriginAndClone("mission-worktree-open-");
  const head = gitIn(clone, "rev-parse", "HEAD");
  const acquired = await manager.acquire({
    repositoryPath: clone,
    baseSha: head,
    owner: { kind: "manual", key: "open-route" },
  });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") throw new Error("the slot could not be acquired");
  await hand(acquired.lease.leaseId);
  const { slotId, path, poolId } = acquired.lease;
  return { clone, head, slotId, path, poolId, open: () => openSlot(slotId), row: () => manager.store.slot(slotId)! };
}

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
  const { clone, head, slotId, path, open, row } = await availableSlot();
  appendFileSync(join(clone, ".git/info/exclude"), "local-cache/\n");
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

test("Open terminal runs no claim on a slot whose next claim would really run", async () => {
  const ran = join(mkdtempSync(join(tmpdir(), "mission-worktree-open-claim-")), "ran");
  // Configured only now, so the slot has no fingerprint that would let a claim skip its step.
  const { clone, head, slotId, open, row } = await availableSlot();
  poolClaim = WorktreeClaimSchema.parse({
    steps: [{ argv: [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(ran)}, "ran\\n")`] }],
  });
  try {
    const dependencies = () => {
      const { depsState, depsFingerprint, depsFingerprintSha, depsClaimedAt, depsLastError } = row();
      return { depsState, depsFingerprint, depsFingerprintSha, depsClaimedAt, depsLastError };
    };
    const before = dependencies();
    assert.equal(before.depsState, null);

    assert.equal((await open()).status, 200);
    assert.equal(row().state, "leased");
    assert.equal(existsSync(ran), false, "the step did not run");
    assert.deepEqual(dependencies(), before);

    // The control: this same slot, handed back, does run the step for a lease that asks for it.
    await hand(row().activeLeaseId!);
    const claimed = await manager.acquire({
      repositoryPath: clone,
      baseSha: head,
      owner: { kind: "manual", key: "claim-control" },
      runClaim: true,
    });
    assert.equal(claimed.outcome, "acquired");
    assert.equal(row().id, slotId);
    assert.equal(readFileSync(ran, "utf8"), "ran\n");
    assert.notEqual(row().depsState, null);
  } finally {
    poolClaim = undefined;
  }
});

test("Open terminal answers at once while a running claim holds the slot lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-worktree-open-held-"));
  const started = join(dir, "started");
  const release = join(dir, "release");
  // Bounded by its own exit as well, so a test that fails before releasing it leaks no process.
  const step = `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(started)}, "");
    setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 20);
    setTimeout(() => process.exit(1), 60_000);
  `;
  poolClaim = WorktreeClaimSchema.parse({ steps: [{ argv: [process.execPath, "-e", step] }] });
  const { clone } = mkOriginAndClone("mission-worktree-open-");
  const ownerKey = "claim-holds-the-lock";
  const acquisition = manager.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "manual", key: ownerKey },
    runClaim: true,
  });
  try {
    await waitUntil(() => existsSync(started));
    const { id: slotId } = db
      .prepare("SELECT id FROM worktree_slots WHERE active_owner_key = ? AND state = 'provisioning'")
      .get(ownerKey) as { id: string };
    const launches = launched.length;
    // Not awaited on its own: a request queued on the lock would wait out the step this test holds.
    let timer: NodeJS.Timeout | undefined;
    const answer = await Promise.race([
      openSlot(slotId),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 10_000); }),
    ]);
    clearTimeout(timer);
    assert.ok(answer, "the request answered while the claim still held the slot lock");
    assert.equal(answer.status, 409);
    assert.deepEqual(await answer.json(), { error: "the slot is provisioning" });
    assert.equal(launched.length, launches);
    assert.equal(manager.store.slot(slotId)?.activeOwnerKey, ownerKey, "the claim's reservation is untouched");
    assert.equal(existsSync(release), false, "the step was still running when the route answered");
  } finally {
    writeFileSync(release, "");
    poolClaim = undefined;
  }
  assert.equal((await acquisition).outcome, "acquired");
});

type Slot = Awaited<ReturnType<typeof availableSlot>>;

/** Each stages one way `leaseAsIs` ends with no lease, and what the route must then answer. */
const NO_LEASE_CASES: Array<{
  name: string;
  stage: (t: TestContext, slot: Slot) => void;
  status: number;
  error: string | RegExp;
  state: "available" | "quarantined";
  quarantineReason?: string;
}> = [
  {
    name: "a process enters after the screening",
    stage: (_t, slot) => occupancyReads.push(null, { status: "known", occupants: [occupant(slot.path)] }),
    status: 409,
    error: "a process entered the available slot before it was leased",
    state: "available",
  },
  {
    name: "occupancy goes unknown after the screening",
    stage: () => occupancyReads.push(null, { status: "unknown", reason: "ps timed out after 15 s" }),
    status: 409,
    error: "ps timed out after 15 s",
    state: "available",
  },
  {
    name: "a process enters and the reservation cannot be handed back",
    stage: (t, slot) => {
      occupancyReads.push(null, { status: "known", occupants: [occupant(slot.path)] });
      t.mock.method(manager.store, "releaseReservation", () => null);
    },
    status: 503,
    error: "a process entered the available slot before it was leased",
    state: "quarantined",
    quarantineReason: RESERVATION_NOT_HANDED_BACK,
  },
  {
    name: "something else reserves the slot first",
    stage: (t) => t.mock.method(manager.store, "reserveAvailable", () => null),
    status: 409,
    error: "the slot was leased by something else first",
    state: "available",
  },
  {
    name: "the reservation cannot be written",
    stage: (t) => t.mock.method(manager.store, "reserveAvailable", () => { throw new Error("database is locked"); }),
    status: 503,
    error: /database is locked/,
    state: "available",
  },
  {
    name: "the lease loses its compare-and-swap",
    stage: (t) => t.mock.method(manager.store, "finalizeLease", () => null),
    status: 503,
    error: "lease commit could not be proven",
    state: "quarantined",
    quarantineReason: "lease commit lost its slot compare-and-swap",
  },
  {
    name: "the lease cannot be written",
    stage: (t) => t.mock.method(manager.store, "finalizeLease", () => { throw new Error("database is locked"); }),
    status: 503,
    error: /database is locked/,
    state: "quarantined",
    quarantineReason: "as-is lease outcome is unknown",
  },
  {
    name: "the screening cannot read occupancy",
    stage: () => occupancyReads.push({ status: "unknown", reason: "ps timed out after 15 s" }),
    status: 409,
    error: `the slot is not idle: ${OBSERVATION_FAILURE.occupancy}`,
    state: "available",
  },
  {
    name: "the screening cannot list registrations",
    stage: (t) => t.mock.method(NativeWorktreeGit.prototype, "list", async () =>
      ({ ok: false as const, reason: "git worktree list timed out after 15 s", outcomeUnknown: true })),
    status: 409,
    error: /git worktree list timed out after 15 s/,
    state: "available",
  },
  {
    name: "the pool's checkout no longer exists",
    stage: (t, slot) => repoint(t, slot, "/nonexistent/mission-worktree-open"),
    status: 409,
    error: "the pool's repository identity can no longer be proven",
    state: "available",
  },
  {
    name: "the pool's checkout is now another repository",
    stage: (t, slot) => repoint(t, slot, mkOriginAndClone("mission-worktree-open-other-").clone),
    status: 409,
    error: "the pool's repository identity can no longer be proven",
    state: "available",
  },
];

function repoint(t: TestContext, slot: Slot, root: string): void {
  const update = db.prepare("UPDATE worktree_pools SET main_checkout_root = ? WHERE id = ?");
  update.run(root, slot.poolId);
  t.after(() => update.run(slot.clone, slot.poolId));
}

for (const scenario of NO_LEASE_CASES) {
  test(`Open terminal opens nothing and holds no lease when ${scenario.name}`, async (t) => {
    const slot = await availableSlot();
    scenario.stage(t, slot);
    const launches = launched.length;
    const response = await slot.open();
    assert.equal(response.status, scenario.status);
    const { error } = await response.json() as { error: string };
    if (typeof scenario.error === "string") assert.equal(error, scenario.error);
    else assert.match(error, scenario.error);
    assert.equal(launched.length, launches, "the launcher was never asked");
    assert.equal(slot.row().state, scenario.state);
    assert.equal(slot.row().activeLeaseId, null);
    assert.equal(slot.row().activeOwnerKey, null);
    assert.equal(slot.row().quarantineReason, scenario.quarantineReason ?? null);
    assert.equal(occupancyReads.length, 0, "every staged read was consumed");
  });
}

test("a lease Open terminal took outlives its shell and is flagged stale like any live lease", async (t) => {
  const { poolId, slotId, head, path, open, row } = await availableSlot();
  // The route launches $SHELL, which on a developer's machine is whatever they log in to.
  const shellBefore = process.env.SHELL;
  process.env.SHELL = "/bin/sh";
  t.after(() => {
    if (shellBefore === undefined) delete process.env.SHELL;
    else process.env.SHELL = shellBefore;
  });
  const leaseCard = async () => {
    const inventory = await (await app.request("/api/worktrees", { headers: HEADERS })).json() as WorktreeInventory;
    return inventory.repositories.flatMap((pool) => pool.slots).find((slot) => slot.id === slotId)!;
  };

  shellExits = [];
  const opened = await open();
  const exits = shellExits;
  shellExits = null;
  assert.equal(opened.status, 200);
  assert.deepEqual(exits, [0], "a real shell ran in the slot and exited before the route answered");
  const leaseId = row().activeLeaseId;
  assert.ok(leaseId);
  assert.equal(row().state, "leased");

  // Reconcile is what would notice an owner that went away with its shell. It must not.
  assert.equal(await manager.reconcilePoolById(poolId), true);
  assert.equal(row().state, "leased");
  assert.equal(row().activeLeaseId, leaseId);
  assert.equal((await leaseCard()).owner?.label, "Terminal from Settings");

  // The clock starts at the first probe, and a lease younger than the threshold is not stale.
  const firstProbe = leaseClock;
  await leaseActivity.pass();
  assert.equal((await leaseCard()).staleSince, null);

  leaseClock += 8 * 24 * 60 * 60 * 1_000;
  await leaseActivity.pass();
  const card = await leaseCard();
  assert.equal(card.staleSince, firstProbe);
  assert.equal(card.state, "leased");
  assert.ok(card.actions.includes("return"));

  // Flagged, never reclaimed: a further pass leaves the lease and the tree as they were.
  assert.equal(await manager.reconcilePoolById(poolId), true);
  assert.equal(row().state, "leased");
  assert.equal(row().activeLeaseId, leaseId);
  assert.equal(gitIn(path, "rev-parse", "HEAD"), head);
});

test("a failed launch on a slot that took no lease reports the launcher's own error", async () => {
  const failedOpen = async (open: () => Promise<Response> | Response) => {
    launchError = "terminal did not answer";
    try {
      const response = await open();
      assert.equal(response.status, 502);
      assert.equal((await response.json() as { error: string }).error, "terminal did not answer");
    } finally {
      launchError = null;
    }
  };

  const { clone } = mkOriginAndClone("mission-worktree-open-");
  const held = await manager.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "manual", key: "still-held" },
  });
  assert.equal(held.outcome, "acquired");
  if (held.outcome !== "acquired") return;
  await failedOpen(() => openSlot(held.lease.slotId));
  const leased = manager.store.slot(held.lease.slotId)!;
  assert.equal(leased.state, "leased");
  assert.equal(leased.activeLeaseId, held.lease.leaseId);

  const quarantined = await availableSlot();
  writeFileSync(join(quarantined.path, "stray.txt"), "work\n");
  assert.equal((await quarantined.open()).status, 409);
  assert.equal(quarantined.row().state, "quarantined");
  await failedOpen(quarantined.open);
  assert.equal(quarantined.row().state, "quarantined");
  assert.equal(quarantined.row().activeLeaseId, null);
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
