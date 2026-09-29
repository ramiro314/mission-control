import assert from "node:assert/strict";
import { test } from "node:test";
import { REVIEW_PROMPT_CAPS, buildReplyPrompt, buildReviewPrompt } from "../src/server/inspector/prompt.ts";
import { InspectorReplySchema } from "../src/server/inspector/verdict.ts";
import type { ReplyPromptInput, ReviewPromptInput } from "../src/server/inspector/prompt.ts";
import type { StandardsBundle } from "../src/server/standards.ts";
import type { InspectorComment, InspectorSeverity } from "../src/shared/types.ts";

// The review prompt embeds four inputs nothing upstream bounds: the PR title, the PR
// body, the changed-path list and the open-findings ledger. At the ledger's own ceiling
// (2000 fingerprints) the open section alone is ~348 KB, and the combined worst case was
// measured at ~944 KB - ~255k tokens on a call that may run twice. These tests drive
// each input far past its cap and check two things the caps must provide: the prompt
// stays bounded, and every cut is ANNOUNCED, because a silent cut reads as "that is
// everything" - and for changed paths it would make the model discard its own real
// findings on the cut files.

function openRow(i: number, severity: InspectorSeverity): InspectorComment {
  return {
    id: `id-${i}`,
    prKey: "owner/repo#1",
    fingerprint: `fp${String(i).padStart(10, "0")}`,
    path: `src/server/somewhere/rather/deep/module-${i}.ts`,
    line: 42,
    // Worst case the verdict schema allows: clampTo(120) on the title.
    title: `finding ${i} `.padEnd(120, "x"),
    body: "detail",
    severity,
    round: 1 + (i % 5),
    status: "open",
    replies: 0,
    answeredCommentId: null,
    createdAt: i,
    updatedAt: i,
  };
}

function standardsDoc(i: number): StandardsBundle["docs"][number] {
  return {
    path: `pkg${i}/AGENTS.md`,
    realPath: `pkg${i}/AGENTS.md`,
    text: "s".repeat(21 * 1024),
    truncated: true,
  };
}

function input(over: Partial<ReviewPromptInput> = {}): ReviewPromptInput {
  return {
    brief: { text: "Review with care.", source: "repo", truncated: false },
    standards: { docs: [], truncated: false },
    prTitle: "Fix the thing",
    prBody: "A short description.",
    diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    diffTruncated: false,
    changedPaths: ["src/a.ts"],
    open: [],
    round: 1,
    ...over,
  };
}

test("an oversized title is clipped and says so", () => {
  const prompt = buildReviewPrompt(input({ prTitle: "t".repeat(REVIEW_PROMPT_CAPS.titleChars * 10) }));
  const titleLine = prompt.split("\n").find((l) => l.startsWith("title: "));
  assert.ok(titleLine);
  assert.ok(titleLine.endsWith("(title truncated)"));
  assert.ok(titleLine.length < REVIEW_PROMPT_CAPS.titleChars + 50);

  const short = buildReviewPrompt(input());
  assert.ok(!short.includes("(title truncated)"));
});

test("an oversized description is clipped and the cut is announced", () => {
  const body = "a".repeat(REVIEW_PROMPT_CAPS.bodyChars) + "NEVER-IN-PROMPT";
  const prompt = buildReviewPrompt(input({ prBody: body }));
  assert.ok(prompt.includes("The description is TRUNCATED for length"));
  assert.ok(!prompt.includes("NEVER-IN-PROMPT"));

  const short = buildReviewPrompt(input());
  assert.ok(!short.includes("The description is TRUNCATED"));
});

test("the changed-path list is capped, counted out, and the discard rule softens", () => {
  const paths = Array.from({ length: 3000 }, (_, i) => `src/dir${i}/file${i}.ts`);
  const prompt = buildReviewPrompt(input({ changedPaths: paths }));
  assert.ok(prompt.includes("2000 more changed files are not shown"));
  assert.ok(prompt.includes(`- src/dir${REVIEW_PROMPT_CAPS.changedPathRows - 1}/`));
  assert.ok(!prompt.includes(`- src/dir${REVIEW_PROMPT_CAPS.changedPathRows}/`));
  // The hard rule would be a lie against an incomplete list - the model would silently
  // drop real findings on the cut files - so it must be replaced, not merely prefixed.
  assert.ok(!prompt.includes("A finding that does not name one of these will be discarded."));
  assert.ok(prompt.includes("still fair to raise"));

  const short = buildReviewPrompt(input());
  assert.ok(short.includes("A finding that does not name one of these will be discarded."));
  assert.ok(!short.includes("more changed files are not shown"));
});

