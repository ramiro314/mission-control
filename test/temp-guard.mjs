// Give every test worker a temp dir of its own, and keep a test run from filling the real one.
//
// The incident was `/tmp` running out of inodes with bytes to spare: 10,499 `mission-*`
// directories, 9,583 of them from one day, nearly all of them git fixtures of about 100 inodes.
// `mkOriginAndClone`, `gitRepo`, `monorepoTree` and their kin hand back a directory and nothing
// removes it, in over 600 files that each call `mkdtemp` their own way. Teaching each to clean up
// would not last, and could not reach what a child process makes, or what a timed-out worker was
// holding when it died.
//
// So the preload points `TMPDIR` at a directory owned by this one worker, every `tmpdir()` in the
// file and in anything it spawns lands there, and it goes when the worker does. It has two halves,
// the same two `leak-guard.mjs` has and for the same reason, a killed worker runs nothing:
//
//   - At worker exit, the worker's temp dir is removed.
//   - At worker start, a temp dir whose owner is gone is removed. Timeouts, SIGTERM and SIGKILL
//     all skip `exit`, so this is what cleans up after them. It reads only the private parent
//     below, never the shared temp dir, so it cannot touch another agent's files, and a live
//     worker's directory is never judged stale.
//
// Where this stops: a child spawned with an environment that drops `TMPDIR` falls back to the real
// temp dir, the same boundary AGENTS.md states for `openDb`. Commands that skip the preload, such
// as `npm run test:e2e` and `npm run smoke`, are not covered either.
//
// Plain `.mjs` with only Node built-ins, for the reason `setup-state.mjs` gives.

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pidNamespace } from "./leak-guard.mjs";

const TEMP_REPORT = "MISSION_TEST_TEMP_REPORT";

/** The preload's own: the worker's state home and the shared compile cache's link. */
const NOT_LEFTOVERS = /^(?:mission-test-state-|tsx-)/;

const USER = process.geteuid?.() ?? userInfo().username;

/** `<pid>-<token>`, or the name of a directory this guard did not derive from a process. */
const OWNED = /^(\d+)-([0-9a-f]{6})$/;

/** Names a directory after its worker. Six hex characters because macOS sockets stop at 104. */
function workerDirName(pid, start) {
  return `${pid}-${createHash("sha256").update(start).digest("hex").slice(0, 6)}`;
}

/**
 * Where this user's worker dirs live. Per user because the temp dir is shared, and per PID
 * namespace because a PID means nothing across one: a container bound to the same `/tmp` would
 * otherwise see every worker here as dead, the case `leak-guard.mjs` also has to refuse.
 */
function parentDir(base) {
  const namespace = pidNamespace("self")?.match(/\d+/)?.[0];
  return join(base, `mc-test-${USER}${namespace ? `-${namespace}` : ""}`);
}

/**
 * The temp root worker dirs hang from. macOS gets `/private/tmp` because its `$TMPDIR` is already
 * 49 characters of the 103 a socket path may use, which two more directories would push fixtures
 * like `mission-herdr-socket-XXXXXX/herdr.sock` past.
 */
function tempBase() {
  return process.platform === "darwin" ? "/private/tmp" : resolve(tmpdir());
}

/** The parent, private to this user, and what it held before the process table was read. */
export function openTempParent() {
  const base = tempBase();
  const parent = parentDir(base);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // The shared temp dir lets any user create this name first, and a symlink there would aim
  // every test's writes, and the sweep's deletes, wherever its author chose.
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || (process.geteuid && stat.uid !== process.geteuid())) {
    throw new Error(`test temp guard: ${parent} is not a directory owned by this user`);
  }
  return { base, parent, entries: readdirSync(parent) };
}

/** True when the process table proves `name`'s worker is gone. */
function ownerIsGone(name, rows) {
  const owned = OWNED.exec(name);
  if (!owned) return false;
  const pid = Number(owned[1]);
  const row = rows.find((candidate) => candidate.pid === pid);
  if (row) return workerDirName(pid, row.start) !== name;
  // A row can be missing from a scan for reasons short of death, and being wrong here deletes
  // a running file's fixtures out from under it.
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

function sweep({ parent, entries }, rows) {
  const swept = [];
  for (const name of entries) {
    if (!ownerIsGone(name, rows)) continue;
    try {
      rmSync(join(parent, name), { recursive: true, force: true });
      swept.push(name);
    } catch {
      // Another worker is removing the same directory, or something in it cannot be removed.
      // Neither is this file's failure, and an undeletable directory is tried again next time.
    }
  }
  if (swept.length === 0) return;
  writeSync(
    2,
    `test temp guard: removed ${swept.length} temp dir(s) left by a test run whose worker is gone ` +
      `(reported, not failed: the leak belongs to that run, not to this file): ${swept.join(", ")}\n`,
  );
}

/**
 * Keep tsx's compile cache in the real temp dir. It sits under `tmpdir()`, and a private temp dir
 * would cost every worker, and every child it starts through tsx, a cold compile of the server.
 * The target has to exist first: tsx's `mkdirSync` throws `ENOENT` on a dangling link.
 */
function shareCompileCache(base, dir) {
  const name = `tsx-${USER}`;
  const cache = join(base, name);
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  symlinkSync(cache, join(dir, name));
}

/** What the test file left for this guard, for a person moving it onto its own cleanup. */
function reportLeftovers(dir) {
  const left = readdirSync(dir).filter((name) => !NOT_LEFTOVERS.test(name));
  if (left.length === 0) return;
  const counts = new Map();
  for (const name of left) {
    const prefix = name.replace(/[A-Za-z0-9]{6}$/, "");
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const summary = [...counts].map(([prefix, count]) => `${prefix}* (${count})`).join(", ");
  writeSync(2, `test temp guard: ${process.argv[1]} left ${left.length} entries: ${summary}\n`);
}

/**
 * Move this worker's `TMPDIR` to a directory of its own and reap what dead workers left. Called
 * once by `setup-state.mjs`, after `armLeakGuard`: a stale process must be dead before its
 * directory goes, and this worker's own leaks must be dead before this `exit` listener runs.
 */
export function armTempGuard(opened, rows) {
  const { base, parent } = opened;
  const self = rows?.find((row) => row.pid === process.pid);
  const dir = self
    ? join(parent, workerDirName(process.pid, self.start))
    : mkdtempSync(join(parent, "unjudged-"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  shareCompileCache(base, dir);
  process.env.TMPDIR = dir;

  if (rows) sweep(opened, rows);

  process.on("exit", () => {
    if (process.env[TEMP_REPORT]) reportLeftovers(dir);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // An untracked child is still writing, or something in here cannot be removed. The next
      // worker's sweep tries again, and failing the file here would turn that race into a flake.
    }
  });
  return dir;
}
