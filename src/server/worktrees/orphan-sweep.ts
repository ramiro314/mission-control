import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { storageProblem } from "@shared/storage-health.ts";
import { CHECK_WORKTREES_DIR, STATE_DIR, WORKTREES_DIR } from "../config.ts";
import { openDb } from "../db.ts";
import {
  REGENERABLE_IGNORED_PATHS,
  regenerableIgnoredPath,
  worktreeDiscardedWork,
  worktreeReturnBlocker,
} from "../git/worktree-return-safety.ts";
import type { StorageProblemObservation } from "../storage-health.ts";
import { commandFailureText, run } from "../util/exec.ts";
import { treeSeed } from "./config.ts";
import { inFlightTrees, type InFlightTrees } from "./in-flight.ts";
import { inspectWorktreeOccupancy, pathContains, type WorktreeOccupancy } from "./occupancy.ts";
import { canonicalWorktreePath } from "./path.ts";
import { NO_SEED, seedRegenerates, type RegenerableSeed } from "./seed.ts";

// The orphan tree sweep: folders under the overflow and check-fallback directories that no
// live owner references. A referenced child is never touched. An unreferenced one is removed
// only when it is provably disposable - a husk of git leftovers, or a clean worktree - and
// everything else is kept and reported as `dirty-orphan-folder`.

/** A child modified this recently, or whose `.git` file was, may still be being created. */
export const ORPHAN_TREE_GRACE_MS = 30 * 60 * 1_000;

const GIT_TIMEOUT_MS = 30_000;
const OCCUPANCY_BATCH = 256;
/** How many of a kept tree's files a discard preview names. */
const DESCRIBED_FILES = 10;

/** An unreferenced child the sweep kept because it could not prove it disposable. */
export interface KeptOrphanTree {
  path: string;
  inode: number;
  reason: string;
}

/** What discarding a kept tree loses, as its preview states it. */
export interface UnownedTreeDescription extends KeptOrphanTree {
  /** A Git worktree whose repository still exists, removed through `git worktree remove`. */
  worktree: boolean;
  /** The kinds of work a discard loses, such as uncommitted changes or unpublished commits. */
  work: string[];
  /** Up to `DESCRIBED_FILES` of the paths it deletes, relative to the tree. */
  files: string[];
  /** More paths are deleted than `files` names. */
  moreFiles: boolean;
  /**
   * A digest of every entry under the tree, with its size and modification time. A preview is
   * bound to it, so any write after the preview, even one `files` does not show, refuses Execute.
   */
  signature: string;
}

/** What Worktrees > Unowned trees needs from the sweep: the preview and the removal it guards. */
export interface UnownedTreeDiscards {
  /** The kept tree at this path, or null when the sweep keeps none there now. */
  describe(path: string): Promise<UnownedTreeDescription | null>;
  /** Remove a kept tree the operator confirmed. Returns why it was refused, or null once it is gone. */
  discard(path: string): Promise<string | null>;
}

export interface OrphanSweepResult {
  removed: string[];
  kept: KeptOrphanTree[];
  /** Unreferenced children left alone this pass, with why. */
  skipped: Array<{ path: string; reason: string }>;
  /** Missing registrations under the state home that scoped prune removed. */
  pruned: string[];
}

export interface OrphanTreeSweepDeps {
  directories: readonly string[];
  stateHome: string;
  /** Every path a task, task repository, or live check lease row names. */
  referencedPaths: () => string[];
  /** Paths native slot rows name. Scoped prune leaves their registrations to reconcile. */
  slotPaths: () => string[];
  /** Every source repository Mission Control knows, for scoped prune. */
  sourceRepositories: () => string[];
  inFlight: InFlightTrees;
  occupancy: (paths: readonly string[]) => Promise<Map<string, WorktreeOccupancy>>;
  /**
   * The owning pool claim's seed for a worktree: what it regenerates, the delete rule counts as
   * regenerable alongside the built-in list.
   */
  seed: (path: string) => RegenerableSeed;
  /** Why a worktree is not clean enough to remove, or null when it is: the delete rule. */
  blocker: (path: string) => Promise<string | null>;
  execute: typeof run;
  now: () => number;
  graceMs: number;
}

