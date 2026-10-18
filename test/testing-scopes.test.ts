import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTestingScopes,
  testingScopeOf,
  testingScopePath,
  testingScopeRelativePath,
  testingSourceBase,
  type TestingScopes,
} from "../src/shared/testing-config.ts";
import { resolveTestingScopes } from "../src/server/testing-config.ts";
import {
  matchesScopeKey,
  selectAffectedTests,
  testUniverse,
} from "../src/server/test-selection.ts";
import {
  MONOREPO_CHANGED,
  MONOREPO_SELECTED,
  MONOREPO_TRACKED,
  monorepoScopes,
  monorepoTree,
  rootLayers,
  storedLayer,
} from "./helpers/monorepo-testing-fixture.ts";

// Subdirectory testing scopes. A stored row for a subdirectory (one app of a monorepo) is a
// scope over the root's merged settings for the files inside it: a key it sets replaces the
// inherited value there, its globs are relative to it, and a key it does not set falls through.
//
// The shape tests pin `TestingScopes` as later work consumes it (per-app import resolution and
// partitioning reuse it unchanged), and the fixture monorepo pins what selection does with it
// while selected files still run through one invocation.

const layer = storedLayer;
const rootOnly = rootLayers;

// ---- TestingScopes shape -------------------------------------------------------------------

test("scopes are ordered root first, each parent before its children, and nest nearest first", () => {
  const scopes = buildTestingScopes(
    rootOnly({ tests: { patterns: ["**/*.test.ts"], smokeSet: ["tools/smoke.test.ts"] } }),
    [
      layer("apps/web/admin", { tests: { smokeSet: ["smoke/*.ts"] } }),
      layer("apps/web", { tests: { patterns: ["src/**/*.test.ts"], includeImporters: false } }),
      layer("apps/api", { tests: { smokeSet: [] } }),
    ],
  );
  assert.deepEqual(scopes.scopes.map((scope) => scope.path), ["", "apps/api", "apps/web", "apps/web/admin"]);

  const [root, api, web, admin] = scopes.scopes;
  assert.deepEqual(root!.tests, { patterns: ["**/*.test.ts"], includeImporters: true, smokeSet: ["tools/smoke.test.ts"] });
  // An unset key falls through to the root, with the root's source.
  assert.deepEqual(api!.tests, { patterns: ["**/*.test.ts"], includeImporters: true, smokeSet: [] });
  assert.deepEqual(api!.sources, [
    { key: "tests.patterns", layer: "committed", scope: null },
    { key: "tests.includeImporters", layer: "committed", scope: null },
    { key: "tests.smokeSet", layer: "stored", scope: "apps/api" },
  ]);
  assert.deepEqual(web!.tests, { patterns: ["src/**/*.test.ts"], includeImporters: false, smokeSet: ["tools/smoke.test.ts"] });
  // A nested scope inherits from its nearest parent, not from the root.
  assert.deepEqual(admin!.tests, { patterns: ["src/**/*.test.ts"], includeImporters: false, smokeSet: ["smoke/*.ts"] });
  assert.deepEqual(admin!.sources, [
    { key: "tests.patterns", layer: "stored", scope: "apps/web" },
    { key: "tests.includeImporters", layer: "stored", scope: "apps/web" },
    { key: "tests.smokeSet", layer: "stored", scope: "apps/web/admin" },
  ]);
  // The root's merge is carried whole, flakes included.
  assert.equal(scopes.root.config.flakes.label, "flaky-test");
});

test("the value is plain data: it survives JSON, so the browser and run detail can carry it", () => {
  const scopes = buildTestingScopes(rootOnly(null, { tests: { patterns: ["t/*.ts"] } }), [
    layer("apps/a", { tests: { patterns: ["*.ts"] } }),
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(scopes)) as TestingScopes, scopes);
});

test("a row that sets nothing, a non-canonical path and a repeat make no scope", () => {
  const scopes = buildTestingScopes(rootOnly({}), [
    layer("apps/empty", {}),
    layer("apps/empty-tests", { tests: {} }),
    layer("/abs", { tests: { patterns: ["a"] } }),
    layer("apps/../escape", { tests: { patterns: ["a"] } }),
    layer("apps/./dot", { tests: { patterns: ["a"] } }),
    layer("apps/trailing/", { tests: { patterns: ["a"] } }),
    layer("apps\\win", { tests: { patterns: ["a"] } }),
    layer("apps/a", { tests: { patterns: ["first"] } }),
    layer("apps/a", { tests: { patterns: ["second"] } }),
  ]);
  assert.deepEqual(scopes.scopes.map((scope) => scope.path), ["", "apps/a"]);
  assert.deepEqual(scopes.scopes[1]!.tests.patterns, ["first"]);
  assert.equal(testingScopePath(""), "");
  assert.equal(testingScopePath("apps/web"), "apps/web");
  assert.equal(testingScopePath("apps//web"), null);
});

