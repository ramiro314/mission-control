import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  createPosixProcessLifetime,
  processLifetimeFor,
  type ProcessLifetimeDeps,
} from "../src/server/platform/process-lifetime.ts";

const SEAM = "src/server/platform/process-lifetime.ts";

function recorder(killError?: () => Error) {
  const kills: Array<[number, NodeJS.Signals | 0]> = [];
  const deps: ProcessLifetimeDeps = {
    kill: (pid, signal) => {
      kills.push([pid, signal]);
      if (killError) throw killError();
    },
  };
  return { deps, kills };
}

function fakeChild(pid: number | undefined, throws = false) {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const child = {
    pid,
    kill: (signal?: NodeJS.Signals | number) => {
      signals.push(signal);
      if (throws) throw new Error("gone");
      return true;
    },
  };
  return { child, signals };
}

const esrch = (): Error => Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });

test("POSIX tree-root spawn options are exactly detached: true, and cannot be edited", () => {
  const { treeRootOptions } = createPosixProcessLifetime(recorder().deps);

  assert.deepEqual(treeRootOptions, { detached: true });
  assert.ok(Object.isFrozen(treeRootOptions));
  assert.deepEqual(
    { ...treeRootOptions, cwd: "/repo", stdio: ["ignore", "pipe", "pipe"] },
    { detached: true, cwd: "/repo", stdio: ["ignore", "pipe", "pipe"] },
    "spread into a call site, it adds detached and leaves every other option alone",
  );
});

test("POSIX signalTree signals the negative pid with the signal it was given", () => {
  const { deps, kills } = recorder();
  const lifetime = createPosixProcessLifetime(deps);

  lifetime.signalTree(4242, "SIGTERM");
  lifetime.signalTree(4242, "SIGKILL");
  lifetime.signalTree(4242, 0);

  assert.deepEqual(kills, [[-4242, "SIGTERM"], [-4242, "SIGKILL"], [-4242, 0]]);
});

test("POSIX signalTree throws what process.kill throws, so a probe can read ESRCH", () => {
  const { deps } = recorder(esrch);
  const lifetime = createPosixProcessLifetime(deps);

  assert.throws(() => lifetime.signalTree(4242, 0), { code: "ESRCH" });
});

test("POSIX killTree SIGKILLs the group and leaves the child handle alone", () => {
  const { deps, kills } = recorder();
  const { child, signals } = fakeChild(4242);

  createPosixProcessLifetime(deps).killTree(child);

  assert.deepEqual(kills, [[-4242, "SIGKILL"]]);
  assert.deepEqual(signals, []);
});

test("POSIX killTree falls back to SIGKILL on the child when the group signal fails", () => {
  const { deps, kills } = recorder(esrch);
  const { child, signals } = fakeChild(4242);

  createPosixProcessLifetime(deps).killTree(child);

  assert.deepEqual(kills, [[-4242, "SIGKILL"]]);
  assert.deepEqual(signals, ["SIGKILL"]);
});

test("POSIX killTree with no pid signals the child directly and sends no group signal", () => {
  const { deps, kills } = recorder();
  const { child, signals } = fakeChild(undefined);

  createPosixProcessLifetime(deps).killTree(child);

  assert.deepEqual(kills, []);
  assert.deepEqual(signals, ["SIGKILL"]);
});

test("POSIX killTree never throws, even when the group and the child both refuse", () => {
  const { deps } = recorder(esrch);
  const { child } = fakeChild(4242, true);

  assert.doesNotThrow(() => createPosixProcessLifetime(deps).killTree(child));
});

test("nothing is registered for win32 on main: every platform resolves to POSIX", () => {
  assert.equal(processLifetimeFor("win32"), processLifetimeFor("darwin"));
  assert.equal(processLifetimeFor("linux"), processLifetimeFor("darwin"));
});

