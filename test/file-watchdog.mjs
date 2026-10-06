// End a `node --test` file that outlives its budget, and say which file it was.
//
// `--test-timeout` bounds one test, never a file, and it cannot fire at all while the file's
// event loop is blocked. A file that never exits therefore holds its runner until the CI step's
// own timeout kills the whole run, and a killed run prints no summary and writes no JUnit. On
// Windows run 37522217862 that took two of three unit shards silently to their 60-minute limit.
//
// Opt-in through `MISSION_TEST_FILE_BUDGET_MS`, which only the Windows unit job sets. The timer
// runs on a worker thread so a blocked main thread cannot hold it back, and the process is
// killed rather than exited so nothing on the main thread has to cooperate. The runner then
// reports the file as failed, by name, and moves on to the next one.
//
// Plain `.mjs` with only Node built-ins, for the reason `setup-state.mjs` gives.

import { Worker } from "node:worker_threads";

const budgetMs = Number(process.env.MISSION_TEST_FILE_BUDGET_MS);

// Test processes only, the scope `setup-state.mjs` uses: the runner sets `NODE_TEST_CONTEXT` in
// each file it spawns, and its own process must never be the one killed.
if (process.env.NODE_TEST_CONTEXT && budgetMs > 0) {
  new Worker(
    `
    const { workerData } = require("node:worker_threads");
    const { writeSync } = require("node:fs");
    setTimeout(() => {
      writeSync(2, \`file watchdog: \${workerData.file} was still running after \${workerData.budgetMs} ms, so it was ended\\n\`);
      process.kill(workerData.pid, "SIGKILL");
    }, workerData.budgetMs);
    `,
    { eval: true, workerData: { pid: process.pid, file: process.argv[1], budgetMs } },
  ).unref();
}