test("a file's nearest scope is the deepest one containing it, by whole path components", () => {
  const scopes = buildTestingScopes(rootOnly({}), [
    layer("apps/web", { tests: { patterns: ["a"] } }),
    layer("apps/web/admin", { tests: { patterns: ["b"] } }),
  ]);
  const of = (path: string) => testingScopeOf(scopes, path).path;
  assert.equal(of("apps/web/src/a.ts"), "apps/web");
  assert.equal(of("apps/web"), "apps/web");
  assert.equal(of("apps/web/admin/x.ts"), "apps/web/admin");
  assert.equal(of("apps/web-old/x.ts"), "", "a sibling sharing a prefix is not inside");
  assert.equal(of("README.md"), "");
});

test("globs are relative to the scope that set them, so an inherited root glob still means the whole path", () => {
  const scopes = buildTestingScopes(rootOnly({ tests: { smokeSet: ["apps/web/smoke.test.ts"] } }), [
    layer("apps/web", { tests: { patterns: ["src/**/*.test.ts"] } }),
  ]);
  const web = testingScopeOf(scopes, "apps/web/src/a.test.ts");
  assert.equal(testingScopeRelativePath(web, "tests.patterns", "apps/web/src/a.test.ts"), "src/a.test.ts");
  assert.equal(testingScopeRelativePath(web, "tests.smokeSet", "apps/web/smoke.test.ts"), "apps/web/smoke.test.ts");
  assert.equal(testingSourceBase(web.sources[0]!), "apps/web");
  assert.equal(testingSourceBase(web.sources[2]!), "");
  assert.equal(matchesScopeKey(scopes, "tests.patterns", "apps/web/src/a.test.ts"), true);
  assert.equal(matchesScopeKey(scopes, "tests.smokeSet", "apps/web/smoke.test.ts"), true);
  // Outside the base of the key, a path never matches.
  assert.equal(testingScopeRelativePath(web, "tests.patterns", "tools/x.ts"), null);
});

// ---- Resolving the layers ------------------------------------------------------------------

test("settings stored only for subdirectories run the gate, over the defaults at the root", () => {
  const tree = mkdtempSync(join(tmpdir(), "testing-scopes-tree-"));
  assert.equal(resolveTestingScopes(tree, null, []).ok, false);
  // A subdirectory row that sets nothing is not a layer, so the gate is still skipped.
  const empty = resolveTestingScopes(tree, null, [layer("apps/a", {})]);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.kind, "missing");

  const read = resolveTestingScopes(tree, null, [layer("apps/a", { tests: { patterns: ["*.test.ts"] } })]);
  assert.ok(read.ok);
  assert.deepEqual(read.scopes.scopes.map((scope) => scope.path), ["", "apps/a"]);
  assert.deepEqual(read.scopes.scopes[0]!.sources.map((source) => source.layer), ["default", "default", "default"]);
});

test("the local file stays root-only: a subdirectory key beats it inside, and it falls through elsewhere", () => {
  const tree = mkdtempSync(join(tmpdir(), "testing-scopes-tree-"));
  const checkout = mkdtempSync(join(tmpdir(), "testing-scopes-checkout-"));
  mkdirSync(join(tree, ".mission"));
  writeFileSync(join(tree, ".mission/testing.json"), JSON.stringify({ tests: { patterns: ["**/*.test.ts"] } }));
  mkdirSync(join(checkout, ".mission"));
  writeFileSync(join(checkout, ".mission/testing.local.json"), JSON.stringify({
    tests: { includeImporters: false, smokeSet: ["tools/local.test.ts"] },
  }));
  const read = resolveTestingScopes(tree, checkout, [
    layer("", { tests: { smokeSet: ["tools/stored.test.ts"] } }),
    layer("apps/a", { tests: { smokeSet: ["smoke.test.ts"] } }),
  ]);
  assert.ok(read.ok);
  const [root, app] = read.scopes.scopes;
  assert.deepEqual(root!.sources.map((source) => source.layer), ["committed", "local", "local"]);
  assert.deepEqual(root!.tests.smokeSet, ["tools/local.test.ts"]);
  assert.deepEqual(app!.tests, { patterns: ["**/*.test.ts"], includeImporters: false, smokeSet: ["smoke.test.ts"] });
  assert.deepEqual(app!.sources.map((source) => `${source.layer}:${source.scope}`), [
    "committed:null",
    "local:null",
    "stored:apps/a",
  ]);
  assert.deepEqual(read.scopes.root.localKeys, ["tests.includeImporters", "tests.smokeSet"]);
});

