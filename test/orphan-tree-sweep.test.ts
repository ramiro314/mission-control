import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-orphan-sweep-"));
process.env.HARNESS_HOME = home;
const { openDb, upsertTask } = await import("../src/server/db.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");
const { CheckLeaseStore } = await import("../src/server/workflows/check-lease.ts");
const { InFlightTrees } = await import("../src/server/worktrees/in-flight.ts");
const { OrphanTreeSweep, ORPHAN_TREE_GRACE_MS, referencedTreePaths } = await import("../src/server/worktrees/orphan-sweep.ts");
const { run, stubRun } = await import("../src/server/util/exec.ts");
const { setWorktreesConfig } = await import("../src/server/worktrees/config.ts");
const { WorktreeClaimSchema } = await import("../src/shared/protocol.ts");
type Deps = ConstructorParameters<typeof OrphanTreeSweep>[0];
type Occupancy = import("../src/server/worktrees/occupancy.ts").WorktreeOccupancy;

after(() => rmSync(home, { recursive: true, force: true }));

// What is at stake: a folder under `worktrees/` or `check-worktrees/` that no row names is
// swept, but only when it is provably disposable. Removing a tree with work in it, one a row
// still owns, one being created, or anything a symlink points at would lose an operator's work.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let fixtures = 0;

/** A state home with both sweep directories and a source repository whose `main` is on origin. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(home, `case-${fixtures++}-`)));
  const stateHome = join(root, "state");
  const worktrees = join(stateHome, "worktrees");
  const checks = join(stateHome, "check-worktrees");
  mkdirSync(worktrees, { recursive: true });
  mkdirSync(checks, { recursive: true });
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const repo = join(root, "repo");
  execFileSync("git", ["clone", "-q", origin, repo], { stdio: "ignore" });
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\ndist/\n.evidence/\n");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "main");
  return { root, stateHome, worktrees, checks, repo };
}

type Fixture = ReturnType<typeof fixture>;

function addWorktree(f: Fixture, path: string, branch: string): string {
  git(f.repo, "worktree", "add", "-q", "-b", branch, path);
  return path;
}

const idle = async (paths: readonly string[]) =>
  new Map<string, Occupancy>(paths.map((path) => [path, { status: "known", occupants: [] }]));

/** A sweep over the fixture, an hour in the future so every folder is past its grace. */
function sweeper(f: Fixture, deps: Deps = {}) {
  return new OrphanTreeSweep({
    directories: [f.worktrees, f.checks],
    stateHome: f.stateHome,
    referencedPaths: () => [],
    slotPaths: () => [],
    sourceRepositories: () => [f.repo],
    inFlight: new InFlightTrees(),
    occupancy: idle,
    now: () => Date.now() + 2 * ORPHAN_TREE_GRACE_MS,
    ...deps,
  });
}

function branches(f: Fixture): string[] {
  return git(f.repo, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);
}

