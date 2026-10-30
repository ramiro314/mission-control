import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { WorktreesConfigSchema } from "../src/shared/protocol.ts";
import { treeSeedPaths } from "../src/server/worktrees/config.ts";
import { treeGitCommonDirectory } from "../src/server/util/git.ts";
import { withinSeedPaths } from "../src/server/worktrees/seed.ts";
import {
  REGENERABLE_IGNORED_PATHS,
  UNCOMMITTED_WORK,
  UNPUBLISHED_COMMITS,
  describeWorktreeWork,
  worktreeDiscardedWork,
  worktreeReturnBlocker,
  worktreeWork,
  type WorktreeWork,
} from "../src/server/git/worktree-return-safety.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mission-return-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "repo");
  mkdirSync(path);
  const git = (...args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(path, "tracked"), "base\n");
  git("add", "."); git("commit", "-m", "base");
  git("init", "--bare", join(root, "origin"));
  git("remote", "add", "origin", join(root, "origin"));
  git("push", "-u", "origin", "main");
  return { path, git };
}

test("a clean published checkout qualifies, including after a fresh origin fetch", async (t) => {
  const { path } = fixture(t);
  assert.equal(await worktreeReturnBlocker(path, { fetch: true }), null);
});

test("Kill preserves ignored local files even when ordinary Git status is clean", async (t) => {
  const { path, git } = fixture(t);
  writeFileSync(join(path, ".gitignore"), "private-notes/\n");
  git("add", ".gitignore"); git("commit", "-m", "ignore private notes");
  git("push", "origin", "main");
  mkdirSync(join(path, "private-notes"));
  writeFileSync(join(path, "private-notes", "draft.txt"), "keep this local work\n");
  assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
  assert.match((await worktreeReturnBlocker(path, { fetch: true }))!, /ignored/);
});

for (const kind of ["unstaged", "staged", "untracked", "unpublished"] as const) {
  test(`Kill and reclaim both preserve ${kind} work`, async (t) => {
    const { path, git } = fixture(t);
    writeFileSync(join(path, kind === "untracked" ? "notes" : "tracked"), "valuable work\n");
    if (kind === "staged" || kind === "unpublished") git("add", ".");
    if (kind === "unpublished") git("commit", "-m", "local only");
    for (const regenerableIgnored of [false, true]) {
      assert.match((await worktreeReturnBlocker(path, { fetch: true, regenerableIgnored }))!, /uncommitted|unpublished/);
    }
  });
}

/** A published checkout that ignores the regenerable directories and the work kinds that must survive. */
function ignoringFixture(t: TestContext) {
  const repo = fixture(t);
  writeFileSync(join(repo.path, ".gitignore"), "node_modules/\ndist/\nbuild/\ncoverage/\n.cache/\n.turbo/\n.next/\n.evidence/\ne2e/.artifacts/\n.env\n");
  repo.git("add", ".gitignore"); repo.git("commit", "-m", "ignore");
  repo.git("push", "origin", "main");
  const put = (file: string) => {
    mkdirSync(join(repo.path, file, ".."), { recursive: true });
    writeFileSync(join(repo.path, file), "x\n");
  };
  return { ...repo, put };
}

test("reclaim discounts ignored files under every regenerable path at any depth; Kill still counts them", async (t) => {
  const { path, put } = ignoringFixture(t);
  for (const dir of REGENERABLE_IGNORED_PATHS) {
    put(`${dir}top`);
    put(`packages/app/${dir}deep/nested`);
  }
  assert.equal(await worktreeReturnBlocker(path, { fetch: true, regenerableIgnored: true }), null);
  assert.match((await worktreeReturnBlocker(path, { fetch: true }))!, /ignored/);
});

for (const file of [".evidence/report.md", "e2e/.artifacts/run/trace.zip", ".env", ".evidence/node_modules/kept"]) {
  test(`reclaim keeps a tree holding non-regenerable ignored ${file}`, async (t) => {
    const { path, put } = ignoringFixture(t);
    put("node_modules/pkg/index.js");
    put(file);
    assert.match((await worktreeReturnBlocker(path, { fetch: true, regenerableIgnored: true }))!, /ignored/);
    assert.match((await worktreeReturnBlocker(path, { fetch: true }))!, /ignored/);
  });
}

