import { realpath } from "node:fs/promises";
import { run } from "../util/exec.ts";

/** Ignored directories an install or build recreates, discounted at any depth by `regenerableIgnored`. */
export const REGENERABLE_IGNORED_PATHS = ["node_modules/", "dist/", "build/", "coverage/", ".cache/", ".turbo/", ".next/"] as const;

/** An ignored `-z` status entry lies under a regenerable directory; a quoted, odd or non-ignored entry never does. */
function regenerable(entry: string): boolean {
  if (!entry.startsWith("!! ")) return false;
  const path = `/${entry.slice(3)}`;
  return REGENERABLE_IGNORED_PATHS.some((dir) => path.includes(`/${dir}`));
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
  const execute = options.execute ?? run;
  const git = (args: string[]) => execute("git", ["--no-optional-locks", "-C", path, ...args], {
    timeoutMs: 30_000,
  });
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
      return "checkout has uncommitted, untracked or ignored work";
    }
    const commits = await git(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]);
    if (commits.code !== 0 || commits.outcomeUnknown || commits.overflowed || !/^\d+$/.test(commits.stdout.trim())) {
      return "commits could not be compared against origin";
    }
    return commits.stdout.trim() === "0" ? null : "checkout has unpublished commits";
  } catch {
    return "checkout safety could not be verified";
  }
}
