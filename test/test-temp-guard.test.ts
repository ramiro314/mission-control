import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

// The temp guard in `test/temp-guard.mjs`, pinned through real workers under the real preload, the
// way `test/test-leak-guard.test.ts` pins its sibling. Each case gets a `TMPDIR` of its own, which
// stands in for the shared temp dir and keeps what it counts away from every other worker.

const PRELOAD = fileURLToPath(new URL("./setup-state.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "mission-temp-guard-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const supported = process.platform === "darwin" || process.platform === "linux";
const USER = process.geteuid?.() ?? "";

let scenarios = 0;

/** A private temp dir, and the file a fixture writes its worker's `TMPDIR` to. */
function scenario() {
  const root = join(dir, `scenario-${scenarios++}`);
  const temp = join(root, "temp");
  mkdirSync(temp, { recursive: true });
  return { temp, marker: join(root, "marker") };
}

function env(temp: string, marker: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...process.env, TMPDIR: temp, FIXTURE_MARKER: marker, ...extra };
  delete next.NODE_TEST_CONTEXT;
  return next;
}

function fixture(name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source, "utf8");
  return path;
}

/** Everything a test file leaks by doing nothing, itself and through a child. */
const LEAK = `
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
writeFileSync(process.env.FIXTURE_MARKER, process.env.TMPDIR);
const leaked = mkdtempSync(join(tmpdir(), "fixture-leak-"));
mkdirSync(join(leaked, "nested/deep"), { recursive: true });
execFileSync(process.execPath, ["-e", \`
  const { mkdtempSync } = require("node:fs");
  const { join } = require("node:path");
  mkdtempSync(join(require("node:os").tmpdir(), "fixture-child-"));
\`]);
`;

const CLEAN_FILE = fixture("clean.test.mjs", `${LEAK}test("passes", () => {});\n`);
const FAILING_FILE = fixture(
  "failing.test.mjs",
  `${LEAK}test("fails", () => { throw new Error("expected"); });\n`,
);

/** A worker with no test in it: the preload, one `TMPDIR` written down, and then it waits. */
const HANGING_WORKER = fixture(
  "hanging-worker.mjs",
  `import { writeFileSync } from "node:fs";
writeFileSync(process.env.FIXTURE_MARKER, process.env.TMPDIR);
setInterval(() => {}, 1000);
`,
);
const BRIEF_WORKER = fixture(
  "brief-worker.mjs",
  `import { writeFileSync } from "node:fs";
writeFileSync(process.env.FIXTURE_MARKER, process.env.TMPDIR);
`,
);

function runTestFile(file: string, childEnv: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--test", "--test-reporter=spec", "--import", PRELOAD, file], {
    encoding: "utf8",
    env: childEnv,
    timeout: 60_000,
  });
}

function runBriefWorker(childEnv: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", PRELOAD, BRIEF_WORKER], {
    encoding: "utf8",
    env: { ...childEnv, NODE_TEST_CONTEXT: "child" },
    timeout: 60_000,
  });
}

/** Start a worker that stays up, and resolve with its temp dir once it has one. */
async function hangingWorker(childEnv: NodeJS.ProcessEnv, marker: string) {
  const child = spawn(process.execPath, ["--import", PRELOAD, HANGING_WORKER], {
    env: { ...childEnv, NODE_TEST_CONTEXT: "child" },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  while (!existsSync(marker)) {
    assert.ok(Date.now() < deadline, "the worker never reported a temp dir");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { child, workerTemp: readFileSync(marker, "utf8") };
}

async function killed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}

/** What the worker left in the private temp dir, its private parent looked into. */
function entriesLeftIn(temp: string): string[] {
  return readdirSync(temp, { recursive: true, encoding: "utf8" }).filter(
    (entry) => !basename(entry).startsWith("tsx-") && !/^mc-test-[^/]+$/.test(entry),
  );
}

test("a passing file that cleans up nothing leaves nothing, and neither does its child", { skip: !supported }, () => {
  const { temp, marker } = scenario();
  const result = runTestFile(CLEAN_FILE, env(temp, marker));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(readFileSync(marker, "utf8")), false);
  assert.deepEqual(entriesLeftIn(temp), []);
});

test("a failing file leaves nothing either", { skip: !supported }, () => {
  const { temp, marker } = scenario();
  const result = runTestFile(FAILING_FILE, env(temp, marker));
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(readFileSync(marker, "utf8")), false);
  assert.deepEqual(entriesLeftIn(temp), []);
});

test("a worker's temp dir sits below the private parent, inside the temp dir it was given", { skip: process.platform !== "linux" }, () => {
  const { temp, marker } = scenario();
  assert.equal(runBriefWorker(env(temp, marker)).status, 0);
  const workerTemp = readFileSync(marker, "utf8");
  assert.equal(dirname(dirname(workerTemp)), temp);
  assert.match(basename(dirname(workerTemp)), new RegExp(`^mc-test-${USER}-\\d+$`));
  assert.match(basename(workerTemp), /^\d+-[0-9a-f]{6}$/);
});

