/**
 * `test/helpers/win32-skip.ts` is the only way a unit test or e2e spec may skip on win32 (D37
 * in `docs/plans/windows-support/plan.md`). The Windows merge gate reviews every call to it,
 * so a skip written any other way would pass that review unseen. This holds the helper's
 * contract and scans `test/` and `e2e/` for any other win32 skip.
 *
 * The scan reads each file's syntax tree and looks at every condition that decides a skip:
 * a `skip` or `todo` option, the arguments of a `skip`, `fixme` or `todo` call, or the
 * condition of an `if`, `?:`, `&&` or `||` whose branch skips or bare-returns. Two kinds of
 * condition are refused there:
 *
 * - A win32 condition: an equality comparison with the string `"win32"`, or a name bound to
 *   one (`const isWindows = process.platform === "win32"`). Always refused.
 * - A platform exclusion: `!==` or `!=` against another platform (`process.platform !==
 *   "darwin"`), or a name bound to one. It skips on win32 too, so it is refused unless the
 *   same condition calls `skipOnWin32` or a `skipSpecOnWin32` statement precedes it.
 *
 * A branch that returns a value is a platform-dependent expectation, not a skip, and stays
 * allowed. A skip on a missing tool (`tmux -V` failing) cannot be told apart from any other
 * probe by its syntax; when that tool does not exist on win32 the skip calls the helper too,
 * by the convention `e2e/README.md` states.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { skipOnWin32, skipSpecOnWin32, WIN32_SKIP_PREFIX } from "./helpers/win32-skip.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HELPER = join("test", "helpers", "win32-skip.ts");
const SCANNED_ROOTS = ["test", "e2e"];
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const SKIPPED_DIRS = new Set(["node_modules", "test-results", "playwright-report"]);
const SKIP_NAMES = new Set(["skip", "fixme", "todo"]);
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const LOGICAL = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken]);
const NEGATION = new Set([ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
/** Every `process.platform` value but win32. */
const OTHER_PLATFORMS = new Set([
  "aix", "android", "cygwin", "darwin", "freebsd", "haiku", "linux", "netbsd", "openbsd", "sunos",
]);
const HELPERS = new Set(["skipOnWin32", "skipSpecOnWin32"]);

function contains(node: ts.Node, match: (node: ts.Node) => boolean): boolean {
  return match(node) || Boolean(ts.forEachChild(node, (child) => contains(child, match) || undefined));
}

function literal(side: ts.Expression): string | null {
  return ts.isStringLiteral(side) || ts.isNoSubstitutionTemplateLiteral(side) ? side.text : null;
}

function isWin32Comparison(node: ts.Node): boolean {
  return ts.isBinaryExpression(node)
    && EQUALITY.has(node.operatorToken.kind)
    && (literal(node.left) === "win32" || literal(node.right) === "win32");
}

/** `process.platform !== "darwin"`: true on win32 as well as on every other platform. */
function isPlatformExclusion(node: ts.Node): boolean {
  return ts.isBinaryExpression(node)
    && NEGATION.has(node.operatorToken.kind)
    && (OTHER_PLATFORMS.has(literal(node.left) ?? "") || OTHER_PLATFORMS.has(literal(node.right) ?? ""));
}

function isHelperCall(node: ts.Node): boolean {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && HELPERS.has(node.expression.text);
}

/** Is a `skipSpecOnWin32(...)` or `skipOnWin32(...)` statement earlier in the same block? */
function precededByHelper(node: ts.Node): boolean {
  let statement = node;
  while (statement.parent && !ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent)) {
    statement = statement.parent;
  }
  const block = statement.parent;
  if (!block || !(ts.isBlock(block) || ts.isSourceFile(block))) return false;
  const siblings = block.statements;
  return siblings
    .slice(0, siblings.indexOf(statement as ts.Statement))
    .some((sibling) => ts.isExpressionStatement(sibling) && isHelperCall(sibling.expression));
}

function skipName(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
}

function isSkipCall(node: ts.Node): boolean {
  return ts.isCallExpression(node) && SKIP_NAMES.has(skipName(node.expression) ?? "");
}

