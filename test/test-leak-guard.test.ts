import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

// The leak guard in `test/leak-guard.mjs`, pinned through real processes under the real
// preload: a fixture test file run by a nested `node --test`, and plain scripts that load the
// preload with `NODE_TEST_CONTEXT` set, which is exactly what makes a process a test worker to
// it. Nothing here is stubbed, because what the guard reads is other processes' environments.

const PRELOAD = fileURLToPath(new URL("./setup-state.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "mission-leak-guard-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const supported = process.platform === "darwin" || process.platform === "linux";

function fixture(name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source, "utf8");
  return path;
}

// Each fixture imports `spawn` itself; this is the statement that leaks.
const SPAWN_ESCAPED = `
const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
escaped.unref();
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

function kill(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** A nested `node --test` over one fixture file, as `npm test` would run it. */
function runTestFile(file: string) {
  // The runner skips every file when it believes it is already inside one, so the outer
  // worker's context is not passed on. Its own worker gets one from the runner, as usual.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ["--test", "--test-reporter=spec", "--import", PRELOAD, file], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

/** Plain node with the preload, believing it is a test worker. */
function workerArgs(script: string): [string, string[], { env: NodeJS.ProcessEnv }] {
  return [process.execPath, ["--import", PRELOAD, script], { env: { ...process.env, NODE_TEST_CONTEXT: "child" } }];
}

/** A worker that spawns one detached tagged child, reports both pids, and stays alive. */
async function startHoldingWorker(): Promise<{ worker: ChildProcess; child: number }> {
  const script = fixture(
    "hold.mjs",
    `import { spawn } from "node:child_process";
${SPAWN_ESCAPED}
process.stdout.write(JSON.stringify({ child: escaped.pid }) + "\\n");
setInterval(() => {}, 1000);
`,
  );
  const [command, args, options] = workerArgs(script);
  const worker = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "inherit"] });
  let buffered = "";
  for await (const chunk of worker.stdout!) {
    buffered += chunk;
    if (buffered.includes("\n")) break;
  }
  return { worker, child: (JSON.parse(buffered) as { child: number }).child };
}

test("a test file that leaks a detached grandchild and exits normally fails, and the grandchild is killed", { skip: !supported }, async (t) => {
  const pidFile = join(dir, "leaked.pid");
  const recorded = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : undefined);
  t.after(() => kill(recorded()));
  const file = fixture(
    "leaks.test.mjs",
    `import test from "node:test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
test("passes, but forgets its child", () => {
  ${SPAWN_ESCAPED}
  writeFileSync(${JSON.stringify(pidFile)}, String(escaped.pid));
});
`,
  );

  const result = runTestFile(file);
  const output = `${result.stdout}\n${result.stderr}`;
  const leaked = recorded();
  assert.ok(leaked, `the fixture should have recorded its child: ${output}`);

  assert.notEqual(result.status, 0, `a leaking file must fail: ${output}`);
  assert.match(output, /this test file left 1 process\(es\) running; killed:/);
  assert.match(output, new RegExp(`pid ${leaked}: .*setInterval`));
  assert.equal(await gone(leaked!), true, "the leaked grandchild should be dead");
});

test("a test file that waits for its own child passes", { skip: !supported }, () => {
  const file = fixture(
    "tidy.test.mjs",
    `import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
test("cleans up", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  child.kill("SIGKILL");
  await once(child, "exit");
});
`,
  );

  const result = runTestFile(file);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /test leak guard/);
});

/**
 * Start a fresh worker and check that it reaped and reported `orphan`. False when the orphan
 * was already gone without this worker reporting it, which happens legitimately: every worker
 * start on this machine reaps stale tags, so one of a concurrent suite can get there first.
 * That is the guard working but says nothing about THIS worker, so callers retry. An orphan
 * that survives the next worker is a failure.
 */
async function nextWorkerReaps(orphan: number): Promise<boolean> {
  const [command, args, options] = workerArgs(fixture("noop.mjs", ""));
  const next = spawnSync(command, args, { ...options, encoding: "utf8", timeout: 30_000 });
  if (!next.stderr.includes(`pid ${orphan}:`)) {
    assert.equal(alive(orphan), false, `the next worker should have reaped the orphan: ${next.stderr}`);
    return false;
  }
  assert.equal(next.status, 0, "an earlier run's leak is reported, not failed");
  assert.match(next.stderr, /leaked by an earlier test run/);
  assert.equal(await gone(orphan), true, "the orphan should be dead");
  return true;
}

test("a killed worker's leak is reaped and reported by the next worker, and a live worker's child survives", { skip: !supported }, async (t) => {
  const pids: (number | undefined)[] = [];
  t.after(() => pids.forEach(kill));

  const live = await startHoldingWorker();
  pids.push(live.child, live.worker.pid);

  let reported = false;
  for (let attempt = 0; attempt < 3 && !reported; attempt++) {
    const killed = await startHoldingWorker();
    pids.push(killed.child, killed.worker.pid);
    const exited = new Promise((resolve) => killed.worker.once("exit", resolve));
    killed.worker.kill("SIGKILL");
    await exited;
    if (!alive(killed.child)) continue;
    reported = await nextWorkerReaps(killed.child);
  }

  assert.equal(reported, true, "the next worker should have reported the killed worker's orphan");
  assert.equal(alive(live.child), true, "a concurrently live worker's child must survive");
  assert.equal(alive(live.worker.pid!), true);
});

test("a tag whose worker pid is alive but started at another time is stale, so its process is reaped", { skip: !supported }, async (t) => {
  // The start time is in the tag for PID reuse: the pid of a dead worker can belong to an
  // unrelated live process by the next run. This process stands in for one, alive the whole
  // time, so only a start-time comparison can tell the tag is not its.
  const pids: number[] = [];
  t.after(() => pids.forEach(kill));

  let reported = false;
  for (let attempt = 0; attempt < 3 && !reported; attempt++) {
    const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, MISSION_TEST_LEAK_TAG: `${process.pid}:not-this-process-start` },
    });
    orphan.unref();
    pids.push(orphan.pid!);
    await once(orphan, "spawn");
    reported = await nextWorkerReaps(orphan.pid!);
  }

  assert.equal(reported, true, "the next worker should have reported the reused-pid orphan");
});