test("reclaim discounts only ignored entries: untracked and modified files under regenerable paths still block", async (t) => {
  const { path, git } = fixture(t);
  mkdirSync(join(path, "node_modules"));
  writeFileSync(join(path, "node_modules", "vendored.js"), "base\n");
  git("add", "."); git("commit", "-m", "vendor"); git("push", "origin", "main");
  writeFileSync(join(path, "node_modules", "vendored.js"), "patched\n");
  assert.match((await worktreeReturnBlocker(path, { fetch: true, regenerableIgnored: true }))!, /uncommitted/);
  git("checkout", "--", "node_modules/vendored.js");
  mkdirSync(join(path, "dist"));
  writeFileSync(join(path, "dist", "out.js"), "built by hand\n");
  assert.match((await worktreeReturnBlocker(path, { fetch: true, regenerableIgnored: true }))!, /untracked/);
});

test("reclaim keeps an ignored file inside a tracked directory that shares a regenerable name", async (t) => {
  const { path, git } = fixture(t);
  mkdirSync(join(path, "build"));
  writeFileSync(join(path, "build", "icon.png"), "source asset\n");
  writeFileSync(join(path, ".gitignore"), ".env\n");
  git("add", "."); git("commit", "-m", "tracked build resources"); git("push", "origin", "main");
  writeFileSync(join(path, "build", ".env"), "SECRET=local\n");
  assert.match((await worktreeReturnBlocker(path, { fetch: true, regenerableIgnored: true }))!, /ignored/);
});

for (const file of ["dist", "mybuild/notes", "node_modules_backup/kept"]) {
  test(`reclaim keeps ignored ${file}, a near miss of a regenerable directory name`, async (t) => {
    const { path, git } = fixture(t);
    writeFileSync(join(path, ".gitignore"), "dist\nmybuild/\nnode_modules_backup/\n");
    git("add", ".gitignore"); git("commit", "-m", "ignore near misses"); git("push", "origin", "main");
    mkdirSync(join(path, file, ".."), { recursive: true });
    writeFileSync(join(path, file), "real work\n");
    assert.match((await worktreeReturnBlocker(path, { fetch: true, regenerableIgnored: true }))!, /ignored/);
  });
}

test("deleted upstream branches cannot vouch for local commits through stale refs", async (t) => {
  const { path, git } = fixture(t);
  git("checkout", "-b", "task");
  writeFileSync(join(path, "tracked"), "branch work\n");
  git("commit", "-am", "task"); git("push", "origin", "task");
  assert.equal(await worktreeReturnBlocker(path), null);
  execFileSync("git", ["--git-dir", join(path, "..", "origin"), "update-ref", "-d", "refs/heads/task"]);
  assert.match((await worktreeReturnBlocker(path, { fetch: true }))!, /unpublished/);
});

test("offline origin, missing checkout, nested path and malformed evidence fail closed", async (t) => {
  const { path, git } = fixture(t);
  git("remote", "set-url", "origin", join(path, "missing-origin"));
  assert.match((await worktreeReturnBlocker(path, { fetch: true }))!, /refreshed/);
  assert.ok(await worktreeReturnBlocker(join(path, "missing")));
  mkdirSync(join(path, "nested"));
  assert.match((await worktreeReturnBlocker(join(path, "nested")))!, /identity/);
  assert.match((await worktreeReturnBlocker(path, { execute: async (_cmd, args) => ({
    code: 0, stderr: "", outcomeUnknown: false, overflowed: false, stdout: args.includes("rev-parse") ? path : args.includes("rev-list") ? "not a count" : "",
  }) }))!, /compared/);
});

