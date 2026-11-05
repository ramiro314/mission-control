import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Registry } from "../src/server/registry.ts";

// `inspector-diff-large-pr.test.ts` stops at what `fetchDiff` returns. This one is the behavior
// the fallback exists for: the REAL worker takes a pull request GitHub refuses to diff through
// a whole review round, instead of parking it as a failed review. The finding sits in file 400,
// past the 300 GitHub stops at, so it can only post if the compare diff reached the prompt and
// the anchoring, and no model tokens are spent because both binaries are fakes.
//
// Environment overrides must be installed before importing the worker: its runner and poll
// interval are resolved at module load.
const temp = mkdtempSync(join(tmpdir(), "mission-inspector-large-pr-round-"));
const binDir = join(temp, "bin");
const claudePath = join(binDir, "claude");
const ghPath = join(binDir, "gh");
const callsPath = join(temp, "gh-calls.log");
const reviewsPath = join(temp, "reviews.log");
const promptPath = join(temp, "prompt.txt");
const project = fileURLToPath(new URL("..", import.meta.url));

mkdirSync(binDir, { recursive: true });
process.env.MISSION_HOME = join(temp, "state");
process.env.MISSION_CLAUDE_BIN = claudePath;
process.env.MISSION_INSPECTOR_POLL_MS = "25";
process.env.FAKE_GH_CALLS = callsPath;
process.env.FAKE_GH_REVIEWS = reviewsPath;
process.env.FAKE_CLAUDE_PROMPT = promptPath;
process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;

writeFileSync(callsPath, "");
writeFileSync(reviewsPath, "");

const FILES = 446;

writeFileSync(
  claudePath,
  `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(process.env.FAKE_CLAUDE_PROMPT, Buffer.concat(chunks));
  const finding = { path: "src/file-400.ts", line: 1, severity: "major", title: "Past the limit", body: "Reviewed." };
  const answer = { summary: "One finding.", findings: [finding], resolved: [] };
  process.stdout.write(JSON.stringify({ result: JSON.stringify(answer) }));
});
`,
);
chmodSync(claudePath, 0o755);

// The refusal is GitHub's real answer for OpenDAM#266, stdout and stderr both.
writeFileSync(
  ghPath,
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("operator\\n");
} else if (args.includes("graphql")) {
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: {
    state: "OPEN",
    headRefOid: "head-1",
    isDraft: false,
    title: "A very large change",
    body: "More files than GitHub will diff.",
    createdAt: "2026-07-30T12:00:00Z",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
    reviewThreads: { nodes: [] },
    reviews: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } }
  } } } }));
} else if (args.some((arg) => arg.endsWith("/reviews"))) {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    fs.appendFileSync(process.env.FAKE_GH_REVIEWS, Buffer.concat(chunks).toString() + "\\n");
    process.stdout.write("{}");
  });
} else if (args.includes("--jq")) {
  fs.appendFileSync(process.env.FAKE_GH_CALLS, "range " + args[1] + "\\n");
  process.stdout.write("base-1...head-1\\n");
} else if (args[1].includes("/compare/")) {
  fs.appendFileSync(process.env.FAKE_GH_CALLS, "diff " + args[1] + "\\n");
  let diff = "";
  for (let i = 1; i <= ${FILES}; i++) {
    const path = "src/file-" + String(i).padStart(3, "0") + ".ts";
    diff += "diff --git a/" + path + " b/" + path + "\\n--- a/" + path + "\\n+++ b/" + path + "\\n@@ -1 +1 @@\\n-old\\n+new\\n";
  }
  process.stdout.write(diff);
} else if (/\\/pulls\\/\\d+$/.test(args[1])) {
  fs.appendFileSync(process.env.FAKE_GH_CALLS, "diff " + args[1] + "\\n");
  process.stdout.write('{"message":"Sorry, the diff exceeded the maximum number of files (300).","errors":[{"resource":"PullRequest","field":"diff","code":"too_large"}],"status":"406"}');
  process.stderr.write("gh: Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead. (HTTP 406)\\n");
  process.exitCode = 1;
} else {
  process.stderr.write("unexpected fake gh invocation: " + JSON.stringify(args));
  process.exitCode = 2;
}
`,
);
chmodSync(ghPath, 0o755);

const { configureClaudeRunnerTransport } = await import("../src/server/llm/claude.ts");
const restoreTransport = configureClaudeRunnerTransport(() => "print");
const { getInspectorPr } = await import("../src/server/db.ts");
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { adoptPr, startInspector } = await import("../src/server/inspector/worker.ts");

after(() => {
  restoreTransport();
  rmSync(temp, { recursive: true, force: true });
});

const registryStub = {
  onPrOpened: () => () => {},
  onPipelineRun: () => () => {},
  refreshInspections: () => {},
  snapshot: () => ({ sessions: [] }),
} as unknown as Registry;

test("a pull request past GitHub's diff limits gets a whole review round", async () => {
  setInspectorConfig({
    enabled: true,
    mode: "live",
    repoAllowlist: [project],
    maxCommentsPerRound: 8,
  });
  const key = "mission/control#266";
  adoptPr(
    "https://github.com/mission/control/pull/266",
    { sessionId: null, cwd: project, repoRoot: project },
    "hook",
    Date.now(),
  );

  const stop = startInspector(registryStub);
  // Either way out ends the wait, so the code this replaced fails on its reason, not a timeout.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pr = getInspectorPr(key);
    if (pr && (pr.round > 0 || pr.lastError)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  stop();

  const pr = getInspectorPr(key);
  assert.equal(pr?.lastError, null, "the pull request was not parked as a failed review");
  assert.equal(pr?.lastFailKind, null);
  assert.equal(pr?.failCount, 0);
  assert.equal(pr?.round, 1, "the review round completed");
  assert.equal(pr?.headSha, "head-1", "the head was recorded as reviewed");

  assert.deepEqual(readFileSync(callsPath, "utf8").trim().split("\n").slice(0, 3), [
    "diff repos/mission/control/pulls/266",
    "range repos/mission/control/pulls/266",
    "diff repos/mission/control/compare/base-1...head-1",
  ]);

  const prompt = readFileSync(promptPath, "utf8");
  assert.ok(prompt.includes("src/file-001.ts"), "the first file reached the reviewer");
  assert.ok(prompt.includes(`src/file-${FILES}.ts`), "the last file reached the reviewer");
  assert.ok(!prompt.includes("## The diff (TRUNCATED"), "the reviewer read the whole diff");

  const posted = JSON.parse(readFileSync(reviewsPath, "utf8").trim().split("\n")[0] ?? "") as {
    comments: { path: string; line: number }[];
  };
  assert.deepEqual(
    posted.comments.map(({ path, line }) => ({ path, line })),
    [{ path: "src/file-400.ts", line: 1 }],
    "a finding past file 300 was anchored to the compare diff and posted",
  );
});