test("an invalid committed file still fails and an invalid local file is still unavailable, with scopes stored", () => {
  const tree = mkdtempSync(join(tmpdir(), "testing-scopes-tree-"));
  const checkout = mkdtempSync(join(tmpdir(), "testing-scopes-checkout-"));
  const stored = [layer("apps/a", { tests: { patterns: ["*.ts"] } })];
  mkdirSync(join(checkout, ".mission"));
  writeFileSync(join(checkout, ".mission/testing.local.json"), "{ nope");
  const badLocal = resolveTestingScopes(tree, checkout, stored);
  assert.equal(!badLocal.ok && badLocal.kind, "invalid-local");
  mkdirSync(join(tree, ".mission"));
  writeFileSync(join(tree, ".mission/testing.json"), JSON.stringify({ tests: { smokeSets: [] } }));
  const bad = resolveTestingScopes(tree, null, stored);
  assert.equal(!bad.ok && bad.kind, "invalid");
});

// ---- A fixture monorepo: two subdirectory scopes and no root tsconfig ----------------------

test("each scope's own patterns and smoke set select its tests, and keys it does not set fall through", async () => {
  const root = monorepoTree();
  const scopes = monorepoScopes();

  assert.deepEqual(Object.fromEntries(testUniverse(scopes, MONOREPO_TRACKED)), {
    "": ["packages/ui/src/button.test.ts", "tools/root-smoke.test.ts", "tools/root.test.ts"],
    "apps/api": ["apps/api/lib/b.spec.ts", "apps/api/lib/c.spec.ts"],
    "apps/web": ["apps/web/src/a.test.ts", "apps/web/src/alias.test.ts", "apps/web/src/untouched.test.ts"],
  });

  const selection = await selectAffectedTests(root, scopes, {
    changedPaths: async () => ({ ok: true, repoRoot: root, paths: MONOREPO_CHANGED }),
    deletedPaths: async () => ({ ok: true, repoRoot: root, paths: [] }),
    trackedFiles: async () => MONOREPO_TRACKED,
  });
  assert.ok(selection.ok, selection.ok ? "" : selection.reason);
  assert.deepEqual(selection.files, MONOREPO_SELECTED);
  // Not selected, each for its own scope's reason:
  //  - apps/api/lib/old.test.ts changed and matches the ROOT's patterns, but the api app's own
  //    patterns replace them there;
  //  - apps/api/lib/b.spec.ts imports a changed file, but the api app turned importers off;
  //  - apps/web/smoke.spec.ts matches the root's smoke glob, but the web app's own smoke set
  //    replaces it there.
  // apps/web/src/alias.test.ts IS selected: it reaches the change through the app's own alias,
  // which its nearest tsconfig.json resolves, so selection has nothing left to report.
  assert.deepEqual(selection.diagnostics, []);
});

test("a repository with no subdirectory scope still resolves each app's own aliases, and records no diagnostics", async () => {
  const root = monorepoTree();
  const scopes = buildTestingScopes(rootOnly({ tests: { patterns: ["**/*.test.ts"] } }));
  const selection = await selectAffectedTests(root, scopes, {
    changedPaths: async () => ({ ok: true, repoRoot: root, paths: MONOREPO_CHANGED }),
    deletedPaths: async () => ({ ok: true, repoRoot: root, paths: [] }),
    trackedFiles: async () => MONOREPO_TRACKED,
  });
  assert.ok(selection.ok);
  assert.deepEqual(selection.diagnostics, []);
  // Import resolution follows the importer's nearest config, not its testing scope: the web app's
  // `@web/*` alias selects alias.test.ts here exactly as it does with scopes.
  assert.deepEqual(selection.files.map((file) => file.path), [
    "apps/api/lib/old.test.ts",
    "apps/web/src/a.test.ts",
    "apps/web/src/alias.test.ts",
    "packages/ui/src/button.test.ts",
  ]);
});
