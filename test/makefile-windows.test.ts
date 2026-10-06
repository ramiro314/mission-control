/**
 * The Makefile under Git Bash on Windows (D31 in `docs/plans/windows-support/plan.md`).
 *
 * Each case runs the real Makefile with `OS` set on the command line, which outranks the
 * environment, so macOS and Linux exercise both branches: `OS=Windows_NT` is what every
 * Windows environment carries, and an empty `OS` is macOS and Linux. Every tool a recipe could
 * reach (npm, node, lsof, pgrep, pkill, nohup) is a fake on `PATH` that only logs its call, so
 * a guard that failed to stop a recipe shows up in the log instead of packaging, installing or
 * killing anything for real.
 *
 * The fakes are POSIX shell scripts, and only a POSIX exec is sure to choose them: on win32 a
 * recipe can resolve `npm.cmd` or `node.exe` instead and run the real recipe. So the file skips
 * on win32, where A10's manual smoke covers the Makefile. GNU make is required everywhere else,
 * as the repository's own gates (`make check`, `make lint`) already assume, so a missing `make`
 * fails here rather than skipping.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { skipOnWin32 } from "./helpers/win32-skip.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const skip = skipOnWin32(
  "the fake tools are POSIX shell scripts that a Windows recipe may bypass for npm.cmd or node.exe, running the real recipe; A10's manual smoke covers the Makefile on Windows",
);
// A recipe that slipped its guard and started the dev stack would otherwise never return.
const MAKE_TIMEOUT_MS = 30_000;

const scratch = mkdtempSync(join(tmpdir(), "makefile-windows-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const bin = join(scratch, "bin");
const log = join(scratch, "calls.log");
mkdirSync(bin);
// npm and node succeed; the process tools find nothing, as they would with no stack running.
for (const [tool, status] of [["npm", 0], ["node", 0], ["lsof", 1], ["pgrep", 1], ["pkill", 1], ["nohup", 0]] as const) {
  const fake = join(bin, tool);
  writeFileSync(fake, `#!/bin/sh\necho "${tool} $*" >> "$FAKE_TOOL_LOG"\nexit ${status}\n`);
  chmodSync(fake, 0o755);
}
// A dependency stamp newer than the manifests, so a build target never reaches `npm install`
// and never touches the worktree's real stamp.
const stamp = join(scratch, "install-stamp");
writeFileSync(stamp, "");
const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
utimesSync(stamp, future, future);

function make(target: string, os: string) {
  writeFileSync(log, "");
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_TOOL_LOG: log,
    MAKEFLAGS: undefined,
    MAKELEVEL: undefined,
  };
  const run = spawnSync("make", ["--no-print-directory", target, `OS=${os}`, `NPM_STAMP=${stamp}`], {
    cwd: REPO,
    env,
    encoding: "utf8",
    timeout: MAKE_TIMEOUT_MS,
  });
  assert.ifError(run.error);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, calls: readFileSync(log, "utf8").trim() };
}

const WINDOWS = "Windows_NT";
const MAC = "";

test("on Windows the macOS app targets say so and run nothing", { skip }, () => {
  for (const target of ["app", "install", "install-app"]) {
    const run = make(target, WINDOWS);
    assert.notEqual(run.status, 0, `make ${target} must fail on Windows`);
    assert.match(run.stderr, /builds or installs the macOS app, so it is not available on Windows/u);
    assert.equal(run.calls, "", `make ${target} ran a recipe past its guard`);
  }
});

test("on Windows the targets that need lsof, pgrep and pkill say so and run nothing", { skip }, () => {
  for (const target of ["claude", "up", "down", "restart", "stop-all", "status"]) {
    const run = make(target, WINDOWS);
    assert.notEqual(run.status, 0, `make ${target} must fail on Windows`);
    assert.match(run.stderr, /needs lsof, pgrep and pkill, which Git Bash on Windows does not provide/u);
    assert.equal(run.calls, "", `make ${target} ran a recipe past its guard`);
  }
});

test("on Windows make start and the build targets run their npm scripts", { skip }, () => {
  for (const [target, call] of [
    ["start", "npm run dev:start"],
    ["build", "npm run build"],
    ["check", "npm run typecheck"],
    ["lint", "npm run lint"],
    ["smoke", "npm run smoke"],
  ] as const) {
    const run = make(target, WINDOWS);
    assert.equal(run.status, 0, `make ${target} failed on Windows: ${run.stderr}`);
    assert.equal(run.calls, call);
    assert.doesNotMatch(run.stderr, /Windows/u);
  }
});

test("elsewhere the macOS and process targets behave as before", { skip }, () => {
  for (const [target, call] of [
    ["app", "npm run package"],
    ["install", "node scripts/install-app.mjs"],
    ["start", "npm run dev:start"],
    ["build", "npm run build"],
    ["status", "lsof -ti tcp:7317"],
  ] as const) {
    const run = make(target, MAC);
    assert.equal(run.status, 0, `make ${target} failed: ${run.stderr}`);
    assert.equal(run.calls, call);
    assert.doesNotMatch(run.stderr, /Windows/u);
  }
  assert.match(make("status", MAC).stdout, /not running/u);
});
