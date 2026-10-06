/**
 * The Makefile under Git Bash on Windows (D31 in `docs/plans/windows-support/plan.md`).
 *
 * Each case runs the real Makefile with `OS` set on the command line, which outranks the
 * environment, so every platform exercises both branches: `OS=Windows_NT` is what every
 * Windows environment carries, and an empty `OS` is macOS and Linux. Every tool a recipe could
 * reach (npm, node, lsof, pgrep, pkill, nohup) is a fake on `PATH` that only logs its call, so
 * a guard that failed to stop a recipe shows up in the log instead of packaging, installing or
 * killing anything for real.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MAKE_MISSING = spawnSync("make", ["--version"], { encoding: "utf8" }).status !== 0;
const skip = MAKE_MISSING ? "GNU make is not on PATH" : false;

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
// and never touches the worktree's real stamp. Relative, so no drive letter reaches make.
const stamp = join(scratch, "install-stamp");
writeFileSync(stamp, "");
const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
utimesSync(stamp, future, future);
const stampArg = relative(REPO, stamp).split("\\").join("/");

function make(target: string, os: string) {
  writeFileSync(log, "");
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_TOOL_LOG: log, MAKEFLAGS: undefined, MAKELEVEL: undefined };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = `${bin}${delimiter}${env[pathKey] ?? ""}`;
  const run = spawnSync("make", ["--no-print-directory", target, `OS=${os}`, `NPM_STAMP=${stampArg}`], {
    cwd: REPO,
    env,
    encoding: "utf8",
  });
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
