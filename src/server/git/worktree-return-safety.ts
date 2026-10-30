import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isConductorScratchPath } from "../pipelines/conductor/scratch.ts";
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
  return entry.code === "!!" && regenerableDirectory(entry.path);
}

/** The built-in regenerable set, as a predicate on an ignored entry's status path. */
export function regenerableDirectory(path: string): boolean {
  return REGENERABLE_IGNORED_PATHS.some((dir) => `/${path}`.endsWith(`/${dir}`));
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

/** The return rule's options: Kill, reclaim and sweep, which `worktreeReturnBlocker` serves. */
interface ReturnRuleOptions {
  fetch?: boolean;
  regenerableIgnored?: boolean;
  execute?: typeof run;
}

/**
 * Kill is permission to stop, not to discard work. Every uncertain read retains the tree.
 * `regenerableIgnored` is for reclaim and sweep only: it discounts ignored files under
 * `REGENERABLE_IGNORED_PATHS`, while every other ignored file (evidence, `.env`) still blocks.
 * This is always the return rule; the reset rule is asked of `worktreeWork` by name.
 */
export async function worktreeReturnBlocker(path: string, options: ReturnRuleOptions = {}): Promise<string | null> {
  return worktreeWorkBlocker(await worktreeWork(path, options));
}

/**
 * Which entries count as work. `return` (the default) is for an action that may remove the
 * folder or that must keep everything, so every ignored entry counts unless
 * `regenerableIgnored` discounts it. `reset` is for an action that keeps the slot's folder
 * and resets it to `targetCommit`: see `worktreeResetWork`.
 */
export type WorktreeWorkRule = "return" | "reset";

export type WorktreeWorkOptions =
  | (ReturnRuleOptions & { rule?: "return" })
  | (ResetRuleOptions & { rule: "reset" });

/**
 * The first entry that blocks discarding this tree. Under the return rule that is every
 * status entry in Git's order (tracked changes, untracked files, ignored files unless
 * `regenerableIgnored` discounts them), then unpushed commits, the rule
 * `worktreeReturnBlocker` states as a sentence. Under the reset rule it is the first entry
 * `worktreeResetWork` names.
 */
export async function worktreeWork(path: string, options: WorktreeWorkOptions = {}): Promise<WorktreeWork> {
  if (options.rule === "reset") {
    const work = await worktreeResetWork(path, options);
    if (work.status !== "work") return work;
    const { kind, path: entry } = work.entries[0]!;
    return { status: "work", entry: { kind, path: entry } };
  }
  const git = gitIn(path, options.execute ?? run);
  const read = await readStatus(git, path, options.fetch);
  if (!Array.isArray(read)) return read;
  try {
    const blocking = read.find((entry) => !(options.regenerableIgnored && regenerable(entry)));
    if (blocking) return { status: "work", entry: { kind: entryKind(blocking.code), path: blocking.path } };
    const unpublished = await hasUnpublishedCommits(git);
    if (unpublished === null) return unknownWork("commits could not be compared against origin");
    return unpublished ? { status: "work", entry: { kind: "unpushed", path: "HEAD" } } : { status: "clean" };
  } catch {
    return unknownWork("checkout safety could not be verified");
  }
}

function unknownWork(reason: string): { status: "unknown"; reason: string } {
  return { status: "unknown", reason };
}

/** The checkout's status entries, after proving `path` is the checkout's root. */
async function readStatus(
  git: ReturnType<typeof gitIn>,
  path: string,
  fetch: boolean | undefined,
): Promise<StatusEntry[] | { status: "unknown"; reason: string }> {
  try {
    const top = await git(["rev-parse", "--show-toplevel"]);
    if (failed(top) || await realpath(top.stdout.trim()) !== await realpath(path)) {
      return unknownWork("checkout identity could not be verified");
    }
    if (fetch) {
      const fetched = await git(["fetch", "--prune", "origin"]);
      if (failed(fetched)) return unknownWork("origin could not be refreshed");
    }
    const status = await git(["status", "--porcelain", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"]);
    if (failed(status)) return unknownWork("working tree could not be read");
    return statusEntries(status.stdout);
  } catch {
    return unknownWork("checkout safety could not be verified");
  }
}

export interface ResetRuleOptions {
  /** The commit the reset will move to. The check is only true of that commit. */
  targetCommit: string;
  fetch?: boolean;
  /**
   * Which ignored entries the reset may overwrite or delete without losing work, as a
   * predicate on the entry's status path. Defaults to `REGENERABLE_IGNORED_PATHS`.
   */
  regenerable?: (path: string) => boolean;
  execute?: typeof run;
}

/** A reset-rule entry, with why the reset would discard it when that is not self-evident. */
export interface WorktreeResetWorkEntry extends WorktreeWorkEntry {
  because: string | null;
}

/** Every entry the reset rule counts, bounded to `RESET_WORK_LIMIT` with `more` saying so. */
export type WorktreeResetWork =
  | { status: "clean" }
  | { status: "work"; entries: WorktreeResetWorkEntry[]; more: boolean }
  | { status: "unknown"; reason: string };

export const RESET_WORK_LIMIT = 20;

/** Bytes of tracked-path listing read from the target before the listing counts as overflowed. */
export const RESET_TRACKED_LISTING_BYTES = 64 * 1024 * 1024;

/** The most `.gitignore` files the target's ignore rules are evaluated from. */
const RESET_IGNORE_FILE_LIMIT = 2_000;

/** "ignored .idea/ (the target tracks .Idea/x)". */
export function describeWorktreeResetWork(entry: WorktreeResetWorkEntry): string {
  const said = describeWorktreeWork(entry);
  return entry.because ? `${said} (${entry.because})` : said;
}

/**
 * The work set's identity, for comparing two reads of it: the entries by kind and path, and
 * whether the list was cut short. Why an entry counts is left out, so a target that discards
 * the same entries for another reason is the same work set.
 */
export function worktreeResetWorkKey(work: WorktreeResetWork): string {
  if (work.status !== "work") return work.status;
  return JSON.stringify([work.entries.map(({ kind, path }) => [kind, path]), work.more]);
}

/**
 * Everything a pool reset to `targetCommit` would discard. A reset runs `checkout --force`,
 * `reset --hard` and `clean -fd`, never `-fdx`, so it keeps an ignored entry only while the
 * entry stays ignored and nothing the target tracks lands on it. Work is:
 *
 * - a staged or unstaged tracked change;
 * - an untracked file that is not ignored, other than the conductor's disposable scratch;
 * - an unpublished commit;
 * - an ignored entry outside the regenerable set that the target tracks a path at, under or
 *   above (a file, symlink or submodule where one of the entry's parent directories is),
 *   compared after Unicode normalization and case folding, always; or that the target's
 *   `.gitignore` files no longer ignore, which `clean -fd` deletes.
 *
 * It writes nothing in the slot. The last item reads a bounded tracked-path listing of the
 * target and a `.gitignore` diff, and only when one differs evaluates the target's rules in a
 * private temporary repository. Any of those steps that fails, overflows or times out counts
 * the entries it could not clear as work, so rules that cannot be evaluated never let a reset
 * run unattended. Only a read the rest of the check depends on (identity, status, commits
 * against origin) answers `unknown`.
 */
export async function worktreeResetWork(path: string, options: ResetRuleOptions): Promise<WorktreeResetWork> {
  const execute = options.execute ?? run;
  const git = gitIn(path, execute);
  const read = await readStatus(git, path, options.fetch);
  if (!Array.isArray(read)) return read;
  const isRegenerable = options.regenerable ?? regenerableDirectory;
  const entries: WorktreeResetWorkEntry[] = [];
  let more = false;
  const add = (entry: WorktreeResetWorkEntry) => {
    if (entries.length < RESET_WORK_LIMIT) entries.push(entry);
    else more = true;
  };
  try {
    const ignored: string[] = [];
    for (const entry of read) {
      if (entry.code === "!!") {
        if (!isRegenerable(entry.path)) ignored.push(entry.path);
      } else if (!(entry.code === "??" && await conductorScratch(path, entry.path))) {
        add({ kind: entryKind(entry.code), path: entry.path, because: null });
      }
    }
    const unpublished = await hasUnpublishedCommits(git);
    if (unpublished === null) return unknownWork("commits could not be compared against origin");
    if (unpublished) add({ kind: "unpushed", path: "HEAD", because: null });
    const discarded = await resetDiscards(git, execute, path, options.targetCommit, ignored);
    for (const entry of ignored) {
      const because = discarded.get(entry);
      if (because) add({ kind: "ignored", path: entry, because });
    }
  } catch {
    return unknownWork("checkout safety could not be verified");
  }
  return entries.length === 0 ? { status: "clean" } : { status: "work", entries, more };
}

/** An untracked conductor scratch file, proven a regular file under real directories. */
async function conductorScratch(root: string, relative: string): Promise<boolean> {
  if (!isConductorScratchPath(relative)) return false;
  const parts = relative.split("/");
  let current = root;
  try {
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = await lstat(current);
      if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Which of these ignored entries a reset to `target` would overwrite or delete, each with why.
 * An entry the evaluation could not clear is in the map too, with the step that failed.
 */
async function resetDiscards(
  git: ReturnType<typeof gitIn>,
  execute: typeof run,
  path: string,
  target: string,
  ignored: readonly string[],
): Promise<Map<string, string>> {
  if (ignored.length === 0) return new Map();
  const unresolved = (entries: readonly string[], because: string) => new Map(entries.map((entry) => [entry, because]));
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const commit = await git(["rev-parse", "--verify", "--quiet", `${target}^{commit}`]);
  if (failed(head) || failed(commit)) return unresolved(ignored, "the reset target could not be read");
  const listing = await git(["ls-tree", "-r", "-z", "--name-only", "--full-tree", commit.stdout.trim()], {
    maxBuffer: RESET_TRACKED_LISTING_BYTES,
  });
  if (failed(listing)) {
    return unresolved(ignored, listing.overflowed
      ? "the target tracks more paths than the check reads"
      : "the target's tracked paths could not be listed");
  }
  const tracked = listing.stdout.split("\0").filter(Boolean);
  const discarded = trackedOverlaps(tracked, ignored);
  const remaining = ignored.filter((entry) => !discarded.has(entry));
  if (remaining.length === 0) return discarded;
  const unignored = await unignoredByTarget(git, execute, path, head.stdout.trim(), commit.stdout.trim(), tracked, remaining);
  for (const [entry, because] of unignored) discarded.set(entry, because);
  return discarded;
}

/**
 * Case-insensitive volumes, the operator's APFS disk among them, treat `.Idea` and `.idea`
 * as one path, and normalize Unicode. Folding both sides always can only add a refusal on a
 * case-sensitive volume, never miss an overlap on an insensitive one.
 */
function fold(path: string): string {
  return path.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

/** Each ignored entry the target tracks a path at, under or above, with the tracked path. */
function trackedOverlaps(tracked: readonly string[], ignored: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  const directories = new Map<string, string>();
  for (const path of tracked) {
    const folded = fold(path);
    if (!files.has(folded)) files.set(folded, path);
    // Longest ancestor first: one already present means every shorter one is too.
    for (let cut = folded.lastIndexOf("/"); cut > 0; cut = folded.lastIndexOf("/", cut - 1)) {
      const directory = folded.slice(0, cut);
      if (directories.has(directory)) break;
      directories.set(directory, path);
    }
  }
  const overlaps = new Map<string, string>();
  for (const entry of ignored) {
    const folded = fold(entry.replace(/\/+$/, ""));
    let hit = files.get(folded) ?? directories.get(folded);
    for (let cut = folded.indexOf("/"); !hit && cut > 0; cut = folded.indexOf("/", cut + 1)) {
      hit = files.get(folded.slice(0, cut));
    }
    if (hit) overlaps.set(entry, `the target tracks ${hit}`);
  }
  return overlaps;
}

/**
 * Each ignored entry the target's `.gitignore` files no longer ignore. `info/exclude` and
 * `core.excludesFile` do not change with the commit, so when no `.gitignore` differs between
 * HEAD and the target, nothing ignored now becomes un-ignored. When one does, the target's
 * rules are evaluated in a private temporary repository: its `.gitignore` blobs at their
 * paths, the common directory's `info/exclude`, the slot's effective `core.excludesFile` and
 * `core.ignorecase`, and an empty file or directory per entry so directory-only patterns
 * match as they would in the slot. Nothing is written in the slot or its Git directory.
 */
async function unignoredByTarget(
  git: ReturnType<typeof gitIn>,
  execute: typeof run,
  path: string,
  head: string,
  target: string,
  tracked: readonly string[],
  entries: readonly string[],
): Promise<Map<string, string>> {
  const unresolved = (because: string) => new Map(entries.map((entry) => [entry, because]));
  const isIgnoreFile = (file: string) => fold(file.slice(file.lastIndexOf("/") + 1)) === ".gitignore";
  const diff = await git(["diff", "--name-only", "-z", "--no-renames", head, target, "--", ":(glob,icase)**/.gitignore"]);
  if (failed(diff)) return unresolved("the target's .gitignore files could not be compared");
  if (!diff.stdout.split("\0").some((file) => file && isIgnoreFile(file))) return new Map();

  const ignoreFiles = tracked.filter(isIgnoreFile);
  if (ignoreFiles.some((file) => !file.endsWith("/.gitignore") && file !== ".gitignore")) {
    return unresolved("the target tracks an ignore file in another letter case");
  }
  if (ignoreFiles.length > RESET_IGNORE_FILE_LIMIT) return unresolved("the target holds more .gitignore files than the check reads");
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const excludesFile = await git(["config", "--path", "--get", "core.excludesFile"]);
  const ignoreCase = await git(["config", "--bool", "--get", "core.ignorecase"]);
  if (failed(common) || ![0, 1].includes(excludesFile.code ?? -1) || excludesFile.outcomeUnknown ||
      ![0, 1].includes(ignoreCase.code ?? -1) || ignoreCase.outcomeUnknown) {
    return unresolved("the slot's ignore settings could not be read");
  }

  let scratch: string | null = null;
  try {
    scratch = await mkdtemp(join(tmpdir(), "mission-ignore-check-"));
    const temp = (args: string[], input?: string) => execute("git", [
      "-c", "core.hooksPath=/dev/null",
      "-c", `core.ignorecase=${ignoreCase.code === 0 && ignoreCase.stdout.trim() === "true"}`,
      ...(excludesFile.code === 0 ? ["-c", `core.excludesFile=${excludesFile.stdout.trim()}`] : []),
      "-C", scratch!, ...args,
    ], { timeoutMs: 30_000, input });
    if (failed(await temp(["init", "-q"]))) return unresolved("the target's ignore rules could not be evaluated");
    // The target's blobs come from the slot's own object store, read-only, through an alternate.
    await writeFile(join(scratch, ".git", "objects", "info", "alternates"), `${join(common.stdout.trim(), "objects")}\n`);
    await mkdir(join(scratch, ".git", "info"), { recursive: true });
    await writeFile(join(scratch, ".git", "info", "exclude"), await readFile(join(common.stdout.trim(), "info", "exclude")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    }));
    if (ignoreFiles.length > 0) {
      const checkout = await temp(
        ["checkout", target, "--pathspec-from-file=-", "--pathspec-file-nul"],
        ignoreFiles.map((file) => `:(literal)${file}`).join("\0"),
      );
      if (failed(checkout)) return unresolved("the target's .gitignore files could not be read");
    }
    for (const entry of entries) {
      const stub = join(scratch, entry);
      if (entry.endsWith("/")) {
        await mkdir(stub, { recursive: true });
      } else {
        await mkdir(dirname(stub), { recursive: true });
        await writeFile(stub, "", { flag: "wx" });
      }
    }
    const checked = await temp(["check-ignore", "--no-index", "--stdin", "-z"], `${entries.join("\0")}\0`);
    // 0 names the ignored ones; 1 means none is.
    if (checked.outcomeUnknown || checked.overflowed || (checked.code !== 0 && checked.code !== 1)) {
      return unresolved("the target's ignore rules could not be evaluated");
    }
    const stillIgnored = new Set(checked.stdout.split("\0").filter(Boolean));
    return new Map(entries
      .filter((entry) => !stillIgnored.has(entry))
      .map((entry) => [entry, "the target's .gitignore files no longer ignore it"]));
  } catch {
    return unresolved("the target's ignore rules could not be evaluated");
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
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
  return (args: string[], options: { maxBuffer?: number } = {}) => execute("git", ["--no-optional-locks", "-C", path, ...args], {
    timeoutMs: 30_000,
    ...options,
  });
}

function failed(result: Awaited<ReturnType<typeof run>>): boolean {
  return result.code !== 0 || result.outcomeUnknown || result.overflowed;
}

/** Whether HEAD has commits no `origin` ref contains, or null when that cannot be read. */
async function hasUnpublishedCommits(git: ReturnType<typeof gitIn>): Promise<boolean | null> {
  const commits = await git(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]);
  if (failed(commits) || !/^\d+$/.test(commits.stdout.trim())) {
    return null;
  }
  return commits.stdout.trim() !== "0";
}
