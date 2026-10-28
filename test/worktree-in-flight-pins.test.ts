import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

// What is at stake: the orphan sweep skips a tree only while it is registered in flight, and
// both fallback creation paths run `git worktree add` before any row names the tree. A path
// that never registers lets a sweep remove a tree mid-creation; one that never releases exempts
// its tree from the sweep for the life of the daemon. Each case watches the daemon's one
// registry while a slowed `git worktree add` is running, then again once the creation settled.

const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-in-flight-pins-")));
process.env.HARNESS_HOME = home;
// A binary that exists, so bin resolution cannot be what fails a dispatch below.
process.env.MISSION_CLAUDE_BIN = "/bin/echo";

const { openDb } = await import("../src/server/db.ts");
const { CHECK_WORKTREES_DIR } = await import("../src/server/config.ts");
const { Dispatcher, provisionWorktree, worktreeSlotPath, verifyPinnedBase } = await import("../src/server/dispatcher.ts");
const { Registry } = await import("../src/server/registry.ts");
const { CheckLeaseManager, CheckLeaseStore } = await import("../src/server/workflows/check-lease.ts");
const { setWorktreesConfig } = await import("../src/server/worktrees/config.ts");
const { inFlightTrees } = await import("../src/server/worktrees/in-flight.ts");
const { locateExecutableSync } = await import("../src/server/executables/locator.ts");

const db = openDb();
// Native allocation positively refuses, so both creation paths take their Git fallback.
setWorktreesConfig({ enabled: false });

const realGit = locateExecutableSync("git")?.path;
assert.ok(realGit, "these tests require a real Git executable");

/**
 * A `git` that, on `worktree add`, marks that it started and waits for the test to release it,
 * then either runs the real add or fails it. Every other command is the real Git.
 */
const bin = join(home, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "git"), `#!/bin/sh
case " $* " in *" worktree add "*)
  : > "$PIN_TEST_MARK"
  i=0
  while [ ! -e "$PIN_TEST_RELEASE" ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i + 1)); done
  if [ -n "$PIN_TEST_FAIL_ADD" ]; then echo "add refused by the test" >&2; exit 1; fi
;; esac
exec "${realGit}" "$@"
`);
chmodSync(join(bin, "git"), 0o755);
const originalGit = process.env.MISSION_GIT_BIN;
process.env.MISSION_GIT_BIN = join(bin, "git");

after(() => {
  if (originalGit === undefined) delete process.env.MISSION_GIT_BIN;
  else process.env.MISSION_GIT_BIN = originalGit;
  delete process.env.MISSION_CLAUDE_BIN;
  for (const name of ["PIN_TEST_MARK", "PIN_TEST_RELEASE", "PIN_TEST_FAIL_ADD"]) delete process.env[name];
  rmSync(home, { recursive: true, force: true });
});

function mkRepo(name: string): { repo: string; head: string } {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync(realGit!, ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@test");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), `${name}\n`);
  git("add", "-A");
  git("commit", "-qm", "first");
  return { repo, head: git("rev-parse", "HEAD") };
}

let gates = 0;

/**
 * Hold the next `git worktree add` until released. `whileAdding` runs once the add has started
 * and before it may finish, which is exactly the window before any row names the tree.
 */
async function slowAdd<T>(
  create: () => Promise<T>,
  whileAdding: () => void,
  options: { failAdd?: boolean } = {},
): Promise<{ outcome: PromiseSettledResult<T> }> {
  const gate = join(home, `gate-${gates++}`);
  process.env.PIN_TEST_MARK = `${gate}.started`;
  process.env.PIN_TEST_RELEASE = `${gate}.release`;
  if (options.failAdd) process.env.PIN_TEST_FAIL_ADD = "1";
  else delete process.env.PIN_TEST_FAIL_ADD;
  const running = create();
  try {
    const deadline = Date.now() + 20_000;
    while (!existsSync(`${gate}.started`)) {
      if (Date.now() > deadline) throw new Error("git worktree add never started");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    whileAdding();
  } finally {
    writeFileSync(`${gate}.release`, "");
  }
  const [outcome] = await Promise.allSettled([running]);
  return { outcome: outcome! };
}

const localBases = async (roots: { primary: string; extras: readonly string[] }) => ({
  primary: execFileSync(realGit!, ["-C", roots.primary, "rev-parse", "HEAD"]).toString().trim(),
  extras: roots.extras.map(() => "0".repeat(40)),
});

// ---- the task overflow arm ---------------------------------------------------------------

test("a dispatch pins its fallback tree while git adds it, and releases it once the row names it", async () => {
  const { repo } = mkRepo("task-recorded");
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "pin-recorded", status: "dispatching", repoRoot: repo, agent: "claude" }));
  // The teardown the failed launch asks for receives the task row, so what it names is what
  // the row recorded.
  const recorded: Array<string | null> = [];
  const dispatcher = new Dispatcher(registry, async (task) => {
    recorded.push(task.worktreePath);
  }, { resolveBases: localBases });
  const path = worktreeSlotPath("pin-recorded", 0);

  const { outcome } = await slowAdd(
    // Refused after the row records the tree, before any agent launches.
    () => dispatcher.dispatch("pin-recorded", { missionMcp: { tools: ["report_status"] } }),
    () => assert.equal(inFlightTrees.has(path), true, "pinned before any row names the tree"),
  );
  assert.equal(outcome.status, "fulfilled");
  assert.deepEqual(recorded, [realpathSync(path)], "the task row named the tree");
  assert.equal(existsSync(path), true, "the tree was created");
  assert.equal(inFlightTrees.has(path), false, "released once the dispatch recorded or unwound it");
});

