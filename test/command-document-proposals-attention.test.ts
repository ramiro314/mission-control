import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BlockedPr } from "../src/shared/types.ts";
import type { CommandDocumentProposal } from "../src/shared/command-document.ts";
import { foldAttention } from "../src/web/lib/attention.ts";
import { AttentionInbox } from "../src/web/components/AttentionInbox.tsx";
import { mkSession } from "./helpers/session-fixture.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

// The Proposed Command documents section: an agent's pending proposal for a repository. The
// daemon holds the set; the fold only places one row per proposal and counts it as one answer.

function mkProposal(over: Partial<CommandDocumentProposal> = {}): CommandDocumentProposal {
  return {
    id: "p1",
    repoRoot: "/repos/monorepo",
    document: { version: 1, commands: { lint: [{ path: "", argv: ["yarn", "lint"] }] }, testing: [] },
    proposedAt: 2_000,
    taskId: "task-1",
    taskTitle: "Configure the monorepo",
    sessionId: "s1",
    sessionName: "agent",
    ...over,
  };
}

const blocked = {
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
} as BlockedPr;

test("proposals sit after blocked pull requests and before the blocked-session backstop, oldest first", () => {
  const result = foldAttention({
    sessions: [mkSession({ id: "amber", state: "awaiting_input" })],
    reviews: [],
    ensembles: [],
    blockedPrs: [blocked],
    commandDocumentProposals: [mkProposal({ id: "later", proposedAt: 9_000 }), mkProposal({ id: "earlier", repoRoot: "/repos/a", proposedAt: 3_000 })],
  });
  assert.deepEqual(result.items.map((item) => item.id), [
    `blocked-pr:${blocked.url}`,
    "command-document-proposal:earlier",
    "command-document-proposal:later",
    "blocked:amber",
  ]);
  assert.equal(result.total, 4, "each proposal is one answer owed");
});

test("the row names the repository and who proposed it, and offers the review", () => {
  const html = renderToStaticMarkup(
    withOverlayHost(
      createElement(AttentionInbox, {
        fold: foldAttention({ sessions: [], reviews: [], ensembles: [], commandDocumentProposals: [mkProposal()] }),
        onClose: () => {},
        onOpenEnsemble: () => {},
        onOpenSession: () => {},
      }),
    ),
  );
  assert.match(html, /Proposed Command documents/);
  assert.match(html, /monorepo/);
  assert.match(html, /Configure the monorepo/);
  assert.match(html, /\(1 entry\)/);
  assert.match(html, /Review proposal/);
  assert.match(html, /Nothing is applied until you review it/);
});
