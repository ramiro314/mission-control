import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BlockedPr } from "../src/shared/types.ts";
import type { PipelineRun } from "../src/shared/pipeline.ts";
import { conflictingFor, foldAttention } from "../src/web/lib/attention.ts";
import { AttentionInbox } from "../src/web/components/AttentionInbox.tsx";
import { mkSession } from "./helpers/session-fixture.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

// The Blocked pull requests section: a conflicting PR the daemon's conflict episodes found
// nothing handling. The daemon decides membership and the reason; the fold only places rows.

function mkBlocked(over: Partial<BlockedPr> = {}): BlockedPr {
  return {
    url: "https://github.com/acme/app/pull/31",
    repo: "acme/app",
    number: 31,
    baseRef: "main",
    headSha: "abc",
    since: 1_000,
    reason: "foreman-cannot-nudge",
    taskId: "task-1",
    taskTitle: "Rename the field",
    sessionId: "s1",
    sessionName: "the agent",
    ...over,
  };
}

const halted = {
  provider: "ai-conductor",
  repoRoot: "/repo",
  slug: "halted-feature",
  worktree: null,
  tier: "L",
  track: "technical",
  steps: [],
  lastStep: null,
  halt: { class: "needs-human", reason: "stopped" },
  group: "halted",
  prUrl: null,
  costTokens: null,
  updatedAt: 5,
} as unknown as PipelineRun;

test("blocked pull requests sit after Pipeline halts and before the blocked-session backstop", () => {
  const result = foldAttention({
    sessions: [mkSession({ id: "amber", state: "awaiting_input" })],
    reviews: [],
    ensembles: [],
    pipelineRuns: [halted],
    blockedPrs: [mkBlocked()],
  });
  assert.deepEqual(
    result.items.map((item) => item.kind),
    ["pipeline_halt", "blocked_pr", "session_blocked"],
  );
});

test("each blocked pull request is one answer owed, oldest conflict first", () => {
  const later = mkBlocked({ url: "https://github.com/acme/app/pull/40", number: 40, since: 9_000 });
  const result = foldAttention({
    sessions: [],
    reviews: [],
    ensembles: [],
    blockedPrs: [later, mkBlocked()],
  });
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["blocked-pr:https://github.com/acme/app/pull/31", "blocked-pr:https://github.com/acme/app/pull/40"],
  );
});

test("a fleet with no blocked pull request folds as it always did", () => {
  assert.deepEqual(foldAttention({ sessions: [], reviews: [], ensembles: [] }), { items: [], total: 0 });
});

test("the row says how long the PR has conflicted", () => {
  assert.equal(conflictingFor(0, 30_000), "Conflicting for 0m");
  assert.equal(conflictingFor(0, 7 * 60_000 + 59_000), "Conflicting for 7m");
  assert.equal(conflictingFor(0, 125 * 60_000), "Conflicting for 2h 5m");
});

function render(prs: BlockedPr[]): string {
  return renderToStaticMarkup(
    withOverlayHost(
      createElement(AttentionInbox, {
        fold: foldAttention({ sessions: [], reviews: [], ensembles: [], blockedPrs: prs }),
        onClose: () => {},
        onOpenEnsemble: () => {},
        onOpenSession: () => {},
      }),
    ),
  );
}

test("the row names the PR, repository, base, owner and why it needs you, with both links", () => {
  const html = render([mkBlocked({ since: Date.now() - 4 * 60_000 })]);
  assert.match(html, /Blocked pull requests/);
  assert.match(html, /acme\/app #31/);
  assert.match(html, /into main · Rename the field/);
  assert.match(html, /Foreman can&#x27;t drive this session/);
  assert.match(html, /Conflicting for 4m/);
  assert.match(html, /href="https:\/\/github\.com\/acme\/app\/pull\/31"[^>]*>Open PR</);
  assert.match(html, />Open session</);
});

test("a row whose session is gone says so and offers no session link", () => {
  const html = render([mkBlocked({ reason: "session-gone", sessionId: null, sessionName: null })]);
  assert.match(html, /session ended/);
  assert.doesNotMatch(html, />Open session</);
});
