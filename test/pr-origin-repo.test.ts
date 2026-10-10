import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A fake `gh` that records its argv and reports no pull requests, set in the file body as the
// suite's other executable overrides are.
const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-origin-repo-gh-"));
const fakeGhArgv = join(fakeGhDir, "argv.json");
writeFileSync(
  join(fakeGhDir, "gh"),
  `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(fakeGhArgv)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write("[]");\n`,
  { mode: 0o755 },
);
process.env.MISSION_GH_BIN = join(fakeGhDir, "gh");
process.on("exit", () => rmSync(fakeGhDir, { recursive: true, force: true }));

const { originGitHubRepository } = await import("../src/server/inspector/github.ts");
const { prListArgs, queryPr } = await import("../src/server/pr.ts");
const { openPullRequestCommand } = await import("../src/shared/pr-command.mjs");

// A fork of an org that enforces SAML SSO: `gh` left to choose prefers the `upstream` remote
// outside a terminal, and asking about that parent fails for a login not authorized there.
function forkCheckout(origin: string | null): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pr-origin-repo-"));
  execFileSync("git", ["init", "-q", dir]);
  if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  execFileSync("git", ["-C", dir, "remote", "add", "upstream", "https://github.com/org/parent.git"]);
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the checkout's origin names the repository, never its upstream", async (t) => {
  for (const url of ["https://github.com/me/fork.git", "git@github.com:me/fork.git"]) {
    const repo = forkCheckout(url);
    t.after(repo.done);
    assert.deepEqual(await originGitHubRepository(repo.dir), { owner: "me", repo: "fork" });
  }
});

test("no origin, or a non-GitHub one, names no repository", async (t) => {
  const none = forkCheckout(null);
  t.after(none.done);
  assert.equal(await originGitHubRepository(none.dir), null);
  const other = forkCheckout("https://gitlab.com/me/fork.git");
  t.after(other.done);
  assert.equal(await originGitHubRepository(other.dir), null);
});

test("the branch lookup pins --repo to origin, and leaves gh to choose without one", () => {
  const pinned = prListArgs("feat/x", { owner: "me", repo: "fork" });
  assert.deepEqual(pinned.slice(0, 6), ["pr", "list", "--repo", "me/fork", "--head", "feat/x"]);
  const unpinned = prListArgs("feat/x", null);
  assert.deepEqual(unpinned.slice(0, 4), ["pr", "list", "--head", "feat/x"]);
  assert.ok(!unpinned.includes("--repo"));
});

test("the poller's branch lookup asks gh about origin's repository, not upstream's", async (t) => {
  const repo = forkCheckout("https://github.com/me/fork.git");
  t.after(repo.done);
  execFileSync("git", ["-C", repo.dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
  assert.equal(await queryPr(repo.dir, "feat/x"), null);
  const argv = JSON.parse(readFileSync(fakeGhArgv, "utf8")) as string[];
  assert.deepEqual(argv.slice(0, 6), ["pr", "list", "--repo", "me/fork", "--head", "feat/x"]);
});

// PR creation depends on this snippet alone, so run it rather than read it: a sed that left
// the scp prefix or the `.git` in place, or a JS-to-shell escaping slip, would name no repo.
test("the open command's origin snippet resolves owner/repo from every GitHub URL form", async (t) => {
  const command = openPullRequestCommand("main");
  const prefix = command.slice(0, command.indexOf(" && "));
  for (const url of [
    "https://github.com/me/fork.git",
    "https://github.com/me/fork",
    "git@github.com:me/fork.git",
    "git@github.com:me/fork",
    "ssh://git@github.com/me/fork.git",
  ]) {
    const repo = forkCheckout(url);
    t.after(repo.done);
    const out = execFileSync("sh", ["-c", `${prefix} && printf %s "$repo"`], { cwd: repo.dir, encoding: "utf8" });
    assert.equal(out, "me/fork", url);
  }
});