test("open findings keep the most severe, newest first, and announce the omitted", () => {
  // 1990 nits then 10 blockers, at the ledger's own ceiling of 2000 rows.
  const open = [
    ...Array.from({ length: 1990 }, (_, i) => openRow(i, "nit")),
    ...Array.from({ length: 10 }, (_, i) => openRow(1990 + i, "blocker")),
  ];
  const prompt = buildReviewPrompt(input({ open }));
  assert.ok(prompt.includes(`the ${REVIEW_PROMPT_CAPS.openRows} most severe of 2000`));
  assert.ok(prompt.includes("1800 omitted simply stay open"));
  // Every blocker survives the cut; the nits kept are the newest, so the oldest is gone.
  for (let i = 1990; i < 2000; i++) assert.ok(prompt.includes(openRow(i, "blocker").fingerprint));
  assert.ok(prompt.includes(openRow(1989, "nit").fingerprint));
  assert.ok(!prompt.includes(openRow(0, "nit").fingerprint));

  const few = buildReviewPrompt(input({ open: [openRow(1, "minor")] }));
  assert.ok(few.includes(openRow(1, "minor").fingerprint));
  assert.ok(!few.includes("TRUNCATED for length: the"));
});

test("the worst-case prompt is pinned, with every truncation announced", () => {
  // Every input at or far past its cap at once. The brief and standards ride at their
  // own upstream caps (MAX_BRIEF_BYTES = 24 KB, MAX_TOTAL_BYTES = 64 KB); the diff is
  // capped upstream by MAX_DIFF_BYTES and rides on top of this pin, so it is small
  // here. Budget for what the builder itself owns: ~3 KB fixed text + 24 KB brief +
  // ~66 KB standards + 0.3 KB title + 8 KB body + ~30 KB paths + ~36 KB open rows,
  // ~170 KB in all. The pin at 200k chars (~50k tokens) is what a future uncapped or
  // widened field has to break to ship - the measured unbounded worst case was ~944 KB.
  const prompt = buildReviewPrompt(
    input({
      brief: { text: "b".repeat(24 * 1024), source: "repo", truncated: true },
      standards: {
        docs: Array.from({ length: 3 }, (_, i) => standardsDoc(i)),
        truncated: true,
      },
      prTitle: "t".repeat(REVIEW_PROMPT_CAPS.titleChars * 10),
      prBody: "b".repeat(65536),
      changedPaths: Array.from({ length: 5000 }, (_, i) => `src/dir${i}/file${i}.ts`),
      open: Array.from({ length: 2000 }, (_, i) =>
        openRow(i, (["blocker", "major", "minor", "nit"] as const)[i % 4] ?? "nit"),
      ),
      diff: "d".repeat(1024),
      diffTruncated: true,
    }),
  );
  assert.ok(prompt.length < 200_000, `worst-case prompt is ${prompt.length} chars`);
  // Every cut is visible to the model. Silent truncation is the defect, not size alone.
  assert.ok(prompt.includes("(title truncated)"));
  assert.ok(prompt.includes("The description is TRUNCATED for length"));
  assert.ok(prompt.includes("4000 more changed files are not shown"));
  assert.ok(prompt.includes("1800 omitted simply stay open"));
  assert.ok(prompt.includes("Some standards documents were omitted for length."));
  assert.ok(prompt.includes("## The diff (TRUNCATED for length"));
});

// The reply prompt carries a MACHINE contract now, not just prose. Its `resolved` field is
// the only thing that can close a finding the Inspector drops in conversation, and the
// worker parses the answer with `InspectorReplySchema` - so a prompt that stopped asking
// for the object, or asked for a different shape, would silently return the subsystem to
// the defect this contract was added for: the Inspector says "dropping the finding" and the
// ledger goes on blocking the merge over it.

function replyInput(over: Partial<ReplyPromptInput> = {}): ReplyPromptInput {
  return {
    brief: { text: "Review carefully.", source: "default", truncated: false },
    original: { path: "src/example.ts", title: "Prior issue", body: "the original comment" },
    thread: [
      { author: "operator", ours: true, body: "the original comment" },
      { author: "author", ours: false, body: "handled by the guard above" },
    ],
    diff: "diff --git a/src/example.ts b/src/example.ts",
    diffTruncated: false,
    ...over,
  };
}