test("the next worker removes what a killed worker left, reports it, and passes", { skip: !supported }, async () => {
  const { temp, marker } = scenario();
  const childEnv = env(temp, marker);
  const { child, workerTemp } = await hangingWorker(childEnv, marker);
  await killed(child);
  assert.equal(existsSync(workerTemp), true, "SIGKILL runs no exit listener");

  const next = runBriefWorker(env(temp, `${marker}-next`));
  assert.equal(next.status, 0, next.stderr);
  assert.equal(existsSync(workerTemp), false);
  assert.match(next.stderr, /test temp guard: removed 1 temp dir\(s\) left by a test run whose worker is gone/);
  assert.match(next.stderr, new RegExp(basename(workerTemp)));
});

test("a live worker's temp dir survives the next worker's start", { skip: !supported }, async () => {
  const { temp, marker } = scenario();
  const childEnv = env(temp, marker);
  const { child, workerTemp } = await hangingWorker(childEnv, marker);
  try {
    const next = runBriefWorker(env(temp, `${marker}-next`));
    assert.equal(next.status, 0, next.stderr);
    assert.equal(existsSync(workerTemp), true);
    assert.doesNotMatch(next.stderr, /test temp guard/);
  } finally {
    await killed(child);
  }
});

test("a directory named for a live PID with another start time is a reused PID, and goes", { skip: !supported }, () => {
  const { temp, marker } = scenario();
  assert.equal(runBriefWorker(env(temp, marker)).status, 0);
  const parent = dirname(readFileSync(marker, "utf8"));
  const stale = join(parent, `${process.pid}-000000`);
  mkdirSync(stale);
  assert.equal(runBriefWorker(env(temp, `${marker}-next`)).status, 0);
  assert.equal(existsSync(stale), false);
});

test("the sweep leaves everything it cannot prove belongs to a dead worker", { skip: !supported }, () => {
  const { temp, marker } = scenario();
  assert.equal(runBriefWorker(env(temp, marker)).status, 0);
  const parent = dirname(readFileSync(marker, "utf8"));
  const unnamed = join(parent, "not-a-worker");
  const neighbor = join(temp, "mission-control-resumes");
  mkdirSync(unnamed);
  mkdirSync(neighbor);
  assert.equal(runBriefWorker(env(temp, `${marker}-next`)).status, 0);
  assert.equal(existsSync(unnamed), true);
  assert.equal(existsSync(neighbor), true);
  rmSync(unnamed, { recursive: true });
});

test("removing a worker's temp dir does not reach through to the shared compile cache", { skip: !supported }, () => {
  const { temp, marker } = scenario();
  const cached = fixture(
    "cached-worker.mjs",
    `import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
writeFileSync(process.env.FIXTURE_MARKER, process.env.TMPDIR);
writeFileSync(join(tmpdir(), "tsx-${USER}", "compiled"), "kept");
`,
  );
  const result = spawnSync(process.execPath, ["--import", PRELOAD, cached], {
    encoding: "utf8",
    env: { ...env(temp, marker), NODE_TEST_CONTEXT: "child" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(readFileSync(marker, "utf8")), false);
  const base = process.platform === "darwin" ? "/private/tmp" : temp;
  assert.equal(readFileSync(join(base, `tsx-${USER}`, "compiled"), "utf8"), "kept");
});

// Linux only: on macOS the parent is the one the running suite is using.
test("a symlink at the private parent's name is refused before anything is deleted", { skip: process.platform !== "linux" }, () => {
  const { temp, marker } = scenario();
  const childEnv = env(temp, marker);
  assert.equal(runBriefWorker(childEnv).status, 0);
  const parent = dirname(readFileSync(marker, "utf8"));
  const target = join(dirname(temp), "elsewhere");
  mkdirSync(join(target, "1-000000"), { recursive: true });
  rmSync(parent, { recursive: true });
  symlinkSync(target, parent);
  const result = runBriefWorker(childEnv);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is not a directory owned by this user/);
  assert.equal(existsSync(join(target, "1-000000")), true);
});

test("MISSION_TEST_TEMP_REPORT names what a file left, and not the worker's own files", { skip: !supported }, () => {
  const { temp, marker } = scenario();
  const result = runTestFile(CLEAN_FILE, env(temp, marker, { MISSION_TEST_TEMP_REPORT: "1" }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = result.stdout + result.stderr;
  assert.match(output, /test temp guard: .*clean\.test\.mjs left 2 entries: /);
  assert.match(output, /fixture-leak-\* \(1\)/);
  assert.match(output, /fixture-child-\* \(1\)/);
  assert.doesNotMatch(output, /mission-test-state/);
});

test("a file with no report requested prints nothing about what it left", { skip: !supported }, () => {
  const { temp, marker } = scenario();
  const childEnv = env(temp, marker);
  delete childEnv.MISSION_TEST_TEMP_REPORT;
  const result = runTestFile(CLEAN_FILE, childEnv);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /test temp guard/);
});