test("a dispatch whose secondary fails releases the primary's pin with its unwind", async () => {
  const { repo } = mkRepo("task-unwound");
  const broken = join(home, "task-unwound-not-a-repo");
  mkdirSync(broken);
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: "pin-unwound",
    status: "dispatching",
    repoRoot: repo,
    agent: "claude",
    extraRepos: [{
      repoRoot: broken, worktreePath: null, branch: null, provider: null, worktreeLeaseId: null,
      baseSha: null, prUrl: null, prState: null, mergedAt: null,
    }],
  }));
  const path = worktreeSlotPath("pin-unwound", 0);

  const { outcome } = await slowAdd(
    () => new Dispatcher(registry, undefined, { resolveBases: localBases }).dispatch("pin-unwound"),
    () => assert.equal(inFlightTrees.has(path), true),
  );
  assert.equal(outcome.status, "fulfilled");
  assert.match(registry.getTask("pin-unwound")?.error ?? "", /is not a git repository/);
  assert.equal(existsSync(path), false, "the primary's tree was unwound");
  assert.equal(inFlightTrees.has(path), false, "and its pin went with it");
});

test("a failed git worktree add releases the task tree's pin", async () => {
  const { repo } = mkRepo("task-add-fails");
  const path = worktreeSlotPath("pin-add-fails", 0);
  const { outcome } = await slowAdd(
    () => provisionWorktree(repo, "pin-add-fails", "slug", "fff000"),
    () => assert.equal(inFlightTrees.has(path), true),
    { failAdd: true },
  );
  assert.equal(outcome.status, "rejected");
  assert.match(String((outcome as PromiseRejectedResult).reason), /add refused by the test/);
  assert.equal(inFlightTrees.has(path), false);
});

// ---- the check fallback ------------------------------------------------------------------

test("a check pins its fallback tree while git adds it, and releases it once its row is held", async () => {
  const { repo, head } = mkRepo("check-recorded");
  const leases = new CheckLeaseManager(db, { verifyBase: verifyPinnedBase });
  const path = join(CHECK_WORKTREES_DIR, "pin-check-recorded");

  const { outcome } = await slowAdd(
    () => leases.acquireForAttempt({
      attemptId: "pin-check-recorded", submissionId: "s", nodeId: "gate", repoRoot: repo, headSha: head,
    }),
    () => assert.equal(inFlightTrees.has(path), true, "pinned before the row is inserted"),
  );
  assert.equal(outcome.status, "fulfilled");
  assert.equal(new CheckLeaseStore(db).get("pin-check-recorded")?.cleanupState, "held");
  assert.equal(inFlightTrees.has(path), false, "the held row names it now, so the pin is released");
  await leases.releaseForAttempt("pin-check-recorded");
});

test("a failed git worktree add releases the check tree's pin", async () => {
  const { repo, head } = mkRepo("check-add-fails");
  const leases = new CheckLeaseManager(db, { verifyBase: verifyPinnedBase });
  const path = join(CHECK_WORKTREES_DIR, "pin-check-add-fails");

  const { outcome } = await slowAdd(
    () => leases.acquireForAttempt({
      attemptId: "pin-check-add-fails", submissionId: "s", nodeId: "gate", repoRoot: repo, headSha: head,
    }),
    () => assert.equal(inFlightTrees.has(path), true),
    { failAdd: true },
  );
  assert.equal(outcome.status, "rejected");
  assert.equal(new CheckLeaseStore(db).get("pin-check-add-fails"), null);
  assert.equal(inFlightTrees.has(path), false);
});
