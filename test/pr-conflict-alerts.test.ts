import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectAlerts,
  PR_CONFLICT_REALERT_MS,
  type AlertMemory,
  type AlertScope,
} from "../src/shared/alerts.ts";
import type { BlockedPr } from "../src/shared/types.ts";

// The `pr-conflict` alert over successive `blocked_prs` snapshots, with the browser's
// page-lifetime memory and an injected clock.

const URL = "https://github.com/acme/app/pull/31";

function mkBlocked(over: Partial<BlockedPr> = {}): BlockedPr {
  return {
    url: URL,
    repo: "acme/app",
    number: 31,
    baseRef: "main",
    headSha: "abc",
    since: 0,
    reason: "foreman-cannot-nudge",
    taskId: "task-1",
    taskTitle: "Rename the field",
    sessionId: "s1",
    sessionName: "the agent",
    ...over,
  };
}

function scope(blockedPrs: BlockedPr[]): AlertScope {
  return { sessions: [], tasks: [], blockedPrs };
}

/** Feeds successive snapshots through one memory, as `useNotifier` does for a page. */
function page() {
  const memory: AlertMemory = { alertedPrConflicts: new Map(), now: 0 };
  let prev = scope([]);
  return {
    memory,
    at(now: number, blocked: BlockedPr[]) {
      memory.now = now;
      const next = scope(blocked);
      const alerts = detectAlerts(prev, next, memory).filter((a) => a.kind === "pr-conflict");
      prev = next;
      return alerts;
    },
  };
}

test("pr-conflict fires once when a PR enters the blocked set, naming the PR", () => {
  const p = page();
  const alerts = p.at(1_000, [mkBlocked()]);
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0], {
    id: `pr-conflict:${URL}`,
    kind: "pr-conflict",
    title: "acme/app #31 has merge conflicts",
    body: "Conflicts with main: Foreman can't drive this session",
    sessionId: "s1",
    severity: "attention",
  });
  assert.deepEqual(p.at(2_000, [mkBlocked()]), [], "staying blocked does not re-fire");
});

test("a reason change while the PR stays blocked does not re-fire", () => {
  const p = page();
  assert.equal(p.at(1_000, [mkBlocked()]).length, 1);
  assert.deepEqual(p.at(2_000, [mkBlocked({ reason: "session-gone", sessionId: null })]), []);
});

test("leaving and re-entering within 5 minutes does not fire", () => {
  const p = page();
  assert.equal(p.at(0, [mkBlocked()]).length, 1);
  p.at(10_000, []);
  assert.deepEqual(p.at(10_000 + PR_CONFLICT_REALERT_MS - 1, [mkBlocked()]), []);
});

test("re-entering after 5 or more minutes absent fires again, with the same id", () => {
  const p = page();
  const [first] = p.at(0, [mkBlocked()]);
  p.at(10_000, []);
  const again = p.at(10_000 + PR_CONFLICT_REALERT_MS, [mkBlocked()]);
  assert.equal(again.length, 1);
  assert.equal(again[0]!.id, first!.id, "a repeat replaces its toast");
});

test("absence is measured from when the PR left, not from when it entered", () => {
  const p = page();
  assert.equal(p.at(0, [mkBlocked()]).length, 1);
  // Blocked for an hour with no other change, then out for a minute: not a new conflict.
  p.at(60 * 60_000, []);
  assert.deepEqual(p.at(61 * 60_000, [mkBlocked()]), []);
});

test("the memory survives a reconnect snapshot that omits the PR", () => {
  const memory: AlertMemory = { alertedPrConflicts: new Map(), now: 1_000 };
  const before = scope([mkBlocked()]);
  assert.equal(detectAlerts(scope([]), before, memory).length, 1);

  // A daemon restart: the reconnect snapshot has no blocked PRs until the first poll.
  memory.now = 60_000;
  const reconnect = scope([]);
  assert.deepEqual(detectAlerts(before, reconnect, memory), []);
  assert.equal(memory.alertedPrConflicts.get(URL), 60_000, "the omission keeps the PR remembered");

  memory.now = 80_000;
  assert.deepEqual(detectAlerts(reconnect, scope([mkBlocked()]), memory), [], "its return is quiet");
});

test("each PR is remembered on its own", () => {
  const p = page();
  const other = mkBlocked({ url: "https://github.com/acme/app/pull/32", number: 32 });
  assert.equal(p.at(0, [mkBlocked()]).length, 1);
  assert.deepEqual(p.at(1_000, [mkBlocked(), other]).map((a) => a.title), ["acme/app #32 has merge conflicts"]);
});

test("entries older than the re-alert window are dropped from the memory", () => {
  const p = page();
  p.at(0, [mkBlocked()]);
  p.at(1_000, []);
  p.at(1_000 + PR_CONFLICT_REALERT_MS, []);
  assert.equal(p.memory.alertedPrConflicts.size, 0);
});

test("a URL that is not a GitHub pull request is named by its URL, without a base", () => {
  const url = "https://git.example.com/pr/9";
  const [alert] = detectAlerts(scope([]), scope([mkBlocked({ url, repo: null, number: null, baseRef: null })]));
  assert.equal(alert!.title, `${url} has merge conflicts`);
  assert.equal(alert!.body, "Foreman can't drive this session");
});
