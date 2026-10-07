import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import test from "node:test";
import { mainRepoRoot, worktreeRepositoryIdentity } from "../src/server/util/git.ts";
import { physicalPathSync } from "../src/server/util/physical-path.ts";
import { ensureWorktreePoolMarker } from "../src/server/worktrees/marker.ts";

// `physicalPathSync` (`src/server/util/physical-path.ts`): the daemon's synchronous realpath
// must spell a path the way `fs.promises.realpath` and Git do, because the exact-physical
// guards compare the two byte for byte. Node's JS `realpathSync` keeps a win32 8.3 short name
// (`C:\Users\RUNNER~1`) that the native realpath expands, which made every worktree pool
// under such a spelling "not an exact physical directory" on the Windows CI runner.

const root = mkdtempSync(join(tmpdir(), "mission-physical-path-"));

/** The 8.3 short spelling of an existing path, or null off win32 or where it has none. */
function shortSpelling(path: string): string | null {
  if (process.platform !== "win32") return null;
  // Verbatim, so cmd sees the quotes it needs around a path and Node adds none of its own.
  const short = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${path}") do @echo %~sI`], {
    encoding: "utf8",
    windowsVerbatimArguments: true,
  }).stdout.trim();
  return short && short !== path ? short : null;
}

/**
 * The other spellings of `target` this platform's physical path resolves: a junction (a
 * symlink off win32) everywhere, and the 8.3 short name on win32.
 */
function aliasesOf(target: string, label: string): string[] {
  const link = join(root, `${label}-link`);
  symlinkSync(target, link, "junction");
  const short = shortSpelling(target);
  return short ? [link, short] : [link];
}

/** The other letter case, which only a case-insensitive volume (macOS, win32) accepts. */
function caseAliasOf(target: string): string[] {
  const upper = join(target, "..", basename(target).toUpperCase());
  return existsSync(upper) ? [upper] : [];
}

test("off win32 the spelling is exactly realpathSync's, so macOS and Linux are unchanged", () => {
  const target = join(root, "posix-target");
  mkdirSync(target);
  for (const alias of [...aliasesOf(target, "posix"), ...caseAliasOf(target)]) {
    assert.equal(physicalPathSync(alias, "darwin"), realpathSync(alias), alias);
    assert.equal(physicalPathSync(alias, "linux"), realpathSync(alias), alias);
  }
});

test("on win32 the spelling is the one fs.promises.realpath gives", async (t) => {
  const target = join(root, "win32-target");
  mkdirSync(target);
  // The case alias is what makes this bite on macOS too: only the native call restores case.
  for (const alias of [...aliasesOf(target, "win32"), ...caseAliasOf(target)]) {
    assert.equal(physicalPathSync(alias, "win32"), await realpath(alias), alias);
  }
  // Without 8.3 names on the temp volume the case above reduces to the junction alias.
  if (process.platform === "win32" && !shortSpelling(target)) t.diagnostic(`no 8.3 spelling for ${target}`);
});

test("a path that does not exist still throws", () => {
  for (const platform of ["win32", "darwin"] as const) {
    assert.throws(() => physicalPathSync(join(root, "missing"), platform), { code: "ENOENT" });
  }
});

test("a pool root under an aliased pools directory passes the exact-physical guard", async () => {
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const state = join(root, "state");
  mkdirSync(state);
  const physicalRepo = await realpath(repo);
  const physicalState = await realpath(state);

  const repoAliases = aliasesOf(repo, "repo");
  for (const [index, stateAlias] of aliasesOf(state, "state").entries()) {
    const repoAlias = repoAliases[index % repoAliases.length]!;
    assert.equal(mainRepoRoot(repoAlias), physicalRepo, repoAlias);
    const identity = worktreeRepositoryIdentity(repoAlias, join(stateAlias, `pools-${index}`));
    assert.ok(identity, stateAlias);
    assert.equal(identity.mainCheckoutRoot, physicalRepo);
    assert.equal(identity.poolPath, join(physicalState, `pools-${index}`, basename(identity.poolPath)));
    // Creates the pool root, then demands `realpath(root) === resolve(root)`.
    await ensureWorktreePoolMarker(identity.poolPath, `pool-${index}`);
  }
});

test("src/server physicalizes synchronously only through physicalPathSync", () => {
  const server = join(import.meta.dirname, "..", "src", "server");
  // `state/isolation.ts` judges a test's state home against the roots `test/setup-state.mjs`
  // captured with the JS `realpathSync`, so it keeps that call to spell them the same way.
  const allowed = new Set(["util/physical-path.ts", "state/isolation.ts"]);
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) {
        const name = relative(server, path).replaceAll("\\", "/");
        if (allowed.has(name)) continue;
        for (const [, names] of readFileSync(path, "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*"(?:node:)?fs"/g)) {
          if (/\brealpath(?:Sync)?\b/.test(names!)) offenders.push(name);
        }
      }
    }
  };
  walk(server);
  assert.deepEqual(offenders, [], "use physicalPathSync from src/server/util/physical-path.ts");
});
