import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  WorktreeClaimSchema,
  WorktreesConfigPatchSchema,
  type WorktreeClaim,
} from "../src/shared/protocol.ts";
import type { WorktreeClaimVariableView } from "../src/shared/worktrees.ts";
import { openDb } from "../src/server/db.ts";
import {
  ClaimRegistry,
  buildClaimEnvironment,
  describeClaimVariables,
  runClaimSteps,
  type RunningClaimStep,
} from "../src/server/worktrees/claim.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import { WorktreeManager, type WorktreeAcquireResult } from "../src/server/worktrees/manager.ts";
import { WorktreeOperationsService, slotDependencies } from "../src/server/worktrees/operations.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import {
  claimErrorsFrom,
  claimFromDraft,
  draftFromClaim,
  draftNames,
  splitClaimFailure,
  type ClaimDraft,
} from "../src/web/lib/worktree-claim-draft.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

// What Settings > Worktrees shows about a pool's dependency claim: each slot's dependency state,
// derived from the durable row, the claim running in it and the last FETCHED default branch,
// and whether each claim variable name has a value, without the value.

const db = openDb();

afterEach(() => {
  db.exec(
    "DELETE FROM worktree_slots; DELETE FROM worktree_pools; " +
      "DELETE FROM app_config WHERE key = 'worktrees';",
  );
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function row(over: Partial<Parameters<typeof slotDependencies>[0]["slot"]> = {}) {
  return {
    depsState: null,
    depsFingerprint: null,
    depsFingerprintSha: null,
    depsClaimedAt: null,
    depsLastError: null,
    ...over,
  };
}

test("a pool with no claim shows no dependency state at all", () => {
  assert.equal(
    slotDependencies({ hasClaim: false, slot: row({ depsState: "current" }), running: null, defaultSha: SHA_A, defaultFingerprint: "f" }),
    null,
  );
});

test("each durable dependency state maps to the state Settings names", () => {
  const view = (slot: ReturnType<typeof row>, defaultFingerprint: string | null = "fp-default") =>
    slotDependencies({ hasClaim: true, slot, running: null, defaultSha: SHA_B, defaultFingerprint });

  assert.equal(view(row())?.state, "never");

  const current = view(row({ depsState: "current", depsFingerprint: "fp-default", depsFingerprintSha: SHA_A, depsClaimedAt: 7 }));
  assert.deepEqual(current, {
    state: "current",
    fingerprintSha: SHA_A,
    claimedAt: 7,
    defaultSha: SHA_B,
    installing: null,
    failure: null,
  });

  const stale = view(row({ depsState: "current", depsFingerprint: "fp-old", depsFingerprintSha: SHA_A }));
  assert.equal(stale?.state, "stale");
  assert.equal(stale?.defaultSha, SHA_B, "stale names the default commit it was judged against");
  assert.equal(stale?.fingerprintSha, SHA_A, "and the commit the slot's fingerprint was taken at");

  // A claim with no fingerprint paths records no fingerprint and runs every lease: never stale.
  assert.equal(view(row({ depsState: "current", depsFingerprint: null, depsFingerprintSha: SHA_A }))?.state, "current");
  // An unknown default (no fetched ref, unreadable tree) is not evidence of staleness.
  const unknown = view(row({ depsState: "current", depsFingerprint: "fp-old" }), null);
  assert.equal(unknown?.state, "current");
  assert.equal(unknown?.defaultSha, null, "a default it did not judge against is not named");

  const failed = view(row({ depsState: "failed", depsLastError: "step 1 of 1 (yarn install) exited with code 3\nE401 Unauthorized\n" }));
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.failure, "step 1 of 1 (yarn install) exited with code 3\nE401 Unauthorized\n", "the tail keeps its lines");

  assert.equal(view(row({ depsState: "interrupted" }))?.state, "interrupted");
  // A write-ahead nobody is running behind is a claim a restart cut off.
  assert.equal(view(row({ depsState: "claiming" }))?.state, "interrupted");
  // A value a later build wrote is never trusted as current.
  assert.equal(view(row({ depsState: "seeding-v9" }))?.state, "interrupted");
});

test("a running claim is installing, with its step, command and start time", () => {
  const owner = { kind: "task" as const, key: "task-1:0" };
  const reading = slotDependencies({
    hasClaim: true,
    slot: row({ depsState: "current", depsFingerprint: "x" }),
    running: { slotId: "s", owner, startedAt: 100, step: null },
    defaultSha: SHA_A,
    defaultFingerprint: "x",
  });
  assert.deepEqual(reading?.installing, { startedAt: 100, step: null }, "before step 1 it is still reading the fingerprint");

  const stepping = slotDependencies({
    hasClaim: true,
    slot: row({ depsState: "claiming" }),
    running: { slotId: "s", owner, startedAt: 100, step: { step: 2, stepCount: 3, argv: ["yarn", "rebuild"], startedAt: 150 } },
    defaultSha: SHA_A,
    defaultFingerprint: "x",
  });
  assert.equal(stepping?.state, "installing");
  assert.deepEqual(stepping?.installing, {
    startedAt: 100,
    step: { step: 2, stepCount: 3, command: "yarn rebuild", startedAt: 150 },
  });
});

test("presence says where a name's value comes from and never carries the value", () => {
  const token = "daemon-token-123";
  const views = describeClaimVariables({
    names: ["FROM_DAEMON", "FROM_SHELL", "EMPTY_IN_DAEMON", "NOWHERE", "CARRIES_TOKEN"],
    daemonEnv: { FROM_DAEMON: "daemon-secret", EMPTY_IN_DAEMON: "", CARRIES_TOKEN: `x${token}x` },
    daemonToken: token,
    loginShell: { FROM_SHELL: "shell-secret", EMPTY_IN_DAEMON: "shell-fallback-secret" },
  });
  assert.deepEqual(views, [
    { name: "FROM_DAEMON", present: true, source: "daemon" },
    { name: "FROM_SHELL", present: true, source: "loginShell" },
    { name: "EMPTY_IN_DAEMON", present: true, source: "loginShell" },
    { name: "NOWHERE", present: false, source: null },
    { name: "CARRIES_TOKEN", present: false, source: null },
  ]);
  const serialized = JSON.stringify(views);
  for (const secret of ["daemon-secret", "shell-secret", "shell-fallback-secret", token]) {
    assert.equal(serialized.includes(secret), false, `${secret} must not appear in a presence view`);
  }
});

test("presence and the step environment agree on every name", () => {
  const sources = {
    daemonEnv: { A: "1", C: "has-the-token-inside" } as NodeJS.ProcessEnv,
    daemonToken: "token-inside",
    loginShell: { B: "2" },
  };
  const names = ["A", "B", "C", "D"];
  const environment = buildClaimEnvironment({ names, ...sources });
  const presence = describeClaimVariables({ names, ...sources });
  assert.deepEqual(presence.filter((view) => view.present).map((view) => view.name), environment.received);
  assert.deepEqual(presence.filter((view) => !view.present).map((view) => view.name), environment.missing);
});

test("the registry records each step a claim reaches, and only for the claim that owns it", async () => {
  const registry = new ClaimRegistry();
  const control = registry.register("slot-1", { kind: "task", key: "t:0" }, 10)!;
  assert.equal(registry.get("slot-1")?.step, null);
  const seen: RunningClaimStep[] = [];
  let clock = 1_000;
  const outcome = await runClaimSteps({
    claim: WorktreeClaimSchema.parse({ steps: [{ argv: ["one"] }, { argv: ["two", "--x"] }] }),
    cwd: "/nowhere",
    signal: control.signal,
    environment: async () => ({ env: {}, received: [], missing: [] }),
    runStep: async () => {
      clock += 5;
      return { outcome: "exited", code: 0, signal: null, tail: "", truncatedBytes: 0 };
    },
    now: () => clock,
    onStep: (step) => {
      seen.push(step);
      registry.progress("slot-1", control, step);
    },
  });
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(seen, [
    { step: 1, stepCount: 2, argv: ["one"], startedAt: 1_000 },
    { step: 2, stepCount: 2, argv: ["two", "--x"], startedAt: 1_005 },
  ]);
  assert.deepEqual(registry.get("slot-1")?.step, { step: 2, stepCount: 2, argv: ["two", "--x"], startedAt: 1_005 });

  // A stale controller from an earlier claim on the same slot cannot overwrite a newer one.
  registry.unregister("slot-1", control);
  const next = registry.register("slot-1", { kind: "task", key: "t:1" }, 20)!;
  registry.progress("slot-1", control, { step: 9, stepCount: 9, argv: ["late"], startedAt: 0 });
  assert.equal(registry.get("slot-1")?.step, null);
  registry.unregister("slot-1", next);
  assert.equal(registry.get("slot-1"), null);
});

test("the claim draft round-trips a stored claim and sends exactly what was typed", () => {
  const claim = WorktreeClaimSchema.parse({
    steps: [
      { argv: ["yarn", "install", "--immutable"], env: ["ARTIFACTORY_AUTH_TOKEN", "NPM_TOKEN"] },
      { argv: ["yarn", "rebuild"] },
    ],
    timeoutMinutes: 25,
    fingerprintPaths: ["yarn.lock", "apps/*/package.json"],
  });
  const draft = draftFromClaim(claim);
  assert.equal(draft.steps[0]!.argv, "yarn\ninstall\n--immutable");
  assert.deepEqual(claimFromDraft(draft), claim);
  assert.deepEqual(draftNames(" A_1,B_2\nC_3  "), ["A_1", "B_2", "C_3"]);
  // An argument keeps its spaces: a line is an argument, never split on whitespace.
  assert.deepEqual(
    (claimFromDraft({ steps: [{ argv: "node\n-e\nconsole.log( 1 )\n", env: "" }], timeoutMinutes: "5", fingerprintPaths: "" }) as WorktreeClaim).steps[0]!.argv,
    ["node", "-e", "console.log( 1 )"],
  );
  assert.equal(draftFromClaim(null).steps.length, 0);
});

test("the route's schema refusal lands beside the claim field that caused it", () => {
  const draft: ClaimDraft = {
    steps: [
      { argv: "yarn\ninstall", env: "GOOD_NAME bad-name" },
      { argv: "", env: "MISSION_API_TOKEN" },
    ],
    timeoutMinutes: "0",
    fingerprintPaths: "yarn.lock\n../outside.json",
  };
  const parsed = WorktreesConfigPatchSchema.safeParse({
    repositories: { "/repo/.git": { claim: claimFromDraft(draft) } },
  });
  assert.equal(parsed.success, false);
  // The route answers with exactly this text as its `error` (parseBody in routes.ts).
  const errors = claimErrorsFrom(parsed.error!.message, draft);
  assert.deepEqual(errors.general, []);
  assert.equal(errors.env[0]?.length, 1);
  assert.match(errors.env[0]![0]!, /^bad-name: a variable name is letters, digits and underscores$/);
  assert.match(errors.env[1]![0]!, /^MISSION_API_TOKEN: PATH and MISSION_\/FLEET_\/HARNESS_ names are reserved$/);
  assert.equal(errors.argv[1]?.length, 1, "an empty command is refused on its own step");
  assert.equal(errors.argv[0], undefined);
  assert.equal(errors.timeoutMinutes.length, 1);
  assert.equal(errors.fingerprintPaths.length, 1);
  assert.match(errors.fingerprintPaths[0]!, /^\.\.\/outside\.json: a fingerprint path is a repository-relative glob/);

  const blankTimeout = { ...draft, steps: [{ argv: "true", env: "" }], timeoutMinutes: "", fingerprintPaths: "" };
  const refusedBlank = WorktreesConfigPatchSchema.safeParse({
    repositories: { "/repo/.git": { claim: claimFromDraft(blankTimeout) } },
  });
  assert.equal(refusedBlank.success, false, "a blank timeout is sent as typed and refused, never defaulted silently");
  assert.equal(claimErrorsFrom(refusedBlank.error!.message, blankTimeout).timeoutMinutes.length, 1);

  const noSteps = { ...draft, steps: [] };
  const refusedEmpty = WorktreesConfigPatchSchema.safeParse({
    repositories: { "/repo/.git": { claim: claimFromDraft({ ...noSteps, timeoutMinutes: "10", fingerprintPaths: "" }) } },
  });
  assert.equal(claimErrorsFrom(refusedEmpty.error!.message, noSteps).steps.length, 1);

  assert.deepEqual(claimErrorsFrom("worktree operations unavailable", draft).general, ["worktree operations unavailable"]);
});

test("a failure summary splits into its step, its command and the reason, even with parentheses in the command", () => {
  assert.deepEqual(
    splitClaimFailure("step 2 of 3 (node -e console.log(1)) exited with code 3 (no value for NPM_TOKEN)"),
    { step: "step 2 of 3", command: "node -e console.log(1)", reason: "exited with code 3 (no value for NPM_TOKEN)" },
  );
  assert.deepEqual(
    splitClaimFailure("step 1 of 1 (pnpm) timed out at the claim's 10-minute limit"),
    { step: "step 1 of 1", command: "pnpm", reason: "timed out at the claim's 10-minute limit" },
  );
  assert.deepEqual(splitClaimFailure("something else entirely"), { step: null, command: null, reason: "something else entirely" });
});

// ---- Through the real manager and inventory ----

function emptyOccupancy(paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> {
  return Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants: [] }])));
}

