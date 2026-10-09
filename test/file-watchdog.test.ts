/**
 * `test/file-watchdog.mjs`, the per-file budget the Windows unit job runs under: a file whose
 * event loop is blocked is ended and named, and the run still finishes with its summary and its
 * JUnit, which is what a step timeout throws away.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A URL, not a path: `--import` resolves its argument as a module specifier, and on win32 an
// absolute path like `C:\...` reads as a URL with the scheme `c:`, which Node refuses.
const WATCHDOG = new URL("./file-watchdog.mjs", import.meta.url).href;

test("a file that outlives its budget is ended and named, and the run still reports", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mission-file-watchdog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Blocked, not merely slow: no timer on its main thread can fire, so `--test-timeout` cannot
  // end it. Bounded, so a broken watchdog leaves nothing spinning once this test gives up.
  const blocked = join(dir, "blocked.test.mjs");
  writeFileSync(
    blocked,
    `import test from "node:test";\n` +
      `test("blocks its event loop", () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000); });\n`,
  );
  const quick = join(dir, "quick.test.mjs");
  writeFileSync(quick, `import test from "node:test";\ntest("finishes inside the budget", () => {});\n`);
  const junit = join(dir, "junit.xml");

  // This process is itself a test file; without the context removed the nested runner would
  // report to it instead of running as a runner.
  const env: NodeJS.ProcessEnv = { ...process.env, MISSION_TEST_FILE_BUDGET_MS: "2000" };
  delete env.NODE_TEST_CONTEXT;
  const started = Date.now();
  const run = await new Promise<{ code: number | null; output: string }>((resolve) => {
    execFile(
      process.execPath,
      [
        "--test",
        "--test-force-exit",
        "--import",
        WATCHDOG,
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        "--test-reporter=junit",
        `--test-reporter-destination=${junit}`,
        blocked,
        quick,
      ],
      { env, timeout: 45_000, encoding: "utf8" },
      (error, stdout, stderr) => resolve({ code: error ? (error.code as number | null) ?? null : 0, output: stdout + stderr }),
    );
  });

  assert.ok(Date.now() - started < 30_000, `the run ended at the budget, not at the fixture's 60 s:\n${run.output}`);
  assert.equal(run.code, 1, run.output);
  assert.match(run.output, /file watchdog: .*blocked\.test\.mjs was still running after 2000 ms, so it was ended/);
  const xml = readFileSync(junit, "utf8");
  assert.match(xml, /<testcase name="[^"]*blocked\.test\.mjs"[^>]*failure=/, "the blocked file is a named failure");
  assert.match(xml, /<testcase name="finishes inside the budget"[^>]*\/>/, "a file inside its budget is untouched");
});
