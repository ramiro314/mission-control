import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Registry } from "../src/server/registry.ts";
import type { InspectorComment } from "../src/shared/types.ts";

// Findings drafted in dry run, after the operator switches the GitHub Inspector to live.
//
// Drives the real Inspector loop through a fake `gh` and a fake model runner, so it spends
// no model tokens. The fake `gh` can refuse a review POST in the ways GitHub does: a 422 for
// a comment it cannot anchor, or a whole-review refusal such as a rate limit. Environment
// overrides are installed before the worker is imported, because its runner and poll
// interval are resolved at module load.
const temp = mkdtempSync(join(tmpdir(), "mission-inspector-drafts-live-"));
const binDir = join(temp, "bin");
const statePath = join(temp, "github-state.json");
const reviewCountPath = join(temp, "review-count.txt");
const claudePath = join(binDir, "claude");
const ghPath = join(binDir, "gh");
const project = fileURLToPath(new URL("..", import.meta.url));

mkdirSync(binDir, { recursive: true });
process.env.MISSION_HOME = join(temp, "state");
process.env.MISSION_CLAUDE_BIN = claudePath;
process.env.MISSION_INSPECTOR_POLL_MS = "25";
process.env.FAKE_GITHUB_STATE = statePath;
process.env.FAKE_REVIEW_COUNT_PATH = reviewCountPath;
process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;

// The fake model. Its first review returns FAKE_FIRST_FINDINGS, and every later one returns
// nothing new and resolves nothing, which is what the review prompt asks of it once a finding
// has been raised. It also records every review prompt, so a test can read what it was told.
writeFileSync(
  claudePath,
  `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const fs = require("node:fs");
  const prompt = Buffer.concat(chunks).toString("utf8");
  const countPath = process.env.FAKE_REVIEW_COUNT_PATH;
  const count = Number(fs.readFileSync(countPath, "utf8")) + 1;
  fs.writeFileSync(countPath, String(count));
  fs.writeFileSync(countPath + "." + count + ".prompt", prompt);
  const verdict = {
    summary: "Nothing else to flag.",
    findings: count === 1 ? JSON.parse(process.env.FAKE_FIRST_FINDINGS || "[]") : [],
    resolved: [],
  };
  process.stdout.write(JSON.stringify({ result: JSON.stringify(verdict) }));
});
`,
);
chmodSync(claudePath, 0o755);

const { configureClaudeRunnerTransport } = await import("../src/server/llm/claude.ts");
const restoreTransport = configureClaudeRunnerTransport(() => "print");

