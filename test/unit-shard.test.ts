import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { junitFileTimes } from "../src/shared/junit.ts";
import {
  parseShardSpec,
  partitionUnitTests,
  readShardTimings,
  shardWeights,
  unitTestFiles,
} from "../scripts/unit-shard.mjs";
import { shardTimings } from "../scripts/unit-shard-timings.ts";

// What is at stake: coverage. Timings only steer which shard a file lands in; whatever they
// say, every unit test file must run in exactly one shard, or CI goes green without it.

const repo = join(import.meta.dirname, "..");

/** A small seeded generator, so a failing case reproduces. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function assertEachFileOnce(files: readonly string[], shards: string[][], total: number, label: string) {
  assert.equal(shards.length, total, label);
  const dealt = shards.flat();
  assert.equal(dealt.length, new Set(dealt).size, `${label}: a file ran twice`);
  assert.deepEqual([...dealt].sort(), [...new Set(files)].sort(), `${label}: a file was dropped or invented`);
}

test("every file lands in exactly one shard, for any files, timings and shard total", () => {
  const next = random(20261005);
  for (let run = 0; run < 400; run++) {
    const count = Math.floor(next() * 60);
    const files = Array.from({ length: count }, (_, i) => `test/f${Math.floor(next() * 80)}-${i % 7}.test.ts`);
    const total = 1 + Math.floor(next() * 12);
    const timings: Record<string, unknown> = {};
    const shape = run % 4;
    if (shape !== 0) {
      for (const file of files) {
        if (shape === 2 && next() < 0.5) continue; // partial
        timings[file] = Math.floor(next() * 5000);
      }
      if (shape === 3) {
        // stale: files that no longer exist, and values that are not durations
        timings["test/deleted.test.ts"] = 99_999;
        if (files[0]) timings[files[0]] = "slow";
        if (files[1]) timings[files[1]] = -5;
      }
    }
    assertEachFileOnce(files, partitionUnitTests(files, timings, total), total, `run ${run}`);
  }
});

test("more shards than files leaves the extra shards empty, never duplicates a file", () => {
  const files = ["test/a.test.ts", "test/b.test.ts"];
  const shards = partitionUnitTests(files, {}, 5);
  assertEachFileOnce(files, shards, 5, "5 shards");
  assert.deepEqual(shards.map((shard) => shard.length), [1, 1, 0, 0, 0]);
});

test("the same files and timings always give the same shards, whatever order the files arrive in", () => {
  const files = Array.from({ length: 40 }, (_, i) => `test/f${i}.test.ts`);
  const timings = Object.fromEntries(files.slice(0, 30).map((file, i) => [file, (i % 5) * 100]));
  const expected = partitionUnitTests(files, timings, 4);
  const next = random(7);
  for (let i = 0; i < 20; i++) {
    const shuffled = [...files].sort(() => next() - 0.5);
    assert.deepEqual(partitionUnitTests(shuffled, timings, 4), expected);
  }
});

test("longest files go first, each onto the lightest shard", () => {
  const timings = { "test/a.test.ts": 10, "test/b.test.ts": 8, "test/c.test.ts": 6, "test/d.test.ts": 5, "test/e.test.ts": 4 };
  // a (10) | b (8), c (6) onto 8 | d (5) onto 10 | e (4) onto 14: shards end at 15 and 18.
  assert.deepEqual(partitionUnitTests(Object.keys(timings), timings, 2), [
    ["test/a.test.ts", "test/d.test.ts"],
    ["test/b.test.ts", "test/c.test.ts", "test/e.test.ts"],
  ]);
});

test("a file without a recorded duration weighs the median of the recorded ones", () => {
  const files = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts", "test/new.test.ts"];
  const weights = shardWeights(files, {
    "test/a.test.ts": 100,
    "test/b.test.ts": 300,
    "test/c.test.ts": 900,
    "test/d.test.ts": 1000,
    "test/deleted.test.ts": 50_000,
  });
  // The median of this file set's recorded times; a deleted file's time does not count.
  assert.equal(weights.get("test/new.test.ts"), 600);
  assert.equal(weights.get("test/c.test.ts"), 900);

  // With no timings at all every file weighs the same, so shards balance by file count.
  const even = partitionUnitTests(files, {}, 2);
  assert.deepEqual(even.map((shard) => shard.length), [3, 2]);
});

test("a recorded value that is not a duration weighs the median, like a missing one", () => {
  const files = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/word.test.ts", "test/neg.test.ts", "test/inf.test.ts"];
  const weights = shardWeights(files, {
    "test/a.test.ts": 100,
    "test/b.test.ts": 200,
    "test/c.test.ts": 900,
    "test/word.test.ts": "slow",
    "test/neg.test.ts": -5,
    "test/inf.test.ts": Infinity,
  });
  for (const file of ["test/word.test.ts", "test/neg.test.ts", "test/inf.test.ts"]) {
    assert.equal(weights.get(file), 200, file);
  }
});

test("the CLI refuses an empty shard rather than let node --test discover its own files", () => {
  // One more shard than there are unit test files leaves the last shard empty.
  const total = unitTestFiles(repo).length + 1;
  const result = spawnSync(process.execPath, [join(repo, "scripts", "unit-shard.mjs"), `${total}/${total}`], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(`shard ${total}/${total} has no test files`));
});

test("reading timings: an absent file is no timings, anything but an object is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "unit-shard-timings-"));
  try {
    assert.deepEqual(readShardTimings(root), {});
    for (const body of ["[]", "null", "42"]) {
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test", "shard-timings.json"), body);
      assert.throws(() => readShardTimings(root), /must be an object/, body);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shard spec is one-based and bounded by its total", () => {
  assert.deepEqual(parseShardSpec("3/6"), { index: 3, total: 6 });
  for (const bad of [undefined, "", "0/6", "7/6", "1/0", "a/b", "1/2/3"]) {
    assert.throws(() => parseShardSpec(bad), /expected <index>\/<total>/, String(bad));
  }
});

test("the committed timings and this checkout's unit glob partition cleanly", () => {
  const files = unitTestFiles(repo);
  assert.ok(files.length > 0);
  assert.ok(files.every((file) => /^test\/.+\.test\.ts$/.test(file)));
  const timings = readShardTimings(repo);
  assert.ok(Object.values(timings).every((ms) => Number.isInteger(ms) && (ms as number) >= 0));
  assertEachFileOnce(files, partitionUnitTests(files, timings, 6), 6, "6 shards");
});

test("each unit shard uploads its JUnit results for the timings generator", () => {
  const action = readFileSync(join(repo, ".github", "actions", "run-unit-shard", "action.yml"), "utf8");
  const upload = /- name: Upload JUnit results\n([\s\S]*?)(?=\n\n|\n {4}- name:)/.exec(action)?.[1] ?? "";
  assert.match(upload, /^\s+if: \$\{\{ !cancelled\(\) \}\}$/m);
  assert.match(upload, /^\s+name: unit-junit-node-\$\{\{ inputs\.node-version \}\}-shard-\$\{\{ inputs\.shard \}\}$/m);
  assert.match(upload, /^\s+path: \$\{\{ runner\.temp \}\}\/flake\/junit\.xml$/m);
  assert.match(upload, /^\s+retention-days: 7$/m);
});

/** Node's reporter shape; `suiteSeconds` wraps the cases in a `describe` suite that took that long. */
function junit(cases: { file: string; seconds: number }[], suiteSeconds?: number): string {
  const body = cases.map((c) => `<testcase name="t" classname="test" time="${c.seconds}" file="${c.file}"/>`).join("\n");
  const wrapped = suiteSeconds === undefined ? body : `<testsuite name="s" time="${suiteSeconds}">\n${body}\n</testsuite>`;
  return `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${wrapped}\n</testsuites>\n`;
}

