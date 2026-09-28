import { z } from "zod";

// A project's testing settings: `.mission/testing.json`, committed and reviewed like code, and
// `.mission/testing.local.json`, a gitignored per-checkout override merged over it key by key.
//
// Browser-safe on purpose (no `node:` imports): the daemon reads it to select affected tests,
// run detail shows it, and the CI flake report action bundles it unchanged. The schema, its
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
