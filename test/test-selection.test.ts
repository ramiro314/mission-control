import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildTestingScopes,
  mergeTestingLayers,
  parseTestingConfig,
  type TestingScopes,
} from "../src/shared/testing-config.ts";
import { scanImportSpecifiers, selectAffectedTests } from "../src/server/test-selection.ts";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { stdio: "ignore" });
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A committed file's settings, as root-only scopes: what a repository without subdirectory rows selects with. */
function config(value: unknown): TestingScopes {
  const parsed = parseTestingConfig(JSON.stringify(value));
  assert.ok(parsed.ok);
  return buildTestingScopes(mergeTestingLayers(parsed.config, null, null));
}

/** A repository whose `main` is the base and whose checked-out branch is the change. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "test-selection-"));
  git(root, "init", "-q", "-b", "main");
  write(root, {
    "tsconfig.json": `{
      // comments and trailing commas are normal in a tsconfig
      "compilerOptions": { "baseUrl": ".", "paths": { "@shared/*": ["src/shared/*"], }, },
    }`,
    "src/shared/util.ts": "export const x = 1;\n",
    "src/mid.ts": "import { x } from \"@shared/util.ts\";\nimport \"./cycle.ts\";\nexport const y = x;\n",
    "src/cycle.ts": "import { y } from \"./mid.ts\";\nexport const z = () => y;\n",
    "src/other.ts": "export const o = 1;\n",
    "test/direct.test.ts": "import { x } from '../src/shared/util.ts';\n",
    "test/transitive.test.ts": "import {\n  y,\n} from \"../src/mid.js\";\n",
    "test/dynamic.test.ts": "const m = await import(\"../src/cycle.ts\");\n",
    "test/unrelated.test.ts": "import { o } from \"../src/other.ts\";\nimport z from \"zod\";\n",
    "test/smoke.test.ts": "import { o } from \"../src/other.ts\";\n",
  });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "change");
  return root;
}

const CONFIG = {
  tests: { patterns: ["test/**/*.test.ts"], smokeSet: ["test/smoke.test.ts"] },
};

test("changed tests, direct and transitive importers (relative, alias, dynamic) and the smoke set", async () => {
  const root = fixture();
  write(root, {
    "src/shared/util.ts": "export const x = 2;\n",
    "test/new.test.ts": "export {};\n",
  });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "change");

  const selection = await selectAffectedTests(root, config(CONFIG));
  assert.ok(selection.ok, selection.ok ? "" : selection.reason);
  assert.deepEqual(selection.files, [
    { path: "test/direct.test.ts", reason: "imports", via: "src/shared/util.ts" },
    { path: "test/dynamic.test.ts", reason: "imports", via: "src/shared/util.ts" },
    { path: "test/new.test.ts", reason: "changed" },
    { path: "test/smoke.test.ts", reason: "smoke" },
    { path: "test/transitive.test.ts", reason: "imports", via: "src/shared/util.ts" },
  ]);
  assert.equal(selection.changedCount, 2);
});

test("importers are skipped when the project turns them off", async () => {
  const root = fixture();
  write(root, { "src/shared/util.ts": "export const x = 3;\n" });
  git(root, "commit", "-q", "-am", "change");
  const selection = await selectAffectedTests(root, config({ tests: { ...CONFIG.tests, includeImporters: false } }));
  assert.ok(selection.ok);
  assert.deepEqual(selection.files.map((file) => file.path), ["test/smoke.test.ts"]);
});

test("no changes select only the smoke set, and nothing at all without one", async () => {
  const root = fixture();
  const withSmoke = await selectAffectedTests(root, config(CONFIG));
  assert.ok(withSmoke.ok);
  assert.deepEqual(withSmoke.files, [{ path: "test/smoke.test.ts", reason: "smoke" }]);
  const none = await selectAffectedTests(root, config({ tests: { patterns: CONFIG.tests.patterns } }));
  assert.ok(none.ok);
  assert.deepEqual(none.files, []);
});

test("a git failure is reported, never read as an empty selection", async () => {
  const selection = await selectAffectedTests("/", config(CONFIG), {
    changedPaths: async () => ({ ok: false, reason: "not a git repository" }),
  });
  assert.deepEqual(selection, { ok: false, reason: "the changed files could not be read: not a git repository" });
  const deleted = await selectAffectedTests("/", config(CONFIG), {
    changedPaths: async () => ({ ok: true, repoRoot: "/", paths: [] }),
    deletedPaths: async () => ({ ok: false, reason: "could not read the deleted paths" }),
  });
  assert.deepEqual(deleted, { ok: false, reason: "the deleted files could not be read: could not read the deleted paths" });
});

