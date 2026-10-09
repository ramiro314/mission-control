import assert from "node:assert/strict";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  type NativeAddonPublishFs,
  publishNativeAddon,
  RETIRED_ADDON_PREFIX,
  WIN32_PUBLISH_ATTEMPTS,
} from "../scripts/native-addon-publish.mjs";

/**
 * Publishing a native addon, and the one property that keeps a daemon startable.
 *
 * `copyFile` onto the published path keeps the destination's inode. On macOS, rewriting an
 * addon that some live process has mapped invalidates the kernel's code-signature bookkeeping
 * for that vnode, and every later process that loads it is `SIGKILL`ed with an empty stderr -
 * no exception, no log line, exit code 137. `codesign` still calls the file valid and the
 * byte-identical file at a fresh inode still loads, so nothing about the file looks wrong.
 *
 * That is not a hypothetical: `npm run build:native` runs on every `make start`, a restarting
 * developer has the previous daemon or Electron shell holding the addon open, and one such
 * restart left this repository's `dist/native/keep-awake.node` permanently unloadable. Every
 * daemon spawned from that worktree then died during startup, including the ones
 * `test/daemon-state-ownership.test.ts` spawns.
 *
 * These tests pin the mechanical property that prevents it - the destination is REPLACED, never
 * written through - without needing a real signed addon or a macOS host.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A disposable `dist/native`, with an addon already published into it. */
function published(bytes = "first build"): { dir: string; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "mission-native-publish-"));
  const output = join(dir, "addon.node");
  writeFileSync(output, bytes);
  return { dir, output };
}

test("publishing replaces the destination rather than writing through it", async () => {
  const { dir, output } = published();
  const before = statSync(output).ino;

  const built = join(dir, "built.node");
  writeFileSync(built, "second build");
  await publishNativeAddon(built, output);

  assert.equal(readFileSync(output, "utf8"), "second build");
  assert.notEqual(
    statSync(output).ino,
    before,
    "the published name must resolve to a new inode, or macOS kills every process that loads it",
  );
});

test("a process holding the previous addon keeps reading the bytes it opened", async () => {
  // The running daemon, modelled: it mapped the old addon and must go on seeing exactly what
  // it validated. A rename leaves that inode alone; a copy would rewrite it underneath.
  const { dir, output } = published("mapped by the running daemon");
  const held = openSync(output, "r");
  try {
    const built = join(dir, "built.node");
    writeFileSync(built, "rebuilt while the daemon was up");
    await publishNativeAddon(built, output);

    const buffer = Buffer.alloc(64);
    const read = readSync(held, buffer, 0, buffer.length, 0);
    assert.equal(buffer.subarray(0, read).toString("utf8"), "mapped by the running daemon");
    assert.equal(readFileSync(output, "utf8"), "rebuilt while the daemon was up");
  } finally {
    closeSync(held);
  }
});

test("a failed publish leaves the previous addon in place and no staging behind", async () => {
  const { dir, output } = published("the addon that still works");

  await assert.rejects(publishNativeAddon(join(dir, "never-built.node"), output));

  assert.equal(readFileSync(output, "utf8"), "the addon that still works");
  assert.deepEqual(
    readdirSync(dir),
    ["addon.node"],
    "a staging directory left in dist/native would ship as a half-built addon",
  );
});

/**
 * The filesystem as Windows presents it to a publisher: a loaded addon cannot be replaced or
 * deleted, because both remove a mapped image, but it can be renamed, and its mapping follows it.
 */
function windowsWithLoaded(loaded: Set<string>): NativeAddonPublishFs {
  const inUse = (path: string) => Object.assign(new Error(`EPERM: ${path}`), { code: "EPERM" });
  return {
    rename: async (from, to) => {
      if (loaded.has(String(to)) && existsSync(String(to))) throw inUse(String(to));
      await rename(from, to);
      if (loaded.delete(String(from))) loaded.add(String(to));
    },
    readdir: (path) => readdir(path),
    rm: async (path, options) => {
      if (loaded.has(String(path))) throw inUse(String(path));
      await rm(path, options);
    },
  };
}

