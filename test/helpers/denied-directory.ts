import fs, { chmodSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, resolve } from "node:path";
import { mock } from "node:test";

/**
 * Which right a test takes away from a directory it still wants to exist.
 *
 * - `list`: reading its entries fails with EACCES, so "unreadable" and "absent" can be told
 *   apart. Creating, removing and opening entries by name still works.
 * - `write`: creating or removing an entry directly inside it fails with EACCES. Listing it
 *   still works.
 */
export type DirectoryRight = "list" | "write";

/** The fs functions a `write` denial refuses, and which arguments name the entry they touch. */
const WRITE_OPERATIONS = {
  symlinkSync: [1],
  linkSync: [1],
  unlinkSync: [0],
  rmSync: [0],
  rmdirSync: [0],
  mkdirSync: [0],
  renameSync: [0, 1],
  writeFileSync: [0],
  copyFileSync: [1],
} as const;

/** The fs functions a `list` denial refuses. Each names the directory as its first argument. */
const LIST_OPERATIONS = {
  sync: ["readdirSync", "opendirSync"],
  promises: ["readdir", "opendir"],
} as const;

/**
 * Take one right away from `dir` until the returned function is called, by the means each
 * platform has.
 *
 * POSIX clears the matching permission bits, so the kernel itself refuses. win32 has no
 * permission bits for `chmod` to clear, and an ACL deny entry is not a reliable stand-in: it
 * held on a developer's non-elevated shell but not on the CI runner, where the listing still
 * succeeded. There, the fs functions that would touch `dir` are replaced for the duration and
 * throw the error the kernel would have, so the code under test sees the same refusal through
 * the same calls. Everything else - other paths, and every right not named - still reaches
 * the real filesystem.
 *
 * The win32 seam covers the functions above. Code that reaches the directory through any other
 * one would not be refused, so a test using this asserts that the refusal was reported; a
 * seam that missed would fail that assertion rather than pass quietly.
 *
 * The returned function restores the directory and is safe to call more than once, so a test
 * can restore early and still register it with `after`.
 *
 * ```ts
 * const restore = denyDirectory(skillsDir, "write");
 * try {
 *   assert.match(reconcile().problems[0], /couldn't enable/);
 * } finally {
 *   restore();
 * }
 * ```
 */
export function denyDirectory(
  dir: string,
  right: DirectoryRight,
  platform: NodeJS.Platform = process.platform,
): () => void {
  if (platform !== "win32") {
    chmodSync(dir, right === "list" ? 0o300 : 0o500);
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      chmodSync(dir, 0o700);
    };
  }

  const denied = resolve(dir);
  const names = (path: unknown): boolean => typeof path === "string" && resolve(path) === denied;
  const inside = (path: unknown): boolean => typeof path === "string" && dirname(resolve(path)) === denied;
  const mocks: Array<{ mock: { restore(): void } }> = [];

  if (right === "write") {
    for (const [name, positions] of Object.entries(WRITE_OPERATIONS)) {
      mocks.push(refuseWhen(fs, name, (args) => {
        const hit = positions.find((i) => inside(args[i]));
        return hit === undefined ? null : refusal(name.replace(/Sync$/, ""), args[hit]);
      }));
    }
  } else {
    const listing = (args: unknown[]) => (names(args[0]) ? refusal("scandir", args[0]) : null);
    for (const name of LIST_OPERATIONS.sync) mocks.push(refuseWhen(fs, name, listing));
    for (const name of LIST_OPERATIONS.promises) mocks.push(refuseWhen(fs.promises, name, listing, true));
  }
  // The code under test imports these by name, and a named import of a builtin is a copy
  // until this runs.
  syncBuiltinESMExports();

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const m of mocks) m.mock.restore();
    syncBuiltinESMExports();
  };
}

type Operation = (...args: unknown[]) => unknown;

/** The error the kernel reports for a refused `syscall` on `path`. */
function refusal(syscall: string, path: unknown): NodeJS.ErrnoException {
  return Object.assign(new Error(`EACCES: permission denied, ${syscall} '${String(path)}'`), {
    code: "EACCES",
    errno: -4092,
    syscall,
    path: String(path),
  });
}

/**
 * Replace `target[name]` with one that fails with `refuse(args)` when that returns an error and
 * otherwise calls through. A promise-returning operation rejects rather than throwing, as the
 * real one would.
 */
function refuseWhen(
  target: object,
  name: string,
  refuse: (args: unknown[]) => NodeJS.ErrnoException | null,
  async = false,
): { mock: { restore(): void } } {
  const operations = target as Record<string, Operation>;
  const original = operations[name];
  if (!original) throw new Error(`fs has no ${name} to deny`);
  return mock.method(operations, name, function (this: unknown, ...args: unknown[]) {
    const error = refuse(args);
    if (error) {
      if (async) return Promise.reject(error);
      throw error;
    }
    return original.apply(this, args);
  });
}
