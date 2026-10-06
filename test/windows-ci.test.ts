/**
 * The Windows CI jobs in `.github/workflows/ci.yml` (D15, D30, D32 in
 * `docs/plans/windows-support/plan.md`): which events run them, what every job sets up, how
 * they are allowed to fail until M2 is green, and that they leave the Linux jobs and
 * `CI result` alone.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { isWindowsJob, jobs, needs } from "./helpers/ci-workflow.ts";

const WORKFLOW = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const ALL = jobs(WORKFLOW);
const WINDOWS = new Map([...ALL].filter(([, body]) => isWindowsJob(body)));
const WINDOWS_IDS = [
  "dependencies-windows",
  "typecheck-windows",
  "unit-windows",
  "build-windows",
  "native-probes-windows",
  "e2e-windows",
];
const ALLOWED_TO_FAIL = "continue-on-error: ${{ env.MISSION_WINDOWS_CI_ALLOWED_TO_FAIL == 'true' }}";
const GIT_BASH = "npm_config_script_shell: 'C:\\Program Files\\Git\\bin\\bash.exe'";

/** One job key's scalar value at the job's own indent. */
function jobValue(body: string, key: string): string | null {
  return body.match(new RegExp(`^ {4}${key}:[ \\t]*(.+?)[ \\t]*$`, "m"))?.[1] ?? null;
}

/** The job's steps, each from its `- name:` line to the next. */
function steps(body: string): string[] {
  return body.split(/^(?= {6}- name: )/m).slice(1);
}

function shards(body: string): number[] | undefined {
  return body.match(/^ {8}shard: \[([^\]]+)\]/m)?.[1]?.split(",").map(Number);
}

/**
 * Evaluates the Windows `if:` for one event, through the JavaScript operators it shares.
 * `base_ref` is GitHub's empty string on every event but a pull request, and `changes` answers
 * `docs_only=false` for every event but a pull request.
 */
function windowsJobsRun(
  event: { event_name: string; ref: string; base_ref?: string },
  docsOnly = false,
): boolean {
  const condition = jobValue(WINDOWS.get("unit-windows")!, "if")!;
  const changes = { outputs: { docs_only: String(docsOnly) } };
  return new Function("github", "needs", `return (${condition});`)({ base_ref: "", ...event }, { changes });
}

test("pushes to main and release/windows run CI, and every pull request does", () => {
  const on = WORKFLOW.slice(WORKFLOW.indexOf("\non:\n"), WORKFLOW.indexOf("\nconcurrency:"));
  assert.match(on, /^ {2}push:\n {4}branches: \[main, release\/windows\]$/m);
  assert.match(on, /^ {2}pull_request:$/m, "pull_request runs for every base branch");
  assert.doesNotMatch(on, /^ {4}branches-ignore:|^ {4}paths/m);
});

test("the Windows jobs are exactly the planned set, on windows-latest with Node 24", () => {
  assert.deepEqual([...WINDOWS.keys()], WINDOWS_IDS);
  for (const [id, body] of WINDOWS) {
    const versions = [...body.matchAll(/node-version: '(\d+)'/g)].map(([, v]) => v);
    assert.ok(versions.length > 0, `${id} sets up Node`);
    assert.deepEqual(new Set(versions), new Set(["24"]), `${id} runs Node 24 only (D32)`);
    assert.ok(body.includes(`      ${GIT_BASH}\n`), `${id} sets npm's script-shell to Git Bash (D30)`);
    assert.match(body, /^ {4}defaults:\n {6}run:\n {8}shell: bash$/m, `${id} runs its steps in bash`);
    assert.match(body, /^ {4}timeout-minutes: \d+$/m, `${id} has a timeout`);
  }
});

