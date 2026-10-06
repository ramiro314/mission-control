import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { CHECK_WORKTREES_DIR } from "../src/server/config.ts";
import { provisionWorktree } from "../src/server/dispatcher.ts";
import { enableWorktreeLongPaths } from "../src/server/git/long-paths.ts";
import { run, stubRun } from "../src/server/util/exec.ts";
import { worktreeRepositoryIdentity } from "../src/server/util/git.ts";
import { GitCheckTreeProvider } from "../src/server/workflows/check-lease.ts";
import { NativeWorktreeGit } from "../src/server/worktrees/git.ts";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function repository(): { clone: string; sha: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-long-paths-")));
  roots.push(root);
  const clone = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", clone]);
  git(clone, "config", "user.email", "test@example.com");
  git(clone, "config", "user.name", "Test");
  writeFileSync(join(clone, "README.md"), "hello\n");
  git(clone, "add", "README.md");
  git(clone, "commit", "-qm", "init");
  return { clone, sha: git(clone, "rev-parse", "HEAD") };
}

test("core.longpaths is set only on win32", async () => {
  const calls: string[][] = [];
  const execute: typeof run = async (bin, args) => {
    calls.push([bin, ...args]);
    return stubRun({ stdout: "", stderr: "", code: 0 });
  };
  for (const platform of ["darwin", "linux"] as const) {
    assert.equal(await enableWorktreeLongPaths("/repo", execute, platform), null, platform);
  }
  assert.deepEqual(calls, [], "macOS and Linux run nothing");

  assert.equal((await enableWorktreeLongPaths("C:\\repo", execute, "win32"))?.code, 0);
  assert.deepEqual(calls, [["git", "-C", "C:\\repo", "config", "core.longpaths", "true"]]);
});

test("a managed worktree added on win32 reads core.longpaths=true; on macOS nothing changes", async () => {
  for (const platform of ["win32", "darwin"] as const) {
    const { clone, sha } = repository();
    const identity = worktreeRepositoryIdentity(clone);
    assert.ok(identity);
    const steps: string[] = [];
    const recorded: typeof run = (bin, args, opts) => {
      steps.push(args.slice(2, 4).join(" "));
      return run(bin, args, opts);
    };
    const path = join(identity.poolPath, `slot-${platform}`);
    roots.push(identity.poolPath);

    const added = await new NativeWorktreeGit(recorded, platform).add(identity, path, sha);
    assert.deepEqual(added, { ok: true, value: undefined }, platform);

    if (platform === "win32") {
      assert.deepEqual(steps, ["config core.longpaths", "worktree add"], "set before the checkout that needs it");
      assert.equal(git(path, "config", "core.longpaths"), "true");
    } else {
      assert.deepEqual(steps, ["worktree add"]);
      assert.throws(() => git(path, "config", "core.longpaths"), "macOS leaves the repository config alone");
    }
  }
});

test("a failed core.longpaths write stops the add before git worktree add runs", async () => {
  const { clone, sha } = repository();
  const identity = worktreeRepositoryIdentity(clone);
  assert.ok(identity);
  roots.push(identity.poolPath);
  const steps: string[] = [];
  const failing: typeof run = async (_bin, args) => {
    steps.push(args.slice(2, 4).join(" "));
    return stubRun({ stdout: "", stderr: "error: could not lock config file", code: 255 });
  };
  const added = await new NativeWorktreeGit(failing, "win32").add(identity, join(identity.poolPath, "slot"), sha);
  assert.deepEqual(added, {
    ok: false,
    reason: "git config core.longpaths failed: error: could not lock config file",
    outcomeUnknown: false,
  });
  assert.deepEqual(steps, ["config core.longpaths"]);
});

/**
 * A real failed `core.longpaths` write: git takes `config.lock` with O_EXCL, so a directory
 * already standing there makes `git config` refuse with "could not lock config file".
 */
function lockConfig(clone: string): void {
  mkdirSync(join(clone, ".git", "config.lock"));
}

/** The registered worktrees, which a refused add must leave at the main checkout alone. */
function worktreeCount(clone: string): number {
  return git(clone, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;
}

test("the dispatcher's git fallback sets core.longpaths on win32 and nothing on macOS", async () => {
  for (const platform of ["win32", "darwin"] as const) {
    const { clone, sha } = repository();
    const tree = await provisionWorktree(clone, `fallback-${platform}`, "slug", platform, sha, 0, undefined, platform);
    assert.equal(tree.provider, "git");
    if (platform === "win32") {
      assert.equal(git(tree.path, "config", "core.longpaths"), "true");
    } else {
      assert.throws(() => git(tree.path, "config", "core.longpaths"), "macOS leaves the repository config alone");
    }
  }
});

test("a failed core.longpaths write stops the dispatcher's git fallback before it adds a worktree", async () => {
  const { clone, sha } = repository();
  lockConfig(clone);
  await assert.rejects(
    provisionWorktree(clone, "fallback-locked", "slug", "locked", sha, 0, undefined, "win32"),
    /^Error: git config core\.longpaths failed: .*could not lock config file/,
  );
  assert.equal(worktreeCount(clone), 1);
  assert.throws(() => git(clone, "rev-parse", "--verify", "refs/heads/harness/slug-locked"), "no branch was created");
});

test("check worktrees set core.longpaths on win32 and nothing on macOS", async () => {
  for (const platform of ["win32", "darwin"] as const) {
    const { clone, sha } = repository();
    const lease = await new GitCheckTreeProvider(platform).acquire({ repoRoot: clone, attemptId: `check-${platform}`, baseSha: sha });
    if (platform === "win32") {
      assert.equal(git(lease.path, "config", "core.longpaths"), "true");
    } else {
      assert.throws(() => git(lease.path, "config", "core.longpaths"), "macOS leaves the repository config alone");
    }
  }
});

test("a failed core.longpaths write stops a check worktree before it is added", async () => {
  const { clone, sha } = repository();
  lockConfig(clone);
  await assert.rejects(
    new GitCheckTreeProvider("win32").acquire({ repoRoot: clone, attemptId: "check-locked", baseSha: sha }),
    /^Error: git config core\.longpaths failed: .*could not lock config file/,
  );
  assert.equal(worktreeCount(clone), 1);
  assert.equal(existsSync(join(CHECK_WORKTREES_DIR, "check-locked")), false);
});
