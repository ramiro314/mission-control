import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  DAEMON_LOG_KEEP,
  DAEMON_LOG_MAX_BYTES,
  rotateDaemonLog,
  teeToDaemonLog,
} from "../src/server/daemon-log.ts";
import { logMain } from "../src/main/main-log.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const startModule = pathToFileURL(join(repo, "src", "server", "daemon-log-start.ts")).href;

function scratch(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "mission-daemon-log-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A stand-in for stdout or stderr that records what reached the terminal. */
function fakeStream() {
  const seen: string[] = [];
  return {
    seen,
    write(chunk: string | Uint8Array): boolean {
      seen.push(String(chunk));
      return true;
    },
  };
}

/**
 * Load the daemon's start module in a fresh Node process, as the daemon entry does, print a
 * line on each stream, then crash. Only the environment differs between a dev launch and one
 * whose launcher captures the output.
 */
function runDaemonLike(home: string, captured: boolean) {
  const env: NodeJS.ProcessEnv = { ...process.env, MISSION_HOME: home };
  delete env.MISSION_DAEMON_LOG_CAPTURED;
  delete env.FLEET_DAEMON_LOG_CAPTURED;
  delete env.HARNESS_DAEMON_LOG_CAPTURED;
  if (captured) env.MISSION_DAEMON_LOG_CAPTURED = "1";
  const script = [
    `await import(${JSON.stringify(startModule)});`,
    `console.log("[worktrees] quarantined uwf slot 3: occupancy-unknown (timeout)");`,
    `console.error("[worktrees] recovered uwf slot 3");`,
    `setImmediate(() => { throw new Error("daemon crashed"); });`,
  ].join("\n");
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: repo, env, encoding: "utf8",
  });
}

test("AC32: without MISSION_DAEMON_LOG_CAPTURED the daemon appends its output and its crash to daemon.log", (t) => {
  const home = scratch(t);
  writeFileSync(join(home, "daemon.log"), "an earlier launch\n");
  const run = runDaemonLike(home, false);
  assert.notEqual(run.status, 0, "the fixture crashes on purpose");
  assert.match(run.stdout, /quarantined uwf slot 3/, "the terminal still sees stdout");
  assert.match(run.stderr, /recovered uwf slot 3/, "and stderr");
  const log = readFileSync(join(home, "daemon.log"), "utf8");
  assert.ok(log.startsWith("an earlier launch\n"), "it appends rather than truncating");
  assert.match(log, /quarantined uwf slot 3: occupancy-unknown \(timeout\)/);
  assert.match(log, /recovered uwf slot 3/);
  assert.match(log, /Error: daemon crashed/, "an uncaught exception reaches the file too");
});

test("AC32: with MISSION_DAEMON_LOG_CAPTURED=1 the daemon writes nothing to daemon.log", (t) => {
  const home = scratch(t);
  const run = runDaemonLike(home, true);
  assert.match(run.stdout, /quarantined uwf slot 3/, "the launcher still receives the output");
  assert.equal(existsSync(join(home, "daemon.log")), false);
});

