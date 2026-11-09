// Move an in-flight task's base branch to where that branch merged.
//
// A task can be stacked on another feature's branch while that branch's pull request is still
// in review. When that pull request merges and GitHub deletes its branch, GitHub retargets the
// stacked pull request to the branch it merged into, and the task has to follow: its merge
// counts only into its base (`Registry.mergeCounts`), and its Diff view, evidence and
// affected-tests selection measure from `origin/<base>`, which no longer exists.
//
// Two paths move it, through one lookup and one write (`TaskManager.moveBaseBranch`):
//
// - The daemon, on its own (`moveMergedBaseBranches`), when origin no longer has the base and
//   `gh` reports a merged pull request whose head was that branch. A base that still exists is
//   never moved automatically, even with a merged pull request behind it: a long-lived branch
//   such as `release/2.0` is merged into the default regularly and stays the base of the work
//   cut from it. When the branch it merged into is gone and merged too, the move follows that
//   chain to the first branch origin still has.
// - The operator (`moveBaseBranchNow`, the session footer's "move base"), which also covers a
//   base that was NOT deleted, such as a stacked pull request retargeted by hand - but only once
//   that base has landed in its target (`branchLandedIn`), so a live long-lived branch is
//   refused rather than moved.
//
// Both require the merged pull request to be the merge of the branch the task was stacked on:
// `gh` lists pull requests by head NAME, so a reused branch name answers with an older pull
// request. Its head has to carry the commit the base was taken at (`commitCarries`): the
// task's `baseSha`, or, for a base an earlier move put there, `baseBranchMovedSha`. The new base
// is stored as a task write stores any base (origin's default as null). Anything uncertain - an
// unreachable origin, a `gh` failure, a branch deleted without merging - moves nothing.

import type { Task } from "@shared/types.ts";
import { ghBin } from "./config.ts";
import { checkoutGitHubRepository } from "./github/repository.ts";
import {
  branchLandedIn,
  commitCarries,
  remoteBranchSha,
  resolveBaseBranch,
  trackingBranchSha,
  type RemoteProbe,
} from "./git/remote-default.ts";
import { run } from "./util/exec.ts";
import { unref } from "./util/timers.ts";

/** How often the daemon looks for a moved base. One `ls-remote` per distinct base each time. */
export const BASE_BRANCH_MOVE_POLL_MS = 60_000;

/** How many merged-and-deleted branches a move follows before it gives up on a chain. */
const MAX_BASE_BRANCH_MOVE_HOPS = 5;

/** The newest merged pull request headed by a branch: where it merged, and the head that did. */
export interface MergedPullRequest {
  url: string;
  base: string;
  /** The head commit that merged, or null when `gh` did not report one. */
  head: string | null;
}

export interface BaseBranchMoveTasks {
  /** The tasks whose base a merge can move: `Registry.baseBranchMoveCandidates`. */
  candidates(): Task[];
  /** `TaskManager.moveBaseBranch`. */
  move(id: string, from: string, to: string | null, movedSha?: string | null): { ok: boolean; error?: string; task?: Task };
}

export interface BaseBranchMoveDeps {
  remoteBranch(repoRoot: string, branch: string): Promise<RemoteProbe<string | null>>;
  /** The newest merged pull request headed by `branch`, null for none. */
  mergedInto(repoRoot: string, branch: string): Promise<MergedPullRequest | null | "error">;
  resolve(repoRoot: string, branch: string): ReturnType<typeof resolveBaseBranch>;
  /** Bring `origin/<branch>` up to date, so the Diff view can measure from it at once. */
  fetch(repoRoot: string, branch: string): Promise<RemoteProbe<void>>;
  /** Whether commit `head` carries `anchor`: `commitCarries`. */
  carries(repoRoot: string, anchor: string, head: string): Promise<RemoteProbe<boolean>>;
  /** Whether `branch` as origin has it now has landed in `target`: `branchLandedIn`. */
  landed(repoRoot: string, branch: string, target: string, head: string | null): Promise<RemoteProbe<boolean>>;
  /** The fetched tip of `origin/<branch>`: `trackingBranchSha`. */
  tip(repoRoot: string, branch: string): Promise<RemoteProbe<string>>;
}

/**
 * The `gh pr list` arguments for the merged pull requests headed by `branch` on `repo`
 * (`owner/name`). `--repo` is never left out, for the reason `prListArgs` gives.
 */
export function mergedPrListArgs(branch: string, repo: string): string[] {
  return [
    "pr", "list", "--repo", repo, "--head", branch, "--state", "merged",
    "--json", "url,state,mergedAt,baseRefName,headRefOid", "--limit", "20",
  ];
}

/**
 * The newest merged pull request a `mergedPrListArgs` listing names, by `mergedAt`: `gh` orders
 * by creation, and a reused branch name can merge out of that order. Null for none; "error" for
 * output that is not a listing, or a newest merge that names no base or no time.
 */