test("the scanner finds static, re-export, dynamic and require specifiers", () => {
  assert.deepEqual(scanImportSpecifiers([
    "import a from \"./a.ts\";",
    "import type { B } from './b.ts';",
    "export * from \"./c.ts\";",
    "import \"./d.css\";",
    "const e = await import('./e.ts');",
    "const f = require(\"./f.cjs\");",
    "const g = import(name);",
  ].join("\n")).sort(), ["./a.ts", "./b.ts", "./c.ts", "./d.css", "./e.ts", "./f.cjs"]);
});

test("a deleted file still selects the tests that import it, directly and transitively", async () => {
  const root = fixture();
  // The change deletes the shared util: direct.test imports it, transitive.test reaches it
  // through src/mid.ts. Neither test changed, and neither is in the smoke set.
  git(root, "rm", "-q", "src/shared/util.ts");
  git(root, "commit", "-q", "-m", "delete util");
  const selection = await selectAffectedTests(root, config({ tests: { patterns: CONFIG.tests.patterns } }));
  assert.ok(selection.ok, selection.ok ? "" : selection.reason);
  assert.deepEqual(selection.files, [
    { path: "test/direct.test.ts", reason: "imports", via: "src/shared/util.ts" },
    { path: "test/dynamic.test.ts", reason: "imports", via: "src/shared/util.ts" },
    { path: "test/transitive.test.ts", reason: "imports", via: "src/shared/util.ts" },
  ]);
  assert.equal(selection.changedCount, 1);
});

// ---- Per-app resolution: the nearest tsconfig or jsconfig, and workspace package names -----

const JSON_FILE = (value: unknown) => JSON.stringify(value, null, 2);

/** Files on disk without git: `tracked` is every key, and selection's git reads are stubbed. */
function onDisk(files: Record<string, string>): { root: string; tracked: string[] } {
  const root = mkdtempSync(join(tmpdir(), "test-selection-apps-"));
  write(root, files);
  return { root, tracked: Object.keys(files) };
}

async function selectOnDisk(root: string, tracked: string[], changed: string[]) {
  const selection = await selectAffectedTests(root, config({ tests: { patterns: ["**/*.test.{ts,tsx,js}"] } }), {
    changedPaths: async () => ({ ok: true, repoRoot: root, paths: changed }),
    deletedPaths: async () => ({ ok: true, repoRoot: root, paths: [] }),
    trackedFiles: async () => tracked,
  });
  assert.ok(selection.ok, selection.ok ? "" : selection.reason);
  return selection;
}