function node(code: string): string[] {
  return [process.execPath, "-e", code];
}

function repository(prefix: string): { origin: string; clone: string; sha: string } {
  const { origin, clone } = mkOriginAndClone(prefix);
  writeFileSync(join(origin, "lock.txt"), "v1\n");
  gitIn(origin, "add", "-A");
  gitIn(origin, "commit", "-qm", "lockfile");
  gitIn(clone, "fetch", "-q", "origin");
  gitIn(clone, "reset", "-q", "--hard", "origin/main");
  return { origin, clone, sha: gitIn(clone, "rev-parse", "HEAD") };
}

function harness(claim: WorktreeClaim, presence: (names: readonly string[]) => Promise<WorktreeClaimVariableView[]>) {
  let bumps = 0;
  const manager = new WorktreeManager(db, {
    occupancy: emptyOccupancy,
    resolvePolicy: () => ({ enabled: true, maxSlots: 4, setupArgv: null, claim }),
    claimEnvironment: async (names) =>
      buildClaimEnvironment({ names, daemonEnv: { PRESENT_TOKEN: "s3cr3t-daemon-value" }, daemonToken: "tok", loginShell: {} }),
    publishChanged: () => { bumps += 1; },
  });
  const operations = new WorktreeOperationsService(manager, {
    legacy: new LegacyTreehouseService(db),
    tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
    checks: new CheckLeaseManager(db, { manager, legacy: new LegacyTreehouseService(db) }),
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => null,
    claimVariablePresence: presence,
  });
  return { manager, operations, bumps: () => bumps };
}

