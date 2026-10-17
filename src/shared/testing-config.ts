import { z } from "zod";

// A project's testing settings, in three layers merged key by key, lowest first:
// `.mission/testing.json`, committed to the repository; stored settings, kept in Mission
// Control's database for a repository that will not commit the file (`tests.*` keys only); and
// `.mission/testing.local.json`, a gitignored per-checkout override that has the last word at
// the root. Stored settings can also be kept for a subdirectory, a scope over the root's result
// for the files inside it (see "Testing scopes" below).
//
// Browser-safe on purpose (no `node:` imports): the daemon reads it to select affected tests,
// run detail shows it, and the CI flake report action bundles it unchanged. The schemas, their
// defaults and `mergeTestingConfig` are a cross-phase contract - later changes must stay
// backward compatible, because a committed file outlives any one release.

/** Where the committed settings live, relative to the repository root. */
export const TESTING_CONFIG_PATH = ".mission/testing.json";
/** The gitignored override, relative to the repository root of the operator's own checkout. */
export const TESTING_LOCAL_CONFIG_PATH = ".mission/testing.local.json";

/** Bounds, because both files are read from a repository and are untrusted input. */
export const TESTING_CONFIG_LIMITS = {
  fileBytes: 64 * 1024,
  patterns: 200,
  pattern: 500,
  label: 50,
} as const;

const PatternListSchema = z
  .array(z.string().min(1).max(TESTING_CONFIG_LIMITS.pattern))
  .max(TESTING_CONFIG_LIMITS.patterns);
const LabelSchema = z.string().min(1).max(TESTING_CONFIG_LIMITS.label);

const TestsFields = {
  /** Test files, as repository-relative globs. A changed file matching one is selected. */
  patterns: PatternListSchema,
  /** Also select tests that import a changed file, directly or not. JS/TS only. */
  includeImporters: z.boolean(),
  /** Globs that always run, for registry-style tests any change can break. */
  smokeSet: PatternListSchema,
};

const FlakesFields = {
  /** The label every flake issue carries. */
  label: LabelSchema,
  /** The label a flake issue gains once it crosses the threshold below. */
  actionableLabel: LabelSchema,
  /** Occurrences within `windowDays` before a flake is actionable. */
  actionableAfter: z.number().int().min(1).max(1000),
  windowDays: z.number().int().min(1).max(365),
};

export const TESTING_CONFIG_DEFAULTS = {
  tests: { patterns: [] as string[], includeImporters: true, smokeSet: [] as string[] },
  flakes: {
    label: "flaky-test",
    actionableLabel: "flaky-test:actionable",
    actionableAfter: 3,
    windowDays: 30,
  },
} as const;

/**
 * The committed file. Every key has a default, so `{}` is a valid (and selects-nothing) file,
 * and every object is strict: a typo such as `smokeSets` must be refused, not silently ignored.
 */
export const TestingConfigSchema = z.object({
  tests: z.object({
    patterns: TestsFields.patterns.default(TESTING_CONFIG_DEFAULTS.tests.patterns),
    includeImporters: TestsFields.includeImporters.default(TESTING_CONFIG_DEFAULTS.tests.includeImporters),
    smokeSet: TestsFields.smokeSet.default(TESTING_CONFIG_DEFAULTS.tests.smokeSet),
  }).strict().default({}),
  flakes: z.object({
    label: FlakesFields.label.default(TESTING_CONFIG_DEFAULTS.flakes.label),
    actionableLabel: FlakesFields.actionableLabel.default(TESTING_CONFIG_DEFAULTS.flakes.actionableLabel),
    actionableAfter: FlakesFields.actionableAfter.default(TESTING_CONFIG_DEFAULTS.flakes.actionableAfter),
    windowDays: FlakesFields.windowDays.default(TESTING_CONFIG_DEFAULTS.flakes.windowDays),
  }).strict().default({}),
}).strict();
export type TestingConfig = z.output<typeof TestingConfigSchema>;