test("each file resolves through its nearest tsconfig or jsconfig, with relative and package extends", async () => {
  const { root, tracked } = onDisk({
    "package.json": JSON_FILE({ private: true, workspaces: ["packages/*"] }),
    // The root config governs only files with no nearer config.
    "tsconfig.json": JSON_FILE({
      compilerOptions: { baseUrl: ".", paths: { "@web/*": ["apps/web/src/*"], "@gen/*": ["generated/*/*.ts"] } },
    }),
    // A base with paths and no baseUrl: its targets are relative to the base itself.
    "tsconfig.base.json": "{\n  // shared by the apps\n  \"compilerOptions\": { \"paths\": { \"@lib/*\": [\"libs/*/index.ts\"], }, },\n}\n",
    "libs/date/index.ts": "export const d = 1;\n",
    "generated/user/user.ts": "export const u = 1;\n",
    // Relative `extends`, written without `.json`.
    "apps/web/tsconfig.json": JSON_FILE({ extends: "../../tsconfig.base", compilerOptions: { strict: true } }),
    "apps/web/src/util.ts": "export const w = 1;\n",
    "apps/web/src/lib.test.ts": "import { d } from \"@lib/date\";\n",
    // The root's @web/* does not reach here: apps/web's own config is the nearest.
    "apps/web/src/root-alias.test.ts": "import { w } from \"@web/util\";\n",
    "tools/root.test.ts": "import { w } from \"@web/util\";\n",
    // Both `*` in the target are replaced, not only the first.
    "tools/gen.test.ts": "import { u } from \"@gen/user\";\n",
    // A jsconfig's baseUrl resolves a bare specifier from it.
    "apps/api/jsconfig.json": JSON_FILE({ compilerOptions: { baseUrl: "src" } }),
    "apps/api/src/models/user.js": "module.exports = {};\n",
    "apps/api/test/user.test.js": "const user = require(\"models/user\");\n",
    // A package `extends` found as a workspace, whose `${configDir}` is the app that uses it.
    "packages/tsconfig/package.json": JSON_FILE({ name: "@acme/tsconfig" }),
    "packages/tsconfig/app.json": JSON_FILE({ compilerOptions: { paths: { "@app/*": ["${configDir}/src/*"] } } }),
    "apps/pkg/tsconfig.json": JSON_FILE({ extends: "@acme/tsconfig/app.json" }),
    "apps/pkg/src/y.ts": "export const y = 1;\n",
    "apps/pkg/src/y.test.ts": "import { y } from \"@app/y\";\n",
    "apps/nm/tsconfig.json": JSON_FILE({ extends: "@tsconfig/strict" }),
    "apps/nm/lib/thing.ts": "export const t = 1;\n",
    "apps/nm/thing.test.ts": "import { t } from \"thing\";\n",
  });
  // A package `extends` found in an installed, untracked node_modules inside the tree.
  write(root, { "node_modules/@tsconfig/strict/tsconfig.json": JSON_FILE({ compilerOptions: { baseUrl: "${configDir}/lib" } }) });

  const selection = await selectOnDisk(root, tracked, [
    "libs/date/index.ts",
    "generated/user/user.ts",
    "apps/web/src/util.ts",
    "apps/api/src/models/user.js",
    "apps/pkg/src/y.ts",
    "apps/nm/lib/thing.ts",
  ]);
  assert.deepEqual(selection.files, [
    { path: "apps/api/test/user.test.js", reason: "imports", via: "apps/api/src/models/user.js" },
    { path: "apps/nm/thing.test.ts", reason: "imports", via: "apps/nm/lib/thing.ts" },
    { path: "apps/pkg/src/y.test.ts", reason: "imports", via: "apps/pkg/src/y.ts" },
    { path: "apps/web/src/lib.test.ts", reason: "imports", via: "libs/date/index.ts" },
    { path: "tools/gen.test.ts", reason: "imports", via: "generated/user/user.ts" },
    { path: "tools/root.test.ts", reason: "imports", via: "apps/web/src/util.ts" },
  ]);
  assert.deepEqual(selection.diagnostics, []);
});

test("a config selection cannot follow is a diagnostic, never fatal, and nothing resolves outside the tree", async () => {
  const outside = mkdtempSync(join(tmpdir(), "test-selection-outside-"));
  write(outside, {
    "outside.json": JSON_FILE({ compilerOptions: { paths: { "@out/*": ["./*"] } } }),
    "elsewhere/x.ts": "export {};\n",
  });
  const { root, tracked } = onDisk({
    // Both bases are missing, but the config's own paths still apply.
    "apps/broken/tsconfig.json": JSON_FILE({ extends: ["@missing/tsconfig", "./absent"], compilerOptions: { paths: { "@b/*": ["src/*"] } } }),
    "apps/broken/src/b.ts": "export const b = 1;\n",
    "apps/broken/src/b.test.ts": "import { b } from \"@b/b\";\n",
    "apps/bad/tsconfig.json": "{ not json",
    "apps/bad/src/x.ts": "export {};\n",
    "apps/bad/x.test.ts": "import \"@x/x\";\n",
    // An escaping `extends` and an escaping target are both refused.
    "apps/escape/tsconfig.json": JSON_FILE({
      extends: "../../../outside.json",
      compilerOptions: { paths: { "@out/*": ["../../../elsewhere/*"] } },
    }),
    "apps/escape/e.test.ts": "import \"@out/x\";\n",
  });
  // A base spelled inside the tree that is a symlink out of it is refused too.
  write(root, { "apps/link/tsconfig.json": JSON_FILE({ extends: "./linked.json" }), "apps/link/l.test.ts": "import \"@out/x\";\n" });
  symlinkSync(join(outside, "outside.json"), join(root, "apps/link/linked.json"));
  tracked.push("apps/link/tsconfig.json", "apps/link/l.test.ts");

  const selection = await selectOnDisk(root, tracked, ["apps/broken/src/b.ts", "apps/bad/src/x.ts"]);
  assert.deepEqual(selection.files, [
    { path: "apps/broken/src/b.test.ts", reason: "imports", via: "apps/broken/src/b.ts" },
  ]);
  assert.deepEqual(selection.diagnostics, [
    "apps/bad/tsconfig.json could not be read or parsed, so its paths and baseUrl were not used.",
    "apps/broken/tsconfig.json extends \"./absent\", which was not found inside the repository, so its own settings were used without it.",
    "apps/broken/tsconfig.json extends \"@missing/tsconfig\", which was not found inside the repository, so its own settings were used without it.",
    "apps/escape/tsconfig.json extends \"../../../outside.json\", which was not found inside the repository, so its own settings were used without it.",
    "apps/link/tsconfig.json extends \"./linked.json\", which was not found inside the repository, so its own settings were used without it.",
  ]);
});

