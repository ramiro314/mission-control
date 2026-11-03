import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HistorySessionDetail } from "../src/shared/history.ts";
import { HistoryMissionOnlyRecord } from "../src/web/components/history/HistorySessionView.tsx";

/**
 * The Mission Control-only record: a bound session the catalog has no row for. Which note it
 * shows depends on whether the session is running, and its task title is a link only when the
 * dashboard holds that task.
 */

function detail(over: Partial<HistorySessionDetail> = {}): HistorySessionDetail {
  return {
    agent: "claude",
    agentSessionId: "00000000-0000-4000-8000-000000000001",
    catalog: null,
    mission: {
      task: {
        id: "task-1",
        title: "Deleted before indexing",
        kind: "ship",
        status: "done",
        outcome: "merged",
        outcomeUrl: "https://github.com/o/r/pull/4",
        workflowId: null,
        labels: [],
      },
      prUrl: "https://github.com/o/r/pull/4",
      mergedAt: 1,
      branch: "feature-branch",
      repoRoot: "/repos/app",
      missionSessionId: null,
      ledgerCostUsd: 3.1,
    },
    liveSessionId: null,
    ...over,
  };
}

function render(value: HistorySessionDetail, canOpenTask: boolean): string {
  return renderToStaticMarkup(createElement(HistoryMissionOnlyRecord, {
    detail: value,
    onOpenSession: () => {},
    onOpenTask: () => {},
    canOpenTask: () => canOpenTask,
  }));
}

test("a record with no transcript says it was removed before Mission Control indexed it", () => {
  const html = render(detail(), true);
  assert.match(html, /removed before Mission Control indexed it/);
  assert.doesNotMatch(html, /has not indexed its transcript yet/);
  assert.doesNotMatch(html, /Open in Fleet/);
});

test("a record whose session is running says it is not indexed yet, never that it was removed", () => {
  const html = render(detail({ liveSessionId: "sdk:live" }), true);
  assert.match(html, /has not indexed its transcript yet/);
  assert.doesNotMatch(html, /removed before Mission Control indexed it/);
  assert.match(html, /Open in Fleet/);
});

test("the task title is a button only when the dashboard holds the task", () => {
  const held = render(detail(), true);
  assert.match(held, /<button[^>]*class="history-task-link"[^>]*>Deleted before indexing<\/button>/);
  const notHeld = render(detail(), false);
  assert.doesNotMatch(notHeld, /history-task-link/);
  assert.match(notHeld, /<dd><span>Deleted before indexing<\/span><\/dd>/);
});
