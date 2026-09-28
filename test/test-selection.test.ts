import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseTestingConfig, type TestingConfig } from "../src/shared/testing-config.ts";
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

function config(value: unknown): TestingConfig {
  const parsed = parseTestingConfig(JSON.stringify(value));
  assert.ok(parsed.ok);
  return parsed.config;
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