test("AC32: the log rotates once it passes 10 MB, keeping 3 old files", (t) => {
  assert.equal(DAEMON_LOG_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(DAEMON_LOG_KEEP, 3);
  const root = scratch(t);
  const path = join(root, "daemon.log");
  for (const n of [1, 2, 3]) writeFileSync(`${path}.${n}`, `old ${n}\n`);
  writeFileSync(path, "current\n");
  truncateSync(path, DAEMON_LOG_MAX_BYTES);
  const stdout = fakeStream();
  const capture = teeToDaemonLog({ path, streams: [stdout] });
  t.after(() => capture.stop());

  stdout.write("first line after rotation\n");
  capture.flush();
  assert.equal(readFileSync(path, "utf8"), "first line after rotation\n");
  assert.equal(statSync(`${path}.1`).size, DAEMON_LOG_MAX_BYTES, "the full log is now .1");
  assert.equal(readFileSync(`${path}.2`, "utf8"), "old 1\n");
  assert.equal(readFileSync(`${path}.3`, "utf8"), "old 2\n");
  assert.equal(existsSync(`${path}.4`), false, "the oldest file is dropped");
  assert.deepEqual(stdout.seen, ["first line after rotation\n"]);
});

test("a log one byte under the limit is appended to, not rotated", (t) => {
  const path = join(scratch(t), "daemon.log");
  writeFileSync(path, "x".repeat(99));
  const out = fakeStream();
  const capture = teeToDaemonLog({ path, streams: [out], maxBytes: 100 });
  t.after(() => capture.stop());

  out.write("kept\n");
  capture.flush();
  assert.equal(existsSync(`${path}.1`), false, "an existing log under the limit is never rotated");
  assert.equal(readFileSync(path, "utf8"), `${"x".repeat(99)}kept\n`);
});

test("a log that cannot be written warns once on the real stderr and never throws", (t) => {
  const root = scratch(t);
  const parent = join(root, "parent");
  // A regular file where the log's directory should be, so mkdir and append both fail.
  const breakParent = () => { rmSync(parent, { recursive: true, force: true }); writeFileSync(parent, ""); };
  const path = join(parent, "daemon.log");
  breakParent();
  const out = fakeStream();
  const err = fakeStream();
  const capture = teeToDaemonLog({ path, streams: [out, err] });
  t.after(() => capture.stop());
  const warnings = () => err.seen.filter((line) => line.startsWith("[daemon-log] could not append to "));

  out.write("lost\n");
  assert.doesNotThrow(() => capture.flush());
  assert.equal(warnings().length, 1);

  // Once the directory can be made, the next batch holds only what came after the failure:
  // a warning written through the wrapped stream would have been queued for this file.
  rmSync(parent);
  out.write("kept\n");
  capture.flush();
  assert.equal(readFileSync(path, "utf8"), "kept\n");

  breakParent();
  out.write("lost again\n");
  assert.doesNotThrow(() => capture.flush());
  assert.equal(warnings().length, 1, "reported once, not on every failing batch");
  assert.deepEqual(out.seen, ["lost\n", "kept\n", "lost again\n"], "the terminal still gets every line");
});

test("the size is checked before each write batch, not each write", async (t) => {
  const path = join(scratch(t), "daemon.log");
  const out = fakeStream();
  const err = fakeStream();
  const capture = teeToDaemonLog({ path, streams: [out, err], maxBytes: 10 });
  t.after(() => capture.stop());

  out.write("0123456789");
  err.write(Buffer.from("abc\n"));
  await new Promise((done) => setImmediate(done));
  assert.equal(readFileSync(path, "utf8"), "0123456789abc\n", "one batch lands whole, past the limit");
  assert.equal(statSync(path).mode & 0o777, 0o600, "a new log is private to its owner");
  assert.equal(existsSync(`${path}.1`), false);

  out.write("next\n");
  await new Promise((done) => setImmediate(done));
  assert.equal(readFileSync(`${path}.1`, "utf8"), "0123456789abc\n");
  assert.equal(readFileSync(path, "utf8"), "next\n");
});

test("rotation tolerates missing generations", (t) => {
  const path = join(scratch(t), "daemon.log");
  writeFileSync(path, "only\n");
  rotateDaemonLog(path);
  assert.equal(readFileSync(`${path}.1`, "utf8"), "only\n");
  assert.equal(existsSync(path), false);
  rotateDaemonLog(path);
  assert.equal(readFileSync(`${path}.2`, "utf8"), "only\n", "an absent current log shifts the rest");
});

test("Electron main's append-mode logger keeps writing after a rotation", (t) => {
  const path = join(scratch(t), "daemon.log");
  const out = fakeStream();
  const capture = teeToDaemonLog({ path, streams: [out], maxBytes: 1 });
  t.after(() => capture.stop());
  logMain("before rotation", path);
  out.write("daemon line\n");
  capture.flush();
  logMain("after rotation", path);
  assert.match(readFileSync(`${path}.1`, "utf8"), /before rotation/);
  const current = readFileSync(path, "utf8");
  assert.match(current, /^daemon line\n.*\[main pid=\d+\] after rotation\n$/);
});

test("stop puts the streams back", (t) => {
  const path = join(scratch(t), "daemon.log");
  const out = fakeStream();
  const original = out.write;
  const capture = teeToDaemonLog({ path, streams: [out] });
  capture.stop();
  assert.equal(out.write, original);
  out.write("not copied\n");
  capture.flush();
  assert.equal(existsSync(path), false);
});