test("they run for a push, manual run or pull request on release/windows, and nowhere else", () => {
  const conditions = new Set([...WINDOWS.values()].map((body) => jobValue(body, "if")));
  assert.equal(conditions.size, 1, "every Windows job carries the same condition");
  for (const [id, body] of WINDOWS) {
    assert.ok(needs(body).includes("changes"), `${id} needs changes, which its condition reads`);
  }

  assert.equal(windowsJobsRun({ event_name: "push", ref: "refs/heads/release/windows" }), true);
  assert.equal(windowsJobsRun({ event_name: "workflow_dispatch", ref: "refs/heads/release/windows" }), true);
  assert.equal(
    windowsJobsRun({ event_name: "pull_request", ref: "refs/pull/7/merge", base_ref: "release/windows" }),
    true,
    "a pull request into release/windows shows its Windows result before it merges",
  );
  assert.equal(windowsJobsRun({ event_name: "pull_request", ref: "refs/pull/7/merge", base_ref: "main" }), false);
  assert.equal(
    windowsJobsRun({ event_name: "pull_request", ref: "refs/pull/7/merge", base_ref: "release/windows" }, true),
    false,
    "a docs-only pull request into release/windows skips them",
  );
  assert.doesNotMatch(conditions.values().next().value!, /tree_reused/, "tree reuse applies only to a push to main");
  assert.equal(windowsJobsRun({ event_name: "push", ref: "refs/heads/main" }), false);
  assert.equal(windowsJobsRun({ event_name: "push", ref: "refs/tags/v1.2.3" }), false);
});

test("each product step is allowed to fail through one switch, and the job reports it", () => {
  for (const [id, body] of WINDOWS) {
    if (id === "dependencies-windows") {
      assert.doesNotMatch(body, /continue-on-error/, "provisioning is never allowed to fail");
      continue;
    }
    assert.match(body, /^ {6}MISSION_WINDOWS_CI_ALLOWED_TO_FAIL: 'true'$/m, `${id} is allowed to fail`);
    assert.doesNotMatch(
      body,
      /^ {4}continue-on-error:/m,
      `${id} must not continue on error as a job: its failed check would fail Wait for CI`,
    );
    const all = steps(body);
    const allowed = all.filter((step) => step.includes("continue-on-error"));
    assert.ok(allowed.length > 0, `${id} has a step that is allowed to fail`);
    let stepMinutes = 0;
    for (const step of allowed) {
      assert.ok(step.includes(`        ${ALLOWED_TO_FAIL}\n`), `${id}: ${step.split("\n")[0]}`);
      assert.match(step, /^ {8}id: \w+$/m, `${id}: an allowed step needs an id to be reported`);
      const minutes = step.match(/^ {8}timeout-minutes: (\d+)$/m)?.[1];
      assert.ok(minutes, `${id}: ${step.split("\n")[0]} needs its own timeout, or a hang times out the job`);
      stepMinutes += Number(minutes);
    }
    assert.ok(
      stepMinutes + 10 <= Number(jobValue(body, "timeout-minutes")),
      `${id}'s timeout leaves ten minutes of provisioning beyond its steps' ${stepMinutes}`,
    );
    const last = all.at(-1)!;
    assert.match(last, /^ {6}- name: Report allowed failures$/m, `${id} ends with the report`);
    assert.match(last, /^ {8}if: \$\{\{ !cancelled\(\) \}\}$/m);
    assert.match(last, /STEPS_JSON: \$\{\{ toJSON\(steps\) \}\}/);
    assert.match(last, /run: node scripts\/ci-allowed-failures\.mjs$/m);
  }
  assert.ok(existsSync(new URL("../scripts/ci-allowed-failures.mjs", import.meta.url)));
});

