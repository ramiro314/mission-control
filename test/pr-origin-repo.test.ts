import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { originGitHubRepository } from "../src/server/inspector/github.ts";
import { prListArgs } from "../src/server/pr.ts";

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
