// Regenerate `test/shard-timings.json` from one CI run: `npm run test:timings -- <run-id>`.
//
// Each unit shard uploads its JUnit results as `unit-junit-node-<v>-shard-<n>`. This downloads
// every one of them with `gh run download`, sums each test file's top-level suite and case times
// per Node release (`junitFileTimes`), and averages the releases the run covered (a pull request
// runs Node 24 only, a push to `main` both). Only files that exist in this checkout are written, so a deleted test drops out and a
// new one is weighted by `scripts/unit-shard.mjs` until the next regeneration. `GH_REPO`
// selects another repository, as it does for every `gh` command.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { junitFileTimes } from "../src/shared/junit.ts";
import { SHARD_TIMINGS_PATH, unitTestFiles } from "./unit-shard.mjs";

const ARTIFACT = /^unit-junit-node-(\d+)-shard-\d+$/;

export interface ShardJUnit {
  /** The artifact name, `unit-junit-node-<v>-shard-<n>`. */
  artifact: string;
  xml: string;
}

/**
 * Milliseconds per repository-relative test file, from every shard's JUnit. A reported path is
 * matched to the checkout file it ends with, since each runner reports its own absolute path.
 */
export function shardTimings(reports: readonly ShardJUnit[], files: readonly string[]): Record<string, number> {
  const byRelease = new Map<string, Map<string, number>>();
  for (const { artifact, xml } of reports) {
    const release = ARTIFACT.exec(artifact)?.[1];
    if (!release) throw new Error(`${artifact} is not a unit-junit-node-<v>-shard-<n> artifact`);
    const parsed = junitFileTimes(xml);
    if (!parsed.ok) throw new Error(`${artifact}: ${parsed.error}`);
    const totals = byRelease.get(release) ?? new Map<string, number>();
    byRelease.set(release, totals);
    for (const [reported, ms] of parsed.times) {
      const file = files.find((candidate) => reported === candidate || reported.endsWith(`/${candidate}`));
      if (file) totals.set(file, (totals.get(file) ?? 0) + ms);
    }
  }
  const timings: Record<string, number> = {};
  for (const file of [...files].sort()) {
    const recorded = [...byRelease.values()].flatMap((totals) => totals.has(file) ? [totals.get(file)!] : []);
    if (recorded.length) timings[file] = Math.round(recorded.reduce((a, b) => a + b, 0) / recorded.length);
  }
  return timings;
}

function main(): void {
  const runId = process.argv[2];
  if (!runId || !/^\d+$/.test(runId)) throw new Error("usage: npm run test:timings -- <run-id>");
  const root = join(fileURLToPath(import.meta.url), "..", "..");
  const dir = mkdtempSync(join(tmpdir(), "unit-shard-timings-"));
  try {
    execFileSync("gh", ["run", "download", runId, "--pattern", "unit-junit-node-*", "--dir", dir], { stdio: "inherit" });
    const reports = readdirSync(dir).filter((name) => ARTIFACT.test(name)).sort().map((artifact) => ({
      artifact,
      xml: readFileSync(join(dir, artifact, "junit.xml"), "utf8"),
    }));
    if (!reports.length) throw new Error(`run ${runId} has no unit-junit-node-<v>-shard-<n> artifacts`);
    const timings = shardTimings(reports, unitTestFiles(root));
    const count = Object.keys(timings).length;
    if (!count) throw new Error(`run ${runId}'s JUnit names none of this checkout's unit test files`);
    writeFileSync(join(root, SHARD_TIMINGS_PATH), `${JSON.stringify(timings, null, 2)}\n`);
    console.log(`Wrote ${count} file timings from ${reports.length} shard reports to ${SHARD_TIMINGS_PATH}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`test:timings: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
