import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REGENERABLE_IGNORED_PATHS,
  RESET_WORK_LIMIT,
  UNCOMMITTED_WORK,
  UNPUBLISHED_COMMITS,
  describeWorktreeResetWork,
  describeWorktreeWork,
  worktreeDiscardedWork,
  worktreeResetWork,
  worktreeResetWorkKey,
  worktreeReturnBlocker,
  worktreeWork,
  type WorktreeResetWork,
  type WorktreeWork,
} from "../src/server/git/worktree-return-safety.ts";
import { run, type RunResult } from "../src/server/util/exec.ts";

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

/**
 * A published checkout shaped like a uwf slot: its `.gitignore` ignores a warm install, an
 * IDE folder, build info, local secrets and evidence. Targets are built as commits on top of
 * HEAD without touching the working tree, so the slot holds exactly what each case planted.
 */
function resetFixture(t: TestContext, options: { ignoreCase?: boolean } = {}) {
  const repo = fixture(t);
  if (options.ignoreCase !== undefined) repo.git("config", "core.ignorecase", String(options.ignoreCase));
  const ignore = ".yarn/install-state.gz\n.idea/\n*.tsbuildinfo\n.env\n.evidence/\nnode_modules/\n";
  writeFileSync(join(repo.path, ".gitignore"), ignore);
  repo.git("add", ".gitignore"); repo.git("commit", "-m", "ignore");
  repo.git("push", "origin", "main");
  const put = (file: string) => {
    mkdirSync(join(repo.path, file, ".."), { recursive: true });
    writeFileSync(join(repo.path, file), "local\n");
  };
  let count = 0;
  /** A commit on top of HEAD that writes each file (or symlink) and removes each null. */
  const target = (changes: Record<string, string | { symlink: string } | { gitlink: string } | null> = {}) => {
    const env = { ...process.env, GIT_INDEX_FILE: join(repo.path, "..", `target-index-${count += 1}`) };
    const git = (args: string[], input?: string) =>
      execFileSync("git", ["-C", repo.path, ...args], { encoding: "utf8", env, input }).trim();
    git(["read-tree", "HEAD"]);
    for (const [file, content] of Object.entries(changes)) {
      if (content === null) {
        git(["update-index", "--force-remove", file]);
        continue;
      }
      if (typeof content === "object" && "gitlink" in content) {
        git(["update-index", "--add", "--cacheinfo", `160000,${content.gitlink},${file}`]);
        continue;
      }
      const symlink = typeof content === "object";
      const blob = git(["hash-object", "-w", "--stdin"], symlink ? content.symlink : content);
      git(["update-index", "--add", "--cacheinfo", `${symlink ? "120000" : "100644"},${blob},${file}`]);
    }
    return git(["commit-tree", git(["write-tree"]), "-p", "HEAD", "-m", "target"]);
  };
  return { ...repo, put, target, ignore };
}

/** Every file and directory under `root`, `.git` included, with its bytes. */
function snapshot(root: string): Map<string, string> {
  const seen = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stat = lstatSync(full);
      const relative = full.slice(root.length);
      if (stat.isDirectory()) {
        seen.set(relative, `dir ${stat.mode}`);
        walk(full);
      } else {
        seen.set(relative, `${stat.mode} ${stat.mtimeMs} ${stat.isSymbolicLink() ? readlinkSync(full) : readFileSync(full).toString("base64")}`);
      }
    }
  };
  walk(root);
  return seen;
}

const resetWork = (work: WorktreeResetWork) =>
  work.status === "work" ? work.entries.map(({ kind, path }) => `${kind} ${path}`) : work.status;

/** A read's named entries, without the key that identifies the whole set. */
const named = (work: WorktreeResetWork) => {
  if (work.status !== "work") return work;
  const { key: _key, ...rest } = work;
  return rest;
};

test("reset rule: ignored files a target keeps ignored are not work, and the check writes nothing", async (t) => {
  const repo = resetFixture(t);
  for (const file of [".yarn/install-state.gz", ".idea/workspace.xml", "apps/personal-loans/tsconfig.tsbuildinfo", ".env", ".evidence/shot.png", "node_modules/pkg/index.js"]) {
    repo.put(file);
  }
  // A target whose ignore rules match HEAD's, with an unrelated change.
  const target = repo.target({ "src/new.ts": "export {};\n" });
  const before = snapshot(repo.path);
  assert.deepEqual(await worktreeResetWork(repo.path, { targetCommit: target }), { status: "clean" });
  assert.deepEqual(await worktreeWork(repo.path, { rule: "reset", targetCommit: target }), { status: "clean" });
  assert.deepEqual(snapshot(repo.path), before, "the slot's files are byte-for-byte unchanged");
  // The return rule still counts each of them, which is what safe Kill keeps.
  assert.deepEqual(await worktreeWork(repo.path, { regenerableIgnored: true }), { status: "work", entry: { kind: "ignored", path: ".env" } });
});