test("timings sum each file's top-level suites and cases per Node release and average the releases", () => {
  const files = ["test/a.test.ts", "test/b.test.ts", "test/never-ran.test.ts"];
  const runner = "/home/runner/work/mission-control/mission-control";
  const timings = shardTimings(
    [
      {
        artifact: "unit-junit-node-24-shard-1",
        // The suite's 2 s includes 0.5 s of hooks around its cases' 1.5 s.
        xml: junit([{ file: `${runner}/test/a.test.ts`, seconds: 1 }, { file: `${runner}/test/a.test.ts`, seconds: 0.5 }], 2),
      },
      { artifact: "unit-junit-node-24-shard-2", xml: junit([{ file: `${runner}/test/b.test.ts`, seconds: 0.25 }]) },
      { artifact: "unit-junit-node-26-shard-1", xml: junit([{ file: `${runner}/test/a.test.ts`, seconds: 2.5 }]) },
      // A file deleted since the run is not written back.
      { artifact: "unit-junit-node-26-shard-2", xml: junit([{ file: `${runner}/test/gone.test.ts`, seconds: 9 }]) },
    ],
    files,
  );
  // a: the suite's 2000 ms on 24 (not its cases' 1500 ms) and 2500 ms on 26.
  assert.deepEqual(timings, { "test/a.test.ts": 2250, "test/b.test.ts": 250 });
});

