import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  StoredTestingSettingsSchema,
  buildTestingScopes,
  mergeTestingLayers,
  parseTestingConfig,
  type LayeredTestingConfig,
  type StoredTestingLayer,
  type TestingScopes,
} from "../../src/shared/testing-config.ts";

// A fixture monorepo for affected-test selection with subdirectory testing scopes: two apps, a
// shared package with no testing scope of its own, and some root tooling, and deliberately NO root
// tsconfig.json. Shared by the scope tests, the import resolution tests and the gate tests, which
// partition it.

/** A stored layer at a repository-relative scope, validated through the stored schema. */
export function storedLayer(scope: string, settings: unknown): StoredTestingLayer {
  return { scope, settings: StoredTestingSettingsSchema.parse(settings) };
}

/** The root's merge from a committed file (or none) and a stored root row (or none). */
export function rootLayers(committed: unknown | null, stored: unknown | null = null): LayeredTestingConfig {
  const parsed = committed === null ? null : parseTestingConfig(JSON.stringify(committed));
  if (parsed && !parsed.ok) throw new Error(parsed.error);
  return mergeTestingLayers(parsed?.config ?? null, stored === null ? null : storedLayer("", stored), null);
}

export const MONOREPO_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }),
  "tools/root.test.ts": "export {};\n",
  "tools/root-smoke.test.ts": "export {};\n",
  "apps/web/package.json": JSON.stringify({ name: "web" }),
  // A per-app alias, read because it is the nearest config to the app's files. There is no root one.
  "apps/web/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@web/*": ["src/*"] } } }),
  "apps/web/src/util.ts": "export const u = 1;\n",
  "apps/web/src/a.test.ts": "import { u } from \"./util.ts\";\n",
  "apps/web/src/alias.test.ts": "import { u } from \"@web/util.ts\";\n",
  "apps/web/src/untouched.test.ts": "export {};\n",
  "apps/web/smoke/web.smoke.ts": "export {};\n",
  "apps/web/smoke.spec.ts": "export {};\n",
  "apps/api/package.json": JSON.stringify({ name: "api" }),
  "apps/api/lib/b.ts": "export const b = 1;\n",
  "apps/api/lib/b.spec.ts": "import { b } from \"./b.ts\";\n",
  "apps/api/lib/c.spec.ts": "export {};\n",
  "apps/api/lib/old.test.ts": "export {};\n",
  "apps/api/smoke.spec.ts": "export {};\n",
  // A shared package: no scope and no Command of its own, so its tests belong to the root.
  "packages/ui/package.json": JSON.stringify({ name: "ui" }),
  "packages/ui/src/button.ts": "export const button = 1;\n",
  "packages/ui/src/button.test.ts": "import { button } from \"./button.ts\";\n",
};

export const MONOREPO_TRACKED = Object.keys(MONOREPO_FILES);

/** The change: one source file in each app and in the package, and two test files in the api app. */
export const MONOREPO_CHANGED = [
  "apps/web/src/util.ts",
  "apps/api/lib/b.ts",
  "apps/api/lib/c.spec.ts",
  "apps/api/lib/old.test.ts",
  "packages/ui/src/button.ts",
];

/** The root's stored settings, generic and repository-relative. */
export const MONOREPO_ROOT_SETTINGS = {
  tests: { patterns: ["**/*.test.ts"], smokeSet: ["tools/root-smoke.test.ts", "apps/*/smoke.spec.ts"] },
};

/** Each app's own settings, relative to the app. */
export const MONOREPO_SUBDIRECTORY_LAYERS: StoredTestingLayer[] = [
  // The web app's own patterns and smoke set.
  storedLayer("apps/web", { tests: { patterns: ["src/**/*.test.ts"], smokeSet: ["smoke/*.ts"] } }),
  // The api app's own patterns; it does not follow imports, and inherits the root's smoke set.
  storedLayer("apps/api", { tests: { patterns: ["lib/**/*.spec.ts"], includeImporters: false } }),
];

export function monorepoScopes(): TestingScopes {
  return buildTestingScopes(rootLayers(null, MONOREPO_ROOT_SETTINGS), MONOREPO_SUBDIRECTORY_LAYERS);
}

/** Write the fixture into a fresh directory and return it. No git: selection deps are stubbed. */
export function monorepoTree(): string {
  const root = mkdtempSync(join(tmpdir(), "testing-scopes-monorepo-"));
  for (const [path, text] of Object.entries(MONOREPO_FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** What selection selects in the fixture: each scope's own patterns and smoke set at work. */
export const MONOREPO_SELECTED = [
  // Changed and matching the api app's own `lib/**/*.spec.ts`.
  { path: "apps/api/lib/c.spec.ts", reason: "changed" },
  // The root's smoke glob, inherited by the api app and matched against the whole path.
  { path: "apps/api/smoke.spec.ts", reason: "smoke" },
  // The web app's own smoke set, relative to apps/web.
  { path: "apps/web/smoke/web.smoke.ts", reason: "smoke" },
  // Imports a changed file, through a relative specifier.
  { path: "apps/web/src/a.test.ts", reason: "imports", via: "apps/web/src/util.ts" },
  // Imports the same file through the web app's own `@web/*` alias.
  { path: "apps/web/src/alias.test.ts", reason: "imports", via: "apps/web/src/util.ts" },
  // The package's test, under the root's patterns, importing the package's changed file.
  { path: "packages/ui/src/button.test.ts", reason: "imports", via: "packages/ui/src/button.ts" },
  { path: "tools/root-smoke.test.ts", reason: "smoke" },
] as const;