function leased(result: WorktreeAcquireResult): Extract<WorktreeAcquireResult, { outcome: "acquired" }> {
  assert.equal(result.outcome, "acquired", JSON.stringify(result));
  return result as Extract<WorktreeAcquireResult, { outcome: "acquired" }>;
}

async function slotView(operations: WorktreeOperationsService, slotId: string) {
  const inventory = await operations.inventory();
  const found = inventory.repositories.flatMap((repo) => repo.slots).find((slot) => slot.id === slotId);
  assert.ok(found, `slot ${slotId} is in the inventory`);
  return { inventory, slot: found };
}

test("the inventory reports current, then stale only once the default ref is fetched", async () => {
  const fixture = repository("mission-claim-inventory-stale-");
  const claim = WorktreeClaimSchema.parse({
    steps: [{ argv: node("process.exit(0)"), env: ["PRESENT_TOKEN", "ABSENT_TOKEN"] }],
    fingerprintPaths: ["lock.txt"],
  });
  const presence = async (names: readonly string[]) =>
    describeClaimVariables({
      names,
      daemonEnv: { PRESENT_TOKEN: "s3cr3t-daemon-value" },
      daemonToken: "tok",
      loginShell: { SHELL_ONLY: "s3cr3t-shell-value" },
    });
  const { manager, operations } = harness(claim, presence);
  const lease = leased(await manager.acquire({
    repositoryPath: fixture.clone,
    baseSha: fixture.sha,
    owner: { kind: "task", key: "task-stale:0" },
    runClaim: true,
  })).lease;

  const first = await slotView(operations, lease.slotId);
  assert.equal(first.slot.dependencies?.state, "current");
  assert.equal(first.slot.dependencies?.fingerprintSha, fixture.sha, "the fingerprint's commit is the leased commit");
  assert.equal(first.slot.dependencies?.defaultSha, fixture.sha);
  const repo = first.inventory.repositories[0]!;
  assert.deepEqual(repo.policy.claim, claim);
  assert.deepEqual(repo.claimVariables, [
    { name: "ABSENT_TOKEN", present: false, source: null },
    { name: "PRESENT_TOKEN", present: true, source: "daemon" },
  ]);
  assert.equal(JSON.stringify(first.inventory).includes("s3cr3t"), false, "no variable value reaches the inventory");

  // origin moves the lockfile, but nothing has fetched it: building the inventory must not.
  writeFileSync(join(fixture.origin, "lock.txt"), "v2\n");
  gitIn(fixture.origin, "add", "-A");
  gitIn(fixture.origin, "commit", "-qm", "lockfile v2");
  const unfetched = await slotView(operations, lease.slotId);
  assert.equal(unfetched.slot.dependencies?.state, "current", "the inventory judges against the last fetched ref only");
  assert.equal(gitIn(fixture.clone, "rev-parse", "origin/main"), fixture.sha, "and it did not fetch to find out");

  gitIn(fixture.clone, "fetch", "-q", "origin");
  const fetched = gitIn(fixture.clone, "rev-parse", "origin/main");
  const stale = await slotView(operations, lease.slotId);
  assert.equal(stale.slot.dependencies?.state, "stale");
  assert.equal(stale.slot.dependencies?.defaultSha, fetched);
  assert.equal(stale.slot.dependencies?.fingerprintSha, fixture.sha);

  // A change outside the fingerprint paths is not a dependency change.
  writeFileSync(join(fixture.origin, "README.md"), "docs only\n");
  gitIn(fixture.origin, "add", "-A");
  gitIn(fixture.origin, "commit", "-qm", "docs");
  gitIn(fixture.clone, "fetch", "-q", "origin");
  assert.equal((await slotView(operations, lease.slotId)).slot.dependencies?.state, "stale", "still stale against lock v2");
});