export function parseMergedPullRequest(stdout: string): MergedPullRequest | null | "error" {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout || "[]");
  } catch {
    return "error";
  }
  if (!Array.isArray(rows)) return "error";
  const merged = rows
    .map((row) => row as { url?: unknown; state?: unknown; mergedAt?: unknown; baseRefName?: unknown; headRefOid?: unknown } | null)
    .filter((row) => row?.state === "MERGED" && typeof row.url === "string")
    .map((row) => ({
      url: row!.url as string,
      base: typeof row!.baseRefName === "string" ? row!.baseRefName : "",
      head: typeof row!.headRefOid === "string" && row!.headRefOid ? row!.headRefOid : null,
      at: typeof row!.mergedAt === "string" ? Date.parse(row!.mergedAt) : Number.NaN,
    }))
    .sort((a, b) => (Number.isFinite(b.at) ? b.at : 0) - (Number.isFinite(a.at) ? a.at : 0));
  const newest = merged[0];
  if (!newest) return null;
  if (!newest.base || !Number.isFinite(newest.at)) return "error";
  return { url: newest.url, base: newest.base, head: newest.head };
}

/** The newest merged pull request headed by `branch`, as `gh` reports it for the checkout. */
export async function newestMergedPullRequest(repoRoot: string, branch: string): Promise<MergedPullRequest | null | "error"> {
  const repo = await checkoutGitHubRepository(repoRoot);
  if (!repo.ok) return "error";
  const listed = await run(ghBin(), mergedPrListArgs(branch, repo.repo), { cwd: repoRoot, timeoutMs: 8000 });
  return listed.code === 0 ? parseMergedPullRequest(listed.stdout) : "error";
}

const defaultDeps: BaseBranchMoveDeps = {
  remoteBranch: (repoRoot, branch) => remoteBranchSha(repoRoot, branch),
  mergedInto: (repoRoot, branch) => newestMergedPullRequest(repoRoot, branch),
  resolve: (repoRoot, branch) => resolveBaseBranch(repoRoot, branch),
  fetch: async (repoRoot, branch) => {
    const fetched = await run("git", ["-C", repoRoot, "fetch", "--quiet", "origin", branch], { timeoutMs: 30_000 });
    return fetched.code === 0 && !fetched.outcomeUnknown
      ? { ok: true, value: undefined }
      : { ok: false, reason: `git fetch origin ${branch} failed: ${fetched.stderr.trim() || `exit ${fetched.code}`}`, outcomeUnknown: fetched.outcomeUnknown };
  },
  carries: (repoRoot, anchor, head) => commitCarries(repoRoot, anchor, head),
  landed: (repoRoot, branch, target, head) => branchLandedIn(repoRoot, branch, target, head),
  tip: (repoRoot, branch) => trackingBranchSha(repoRoot, branch),
};

/**
 * The commit a task's current base was taken at: the commit dispatch started it from, or the
 * tip an earlier move put the base on. Null when the task recorded none.
 */
export function baseBranchAnchor(task: Pick<Task, "baseSha" | "baseBranchMovedFrom" | "baseBranchMovedSha">): string | null {
  return task.baseBranchMovedFrom ? task.baseBranchMovedSha ?? null : task.baseSha;
}

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
  type Target = { to: string | null; toName: string; pr: MergedPullRequest; movedSha: string | null };
  const targets = new Map<string, Promise<Target | null>>();
  const targetFor = (repoRoot: string, branch: string): Promise<Target | null> => {
    const key = `${repoRoot}\0${branch}`;
    let target = targets.get(key);
    if (!target) {
      target = (async () => {
        // Follow the chain while each branch is gone and merged: the branch the base merged
        // into may itself have merged and been deleted before a sweep saw the first merge,
        // and a merged pull request keeps the base it merged into, which then never resolves.
        // The FIRST pull request is the base's own merge, the one the task's anchor is checked
        // against; later hops only say where that merge ended up.
        const visited = new Set([branch]);
        let current = branch;
        let first: MergedPullRequest | null = null;
        for (let hop = 0; hop < MAX_BASE_BRANCH_MOVE_HOPS; hop++) {
          const remote = await deps.remoteBranch(repoRoot, current);
          if (!remote.ok || remote.value !== null) return null;
          const merged = await deps.mergedInto(repoRoot, current);
          if (merged === null || merged === "error" || visited.has(merged.base)) return null;
          first ??= merged;
          visited.add(merged.base);
          const resolved = await deps.resolve(repoRoot, merged.base);
          if (resolved.ok) {
            const fetched = await deps.fetch(repoRoot, merged.base).catch(() => null);
            // A failed fetch still moves the task; the next move down the stack then has no
            // anchor to confirm against and waits for the operator.
            const tip = fetched?.ok ? await deps.tip(repoRoot, merged.base).catch(() => null) : null;
            return { to: resolved.baseBranch, toName: merged.base, pr: first, movedSha: tip?.ok ? tip.value : null };
          }
          // Refused: the next hop moves on only if origin confirms this branch is gone too.
          current = merged.base;
        }
        return null;
      })().catch(() => null);
      targets.set(key, target);
    }
    return target;
  };
  const moves: BaseBranchMove[] = [];
  for (const task of tasks.candidates()) {
    const { id, repoRoot, baseBranch } = task;
    if (!baseBranch) continue;
    const target = await targetFor(repoRoot, baseBranch);
    if (!target) continue;
    // Only the merge of the branch this task was stacked on moves it; anything uncertain waits.
    const anchor = baseBranchAnchor(task);
    if (!anchor || !target.pr.head) continue;
    const carried = await deps.carries(repoRoot, anchor, target.pr.head).catch(() => null);
    if (!carried?.ok || !carried.value) continue;
    // `move` refuses a task whose base changed while the network calls ran.
    if (tasks.move(id, baseBranch, target.to, target.movedSha).ok) {
      moves.push({ taskId: id, from: baseBranch, to: target.to });
    }
  }
  return moves;
}