test("the discard list names uncommitted work and unpushed commits together, where the blocker stops at one", async (t) => {
  const { path, git } = fixture(t);
  assert.deepEqual(await worktreeDiscardedWork(path), []);
  writeFileSync(join(path, "tracked"), "local only\n");
  git("commit", "-qam", "local only");
  assert.deepEqual(await worktreeDiscardedWork(path), [UNPUBLISHED_COMMITS]);
  writeFileSync(join(path, "notes"), "untracked\n");
  assert.equal(await worktreeReturnBlocker(path), UNCOMMITTED_WORK, "the blocker reports only the first");
  assert.deepEqual(await worktreeDiscardedWork(path), [UNCOMMITTED_WORK, UNPUBLISHED_COMMITS]);
  // An unreadable tree states nothing: the discard list is never a refusal.
  assert.deepEqual(await worktreeDiscardedWork(join(path, "missing")), []);
});

/**
 * The rule as `worktreeReturnBlocker` applied it before `worktreeWork` existed, kept here as the
 * oracle: any ignored entry that is a regenerable directory is discounted, every other `-z`
 * field is work, and only a tree with none is compared against origin.
 */
function previousRule(path: string, regenerableIgnored: boolean): "work" | "unpushed" | "clean" {
  const run = (...args: string[]) => execFileSync("git", ["--no-optional-locks", "-C", path, ...args], { encoding: "utf8" });
  const status = run("status", "--porcelain", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none");
  const regenerable = (entry: string) => entry.startsWith("!! ") &&
    REGENERABLE_IGNORED_PATHS.some((dir) => `/${entry.slice(3)}`.endsWith(`/${dir}`));
  if (status.split("\0").filter((entry) => entry.trim()).some((entry) => !(regenerableIgnored && regenerable(entry)))) return "work";
  return run("rev-list", "--count", "HEAD", "--not", "--remotes=origin").trim() === "0" ? "clean" : "unpushed";
}

const decision = (work: WorktreeWork) => work.status === "work" ? work.entry.kind === "unpushed" ? "unpushed" : "work" : work.status;

test("worktreeWork names the first blocking entry by path and kind, and decides exactly as the previous rule", async (t) => {
  const cases: Array<{ name: string; plant: (repo: ReturnType<typeof ignoringFixture>) => void; entry: WorktreeWork }> = [
    { name: "clean", plant: () => {}, entry: { status: "clean" } },
    {
      name: "a tracked change",
      plant: ({ path }) => writeFileSync(join(path, "tracked"), "edited\n"),
      entry: { status: "work", entry: { kind: "tracked", path: "tracked" } },
    },
    {
      name: "a staged rename, whose source field is not a second entry",
      plant: ({ git }) => git("mv", "tracked", "renamed"),
      entry: { status: "work", entry: { kind: "tracked", path: "renamed" } },
    },
    {
      name: "an untracked file with a space in its name",
      plant: ({ put }) => put("notes/draft one.md"),
      entry: { status: "work", entry: { kind: "untracked", path: "notes/draft one.md" } },
    },
    {
      name: "an ignored file outside the regenerable list",
      plant: ({ put }) => { put("node_modules/pkg/index.js"); put(".env"); },
      entry: { status: "work", entry: { kind: "ignored", path: ".env" } },
    },
    {
      name: "an unpushed commit",
      plant: ({ path, git }) => { writeFileSync(join(path, "tracked"), "local\n"); git("commit", "-qam", "local only"); },
      entry: { status: "work", entry: { kind: "unpushed", path: "HEAD" } },
    },
    {
      name: "only regenerable ignored directories",
      plant: ({ put }) => { put("node_modules/pkg/index.js"); put("packages/app/dist/out.js"); },
      entry: { status: "clean" },
    },
  ];
  for (const each of cases) {
    const repo = ignoringFixture(t);
    each.plant(repo);
    assert.deepEqual(await worktreeWork(repo.path, { fetch: true, regenerableIgnored: true }), each.entry, each.name);
    for (const regenerableIgnored of [false, true]) {
      const work = await worktreeWork(repo.path, { regenerableIgnored });
      assert.equal(decision(work), previousRule(repo.path, regenerableIgnored), `${each.name}, regenerableIgnored ${regenerableIgnored}`);
      const blocker = await worktreeReturnBlocker(repo.path, { regenerableIgnored });
      assert.equal(blocker, work.status === "clean" ? null : work.status === "work" && work.entry.kind === "unpushed" ? UNPUBLISHED_COMMITS : UNCOMMITTED_WORK);
    }
  }
  // Without the discount, a regenerable directory is the first ignored entry Git lists.
  const repo = ignoringFixture(t);
  repo.put("node_modules/pkg/index.js");
  assert.deepEqual(await worktreeWork(repo.path), { status: "work", entry: { kind: "ignored", path: "node_modules/" } });
});

test("worktreeWork reports a failed read as unknown, never as clean", async (t) => {
  const { path } = fixture(t);
  assert.deepEqual(await worktreeWork(join(path, "missing")), { status: "unknown", reason: "checkout identity could not be verified" });
  assert.deepEqual(await worktreeWork(path, { execute: async (_cmd, args) => ({
    code: args.includes("status") ? 1 : 0, stderr: "", outcomeUnknown: false, overflowed: false, stdout: path,
  }) }), { status: "unknown", reason: "working tree could not be read" });
});

test("each blocking kind reads as a phrase naming its path", () => {
  assert.equal(describeWorktreeWork({ kind: "tracked", path: "src/a.ts" }), "uncommitted change to src/a.ts");
  assert.equal(describeWorktreeWork({ kind: "untracked", path: "notes.md" }), "untracked notes.md");
  assert.equal(describeWorktreeWork({ kind: "ignored", path: ".env" }), "ignored .env");
  assert.equal(describeWorktreeWork({ kind: "unpushed", path: "HEAD" }), "unpushed commits on HEAD");
});

/** Every path under `root` with its kind, size, mtime and content: what "unchanged" means here. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      out.push(`${relative(root, path)} ${stat.isDirectory() ? "d" : "f"} ${stat.size} ${stat.mtimeMs}`);
      if (stat.isDirectory()) walk(path);
      else out.push(readFileSync(path, "utf8"));
    }
  };
  walk(root);
  return out;
}

/**
 * A linked worktree of an ignoring checkout, as a pool or overflow tree is: its `.git` is a file
 * naming the main checkout's common directory, which keys the pool's claim. The `.yarn` install
 * state, `.idea/` and `.env` are ignored there, as they are in upstart-web-frontend.
 */
function linkedTree(t: TestContext) {
  const repo = ignoringFixture(t);
  writeFileSync(join(repo.path, ".git", "info", "exclude"), ".yarn/install-state.gz\n.idea/\n");
  const tree = join(repo.path, "..", "tree");
  repo.git("worktree", "add", "-q", "--detach", tree, "HEAD");
  const put = (file: string) => {
    mkdirSync(join(tree, file, ".."), { recursive: true });
    writeFileSync(join(tree, file), "x\n");
  };
  const claimed = (paths: string[]) => WorktreesConfigSchema.parse({
    repositories: {
      [realpathSync(join(repo.path, ".git"))]: { claim: { steps: [{ argv: ["yarn", "install"] }], seed: { paths } } },
    },
  });
  return { tree, put, claimed };
}

test("delete rule: a pool's seed paths are regenerable, while .idea/ and .env are still work", async (t) => {
  const { tree, put, claimed } = linkedTree(t);
  const config = claimed(["node_modules", "apps/*/node_modules", ".yarn/install-state.gz"]);
  const seedPaths = treeSeedPaths(tree, config);
  assert.deepEqual(seedPaths, ["node_modules", "apps/*/node_modules", ".yarn/install-state.gz"], "the tree maps to its pool by common directory");
  put(".yarn/install-state.gz");
  put("node_modules/pkg/index.js");
  const deleteRule = { fetch: true, regenerableIgnored: true, seedPaths } as const;
  assert.deepEqual(await worktreeWork(tree, deleteRule), { status: "clean" });
  assert.equal(await worktreeReturnBlocker(tree, deleteRule), null);
  assert.deepEqual(await worktreeDiscardedWork(tree, deleteRule), []);

  put(".idea/workspace.xml");
  assert.deepEqual(await worktreeWork(tree, deleteRule), { status: "work", entry: { kind: "ignored", path: ".idea/" } });
  rmSync(join(tree, ".idea"), { recursive: true });
  put(".env");
  const before = snapshot(tree);
  assert.deepEqual(await worktreeWork(tree, deleteRule), { status: "work", entry: { kind: "ignored", path: ".env" } });
  assert.deepEqual(await worktreeDiscardedWork(tree, deleteRule), [UNCOMMITTED_WORK]);
  assert.deepEqual(snapshot(tree), before, "the check leaves every file in the tree as it was");
});

test("delete rule: a pool with no claim, and a folder with no repository, get only the built-in list", async (t) => {
  const { tree, put, claimed } = linkedTree(t);
  put(".yarn/install-state.gz");
  put("node_modules/pkg/index.js");
  const noClaim = WorktreesConfigSchema.parse({ repositories: {} });
  assert.deepEqual(treeSeedPaths(tree, noClaim), []);
  assert.deepEqual(
    await worktreeWork(tree, { regenerableIgnored: true, seedPaths: treeSeedPaths(tree, noClaim) }),
    { status: "work", entry: { kind: "ignored", path: ".yarn/install-state.gz" } },
  );
  // Another pool's claim never applies: the key is this tree's own common directory.
  const elsewhere = WorktreesConfigSchema.parse({
    repositories: { "/elsewhere/.git": { claim: { steps: [{ argv: ["yarn"] }], seed: { paths: [".yarn/install-state.gz"] } } } },
  });
  assert.deepEqual(treeSeedPaths(tree, elsewhere), []);
  const bare = mkdtempSync(join(tmpdir(), "mission-no-repo-"));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.deepEqual(treeSeedPaths(bare, claimed([".yarn/install-state.gz"])), [], "no .git of its own, and no walking up");
});

test("a checkout whose .git is a directory maps to its own pool; a .git file naming no gitdir maps to none", async (t) => {
  const { path, git } = ignoringFixture(t);
  writeFileSync(join(path, ".git", "info", "exclude"), ".yarn/install-state.gz\n");
  const config = WorktreesConfigSchema.parse({
    repositories: {
      [realpathSync(join(path, ".git"))]: { claim: { steps: [{ argv: ["yarn"] }], seed: { paths: [".yarn/install-state.gz"] } } },
    },
  });
  // Keyed as `worktreeRepositoryIdentity` keys a pool: the physical common directory.
  assert.equal(treeGitCommonDirectory(path), realpathSync(git("rev-parse", "--path-format=absolute", "--git-common-dir")));
  const seedPaths = treeSeedPaths(path, config);
  assert.deepEqual(seedPaths, [".yarn/install-state.gz"]);
  mkdirSync(join(path, ".yarn"));
  writeFileSync(join(path, ".yarn", "install-state.gz"), "state\n");
  assert.deepEqual(await worktreeWork(path, { regenerableIgnored: true, seedPaths }), { status: "clean" });

  const malformed = mkdtempSync(join(tmpdir(), "mission-malformed-git-"));
  t.after(() => rmSync(malformed, { recursive: true, force: true }));
  writeFileSync(join(malformed, ".git"), "not a gitdir pointer\n");
  assert.equal(treeGitCommonDirectory(malformed), null);
  assert.deepEqual(treeSeedPaths(malformed, config), []);
});

test("seed paths match an ignored entry segment by segment, as the seed matches them", () => {
  const globs = ["node_modules", "apps/*/node_modules", ".yarn/install-state.gz"];
  for (const path of ["node_modules/", "node_modules/pkg/index.js", "apps/web/node_modules/", ".yarn/install-state.gz"]) {
    assert.equal(withinSeedPaths(path, globs), true, path);
  }
  for (const path of ["apps/", "apps/web/dist/", "packages/web/node_modules/", ".yarn/", ".yarn/cache/x.zip", "apps/.hidden/node_modules/"]) {
    assert.equal(withinSeedPaths(path, globs), false, path);
  }
  assert.equal(withinSeedPaths(".git/x", ["*"]), false, ".git is never a seed path");
  assert.equal(withinSeedPaths("anything", []), false);
});
