// The GitHub repository a repository script's `gh` calls name with `--repo`.
//
// Left to choose, `gh` prefers a remote called `upstream`, which on this fork is the parent
// (see `src/shared/github-repository.mjs`). So a script never leaves it to `gh`: an explicit
// `--repo` wins, then `GH_REPO`, then the shared resolver over the working directory's git
// config.

import { spawnSync } from "node:child_process";
import { REMOTE_CONFIG_ARGS, parseRemoteConfig, pickCheckoutRepository } from "../src/shared/github-repository.mjs";

/**
 * `explicit` when given, else `env.GH_REPO`, else the checkout at `cwd`'s gh default pin or
 * origin. Throws an `Error` carrying the resolver's message when none of those names one.
 */
export function scriptRepository(explicit, { env = process.env, cwd = process.cwd() } = {}) {
  if (explicit) return explicit;
  if (env.GH_REPO) return env.GH_REPO;
  const result = spawnSync("git", REMOTE_CONFIG_ARGS, { cwd, encoding: "utf8" });
  // `--get-regexp` exits 1 when nothing matches: a checkout with no remotes, not a failure.
  const noRemotes = result.status === 1 && !result.stderr.trim();
  if (result.error || (result.status !== 0 && !noRemotes)) {
    const detail = result.error?.message ?? (result.stderr.trim().split("\n")[0] || `exit ${result.status}`);
    throw new Error(`Could not read the git remotes of ${cwd}: ${detail}`);
  }
  const picked = pickCheckoutRepository(noRemotes ? [] : parseRemoteConfig(result.stdout), cwd);
  if (!picked.ok) throw new Error(picked.error);
  return picked.repo;
}