test("reset rule: a tracked change, an untracked file and an unpushed commit are work; conductor scratch is not", async (t) => {
  const repo = resetFixture(t);
  const target = repo.target();
  mkdirSync(join(repo.path, ".pipeline"));
  writeFileSync(join(repo.path, ".pipeline", "conduct-state.json"), "{}\n");
  assert.deepEqual(await worktreeResetWork(repo.path, { targetCommit: target }), { status: "clean" });
  writeFileSync(join(repo.path, "tracked"), "edited\n");
  repo.put("notes.md");
  assert.deepEqual(resetWork(await worktreeResetWork(repo.path, { targetCommit: target })), ["tracked tracked", "untracked notes.md"]);
  repo.git("add", "."); repo.git("commit", "-qm", "local only");
  assert.deepEqual(resetWork(await worktreeResetWork(repo.path, { targetCommit: target })), ["unpushed HEAD"]);
});

test("reset rule: an ignored entry the target overwrites or un-ignores is work, and names why", async (t) => {
  const cases: Array<{
    name: string;
    plant: string[];
    /** A pattern HEAD ignores beyond the fixture's, so the planted entry is ignored now. */
    headIgnores?: string;
    changes: Parameters<ReturnType<typeof resetFixture>["target"]>[0] | ((ignore: string) => Parameters<ReturnType<typeof resetFixture>["target"]>[0]);
    work: Array<{ path: string; because: string }>;
  }> = [
    {
      name: "a target that tracks a file inside the ignored .idea/",
      plant: [".idea/workspace.xml"],
      changes: { ".idea/codeStyles/Project.xml": "<x/>\n" },
      work: [{ path: ".idea/", because: "the target tracks .idea/codeStyles/Project.xml" }],
    },
    {
      name: "a target that tracks the ignored file itself",
      plant: [".env"],
      changes: { ".env": "SHARED=1\n" },
      work: [{ path: ".env", because: "the target tracks .env" }],
    },
    {
      name: "a target whose .gitignore no longer ignores .env or .evidence/",
      plant: [".env", ".evidence/shot.png", ".yarn/install-state.gz"],
      changes: (ignore) => ({ ".gitignore": ignore.replace(".env\n", "").replace(".evidence/\n", "") }),
      work: [
        { path: ".env", because: "the target's .gitignore files no longer ignore it" },
        { path: ".evidence/", because: "the target's .gitignore files no longer ignore it" },
      ],
    },
    {
      name: "a target that stops ignoring node_modules/, which is regenerable",
      plant: ["node_modules/pkg/index.js"],
      changes: (ignore) => ({ ".gitignore": ignore.replace("node_modules/\n", "") }),
      work: [],
    },
    {
      name: "a target with a nested .gitignore that still ignores the entry",
      plant: [".env"],
      changes: (ignore) => ({ ".gitignore": ignore.replace(".env\n", ""), "apps/.gitignore": "dist/\n", "keep/.gitignore": "x\n" }),
      work: [{ path: ".env", because: "the target's .gitignore files no longer ignore it" }],
    },
    {
      name: "a target that tracks apps/foo/.local as a file above an ignored file",
      plant: ["apps/foo/.local/notes.md"],
      headIgnores: ".local/\n",
      changes: { "apps/foo/.local": "file\n" },
      work: [{ path: "apps/foo/.local/", because: "the target tracks apps/foo/.local" }],
    },
    {
      name: "a target that tracks apps/foo/.local as a submodule above an ignored file",
      plant: ["apps/foo/.local/notes.md"],
      headIgnores: ".local/\n",
      changes: { "apps/foo/.local": { gitlink: "1".repeat(40) } },
      work: [{ path: "apps/foo/.local/", because: "the target tracks apps/foo/.local" }],
    },
    {
      name: "a target that tracks an NFD-spelled path inside an NFC-spelled ignored directory",
      plant: ["caf\u00e9/notes.md"],
      headIgnores: "caf\u00e9/\n",
      changes: { "cafe\u0301/x": "x\n" },
      work: [{ path: "caf\u00e9/", because: "the target tracks cafe\u0301/x" }],
    },
    {
      name: "a target that tracks an NFC-spelled path inside an NFD-spelled ignored directory",
      plant: ["cafe\u0301/notes.md"],
      headIgnores: "cafe\u0301/\n",
      changes: { "caf\u00e9/x": "x\n" },
      work: [{ path: "cafe\u0301/", because: "the target tracks caf\u00e9/x" }],
    },
    {
      name: "a target that tracks apps/foo/.local as a symlink above an ignored file",
      plant: ["apps/foo/.local/notes.md"],
      headIgnores: ".local/\n",
      changes: { "apps/foo/.local": { symlink: "../elsewhere" } },
      work: [{ path: "apps/foo/.local/", because: "the target tracks apps/foo/.local" }],
    },
  ];
  for (const each of cases) {
    const repo = resetFixture(t);
    if (each.headIgnores) {
      writeFileSync(join(repo.path, ".gitignore"), repo.ignore + each.headIgnores);
      repo.git("commit", "-qam", "ignore more"); repo.git("push", "-q", "origin", "main");
    }
    const changes = typeof each.changes === "function" ? each.changes(repo.ignore) : each.changes;
    for (const file of each.plant) repo.put(file);
    const target = repo.target(changes);
    const before = snapshot(repo.path);
    const work = await worktreeResetWork(repo.path, { targetCommit: target });
    assert.deepEqual(
      work.status === "work" ? work.entries : work.status,
      each.work.length === 0 ? "clean" : each.work.map((entry) => ({ kind: "ignored", ...entry })),
      each.name,
    );
    assert.deepEqual(snapshot(repo.path), before, `${each.name}: the slot's files are unchanged`);
    if (each.work.length > 0) {
      assert.deepEqual(await worktreeWork(repo.path, { rule: "reset", targetCommit: target }), {
        status: "work", entry: { kind: "ignored", path: each.work[0]!.path },
      }, each.name);
    }
  }
});

