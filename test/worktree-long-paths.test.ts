import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { enableWorktreeLongPaths } from "../src/server/git/long-paths.ts";
import { run, stubRun } from "../src/server/util/exec.ts";
import { worktreeRepositoryIdentity } from "../src/server/util/git.ts";
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
