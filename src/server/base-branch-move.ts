// Move an in-flight task's base branch to where that branch merged.
//
// A task can be stacked on another feature's branch while that branch's pull request is still
// in review. When that pull request merges and GitHub deletes its branch, GitHub retargets the
// stacked pull request to the branch it merged into, and the task has to follow: its merge
// counts only into its base (`Registry.mergeCounts`), and its Diff view, evidence and
// affected-tests selection measure from `origin/<base>`, which no longer exists.
//
// So the daemon moves it, on its own, when two things are both true: origin no longer has the
// base branch, and `gh` reports a merged pull request whose head was that branch. The new base
// is that pull request's base, stored as a task write stores any base (origin's default as
// null). A base branch that still exists is never moved, even with a merged pull request
// behind it: a long-lived branch such as `release/2.0` is merged into the default regularly
// and stays the base of the work cut from it. Anything uncertain - an unreachable origin, a
// `gh` failure, a branch deleted without merging - leaves the task exactly as it is. When the
// branch it merged into is gone and merged too, the move follows that chain to the first
// branch origin still has.

import type { Task } from "@shared/types.ts";
import { ghBin } from "./config.ts";
import { checkoutGitHubRepository } from "./github/repository.ts";
import { remoteBranchSha, resolveBaseBranch, type RemoteProbe } from "./git/remote-default.ts";
import { run } from "./util/exec.ts";
import { unref } from "./util/timers.ts";

/** How often the daemon looks for a moved base. One `ls-remote` per distinct base each time. */
export const BASE_BRANCH_MOVE_POLL_MS = 60_000;

/** How many merged-and-deleted branches a move follows before it gives up on a chain. */
const MAX_BASE_BRANCH_MOVE_HOPS = 5;

export interface BaseBranchMoveTasks {
  /** The tasks whose base a merge can move: `Registry.baseBranchMoveCandidates`. */
  candidates(): Task[];
  /** `TaskManager.moveBaseBranch`. */
  move(id: string, from: string, to: string | null): { ok: boolean; error?: string };
}

export interface BaseBranchMoveDeps {
  remoteBranch(repoRoot: string, branch: string): Promise<RemoteProbe<string | null>>;
  /** The branch the newest merged pull request headed by `branch` merged into, null for none. */
  mergedInto(repoRoot: string, branch: string): Promise<string | null | "error">;
  resolve(repoRoot: string, branch: string): ReturnType<typeof resolveBaseBranch>;
  /** Bring `origin/<branch>` up to date, so the Diff view can measure from it at once. */
  fetch(repoRoot: string, branch: string): Promise<void>;
}

/**
 * The base `branch` merged into, as `pr list --head <branch> --state merged` reports it. `gh`
 * lists newest first, so a branch name reused for a later pull request answers with that one.
 */
export async function mergedPullRequestBase(
  repoRoot: string,
  branch: string,
  execute: typeof run = run,
): Promise<string | null | "error"> {
  const repo = await checkoutGitHubRepository(repoRoot);
  if (!repo.ok) return "error";
  const listed = await execute(
    ghBin(),
    ["pr", "list", "--repo", repo.repo, "--head", branch, "--state", "merged", "--json", "baseRefName", "--limit", "1"],
    { cwd: repoRoot, timeoutMs: 8000 },
  );
  if (listed.code !== 0) return "error";
  try {
    const rows: unknown = JSON.parse(listed.stdout || "[]");
    if (!Array.isArray(rows)) return "error";
    if (rows.length === 0) return null;
    const base = (rows[0] as { baseRefName?: unknown } | null)?.baseRefName;
    return typeof base === "string" && base ? base : "error";
  } catch {
    return "error";
  }
}

const defaultDeps: BaseBranchMoveDeps = {
  remoteBranch: (repoRoot, branch) => remoteBranchSha(repoRoot, branch),
  mergedInto: (repoRoot, branch) => mergedPullRequestBase(repoRoot, branch),
  resolve: (repoRoot, branch) => resolveBaseBranch(repoRoot, branch),
  fetch: async (repoRoot, branch) => {
    await run("git", ["-C", repoRoot, "fetch", "--quiet", "origin", branch], { timeoutMs: 30_000 });
  },
};

export interface BaseBranchMove {
  taskId: string;
  from: string;
  to: string | null;
}

/**
 * Move every candidate task whose base branch is gone from origin and merged, to the branch it
 * merged into. Asks once per distinct repository and base, and returns the moves it made.
 */
export async function moveMergedBaseBranches(
  tasks: BaseBranchMoveTasks,
  overrides: Partial<BaseBranchMoveDeps> = {},
): Promise<BaseBranchMove[]> {
  const deps = { ...defaultDeps, ...overrides };
  const targets = new Map<string, Promise<{ to: string | null } | null>>();
  const targetFor = (repoRoot: string, branch: string): Promise<{ to: string | null } | null> => {
    const key = `${repoRoot}\0${branch}`;
    let target = targets.get(key);
    if (!target) {
      target = (async () => {
        // Follow the chain while each branch is gone and merged: the branch the base merged
        // into may itself have merged and been deleted before a sweep saw the first merge,
        // and a merged pull request keeps the base it merged into, which then never resolves.
        const visited = new Set([branch]);
        let current = branch;
        for (let hop = 0; hop < MAX_BASE_BRANCH_MOVE_HOPS; hop++) {
          const remote = await deps.remoteBranch(repoRoot, current);
          if (!remote.ok || remote.value !== null) return null;
          const mergedInto = await deps.mergedInto(repoRoot, current);
          if (typeof mergedInto !== "string" || visited.has(mergedInto)) return null;
          visited.add(mergedInto);
          const resolved = await deps.resolve(repoRoot, mergedInto);
          if (resolved.ok) {
            await deps.fetch(repoRoot, mergedInto).catch(() => undefined);
            return { to: resolved.baseBranch };
          }
          // Refused: the next hop moves on only if origin confirms this branch is gone too.
          current = mergedInto;
        }
        return null;
      })().catch(() => null);
      targets.set(key, target);
    }
    return target;
  };
  const moves: BaseBranchMove[] = [];
  for (const { id, repoRoot, baseBranch } of tasks.candidates()) {
    if (!baseBranch) continue;
    const target = await targetFor(repoRoot, baseBranch);
    if (!target) continue;
    // `move` refuses a task whose base changed while the network calls ran.
    if (tasks.move(id, baseBranch, target.to).ok) moves.push({ taskId: id, from: baseBranch, to: target.to });
  }
  return moves;
}

/** Run `moveMergedBaseBranches` every `intervalMs`, never two at once. Returns the stop. */
export function startMergedBaseBranchMover(
  tasks: BaseBranchMoveTasks,
  intervalMs = BASE_BRANCH_MOVE_POLL_MS,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async (): Promise<void> => {
    try {
      for (const move of await moveMergedBaseBranches(tasks)) {
        console.log(
          `[mission-control] task ${move.taskId}: base branch ${move.from} merged into ` +
            `${move.to ?? "origin's default branch"}, which is now its base`,
        );
      }
    } catch (error) {
      console.warn("[mission-control] could not check merged base branches:", error);
    }
    if (!stopped) timer = unref(setTimeout(() => void tick(), intervalMs));
  };
  timer = unref(setTimeout(() => void tick(), intervalMs));
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