for (const ignoreCase of [true, false, undefined]) {
  test(`reset rule: a target tracking .Idea/x overlaps the ignored .idea/ (core.ignorecase ${ignoreCase ?? "unset"})`, async (t) => {
    const repo = resetFixture(t, { ignoreCase });
    repo.put(".idea/workspace.xml");
    const target = repo.target({ ".Idea/x": "x\n" });
    assert.deepEqual(named(await worktreeResetWork(repo.path, { targetCommit: target })), {
      status: "work",
      entries: [{ kind: "ignored", path: ".idea/", because: "the target tracks .Idea/x" }],
      more: false,
    });
  });
}

test("reset rule: a listing or evaluation that fails, overflows or times out counts as work", async (t) => {
  const repo = resetFixture(t);
  repo.put(".env");
  repo.put(".yarn/install-state.gz");
  const target = repo.target({ ".gitignore": repo.ignore.replace("*.tsbuildinfo\n", "") });
  const stubbed = (match: (args: string[]) => boolean, result: Partial<RunResult>): typeof run =>
    async (bin, args, options) => match(args)
      ? { stdout: "", stderr: "", code: 1, outcomeUnknown: false, overflowed: false, ...result }
      : run(bin, args, options);
  const failures: Array<{ name: string; execute: typeof run; because: string }> = [
    { name: "a failed listing", execute: stubbed((args) => args.includes("ls-tree"), {}), because: "the target's tracked paths could not be listed" },
    { name: "an overflowed listing", execute: stubbed((args) => args.includes("ls-tree"), { overflowed: true }), because: "the target tracks more paths than the check reads" },
    { name: "a timed-out .gitignore diff", execute: stubbed((args) => args.includes("diff"), { outcomeUnknown: true, timedOut: true }), because: "the target's .gitignore files could not be compared" },
    { name: "a failed blob read", execute: stubbed((args) => args.includes("checkout"), { code: 128 }), because: "the target's .gitignore files could not be read" },
    { name: "a timed-out ignore evaluation", execute: stubbed((args) => args.includes("check-ignore"), { outcomeUnknown: true, timedOut: true }), because: "the target's ignore rules could not be evaluated" },
    { name: "an unreadable ignore setting", execute: stubbed((args) => args.includes("core.ignorecase") && args.includes("config"), { code: 3 }), because: "the slot's ignore settings could not be read" },
  ];
  // Without a stub the target keeps both ignored, so each refusal below is the failure's alone.
  assert.deepEqual(await worktreeResetWork(repo.path, { targetCommit: target }), { status: "clean" });
  for (const each of failures) {
    assert.deepEqual(named(await worktreeResetWork(repo.path, { targetCommit: target, execute: each.execute })), {
      status: "work",
      entries: [
        { kind: "ignored", path: ".env", because: each.because },
        { kind: "ignored", path: ".yarn/install-state.gz", because: each.because },
      ],
      more: false,
    }, each.name);
  }
  assert.deepEqual(named(await worktreeResetWork(repo.path, { targetCommit: "0".repeat(40) })), {
    status: "work",
    entries: [".env", ".yarn/install-state.gz"].map((path) => ({ kind: "ignored", path, because: "the reset target could not be read" })),
    more: false,
  });
});