/** The local override: the same keys, none required, no defaults - absent means "committed". */
export const TestingLocalConfigSchema = z.object({
  tests: z.object(TestsFields).partial().strict().optional(),
  flakes: z.object(FlakesFields).partial().strict().optional(),
}).strict();
export type TestingLocalConfig = z.output<typeof TestingLocalConfigSchema>;

export type TestingConfigParse<T> = { ok: true; config: T } | { ok: false; error: string };

/** Parse JSON text through a schema, with one readable sentence on failure. */
function parseWith<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, text: string, file: string): TestingConfigParse<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, config: parsed.data };
  const issues = parsed.error.issues.slice(0, 5).map((issue) => {
    const at = issue.path.length > 0 ? issue.path.join(".") : "(top level)";
    return `${at}: ${issue.message}`;
  });
  return { ok: false, error: `${file} is not valid: ${issues.join("; ")}` };
}

export function parseTestingConfig(text: string): TestingConfigParse<TestingConfig> {
  return parseWith(TestingConfigSchema, text, TESTING_CONFIG_PATH);
}

export function parseTestingLocalConfig(text: string): TestingConfigParse<TestingLocalConfig> {
  return parseWith(TestingLocalConfigSchema, text, TESTING_LOCAL_CONFIG_PATH);
}

export interface MergedTestingConfig {
  config: TestingConfig;
  /** Dotted keys whose value came from the local file, e.g. `tests.smokeSet`, sorted. */
  localKeys: string[];
}

/**
 * Lay the local override over the committed settings, key by key.
 *
 * A key the local file sets replaces the committed value outright, and a list replaces a list
 * rather than extending it - so a local file can REMOVE something (a slow smoke test) and stays
 * small. Returns which keys came from the local file, so every surface can say so.
 */
export function mergeTestingConfig(
  committed: TestingConfig,
  local: TestingLocalConfig | null,
): MergedTestingConfig {
  const localKeys: string[] = [];
  const tests = { ...committed.tests };
  const flakes = { ...committed.flakes };
  if (local?.tests) {
    for (const [key, value] of Object.entries(local.tests)) {
      if (value === undefined) continue;
      (tests as Record<string, unknown>)[key] = value;
      localKeys.push(`tests.${key}`);
    }
  }
  if (local?.flakes) {
    for (const [key, value] of Object.entries(local.flakes)) {
      if (value === undefined) continue;
      (flakes as Record<string, unknown>)[key] = value;
      localKeys.push(`flakes.${key}`);
    }
  }
  return { config: { tests, flakes }, localKeys: localKeys.sort() };
}

// ---- Stored testing settings ---------------------------------------------------------------
//
// A repository that will not commit `.mission/testing.json` can still have an affected-tests
// gate: Mission Control stores the selection keys itself, per canonical repository path (the
// same key Command overrides use). Only the three `tests.*` keys can be stored. `flakes` is read
// by the CI flake report action, and CI cannot read this machine's database, so a stored copy
// would be a setting that silently does nothing.

/** The `tests.*` keys a layer can set, in display order. */
export const TESTING_SETTINGS_KEYS = ["tests.patterns", "tests.includeImporters", "tests.smokeSet"] as const;
export type TestingSettingsKey = (typeof TESTING_SETTINGS_KEYS)[number];

/**
 * One stored row's settings: the local file's `tests` shape and nothing else. Every key is
 * optional (absent means "the layer below decides") and both levels are strict, so `flakes` or a
 * typo is refused on save rather than stored and ignored.
 */
export const StoredTestingSettingsSchema = z.object({
  tests: z.object(TestsFields).partial().strict().optional(),
}).strict();
export type StoredTestingSettings = z.output<typeof StoredTestingSettingsSchema>;

/** The keys a stored row sets. A row that sets none is not a layer. */
export function storedTestingSettingsKeys(settings: StoredTestingSettings | null): TestingSettingsKey[] {
  const tests: Record<string, unknown> = settings?.tests ?? {};
  return TESTING_SETTINGS_KEYS.filter((key) => tests[key.slice(6)] !== undefined);
}

