import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = join(import.meta.dirname, "..");
const script = join(repo, "scripts", "init.mjs");

test("CI uses ephemeral GitHub-hosted runners at their bounded capacities", async () => {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const workflow = readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8");
  const unitAction = readFileSync(
    join(repo, ".github", "actions", "run-unit-shard", "action.yml"),
    "utf8",
  );
  const testCommand = pkg.scripts.test ?? "";
  const unitShardOption = "${MISSION_TEST_SHARD:+--test-shard=$MISSION_TEST_SHARD}";
  const unitTestPattern = "'test/**/*.test.ts'";
  const jobs = Object.fromEntries(
    [
      ...workflow.matchAll(
        /^([ \t]*)(dependencies(?:-node-(?:24|26))?|gates|build-smoke-node-(?:24|26)|unit(?:-node-(?:24|26))?|e2e|package):[ \t]*\r?\n([\s\S]*?)(?=^\1(?![ \t])[a-zA-Z][\w-]*:[ \t]*(?:\r?\n|$)|(?![\s\S]))/gm,
      ),
    ].map(([, , job, body]) => [job, body]),
  );
  const capture = (source: string | undefined, pattern: RegExp) =>
    source?.match(pattern)?.[1] ?? null;
  const jobValue = (job: string, key: string) =>
    capture(
      jobs[job],
      new RegExp(`^[ \\t]+${key}:[ \\t]*(.+?)[ \\t]*$`, "m"),
    );
  const runner = (job: string) => ({
    scalar: jobValue(job, "runs-on"),
    group: capture(jobs[job], /^[ \t]+group:[ \t]*(.+?)[ \t]*$/m),
    label: capture(jobs[job], /^[ \t]+labels:[ \t]*(.+?)[ \t]*$/m),
  });
  const list = (job: string, key: string) => capture(
    jobs[job],
    new RegExp(`^[ \\t]+${key}:[ \\t]*\\[([^\\]]+)\\]`, "m"),
  )
    ?.split(",")
    .map((value) => value.trim().replaceAll("'", ""));
  const shardList = (job: string) =>
    list(job, "shard")?.map(Number);
  const stepTimeout = (source: string | undefined, step: string) => capture(
    source,
    new RegExp(`- name: ${step}[\\s\\S]*?^[ \\t]+timeout-minutes:[ \\t]*(\\d+)`, "m"),
  );
  const stepNames = (source: string | undefined) =>
    [...(source ?? "").matchAll(/^[ \t]+- name:[ \t]*(.+?)[ \t]*$/gm)].map(([, name]) => name!);
  const unitCallValue = (job: string, key: string) => capture(
    jobs[job],
    new RegExp(`- name: Run unit shard[\\s\\S]*?^[ \\t]+${key}:[ \\t]*(.+?)[ \\t]*$`, "m"),
  );
  // ci.yml's "Shard budget": every job a full pull request runs at once with the shards, matrix
  // legs counted, derived from the job graph rather than a literal, so a new job that runs beside
  // the shards on a pull request raises the count. A job the shards wait for, or one that waits
  // for a shard, is not concurrent with them. Every job is parsed, not just the ones named above. A job's `if:` is evaluated as a full (non-docs, untagged) pull request
  // into `main` would see it; an expression this cannot read throws, which fails the test until it can.
  const allJobs = new Map(
    [...workflow.slice(workflow.indexOf("\njobs:\n")).matchAll(
      /^ {2}([\w-]+):[ \t]*\r?\n([\s\S]*?)(?=^ {2}[\w-]+:|(?![\s\S]))/gm,
    )].map(([, id, body]) => [id!, body!]),
  );
  const needsOf = (body: string) => {
    const inline = capture(body, /^ {4}needs:[ \t]*(.*?)[ \t]*$/m);
    if (inline === null) return [];
    if (inline) return inline.replace(/^\[|\]$/g, "").split(",").map((id) => id.trim());
    return [...(body.split(/^ {4}needs:.*$/m)[1]!.match(/^(?: {6}- [\w-]+\r?\n)+/m)?.[0] ?? "")
      .matchAll(/- ([\w-]+)/g)].map(([, id]) => id!);
  };
  const runsOnFullPullRequest = (body: string) => {
    const condition = capture(body, /^ {4}if:[ \t]*(.+?)[ \t]*$/m);
    if (condition === null) return true;
    const expression = condition
      .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
      .replaceAll("github.event_name", "'pull_request'")
      .replaceAll("github.base_ref", "'main'")
      .replaceAll("github.ref", "'refs/pull/1/merge'")
      .replace(/needs\.changes\.outputs\.\w+/g, "'false'");
    return Boolean(new Function("startsWith", "always", "cancelled", `return (${expression});`)(
      (value: string, prefix: string) => value.startsWith(prefix),
      () => true,
      () => false,
    ));
  };
  const transitiveNeeds = (id: string, found = new Set<string>()): Set<string> => {
    for (const need of needsOf(allJobs.get(id) ?? "")) {
      if (found.has(need)) continue;
      found.add(need);
      transitiveNeeds(need, found);
    }
    return found;
  };
  const shardJobs = ["unit-node-24", "e2e"];
  const beforeShards = new Set(shardJobs.flatMap((id) => [...transitiveNeeds(id)]));
  const afterShards = (id: string) => shardJobs.some((shard) => transitiveNeeds(id).has(shard));
  // A matrix runs the product of its lists at once. A shape this cannot count (`include:`,
  // `exclude:`, a block list, an inline map, an expression) throws, like an unreadable `if:`.
  const matrixLegs = (id: string, body: string) => {
    const matrix = /^( +)matrix:[ \t]*(.*)$/m.exec(body);
    if (!matrix) return 1;
    if (matrix[2]!.trim()) throw new Error(`${id}: cannot count matrix legs from: ${matrix[2]!.trim()}`);
    const nested = body.slice(matrix.index + matrix[0].length).split(/\r?\n/).slice(1);
    const end = nested.findIndex((line) => line.trim() && !line.startsWith(`${matrix[1]} `));
    return nested
      .slice(0, end < 0 ? undefined : end)
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .reduce((legs, line) => {
        const list = /^\s+[\w-]+:[ \t]*\[([^\]]+)\][ \t]*$/.exec(line);
        if (!list) throw new Error(`${id}: cannot count matrix legs from: ${line.trim()}`);
        return legs * list[1]!.split(",").length;
      }, 1);
  };
  const peakJobs = [...allJobs]
    .filter(([id, body]) =>
      runsOnFullPullRequest(body) && !beforeShards.has(id) && !afterShards(id)
    )
    .map(([id, body]) => ({
      id,
      legs: matrixLegs(id, body),
    }));
  const e2eConfigUrl = pathToFileURL(join(repo, "e2e", "playwright.config.ts")).href;
  const previousCi = process.env.CI;
  const previousWorkers = process.env.MISSION_E2E_WORKERS;
  const loadWorkers = async (ci: boolean) => {
    if (ci) process.env.CI = "true";
    else delete process.env.CI;
    delete process.env.MISSION_E2E_WORKERS;

    const config = (await import(
      `${e2eConfigUrl}?capacity-contract=${ci}`
    )).default as { workers?: number };
    return config.workers ?? null;
  };

  let playwrightWorkers: { ci: number | null; local: number | null };
  try {
    playwrightWorkers = {
      ci: await loadWorkers(true),
      local: await loadWorkers(false),
    };
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousWorkers === undefined) delete process.env.MISSION_E2E_WORKERS;
    else process.env.MISSION_E2E_WORKERS = previousWorkers;
  }

  assert.deepEqual(
    {
      runners: {
        dependencies24: runner("dependencies-node-24"),
        dependencies26: runner("dependencies-node-26"),
        gates: runner("gates"),
        buildSmoke24: runner("build-smoke-node-24"),
        buildSmoke26: runner("build-smoke-node-26"),
        unit24: runner("unit-node-24"),
        unit26: runner("unit-node-26"),
        e2e: runner("e2e"),
      },
      hasBlacksmithLabel: /blacksmith/i.test(workflow),
      hasRunnerVariable: /MISSION_CONTROL_CI_RUNNER/.test(workflow),
      hasAggregateDependencyJob: Boolean(jobs.dependencies),
      hasAggregateUnitJob: Boolean(jobs.unit),
      dependencyNodes: [
        jobValue("dependencies-node-24", "node-version"),
        jobValue("dependencies-node-26", "node-version"),
      ],
      dependencyCacheActions: ["dependencies-node-24", "dependencies-node-26"].map((job) =>
        capture(jobs[job], /- name: Cache node_modules[\s\S]*?uses: actions\/cache@(v\d+)/)
      ),
      dependencyInstallConditions: ["dependencies-node-24", "dependencies-node-26"].map((job) =>
        capture(jobs[job], /- name: Install dependencies\r?\n[ \t]+if:[ \t]*(.+?)[ \t]*$/m)
      ),
      dependencyInstallCommands: ["dependencies-node-24", "dependencies-node-26"].map((job) =>
        capture(jobs[job], /- name: Install dependencies[\s\S]*?^[ \t]+run:[ \t]*(.+?)[ \t]*$/m)
      ),
      consumerNeeds: [
        "gates",
        "build-smoke-node-24",
        "build-smoke-node-26",
        "unit-node-24",
        "unit-node-26",
        "e2e",
      ].map((job) => jobValue(job, "needs")),
      // Node 26 never runs on a pull request, and its condition reads nothing else.
      node26Conditions: ["dependencies-node-26", "build-smoke-node-26", "unit-node-26"].map((job) =>
        jobValue(job, "if")
      ),
      buildSmokeNodes: ["build-smoke-node-24", "build-smoke-node-26"].map((job) =>
        jobValue(job, "node-version")
      ),
      buildSmokeSteps: ["build-smoke-node-24", "build-smoke-node-26"].map((job) =>
        stepNames(jobs[job]).slice(stepNames(jobs[job]).indexOf("Build"))
      ),
      // E2E tests the `dist/` that `build-smoke-node-24` built and smoked, never its own.
      e2eDistSteps: stepNames(jobs.e2e).filter((name) => /dist|^Build$/.test(name)),
      distArtifact: [["build-smoke-node-24", "upload"], ["e2e", "download"]].map(([job, verb]) =>
        capture(jobs[job!], new RegExp(`uses: actions/${verb}-artifact@v\\d+\\s+with:\\s+name:[ \\t]*(.+?)[ \\t]*$`, "m"))
      ),
      // A rerun of a failed E2E shard downloads the original attempt's `dist/`.
      distRetentionDays: capture(
        jobs["build-smoke-node-24"],
        /name: dist-node-24[\s\S]*?retention-days:[ \t]*(\d+)/,
      ),
      unitActionBuildsOrSmokes: stepNames(unitAction).some((name) => /build$|smoke/i.test(name)),
      consumerRestores: [
        jobs.gates,
        jobs["build-smoke-node-24"],
        jobs["build-smoke-node-26"],
        unitAction,
        jobs.e2e,
      ].map((source) => ({
        action: capture(source, /- name: Restore node_modules[\s\S]*?uses: (actions\/cache\/restore@v\d+)/),
        failOnMiss: capture(source, /^[ \t]+fail-on-cache-miss:[ \t]*(.+?)[ \t]*$/m),
        repeatsInstall: /- name: Install dependencies/.test(source ?? ""),
      })),
      cacheActionVersions: [
        ...`${workflow}\n${unitAction}`.matchAll(/uses: actions\/cache@(v\d+)/g),
      ].map(([, version]) => version),
      unitWorkers: ["unit-node-24", "unit-node-26"].map((job) =>
        jobValue(job, "MISSION_TEST_CONCURRENCY")
      ),
      unitShardTotals: ["unit-node-24", "unit-node-26"].map((job) =>
        jobValue(job, "MISSION_TEST_SHARDS")
      ),
      unitShards: ["unit-node-24", "unit-node-26"].map(shardList),
      unitActionUses: ["unit-node-24", "unit-node-26"].map((job) =>
        unitCallValue(job, "uses")
      ),
      unitActionNodes: ["unit-node-24", "unit-node-26"].map((job) =>
        unitCallValue(job, "node-version")
      ),
      unitActionTotals: ["unit-node-24", "unit-node-26"].map((job) =>
        unitCallValue(job, "shard-total")
      ),
      unitShardEnv: capture(
        unitAction,
        /^[ \t]+MISSION_TEST_SHARD:[ \t]*(.+?)[ \t]*$/m,
      ),
      unitTestTimeout: stepTimeout(unitAction, "Test"),
      e2eWorkerVariable: jobValue("e2e", "MISSION_E2E_WORKERS"),
      e2eShards: shardList("e2e"),
      // GitHub Free runs at most 20 jobs at once per account; see ci.yml's "Shard budget".
      pullRequestPeakJobIds: peakJobs.map(({ id }) => id),
      pullRequestPeakJobs: peakJobs.reduce((total, { legs }) => total + legs, 0),
      e2eTestTimeout: stepTimeout(jobs.e2e, "End-to-end tests"),
      localUnitWorkers:
        testCommand.match(
          /--test-concurrency=\$\{MISSION_TEST_CONCURRENCY:-(\d+)\}/,
        )?.[1] ?? null,
      unitShardOption:
        testCommand.includes(unitShardOption) ? unitShardOption : null,
      unitShardOptionPrecedesPattern:
        testCommand.indexOf(unitShardOption) >= 0
        && testCommand.indexOf(unitShardOption) < testCommand.indexOf(unitTestPattern),
      playwrightWorkers,
    },
    {
      runners: {
        dependencies24: { scalar: "ubuntu-latest", group: null, label: null },
        dependencies26: { scalar: "ubuntu-latest", group: null, label: null },
        gates: { scalar: "ubuntu-latest", group: null, label: null },
        buildSmoke24: { scalar: "ubuntu-latest", group: null, label: null },
        buildSmoke26: { scalar: "ubuntu-latest", group: null, label: null },
        unit24: { scalar: "ubuntu-latest", group: null, label: null },
        unit26: { scalar: "ubuntu-latest", group: null, label: null },
        e2e: { scalar: "ubuntu-latest", group: null, label: null },
      },
      hasBlacksmithLabel: false,
      hasRunnerVariable: false,
      hasAggregateDependencyJob: false,
      hasAggregateUnitJob: false,
      dependencyNodes: ["'24'", "'26'"],
      dependencyCacheActions: ["v5", "v5"],
      dependencyInstallConditions: [
        "steps.dependencies.outputs.cache-hit != 'true'",
        "steps.dependencies.outputs.cache-hit != 'true'",
      ],
      dependencyInstallCommands: [
        "npm ci --prefer-offline --no-audit --no-fund",
        "npm ci --prefer-offline --no-audit --no-fund",
      ],
      consumerNeeds: [
        "[changes, dependencies-node-24]",
        "[changes, dependencies-node-24]",
        "dependencies-node-26",
        "[changes, dependencies-node-24]",
        "dependencies-node-26",
        "[changes, dependencies-node-24, build-smoke-node-24]",
      ],
      node26Conditions: [
        "github.event_name != 'pull_request'",
        "github.event_name != 'pull_request'",
        "github.event_name != 'pull_request'",
      ],
      buildSmokeNodes: ["'24'", "'26'"],
      buildSmokeSteps: [
        ["Build", "Smoke the built bundles", "Pack dist for E2E", "Upload dist for E2E"],
        ["Build", "Smoke the built bundles"],
      ],
      e2eDistSteps: ["Download dist", "Unpack dist"],
      distArtifact: ["dist-node-24", "dist-node-24"],
      distRetentionDays: "7",
      unitActionBuildsOrSmokes: false,
      consumerRestores: [
        { action: "actions/cache/restore@v5", failOnMiss: "true", repeatsInstall: false },
        { action: "actions/cache/restore@v5", failOnMiss: "true", repeatsInstall: false },
        { action: "actions/cache/restore@v5", failOnMiss: "true", repeatsInstall: false },
        { action: "actions/cache/restore@v5", failOnMiss: "true", repeatsInstall: false },
        { action: "actions/cache/restore@v5", failOnMiss: "true", repeatsInstall: false },
      ],
      cacheActionVersions: ["v5", "v5", "v5", "v5", "v5", "v5", "v5"],
      unitWorkers: ["'4'", "'4'"],
      unitShardTotals: ["'3'", "'6'"],
      unitShards: [
        [1, 2, 3],
        [1, 2, 3, 4, 5, 6],
      ],
      unitActionUses: [
        "./.github/actions/run-unit-shard",
        "./.github/actions/run-unit-shard",
      ],
      unitActionNodes: ["'24'", "'26'"],
      unitActionTotals: ["3", "6"],
      unitShardEnv: "${{ inputs.shard }}/${{ inputs.shard-total }}",
      unitTestTimeout: null,
      e2eWorkerVariable: null,
      e2eShards: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      pullRequestPeakJobIds: ["gates", "docs-checks", "unit-node-24", "e2e"],
      pullRequestPeakJobs: 19,
      e2eTestTimeout: null,
      localUnitWorkers: "6",
      unitShardOption: "${MISSION_TEST_SHARD:+--test-shard=$MISSION_TEST_SHARD}",
      unitShardOptionPrecedesPattern: true,
      // The config reads the platform it runs on, and win32 deliberately runs two workers
      // (see `e2e/playwright.config.ts`), so each platform pins its own count.
      playwrightWorkers: process.platform === "win32" ? { ci: 2, local: 2 } : { ci: 4, local: 4 },
    },
  );
});

test("init dry-run has no external worktree installer or configuration step", () => {
  const output = execFileSync(
    process.execPath,
    [script, "--dry-run", "--skip-build", "--skip-hooks"],
    { cwd: repo, encoding: "utf8" },
  );
  assert.doesNotMatch(output, /^\s*(?:\d+\.\s+)?treehouse|curl -fsSL|go install/im);
  assert.match(output, /Node\.js prerequisite/);
  assert.match(output, /Node dependencies/);
  assert.match(output, /Claude status hooks/);
});

test("init source cannot invoke the retired Treehouse bootstrap", () => {
  const source = readFileSync(script, "utf8");
  const makefile = readFileSync(join(repo, "Makefile"), "utf8");
  assert.doesNotMatch(source, /treehouse|kunchenguid|curl -fsSL|go install/i);
  assert.doesNotMatch(makefile, /treehouse|kunchenguid|curl -fsSL|go install/i);
});
