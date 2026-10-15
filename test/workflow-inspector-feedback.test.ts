import { test } from "node:test";
import assert from "node:assert/strict";
import { renderInspectorFeedback } from "../src/server/workflows/feedback.ts";
import { WORKFLOW_LIMITS } from "../src/shared/workflow.ts";
import type { InspectorComment } from "../src/shared/types.ts";

// What is at stake: a repair delivery is an immutable instruction packet. Ordering,
// deduplication, fallback text, and hashing must not depend on a later ledger read.
function finding(
  fingerprint: string,
  severity: InspectorComment["severity"],
  over: Partial<InspectorComment> = {},
): InspectorComment {
  return {
    id: fingerprint,
    prKey: "owner/repo#12",
    fingerprint,
    path: "src/file.ts",
    line: 10,
    title: `${severity} title`,
    body: `${severity} detail`,
    severity,
    round: 3,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function render(
  findings: InspectorComment[],
  policy: "restart_workflow" | "inspector_only" = "restart_workflow",
  workflowEvidence = true,
) {
  return renderInspectorFeedback({
    workflowName: "Release review",
    workflowVersion: 4,
    runId: "run-1",
    submissionRound: 2,
    originalGoal: "Ship the safe change",
    prUrl: "https://github.com/owner/repo/pull/12",
    targetHeadSha: "a".repeat(40),
    inspectorRound: 3,
    reviewPosture: "live",
    policy,
    findings,
    workflowEvidence,
  });
}

test("Inspector feedback is severity ordered, fingerprint deduplicated, and stable", () => {
  const rows = [
    finding("minor", "minor"),
    finding("blocker", "blocker", { path: "z.ts" }),
    finding("major", "major"),
    finding("nit", "nit"),
    finding("major", "major", { title: "duplicate wording must not win" }),
  ];
  const first = render(rows);
  const second = render([...rows].reverse());
  assert.equal(first.payloadSha256, second.payloadSha256);
  assert.equal(first.payload, second.payload);
  assert.equal(first.failedPersonaCount, 4);
  assert.ok(first.payload.indexOf("BLOCKER") < first.payload.indexOf("MAJOR"));
  assert.ok(first.payload.indexOf("MAJOR") < first.payload.indexOf("MINOR"));
  assert.ok(first.payload.indexOf("MINOR") < first.payload.indexOf("NIT"));
  assert.equal(first.payload.match(/Fingerprint: major/g)?.length, 1);
  // These rows predate `postedAt`, as an older snapshot would: an open row is still on GitHub.
  assert.match(first.payload, /Location: src\/file\.ts:10\nPosted on GitHub \(link not captured yet\)\nminor detail/);
  assert.match(first.payload, /Original user goal:\nShip the safe change/);
  assert.match(first.payload, /Pinned head: a{40}/);
  assert.match(first.payload, /Do not push or open a pull request on your own initiative/);
  assert.match(first.payload, /Once this task's pull request exists, you may push to update it/);
  assert.doesNotMatch(first.payload, /already authorized you to commit the scoped work/);
  assert.match(first.payload, /already authorized `submit_workflow_evidence`/);
  assert.match(first.payload, /do not ask the human to resubmit the workflow/);
});

test("scrubbed detail and legacy fallback are frozen with published policy wording", () => {
  const packet = render([
    finding("scrubbed", "major", { body: "Token: [REDACTED]\u0007" }),
    finding("legacy", "minor", { body: null, path: null, line: null }),
  ], "inspector_only");
  assert.match(packet.payload, /Token: \[REDACTED\]/);
  assert.doesNotMatch(packet.payload, /\u0007/);
  assert.match(packet.payload, /Legacy finding detail is unavailable/);
  assert.match(packet.payload, /permits bypassing Personas only for this GitHub Inspector repair/);
  assert.match(packet.payload, /commit and push a new head/);
});

test("field and packet caps retain a deterministic hash and truncation notice", () => {
  const huge = "ø".repeat(200_000);
  const first = render([finding("huge", "blocker", { title: huge, body: huge })]);
  const second = render([finding("huge", "blocker", { title: huge, body: huge })]);
  assert.equal(first.truncated, true);
  assert.equal(first.payloadSha256, second.payloadSha256);
  assert.equal(first.payload, second.payload);
  assert.match(first.payload, /Workflow repair packet truncated deterministically/);
  assert.match(first.payload, /do not ask the human to resubmit the workflow/);
  assert.ok(Buffer.byteLength(first.payload, "utf8") <= WORKFLOW_LIMITS.feedbackPayloadBytes);
  // The one finding that cannot fit whole is shortened inside its body, never cut off
  // before its fingerprint by the packet's final clip.
  assert.match(first.payload, /\nFingerprint: huge\n\n## Mission Control execution authorization/);
  assert.equal(first.failedPersonaCount, 1);
});

// The marker table itself is pinned in `inspector-findings-text.test.ts`; this pins that the
// packet carries it inside each finding, between location and body.
test("each finding says whether it is on GitHub", () => {
  const packet = render([
    finding("posted", "blocker", {
      postedAt: 5,
      githubUrl: "https://github.com/owner/repo/pull/12#discussion_r1",
    }),
    finding("draft", "major", { status: "drafted", postedAt: null, githubUrl: null }),
    finding("again", "minor", {
      status: "drafted",
      postedAt: 5,
      githubUrl: "https://github.com/owner/repo/pull/12#discussion_r2",
    }),
  ]);
  assert.ok(packet.payload.includes([
    "## BLOCKER - blocker title",
    "Location: src/file.ts:10",
    "Posted on GitHub: https://github.com/owner/repo/pull/12#discussion_r1",
    "blocker detail",
    "Fingerprint: posted",
  ].join("\n")));
  assert.match(packet.payload, /## MAJOR - major title\nLocation: src\/file\.ts:10\nNot posted on GitHub\. This message is the only copy\.\nmajor detail/);
  assert.match(packet.payload, /## MINOR - minor title\nLocation: src\/file\.ts:10\nNot posted again\. An earlier version was posted on GitHub: https:\/\/github\.com\/owner\/repo\/pull\/12#discussion_r2\n/);
  assert.equal(packet.payload.match(/only copy/g)?.length, 1);
});

test("past the payload limit the packet drops whole findings, says how many, and counts all of them", () => {
  const severities = ["blocker", "major", "minor", "nit"] as const;
  const rows = Array.from({ length: 40 }, (_, index) =>
    finding(`fp-${String(index).padStart(2, "0")}`, severities[index % 4]!, { body: "d".repeat(300) }));
  const packet = render(rows);
  const listed = packet.payload.match(/^Fingerprint: /gm)?.length ?? 0;
  assert.ok(Buffer.byteLength(packet.payload, "utf8") <= WORKFLOW_LIMITS.feedbackPayloadBytes);
  assert.ok(listed > 0 && listed < 40);
  assert.equal(packet.failedPersonaCount, 40, "the failed count stays the total, not the number shown");
  assert.equal(packet.truncated, false);
  assert.doesNotMatch(packet.payload, /Workflow repair packet truncated deterministically/);
  assert.equal(packet.payload.match(/d{300}/g)?.length, listed, "a listed finding was clipped mid-text");
  assert.match(
    packet.payload,
    new RegExp(`\\nFingerprint: \\S+\\n\\n${40 - listed} more unresolved findings are not listed here, to keep this message short\\. They stay open and come back in the next relay\\.\\n\\n## Mission Control execution authorization`),
  );
  // Header and closing are the packet's own, and both survive the budget.
  assert.match(packet.payload, /^GitHub Inspector reviewed the pinned pull request head/);
  assert.match(packet.payload, /GitHub Inspector round: 3\nReview posture: live\n\n## BLOCKER/);
  assert.ok(packet.payload.endsWith("Fix the findings, verify the work, then commit and push it."));
  assert.doesNotMatch(packet.payload, /^## NIT/m, "a nit was kept while a higher severity was dropped");
});

test("Inspector feedback omits evidence-tool authority when the pinned graph has no Persona", () => {
  const packet = render([finding("major", "major")], "restart_workflow", false);
  assert.doesNotMatch(packet.payload, /submit_workflow_evidence/);
  assert.match(packet.payload, /do not ask the human to resubmit the workflow/);
});
