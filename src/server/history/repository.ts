import { existsSync } from "node:fs";
import { relative, sep } from "node:path";
import { WORKTREES_DIR } from "../config.ts";
import { mainRepoRoot } from "../util/git.ts";

/**
 * Which repository a session's first cwd belonged to, resolved when its row is indexed and
 * stored, so the answer survives the directory being deleted or a pool slot being reused.
 *
 * In order: a cwd inside a native worktree pool maps to that pool's main checkout, even when
 * the slot directory is gone; a cwd inside `worktrees/<taskId>` maps to the task's
 * repository; an existing path resolves through Git; anything else has no repository and
 * the page shows the raw cwd.
 */
export interface HistoryRepositorySources {
  pools: readonly { poolPath: string; mainCheckoutRoot: string }[];
  taskRepoRoot: (taskId: string) => string | null;
  worktreesDir?: string;
  gitRoot?: (cwd: string) => string | null;
}

/** The path below `root`, or null when `path` is not inside it. */
function inside(root: string, path: string): string | null {
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep) || rel.includes(`..${sep}`)) return null;
  return rel;
}

export function resolveHistoryRepository(cwd: string | null, sources: HistoryRepositorySources): string | null {
  if (!cwd) return null;
  for (const pool of sources.pools) {
    if (inside(pool.poolPath, cwd) !== null) return pool.mainCheckoutRoot;
  }
  const task = inside(sources.worktreesDir ?? WORKTREES_DIR, cwd);
  if (task !== null) {
    const repo = sources.taskRepoRoot(task.split(sep)[0]!);
    if (repo) return repo;
  }
  const gitRoot = sources.gitRoot ?? ((path: string) => (existsSync(path) ? mainRepoRoot(path) : null));
  return gitRoot(cwd);
}
