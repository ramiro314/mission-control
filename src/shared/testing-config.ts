import { z } from "zod";

// A project's testing settings, in three layers merged key by key, lowest first:
// `.mission/testing.json`, committed to the repository; stored settings, kept in Mission
// Control's database for a repository that will not commit the file (`tests.*` keys only); and
// `.mission/testing.local.json`, a gitignored per-checkout override that has the last word.
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