// The fake GitHub.
//
// A review POST is answered, in order, by:
//   1. the next entry of `forcedStatuses`, when there is one: a status other than 200 refuses
//      the whole review with that HTTP status, whatever it carries;
//   2. `rejectFingerprints`: a review carrying a comment whose marker names one of these is
//      refused with GitHub's 422 for a line it cannot resolve;
//   3. otherwise it is accepted.
// `headAfterRefusal` moves the head the moment a review is refused, so the moved-head check
// reads a different commit from the one the review was made for.
writeFileSync(
  ghPath,
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GITHUB_STATE;
const load = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
// Written through a temp file and renamed, so a test polling the file never reads it half-written.
const save = (state) => {
  const tmp = statePath + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
};

if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("operator\\n");
} else if (args.includes("graphql")) {
  const state = load();
  state.sweeps += 1;
  save(state);
  process.stdout.write(JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: "OPEN",
          headRefOid: state.headSha,
          headRefName: "feature",
          isDraft: false,
          title: "Drafts after a switch to live",
          body: "Exercise posting dry-run drafts.",
          createdAt: "2020-01-01T00:00:00Z",
          mergeable: "MERGEABLE",
          reviewDecision: null,
          commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
          reviewThreads: { nodes: state.threads, pageInfo: { hasNextPage: false, endCursor: null } },
          reviews: { nodes: state.reviews, pageInfo: { hasPreviousPage: false, startCursor: null } }
        }
      }
    }
  }));
} else if (args.includes("--method") && args.includes("POST") && args.some((a) => /\\/reviews$/.test(a))) {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const state = load();
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const fps = payload.comments.map((c) => (/ fp=(\\S+) /.exec(c.body) || [])[1]);
    state.attempts.push({ body: payload.body, fingerprints: fps, commit_id: payload.commit_id });
    const refuse = (status, message) => {
      state.refusals.push({ status, fingerprints: fps });
      if (state.headAfterRefusal) state.headSha = state.headAfterRefusal;
      save(state);
      process.stdout.write(JSON.stringify({ message }));
      process.stderr.write("gh: " + message + " (HTTP " + status + ")\\n");
      process.exit(1);
    };
    const forced = state.forcedStatuses.length ? state.forcedStatuses.shift() : 200;
    if (forced !== 200) return refuse(forced, forced === 429 ? "API rate limit exceeded" : "Refused");
    if (fps.some((fp) => state.rejectFingerprints.includes(fp))) {
      return refuse(422, "Unprocessable Entity: Line could not be resolved");
    }
    state.posts.push({ body: payload.body, fingerprints: fps, commit_id: payload.commit_id });
    payload.comments.forEach((c, i) => {
      state.threads.push({
        id: "T_" + (state.threads.length + 1),
        isResolved: false,
        path: c.path,
        comments: { nodes: [{
          databaseId: 1000 + state.threads.length,
          body: c.body,
          url: "https://github.com/mission/control/pull/1#discussion_r" + (1000 + state.threads.length),
          createdAt: "2026-10-15T00:00:00Z",
          author: { login: "operator" }
        }] }
      });
    });
    state.reviews.push({ body: payload.body, author: { login: "operator" }, commit: { oid: payload.commit_id } });
    save(state);
    process.stdout.write("{}");
  });
} else if (args.includes("--jq") && args.includes(".head.sha")) {
  const state = load();
  state.headReads += 1;
  save(state);
  process.stdout.write(state.headSha + "\\n");
} else if (args.some((arg) => /repos\\/mission\\/control\\/pulls\\/\\d+$/.test(arg))) {
  process.stdout.write([
    "diff --git a/src/example.ts b/src/example.ts",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1 +1 @@",
    "-export const value = 1;",
    "+export const value = 2;",
    ""
  ].join("\\n"));
} else {
  process.stderr.write("unexpected fake gh invocation: " + JSON.stringify(args));
  process.exit(2);
}
`,
);
chmodSync(ghPath, 0o755);

const { openDb, getInspectorPr, loadInspectorComments, updateInspectorPr, upsertInspectorComment } =
  await import("../src/server/db.ts");
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { adoptPr, startInspector } = await import("../src/server/inspector/worker.ts");
const { resetAuthenticatedLogin } = await import("../src/server/inspector/github.ts");

interface FakeGithubState {
  headSha: string;
  headAfterRefusal: string | null;
  forcedStatuses: number[];
  rejectFingerprints: string[];
  threads: unknown[];
  reviews: { body: string; author: { login: string }; commit: { oid: string } }[];
  attempts: { body: string; fingerprints: string[]; commit_id: string }[];
  posts: { body: string; fingerprints: string[]; commit_id: string }[];
  refusals: { status: number; fingerprints: string[] }[];
  headReads: number;
  sweeps: number;
}

function writeGithubState(state: Partial<FakeGithubState> = {}): void {
  const full: FakeGithubState = {
    headSha: "head-1",
    headAfterRefusal: null,
    forcedStatuses: [],
    rejectFingerprints: [],
    threads: [],
    reviews: [],
    attempts: [],
    posts: [],
    refusals: [],
    headReads: 0,
    sweeps: 0,
    ...state,
  };
  const tmp = `${statePath}.seed.tmp`;
  writeFileSync(tmp, JSON.stringify(full, null, 2));
  renameSync(tmp, statePath);
}

function readGithubState(): FakeGithubState {
  return JSON.parse(readFileSync(statePath, "utf8")) as FakeGithubState;
}

function reviewCount(): number {
  return Number(readFileSync(reviewCountPath, "utf8"));
}

let stopAtSweepEnd: (() => void) | null = null;
function registryStub(): Registry {
  return {
    onPrOpened: () => () => {},
    onPipelineRun: () => () => {},
    refreshInspections: () => { stopAtSweepEnd?.(); },
    snapshot: () => ({ sessions: [] }),
  } as unknown as Registry;
}

/** One full sweep of the real loop, stopped at its end so nothing runs under the next case. */
async function runOneSweep(): Promise<void> {
  let stop = () => {};
  const finished = new Promise<void>((resolve) => {
    stopAtSweepEnd = () => { stop(); stopAtSweepEnd = null; resolve(); };
  });
  stop = startInspector(registryStub());
  await finished;
}

function adopt(number: number): string {
  const key = `mission/control#${number}`;
  assert.equal(
    adoptPr(
      `https://github.com/mission/control/pull/${number}`,
      { sessionId: null, cwd: project, repoRoot: project },
      "hook",
      Date.now(),
    ),
    true,
  );
  return key;
}