test("they cover typecheck, the sharded unit suite, build plus smoke, and e2e", () => {
  const run = (id: string) => [...WINDOWS.get(id)!.matchAll(/^ {8}run: (.+)$/gm)].map(([, cmd]) => cmd!);
  assert.ok(run("typecheck-windows").includes("npm run typecheck"));
  const stages = run("unit-windows").filter((cmd) => /^npm (run (--silent )?)?(pretest|test:run|posttest)\b/.test(cmd));
  assert.equal(stages.length, 3, "the unit shard runs all three stages of npm test");
  assert.equal(stages[0], "npm run pretest");
  assert.ok(stages[1]!.startsWith("npm run --silent test:run -- "), "the middle stage is npm test's own test:run");
  assert.equal(stages[2], "npm run posttest");
  assert.match(WINDOWS.get("unit-windows")!, /MISSION_TEST_SHARD: \$\{\{ matrix\.shard \}\}\/3$/m);
  assert.deepEqual(shards(WINDOWS.get("unit-windows")!), shards(ALL.get("unit-node-24")!));
  assert.ok(run("build-windows").includes("npm run build"));
  assert.ok(run("build-windows").includes("npm run smoke"));
  assert.ok(run("e2e-windows").includes("npm run build"));
  const e2e = run("e2e-windows").find((cmd) => cmd.startsWith("npm run test:e2e"));
  assert.ok(e2e, "the e2e job runs the Playwright suite");
  assert.ok(e2e.startsWith("npm run test:e2e -- --shard=${{ matrix.shard }}/${{ strategy.job-total }} "));
  assert.ok(e2e.includes(" --retries=0"), "an allowed-to-fail run has no flake report for a retry to feed");
  // Playwright must stop on its own before the step's timeout kills it: a killed shard reports
  // nothing, and on run 37505044919 the runner was lost as the step was torn down.
  const globalMs = Number(e2e.match(/ --global-timeout=(\d+)(?: |$)/)?.[1]);
  const step = steps(WINDOWS.get("e2e-windows")!).find((s) => s.includes("        id: e2e\n"))!;
  const stepMinutes = Number(step.match(/^ {8}timeout-minutes: (\d+)$/m)?.[1]);
  assert.ok(globalMs > 0, "the e2e run sets a global timeout");
  assert.ok(
    globalMs <= (stepMinutes - 5) * 60_000,
    `the ${globalMs / 60_000}-minute global timeout leaves five minutes inside the ${stepMinutes}-minute step`,
  );
  assert.deepEqual(shards(WINDOWS.get("e2e-windows")!), shards(ALL.get("e2e")!));
});

