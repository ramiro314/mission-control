// Regenerate shard timings from one CI run: `npm run test:timings -- <run-id>` for Linux's
// `test/shard-timings.json`, `npm run test:timings -- --windows <run-id>` for the Windows unit
// and e2e timings (`SHARD_SUITES` in `scripts/unit-shard.mjs` names their files).
//
// Each Linux unit shard uploads its JUnit results as `unit-junit-node-<v>-shard-<n>`, each
// Windows one as `windows-unit-junit-shard-<n>` or `windows-e2e-junit-shard-<n>`. This downloads
// every one of a source's artifacts with `gh run download`, sums each test file's top-level suite
// and case times per sample (`junitFileTimes`), and averages the samples. A Linux sample is a
// Node release (a pull request runs Node 24 only, a push to `main` both); Windows runs one. Only
// files that exist in this checkout are written, so a deleted test drops out and a new one is
// weighted by `scripts/unit-shard.mjs` until the next regeneration. `GH_REPO` selects another
// repository, as it does for every `gh` command.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { junitFileTimes } from "../src/shared/junit.ts";
import { SHARD_SUITES, suiteFiles, type ShardSuite } from "./unit-shard.mjs";

const ARTIFACT = /^unit-junit-node-(\d+)-shard-\d+$/;

/** Where one suite's JUnit comes from: the artifacts' name, their file, and their sample. */
interface TimingSource {
  suite: ShardSuite;
  /** Matches every artifact of the source; its first group, when it has one, names the sample. */
  artifact: RegExp;
  /** The `gh run download --pattern` that fetches them. */
  pattern: string;
  /** The JUnit file inside each artifact. */
  junit: string;
}

export const TIMING_SOURCES: Record<"linux" | "windows", TimingSource[]> = {
  linux: [{ suite: "unit", artifact: ARTIFACT, pattern: "unit-junit-node-*", junit: "junit.xml" }],
  windows: [
    { suite: "windows-unit", artifact: /^windows-unit-junit-shard-\d+$/, pattern: "windows-unit-junit-shard-*", junit: "windows-unit-junit.xml" },
    { suite: "windows-e2e", artifact: /^windows-e2e-junit-shard-\d+$/, pattern: "windows-e2e-junit-shard-*", junit: "windows-e2e-junit.xml" },
  ],
};

export interface ShardJUnit {
  /** The artifact name, `unit-junit-node-<v>-shard-<n>` unless another `artifact` is given. */
  artifact: string;
  xml: string;
}

/**
 * Milliseconds per test file, from every shard's JUnit. A reported path is matched to the
 * checkout file it ends with, since each runner reports its own absolute path, and a win32 one
 * with backslashes.
 */
export function shardTimings(
  reports: readonly ShardJUnit[],
  files: readonly string[],
  artifact: RegExp = ARTIFACT,
): Record<string, number> {
  const bySample = new Map<string, Map<string, number>>();
  for (const report of reports) {
    const match = artifact.exec(report.artifact);
    if (!match) throw new Error(`${report.artifact} does not match ${artifact}`);
    const sample = match[1] ?? "";
    const parsed = junitFileTimes(report.xml);
    if (!parsed.ok) throw new Error(`${report.artifact}: ${parsed.error}`);
    const totals = bySample.get(sample) ?? new Map<string, number>();
    bySample.set(sample, totals);
    for (const [raw, ms] of parsed.times) {
      const reported = raw.replaceAll("\\", "/");
      const file = files.find((candidate) => reported === candidate || reported.endsWith(`/${candidate}`));
      if (file) totals.set(file, (totals.get(file) ?? 0) + ms);
    }
  }
  const timings: Record<string, number> = {};
  for (const file of [...files].sort()) {
    const recorded = [...bySample.values()].flatMap((totals) => totals.has(file) ? [totals.get(file)!] : []);
    if (recorded.length) timings[file] = Math.round(recorded.reduce((a, b) => a + b, 0) / recorded.length);
  }
  return timings;
}

function regenerate(root: string, runId: string, source: TimingSource): void {
  const dir = mkdtempSync(join(tmpdir(), "unit-shard-timings-"));
  try {
    execFileSync("gh", ["run", "download", runId, "--pattern", source.pattern, "--dir", dir], { stdio: "inherit" });
    const reports = readdirSync(dir).filter((name) => source.artifact.test(name)).sort().map((artifact) => ({
      artifact,
      xml: readFileSync(join(dir, artifact, source.junit), "utf8"),
    }));
    if (!reports.length) throw new Error(`run ${runId} has no ${source.pattern} artifacts`);
    const timings = shardTimings(reports, suiteFiles(root, source.suite), source.artifact);
    const count = Object.keys(timings).length;
    if (!count) throw new Error(`run ${runId}'s ${source.pattern} JUnit names none of this checkout's ${source.suite} files`);
    const path = SHARD_SUITES[source.suite].timings;
    writeFileSync(join(root, path), `${JSON.stringify(timings, null, 2)}\n`);
    console.log(`Wrote ${count} file timings from ${reports.length} shard reports to ${path}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const windows = args[0] === "--windows";
  const runId = windows ? args[1] : args[0];
  if (!runId || !/^\d+$/.test(runId) || args.length !== (windows ? 2 : 1)) {
    throw new Error("usage: npm run test:timings -- [--windows] <run-id>");
  }
  const root = join(fileURLToPath(import.meta.url), "..", "..");
  for (const source of TIMING_SOURCES[windows ? "windows" : "linux"]) regenerate(root, runId, source);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`test:timings: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
