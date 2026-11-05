import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathContains } from "./occupancy.ts";

/** Canonicalize an existing checkout path, while keeping missing legacy paths comparable. */
export function canonicalWorktreePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The native pool whose root holds `path`, or null. Matched by path segment over the
 * `worktree_pools` rows, never by string prefix: pool roots are `<repo>-<digest>`, so a
 * `startsWith` would let `/pools/app-1f2e` claim a slot of `/pools/app-1f2e3d`. Purely
 * lexical, so a slot whose directory was deleted still maps to its pool. The longest root
 * wins, so the answer never depends on row order.
 */
export function poolContainingPath<T extends { poolPath: string }>(pools: readonly T[], path: string): T | null {
  let best: T | null = null;
  for (const pool of pools) {
    if (!pathContains(pool.poolPath, path)) continue;
    if (!best || pool.poolPath.length > best.poolPath.length) best = pool;
  }
  return best;
}
