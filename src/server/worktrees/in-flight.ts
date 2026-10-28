import { basename, dirname, join } from "node:path";
import { canonicalWorktreePath } from "./path.ts";

/**
 * Keyed through the parent's real path, never the tree's own: a path registered before `git
 * worktree add` does not exist yet, and must still match itself once it does.
 */
function key(path: string): string {
  return join(canonicalWorktreePath(dirname(path)), basename(path));
}

/**
 * Trees a creation path is making right now, before any row names them. The task overflow arm
 * and the check fallback both run `git worktree add` before their row records the path, and
 * the orphan sweep skips every path registered here, so it never removes a tree mid-creation.
 *
 * Each path is registered before `git worktree add` and cleared once its row names it or its
 * unwind removed the tree. In memory by design: after a crash nothing is in flight, and the
 * sweep's age grace covers a half-created tree until it is old enough to sweep.
 */
export class InFlightTrees {
  private readonly paths = new Set<string>();

  add(path: string): void {
    this.paths.add(key(path));
  }

  delete(path: string): void {
    this.paths.delete(key(path));
  }

  has(path: string): boolean {
    return this.paths.has(key(path));
  }
}

/** The daemon's one registry, shared by both creation paths and the sweep. */
export const inFlightTrees = new InFlightTrees();