test("removes a husk and a clean unreferenced worktree, and keeps and lists a dirty one", async () => {
  const f = fixture();
  // The Sep 26 shape: a `.git` file whose gitdir is gone, and empty directories.
  const husk = join(f.worktrees, "husk");
  mkdirSync(join(husk, "src", "deep", "er"), { recursive: true });
  writeFileSync(join(husk, ".git"), `gitdir: ${join(f.repo, ".git", "worktrees", "gone")}\n`);
  const clean = addWorktree(f, join(f.worktrees, "clean"), "harness/clean");
  // Regenerable ignored files do not count as work.
  mkdirSync(join(clean, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(clean, "node_modules", "pkg", "index.js"), "x");
  mkdirSync(join(clean, "dist"));
  writeFileSync(join(clean, "dist", "out.js"), "x");
  const dirty = addWorktree(f, join(f.checks, "dirty"), "harness/dirty");
  writeFileSync(join(dirty, "notes.md"), "work in progress\n");

  const sweep = sweeper(f);
  const result = await sweep.sweep();

  assert.deepEqual(result.removed.sort(), [clean, husk].sort());
  assert.equal(existsSync(husk), false);
  assert.equal(existsSync(clean), false);
  assert.ok(!git(f.repo, "worktree", "list").includes(clean), "the clean tree's registration went with it");
  assert.ok(!branches(f).includes("harness/clean"), "its harness branch was on origin, so it was deleted");
  assert.deepEqual(result.kept.map((tree) => tree.path), [dirty]);
  assert.match(result.kept[0]!.reason, /uncommitted, untracked or ignored work/);
  assert.ok(existsSync(join(dirty, "notes.md")), "the dirty tree's work is intact");

  const observed = sweep.problems();
  assert.equal(observed.firstSeen?.length, 1);
  const problem = observed.firstSeen![0]!.problem(1_000);
  assert.equal(problem.id, `dirty-orphan-folder:${dirty}:1000`);
  assert.equal(problem.kind, "dirty-orphan-folder");
  assert.equal(problem.bannered, true);
  assert.deepEqual(problem.link, { target: "unowned-tree", path: dirty });
});

test("the sweep applies the delete rule with the owning pool's seed paths", async () => {
  const seeded = fixture();
  const unclaimed = fixture();
  for (const f of [seeded, unclaimed]) writeFileSync(join(f.repo, ".git", "info", "exclude"), ".yarn/install-state.gz\n.idea/\n.env\n");
  // Only `seeded`'s pool has a claim; the policy is keyed by the physical common directory.
  setWorktreesConfig({
    repositories: {
      [realpathSync(join(seeded.repo, ".git"))]: {
        claim: WorktreeClaimSchema.parse({ steps: [{ argv: ["yarn", "install"] }], seed: { paths: ["node_modules", ".yarn/install-state.gz"] } }),
      },
    },
  });
  const plant = (path: string, ...files: string[]) => {
    for (const file of files) {
      mkdirSync(join(path, file, ".."), { recursive: true });
      writeFileSync(join(path, file), "x");
    }
    return path;
  };
  const install = plant(addWorktree(seeded, join(seeded.worktrees, "install"), "harness/install"), ".yarn/install-state.gz");
  const idea = plant(addWorktree(seeded, join(seeded.worktrees, "idea"), "harness/idea"), ".yarn/install-state.gz", ".idea/workspace.xml");
  const env = plant(addWorktree(seeded, join(seeded.checks, "env"), "harness/env"), ".yarn/install-state.gz", ".env");
  const noClaim = plant(addWorktree(unclaimed, join(unclaimed.worktrees, "install"), "harness/install"), ".yarn/install-state.gz");

  const result = await sweeper(seeded).sweep();
  assert.deepEqual(result.removed, [install], "only the seed path is regenerable");
  assert.equal(existsSync(install), false);
  assert.deepEqual(result.kept.map((tree) => tree.path).sort(), [env, idea].sort());
  assert.ok(existsSync(join(idea, ".idea", "workspace.xml")));
  assert.ok(existsSync(join(env, ".env")));

  // A pool with no claim gets the built-in list, so its install state is work.
  const plain = await sweeper(unclaimed).sweep();
  assert.deepEqual(plain.removed, []);
  assert.deepEqual(plain.kept.map((tree) => tree.path), [noClaim]);
  assert.match(plain.kept[0]!.reason, /ignored work/);
});

test("the sweep keeps a tree holding what the pool's seed excludes, even inside a seed path", async () => {
  const f = fixture();
  writeFileSync(join(f.repo, ".git", "info", "exclude"), ".yarn/\n");
  setWorktreesConfig({
    repositories: {
      [realpathSync(join(f.repo, ".git"))]: {
        claim: WorktreeClaimSchema.parse({ steps: [{ argv: ["yarn", "install"] }], seed: { paths: [".yarn"], exclude: [".yarn/secrets/*"] } }),
      },
    },
  });
  const path = addWorktree(f, join(f.worktrees, "secrets"), "harness/secrets");
  mkdirSync(join(path, ".yarn", "secrets"), { recursive: true });
  writeFileSync(join(path, ".yarn", "secrets", "token"), "local only");

  const result = await sweeper(f).sweep();
  assert.deepEqual(result.removed, [], "no seed will ever put an excluded file back");
  assert.deepEqual(result.kept.map((tree) => tree.path), [path]);
  assert.ok(existsSync(join(path, ".yarn", "secrets", "token")));
});

test("a tree with unpublished commits is kept, with its branch", async () => {
  const f = fixture();
  const path = addWorktree(f, join(f.worktrees, "unpushed"), "harness/unpushed");
  writeFileSync(join(path, "change.txt"), "x");
  git(path, "add", ".");
  git(path, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "local only");
  const result = await sweeper(f).sweep();
  assert.deepEqual(result.removed, []);
  assert.match(result.kept[0]!.reason, /unpublished commits/);
  assert.ok(existsSync(path));
  assert.ok(branches(f).includes("harness/unpushed"));
});

test("a clean tree whose removal fails is kept and listed with why", async () => {
  const f = fixture();
  const clean = addWorktree(f, join(f.worktrees, "stuck"), "harness/stuck");
  const sweep = sweeper(f, {
    execute: async (bin, args, options) =>
      args.includes("remove") && args.includes(clean)
        ? stubRun({ stdout: "", stderr: "fatal: simulated failure", code: 128 })
        : run(bin, args, options),
  });
  const result = await sweep.sweep();
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.kept.map((tree) => [tree.path, tree.reason]), [
    [clean, "it could not be removed: fatal: simulated failure"],
  ]);
  assert.ok(existsSync(join(clean, "README.md")), "the tree is still there");
  assert.ok(branches(f).includes("harness/stuck"), "and so is its branch");
  const [problem] = sweep.problems().firstSeen ?? [];
  assert.equal(problem?.problem(5).id, `dirty-orphan-folder:${clean}:5`);
});

