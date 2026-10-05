import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join, matchesGlob, normalize, posix } from "node:path";
import type { TestingConfig } from "@shared/testing-config.ts";
import type { WorkflowSelectedTest } from "@shared/workflow.ts";
import { changedPathsSince, deletedPathsSince, type ChangedPathsResult } from "./diff.ts";
import { run } from "./util/exec.ts";

// Which tests an `affected-tests` check runs, from the project's `.mission/testing.json`:
//
//  1. test files the change added or modified, matched by `tests.patterns`;
//  2. when `tests.includeImporters` is on, tests that import a changed file, directly or through
//     other files - found with a lexical JS/TS import scanner, not a bundler;
//  3. the smoke set, `tests.smokeSet`, which always runs.
//
// "Changed" is measured from the merge base with the default branch, or with `origin/<base>` for
// a task that names a base branch - the same base the session diff uses (`changedPathsSince`).
// The scanner is deliberately conservative: an import it cannot resolve (a package, a computed
// specifier) is ignored, and a type-only import counts as a dependency, because running one test
// too many costs seconds while missing one costs a broken merge.

export type TestSelection =
  | { ok: true; files: WorkflowSelectedTest[]; changedCount: number }
  | { ok: false; reason: string };

export interface TestSelectionDeps {
  /** Defaults to `changedPathsSince`. */
  changedPaths?: (treeRoot: string, baseBranch: string | null) => Promise<ChangedPathsResult>;
  /** Defaults to `deletedPathsSince`: files the change removed, from the same base. */
  deletedPaths?: (treeRoot: string, baseBranch: string | null) => Promise<ChangedPathsResult>;
  /** Defaults to `git ls-files`. Repository-relative, forward slashes. */
  trackedFiles?: (treeRoot: string) => Promise<string[] | null>;
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
  targets: string[];
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

/** `compilerOptions.paths` from the repository's root `tsconfig.json`, as repo-relative targets. */
export function readPathAliases(treeRoot: string): PathAlias[] {
  const text = readSource(join(treeRoot, "tsconfig.json"));
  if (text === null) return [];
  let config: unknown;
  try {
    config = parseJsonc(text);
  } catch {
    return [];
  }
  const options = (config as { compilerOptions?: { baseUrl?: unknown; paths?: unknown } })?.compilerOptions;
  if (!options || typeof options.paths !== "object" || options.paths === null) return [];
  const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : ".";
  const aliases: PathAlias[] = [];
  for (const [key, value] of Object.entries(options.paths as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const star = key.indexOf("*");
    const targets = value
      .filter((target): target is string => typeof target === "string")
      .map((target) => posix.normalize(posix.join(baseUrl, target)));
    aliases.push(star === -1
      ? { prefix: key, suffix: "", wildcard: false, targets }
      : { prefix: key.slice(0, star), suffix: key.slice(star + 1), wildcard: true, targets });
  }
  return aliases;
}

class ImportResolver {
  constructor(
    private readonly files: ReadonlySet<string>,
    private readonly aliases: readonly PathAlias[],
  ) {}

  /** The repository-relative file `specifier` names from `importer`, or null. */
  resolve(importer: string, specifier: string): string | null {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      return this.resolveFile(posix.normalize(posix.join(posix.dirname(importer), specifier)));
    }
    for (const alias of this.aliases) {
      if (!alias.wildcard && specifier !== alias.prefix) continue;
      if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) continue;
      const middle = specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
      for (const target of alias.targets) {
        const resolved = this.resolveFile(target.replace("*", middle));
        if (resolved) return resolved;
      }
    }
    return null;
  }

  private resolveFile(candidate: string): string | null {
    if (candidate.startsWith("../")) return null;
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
    for (const ext of SOURCE_EXTENSIONS) {
      if (this.files.has(`${candidate}/index${ext}`)) return `${candidate}/index${ext}`;
    }
    return null;
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
    const source = readSource(join(treeRoot, file));
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
  config: TestingConfig,
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
  const { patterns, includeImporters, smokeSet } = config.tests;
  const tests = [...present].filter((file) => matchesAny(file, patterns)).sort();

  const selected = new Map<string, WorkflowSelectedTest>();
  for (const file of tests) {
    if (changed.has(file)) selected.set(file, { path: file, reason: "changed" });
  }
  if (includeImporters && changed.size > 0) {
    const resolver = new ImportResolver(new Set([...present, ...deleted]), readPathAliases(treeRoot));
    const reached = testsReachingChanges(treeRoot, tests, changed, resolver);
    for (const [file, via] of reached) {
      if (!selected.has(file)) selected.set(file, { path: file, reason: "imports", via });
    }
  }
  for (const file of [...present].filter((candidate) => matchesAny(candidate, smokeSet)).sort()) {
    if (!selected.has(file)) selected.set(file, { path: file, reason: "smoke" });
  }
  const files = [...selected.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, files, changedCount: changed.size };
}

