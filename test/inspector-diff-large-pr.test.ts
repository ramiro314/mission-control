import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// GitHub answers a pull request's diff with a 406 past 300 files or 20,000 lines, and that
// parked every such PR as a failed review. The compare API renders the same range without
// the limit, so `fetchDiff` falls back to it. Driven through a fake `gh` on PATH, the same
// way `inspector-diff-bytes.test.ts` is, because the status lives in gh's stderr.

const temp = mkdtempSync(join(tmpdir(), "mission-inspector-large-pr-"));
const binDir = join(temp, "bin");
const scriptPath = join(temp, "script.json");
const callsPath = join(temp, "calls.log");
mkdirSync(binDir, { recursive: true });

process.env.FAKE_GH_SCRIPT = scriptPath;
process.env.FAKE_GH_CALLS = callsPath;
process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;

// `script` maps a call's kind to what gh does for it. An unscripted kind fails loudly, so a
// request this test did not expect cannot read as a success.
const ghPath = join(binDir, "gh");
writeFileSync(
  ghPath,
  `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(argv) + "\\n");
const kind = argv.includes("--jq") ? "range" : argv[1].includes("/compare/") ? "compare" : "pull";
const step = JSON.parse(fs.readFileSync(process.env.FAKE_GH_SCRIPT, "utf8"))[kind];
if (!step) {
  process.stderr.write("unexpected gh call: " + argv.join(" "));
  process.exit(1);
}
process.stdout.write(step.stdoutBytes ? "x".repeat(step.stdoutBytes) : (step.stdout ?? ""));
process.stderr.write(step.stderr ?? "");
// Not process.exit: that drops whatever the pipe has not taken yet, so a large write would
// arrive short and never overflow.
process.exitCode = step.code ?? 0;
`,
);
chmodSync(ghPath, 0o755);

const { fetchDiff } = await import("../src/server/inspector/github.ts");

after(() => rmSync(temp, { recursive: true, force: true }));
beforeEach(() => writeFileSync(callsPath, ""));

const REFUSED = {
  code: 1,
  stdout: '{"message":"Sorry, the diff exceeded the maximum number of files (300).","status":"406"}',
  stderr: "gh: Sorry, the diff exceeded the maximum number of files (300). (HTTP 406)\n",
};
const RANGE = { stdout: "aaa111...bbb222\n" };
const DIFF = "diff --git a/one.ts b/one.ts\n--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-a\n+b\n";

function script(steps: Record<string, unknown>): void {
  writeFileSync(scriptPath, JSON.stringify(steps));
}

function calls(): string[][] {
  return readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("a pull request past GitHub's diff limits is read through compare", async () => {
  script({ pull: REFUSED, range: RANGE, compare: { stdout: DIFF } });
  const res = await fetchDiff(null, "acme", "widgets", 7, 1_000);
  assert.deepEqual(res, { ok: true, value: { diff: DIFF, truncated: false } });
  assert.deepEqual(calls().map((argv) => argv[1]), [
    "repos/acme/widgets/pulls/7",
    "repos/acme/widgets/pulls/7",
    "repos/acme/widgets/compare/aaa111...bbb222",
  ]);
  assert.ok(calls()[2]?.includes("Accept: application/vnd.github.v3.diff"), "compare is asked for a diff");
});

test("a diff read through compare keeps the prompt's byte cap", async () => {
  script({ pull: REFUSED, range: RANGE, compare: { stdout: DIFF } });
  const res = await fetchDiff(null, "acme", "widgets", 7, 10);
  assert.deepEqual(res.value, { diff: DIFF.slice(0, 10), truncated: true });
});

test("an ordinary pull request reads its own diff and nothing else", async () => {
  script({ pull: { stdout: DIFF } });
  const res = await fetchDiff(null, "acme", "widgets", 7, 1_000);
  assert.equal(res.value?.diff, DIFF);
  assert.equal(calls().length, 1);
});

test("any other failure does not reach for compare", async () => {
  script({ pull: { code: 1, stderr: "gh: Server Error (HTTP 502)\n" } });
  const res = await fetchDiff(null, "acme", "widgets", 7, 1_000);
  assert.equal(res.ok, false);
  assert.equal(res.tooLarge, false, "a 502 climbs the ordinary ladder");
  assert.equal(calls().length, 1);
});

test("a refusal from compare too parks the pull request as too large", async () => {
  script({ pull: REFUSED, range: RANGE, compare: REFUSED });
  const res = await fetchDiff(null, "acme", "widgets", 7, 1_000);
  assert.equal(res.ok, false);
  assert.equal(res.tooLarge, true, "retrying the same head cannot produce a smaller diff");
  assert.match(res.error ?? "", /maximum number of files/);
});

test("a compare past the 16MB pipe budget parks the pull request as too large", async () => {
  script({ pull: REFUSED, range: RANGE, compare: { stdoutBytes: 17 * 1024 * 1024 } });
  const res = await fetchDiff(null, "acme", "widgets", 7, 1_000);
  assert.equal(res.ok, false);
  assert.equal(res.tooLarge, true, "retrying the same head cannot produce fewer bytes");
  assert.match(res.error ?? "", /larger than 16MB/);
  assert.equal(calls().length, 3);
  assert.equal(calls()[2]?.[1], "repos/acme/widgets/compare/aaa111...bbb222", "compare was the last call");
});

test("a compare that fails for another reason stays an ordinary failure", async () => {
  script({ pull: REFUSED, range: RANGE, compare: { code: 1, stderr: "gh: Server Error (HTTP 502)\n" } });
  const res = await fetchDiff(null, "acme", "widgets", 7, 1_000);
  assert.equal(res.ok, false);
  assert.equal(res.tooLarge, false);
  assert.match(res.error ?? "", /HTTP 502/);
});

test("a range that cannot be read is reported, not retried against compare", async () => {
  script({ pull: REFUSED, range: { code: 1, stderr: "gh: Not Found (HTTP 404)\n" } });
  const res = await fetchDiff(null, "acme", "widgets", 7, 1_000);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /^gh api \(diff range\) failed \(exit 1\): gh: Not Found/);
  assert.equal(calls().length, 2);
});