test("timings refuse an artifact that is not a unit shard's JUnit, or XML that does not parse", () => {
  assert.throws(() => shardTimings([{ artifact: "flake-report-unit-node-24-shard-1", xml: junit([]) }], []), /not a unit-junit/);
  assert.throws(() => shardTimings([{ artifact: "unit-junit-node-24-shard-1", xml: "<testsuites>" }], []), /not well-formed/);
});

test("a test case or suite with no file or no readable time adds nothing to any file", () => {
  const parsed = junitFileTimes(`<?xml version="1.0" encoding="utf-8"?>
<testsuites>
<testcase name="no file" time="5"/>
<testcase name="bad time" time="abc" file="/w/test/a.test.ts"/>
<testcase name="negative" time="-1" file="/w/test/a.test.ts"/>
<testcase name="no time" file="/w/test/a.test.ts"/>
<testcase name="ok" time="0.25" file="/w/test/a.test.ts"/>
<testsuite name="no file under it" time="7"><testcase name="x" time="7"/></testsuite>
</testsuites>
`);
  assert.ok(parsed.ok);
  assert.deepEqual([...parsed.times], [["/w/test/a.test.ts", 250]]);
});

test("a suite counts once at its own time: hooks are included, concurrent cases are not summed", () => {
  const parsed = junitFileTimes(`<?xml version="1.0" encoding="utf-8"?>
<testsuites>
<testsuite name="hooks" time="3">
<testcase name="cheap" time="0.1" file="/w/test/hooked.test.ts"/>
</testsuite>
<testsuite name="concurrency 4" time="2">
<testsuite name="nested" time="1.5">
<testcase name="a" time="1.5" file="/w/test/parallel.test.ts"/>
</testsuite>
<testcase name="b" time="1.9" file="/w/test/parallel.test.ts"/>
<testcase name="c" time="1.9" file="/w/test/parallel.test.ts"/>
</testsuite>
<testcase name="bare" time="0.5" file="/w/test/parallel.test.ts"/>
</testsuites>
`);
  assert.ok(parsed.ok);
  assert.deepEqual(Object.fromEntries(parsed.times), {
    // A slow before() hook around a cheap case is the suite's 3 s, not the case's 0.1 s.
    "/w/test/hooked.test.ts": 3000,
    // The concurrent suite's wall time (2 s) plus a bare top-level case, never the 5.3 s its
    // cases add up to, and the nested suite is not counted again.
    "/w/test/parallel.test.ts": 2500,
  });
});