/** Does this branch skip, or leave the test body early, without entering a nested function? */
function skips(node: ts.Node | undefined): boolean {
  if (!node || ts.isFunctionLike(node)) return false;
  if (isSkipCall(node)) return true;
  if (ts.isReturnStatement(node) && !node.expression) return true;
  if (ts.isPropertyAccessExpression(node) && SKIP_NAMES.has(node.name.text)) return true;
  return Boolean(ts.forEachChild(node, (child) => skips(child) || undefined));
}

/** Every win32 skip in one file, as `path:line`, that does not go through the helper. */
function win32Skips(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const win32Aliases = new Set<string>();
  const exclusionAliases = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (contains(node.initializer, isWin32Comparison)) win32Aliases.add(node.name.text);
      else if (contains(node.initializer, isPlatformExclusion) && !contains(node.initializer, isHelperCall)) {
        exclusionAliases.add(node.name.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(tree);
  const named = (names: Set<string>) => (n: ts.Node) => ts.isIdentifier(n) && names.has(n.text);
  const mentionsWin32 = (node: ts.Node) =>
    contains(node, (n) => isWin32Comparison(n) || named(win32Aliases)(n));
  const excludesPlatform = (node: ts.Node) =>
    contains(node, (n) => isPlatformExclusion(n) || named(exclusionAliases)(n));
  /** Does this condition, deciding the skip `construct`, skip on win32 without the helper? */
  const refused = (condition: ts.Node, construct: ts.Node) =>
    mentionsWin32(condition)
    || (excludesPlatform(condition) && !contains(condition, isHelperCall) && !precededByHelper(construct));

  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const skipsOnWin32 =
      (ts.isPropertyAssignment(node)
        && SKIP_NAMES.has(skipName(node.name) ?? "")
        && refused(node.initializer, node))
      || (ts.isShorthandPropertyAssignment(node)
        && SKIP_NAMES.has(node.name.text)
        && (win32Aliases.has(node.name.text) || exclusionAliases.has(node.name.text)))
      || (ts.isCallExpression(node) && isSkipCall(node) && node.arguments.some((arg) => refused(arg, node)))
      || (ts.isIfStatement(node)
        && refused(node.expression, node)
        && (skips(node.thenStatement) || skips(node.elseStatement)))
      || (ts.isConditionalExpression(node)
        && refused(node.condition, node)
        && (skips(node.whenTrue) || skips(node.whenFalse)))
      || (ts.isBinaryExpression(node)
        && LOGICAL.has(node.operatorToken.kind)
        && refused(node.left, node)
        && skips(node.right));
    if (skipsOnWin32) {
      const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
      found.push(`${file}:${line + 1}`);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

function scannedFiles(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : scannedFiles(path);
    return SCANNED_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

test("skipOnWin32 returns the stated reason on win32 and false everywhere else", () => {
  assert.equal(skipOnWin32("tmux does not run on win32", "win32"), "win32: tmux does not run on win32");
  assert.equal(skipOnWin32("  padded reason  ", "win32"), `${WIN32_SKIP_PREFIX}padded reason`);
  for (const platform of ["darwin", "linux", "freebsd"] as const) {
    assert.equal(skipOnWin32("tmux does not run on win32", platform), false);
  }
});

test("skipOnWin32 refuses a missing reason on every platform, not only on Windows", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    for (const reason of ["", "   "]) {
      assert.throws(() => skipOnWin32(reason, platform), /needs a stated reason/);
    }
  }
});

test("skipSpecOnWin32 skips a Playwright spec with the reason on win32 only", () => {
  const calls: [boolean, string | undefined][] = [];
  const spec = { skip: (condition: boolean, description?: string) => void calls.push([condition, description]) };
  skipSpecOnWin32(spec, "the terminal runtime is unavailable on win32", "win32");
  skipSpecOnWin32(spec, "the terminal runtime is unavailable on win32", "darwin");
  assert.deepEqual(calls, [
    [true, "win32: the terminal runtime is unavailable on win32"],
    [false, undefined],
  ]);
  assert.throws(() => skipSpecOnWin32(spec, "", "darwin"), /needs a stated reason/);
});

test("the scan refuses every way of skipping on win32 without the helper", () => {
  const refused = [
    `test("x", { skip: process.platform === "win32" }, () => {});`,
    `test("x", { skip: process.platform === "win32" ? "no tmux" : false }, () => {});`,
    `test("x", { todo: os.platform() !== 'win32' }, () => {});`,
    "test(\"x\", { skip: process.platform === `win32` }, () => {});",
    `test.skip(process.platform === "win32", "no tmux");`,
    `test.fixme("win32" === process.platform, "no tmux");`,
    `test("x", (t) => { if (process.platform === "win32") { t.skip("no tmux"); return; } });`,
    `test("x", () => { if (process.platform === "win32") return; });`,
    `test("x", (t) => { process.platform === "win32" && t.skip("no tmux"); });`,
    `(process.platform === "win32" ? test.skip : test)("x", () => {});`,
    `const isWindows = process.platform === "win32";\ntest("x", { skip: isWindows }, () => {});`,
    `const skip = process.platform === "win32";\ntest("x", { skip }, () => {});`,
    `const onWindows = () => process.platform === "win32";\ntest.skip(onWindows(), "no tmux");`,
    `test("x", { skip: process.platform !== "darwin" }, () => {});`,
    `test("x", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, () => {});`,
    `test.skip(process.platform !== "darwin", "the desktop shell requires the macOS GUI");`,
    `test("x", (t) => { if (process.platform != "linux") t.skip("Linux only"); });`,
    `const macOnly = process.platform !== "darwin";\ntest("x", { skip: macOnly }, () => {});`,
    `skipSpecOnWin32(test, "r");\ntest("x", () => { test.skip(process.platform !== "darwin", "macOS"); });`,
  ];
  for (const source of refused) {
    assert.equal(win32Skips("fixture.ts", source).length, 1, `refused:\n${source}`);
  }
});

test("the scan allows the helper and platform-dependent values", () => {
  const allowed = [
    `test("x", { skip: skipOnWin32("tmux does not run on win32") }, () => {});`,
    `skipSpecOnWin32(test, "the terminal runtime is unavailable on win32");`,
    `const tooLarge = process.platform === "win32" ? /E2BIG|EINVAL/ : /E2BIG/;`,
    `function shell() { if (process.platform === "win32") return "cmd.exe"; return "/bin/sh"; }`,
    `test("x", { skip: process.platform === "linux" }, () => {});`,
    `test("x", { skip: skipOnWin32("macOS only") || process.platform !== "darwin" }, () => {});`,
    `const macOnly = skipOnWin32("macOS only") || process.platform !== "darwin";\ntest("x", { skip: macOnly }, () => {});`,
    `skipSpecOnWin32(test, "the desktop shell is macOS-only");\ntest.skip(process.platform !== "darwin", "macOS GUI");`,
    `test("x", () => {\n  skipSpecOnWin32(test, "macOS only");\n  test.skip(process.platform !== "darwin", "macOS");\n});`,
    `const tmp = process.platform !== "darwin" ? "/tmp" : "/private/tmp";`,
    `assert.equal(processLifetimeFor("win32"), processLifetimeFor("darwin"));`,
  ];
  for (const source of allowed) {
    assert.deepEqual(win32Skips("fixture.ts", source), [], `allowed:\n${source}`);
  }
});

test("no file under test/ or e2e/ skips on win32 except through the helper", () => {
  const files = SCANNED_ROOTS.flatMap(scannedFiles).filter((file) => file !== HELPER);
  assert.ok(files.length > 100, `the scan found only ${files.length} files; its walk has rotted`);
  assert.ok(files.includes(relative(REPO_ROOT, fileURLToPath(import.meta.url))));
  const found = files.flatMap((file) => win32Skips(file, readFileSync(join(REPO_ROOT, file), "utf8")));
  assert.deepEqual(found, [], "skip on win32 only through test/helpers/win32-skip.ts");
});
