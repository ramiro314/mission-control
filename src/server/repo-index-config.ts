import { homedir } from "node:os";
import { delimiter, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  MAX_INDEXED_DIRECTORIES,
  RepoIndexConfigSchema,
  type IndexedDirectory,
  type RepoIndexConfig,
} from "@shared/repo-index.ts";
import { getAppConfig } from "./db.ts";
import { physicalPathSync } from "./util/physical-path.ts";

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.repoIndex;

/** A semantic config refusal whose message is safe to show beside the Settings field. */
export class RepoIndexConfigError extends Error {}

/** The current saved list, with the four removable defaults applied only when absent. */
export function getRepoIndexConfig(): RepoIndexConfig {
  return RepoIndexConfigSchema.parse(getAppConfig(CONFIG_ENTRY) ?? {});
}

/** Expand the two home-relative forms the setting accepts. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

/**
 * Return the first environment override in the existing prefix and singular-fallback order.
 * Keeping the variable name with the value lets Settings state which launch-time setting is
 * making the saved rows read-only, including an older supported prefix.
 */
export function repositoryIndexEnvironmentOverride(): { variable: string; value: string } | null {
  for (const suffix of ["WORKSPACE_DIRS", "WORKSPACE_DIR"] as const) {
    for (const prefix of ["MISSION", "FLEET", "HARNESS"] as const) {
      const variable = `${prefix}_${suffix}`;
      const value = process.env[variable];
      if (value !== undefined) return { variable, value };
    }
  }
  return null;
}

/**
 * PATH-style entries named by the launch environment, with empty segments discarded. The
 * separator is PATH's own (`:` on POSIX, `;` on win32), so a drive letter stays in its path.
 */
export function environmentDirectories(): string[] {
  const override = repositoryIndexEnvironmentOverride();
  if (!override) return [];
  return override.value.split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}

/** Expand, normalize, and resolve symlinks where the target already exists. */
export function canonicalize(path: string): string {
  const normalized = resolve(expandHome(path.trim()));
  try {
    return physicalPathSync(normalized);
  } catch {
    return normalized;
  }
}

/** Whether a path currently resolves to the operator's home or one of its ancestors. */
export function resolvesAtOrAboveHome(path: string): boolean {
  const canonical = canonicalize(path);
  const home = canonicalize(homedir());
  const fromPathToHome = relative(canonical, home);
  return fromPathToHome === ""
    || (!isAbsolute(fromPathToHome)
      && fromPathToHome !== ".."
      && !fromPathToHome.startsWith(`..${sep}`));
}

/**
 * Whether an absolute path is the root of a filesystem: `/`, a win32 drive root such as `D:\`,
 * or a UNC share root. Scanning one walks a whole volume. On POSIX `/` is always at or above
 * home, so this adds nothing there. A win32 drive root need not be: with a checkout on `D:`
 * and the home on `C:`, `/` resolves to `D:\`, which is not an ancestor of the home. The path
 * API is a parameter so a win32 spelling can be tested from any platform.
 */
export function isFilesystemRoot(
  absolute: string,
  pathApi: { parse: typeof parse } = { parse },
): boolean {
  return pathApi.parse(absolute).root === absolute;
}

/**
 * Whether a configured path names a filesystem root, as written or once canonical. Both are
 * asked because each can hide the other: a symlink to `/` is only a root once followed, and a
 * `subst` drive's root is only a root as written, since its realpath is the folder it maps.
 * The path API and the canonicalizer are parameters so both cases can be tested from any
 * platform without a real link or drive mapping.
 */
export function namesFilesystemRoot(
  path: string,
  deps: {
    pathApi: { parse: typeof parse; resolve: typeof resolve };
    canonicalize: (path: string) => string;
  } = { pathApi: { parse, resolve }, canonicalize },
): boolean {
  const { pathApi } = deps;
  return isFilesystemRoot(pathApi.resolve(expandHome(path.trim())), pathApi)
    || isFilesystemRoot(deps.canonicalize(path), pathApi);
}

/** Validate the whole list so duplicate and broad-root checks compare canonical paths. */
export function validateIndexedDirectories(rows: readonly IndexedDirectory[]): void {
  if (rows.length > MAX_INDEXED_DIRECTORIES) {
    throw new RepoIndexConfigError(
      `At most ${MAX_INDEXED_DIRECTORIES} directories can be indexed.`,
    );
  }

  const seen = new Map<string, string>();
  for (const row of rows) {
    const path = row.path.trim();
    if (!path) throw new RepoIndexConfigError("Directory paths cannot be empty.");
    const expanded = expandHome(path);
    if (!isAbsolute(expanded)) {
      throw new RepoIndexConfigError(
        `"${path}" is not an absolute path. Start it with / or ~/.`,
      );
    }
    const canonical = canonicalize(path);
    if (resolvesAtOrAboveHome(canonical)) {
      throw new RepoIndexConfigError(
        `"${path}" is at or above your home directory. Name the folder that holds your checkouts.`,
      );
    }
    if (namesFilesystemRoot(path)) {
      throw new RepoIndexConfigError(
        `"${path}" is the root of a drive. Name the folder that holds your checkouts.`,
      );
    }
    const duplicate = seen.get(canonical);
    if (duplicate !== undefined) {
      throw new RepoIndexConfigError(
        `"${path}" is the same directory as "${duplicate}". Each directory can be indexed once.`,
      );
    }
    seen.set(canonical, path);
  }
}

/**
 * The one answer to which roots discovery walks. A set environment value, including an
 * intentionally empty one, wins. Saved roots are expanded, canonicalized, and deduplicated.
 */
export function indexedDirectories(): string[] {
  if (repositoryIndexEnvironmentOverride()) return environmentDirectories();
  const roots = new Set<string>();
  for (const row of getRepoIndexConfig().directories) {
    const canonical = canonicalize(row.path);
    // A missing path can become a symlink after it was saved. Reapply the broad-root guard
    // at read time so that filesystem change cannot turn a safe deferred row into a home or
    // whole-volume scan.
    if (!resolvesAtOrAboveHome(canonical) && !namesFilesystemRoot(row.path)) roots.add(canonical);
  }
  return [...roots];
}
