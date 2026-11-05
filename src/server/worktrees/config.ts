import {
  WorktreesConfigSchema,
  type WorktreeClaim,
  type WorktreesConfig,
  type WorktreesConfigPatch,
} from "@shared/protocol.ts";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { getAppConfig, setAppConfig } from "../db.ts";
import { treeGitCommonDirectory } from "../util/git.ts";
import { NO_SEED, type RegenerableSeed } from "./seed.ts";

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.worktrees;

/** Resolved policy for one physical Git common directory. */
export interface WorktreePolicy {
  enabled: boolean;
  maxSlots: number;
  setupArgv: readonly string[] | null;
  /**
   * The pool's dependency claim, or null when none is configured. Optional so a focused
   * caller describing a pool with no claim need not spell the field out.
   */
  claim?: WorktreeClaim | null;
}

/** The current policy, with default-on and max-16 defaults applied on every read. */
export function getWorktreesConfig(): WorktreesConfig {
  return WorktreesConfigSchema.parse(getAppConfig(CONFIG_ENTRY) ?? {});
}

/**
 * Merge a bounded patch without replacing repository overrides the caller did not name.
 * Null removes one override; null setup argv or claim removes only that field. A claim is
 * replaced whole, never merged step by step: its steps are one ordered unit.
 */
export function setWorktreesConfig(patch: WorktreesConfigPatch): WorktreesConfig {
  const current = getWorktreesConfig();
  const repositories: WorktreesConfig["repositories"] = { ...current.repositories };
  for (const [commonDirectory, repositoryPatch] of Object.entries(patch.repositories ?? {})) {
    if (repositoryPatch === null) {
      delete repositories[commonDirectory];
      continue;
    }
    const prior = repositories[commonDirectory] ?? {};
    const { setupArgv, claim, ...scalarPatch } = repositoryPatch;
    const next = { ...prior, ...scalarPatch };
    if (setupArgv === null) delete next.setupArgv;
    else if (setupArgv !== undefined) next.setupArgv = setupArgv;
    if (claim === null) delete next.claim;
    else if (claim !== undefined) next.claim = claim;
    repositories[commonDirectory] = next;
  }
  const resolved = WorktreesConfigSchema.parse({
    ...current,
    ...patch,
    repositories,
  });
  setAppConfig(CONFIG_ENTRY, resolved);
  return resolved;
}

/** Resolve a repository override over the global defaults, keyed only by physical common dir. */
export function resolveWorktreePolicy(
  commonDirectory: string,
  config = getWorktreesConfig(),
): WorktreePolicy {
  const override = config.repositories[commonDirectory];
  return {
    enabled: override?.enabled ?? config.enabled,
    maxSlots: override?.maxSlots ?? config.maxSlots,
    setupArgv: override?.setupArgv ?? null,
    claim: override?.claim ?? null,
  };
}

/**
 * The seed of the pool that owns this tree: its claim's `seed.paths` and `seed.exclude`, for the
 * pool keyed by the Git common directory the tree's `.git` names. A tree with no repository, a
 * pool with no claim or no seed, and a policy that cannot be read all get `NO_SEED`, so the
 * delete rule falls back to the built-in regenerable list and never discounts more than it can prove.
 */
export function treeSeed(tree: string, config?: WorktreesConfig): RegenerableSeed {
  const commonDirectory = treeGitCommonDirectory(tree);
  if (!commonDirectory) return NO_SEED;
  try {
    const seed = (config ?? getWorktreesConfig()).repositories[commonDirectory]?.claim?.seed;
    return seed ? { paths: seed.paths, exclude: seed.exclude } : NO_SEED;
  } catch {
    return NO_SEED;
  }
}
