import { realpath } from "node:fs/promises";
import { run } from "../util/exec.ts";

/** Ignored directories an install or build recreates, discounted at any depth by `regenerableIgnored`. */
export const REGENERABLE_IGNORED_PATHS = ["node_modules/", "dist/", "build/", "coverage/", ".cache/", ".turbo/", ".next/"] as const;

/** The two refusals that name work a discard would lose, as opposed to a read that failed. */
export const UNCOMMITTED_WORK = "checkout has uncommitted, untracked or ignored work";
export const UNPUBLISHED_COMMITS = "checkout has unpublished commits";

/** What a discard would lose, as `worktreeWork` names its first blocking entry. */
export type WorktreeWorkKind = "tracked" | "untracked" | "ignored" | "unpushed";

/**
 * The first entry that blocks a discard. `path` is relative to the checkout, exactly as Git's
 * status printed it; for unpushed commits it is `HEAD`, the ref that holds them.
 */
export interface WorktreeWorkEntry {
  kind: WorktreeWorkKind;
  path: string;
}

/** A work check's answer. `unknown` is a read that failed, never a clean tree. */
export type WorktreeWork =
  | { status: "clean" }
  | { status: "work"; entry: WorktreeWorkEntry }
  | { status: "unknown"; reason: string };

/** One status entry, in words: "ignored .env", "untracked notes.md", "unpushed commits on HEAD". */
export function describeWorktreeWork(entry: WorktreeWorkEntry): string {
  switch (entry.kind) {
    case "tracked": return `uncommitted change to ${entry.path}`;
    case "untracked": return `untracked ${entry.path}`;
    case "ignored": return `ignored ${entry.path}`;
    case "unpushed": return `unpushed commits on ${entry.path}`;
  }
}

/** The sentence `worktreeReturnBlocker` has always returned for a work check's answer. */
export function worktreeWorkBlocker(work: WorktreeWork): string | null {
  if (work.status === "clean") return null;
  if (work.status === "unknown") return work.reason;
  return work.entry.kind === "unpushed" ? UNPUBLISHED_COMMITS : UNCOMMITTED_WORK;
}

/**
 * An ignored entry that is a regenerable directory itself, which is how `--ignored=matching`
 * reports one. A file merely under a tracked `build/` (`!! build/.env`) is not, nor is a non-ignored entry.
 */
function regenerable(entry: StatusEntry): boolean {
  if (entry.code !== "!!") return false;
  const path = `/${entry.path}`;
  return REGENERABLE_IGNORED_PATHS.some((dir) => path.endsWith(`/${dir}`));
}

interface StatusEntry {
  code: string;
  path: string;
}

/** `--porcelain -z` entries in Git's order. A rename or copy is followed by its source path, which is skipped. */
function statusEntries(stdout: string): StatusEntry[] {
  const fields = stdout.split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (!field.trim()) continue;
    const code = field.slice(0, 2);
    entries.push({ code, path: field.slice(3) });
    if (/[RC]/.test(code)) index += 1;
  }
  return entries;
}

function entryKind(code: string): WorktreeWorkKind {
  if (code === "??") return "untracked";
  if (code === "!!") return "ignored";
  return "tracked";
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
  return worktreeWorkBlocker(await worktreeWork(path, options));
}

/**
 * The first entry that blocks discarding this tree, under the same rule `worktreeReturnBlocker`
 * states as a sentence: every status entry in Git's order (tracked changes, untracked files,
 * ignored files unless `regenerableIgnored` discounts them), then unpushed commits.
 */
export async function worktreeWork(
  path: string,
  options: { fetch?: boolean; regenerableIgnored?: boolean; execute?: typeof run } = {},
): Promise<WorktreeWork> {
  const git = gitIn(path, options.execute ?? run);
  const unknown = (reason: string): WorktreeWork => ({ status: "unknown", reason });
  try {
    const top = await git(["rev-parse", "--show-toplevel"]);
    if (top.code !== 0 || top.outcomeUnknown || top.overflowed ||
        await realpath(top.stdout.trim()) !== await realpath(path)) {
      return unknown("checkout identity could not be verified");
    }
    if (options.fetch) {
      const fetched = await git(["fetch", "--prune", "origin"]);
      if (fetched.code !== 0 || fetched.outcomeUnknown || fetched.overflowed) return unknown("origin could not be refreshed");
    }
    const status = await git(["status", "--porcelain", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"]);
    if (status.code !== 0 || status.outcomeUnknown || status.overflowed) return unknown("working tree could not be read");
    const blocking = statusEntries(status.stdout).find((entry) => !(options.regenerableIgnored && regenerable(entry)));
    if (blocking) return { status: "work", entry: { kind: entryKind(blocking.code), path: blocking.path } };
    const unpublished = await hasUnpublishedCommits(git);
    if (unpublished === null) return unknown("commits could not be compared against origin");
    return unpublished ? { status: "work", entry: { kind: "unpushed", path: "HEAD" } } : { status: "clean" };
  } catch {
    return unknown("checkout safety could not be verified");
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
