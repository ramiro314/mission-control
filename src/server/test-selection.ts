import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { join, matchesGlob, normalize, posix, sep } from "node:path";
import {
  testingScopeOf,
  testingScopeRelativePath,
  type TestingScopes,
} from "@shared/testing-config.ts";
import type { WorkflowSelectedTest } from "@shared/workflow.ts";
import { changedPathsSince, deletedPathsSince, type ChangedPathsResult } from "./diff.ts";
import { run } from "./util/exec.ts";

// Which tests an `affected-tests` check runs, from the project's testing scopes (the root's
// layered settings, and a scope per subdirectory with stored settings):
//
//  1. test files the change added or modified, matched by `tests.patterns`;
//  2. when `tests.includeImporters` is on, tests that import a changed file, directly or through
//     other files - found with a lexical JS/TS import scanner, not a bundler;
//  3. the smoke set, `tests.smokeSet`, which always runs.
//
// Every file is judged by its NEAREST scope's settings, and a scope's globs are matched relative
// to the scope that set them. So a subdirectory's own `patterns` find the tests inside it, its
// own `smokeSet` replaces the root's there, and a key it does not set falls through.
//
// "Changed" is measured from the merge base with the default branch, or with `origin/<base>` for
// a task that names a base branch - the same base the session diff uses (`changedPathsSince`).
// The scanner is deliberately conservative: an import it cannot resolve (a third-party package, a
// computed specifier) is ignored, and a type-only import counts as a dependency, because running
// one test too many costs seconds while missing one costs a broken merge.
//
// A non-relative specifier resolves the way the importer's own app sees it (`ImportResolver`):
// through the `paths` and `baseUrl` of the nearest tsconfig.json or jsconfig.json at or above the
// importer, with its `extends` followed, and then through the root workspaces' package names.
// Nothing resolves outside the tree.

export type TestSelection =
  | {
    ok: true;
    files: WorkflowSelectedTest[];
    changedCount: number;
    /** What selection could not do for this repository, one sentence each, for run detail. */
    diagnostics: string[];
  }
  | { ok: false; reason: string };