test("the seam imports only Node builtins, so the Electron and daemon bundles can both take it", () => {
  const source = readFileSync(SEAM, "utf8");
  const specifiers = [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.match(specifier, /^node:/);
});

/**
 * Where a source file starts or signals a process tree by hand, found in its syntax tree, so a
 * comment never counts and no spelling of the option slips past a line pattern.
 *
 *  - `process.kill(-pid, …)`: a negated first argument, however it is wrapped or spaced.
 *  - A `detached` key in any object literal, in any form (`detached: true`, `detached: !win`,
 *    shorthand `detached`), so options built in a variable and handed to an injected spawn
 *    count too.
 *
 * `spawnOnly` narrows the second rule for a file whose `detached` keys mean something else,
 * such as a git checkout's detached-HEAD state. There a key counts only in an object handed
 * straight to a `spawn*`, `fork*` or `exec*` call, or anywhere in a file that imports
 * `node:child_process`, which is where spawn options get built up first.
 */
export function processTreeSites(file: string, source: string, spawnOnly = false): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const importsChildProcess = tree.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === "node:child_process",
  );
  const sites: string[] = [];
  const line = (node: ts.Node): number => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
  const calleeName = (call: ts.CallExpression): string => {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    return "";
  };
  const passedToSpawn = (object: ts.ObjectLiteralExpression): boolean => {
    let node: ts.Node = object;
    while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
    return ts.isCallExpression(node.parent)
      && node.parent.arguments.includes(node as ts.Expression)
      && /^(spawn|fork|exec)/i.test(calleeName(node.parent));
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "process"
      && node.expression.name.text === "kill"
    ) {
      let target = node.arguments[0];
      while (target && ts.isParenthesizedExpression(target)) target = target.expression;
      if (target && ts.isPrefixUnaryExpression(target) && target.operator === ts.SyntaxKind.MinusToken) {
        sites.push(`${file}:${line(node)} process.kill(-pid)`);
      }
    }
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
      && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
      && node.name.text === "detached"
      && ts.isObjectLiteralExpression(node.parent)
      && (!spawnOnly || importsChildProcess || passedToSpawn(node.parent))
    ) {
      sites.push(`${file}:${line(node)} detached`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return sites;
}

test("the process-tree scanner sees every spelling, and nothing that is not a spawn", () => {
  const spawning = processTreeSites(
    "spawning.ts",
    [
      'import { spawn } from "node:child_process";',
      "// detached: true and process.kill(-pid) in a comment are not code",
      'spawn("a", [], { detached: true });',
      'spawn("b", [], { detached: !isWindows });',
      'spawn("c", [], { detached, stdio: "ignore" });',
      "const options = { detached: process.platform !== \"win32\" };",
      "process.kill(\n  -pid,\n  \"SIGKILL\",\n);",
      "process.kill((-child.pid), 0);",
      "process.kill(pid, 0);",
    ].join("\n"),
  );
  assert.deepEqual(spawning, [
    "spawning.ts:3 detached",
    "spawning.ts:4 detached",
    "spawning.ts:5 detached",
    "spawning.ts:6 detached",
    "spawning.ts:7 process.kill(-pid)",
    "spawning.ts:11 process.kill(-pid)",
  ]);
  assert.deepEqual(
    processTreeSites(
      "elsewhere.ts",
      [
        'deps.spawnDetached(bin, ["server"], { detached: true });',
        'cp["fork"]; return { ok: false, root: null, detached: false };',
        "interface Checkout { detached: boolean }",
      ].join("\n"),
      true,
    ),
    ["elsewhere.ts:1 detached"],
    "narrowed to spawns, only an object handed straight to a spawn counts outside a child_process file",
  );
  assert.deepEqual(
    processTreeSites(
      "injected.ts",
      [
        "const options = { detached: true, stdio: \"ignore\" };",
        'deps.start(bin, ["server"], options);',
        "interface Checkout { detached: boolean }",
      ].join("\n"),
    ),
    ["injected.ts:1 detached"],
    "by default, a detached key counts wherever it is built, and a type's field does not",
  );
});

test("no process-group spawn or signal is written outside the seam", () => {
  // Herdr's server is launched to outlive the daemon and is never signalled, so it is not a
  // supervised tree; its injected spawn's `detached` option is pinned by its own tests.
  const daemonised = "src/server/terminal/herdr-client.ts";
  // Here `detached` is a git checkout's detached-HEAD state (or a review's detached flag in a
  // JSON reply), so these files are held only to the spawn-reachable rule.
  const detachedHead = new Set([
    "src/server/actions.ts",
    "src/server/routes.ts",
    "src/server/worktrees/git.ts",
  ]);
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mts)$/.test(entry.name)) {
        const file = relative(".", path);
        if (file === SEAM) continue;
        for (const site of processTreeSites(file, readFileSync(path, "utf8"), detachedHead.has(file))) {
          if (file === daemonised && site.endsWith(" detached")) continue;
          offenders.push(site);
        }
      }
    }
  };
  walk("src/server");
  walk("src/main");
  assert.deepEqual(offenders, []);
});
