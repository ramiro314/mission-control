/**
 * What a person reads on a Wait for CI card. A block has no structure of its own - no check
 * list decides it, no requested change carries it - so the sentence IS the outcome, and each
 * code has to render its own reason rather than another code's, an empty line, or the
 * waiting headline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WaitForCiPanel } from "../src/web/workflows/WaitForCiPanel.tsx";
import { WAIT_FOR_CI_BLOCK_SENTENCES, waitForCiHeadline } from "../src/web/workflows/run-model.ts";
import {
  WAIT_FOR_CI_BLOCK_CODES,
  initialWaitForCiState,
  type WaitForCiBlockCode,
  type WaitForCiState,
} from "../src/shared/wait-for-ci.ts";

const HEAD = "c".repeat(40);
const NOW = 10_000_000;

function waiting(over: Partial<WaitForCiState> = {}): WaitForCiState {
  return {
    ...initialWaitForCiState({
      pullRequestKey: "owner/repo#77",
      pullRequestUrl: "https://github.com/owner/repo/pull/77",
      pullRequestNumber: 77,
      expectedHeadOid: HEAD,
      timeoutMinutes: 45,
      now: NOW,
    }),
    ...over,
  };
}

const blocked = (code: WaitForCiBlockCode): WaitForCiState =>
  waiting({ outcome: "blocked", blocked: { code, detail: "machine detail" } });

const render = (state: WaitForCiState): string =>
  renderToStaticMarkup(createElement(WaitForCiPanel, { attempt: { output: state as never }, now: NOW + 12 * 60_000 }));

/** The headline paragraph's text, which is the one line a block renders. */
const headline = (html: string): string =>
  /<p class="wf-run-ci-headline">([^<]*)<\/p>/.exec(html)?.[1]?.replaceAll("&quot;", "\"").replaceAll("&#x27;", "'") ?? "";

// What each sentence must say, in words a person acts on - pinned per code so two sentences
// swapped between codes fail here.
const SAYS: Record<WaitForCiBlockCode, RegExp[]> = {
  ci_flake_report_missing: [/Every CI check passed/, /no "Flaky tests" check appeared/, /start a new round/],
  ci_missing: [/No CI check appeared/, /before the timeout/, /GitHub Inspector is on/],
  ci_timeout: [/still running when the timeout ran out/, /Wait for CI again/],
  ci_pull_request_unknown: [/could not tell which commit to watch/, /Start a new round/],
};

test("every block code renders its own plain reason as the card's headline", () => {
  const seen = new Set<string>();
  for (const code of WAIT_FOR_CI_BLOCK_CODES) {
    const text = headline(render(blocked(code)));
    assert.equal(text, WAIT_FOR_CI_BLOCK_SENTENCES[code], `${code} did not render its own sentence`);
    for (const pattern of SAYS[code]) assert.match(text, pattern, `${code}: ${text}`);
    assert.doesNotMatch(text, /Waiting for CI/, `${code} fell through to the waiting headline`);
    assert.doesNotMatch(text, /ci_|machine detail/, `${code} leaked its code or detail`);
    seen.add(text);
  }
  assert.equal(seen.size, WAIT_FOR_CI_BLOCK_CODES.length, "two block codes share one sentence");
});

test("a blocked card keeps the pull request it was watching and the checks it saw", () => {
  const html = render({
    ...blocked("ci_timeout"),
    checkRuns: [{ name: "e2e", state: "pending", conclusion: null, detailsUrl: null, title: null, summary: null }],
  });
  assert.match(html, /href="https:\/\/github\.com\/owner\/repo\/pull\/77"/);
  assert.match(html, /head cccccccccccc/);
  assert.match(html, /Checks on the head commit \(1\)/);
  assert.match(html, /e2e<\/span> <span class="wf-run-meta">Running/);
  // A block is not a fail or a pass: neither list renders.
  assert.doesNotMatch(html, /Failing checks|flaky test/);
});

test("the other headlines: waiting with elapsed and limit, pass, fail, and disabled", () => {
  assert.equal(
    waitForCiHeadline(waiting(), NOW + 12 * 60_000),
    `Waiting for CI on PR #77 at ${HEAD.slice(0, 12)} · 12 of 45 min.`,
  );
  assert.equal(waitForCiHeadline(waiting({ outcome: "pass" }), NOW), `CI passed on PR #77 at ${HEAD.slice(0, 12)}.`);
  assert.equal(waitForCiHeadline(waiting({ outcome: "fail" }), NOW), `CI failed on PR #77 at ${HEAD.slice(0, 12)}.`);
  assert.match(waitForCiHeadline(waiting({ outcome: "pass", disabled: true }), NOW), /Disabled for this run/);
  // Before the Inspector has read anything, the card says so rather than showing an empty list.
  assert.match(render(waiting()), /GitHub Inspector has not read CI for this head yet/);
});

test("any other attempt renders nothing", () => {
  assert.equal(renderToStaticMarkup(createElement(WaitForCiPanel, { attempt: { output: { outcome: "pass" } as never } })), "");
});

test("one function picks each member kind's chip for every run view", async () => {
  const { memberPipelineStatus } = await import("../src/web/workflows/run-model.ts");
  assert.equal(memberPipelineStatus("wait_for_ci", "waiting").label, "Waiting for CI");
  assert.equal(memberPipelineStatus("wait_for_ci", "error").label, "Blocked");
  assert.equal(memberPipelineStatus("wait_for_ci", "pass").label, "CI passed");
  assert.equal(memberPipelineStatus("check", "pass", { checkOutcome: "skipped" }).label, "Skipped");
  assert.equal(memberPipelineStatus("persona", "fail").label, "Changes requested");
  assert.equal(memberPipelineStatus("session_action", undefined).tone, "waiting");
  // The three views call it rather than keeping their own ternary chains.
  const { readFileSync } = await import("node:fs");
  for (const view of ["RunPipeline.tsx", "WorkflowLadder.tsx", "WorkflowLadderPeek.tsx"]) {
    const source = readFileSync(new URL(`../src/web/workflows/${view}`, import.meta.url), "utf8");
    assert.match(source, /memberPipelineStatus\(/, view);
    assert.doesNotMatch(source, /waitForCiStatus\(|reviewerStatus\(/, `${view} re-derives a member chip`);
  }
});