export interface OperatorBaseBranchMoveTasks {
  get(id: string): Task | undefined;
  /** `TaskManager.operatorMoveRefusal`. */
  refusal(task: Task): string | null;
  /** `TaskManager.moveBaseBranch`. */
  move: BaseBranchMoveTasks["move"];
}

export type OperatorBaseBranchMove =
  | { ok: true; task: Task; to: string }
  | { ok: false; error: string; status: 404 | 409 | 502 };

/**
 * Move one in-flight task's base to where its base branch's newest merged pull request went,
 * because the operator asked (`POST /api/tasks/:id/base-branch/move`). Unlike the sweep, the
 * base may still exist on origin - but then it must have landed in the target. One hop: a target
 * origin no longer has is refused with the reason, and the sweep follows that chain once the
 * base is deleted. Every refusal writes nothing. `to` is the target's name, even when it is
 * origin's default and the task stores null.
 */
export async function moveBaseBranchNow(
  tasks: OperatorBaseBranchMoveTasks,
  id: string,
  overrides: Partial<BaseBranchMoveDeps> = {},
): Promise<OperatorBaseBranchMove> {
  const deps = { ...defaultDeps, ...overrides };
  const t = tasks.get(id);
  if (!t) return { ok: false, error: "no such task", status: 404 };
  const refused = tasks.refusal(t);
  if (refused) return { ok: false, error: refused, status: 409 };
  const from = t.baseBranch!;
  const pr = await deps.mergedInto(t.repoRoot, from);
  if (pr === "error") return { ok: false, error: `could not ask GitHub for ${from}'s merged pull request`, status: 502 };
  if (!pr) return { ok: false, error: `base branch ${from} has no merged pull request, so it has nowhere to move yet`, status: 409 };
  const anchor = baseBranchAnchor(t);
  if (!anchor || !pr.head) {
    return {
      ok: false,
      error: anchor
        ? `GitHub did not report ${pr.url}'s head, so it cannot be confirmed as ${from}'s merge`
        : `this task recorded no start commit, so ${pr.url} cannot be confirmed as its base branch's merge`,
      status: 409,
    };
  }
  const target = await deps.resolve(t.repoRoot, pr.base);
  if (!target.ok) return { ok: false, error: target.error, status: 409 };
  const fetched = await deps.fetch(t.repoRoot, pr.base);
  if (!fetched.ok) return { ok: false, error: `could not fetch origin: ${fetched.reason}`, status: 502 };
  const carried = await deps.carries(t.repoRoot, anchor, pr.head);
  if (!carried.ok) return { ok: false, error: `could not check ${pr.url}'s head: ${carried.reason}`, status: 502 };
  if (!carried.value) {
    return { ok: false, error: `${pr.url} does not carry the ${from} this task was stacked on, so it is not this base branch's merge`, status: 409 };
  }
  // The right pull request is still not the base landing when the branch has moved on since:
  // a long-lived branch keeps work of its own after each merge.
  const landed = await deps.landed(t.repoRoot, from, pr.base, pr.head);
  if (!landed.ok) return { ok: false, error: `could not check whether ${from} landed: ${landed.reason}`, status: 502 };
  if (!landed.value) {
    return { ok: false, error: `base branch ${from} has moved on since ${pr.url} merged it into ${pr.base}, so it has not landed there`, status: 409 };
  }
  const tip = await deps.tip(t.repoRoot, pr.base);
  if (!tip.ok) return { ok: false, error: `could not read origin/${pr.base}: ${tip.reason}`, status: 502 };
  const moved = tasks.move(id, from, target.baseBranch, tip.value);
  if (!moved.ok || !moved.task) return { ok: false, error: moved.error ?? "task changed while its base branch was moving; retry", status: 409 };
  return { ok: true, task: moved.task, to: pr.base };
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
