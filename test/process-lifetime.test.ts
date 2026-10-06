import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep, win32 as win32Path } from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  createPosixProcessLifetime,
  createWin32ProcessLifetime,
  processLifetimeFor,
  type ProcessLifetimeDeps,
  type Win32ProcessLifetimeDeps,
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

test("win32 resolves to its own lifetime, and every other platform to POSIX", () => {
  const win32 = processLifetimeFor("win32");
  assert.notEqual(win32, processLifetimeFor("darwin"));
  assert.deepEqual(win32.treeRootOptions, { windowsHide: true });
  for (const platform of ["linux", "freebsd"] as const) {
    assert.equal(processLifetimeFor(platform), processLifetimeFor("darwin"), platform);
  }
  assert.deepEqual(processLifetimeFor("darwin").treeRootOptions, { detached: true });
});

function win32Recorder(taskkillError?: () => Error) {
  const kills: Array<[number, NodeJS.Signals | 0]> = [];
  const taskkills: string[][] = [];
  const deps: Win32ProcessLifetimeDeps = {
    kill: (pid, signal) => {
      kills.push([pid, signal]);
    },
    taskkill: (args) => {
      taskkills.push([...args]);
      if (taskkillError) throw taskkillError();
    },
  };
  return { deps, kills, taskkills };
}

/** What `execFileSync` throws when the command exits with `status`. */
const exited = (status: number) => (): Error => Object.assign(new Error(`Command failed: taskkill`), { status });

test("win32 tree-root spawn options hide the console and leave the child attached", () => {
  const { treeRootOptions } = createWin32ProcessLifetime(win32Recorder().deps);

  assert.deepEqual(treeRootOptions, { windowsHide: true });
  assert.ok(Object.isFrozen(treeRootOptions));
  assert.equal("detached" in treeRootOptions, false, "detached would leave Node's job and open console windows");
});

test("win32 signalTree ends the tree with taskkill /T /F for every signal but 0", () => {
  const { deps, kills, taskkills } = win32Recorder();
  const lifetime = createWin32ProcessLifetime(deps);

  lifetime.signalTree(4242, "SIGTERM");
  lifetime.signalTree(4242, "SIGKILL");

  assert.deepEqual(taskkills, [
    ["/PID", "4242", "/T", "/F"],
    ["/PID", "4242", "/T", "/F"],
  ]);
  assert.deepEqual(kills, []);
});

test("win32 signalTree 0 probes the root pid itself, never a negative pid", () => {
  const { deps, kills, taskkills } = win32Recorder();

  createWin32ProcessLifetime(deps).signalTree(4242, 0);

  assert.deepEqual(kills, [[4242, 0]]);
  assert.deepEqual(taskkills, []);
});

test("win32 signalTree throws ESRCH when taskkill finds no such pid, and EPERM otherwise", () => {
  assert.throws(
    () => createWin32ProcessLifetime(win32Recorder(exited(128)).deps).signalTree(4242, "SIGKILL"),
    { code: "ESRCH", syscall: "kill" },
  );
  assert.throws(
    () => createWin32ProcessLifetime(win32Recorder(exited(1)).deps).signalTree(4242, "SIGKILL"),
    { code: "EPERM", syscall: "kill" },
    "access denied leaves the tree possibly alive",
  );
  const timedOut = () => Object.assign(new Error("spawnSync taskkill.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
  assert.throws(
    () => createWin32ProcessLifetime(win32Recorder(timedOut).deps).signalTree(4242, "SIGKILL"),
    { code: "EPERM" },
  );
});

test("win32 killTree runs taskkill on the tree and leaves the child handle alone", () => {
  const { deps, taskkills } = win32Recorder();
  const { child, signals } = fakeChild(4242);

  createWin32ProcessLifetime(deps).killTree(child);

  assert.deepEqual(taskkills, [["/PID", "4242", "/T", "/F"]]);
  assert.deepEqual(signals, []);
});

test("win32 killTree falls back to the child when taskkill fails, and never throws", () => {
  const { deps } = win32Recorder(exited(1));
  const { child, signals } = fakeChild(4242);
  createWin32ProcessLifetime(deps).killTree(child);
  assert.deepEqual(signals, ["SIGKILL"]);

  const { child: gone } = fakeChild(4242, true);
  assert.doesNotThrow(() => createWin32ProcessLifetime(deps).killTree(gone));

  const { deps: idle, taskkills } = win32Recorder();
  const { child: unspawned, signals: direct } = fakeChild(undefined);
  createWin32ProcessLifetime(idle).killTree(unspawned);
  assert.deepEqual(taskkills, [], "a child that never got a pid has no tree");
  assert.deepEqual(direct, ["SIGKILL"]);
});

const taskkillPath = win32Path.join(process.env.SystemRoot?.trim() || "C:\\Windows", "System32", "taskkill.exe");
const noTaskkill = existsSync(taskkillPath) ? false : "taskkill.exe is not installed";

test("win32 killTree ends a real grandchild through taskkill", { skip: noTaskkill }, async () => {
  const lifetime = createWin32ProcessLifetime();
  const child = spawn(
    process.execPath,
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        // Detached, so it leaves the job Node ends a child's children with: only /T reaches it.
        "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });",
        "process.stdout.write(String(grandchild.pid) + '\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ],
    { ...lifetime.treeRootOptions, stdio: ["ignore", "pipe", "ignore"] },
  );
  const grandchild = await new Promise<number>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", (chunk: string) => resolve(Number(chunk.trim())));
    child.once("error", reject);
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));

  lifetime.killTree(child);
  await exited;

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    const deadline = Date.now() + 10_000;
    while (alive(grandchild) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(alive(grandchild), false, "the grandchild died with its tree");
    assert.throws(() => lifetime.signalTree(child.pid!, "SIGKILL"), { code: "ESRCH" }, "taskkill exits 128 for a gone pid");
  } finally {
    if (alive(grandchild)) process.kill(grandchild);
  }
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
    "src/server/reset.ts",
    "src/server/routes.ts",
    "src/server/worktrees/git.ts",
  ]);
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mts)$/.test(entry.name)) {
        // POSIX separators, so the seam and the lists above match on a win32 host too.
        const file = relative(".", path).split(sep).join("/");
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