test("skips an occupied tree, never touches a referenced one, and never follows a symlink out", async () => {
  const f = fixture();
  const occupied = addWorktree(f, join(f.worktrees, "occupied"), "harness/occupied");
  const unknown = addWorktree(f, join(f.worktrees, "unknown"), "harness/unknown");
  const referenced = join(f.checks, "referenced");
  mkdirSync(join(referenced, "empty"), { recursive: true });
  // A husk outside the sweep directories, reachable only through a symlink inside one.
  const outside = join(f.root, "outside-husk");
  mkdirSync(join(outside, "empty"), { recursive: true });
  symlinkSync(outside, join(f.worktrees, "link"));

  const result = await sweeper(f, {
    referencedPaths: () => [referenced],
    occupancy: async (paths) => new Map<string, Occupancy>(paths.map((path) => [path,
      path === occupied
        ? { status: "known", occupants: [{ pid: 1, ppid: 0, startRaw: "", startMs: 0, command: "vim", cwd: path, knownOwner: null }] }
        : path === unknown
          ? { status: "unknown", reason: "lsof timed out" }
          : { status: "known", occupants: [] },
    ])),
  }).sweep();

  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(
    result.skipped.map((each) => [each.path, each.reason]).sort(),
    [[occupied, "occupied"], [unknown, "lsof timed out"]],
  );
  assert.ok(existsSync(occupied) && existsSync(unknown));
  assert.ok(existsSync(join(referenced, "empty")), "a referenced husk is never touched");
  assert.ok(existsSync(join(outside, "empty")), "the symlink's target is never touched");
  assert.ok(existsSync(join(f.worktrees, "link")), "nor the symlink itself");
});