test("on win32 a loaded addon is moved aside, kept while loaded, and swept afterwards", async () => {
  const { dir, output } = published("loaded by the running daemon");
  const loaded = new Set([output]);
  const built = join(dir, "built.node");
  writeFileSync(built, "rebuilt while the daemon was up");

  await publishNativeAddon(built, output, "win32", windowsWithLoaded(loaded));

  assert.equal(readFileSync(output, "utf8"), "rebuilt while the daemon was up");
  const [retired, ...others] = readdirSync(dir).filter((name) => name.startsWith(RETIRED_ADDON_PREFIX));
  assert.ok(retired && others.length === 0, "the loaded addon is retired once, beside the published one");
  assert.equal(readFileSync(join(dir, retired), "utf8"), "loaded by the running daemon");

  // The daemon exits, and the next publish clears what it left behind.
  loaded.clear();
  writeFileSync(built, "the next build");
  await publishNativeAddon(built, output, "win32", windowsWithLoaded(loaded));
  assert.equal(readFileSync(output, "utf8"), "the next build");
  assert.deepEqual(readdirSync(dir).sort(), ["addon.node", "built.node"]);
});

/** A win32 filesystem that refuses every rename of the built addon onto `output` with `code`. */
function refusingPublish(output: string, code: string): { fs: NativeAddonPublishFs; refused: () => number } {
  let refused = 0;
  return {
    refused: () => refused,
    fs: {
      rename: async (from, to) => {
        if (String(to) === output && String(from).includes(".publish-")) {
          refused++;
          throw Object.assign(new Error(`${code}: ${output}`), { code });
        }
        await rename(from, to);
      },
      readdir: (path) => readdir(path),
      rm: (path, options) => rm(path, options),
    },
  };
}

test("on win32 an error other than in-use is thrown at once, and nothing is moved aside", async () => {
  const { dir, output } = published("the addon that still works");
  const built = join(dir, "built.node");
  writeFileSync(built, "never published");
  const { fs, refused } = refusingPublish(output, "ENOSPC");

  await assert.rejects(publishNativeAddon(built, output, "win32", fs), { code: "ENOSPC" });
  assert.equal(refused(), 1);
  assert.equal(readFileSync(output, "utf8"), "the addon that still works");
  assert.deepEqual(readdirSync(dir).sort(), ["addon.node", "built.node"]);
});

test("on win32 a publish that stays refused gives up and puts the previous addon back", async () => {
  const { dir, output } = published("the addon that still works");
  const built = join(dir, "built.node");
  writeFileSync(built, "never published");
  // The first refusal moves the addon aside; every later move-aside finds the name already
  // empty (ENOENT) and carries on, until the attempts run out.
  const { fs, refused } = refusingPublish(output, "EPERM");

  await assert.rejects(publishNativeAddon(built, output, "win32", fs), { code: "EPERM" });
  assert.equal(refused(), WIN32_PUBLISH_ATTEMPTS);
  assert.equal(readFileSync(output, "utf8"), "the addon that still works");
  assert.deepEqual(readdirSync(dir).sort(), ["addon.node", "built.node"]);
});

test("off win32 a refused rename is an error, and the published addon stays", async () => {
  const { dir, output } = published("the addon that still works");
  const built = join(dir, "built.node");
  writeFileSync(built, "never published");

  await assert.rejects(
    publishNativeAddon(built, output, "darwin", windowsWithLoaded(new Set([output]))),
    { code: "EPERM" },
  );
  assert.equal(readFileSync(output, "utf8"), "the addon that still works");
  assert.deepEqual(readdirSync(dir).sort(), ["addon.node", "built.node"]);
});

/** Does this build script hand its artifact to the shared publisher, and copy nothing itself? */
function publishesThroughTheHelper(file: string): { imports: boolean; calls: boolean; copies: boolean } {
  const source = readFileSync(join(REPO_ROOT, "scripts", file), "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

  let imports = false;
  let calls = false;
  let copies = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.endsWith("native-addon-publish.mjs")
    ) {
      imports = true;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "publishNativeAddon") calls = true;
      // The defect this file exists for. `copyFile` is legitimate inside a private staging
      // directory, but a builder that reaches for it at all is one edit away from aiming it
      // at `dist/native`, and that is exactly how the two builders drifted apart.
      if (node.expression.text === "copyFile" || node.expression.text === "copyFileSync") {
        copies = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { imports, calls, copies };
}

test("every native builder publishes through the one place that knows why", () => {
  // Every addon is loaded by a running daemon, so each carries the same consequence for
  // getting this wrong. `keep-awake` did not, for as long as it published its own output, and
  // nothing failed until a developer restarted the stack at the wrong moment.
  for (const script of [
    "build-state-lock-native.mjs",
    "build-keep-awake-native.mjs",
    "build-process-inspection-native.mjs",
  ]) {
    const { imports, calls, copies } = publishesThroughTheHelper(script);
    assert.ok(imports, `${script} must import the shared publisher`);
    assert.ok(calls, `${script} must publish through publishNativeAddon`);
    assert.equal(copies, false, `${script} must not copy its own artifact into dist/native`);
  }
});
