#!/usr/bin/env node

import { copyFile, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { platform as processPlatform } from "node:process";

/**
 * How a freshly built native addon reaches `dist/native`, and why it is never a plain copy.
 *
 * A `copyFile` onto the published path truncates and rewrites the file that is already there,
 * keeping its inode. On macOS that is destructive in a way no JavaScript error reports: if any
 * live process has that addon mapped, rewriting the bytes underneath it invalidates the
 * kernel's code-signature bookkeeping for that vnode, and from then on EVERY process that
 * loads it is `SIGKILL`ed. Not an exception, not a load error - the process is gone before it
 * can print anything, and a `require` of the byte-identical file at a fresh inode still works,
 * so the file looks perfectly healthy to `codesign`, `shasum`, and a reader.
 *
 * That is not hypothetical. `npm run build:native` runs on every `make start`, and a developer
 * restarting the stack has a daemon or an Electron shell holding the previous addon open. One
 * such restart poisons the published inode, and afterwards every daemon spawned from that
 * worktree dies during startup with an empty stderr and exit code 137 - including the daemons
 * that `test/daemon-state-ownership.test.ts` spawns, which is how this was found.
 *
 * A rename cannot do that. It publishes a NEW inode and leaves the old one alone, so a process
 * that already mapped the previous addon keeps reading the bytes it validated, and the next
 * process to load resolves the name to an untouched file. The staging copy lives beside the
 * destination so the rename stays within one filesystem, which is what makes it atomic.
 *
 * Both native builders publish through here rather than each spelling it out. The rule is one
 * line of code and several paragraphs of reason, and it was already written down correctly in
 * one of the two builders while the other quietly copied over its output.
 */

/**
 * Remove download provenance inherited by a freshly copied local addon on macOS.
 *
 * The linker gives the bundle a valid ad-hoc signature, but a worktree can itself carry
 * `com.apple.provenance`. `copyFile` preserves that attribute on this host, and macOS then kills
 * Node while it loads the addon. Listing first distinguishes an already-clean file without
 * interpreting platform-specific error text. Every listing or deletion failure stays fatal
 * because shipping an addon the daemon cannot load would make both ordinary startup and
 * database recovery fail without a JavaScript diagnostic.
 */
export function clearDarwinProvenance(
  path,
  platform = processPlatform,
  execute = execFileSync,
) {
  if (platform !== "darwin") return false;
  const attributes = String(
    execute("/usr/bin/xattr", [path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (!attributes.split(/\r?\n/).includes("com.apple.provenance")) return false;
  execute("/usr/bin/xattr", ["-d", "com.apple.provenance", path], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  return true;
}

/**
 * Move a built addon to its published path without ever writing through that path.
 *
 * `built` is the artifact node-gyp just produced; `output` is the name the daemon loads. The
 * staging directory is created beside `output` and removed on every exit path, so a failed
 * build leaves the previously published addon exactly as it was rather than a half-written one.
 */
export async function publishNativeAddon(
  built,
  output,
  platform = processPlatform,
  fs = { rename, readdir, rm },
) {
  const workspace = await mkdtemp(join(dirname(output), ".publish-"));
  try {
    const staged = join(workspace, "addon.node");
    await copyFile(built, staged);
    clearDarwinProvenance(staged);
    await replaceAddon(staged, output, platform, fs);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** Every addon a win32 publish moved aside starts with this, in the published directory. */
export const RETIRED_ADDON_PREFIX = ".retired-";

const WIN32_IN_USE = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * The rename itself, plus the one thing Windows needs on top of it.
 *
 * Windows refuses to rename onto an addon that a live process has loaded: replacing the name
 * deletes the old file, and a mapped image cannot be deleted. It can still be renamed, so on
 * win32 a refused publish moves the loaded addon aside to a `.retired-` name in the same
 * directory and tries again. The process holding it keeps the bytes it mapped, exactly as on
 * macOS, and a later publish sweeps the retired file once nothing has it loaded. Between those
 * two renames the published name is briefly absent, so a process loading it at that instant
 * fails to load rather than loading a half-written file. Every other platform, and every other
 * error, takes the plain rename and its error unchanged.
 */
async function replaceAddon(staged, output, platform, fs) {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(staged, output);
      break;
    } catch (error) {
      if (platform !== "win32" || attempt >= 5 || !WIN32_IN_USE.has(error?.code)) throw error;
    }
    try {
      await fs.rename(output, join(dirname(output), `${RETIRED_ADDON_PREFIX}${randomUUID()}.node`));
    } catch (error) {
      // A concurrent publisher already moved it aside.
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (platform === "win32") await sweepRetiredAddons(dirname(output), fs);
}

/** Best effort: a retired addon that is still loaded somewhere stays until a later sweep. */
async function sweepRetiredAddons(dir, fs) {
  const retired = (await fs.readdir(dir)).filter((name) => name.startsWith(RETIRED_ADDON_PREFIX));
  await Promise.all(retired.map((name) => fs.rm(join(dir, name), { force: true }).catch(() => {})));
}