test("a folder holding any file outside git's leftovers is listed, not removed", async () => {
  const f = fixture();
  // A tree whose `.git` file was lost but whose source files remain.
  const lost = addWorktree(f, join(f.worktrees, "lost-git"), "harness/lost");
  rmSync(join(lost, ".git"));
  // A husk shape, but with one stray regular file deep inside.
  const stray = join(f.worktrees, "stray");
  mkdirSync(join(stray, "a", "b"), { recursive: true });
  writeFileSync(join(stray, "a", "b", ".env"), "TOKEN=1\n");
  // A husk shape whose only entry is a symlink, which is not git's own either.
  const linked = join(f.checks, "linked");
  mkdirSync(linked);
  symlinkSync("/etc/hosts", join(linked, "hosts"));

  const result = await sweeper(f).sweep();
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.kept.map((tree) => tree.path).sort(), [linked, lost, stray].sort());
  for (const tree of result.kept) assert.equal(tree.reason, "folder is not a Git worktree but still holds files");
  assert.ok(existsSync(join(lost, "README.md")));
  assert.ok(existsSync(join(stray, "a", "b", ".env")));
});

test("a tree registered in flight or younger than the grace survives; an unregistered older one is swept", async () => {
  const f = fixture();
  const inFlight = new InFlightTrees();
  const registered = join(f.worktrees, "registered");
  // Registered before it exists, as a creation path does before `git worktree add`.
  inFlight.add(registered);
  addWorktree(f, registered, "harness/registered");
  const old = addWorktree(f, join(f.checks, "old"), "harness/old");

  const past = await sweeper(f, { inFlight }).sweep();
  assert.deepEqual(past.removed, [old], "an unregistered tree past the grace is swept");
  assert.deepEqual(past.skipped, [{ path: registered, reason: "being created" }]);

  const young = addWorktree(f, join(f.checks, "young"), "harness/young");
  const now = await sweeper(f, { inFlight, now: Date.now }).sweep();
  assert.deepEqual(now.removed, []);
  assert.deepEqual(now.skipped.map((each) => each.path).sort(), [registered, young].sort());
  assert.ok(existsSync(registered) && existsSync(young));

  inFlight.delete(registered);
  const released = await sweeper(f, { inFlight }).sweep();
  assert.deepEqual(released.removed.sort(), [registered, young].sort(), "released and past the grace, both go");
});

test("scoped prune removes only missing registrations under the state home", async () => {
  const f = fixture();
  const missingHome = addWorktree(f, join(f.stateHome, "worktree-pools", "p", "gone"), "harness/gone-home");
  const missingSlot = addWorktree(f, join(f.stateHome, "worktree-pools", "p", "slot"), "harness/gone-slot");
  const missingOutside = addWorktree(f, join(f.root, "elsewhere"), "harness/gone-outside");
  const present = addWorktree(f, join(f.stateHome, "worktree-pools", "p", "present"), "harness/present");
  for (const path of [missingHome, missingSlot, missingOutside]) rmSync(path, { recursive: true });

  const result = await sweeper(f, { slotPaths: () => [missingSlot] }).sweep();
  assert.deepEqual(result.pruned, [missingHome]);
  const listed = git(f.repo, "worktree", "list", "--porcelain");
  assert.ok(!listed.includes(`worktree ${missingHome}\n`));
  assert.ok(listed.includes(`worktree ${missingSlot}\n`), "a slot row's registration is left to reconcile");
  assert.ok(listed.includes(`worktree ${missingOutside}\n`), "the operator's own worktree elsewhere is untouched");
  assert.ok(listed.includes(`worktree ${present}\n`));
  assert.ok(existsSync(present));
});