test("an extends cycle is reported and broken, and the rest of the chain still applies", async () => {
  const { root, tracked } = onDisk({
    "apps/cycle/tsconfig.json": JSON_FILE({ extends: "./a.json", compilerOptions: { paths: { "@c/*": ["src/*"] } } }),
    "apps/cycle/a.json": JSON_FILE({ extends: "./tsconfig.json", compilerOptions: { baseUrl: "." } }),
    "apps/cycle/src/c.ts": "export const c = 1;\n",
    "apps/cycle/c.test.ts": "import { c } from \"@c/c\";\n",
  });
  const selection = await selectOnDisk(root, tracked, ["apps/cycle/src/c.ts"]);
  assert.deepEqual(selection.files, [{ path: "apps/cycle/c.test.ts", reason: "imports", via: "apps/cycle/src/c.ts" }]);
  assert.deepEqual(selection.diagnostics, [
    "apps/cycle/a.json extends \"./tsconfig.json\", which extends it back, so that extends was ignored.",
  ]);
});

test("workspace package names resolve bare and with a subpath, inside the workspace only", async () => {
  const { root, tracked } = onDisk({
    // The `{ packages }` form, with a `./` prefix and a negated glob.
    "package.json": JSON_FILE({ private: true, workspaces: { packages: ["./packages/*", "!packages/ignored"] } }),
    "packages/ui/package.json": JSON_FILE({ name: "@acme/ui", exports: "./src/index.ts" }),
    "packages/ui/src/index.ts": "export * from \"./button.tsx\";\n",
    "packages/ui/src/button.tsx": "export const Button = 1;\n",
    "packages/core/package.json": JSON_FILE({ name: "core", main: "lib/main.js" }),
    "packages/core/lib/main.ts": "export const main = 1;\n",
    "packages/plain/package.json": JSON_FILE({ name: "plain" }),
    "packages/plain/index.ts": "export const plain = 1;\n",
    // An exports map with conditions is not read: `types` resolves instead, and it is reported.
    "packages/rich/package.json": JSON_FILE({
      name: "@acme/rich",
      types: "src/index.ts",
      exports: { ".": { import: "./dist/index.js" }, "./feature": "./src/feature.ts" },
    }),
    "packages/rich/src/index.ts": "export const rich = 1;\n",
    "packages/ignored/package.json": JSON_FILE({ name: "ignored" }),
    "packages/ignored/index.ts": "export const ignored = 1;\n",
    "app/ui.test.ts": "import { Button } from \"@acme/ui\";\n",
    "app/button.test.ts": "import { Button } from \"@acme/ui/src/button\";\n",
    "app/core.test.ts": "import { main } from \"core\";\n",
    "app/plain.test.ts": "import { plain } from \"plain\";\n",
    "app/rich.test.ts": "import { rich } from \"@acme/rich\";\n",
    "app/ignored.test.ts": "import { ignored } from \"ignored\";\n",
    // A subpath that climbs out of its workspace is refused, inside the tree or not.
    "app/escape.test.ts": "import \"core/../plain/index\";\nimport \"@acme/ui/../../../outside\";\n",
    "app/third-party.test.ts": "import { z } from \"zod\";\n",
  });
  const selection = await selectOnDisk(root, tracked, [
    "packages/ui/src/button.tsx",
    "packages/core/lib/main.ts",
    "packages/plain/index.ts",
    "packages/rich/src/index.ts",
    "packages/ignored/index.ts",
  ]);
  assert.deepEqual(selection.files, [
    { path: "app/button.test.ts", reason: "imports", via: "packages/ui/src/button.tsx" },
    { path: "app/core.test.ts", reason: "imports", via: "packages/core/lib/main.ts" },
    { path: "app/plain.test.ts", reason: "imports", via: "packages/plain/index.ts" },
    { path: "app/rich.test.ts", reason: "imports", via: "packages/rich/src/index.ts" },
    { path: "app/ui.test.ts", reason: "imports", via: "packages/ui/src/button.tsx" },
  ]);
  assert.deepEqual(selection.diagnostics, [
    "Workspace package \"@acme/rich\" (packages/rich) has an exports map beyond a single string, which selection "
    + "does not read, so imports of it were resolved through its types, main or index file, and its subpaths inside "
    + "packages/rich.",
  ]);
});
