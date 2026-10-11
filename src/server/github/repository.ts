import {
  REMOTE_CONFIG_ARGS,
  parseGitHubRemoteUrl,
  parseRemoteConfig,
  pickCheckoutRepository,
  type CheckoutRemote,
  type CheckoutRepository,
  type GitHubRepositoryIdentity,
} from "@shared/github-repository.mjs";
import { run } from "../util/exec.ts";

export type { CheckoutRepository, GitHubRepositoryIdentity };

/** The checkout's remotes, or the reason its git config could not be read. */
async function readCheckoutRemotes(
  repoRoot: string,
): Promise<{ ok: true; remotes: CheckoutRemote[] } | { ok: false; error: string }> {
  const result = await run("git", [...REMOTE_CONFIG_ARGS], { cwd: repoRoot, timeoutMs: 8000 });
  // `--get-regexp` exits 1 when nothing matches: a checkout with no remotes, not a failure.
  if (!result.outcomeUnknown && result.code === 1 && !result.stderr.trim()) return { ok: true, remotes: [] };
  if (result.outcomeUnknown || result.code !== 0) {
    const detail = result.stderr.trim().split("\n")[0] || (result.outcomeUnknown ? "git did not answer" : `exit ${result.code}`);
    return { ok: false, error: `Could not read the git remotes of ${repoRoot}: ${detail}` };
  }
  return { ok: true, remotes: parseRemoteConfig(result.stdout) };
}

/**
 * The GitHub repository `gh` calls run in `repoRoot` should name with `--repo`: the gh
 * default pin, else `origin`, else an error naming the checkout and its remotes. See
 * `pickCheckoutRepository` for the precedence and why `gh`'s own choice is never used.
 */
export async function checkoutGitHubRepository(repoRoot: string): Promise<CheckoutRepository> {
  const remotes = await readCheckoutRemotes(repoRoot);
  if (!remotes.ok) return remotes;
  return pickCheckoutRepository(remotes.remotes, repoRoot);
}

/**
 * The GitHub repositories this checkout's git config names.
 *
 * Every configured fetch remote is considered rather than assuming one named `origin`:
 * forks cloned with `--origin upstream` and checkouts with a separate fork remote are both
 * ordinary. An unreadable config, a repository with no remotes, and non-GitHub remotes all
 * answer with an empty set, which makes the adoption caller abstain.
 */
export async function configuredGitHubRepositories(repoRoot: string): Promise<GitHubRepositoryIdentity[]> {
  const remotes = await readCheckoutRemotes(repoRoot);
  if (!remotes.ok) return [];

  const repositories = new Map<string, GitHubRepositoryIdentity>();
  for (const url of remotes.remotes.flatMap((remote) => remote.urls)) {
    const identity = parseGitHubRemoteUrl(url);
    if (!identity) continue;
    repositories.set(`${identity.owner}/${identity.repo}`.toLowerCase(), identity);
  }
  return [...repositories.values()];
}
