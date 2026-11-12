import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadNativeCloneTreeBinding,
  nativeCloneTreeAddonPath,
  validateNativeCloneTreeBinding,
} from "../src/server/clone-tree-native.ts";
import { copyOnWriteClone } from "../src/server/worktrees/seed.ts";

test("native tree clone loader resolves the same dist artifact from source and bundled module URLs", () => {
  assert.equal(
    nativeCloneTreeAddonPath("file:///repo/dist/server/index.mjs"),
    nativeCloneTreeAddonPath("file:///repo/src/server/clone-tree-native.ts"),
  );
  assert.equal(nativeCloneTreeAddonPath("file:///repo/src/server/clone-tree-native.ts"), "/repo/dist/native/clone-tree.node");
});

test("native tree clone loader refuses a module without a clone function", () => {
  assert.throws(() => validateNativeCloneTreeBinding({}), /must export a clone function/);
  assert.throws(() => validateNativeCloneTreeBinding(null), /must export a clone function/);
  assert.throws(
    () => loadNativeCloneTreeBinding(() => ({ clone: "not a function" })),
    /must export a clone function/,
  );
});

test("native tree clone loader accepts a clone function and asks for the dist artifact", () => {
  const binding = { clone: async () => {} };
  let asked = "";
  assert.equal(
    loadNativeCloneTreeBinding((id) => {
      asked = id;
      return binding;
    }),
    binding,
  );
  assert.equal(asked, nativeCloneTreeAddonPath());
});

// ---- the real addon, on macOS ----

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Provision `dist/native/clone-tree.node` as `ensureNativeStateLockAddon` provisions the state
 * lock: the load decides, probed in a child so a rebuilt addon is never shadowed by one this
 * worker already opened. `npm test` builds only the state lock, so a Mac that never ran
 * `npm run build:native` compiles it here rather than skipping the addon's only real test.
 */
function ensureNativeCloneTreeAddon(): void {
  const addon = nativeCloneTreeAddonPath();
  try {
    execFileSync(process.execPath, ["-e", `require(${JSON.stringify(addon)})`], { cwd: REPO_ROOT, stdio: "pipe" });
  } catch {
    execFileSync(process.execPath, ["scripts/build-clone-tree-native.mjs"], { cwd: REPO_ROOT, stdio: "pipe" });
  }
}

/** Every entry under `root`: name, type, permission bits, size, symlink target and contents. */
function describeTree(root: string): string[] {
  const entries: string[] = [];
  const walk = (relative: string): void => {
    const path = join(root, relative);
    const stat = lstatSync(path);
    const mode = (stat.mode & 0o7777).toString(8);
    if (stat.isSymbolicLink()) entries.push(`${relative} link ${mode} -> ${readlinkSync(path)}`);
    else if (stat.isDirectory()) {
      entries.push(`${relative} dir ${mode}`);
      for (const name of readdirSync(path).sort()) walk(relative ? `${relative}/${name}` : name);
    } else {
      const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
      entries.push(`${relative} file ${mode} ${stat.size} ${digest}`);
    }
  };
  walk("");
  return entries;
}

/** A tree with nesting, an empty directory, non-default modes, and live and dangling symlinks. */
function fixtureTree(): string {
  const root = join(mkdtempSync(join(tmpdir(), "mission-clone-tree-")), "node_modules");
  mkdirSync(join(root, "pkg", "lib"), { recursive: true });
  mkdirSync(join(root, "empty"));
  writeFileSync(join(root, "pkg", "lib", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(root, "pkg", "bin"), "#!/bin/sh\necho hi\n");
  chmodSync(join(root, "pkg", "bin"), 0o750);
  writeFileSync(join(root, "pkg", "secret"), Buffer.alloc(70_000, 7));
  chmodSync(join(root, "pkg", "secret"), 0o600);
  chmodSync(join(root, "pkg", "lib"), 0o700);
  symlinkSync("../pkg/bin", join(root, "bin-link"));
  symlinkSync("does/not/exist", join(root, "dangling"));
  return root;
}

const onMac = process.platform === "darwin";

test("the real addon clones a tree that matches its source", { skip: !onMac && "the clone-tree addon is darwin-only" }, async () => {
  ensureNativeCloneTreeAddon();
  const binding = loadNativeCloneTreeBinding();
  const source = fixtureTree();
  const destination = join(mkdtempSync(join(tmpdir(), "mission-clone-tree-dest-")), "node_modules");
  await binding.clone(source, destination);
  assert.deepEqual(describeTree(destination), describeTree(source));
  assert.equal(lstatSync(join(destination, "dangling")).isSymbolicLink(), true, "a symlink is cloned, never followed");

  // The production clone through the real loader reaches the same addon.
  const viaSeed = join(mkdtempSync(join(tmpdir(), "mission-clone-tree-seed-")), "node_modules");
  const result = await copyOnWriteClone({ platform: "darwin" })({
    source,
    destination: viaSeed,
    signal: new AbortController().signal,
    timeoutMs: 60_000,
  });
  assert.deepEqual(result, { outcome: "cloned" });
  assert.deepEqual(describeTree(viaSeed), describeTree(source));
});

test("the real addon rejects a refusal with a positive errno and refuses bad arguments", { skip: !onMac && "the clone-tree addon is darwin-only" }, async () => {
  ensureNativeCloneTreeAddon();
  const binding = loadNativeCloneTreeBinding();
  const holder = mkdtempSync(join(tmpdir(), "mission-clone-tree-refuse-"));
  await assert.rejects(binding.clone(join(holder, "missing"), join(holder, "copy")), (error: unknown) => {
    assert.ok(error instanceof Error);
    const errno = (error as { errno?: unknown }).errno;
    assert.ok(typeof errno === "number" && Number.isInteger(errno) && errno > 0, `errno ${String(errno)}`);
    return true;
  });
  assert.equal(existsSync(join(holder, "copy")), false);

  const clone = binding.clone as (...args: unknown[]) => unknown;
  assert.throws(() => clone(holder), TypeError);
  assert.throws(() => clone(holder, holder, holder), TypeError);
  assert.throws(() => clone("", join(holder, "copy")), TypeError);
  assert.throws(() => clone(`${holder}\0x`, join(holder, "copy")), TypeError);
  assert.throws(() => clone(holder, 7), TypeError);
});