function goLive(): void {
  setInspectorConfig({ enabled: true, mode: "live", repoAllowlist: [project], maxCommentsPerRound: 8 });
}

function byTitle(key: string): Map<string, InspectorComment> {
  return new Map(loadInspectorComments(key).map((r) => [r.title, r]));
}

beforeEach(() => {
  openDb().exec("DELETE FROM inspector_prs; DELETE FROM inspector_comments; DELETE FROM app_config");
  resetAuthenticatedLogin();
  delete process.env.FAKE_FIRST_FINDINGS;
  writeFileSync(reviewCountPath, "0");
  setShippingConfig({ autoMerge: false });
});

after(() => {
  restoreTransport();
  rmSync(temp, { recursive: true, force: true });
});

test("reproduction: findings drafted in dry run are posted by the forced re-review after a switch to live", async () => {
  // 1. In dry run, one round drafts two findings.
  process.env.FAKE_FIRST_FINDINGS = JSON.stringify([
    { path: "src/example.ts", line: 1, title: "First drafted finding", body: "Needs attention.", severity: "major" },
    { path: "src/example.ts", line: 1, title: "Second drafted finding", body: "Also this.", severity: "minor" },
  ]);
  writeGithubState();
  setInspectorConfig({ enabled: true, mode: "dry-run", repoAllowlist: [project], maxCommentsPerRound: 8 });
  const key = adopt(701);
  await runOneSweep();
  assert.equal(reviewCount(), 1, "the dry-run round reviewed the head");
  assert.equal(readGithubState().posts.length, 0, "dry run posts nothing");
  assert.deepEqual(loadInspectorComments(key).map((r) => r.status), ["drafted", "drafted"]);
  assert.equal(getInspectorPr(key)?.reviewPosture, "dry-run");

  // 2. The config switches to live, on an allowlisted repository.
  goLive();

  // 3. The next tick forces a re-review of the same head. The fake model raises nothing new
  //    and resolves nothing, as the prompt asks of a finding it has already raised.
  await runOneSweep();
  const state = readGithubState();
  const rows = loadInspectorComments(key);
  console.log(JSON.stringify({
    reviews: reviewCount(),
    reviewPosture: getInspectorPr(key)?.reviewPosture,
    reviewedHead: getInspectorPr(key)?.headSha,
    posts: state.posts.map((p) => p.fingerprints.length),
    rows: rows.map((r) => ({ title: r.title, status: r.status, postedAt: r.postedAt })),
  }));
  assert.equal(reviewCount(), 2, "the switch to live forced a second review of the same head");
  assert.equal(getInspectorPr(key)?.reviewPosture, "live");

  // 4. The drafts were posted, in one review, and stamped.
  assert.equal(state.posts.length, 1, "one review carried the drafted findings");
  assert.equal(state.posts[0]!.fingerprints.length, 2);
  for (const row of rows) {
    assert.equal(row.status, "open", `${row.title} reached GitHub`);
    assert.ok(row.postedAt != null, `${row.title} is stamped posted`);
  }
});