/** Every path a domain row names as its tree, read from durable state each pass. */
export function referencedTreePaths(db: DatabaseSync = openDb()): string[] {
  const rows = db.prepare(
    `SELECT worktree_path AS path FROM tasks WHERE worktree_path IS NOT NULL
     UNION SELECT worktree_path FROM task_repos WHERE worktree_path IS NOT NULL
     UNION SELECT lease_path FROM workflow_check_leases WHERE cleanup_state IN ('held', 'returning')`,
  ).all() as Array<{ path: string }>;
  return rows.map((row) => row.path);
}

export function knownSourceRepositories(db: DatabaseSync = openDb()): string[] {
  const rows = db.prepare(
    `SELECT main_checkout_root AS root FROM worktree_pools
     UNION SELECT repo_root FROM tasks
     UNION SELECT repo_root FROM task_repos
     UNION SELECT repo_root FROM workflow_check_leases`,
  ).all() as Array<{ root: string }>;
  return rows.map((row) => row.root);
}

function slotTreePaths(db: DatabaseSync = openDb()): string[] {
  return (db.prepare("SELECT path FROM worktree_slots").all() as Array<{ path: string }>).map((row) => row.path);
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function ok(result: Awaited<ReturnType<typeof run>>): boolean {
  return result.code === 0 && !result.outcomeUnknown && !result.overflowed;
}

/** What a child's top-level `.git` says about it. */
type GitMarker =
  /** A `.git` file whose gitdir exists: a candidate worktree. */
  | { kind: "worktree" }
  /** A `.git` file whose gitdir is gone: git's own leftover. */
  | { kind: "leftover" }
  | { kind: "none" }
  /** A `.git` directory, symlink, or unreadable file: nothing the sweep may discard. */
  | { kind: "other" };

async function gitMarker(path: string): Promise<GitMarker> {
  const marker = join(path, ".git");
  const stat = await lstat(marker).catch(() => null);
  if (!stat) return { kind: "none" };
  if (!stat.isFile()) return { kind: "other" };
  try {
    const match = /^gitdir: (.+)$/m.exec(await readFile(marker, "utf8"));
    if (!match) return { kind: "other" };
    const gitdir = match[1]!.trim();
    const target = isAbsolute(gitdir) ? gitdir : resolve(path, gitdir);
    return (await lstat(target).catch(() => null)) ? { kind: "worktree" } : { kind: "leftover" };
  } catch {
    return { kind: "other" };
  }
}

/**
 * A husk holds no file anywhere but git's own leftover `.git` at its top: only directories,
 * empty or nesting more of them. Any other entry, a symlink included, is something the sweep
 * cannot prove is git's own.
 */
async function isHusk(path: string, leftoverGitFile: boolean): Promise<boolean> {
  const pending = [path];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (!(leftoverGitFile && directory === path && entry.name === ".git" && entry.isFile())) return false;
    }
  }
  return true;
}

/** Directories a discard deletes without anyone losing work, so the signature stops at them. */
const REGENERABLE_DIRECTORIES = new Set(REGENERABLE_IGNORED_PATHS.map((each) => each.replace(/\/$/, "")));
/** How many entries of one directory are stat'ed at once. */
const SIGNATURE_STAT_BATCH = 64;

/**
 * Every entry under `path`, in a stable order, with its kind, size and modification time. A
 * regenerable directory such as `node_modules/`, or one the owning pool's seed regenerates
 * (never one an exclusion could reach), contributes its own stat only: a warmed tree can hold hundreds of thousands of entries
 * there, and they are deleted either way. An entry that vanishes mid-walk is recorded as gone
 * rather than thrown, so the tree reads as changed.
 */
async function treeSignature(path: string, seed: RegenerableSeed): Promise<string> {
  const hash = createHash("sha256");
  const pending = [path];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const names = await readdir(directory).catch(() => null);
    if (names === null) {
      hash.update(`${relative(path, directory)}\0gone\n`);
      continue;
    }
    names.sort();
    for (let start = 0; start < names.length; start += SIGNATURE_STAT_BATCH) {
      const batch = names.slice(start, start + SIGNATURE_STAT_BATCH).map((name) => join(directory, name));
      const stats = await Promise.all(batch.map((child) => lstat(child).catch(() => null)));
      batch.forEach((child, index) => {
        const stat = stats[index];
        const name = relative(path, child);
        if (!stat) {
          hash.update(`${name}\0gone\n`);
          return;
        }
        if (stat.isDirectory() && !REGENERABLE_DIRECTORIES.has(basename(child)) && !seedRegenerates(`${name}/`, seed)) {
          pending.push(child);
        }
        hash.update(`${name}\0${stat.isDirectory() ? "d" : stat.isFile() ? "f" : "o"}\0${stat.size}\0${stat.mtimeMs}\n`);
      });
    }
  }
  return hash.digest("hex");
}

