import { realpath } from "node:fs/promises";
import { run } from "../util/exec.ts";

/** Ignored directories an install or build recreates, discounted at any depth by `regenerableIgnored`. */
export const REGENERABLE_IGNORED_PATHS = ["node_modules/", "dist/", "build/", "coverage/", ".cache/", ".turbo/", ".next/"] as const;

/** The two refusals that name work a discard would lose, as opposed to a read that failed. */
export const UNCOMMITTED_WORK = "checkout has uncommitted, untracked or ignored work";
export const UNPUBLISHED_COMMITS = "checkout has unpublished commits";

/**
 * An ignored `-z` status entry is a regenerable directory itself, which is how `--ignored=matching`
 * reports one. A file merely under a tracked `build/` (`!! build/.env`) is not, nor is a non-ignored entry.
 */
function regenerable(entry: string): boolean {
  if (!entry.startsWith("!! ")) return false;
  const path = `/${entry.slice(3)}`;
  return REGENERABLE_IGNORED_PATHS.some((dir) => path.endsWith(`/${dir}`));
}

/**
 * Kill is permission to stop, not to discard work. Every uncertain read retains the tree.
 * `regenerableIgnored` is for reclaim and sweep only: it discounts ignored files under
 * `REGENERABLE_IGNORED_PATHS`, while every other ignored file (evidence, `.env`) still blocks.
 */
export async function worktreeReturnBlocker(
  path: string,
  options: { fetch?: boolean; regenerableIgnored?: boolean; execute?: typeof run } = {},
): Promise<string | null> {
  const git = gitIn(path, options.execute ?? run);
  try {
    const top = await git(["rev-parse", "--show-toplevel"]);
    if (top.code !== 0 || top.outcomeUnknown || top.overflowed ||
        await realpath(top.stdout.trim()) !== await realpath(path)) {
      return "checkout identity could not be verified";
    }
    if (options.fetch) {
      const fetched = await git(["fetch", "--prune", "origin"]);
      if (fetched.code !== 0 || fetched.outcomeUnknown || fetched.overflowed) return "origin could not be refreshed";
    }
    const status = await git(["status", "--porcelain", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"]);
    if (status.code !== 0 || status.outcomeUnknown || status.overflowed) return "working tree could not be read";
    const entries = status.stdout.split("\0").filter((entry) => entry.trim());
    if (entries.some((entry) => !(options.regenerableIgnored && regenerable(entry)))) {
      return UNCOMMITTED_WORK;
    }
    const unpublished = await hasUnpublishedCommits(git);
    if (unpublished === null) return "commits could not be compared against origin";
    return unpublished ? UNPUBLISHED_COMMITS : null;
  } catch {
    return "checkout safety could not be verified";
  }
}

/**
 * Every kind of work discarding this tree would lose, each read on its own: the blocker stops
 * at the first, so a tree with both a local `.env` and unpushed commits would name only one.
 * For stating a discard, never for deciding one; an unreadable tree yields no entries.
 */
export async function worktreeDiscardedWork(
  path: string,
  options: { regenerableIgnored?: boolean; execute?: typeof run } = {},
): Promise<Array<typeof UNCOMMITTED_WORK | typeof UNPUBLISHED_COMMITS>> {
  const first = await worktreeReturnBlocker(path, options);
  if (first === UNPUBLISHED_COMMITS) return [UNPUBLISHED_COMMITS];
  if (first !== UNCOMMITTED_WORK) return [];
  try {
    return await hasUnpublishedCommits(gitIn(path, options.execute ?? run))
      ? [UNCOMMITTED_WORK, UNPUBLISHED_COMMITS]
      : [UNCOMMITTED_WORK];
  } catch {
    return [UNCOMMITTED_WORK];
  }
}

function gitIn(path: string, execute: typeof run) {
  return (args: string[]) => execute("git", ["--no-optional-locks", "-C", path, ...args], {
    timeoutMs: 30_000,
  });
}

/** Whether HEAD has commits no `origin` ref contains, or null when that cannot be read. */
async function hasUnpublishedCommits(git: ReturnType<typeof gitIn>): Promise<boolean | null> {
  const commits = await git(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]);
  if (commits.code !== 0 || commits.outcomeUnknown || commits.overflowed || !/^\d+$/.test(commits.stdout.trim())) {
    return null;
  }
  return commits.stdout.trim() !== "0";
}