test("a kept folder keeps its problem while skipped, and is reported gone once removed", async () => {
  const f = fixture();
  const dirty = addWorktree(f, join(f.worktrees, "dirty"), "harness/dirty");
  writeFileSync(join(dirty, "work.txt"), "x");
  let occupied = false;
  const sweep = sweeper(f, {
    occupancy: async (paths) => new Map<string, Occupancy>(paths.map((path) => [path, {
      status: "known",
      occupants: occupied ? [{ pid: 1, ppid: 0, startRaw: "", startMs: 0, command: "sh", cwd: path, knownOwner: null }] : [],
    }])),
  });
  await sweep.sweep();
  const subject = sweep.problems().firstSeen?.[0]?.subject;
  assert.ok(subject?.startsWith(`dirty-orphan-folder:${dirty}:`));

  occupied = true;
  await sweep.sweep();
  assert.deepEqual(sweep.problems().firstSeen?.map((each) => each.subject), [subject], "an occupied pass keeps it");

  rmSync(dirty, { recursive: true });
  await sweep.sweep();
  const observed = sweep.problems();
  assert.deepEqual(observed.firstSeen, []);
  assert.deepEqual(observed.goneSubjects, [subject]);
  assert.deepEqual(sweep.problems().goneSubjects, [], "reported gone once");
});

test("a kept folder the sweep later removes, or a row later references, is reported gone at once", async () => {
  const f = fixture();
  const fixed = addWorktree(f, join(f.worktrees, "fixed"), "harness/fixed");
  writeFileSync(join(fixed, "work.txt"), "x");
  const claimed = addWorktree(f, join(f.checks, "claimed"), "harness/claimed");
  writeFileSync(join(claimed, "work.txt"), "x");
  let referenced: string[] = [];
  const sweep = sweeper(f, { referencedPaths: () => referenced });
  await sweep.sweep();
  const subjects = new Map(sweep.problems().firstSeen!.map((each) => [each.problem(0).link, each.subject]));
  const subjectOf = (path: string) =>
    [...subjects].find(([link]) => link.target === "unowned-tree" && link.path === path)?.[1];
  assert.ok(subjectOf(fixed) && subjectOf(claimed));

  // The operator commits and pushes the work, so the next pass removes the tree; and a row
  // starts naming the other one.
  git(fixed, "add", ".");
  git(fixed, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "done");
  git(fixed, "push", "-q", "origin", "harness/fixed");
  referenced = [claimed];
  const result = await sweep.sweep();
  assert.deepEqual(result.removed, [fixed]);

  const observed = sweep.problems();
  assert.deepEqual(observed.firstSeen, []);
  assert.deepEqual(observed.goneSubjects?.sort(), [subjectOf(claimed), subjectOf(fixed)].sort());
});

test("referenced paths are every task and task repository path and every live check lease", () => {
  const db = openDb();
  const now = Date.now();
  upsertTask(mkTask({
    id: "t1",
    repoRoot: "/repo",
    worktreePath: "/state/worktrees/t1",
    extraRepos: [{ repoRoot: "/other", worktreePath: "/state/worktrees/t1-1", branch: null, provider: "git", worktreeLeaseId: null, baseSha: null, prUrl: null, prState: null, mergedAt: null }],
  }));
  const leases = new CheckLeaseStore(db);
  for (const [attemptId, path] of [
    ["held", "/state/check-worktrees/held"],
    ["returning", "/state/check-worktrees/returning"],
    ["returned", "/state/check-worktrees/returned"],
  ]) {
    leases.insertHeld({
      attemptId: attemptId!, submissionId: "s", nodeId: attemptId!, repoRoot: "/repo",
      leasePath: path!, holderToken: "h", provider: "git", now,
    });
  }
  leases.setState("returning", "returning", now);
  leases.setState("returned", "returned", now);
  assert.deepEqual(referencedTreePaths(db).sort(), [
    "/state/check-worktrees/held",
    "/state/check-worktrees/returning",
    "/state/worktrees/t1",
    "/state/worktrees/t1-1",
  ]);
});

test("an in-flight path registered before it exists still matches once created through a symlinked parent", () => {
  const parent = mkdtempSync(join(tmpdir(), "mission-in-flight-"));
  try {
    const inFlight = new InFlightTrees();
    const path = join(parent, "tree");
    inFlight.add(path);
    mkdirSync(path);
    assert.ok(inFlight.has(realpathSync(path)));
    assert.ok(inFlight.has(path));
    inFlight.delete(realpathSync(path));
    assert.equal(inFlight.has(path), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