/** Up to `DESCRIBED_FILES` regular files and links under a folder that is not a worktree. */
async function listedFiles(path: string): Promise<{ files: string[]; moreFiles: boolean }> {
  const files: string[] = [];
  const pending = [path];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    // Gone or unreadable since the sweep kept it: the signature records that, so skip it here.
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
        continue;
      }
      if (files.length === DESCRIBED_FILES) return { files, moreFiles: true };
      files.push(relative(path, child));
    }
  }
  return { files, moreFiles: false };
}

/**
 * The worktree's changed, untracked and ignored paths, as `git status` lists them, or null when
 * Git cannot read it. Ignored paths are read in matching mode, as the work check reads them, so a
 * file an ignore pattern names is listed by itself rather than folded into its directory. One the
 * delete rule discounts is labelled regenerable: it is deleted too, but loses no work.
 */
async function statusFiles(
  path: string,
  seed: RegenerableSeed,
  execute: typeof run,
): Promise<{ files: string[]; moreFiles: boolean } | null> {
  const status = await execute(
    "git",
    ["--no-optional-locks", "-C", path, "status", "--porcelain", "--ignored=matching", "--untracked-files=normal"],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (!ok(status)) return null;
  const lines = status.stdout.split("\n").filter(Boolean).map((line) => {
    const code = line.slice(0, 2);
    const name = line.slice(3);
    if (code === "??") return `${name} (untracked)`;
    if (code === "!!") return `${name} (${regenerableIgnoredPath(name, seed) ? "regenerable" : "ignored"})`;
    return `${name} (changed)`;
  });
  return { files: lines.slice(0, DESCRIBED_FILES), moreFiles: lines.length > DESCRIBED_FILES };
}

/** What a discard preview states about a folder Git may or may not be able to read. */
export type TreeDiscard = Pick<UnownedTreeDescription, "worktree" | "work" | "files" | "moreFiles" | "signature">;

/**
 * What deleting this folder loses, by the delete rule when Git can read it, and otherwise up to
 * `DESCRIBED_FILES` of its files. `seed` is the owning pool's; a tree with no pool gets `NO_SEED`.
 */
export async function describeTreeDiscard(path: string, seed: RegenerableSeed, execute: typeof run = run): Promise<TreeDiscard> {
  const worktree = (await gitMarker(path)).kind === "worktree";
  const status = worktree ? await statusFiles(path, seed, execute) : null;
  const work = worktree ? await worktreeDiscardedWork(path, { regenerableIgnored: true, seed, execute }) : [];
  const { files, moreFiles } = status ?? await listedFiles(path);
  return { worktree, work, files, moreFiles, signature: await treeSignature(path, seed) };
}

/**
 * Lists the children of the overflow and check-fallback directories and removes the ones no
 * live owner references and that are provably disposable. One pass runs at a time; a caller
 * that asks while one runs waits for it.
 */
export class OrphanTreeSweep implements UnownedTreeDiscards {
  private readonly deps: OrphanTreeSweepDeps;
  private running: Promise<OrphanSweepResult> | null = null;
  /** Passes and discards, one at a time, so a removal never races a pass over the same tree. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Unreferenced children past their grace that the last pass left on disk, occupied ones included. */
  private unreferencedTrees: string[] = [];
  /** Kept children by subject (`<path>:<inode>`), as of the last pass. */
  private kept = new Map<string, KeptOrphanTree>();
  /** Kept subjects that no longer exist, reported once so their first-seen entries go at once. */
  private gone: string[] = [];

  constructor(deps: Partial<OrphanTreeSweepDeps> = {}) {
    this.deps = {
      directories: [WORKTREES_DIR, CHECK_WORKTREES_DIR],
      stateHome: STATE_DIR,
      referencedPaths: () => referencedTreePaths(),
      slotPaths: () => slotTreePaths(),
      sourceRepositories: () => knownSourceRepositories(),
      inFlight: inFlightTrees,
      occupancy: inspectWorktreeOccupancy,
      seed: (path) => treeSeed(path),
      blocker: (path) => worktreeReturnBlocker(path, { regenerableIgnored: true, seed: this.deps.seed(path) }),
      execute: run,
      now: Date.now,
      graceMs: ORPHAN_TREE_GRACE_MS,
      ...deps,
    };
  }

  /**
   * A pass that starts after this call, never one already in flight. A Kill's retry needs this:
   * a pass that began before the kill may have seen the process and would skip the tree again.
   */
  sweepFresh(): Promise<OrphanSweepResult> {
    return this.exclusive(() => this.pass());
  }

  sweep(): Promise<OrphanSweepResult> {
    this.running ??= this.exclusive(() => this.pass()).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /**
   * Every unreferenced tree the last pass left in place: the kept ones, and the ones it skipped
   * because a process occupies them or their occupancy was unknown. The orphan process scan
   * inspects these, so a process holding an unowned tree is reported and can be killed.
   */
  unreferenced(): string[] {
    return [...this.unreferencedTrees];
  }

  async describe(path: string): Promise<UnownedTreeDescription | null> {
    const real = await realpath(path).catch(() => null);
    const tree = real === null ? undefined : [...this.kept.values()].find((each) => each.path === real);
    if (!tree) return null;
    const stat = await lstat(tree.path).catch(() => null);
    if (!stat?.isDirectory() || stat.ino !== tree.inode) return null;
    const worktree = (await gitMarker(tree.path)).kind === "worktree";
    // The delete rule: a folder with no repository has no pool, so only the built-in list applies.
    const seed = worktree ? this.deps.seed(tree.path) : NO_SEED;
    return { ...tree, ...await describeTreeDiscard(tree.path, seed, this.deps.execute) };
  }

  discard(path: string): Promise<string | null> {
    return this.exclusive(() => this.discardNow(path));
  }

  /**
   * The scoped prune alone, outside a pass. A check lease that deleted a tree Git no longer
   * recognized calls this once the lease has settled, so its registration goes in the same pass.
   */
  pruneRegistrations(): Promise<string[]> {
    return this.exclusive(() => this.prune(this.referencedSet()));
  }

  /** Every path a row names, in both its resolved and canonical spellings. */
  private referencedSet(): Set<string> {
    const referenced = new Set<string>();
    for (const path of this.deps.referencedPaths()) {
      referenced.add(resolve(path));
      referenced.add(canonicalWorktreePath(path));
    }
    return referenced;
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * The same proof a pass needs before it touches a tree, taken again now: the sweep still keeps
   * it, it is the same folder (inode included), no row names it, nothing is creating it, and no
   * process is in it.
   */
  private async discardNow(path: string): Promise<string | null> {
    const tree = [...this.kept.values()].find((each) => each.path === path);
    if (!tree) return "the sweep no longer keeps that tree; preview it again";
    const subject = `${tree.path}:${tree.inode}`;
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isDirectory() || stat.ino !== tree.inode || await realpath(path).catch(() => null) !== path) {
      return "the folder changed since it was kept; preview it again";
    }
    if (this.deps.referencedPaths().some((named) => pathContains(path, resolve(named)) || pathContains(path, canonicalWorktreePath(named)))) {
      return "a task or check now names that tree";
    }
    if (this.deps.inFlight.has(path)) return "it is being created";
    const occupied = (await this.deps.occupancy([path])).get(path);
    if (!occupied || occupied.status === "unknown") return `its processes could not be inspected: ${occupied?.reason ?? "occupancy is unknown"}`;
    if (occupied.occupants.length > 0) return `${occupied.occupants.length} process(es) still use it`;
    try {
      if ((await gitMarker(path)).kind === "worktree") {
        const refused = await this.removeWorktree(path);
        if (refused) return refused;
      }
      // `worktree remove` deletes the folder; anything else is deleted here, every file in it.
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      return `it could not be removed: ${message(error)}`;
    }
    this.kept.delete(subject);
    this.gone.push(subject);
    this.unreferencedTrees = this.unreferencedTrees.filter((each) => each !== path);
    return null;
  }

  /**
   * The `dirty-orphan-folder` problems of the last pass. Each subject is a folder's path and
   * inode, so the same folder keeps its first-seen time and a recreated one starts afresh.
   */
  problems(): StorageProblemObservation {
    const gone = this.gone;
    this.gone = [];
    return {
      firstSeen: [...this.kept.entries()].map(([subject, tree]) => ({
        subject: `dirty-orphan-folder:${subject}`,
        problem: (firstSeenAt: number) => storageProblem(
          "dirty-orphan-folder",
          tree.path,
          firstSeenAt,
          `Unowned tree ${tree.path} was kept: ${tree.reason}`,
          { target: "unowned-tree", path: tree.path },
        ),
      })),
      goneSubjects: gone.map((subject) => `dirty-orphan-folder:${subject}`),
    };
  }

  private async pass(): Promise<OrphanSweepResult> {
    const result: OrphanSweepResult = { removed: [], kept: [], skipped: [], pruned: [] };
    const referenced = this.referencedSet();
    const isReferenced = (path: string) => [...referenced].some((named) => pathContains(path, named));

    const candidates: Array<{ path: string; inode: number }> = [];
    const present = new Set<string>();
    for (const directory of this.deps.directories) {
      const listed = await this.children(directory);
      for (const { path, inode } of listed) {
        present.add(`${path}:${inode}`);
        if (isReferenced(path)) continue;
        if (this.deps.inFlight.has(path)) {
          result.skipped.push({ path, reason: "being created" });
        } else if (await this.recentlyModified(path)) {
          result.skipped.push({ path, reason: "modified within the grace period" });
        } else {
          candidates.push({ path, inode });
        }
      }
    }

    // The occupancy query answers at most `OCCUPANCY_BATCH` paths at once.
    const occupancy = new Map<string, WorktreeOccupancy>();
    for (let start = 0; start < candidates.length; start += OCCUPANCY_BATCH) {
      const batch = candidates.slice(start, start + OCCUPANCY_BATCH).map((each) => each.path);
      for (const [path, each] of await this.deps.occupancy(batch)) occupancy.set(path, each);
    }
    for (const candidate of candidates) {
      const occupied = occupancy.get(candidate.path);
      if (!occupied || occupied.status === "unknown") {
        result.skipped.push({ path: candidate.path, reason: occupied?.reason ?? "occupancy is unknown" });
      } else if (occupied.occupants.length > 0) {
        result.skipped.push({ path: candidate.path, reason: "occupied" });
      } else {
        await this.settle(candidate, result);
      }
    }

    // A kept tree skipped this pass (occupied, or touched within the grace) is still kept, so
    // its problem and first-seen time carry over. One that left the kept set any other way -
    // removed by this pass, referenced by a row, or no longer on disk with that inode - is
    // reported gone, so its first-seen entry goes at once rather than outliving the problem.
    const kept = new Map(result.kept.map((tree) => [`${tree.path}:${tree.inode}`, tree]));
    const skipped = new Set(result.skipped.map((each) => each.path));
    for (const [subject, tree] of this.kept) {
      if (kept.has(subject)) continue;
      if (present.has(subject) && skipped.has(tree.path)) kept.set(subject, tree);
      else this.gone.push(subject);
    }
    this.kept = kept;
    const removed = new Set(result.removed);
    this.unreferencedTrees = candidates.map((each) => each.path).filter((path) => !removed.has(path));

    result.pruned = await this.prune(referenced);
    return result;
  }

  /** Real directories directly inside `directory`, never a symlink or anything resolving out. */
  private async children(directory: string): Promise<Array<{ path: string; inode: number }>> {
    let real: string;
    let names: string[];
    try {
      real = await realpath(directory);
      names = await readdir(real);
    } catch {
      return [];
    }
    const found: Array<{ path: string; inode: number }> = [];
    for (const name of names) {
      const path = join(real, name);
      try {
        const stat = await lstat(path);
        if (!stat.isDirectory() || await realpath(path) !== path) continue;
        found.push({ path, inode: stat.ino });
      } catch {
        // Gone between the listing and the stat.
      }
    }
    return found;
  }

  private async recentlyModified(path: string): Promise<boolean> {
    const since = this.deps.now() - this.deps.graceMs;
    for (const each of [path, join(path, ".git")]) {
      const stat = await lstat(each).catch(() => null);
      if (stat && stat.mtimeMs > since) return true;
    }
    return false;
  }

  private async settle(tree: { path: string; inode: number }, result: OrphanSweepResult): Promise<void> {
    const keep = (reason: string): void => {
      result.kept.push({ ...tree, reason });
    };
    try {
      const marker = await gitMarker(tree.path);
      if (marker.kind === "worktree") {
        const kept = await this.deps.blocker(tree.path) ?? await this.removeWorktree(tree.path);
        if (kept) keep(kept);
        else result.removed.push(tree.path);
        return;
      }
      if (marker.kind === "other" || !await isHusk(tree.path, marker.kind === "leftover")) {
        keep("folder is not a Git worktree but still holds files");
        return;
      }
      // Checked again after every await above: a creation registered since must win.
      if (this.deps.inFlight.has(tree.path)) {
        result.skipped.push({ path: tree.path, reason: "being created" });
        return;
      }
      await rm(tree.path, { recursive: true });
      result.removed.push(tree.path);
    } catch (error) {
      keep(`folder could not be inspected: ${message(error)}`);
    }
  }

  /**
   * Remove a clean worktree through its own repository, then delete its `harness/*` branch
   * only when a remote branch contains it. Returns why it was kept, or null once removed.
   */
  private async removeWorktree(path: string): Promise<string | null> {
    const git = (args: string[]) => this.deps.execute("git", args, { timeoutMs: GIT_TIMEOUT_MS });
    const common = await git(["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!ok(common)) return "its repository could not be read";
    const commonDir = common.stdout.trim();
    const head = await git(["-C", path, "symbolic-ref", "-q", "--short", "HEAD"]);
    const branch = head.code === 0 ? head.stdout.trim() : "";
    if (this.deps.inFlight.has(path)) return "it is being created";
    const removed = await git(["--git-dir", commonDir, "worktree", "remove", "--force", path]);
    if (!ok(removed)) return `it could not be removed: ${commandFailureText(removed)}`;
    if (branch.startsWith("harness/")) {
      const contained = await git([
        "--git-dir", commonDir, "for-each-ref", "--contains", `refs/heads/${branch}`, "--format=%(refname)", "refs/remotes",
      ]);
      if (ok(contained) && contained.stdout.trim()) {
        await git(["--git-dir", commonDir, "branch", "-D", branch]);
      }
    }
    return null;
  }

  /**
   * Scoped `git worktree prune`: for each known repository, remove only the `prunable`
   * registrations whose path is under the state home and no longer exists. Never an unscoped
   * prune, so the operator's own worktrees elsewhere are untouched, and never a path a row or
   * a native slot names: those trees have owners that decide.
   */
  private async prune(referenced: ReadonlySet<string>): Promise<string[]> {
    const git = (args: string[]) => this.deps.execute("git", args, { timeoutMs: GIT_TIMEOUT_MS });
    const homes = [resolve(this.deps.stateHome), canonicalWorktreePath(this.deps.stateHome)];
    const owned = new Set(referenced);
    for (const path of this.deps.slotPaths()) {
      owned.add(resolve(path));
      owned.add(canonicalWorktreePath(path));
    }
    const commonDirs = new Set<string>();
    for (const root of new Set(this.deps.sourceRepositories())) {
      const common = await git(["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
      if (ok(common) && common.stdout.trim()) commonDirs.add(common.stdout.trim());
    }
    const pruned: string[] = [];
    for (const commonDir of commonDirs) {
      const listed = await git(["--git-dir", commonDir, "worktree", "list", "--porcelain"]);
      if (!ok(listed)) continue;
      for (const block of listed.stdout.split(/\n\n+/)) {
        const lines = block.split("\n");
        const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
        if (!path || !lines.some((line) => line.startsWith("prunable"))) continue;
        if (!homes.some((home) => pathContains(home, path) && resolve(path) !== home)) continue;
        if (owned.has(resolve(path)) || this.deps.inFlight.has(path)) continue;
        // `remove --force` deletes a directory that exists; only a missing one is a registration alone.
        if (await lstat(path).then(() => true, () => false)) continue;
        const removed = await git(["--git-dir", commonDir, "worktree", "remove", "--force", path]);
        if (ok(removed)) pruned.push(path);
        else console.warn(`[worktrees] could not prune the registration of ${path}: ${commandFailureText(removed)}`);
      }
    }
    return pruned;
  }
}