test("the reply prompt asks for the object the worker parses, and says what closes a finding", () => {
  const prompt = buildReplyPrompt(replyInput());

  // The shape, and an answer that validates against the schema the worker actually uses.
  assert.ok(prompt.includes('"reply"'), "the comment text is asked for by name");
  assert.ok(prompt.includes('"resolved": true | false'), "and so is the judgment");
  assert.equal(
    InspectorReplySchema.safeParse({ reply: "You are right.", resolved: true }).success,
    true,
  );

  // The one instruction that closes the gap: prose saying "dropping this" is not the act.
  assert.ok(
    prompt.includes(
      "Saying you are dropping the finding in the reply text does NOT\nclose it; this field does",
    ),
    "the prompt must separate saying it from doing it",
  );
  assert.ok(prompt.includes("False is the safe answer."), "the default is stated as safe");

  // Trailing, for recency - the review prompt does the same with its own contract.
  assert.ok(
    prompt.trimEnd().endsWith("False is the safe answer."),
    "the output contract is the last thing the model reads",
  );

  // The untrusted halves are still fenced, and the reply is still told it is public.
  assert.ok(prompt.includes("<reply from author>"));
  assert.ok(prompt.includes("<inspector>"));
  assert.ok(prompt.includes("Your reply is PUBLIC"));
});

test("the reply prompt marks a truncated diff, so absence is never read as evidence", () => {
  assert.ok(buildReplyPrompt(replyInput({ diffTruncated: true })).includes("## The diff (truncated)"));
  assert.ok(buildReplyPrompt(replyInput()).includes("## The diff"));
});

// ---- CI's flake report ------------------------------------------------------------------
//
// The Inspector reads the "Flaky tests" check's report for the head it reviews. Flakes are
// informational: the policy says to raise one only when the pull request plausibly caused it,
// and the list is fenced as untrusted data and capped like every other input.

function flakeReport(count: number, omitted = 0): NonNullable<ReviewPromptInput["flakeSummary"]> {
  const flakes = Array.from({ length: count }, (_, i) => ({
    key: `key${i}`,
    runner: "junit",
    file: `test/flaky-${i}.test.ts`,
    name: `suite > flaky ${i}`,
    message: `timed out\n  at line ${i} `.padEnd(1000, "m"),
    job: "unit (node 24, shard 1/6)",
  }));
  return {
    version: 1,
    commit: "abc",
    ref: "feature",
    pullRequest: 1,
    runUrl: "https://github.com/owner/repo/actions/runs/1",
    flakes,
    failures: [],
    errors: [],
    issues: flakes.map((flake, i) => ({
      key: flake.key,
      number: 100 + i,
      url: `https://github.com/owner/repo/issues/${100 + i}`,
      occurrences: 2,
      actionable: false,
    })),
    ...(omitted > 0 ? { omitted: { flakes: omitted, failures: 0 } } : {}),
  };
}

test("no flake report, or one with no flakes, adds no flake section", () => {
  assert.doesNotMatch(buildReviewPrompt(input()), /Flaky tests in CI/);
  assert.doesNotMatch(buildReviewPrompt(input({ flakeSummary: null })), /Flaky tests in CI/);
  assert.doesNotMatch(buildReviewPrompt(input({ flakeSummary: flakeReport(0) })), /Flaky tests in CI/);
});

test("flakes are fenced as data, compact, linked to their history, and informational", () => {
  const prompt = buildReviewPrompt(input({ flakeSummary: flakeReport(1) }));
  assert.match(prompt, /## Flaky tests in CI/);
  assert.match(prompt, /Flakes are informational/);
  assert.match(prompt, /ONLY when its test file is one this pull request changed/);
  const fenced = prompt.slice(prompt.indexOf("<flaky-tests>"), prompt.indexOf("</flaky-tests>"));
  assert.match(fenced, /- suite > flaky 0 - test\/flaky-0\.test\.ts in unit \(node 24, shard 1\/6\) - history: https:\/\/github\.com\/owner\/repo\/issues\/100/);
  // The message is flattened to one line and cut, and says it was.
  assert.match(fenced, /timed out at line 0 m+ \(truncated\)/);
  // Before the diff, which stays last so the output contract keeps its recency.
  assert.ok(prompt.indexOf("## Flaky tests in CI") < prompt.indexOf("## The diff"));
});

test("the flake list is capped and the cut is announced", () => {
  const prompt = buildReviewPrompt(input({ flakeSummary: flakeReport(REVIEW_PROMPT_CAPS.flakeRows + 5, 7) }));
  assert.equal((prompt.match(/^- suite > flaky /gm) ?? []).length, REVIEW_PROMPT_CAPS.flakeRows);
  assert.match(prompt, /TRUNCATED: 12 more flaky tests are not listed/);
  assert.ok(prompt.length < 20_000, `flake section grew the prompt to ${prompt.length} chars`);
});