test("a running claim shows installing with its step, and a failed one keeps its tail", async () => {
  const fixture = repository("mission-claim-inventory-running-");
  const gate = join(fixture.clone, "..", `gate-${process.pid}-${Date.now()}`);
  const claim = WorktreeClaimSchema.parse({
    steps: [
      { argv: node("process.exit(0)") },
      {
        argv: node(
          `const fs=require("fs");const gate=${JSON.stringify(gate)};` +
            `const wait=()=>{if(fs.existsSync(gate)){console.log("resolving packages");console.error("E401 Unauthorized: token rejected");process.exit(3)}setTimeout(wait,25)};wait();`,
        ),
      },
    ],
  });
  const { manager, operations, bumps } = harness(claim, async () => []);
  const pending = manager.acquire({
    repositoryPath: fixture.clone,
    baseSha: fixture.sha,
    owner: { kind: "task", key: "task-running:0" },
    runClaim: true,
  });
  const deadline = Date.now() + 15_000;
  while (manager.claims.list()[0]?.step?.step !== 2) {
    if (Date.now() > deadline) throw new Error("the claim never reached step 2");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const slotId = manager.claims.list()[0]!.slotId;
  const bumpsBefore = bumps();
  assert.ok(bumpsBefore >= 3, "the write-ahead and each step start bump the worktrees revision");

  const installing = await slotView(operations, slotId);
  assert.equal(installing.slot.state, "provisioning");
  assert.equal(installing.slot.dependencies?.state, "installing");
  assert.equal(installing.slot.dependencies?.installing?.step?.step, 2);
  assert.equal(installing.slot.dependencies?.installing?.step?.stepCount, 2);
  assert.match(installing.slot.dependencies?.installing?.step?.command ?? "", /-e /);

  writeFileSync(gate, "go\n");
  const result = leased(await pending);
  assert.ok(result.claimWarning, "a failed claim still hands the slot over, with a warning");
  assert.equal(existsSync(gate), true);
  const failed = await slotView(operations, slotId);
  assert.equal(failed.slot.dependencies?.state, "failed");
  assert.match(failed.slot.dependencies?.failure ?? "", /^step 2 of 2 .* exited with code 3\n/);
  assert.match(failed.slot.dependencies?.failure ?? "", /E401 Unauthorized: token rejected/);
  assert.equal(failed.slot.dependencies?.installing, null);
});