export interface TestSelectionDeps {
  /** Defaults to `changedPathsSince`. */
  changedPaths?: (treeRoot: string, baseBranch: string | null) => Promise<ChangedPathsResult>;
  /** Defaults to `deletedPathsSince`: files the change removed, from the same base. */
  deletedPaths?: (treeRoot: string, baseBranch: string | null) => Promise<ChangedPathsResult>;
  /** Defaults to `git ls-files`. Repository-relative, forward slashes. */
  trackedFiles?: (treeRoot: string) => Promise<string[] | null>;
  /**
   * Reads a scanned source, config or manifest by absolute path; null when it cannot be read.
   * Defaults to reading the file, skipping one over 1 MiB.
   */
  readFile?: (abs: string) => string | null;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
/** A source file larger than this is not scanned; generated bundles are not import graphs. */
const MAX_SCANNED_BYTES = 1024 * 1024;

const STATIC_IMPORT = /\b(?:import|export)\s+(?:[^'"`;]*?\bfrom\s*)?["']([^"'\n]+)["']/g;
const CALL_IMPORT = /\b(?:import|require)\s*\(\s*["']([^"'\n]+)["']\s*\)/g;

function isSource(path: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

/**
 * Whether a repository-relative path matches its nearest scope's globs for `key`, matched
 * relative to the scope that set them: a subdirectory's own globs see `src/a.test.ts` for
 * `apps/web/src/a.test.ts`, while globs inherited from the root see the whole path.
 */
export function matchesScopeKey(
  scopes: TestingScopes,
  key: "tests.patterns" | "tests.smokeSet",
  path: string,
): boolean {
  const scope = testingScopeOf(scopes, path);
  const relative = testingScopeRelativePath(scope, key, path);
  if (relative === null) return false;
  return matchesAny(relative, key === "tests.patterns" ? scope.tests.patterns : scope.tests.smokeSet);
}

/**
 * The test universe, per scope: the files whose nearest scope it is and that match its effective
 * `patterns`. Every scope has an entry, in scope order, each list sorted. A file belongs to one
 * scope only, so the lists never overlap.
 */
export function testUniverse(scopes: TestingScopes, files: Iterable<string>): Map<string, string[]> {
  const universe = new Map<string, string[]>(scopes.scopes.map((scope) => [scope.path, []]));
  for (const file of files) {
    if (matchesScopeKey(scopes, "tests.patterns", file)) universe.get(testingScopeOf(scopes, file).path)!.push(file);
  }
  for (const list of universe.values()) list.sort();
  return universe;
}

async function gitTrackedFiles(treeRoot: string): Promise<string[] | null> {
  const listed = await run("git", ["-C", treeRoot, "ls-files", "-z"], {
    timeoutMs: 15_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.code !== 0) return null;
  return listed.stdout.split("\0").filter(Boolean);
}

function readSource(abs: string): string | null {
  try {
    const stat = statSync(abs);
    if (!stat.isFile() || stat.size > MAX_SCANNED_BYTES) return null;
    const fd = openSync(abs, "r");
    try {
      const buf = Buffer.alloc(stat.size);
      readSync(fd, buf, 0, stat.size, 0);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Every string-literal specifier a file imports, exports from, dynamically imports or requires. */
export function scanImportSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of [STATIC_IMPORT, CALL_IMPORT]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) found.add(match[1]!);
  }
  return [...found];
}

interface PathAlias {
  prefix: string;
  suffix: string;
  /** False for a key with no `*`, which names exactly one specifier. */
  wildcard: boolean;
  /** Repository-relative. Every `*` in a target is replaced by what the key's `*` matched. */
  targets: string[];
}

/** What a config chain sets, before the directory of the config that uses it is known. */
interface ConfigOptions {
  /** Repository-relative, or still starting with `${configDir}`. */
  baseUrl?: string;
  /** The raw `paths` entries, and the directory of the config that set them. */
  paths?: { entries: Array<[string, unknown]>; dir: string };
}

/** How one importer's nearest config resolves non-relative specifiers. */
interface ResolvedConfig {
  /** Exact keys first, then wildcards by longest prefix: the order TypeScript tries them. */
  aliases: PathAlias[];
  /** Repository-relative, or null when no config in the chain sets one. */
  baseUrl: string | null;
}

interface WorkspacePackage {
  dir: string;
  manifest: Record<string, unknown>;
}

/** Looked for in each directory, in this order, as TypeScript's language service does. */
const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"] as const;
const CONFIG_DIR = "${configDir}";

/** `dir/name`, where the repository root is "". */
function child(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

function parentOf(path: string): string {
  const dir = posix.dirname(path);
  return dir === "." ? "" : dir;
}

/** A repository-relative join: "" for the root, and `../…` for an escape, which is refused later. */
function joinRelative(dir: string, path: string): string {
  const joined = posix.normalize(posix.join(dir === "" ? "." : dir, path)).replace(/\/$/, "");
  return joined === "." ? "" : joined;
}

function escapesTree(path: string): boolean {
  return path === ".." || path.startsWith("../") || posix.isAbsolute(path);
}

/** The package a bare specifier names, and the subpath inside it ("" for none). */
function splitPackageSpecifier(specifier: string): { name: string; sub: string } | null {
  const parts = specifier.split("/");
  const count = specifier.startsWith("@") ? 2 : 1;
  if (parts.length < count || parts.slice(0, count).some((part) => part === "")) return null;
  return { name: parts.slice(0, count).join("/"), sub: parts.slice(count).join("/") };
}

/** A workspace's `exports` for `.` when it is one string, null when absent, "rich" for anything more. */
function exportsTarget(exports: unknown): string | null | "rich" {
  if (exports === undefined || exports === null) return null;
  if (typeof exports === "string") return exports;
  if (typeof exports === "object" && !Array.isArray(exports)) {
    const entries = Object.entries(exports as Record<string, unknown>);
    if (entries.length === 1 && entries[0]![0] === "." && typeof entries[0]![1] === "string") return entries[0]![1];
  }
  return "rich";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip `//` and `/* *\/` comments and trailing commas, so a tsconfig parses as JSON. */
function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\"") {
      const start = i++;
      while (i < text.length && text[i] !== "\"") i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Resolves the specifiers one gate's scan finds, the way each importer's own app resolves them:
 *
 *  - a relative specifier, from the importer's directory;
 *  - otherwise the `paths`, then the `baseUrl`, of the nearest tsconfig.json or jsconfig.json at or
 *    above the importer (tsconfig.json first in each directory), stopping at the tree root, with
 *    its `extends` chain applied: relative, or a package found as a workspace or in a
 *    `node_modules` inside the tree. Each `baseUrl`, and each `paths` without one, is relative to
 *    the config that set it, and `${configDir}` is the directory of the config in use;
 *  - otherwise a workspace package name from the root `package.json`'s `workspaces`.
 *
 * Every candidate keeps today's extension and JS-to-TS swaps, and nothing resolves outside the
 * tree. One resolver serves one gate, so each config and manifest is parsed at most once; what it
 * could not follow is collected in `diagnostics`, never thrown.
 */
class ImportResolver {
  readonly diagnostics = new Set<string>();
  /** Nearest config, by directory. */
  private readonly nearest = new Map<string, ResolvedConfig | null>();
  /** By config path. */
  private readonly resolvedConfigs = new Map<string, ResolvedConfig | null>();
  /** By config path: what it sets with its `extends` applied, or null when it cannot be read. */
  private readonly options = new Map<string, ConfigOptions | null>();
  /** By package directory. */
  private readonly manifests = new Map<string, Record<string, unknown> | null>();
  private workspaces: Map<string, WorkspacePackage> | null = null;
  private realRoot: string | null | undefined;

  constructor(
    private readonly treeRoot: string,
    /** Every file a specifier may resolve to: the tracked files and the ones the change deleted. */
    private readonly files: ReadonlySet<string>,
    /** The tracked files still present, where configs and workspace manifests are looked for. */
    private readonly present: ReadonlySet<string>,
    /** How every file this gate scans, and every config and manifest it parses, is read. */
    readonly readFile: (abs: string) => string | null = readSource,
  ) {}

  /** The repository-relative file `specifier` names from `importer`, or null. */
  resolve(importer: string, specifier: string): string | null {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      return this.resolveFile(joinRelative(parentOf(importer), specifier));
    }
    if (specifier === "" || specifier === "." || specifier === ".." || posix.isAbsolute(specifier)) return null;
    const config = this.configFor(parentOf(importer));
    if (config) {
      for (const alias of config.aliases) {
        const matches = alias.wildcard
          ? specifier.length >= alias.prefix.length + alias.suffix.length
            && specifier.startsWith(alias.prefix) && specifier.endsWith(alias.suffix)
          : specifier === alias.prefix;
        if (!matches) continue;
        const middle = specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
        for (const target of alias.targets) {
          const resolved = this.resolveFile(alias.wildcard ? target.replaceAll("*", middle) : target);
          if (resolved) return resolved;
        }
      }
      if (config.baseUrl !== null) {
        const resolved = this.resolveFile(joinRelative(config.baseUrl, specifier));
        if (resolved) return resolved;
      }
    }
    return this.resolveWorkspace(specifier);
  }

  private resolveFile(path: string): string | null {
    if (posix.isAbsolute(path)) return null;
    const candidate = joinRelative("", path);
    if (escapesTree(candidate)) return null;
    if (candidate !== "") {
      if (this.files.has(candidate)) return candidate;
      for (const ext of SOURCE_EXTENSIONS) {
        if (this.files.has(candidate + ext)) return candidate + ext;
      }
      const dot = candidate.lastIndexOf(".");
      const ext = dot > candidate.lastIndexOf("/") ? candidate.slice(dot) : "";
      for (const replacement of JS_TO_TS[ext] ?? []) {
        const swapped = candidate.slice(0, dot) + replacement;
        if (this.files.has(swapped)) return swapped;
      }
    }
    for (const ext of SOURCE_EXTENSIONS) {
      const index = child(candidate, `index${ext}`);
      if (this.files.has(index)) return index;
    }
    return null;
  }

  // ---- tsconfig.json and jsconfig.json ----

  /** The config that governs files in `dir`: the nearest one at or above it, up to the tree root. */
  private configFor(dir: string): ResolvedConfig | null {
    const cached = this.nearest.get(dir);
    if (cached !== undefined) return cached;
    const own = CONFIG_NAMES.map((name) => child(dir, name)).find((path) => this.present.has(path));
    const found = own !== undefined ? this.resolvedConfig(own) : dir === "" ? null : this.configFor(parentOf(dir));
    this.nearest.set(dir, found);
    return found;
  }

  private resolvedConfig(path: string): ResolvedConfig | null {
    const cached = this.resolvedConfigs.get(path);
    if (cached !== undefined) return cached;
    const options = this.configOptions(path, []);
    let resolved: ResolvedConfig | null = null;
    if (options !== null) {
      const configDir = parentOf(path);
      const fromConfigDir = (value: string) => joinRelative(configDir, `.${value.slice(CONFIG_DIR.length)}`);
      const baseUrl = options.baseUrl === undefined
        ? null
        : options.baseUrl.startsWith(CONFIG_DIR) ? fromConfigDir(options.baseUrl) : options.baseUrl;
      const aliases: PathAlias[] = [];
      if (options.paths) {
        const base = baseUrl ?? options.paths.dir;
        for (const [key, value] of options.paths.entries) {
          if (!Array.isArray(value)) continue;
          const targets = value
            .filter(isString)
            .map((target) => (target.startsWith(CONFIG_DIR) ? fromConfigDir(target) : joinRelative(base, target)));
          const star = key.indexOf("*");
          aliases.push(star === -1
            ? { prefix: key, suffix: "", wildcard: false, targets }
            : { prefix: key.slice(0, star), suffix: key.slice(star + 1), wildcard: true, targets });
        }
        // A stable sort: exact keys first, then the longest wildcard prefix, as TypeScript matches.
        aliases.sort((a, b) => Number(a.wildcard) - Number(b.wildcard)
          || (a.wildcard ? b.prefix.length - a.prefix.length : 0));
      }
      resolved = { aliases, baseUrl };
    }
    this.resolvedConfigs.set(path, resolved);
    return resolved;
  }

  /** What `path` sets with its `extends` applied: each base in order, then its own options. */
  private configOptions(path: string, stack: readonly string[]): ConfigOptions | null {
    const cached = this.options.get(path);
    if (cached !== undefined) return cached;
    const config = this.readConfig(path);
    let merged: ConfigOptions | null = null;
    if (config !== null) {
      merged = {};
      const bases = isString(config.extends)
        ? [config.extends]
        : Array.isArray(config.extends) ? config.extends.filter(isString) : [];
      for (const specifier of bases) {
        const base = this.extendsTarget(path, specifier);
        if (base === null) {
          this.diagnostics.add(`${path} extends "${specifier}", which was not found inside the repository, `
            + "so its own settings were used without it.");
          continue;
        }
        if (base === path || stack.includes(base)) {
          this.diagnostics.add(`${path} extends "${specifier}", which extends it back, so that extends was ignored.`);
          continue;
        }
        const inherited = this.configOptions(base, [...stack, path]);
        if (inherited !== null) merged = { ...merged, ...inherited };
      }
      const compilerOptions: Record<string, unknown> = isRecord(config.compilerOptions) ? config.compilerOptions : {};
      const dir = parentOf(path);
      if (isString(compilerOptions.baseUrl)) {
        merged.baseUrl = compilerOptions.baseUrl.startsWith(CONFIG_DIR)
          ? compilerOptions.baseUrl
          : joinRelative(dir, compilerOptions.baseUrl);
      }
      if (isRecord(compilerOptions.paths)) merged.paths = { entries: Object.entries(compilerOptions.paths), dir };
    }
    this.options.set(path, merged);
    return merged;
  }

  private readConfig(path: string): Record<string, unknown> | null {
    if (!this.inside(path)) {
      this.diagnostics.add(`${path} resolves outside the repository, so its paths and baseUrl were not used.`);
      return null;
    }
    const text = this.readFile(join(this.treeRoot, path));
    try {
      const parsed = text === null ? null : parseJsonc(text);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Reported below.
    }
    this.diagnostics.add(`${path} could not be read or parsed, so its paths and baseUrl were not used.`);
    return null;
  }

  /** The in-tree config file an `extends` entry names, or null when it names none. */
  private extendsTarget(from: string, specifier: string): string | null {
    const dir = parentOf(from);
    const withJson = (path: string) => (path.endsWith(".json") ? [path] : [path, `${path}.json`]);
    if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")) {
      return this.firstFile(withJson(joinRelative(dir, specifier)));
    }
    const pkg = posix.isAbsolute(specifier) ? null : splitPackageSpecifier(specifier);
    if (pkg === null) return null;
    for (const pkgDir of this.packageDirs(pkg.name, dir)) {
      let candidates: string[];
      if (pkg.sub === "") {
        const field = this.manifestAt(pkgDir)?.tsconfig;
        candidates = [...(isString(field) ? [joinRelative(pkgDir, field)] : []), child(pkgDir, "tsconfig.json")];
      } else {
        const target = joinRelative(pkgDir, pkg.sub);
        candidates = [...withJson(target), child(target, "tsconfig.json")];
      }
      const found = this.firstFile(candidates);
      if (found !== null) return found;
    }
    return null;
  }

  /** Where package `name` may live, seen from `dir`: its workspace, then each `node_modules` up to the root. */
  private packageDirs(name: string, dir: string): string[] {
    const dirs: string[] = [];
    const workspace = this.workspaceMap().get(name);
    if (workspace) dirs.push(workspace.dir);
    for (let at = dir; ; at = parentOf(at)) {
      const candidate = child(at, `node_modules/${name}`);
      if (this.inside(candidate) && isDirectory(join(this.treeRoot, candidate))) dirs.push(candidate);
      if (at === "") break;
    }
    return dirs;
  }

  private firstFile(candidates: readonly string[]): string | null {
    return candidates.find((path) => this.inside(path) && isFile(join(this.treeRoot, path))) ?? null;
  }

  /** Whether `path` exists and stays inside the tree, through symlinks as well as spelled. */
  private inside(path: string): boolean {
    if (escapesTree(path)) return false;
    if (this.realRoot === undefined) {
      try {
        this.realRoot = realpathSync(this.treeRoot);
      } catch {
        this.realRoot = null;
      }
    }
    if (this.realRoot === null) return false;
    try {
      const real = realpathSync(join(this.treeRoot, path));
      return real === this.realRoot || real.startsWith(this.realRoot + sep);
    } catch {
      return false;
    }
  }

  // ---- Workspace packages ----

  private manifestAt(dir: string): Record<string, unknown> | null {
    const cached = this.manifests.get(dir);
    if (cached !== undefined) return cached;
    const path = child(dir, "package.json");
    let manifest: Record<string, unknown> | null = null;
    // A package with no manifest is normal (a bare tsconfig package); one that will not parse is not.
    if (this.inside(path) && isFile(join(this.treeRoot, path))) {
      try {
        const text = this.readFile(join(this.treeRoot, path));
        const parsed: unknown = text === null ? null : JSON.parse(text);
        if (isRecord(parsed)) manifest = parsed;
      } catch {
        // Reported below.
      }
      if (manifest === null) {
        this.diagnostics.add(`${path} could not be read or parsed, so the package it describes was not resolved.`);
      }
    }
    this.manifests.set(dir, manifest);
    return manifest;
  }

  /**
   * Each workspace package's name, mapped to its directory: the tracked `package.json` files whose
   * directories match the root `workspaces` globs (an array, or `{ packages }`), less any `!` glob.
   */
  private workspaceMap(): Map<string, WorkspacePackage> {
    if (this.workspaces) return this.workspaces;
    const map = new Map<string, WorkspacePackage>();
    this.workspaces = map;
    if (!this.present.has("package.json")) return map;
    const root = this.manifestAt("");
    const declared = root === null
      ? []
      : Array.isArray(root.workspaces)
        ? root.workspaces
        : isRecord(root.workspaces) && Array.isArray(root.workspaces.packages) ? root.workspaces.packages : [];
    const globs = declared
      .filter(isString)
      .map((glob) => glob.trim().replace(/^(!?)\.\//, "$1").replace(/\/+$/, ""))
      .filter((glob) => glob !== "" && glob !== "!");
    const include = globs.filter((glob) => !glob.startsWith("!"));
    const exclude = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
    if (include.length === 0) return map;
    const dirs = [...this.present]
      .filter((file) => file.endsWith("/package.json"))
      .map(parentOf)
      .filter((dir) => !dir.split("/").includes("node_modules") && matchesAny(dir, include) && !matchesAny(dir, exclude))
      .sort();
    for (const dir of dirs) {
      const name = this.manifestAt(dir)?.name;
      if (!isString(name) || name === "") continue;
      const existing = map.get(name);
      if (existing) {
        this.diagnostics.add(`Workspace package "${name}" is declared by both ${existing.dir} and ${dir}; `
          + `${existing.dir} was used.`);
        continue;
      }
      map.set(name, { dir, manifest: this.manifestAt(dir)! });
    }
    return map;
  }

  /**
   * A workspace package specifier: `name` through a string `exports`, else `types`, `main`, then
   * `index`; `name/sub` inside the workspace's directory.
   */
  private resolveWorkspace(specifier: string): string | null {
    const pkg = splitPackageSpecifier(specifier);
    const workspace = pkg === null ? undefined : this.workspaceMap().get(pkg.name);
    if (pkg === null || workspace === undefined) return null;
    const exports = exportsTarget(workspace.manifest.exports);
    if (exports === "rich") {
      this.diagnostics.add(`Workspace package "${pkg.name}" (${workspace.dir}) has an exports map beyond `
        + "a single string, which selection does not read, so imports of it were resolved through its types, main or "
        + `index file, and its subpaths inside ${workspace.dir}.`);
    }
    // A workspace is never the root (its manifest is `<dir>/package.json`), so `dir/` bounds it.
    const within = (file: string | null) => (file !== null && file.startsWith(`${workspace.dir}/`) ? file : null);
    if (pkg.sub !== "") return within(this.resolveFile(joinRelative(workspace.dir, pkg.sub)));
    const manifest = workspace.manifest;
    const entries = [exports === "rich" ? null : exports, manifest.types, manifest.typings, manifest.main].filter(isString);
    for (const entry of [...entries, "index"]) {
      const resolved = within(this.resolveFile(joinRelative(workspace.dir, entry)));
      if (resolved) return resolved;
    }
    return null;
  }
}

function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

function isDirectory(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/**
 * For each test, the changed file it reaches through imports, if any.
 *
 * Walks forward from every test to learn the part of the graph tests can reach, then walks
 * BACKWARD from each changed file over that part. Cycles are harmless in both directions, and
 * nothing outside what a test can reach is ever read.
 */
function testsReachingChanges(
  treeRoot: string,
  tests: readonly string[],
  changed: ReadonlySet<string>,
  resolver: ImportResolver,
): Map<string, string> {
  const importersOf = new Map<string, Set<string>>();
  const seen = new Set<string>(tests);
  const queue = [...tests];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (!isSource(file)) continue;
    const source = resolver.readFile(join(treeRoot, file));
    if (source === null) continue;
    for (const specifier of scanImportSpecifiers(source)) {
      const target = resolver.resolve(file, specifier);
      if (!target || target === file) continue;
      let importers = importersOf.get(target);
      if (!importers) importersOf.set(target, importers = new Set());
      importers.add(file);
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }

  const testSet = new Set(tests);
  const reached = new Map<string, string>();
  for (const origin of [...changed].sort()) {
    const visited = new Set<string>([origin]);
    const frontier = [origin];
    while (frontier.length > 0) {
      const file = frontier.shift()!;
      for (const importer of importersOf.get(file) ?? []) {
        if (visited.has(importer)) continue;
        visited.add(importer);
        frontier.push(importer);
        if (testSet.has(importer) && !reached.has(importer)) reached.set(importer, origin);
      }
    }
  }
  return reached;
}

/** Select the tests one `affected-tests` check runs, in the check's worktree. */
export async function selectAffectedTests(
  treeRoot: string,
  scopes: TestingScopes,
  deps: TestSelectionDeps = {},
  /** The task's base branch, or null to measure from origin's default branch. */
  baseBranch: string | null = null,
): Promise<TestSelection> {
  const changedResult = await (deps.changedPaths ?? changedPathsSince)(treeRoot, baseBranch);
  if (!changedResult.ok) {
    return { ok: false, reason: `the changed files could not be read: ${changedResult.reason}` };
  }
  const deletedResult = await (deps.deletedPaths ?? deletedPathsSince)(treeRoot, baseBranch);
  if (!deletedResult.ok) {
    return { ok: false, reason: `the deleted files could not be read: ${deletedResult.reason}` };
  }
  const tracked = await (deps.trackedFiles ?? gitTrackedFiles)(treeRoot);
  if (!tracked) return { ok: false, reason: "the repository's files could not be listed" };

  const present = new Set(tracked.map((file) => normalize(file).split("\\").join("/")));
  // A deleted file is a change too: a test still importing it is broken by this change without
  // being touched. It is an origin of the import graph and a file specifiers may resolve to,
  // although nothing can be read from it.
  const deleted = deletedResult.paths.filter((file) => !present.has(file));
  const changed = new Set([...changedResult.paths.filter((file) => present.has(file)), ...deleted]);
  const tests = [...testUniverse(scopes, present).values()].flat().sort();

  const selected = new Map<string, WorkflowSelectedTest>();
  for (const file of tests) {
    if (changed.has(file)) selected.set(file, { path: file, reason: "changed" });
  }
  // Only tests whose own scope follows imports are walked from: a scope that turned
  // `includeImporters` off selects its tests by change and smoke set alone.
  const importing = tests.filter((file) => testingScopeOf(scopes, file).tests.includeImporters);
  const diagnostics: string[] = [];
  if (importing.length > 0 && changed.size > 0) {
    // One resolver per gate: each config and manifest is parsed once here, and again next gate.
    const resolver = new ImportResolver(treeRoot, new Set([...present, ...deleted]), present, deps.readFile);
    const reached = testsReachingChanges(treeRoot, importing, changed, resolver);
    for (const [file, via] of reached) {
      if (!selected.has(file)) selected.set(file, { path: file, reason: "imports", via });
    }
    diagnostics.push(...[...resolver.diagnostics].sort());
  }
  for (const file of [...present].filter((candidate) => matchesScopeKey(scopes, "tests.smokeSet", candidate)).sort()) {
    if (!selected.has(file)) selected.set(file, { path: file, reason: "smoke" });
  }
  const files = [...selected.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, files, changedCount: changed.size, diagnostics };
}