/** One stored testing settings row, as the daemon serves it. */
export interface TestingSettingsView {
  /** The canonical path the row is keyed by: a main checkout's realpath. */
  repoRoot: string;
  settings: StoredTestingSettings;
  /** Compare-and-swap revision. A path with no row has none and is written with revision 0. */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** Which layer supplied a key's effective value. `default` means no layer set it. */
export const TESTING_SETTINGS_LAYERS = ["default", "committed", "stored", "local"] as const;
export type TestingSettingsLayer = (typeof TESTING_SETTINGS_LAYERS)[number];

export interface TestingSettingsSource {
  key: TestingSettingsKey;
  layer: TestingSettingsLayer;
  /** For `stored`, the scope's repository-relative path, `""` at the root. Otherwise null. */
  scope: string | null;
}

/** A stored layer and the scope it was stored at. */
export interface StoredTestingLayer {
  settings: StoredTestingSettings;
  /** Repository-relative, `""` for the repository root. */
  scope: string;
}

export interface LayeredTestingConfig extends MergedTestingConfig {
  /** Where each `tests.*` key's effective value came from, in `TESTING_SETTINGS_KEYS` order. */
  sources: TestingSettingsSource[];
}

/**
 * Merge the root's layers, lowest first: the committed file, the stored settings, the local file.
 *
 * Every layer replaces key by key, and a list replaces a list. With no committed file the base is
 * the schema's defaults, and a key nobody set is reported as `default`. The local file is merged
 * through `mergeTestingConfig` unchanged, so `localKeys` keeps its meaning: every key, `flakes.*`
 * included, that came from the local file.
 */
export function mergeTestingLayers(
  committed: TestingConfig | null,
  stored: StoredTestingLayer | null,
  local: TestingLocalConfig | null,
): LayeredTestingConfig {
  const base: TestingConfig = committed ?? TestingConfigSchema.parse({});
  const sources = new Map<string, TestingSettingsSource>(TESTING_SETTINGS_KEYS.map((key) => [
    key,
    { key, layer: committed ? "committed" : "default", scope: null },
  ]));
  const tests = { ...base.tests };
  for (const key of storedTestingSettingsKeys(stored?.settings ?? null)) {
    const name = key.slice(6) as keyof typeof tests;
    (tests as Record<string, unknown>)[name] = stored!.settings.tests![name];
    sources.set(key, { key, layer: "stored", scope: stored!.scope });
  }
  const merged = mergeTestingConfig({ tests, flakes: base.flakes }, local);
  for (const key of merged.localKeys) {
    const source = sources.get(key);
    if (source) sources.set(key, { key: source.key, layer: "local", scope: null });
  }
  return { ...merged, sources: TESTING_SETTINGS_KEYS.map((key) => sources.get(key)!) };
}

/** A source as run detail prints it: `committed`, `stored (root)`, `stored (apps/web)`, `local`. */
export function testingSettingsSourceLabel(source: Pick<TestingSettingsSource, "layer" | "scope">): string {
  if (source.layer !== "stored") return source.layer;
  return `stored (${source.scope ? source.scope : "root"})`;
}

// ---- Testing scopes ------------------------------------------------------------------------
//
// Stored settings can also be kept for a subdirectory, such as one app of a monorepo. Such a
// row is a SCOPE, and its keys apply to the files inside that subdirectory:
//
//  - a key it sets replaces the value it would otherwise inherit, for files inside it;
//  - its `patterns` and `smokeSet` are relative to the subdirectory, not to the repository;
//  - a key it does not set falls through to the nearest enclosing scope, and finally the root.
//
// The root scope is the merge of the root's three layers (committed, stored, local). The local
// file stays flat and root-only. A file belongs to its NEAREST scope, so nested subdirectories
// apply nearest first. An inherited key keeps the base directory of the scope that set it, so a
// root glob such as `apps/web/**/*.test.ts` still means what it says inside `apps/web`.
//
// Test selection consumes this value in place of one flat config, and per-app resolution and
// partitioning build on it. Browser-safe on purpose: glob matching lives with the selector,
// which has `node:path`.

/** One scope: the repository root, or a subdirectory with stored settings. */
export interface TestingScope {
  /** Repository-relative, forward slashes, no trailing slash. `""` is the repository root. */
  path: string;
  /** The effective `tests.*` settings for every file whose nearest scope this is. */
  tests: TestingConfig["tests"];
  /** Where each key's effective value came from, in `TESTING_SETTINGS_KEYS` order. */
  sources: TestingSettingsSource[];
}

export interface TestingScopes {
  /** The root first, then every subdirectory scope, each parent before its children. */
  scopes: TestingScope[];
  /** The root's merged settings, `flakes` and `localKeys` included, exactly as the root merge made them. */
  root: LayeredTestingConfig;
}

/**
 * A stored row's repository-relative path in canonical form, or null when it cannot name a
 * subdirectory: absolute, a trailing or doubled slash, `.` or `..`, or a backslash. `""` is the root.
 */
export function testingScopePath(path: string): string | null {
  if (path === "") return "";
  if (path.startsWith("/") || path.includes("\\")) return null;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..") ? path : null;
}

/** Whether `path` is `scope` itself or inside it, compared by whole path components. */
function withinScope(scope: string, path: string): boolean {
  return scope === "" || path === scope || path.startsWith(`${scope}/`);
}

/**
 * The repository-relative directory a key's globs are relative to: the subdirectory whose stored
 * row set it, or the root for every root layer (committed, stored at the root, local, default).
 */
export function testingSourceBase(source: Pick<TestingSettingsSource, "layer" | "scope">): string {
  return source.layer === "stored" ? source.scope ?? "" : "";
}

function nearestScope(scopes: readonly TestingScope[], path: string): TestingScope {
  let best = scopes[0]!;
  for (const scope of scopes) {
    if (scope.path.length > best.path.length && withinScope(scope.path, path)) best = scope;
  }
  return best;
}

/**
 * Build the scopes from the root's merged settings and the subdirectory rows.
 *
 * A subdirectory row that sets no key is not a layer, so it makes no scope. A row whose path is
 * not a canonical subdirectory, or repeats an earlier one, is ignored: the catalog keys rows by
 * canonical path, so neither should reach here. Each scope starts from its nearest enclosing
 * scope's effective settings and replaces key by key, a list for a list.
 */
export function buildTestingScopes(
  root: LayeredTestingConfig,
  subdirectories: readonly StoredTestingLayer[] = [],
): TestingScopes {
  const scopes: TestingScope[] = [{
    path: "",
    tests: { ...root.config.tests },
    sources: root.sources.map((source) => ({ ...source })),
  }];
  const layers = new Map<string, StoredTestingSettings>();
  for (const layer of subdirectories) {
    const path = testingScopePath(layer.scope);
    if (!path || layers.has(path) || storedTestingSettingsKeys(layer.settings).length === 0) continue;
    layers.set(path, layer.settings);
  }
  // A proper prefix sorts before every path it prefixes, so each parent is built before its children.
  for (const path of [...layers.keys()].sort()) {
    const parent = nearestScope(scopes, path);
    const settings = layers.get(path)!;
    const tests = { ...parent.tests };
    const sources = new Map(parent.sources.map((source) => [source.key, { ...source }]));
    for (const key of storedTestingSettingsKeys(settings)) {
      const name = key.slice(6) as keyof typeof tests;
      (tests as Record<string, unknown>)[name] = settings.tests![name];
      sources.set(key, { key, layer: "stored", scope: path });
    }
    scopes.push({ path, tests, sources: TESTING_SETTINGS_KEYS.map((key) => sources.get(key)!) });
  }
  return { scopes, root };
}

/** The nearest scope of a repository-relative path: the deepest scope containing it, else the root. */
export function testingScopeOf(scopes: TestingScopes, path: string): TestingScope {
  return nearestScope(scopes.scopes, path);
}

/**
 * `path` as the glob for `key` in `scope` sees it: relative to the base of the scope that set
 * that key. Null when the path is outside that base, which only a path outside `scope` can be.
 */
export function testingScopeRelativePath(
  scope: TestingScope,
  key: "tests.patterns" | "tests.smokeSet",
  path: string,
): string | null {
  const source = scope.sources.find((entry) => entry.key === key);
  const base = source ? testingSourceBase(source) : "";
  if (base === "") return path;
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
}