test("the native probes run the state-lock specs and the Keep Awake verification", () => {
  const body = WINDOWS.get("native-probes-windows")!;
  const specs = ["test/native-state-lock-provisioning.test.ts", "test/daemon-state-ownership.test.ts"];
  for (const spec of specs) {
    assert.ok(body.includes(` ${spec}`), `the probe runs ${spec}`);
    assert.ok(existsSync(new URL(`../${spec}`, import.meta.url)), `${spec} exists`);
  }
  assert.match(body, /run: node --test --import \.\/test\/setup-state\.mjs --import tsx test\//);
  assert.match(body, /^ {8}run: npm run verify:keep-awake-native$/m);
});

test("CI result and the flake report ignore them until they are required", () => {
  for (const id of ["ci-result", "flake-report"]) {
    const required = needs(ALL.get(id)!);
    assert.deepEqual(required.filter((need) => WINDOWS.has(need)), [], `${id} does not need a Windows job`);
  }
  for (const [id, body] of WINDOWS) {
    assert.doesNotMatch(body, /name: flake-report-/, `${id} uploads no flake report`);
    assert.doesNotMatch(body, /mission-flake-report/, `${id} does not classify flakes`);
  }
  for (const [id, body] of ALL) {
    if (WINDOWS.has(id)) continue;
    assert.deepEqual(
      needs(body).filter((need) => WINDOWS.has(need)),
      [],
      `${id} does not wait on a Windows job`,
    );
  }
});

test("every unit shard finishes inside its step, so it prints its summary and JUnit", () => {
  const body = WINDOWS.get("unit-windows")!;
  const step = steps(body).find((s) => s.includes("        id: test\n"))!;
  const command = step.match(/^ {8}run: (.+)$/m)![1]!;
  const stepMs = Number(step.match(/^ {8}timeout-minutes: (\d+)$/m)?.[1]) * 60_000;

  // The same files and shard as `npm test`, which runs the same `test:run`.
  const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
  const glob = scripts.test.match(/('[^']+\*\.test\.ts')$/)?.[1];
  assert.ok(glob && command.endsWith(` ${glob}`), "the shard runs npm test's glob");
  assert.ok(command.includes(' --test-shard="$MISSION_TEST_SHARD" '));
  assert.ok(command.includes(' --test-concurrency="$MISSION_TEST_CONCURRENCY" '));
  // The step expands those itself, no longer inside npm's script-shell, so it must run in bash
  // (pwsh, the windows-latest default, would pass `--test-shard=`) and both must be set.
  const stepShell = step.match(/^ {8}shell: (\S+)$/m)?.[1];
  const jobShell = body.match(/^ {4}defaults:\n {6}run:\n {8}shell: (\S+)$/m)?.[1];
  assert.equal(stepShell ?? jobShell, "bash", "the Test step runs in bash");
  assert.match(step, /^ {10}MISSION_TEST_SHARD: \$\{\{ matrix\.shard \}\}\/3$/m);
  assert.match(body, /^ {6}MISSION_TEST_CONCURRENCY: '\d+'$/m, "the job sets the concurrency the step expands");

  // A hung test fails sooner than test:run's own bound, and so names itself sooner.
  const linuxMs = Number(scripts["test:run"].match(/--test-timeout=(\d+)/)?.[1]);
  const testMs = Number(command.match(/ --test-timeout=(\d+) /)?.[1]);
  assert.ok(testMs > 0 && testMs < linuxMs, `the Windows per-test timeout ${testMs} is below test:run's ${linuxMs}`);
  // A file whose leaked handles outlive its tests exits, and one that will not is ended.
  assert.ok(command.includes(" --test-force-exit "));
  assert.ok(command.includes(" --import ./test/file-watchdog.mjs "));
  assert.ok(existsSync(new URL("./file-watchdog.mjs", import.meta.url)));
  const budgetMs = Number(step.match(/^ {10}MISSION_TEST_FILE_BUDGET_MS: '(\d+)'$/m)?.[1]);
  assert.ok(budgetMs > testMs && budgetMs < stepMs, `the ${budgetMs} ms file budget sits inside the step`);
});

test("the unit and e2e shards upload JUnit that Linux shard timings never read", () => {
  // The pattern `npm run test:timings` downloads and parses, read from the script itself.
  const timings = readFileSync(new URL("../scripts/unit-shard-timings.ts", import.meta.url), "utf8");
  const linuxArtifact = new RegExp(timings.match(/^const ARTIFACT = \/(.+)\/;$/m)![1]!);
  assert.ok(linuxArtifact.test("unit-junit-node-24-shard-1"), "the timings pattern was read");
  const cases = [
    ["unit-windows", "MISSION_TEST_JUNIT", "windows-unit-junit-shard-"],
    ["e2e-windows", "MISSION_PLAYWRIGHT_JUNIT", "windows-e2e-junit-shard-"],
  ] as const;
  for (const [id, variable, artifact] of cases) {
    const body = WINDOWS.get(id)!;
    const path = body.match(new RegExp(`^ {10}${variable}: (.+)$`, "m"))?.[1];
    assert.ok(path, `${id} writes JUnit through ${variable}`);
    const upload = steps(body).find((s) => s.includes(`name: ${artifact}\${{ matrix.shard }}`));
    assert.ok(upload, `${id} uploads ${artifact}<n>`);
    assert.ok(upload.includes(`path: ${path}\n`), `${id} uploads the file it wrote`);
    assert.match(upload, /^ {8}if: \$\{\{ !cancelled\(\)/m, `${id} uploads after a failed run too`);
    assert.ok(!linuxArtifact.test(`${artifact}1`), `test:timings never reads ${artifact}<n>`);
  }
  const config = readFileSync(new URL("../e2e/playwright.config.ts", import.meta.url), "utf8");
  assert.match(config, /\["junit", \{ outputFile: process\.env\.MISSION_PLAYWRIGHT_JUNIT \}\]/, "Playwright writes JUnit where the job uploads it from");
});
