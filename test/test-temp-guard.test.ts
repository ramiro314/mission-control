import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
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
const TEMP_GUARD = new URL("./temp-guard.mjs", import.meta.url).href;
const dir = mkdtempSync(join(tmpdir(), "mission-temp-guard-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const supported = process.platform === "darwin" || process.platform === "linux";
// On macOS the parent is the one the running suite is using, so another worker may sweep a stale
// directory first, and what these tests may say about the sweep's report is limited to Linux.
const privateParent = process.platform === "linux";
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

/**
 * The guard with a process table of the test's choosing, which the preload never allows: `rows` is
 * the source of an expression, and `names` go into the parent before the guard reads it.
 */
function runGuardWith(rows: string, names: string[], childEnv: NodeJS.ProcessEnv) {
  const script = fixture(
    `guard-with-${scenarios++}.mjs`,
    `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { armTempGuard, openTempParent } from ${JSON.stringify(TEMP_GUARD)};
const { parent } = openTempParent();
for (const name of ${JSON.stringify(names)}) mkdirSync(join(parent, name), { recursive: true });
armTempGuard(openTempParent(), ${rows});
writeFileSync(process.env.FIXTURE_MARKER, JSON.stringify({ parent, workerTemp: process.env.TMPDIR }));
`,
  );
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: childEnv, timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  const { parent, workerTemp } = JSON.parse(readFileSync(childEnv.FIXTURE_MARKER!, "utf8")) as {
    parent: string;
    workerTemp: string;
  };
  return { ...result, parent, workerTemp };
}

/** A PID that belonged to a real process and is provably gone. */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(pid);
  return pid;
}

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

test("a worker's temp dir sits below the private parent, inside the temp dir it was given", { skip: !privateParent }, () => {
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
  if (privateParent) assert.equal(existsSync(workerTemp), true, "SIGKILL runs no exit listener");

  const next = runBriefWorker(env(temp, `${marker}-next`));
  assert.equal(next.status, 0, next.stderr);
  assert.equal(existsSync(workerTemp), false);
  if (privateParent) {
    assert.match(next.stderr, /test temp guard: removed 1 temp dir\(s\) left by a test run whose worker is gone/);
    assert.match(next.stderr, new RegExp(basename(workerTemp)));
  }
});

test("a live worker's temp dir survives the next worker's start", { skip: !supported }, async () => {
  const { temp, marker } = scenario();
  const childEnv = env(temp, marker);
  const { child, workerTemp } = await hangingWorker(childEnv, marker);
  try {
    const next = runBriefWorker(env(temp, `${marker}-next`));
    assert.equal(next.status, 0, next.stderr);
    assert.equal(existsSync(workerTemp), true);
    assert.doesNotMatch(next.stderr, new RegExp(basename(workerTemp)));
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

test("the sweep leaves a name it did not make, and everything outside its parent", { skip: !supported }, () => {
  const { temp, marker } = scenario();
  assert.equal(runBriefWorker(env(temp, marker)).status, 0);
  const parent = dirname(readFileSync(marker, "utf8"));
  const unnamed = join(parent, "not-a-worker");
  const neighbor = join(temp, "mission-control-resumes");
  // Named as a dead worker's directory would be, so only where it sits can save it.
  const deadNeighbor = join(temp, `${deadPid()}-abcdef`);
  mkdirSync(unnamed);
  mkdirSync(neighbor);
  mkdirSync(deadNeighbor);
  assert.equal(runBriefWorker(env(temp, `${marker}-next`)).status, 0);
  assert.equal(existsSync(unnamed), true);
  assert.equal(existsSync(neighbor), true);
  assert.equal(existsSync(deadNeighbor), true);
  rmSync(unnamed, { recursive: true });
});

test("a directory whose owner is missing from the table but not proven dead is kept", { skip: !privateParent }, () => {
  const { temp, marker } = scenario();
  // This worker is alive and PID 1 answers EPERM to anyone but root, and neither is in the table.
  const alive = `${process.pid}-abcdef`;
  const unprovable = "1-abcdef";
  const { stderr, parent } = runGuardWith(
    `[{ pid: process.pid, start: "fixture" }]`,
    [alive, unprovable],
    env(temp, marker),
  );
  assert.equal(existsSync(join(parent, alive)), true);
  assert.equal(existsSync(join(parent, unprovable)), true);
  assert.doesNotMatch(stderr, /abcdef/);
  rmSync(join(parent, alive), { recursive: true });
  rmSync(join(parent, unprovable), { recursive: true });
});

test("a worker with no process table judges nothing and still removes its own temp dir", { skip: !privateParent }, () => {
  const { temp, marker } = scenario();
  const earlier = "unjudged-abc123";
  const dead = `${deadPid()}-abcdef`;
  const { stderr, parent, workerTemp } = runGuardWith("null", [earlier, dead], env(temp, marker));
  assert.equal(dirname(workerTemp), parent);
  assert.match(basename(workerTemp), /^unjudged-/);
  assert.equal(existsSync(workerTemp), false);
  assert.equal(existsSync(join(parent, earlier)), true);
  assert.equal(existsSync(join(parent, dead)), true, "a sweep with no table has nothing to judge by");
  assert.doesNotMatch(stderr, /test temp guard/);
  rmSync(join(parent, earlier), { recursive: true });
  rmSync(join(parent, dead), { recursive: true });
});

test("a worker missing from its own table is unjudged, and can still sweep the dead", { skip: !privateParent }, () => {
  const { temp, marker } = scenario();
  const earlier = "unjudged-abc123";
  const dead = `${deadPid()}-abcdef`;
  const { stderr, parent, workerTemp } = runGuardWith("[]", [earlier, dead], env(temp, marker));
  assert.match(basename(workerTemp), /^unjudged-/);
  assert.equal(existsSync(workerTemp), false);
  assert.equal(existsSync(join(parent, earlier)), true);
  assert.equal(existsSync(join(parent, dead)), false);
  assert.match(stderr, /test temp guard: removed 1 temp dir\(s\)/);
  rmSync(join(parent, earlier), { recursive: true });
});

test("a child still writing to the temp dir is killed before the directory goes", { skip: !supported }, () => {
  const { temp, marker } = scenario();
  // The child recreates its directory for as long as it lives, so removing first would lose: the
  // leak guard only kills it afterwards, and by then the worker's temp dir is back.
  const file = fixture(
    "outliving-child.test.mjs",
    `import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
writeFileSync(process.env.FIXTURE_MARKER, process.env.TMPDIR);
const churn = join(tmpdir(), "churn");
test("leaves a child running", async () => {
  const recreate = 'setInterval(() => require("node:fs").mkdirSync(process.argv[1], { recursive: true }), 5)';
  spawn(process.execPath, ["-e", recreate, churn], { detached: true, stdio: "ignore" }).unref();
  while (!existsSync(churn)) await new Promise((resolve) => setTimeout(resolve, 5));
});
`,
  );
  const result = runTestFile(file, env(temp, marker));
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /test leak guard: this test file left 1 process\(es\) running; killed:/);
  assert.equal(existsSync(readFileSync(marker, "utf8")), false);
  assert.deepEqual(entriesLeftIn(temp), []);
});

test("a temp dir that cannot be removed fails neither its file nor the next worker", { skip: !supported || process.geteuid?.() === 0 }, (t) => {
  const { temp, marker } = scenario();
  const file = fixture(
    "undeletable.test.mjs",
    `import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
writeFileSync(process.env.FIXTURE_MARKER, process.env.TMPDIR);
const locked = join(tmpdir(), "locked");
mkdirSync(locked);
writeFileSync(join(locked, "held"), "");
chmodSync(locked, 0o500);
test("passes", () => {});
`,
  );
  const result = runTestFile(file, env(temp, marker));
  const workerTemp = readFileSync(marker, "utf8");
  const locked = join(workerTemp, "locked");
  // Before any assertion, or a failure here leaves what the suite's own cleanup cannot remove.
  t.after(() => {
    chmodSync(locked, 0o700);
    rmSync(workerTemp, { recursive: true, force: true });
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const next = runBriefWorker(env(temp, `${marker}-next`));
  assert.equal(next.status, 0, next.stderr);
  assert.doesNotMatch(next.stderr, new RegExp(basename(workerTemp)));
  assert.equal(existsSync(join(locked, "held")), true);
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
  const compiled = join(base, `tsx-${USER}`, "compiled");
  assert.equal(readFileSync(compiled, "utf8"), "kept");
  rmSync(compiled);
});

test("a symlink at the private parent's name is refused before anything is deleted", { skip: !privateParent }, () => {
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

test("a private parent owned by another user is refused before anything is deleted", { skip: !privateParent }, () => {
  const { temp, marker } = scenario();
  const stale = `${deadPid()}-abcdef`;
  // `temp-guard.mjs` reads the user for the parent's name at import and for the check at each
  // call, so this keeps the same directory and makes its owner someone else.
  const script = fixture(
    "foreign-parent.mjs",
    `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { armTempGuard, openTempParent } from ${JSON.stringify(TEMP_GUARD)};
const { parent } = openTempParent();
mkdirSync(join(parent, ${JSON.stringify(stale)}));
writeFileSync(process.env.FIXTURE_MARKER, parent);
const self = process.geteuid();
process.geteuid = () => self + 1;
armTempGuard(openTempParent(), []);
`,
  );
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: env(temp, marker), timeout: 60_000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is not a directory owned by this user/);
  assert.equal(existsSync(join(readFileSync(marker, "utf8"), stale)), true);
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

test("MISSION_TEST_TEMP_REPORT counts the entries of one prefix together", { skip: !supported }, () => {
  const { temp, marker } = scenario();
  const file = fixture(
    "twins.test.mjs",
    `import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
mkdtempSync(join(tmpdir(), "fixture-twin-"));
mkdtempSync(join(tmpdir(), "fixture-twin-"));
test("passes", () => {});
`,
  );
  const result = runTestFile(file, env(temp, marker, { MISSION_TEST_TEMP_REPORT: "1" }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /twins\.test\.mjs left 2 entries: fixture-twin-\* \(2\)/);
});

test("MISSION_TEST_TEMP_REPORT says nothing about a file that left nothing", { skip: !supported }, () => {
  const { temp, marker } = scenario();
  const file = fixture("tidy.test.mjs", `import test from "node:test";\ntest("passes", () => {});\n`);
  const result = runTestFile(file, env(temp, marker, { MISSION_TEST_TEMP_REPORT: "1" }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, / left \d+ entries/);
});

test("a file with no report requested prints nothing about what it left", { skip: !supported }, () => {
  const { temp, marker } = scenario();
  const childEnv = env(temp, marker);
  delete childEnv.MISSION_TEST_TEMP_REPORT;
  const result = runTestFile(CLEAN_FILE, childEnv);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, / left \d+ entries/);
});