test("reset rule: the work set's key ignores why an entry counts, and the description names it", async (t) => {
  const repo = resetFixture(t);
  repo.put(".env");
  const tracks = await worktreeResetWork(repo.path, { targetCommit: repo.target({ ".env": "SHARED=1\n" }) });
  const unignores = await worktreeResetWork(repo.path, { targetCommit: repo.target({ ".gitignore": repo.ignore.replace(".env\n", "") }) });
  assert.notDeepEqual(named(tracks), named(unignores), "the two targets discard .env for different reasons");
  assert.equal(worktreeResetWorkKey(tracks), worktreeResetWorkKey(unignores));
  assert.notEqual(worktreeResetWorkKey(tracks), worktreeResetWorkKey({ status: "clean" }));
  assert.equal(
    describeWorktreeResetWork({ kind: "ignored", path: ".idea/", because: "the target tracks .Idea/x" }),
    "ignored .idea/ (the target tracks .Idea/x)",
  );
});

test("reset rule: the work set stops at RESET_WORK_LIMIT entries and says there are more, which changes its key", async (t) => {
  const repo = resetFixture(t);
  const target = repo.target();
  for (let index = 0; index < RESET_WORK_LIMIT; index += 1) repo.put(`notes/${String(index).padStart(2, "0")}.md`);
  const full = await worktreeResetWork(repo.path, { targetCommit: target });
  assert.equal(full.status === "work" && full.entries.length, RESET_WORK_LIMIT);
  assert.equal(full.status === "work" && full.more, false);
  repo.put("notes/99.md");
  const over = await worktreeResetWork(repo.path, { targetCommit: target });
  assert.equal(over.status === "work" && over.entries.length, RESET_WORK_LIMIT);
  assert.equal(over.status === "work" && over.more, true);
  assert.notEqual(worktreeResetWorkKey(over), worktreeResetWorkKey(full), "an entry past the limit still changes the work set");
});

test("reset rule: an ignored entry past RESET_WORK_LIMIT that a moved default would discard still changes the key", async (t) => {
  const repo = resetFixture(t);
  for (let index = 0; index <= RESET_WORK_LIMIT; index += 1) repo.put(`notes/${String(index).padStart(2, "0")}.md`);
  repo.put(".env");
  const keeps = await worktreeResetWork(repo.path, { targetCommit: repo.target() });
  const deletes = await worktreeResetWork(repo.path, { targetCommit: repo.target({ ".gitignore": repo.ignore.replace(".env\n", "") }) });
  assert.deepEqual(named(keeps), named(deletes), "the named entries and their bound are identical");
  assert.notEqual(worktreeResetWorkKey(keeps), worktreeResetWorkKey(deletes), ".env, past the bound, is in one set and not the other");
});

test("reset rule: an entry ignored only by the working tree's own .gitignore edits is work when the reset restores HEAD's", async (t) => {
  const cases: Array<{ name: string; plant: (repo: ReturnType<typeof resetFixture>) => void; work: string[] }> = [
    {
      name: "a tracked .gitignore edit",
      plant: (repo) => {
        writeFileSync(join(repo.path, ".gitignore"), `${repo.ignore}.agent-notes/\n`);
        repo.put(".agent-notes/plan.md");
      },
      work: ["tracked .gitignore", "ignored .agent-notes/"],
    },
    {
      name: "a staged new .gitignore",
      plant: (repo) => {
        mkdirSync(join(repo.path, "apps", "x"), { recursive: true });
        writeFileSync(join(repo.path, "apps", "x", ".gitignore"), "scratch/\n");
        repo.git("add", "apps/x/.gitignore");
        repo.put("apps/x/scratch/plan.md");
      },
      work: ["tracked apps/x/.gitignore", "ignored apps/x/scratch/"],
    },
    {
      name: "an untracked .gitignore",
      plant: (repo) => {
        mkdirSync(join(repo.path, "apps", "y"), { recursive: true });
        writeFileSync(join(repo.path, "apps", "y", ".gitignore"), "scratch/\n");
        repo.put("apps/y/scratch/plan.md");
      },
      work: ["untracked apps/y/.gitignore", "ignored apps/y/scratch/"],
    },
  ];
  for (const each of cases) {
    const repo = resetFixture(t);
    repo.put(".yarn/install-state.gz");
    // The target's .gitignore files are HEAD's, so a HEAD-to-target diff alone would clear them.
    const target = repo.target({ "src/new.ts": "export {};\n" });
    each.plant(repo);
    const before = snapshot(repo.path);
    const work = await worktreeResetWork(repo.path, { targetCommit: target });
    assert.deepEqual(resetWork(work), each.work, each.name);
    assert.equal(
      work.status === "work" && work.entries.at(-1)?.because,
      "the target's .gitignore files no longer ignore it",
      each.name,
    );
    assert.deepEqual(snapshot(repo.path), before, `${each.name}: the slot's files are unchanged`);
  }
});
