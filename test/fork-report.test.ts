import assert from "node:assert/strict";
import test from "node:test";
import {
  featureStatus,
  intentSentence,
  renderForkReport,
  type ReportData,
  type ReportIssue,
  type ReportPr,
} from "../scripts/fork-report.mjs";

// What is at stake: a fork status doc that misreports where the fork stands against upstream,
// or lists work that never reached `main`. Every fixture is hand-built; nothing reaches GitHub.

const REPO = "https://github.com/ramiro314/mission-control";
const MERGE_BASE = "2012e91bf7a1b398a04eb099957a86ffa8279703";
const UPSTREAM_TIP = "8930afa1715a331ec347c2f8b46dfe8ef7225c3a";
const ORIGIN = "5a48970a1092fa4685123c4c05dfdebaa837d84b";

function issue(number: number, name: string, slug: string, intent: string, extra: Partial<ReportIssue> = {}): ReportIssue {
  return {
    number,
    title: `Fork feature: ${name}`,
    state: "OPEN",
    labels: ["fork-feature", `fork:${slug}`],
    body: `### Intent\n\n${intent}\n\n### Behavior contracts\n\n- a contract`,
    url: `${REPO}/issues/${number}`,
    ...extra,
  };
}

function pr(number: number, extra: Partial<ReportPr> = {}): ReportPr {
  return {
    number,
    title: `PR ${number}`,
    labels: [],
    headRefName: `feat/branch-${number}`,
    baseRefName: "main",
    mergedAt: `2026-09-${String(10 + (number % 20)).padStart(2, "0")}T12:00:00Z`,
    url: `${REPO}/pull/${number}`,
    author: { login: "ramiro314" },
    ...extra,
  };
}

function data(extra: Partial<ReportData> = {}): ReportData {
  return {
    issues: [],
    prs: [],
    windowsPrs: [],
    git: { mergeBase: MERGE_BASE, mergeBaseVersion: "1.26.0", upstreamTip: MERGE_BASE, ahead: 341, aheadNoMerges: 247, behind: 0 },
    measuredAt: { sha: ORIGIN, time: "2026-10-07T15:00Z" },
    ...extra,
  };
}

function row(report: string, field: string): string {
  const line = report.split("\n").find((l) => l.startsWith(`| ${field} |`));
  assert.ok(line, `no "${field}" row in:\n${report}`);
  return line;
}

function section(report: string, heading: string): string {
  const start = report.indexOf(`## ${heading}\n`);
  assert.notEqual(start, -1, `no "## ${heading}" section`);
  const next = report.indexOf("\n## ", start + 1);
  return report.slice(start, next === -1 ? undefined : next);
}

test("the status header reports the merge-base, the newest sync PR and the counts", () => {
  const report = renderForkReport(
    data({
      issues: [issue(300, "Shape tasks", "shape-tasks", "Shape first.")],
      prs: [
        pr(62, { headRefName: "sync/upstream-2026-09-29", title: "chore: sync upstream", mergedAt: "2026-09-29T10:00:00Z" }),
        pr(175, { headRefName: "sync/upstream-2026-10-05", title: "chore: sync upstream 1.26.0", mergedAt: "2026-10-05T18:30:00Z" }),
        pr(4),
      ],
    }),
  );
  assert.equal(row(report, "Last synced upstream"), "| Last synced upstream | **1.26.0**, merge-base `2012e91bf7a1` |");
  assert.equal(row(report, "Last sync PR"), `| Last sync PR | [#175](${REPO}/pull/175) chore: sync upstream 1.26.0, merged 2026-10-05 |`);
  assert.equal(row(report, "Fork commits ahead of upstream"), "| Fork commits ahead of upstream | **341** (247 excluding merge commits) |");
  assert.equal(row(report, "Upstream commits behind"), "| Upstream commits behind | **0** |");
  assert.equal(
    row(report, "Active fork features"),
    "| Active fork features | **1** (0 in progress), plus 0 closed, and 1 standalone fixes |",
  );
  assert.equal(row(report, "Measured at"), "| Measured at | `origin/main` `5a48970a1092`, 2026-10-07T15:00Z |");
});

test("an upstream tip past the merge-base is counted as behind, never reported as synced", () => {
  const report = renderForkReport(
    data({ git: { mergeBase: MERGE_BASE, mergeBaseVersion: "1.26.0", upstreamTip: UPSTREAM_TIP, ahead: 341, aheadNoMerges: 247, behind: 12 } }),
  );
  assert.equal(row(report, "Last synced upstream"), "| Last synced upstream | **1.26.0**, merge-base `2012e91bf7a1` |");
  assert.equal(row(report, "Upstream commits behind"), "| Upstream commits behind | **12** (`upstream/main` at `8930afa1715a`) |");
  assert.equal(row(report, "Last sync PR"), "| Last sync PR | none merged yet |");
});

test("features list active and in-progress issues first, then closed, with intent and ascending PRs", () => {
  const report = renderForkReport(
    data({
      issues: [
        issue(301, "Dependabot", "dependabot", "Keep dependencies current.", {
          state: "CLOSED",
          labels: ["fork-feature", "fork:dependabot", "fork-status:removed"],
        }),
        issue(305, "Decision forms", "decision-forms", "Ask the human in one form. It batches every open\nquestion | at once."),
        issue(303, "CI time-to-green", "ci-time-to-green", "Make CI faster! Then measure it.", {
          labels: ["fork-feature", "fork:ci-time-to-green", "fork-status:in-progress"],
        }),
        issue(304, "Complete frees the worktree", "complete-frees-worktree", "Free it on complete.", {
          state: "CLOSED",
          labels: ["fork-feature", "fork:complete-frees-worktree", "fork-status:superseded"],
        }),
        issue(306, "New feature", "new-feature", ""),
      ],
      prs: [
        pr(30, { labels: ["fork:decision-forms", "fork-delta:applied"] }),
        pr(2, { labels: ["fork:decision-forms"] }),
        pr(28, { labels: ["fork:decision-forms", "fork:ci-time-to-green"] }),
        pr(43, { labels: ["fork:dependabot"], author: { login: "app/dependabot" } }),
        pr(11, { labels: ["fork:complete-frees-worktree"] }),
      ],
    }),
  );
  const features = section(report, "Features").split("\n").filter((l) => l.startsWith("| ["));
  assert.deepEqual(features, [
    `| [CI time-to-green](${REPO}/issues/303) | in-progress | Make CI faster! | [#28](${REPO}/pull/28) |`,
    `| [Decision forms](${REPO}/issues/305) | active | Ask the human in one form. | [#2](${REPO}/pull/2), [#28](${REPO}/pull/28), [#30](${REPO}/pull/30) |`,
    `| [New feature](${REPO}/issues/306) | active |  | none yet |`,
    `| [Dependabot](${REPO}/issues/301) | removed | Keep dependencies current. | [#43](${REPO}/pull/43) |`,
    `| [Complete frees the worktree](${REPO}/issues/304) | superseded | Free it on complete. | [#11](${REPO}/pull/11) |`,
  ]);
  assert.match(
    row(report, "Active fork features"),
    /\*\*3\*\* \(1 in progress\), plus 2 closed, and 0 standalone fixes/,
  );
});

test("standalone fixes exclude labeled, upstream sync and bot-authored PRs", () => {
  const report = renderForkReport(
    data({
      issues: [issue(300, "Decision forms", "decision-forms", "Ask once.")],
      prs: [
        pr(21, { title: "fix: a | pipe" }),
        pr(4, { labels: ["fork-delta:applied"] }),
        pr(6, { labels: ["fork:decision-forms"] }),
        pr(62, { headRefName: "sync/upstream-2026-09-29" }),
        pr(40, { author: { login: "app/dependabot" } }),
        pr(41, { author: { login: "app/github-actions" } }),
      ],
    }),
  );
  const fixes = section(report, "Standalone fixes").split("\n").filter((l) => l.startsWith("| [#"));
  assert.deepEqual(fixes, [
    `| [#4](${REPO}/pull/4) | PR 4 | 2026-09-14 |`,
    `| [#21](${REPO}/pull/21) | fix: a \\| pipe | 2026-09-11 |`,
  ]);
  assert.match(row(report, "Active fork features"), /and 2 standalone fixes \|$/);
});

test("each release/windows merge PR counts only the branch PRs that merge brought into main", () => {
  const branch = (number: number, mergedAt: string) => ({ number, mergedAt });
  const report = renderForkReport(
    data({
      windowsPrs: [
        branch(147, "2026-10-01T00:00:00Z"),
        branch(265, "2026-10-20T00:00:00Z"),
        branch(273, "2026-11-01T09:00:00Z"),
        branch(410, "2026-11-10T00:00:00Z"),
        branch(420, "2026-11-20T00:00:00Z"),
        branch(460, "2026-12-05T00:00:00Z"),
        branch(470, "2026-12-06T00:00:00Z"),
      ],
      issues: [issue(310, "Windows support", "windows-support", "Run on Windows.")],
      prs: [
        pr(128, { labels: ["fork:windows-support"] }),
        pr(450, { labels: ["fork:windows-support"], headRefName: "release/windows", mergedAt: "2026-12-01T00:00:00Z" }),
        pr(400, { labels: ["fork:windows-support"], headRefName: "release/windows", mergedAt: "2026-11-01T09:00:00Z" }),
        pr(480, { labels: ["fork:windows-support"], headRefName: "release/windows", mergedAt: null }),
      ],
    }),
  );
  // #273 merged into the branch at the same instant as #400 and is counted there; #460 and
  // #470 landed after the last merge into main, so no row counts them.
  assert.equal(
    section(report, "Features").split("\n").find((l) => l.startsWith("| [Windows")),
    `| [Windows support](${REPO}/issues/310) | active | Run on Windows. | [#128](${REPO}/pull/128), ` +
      `[#400](${REPO}/pull/400) (includes 3 release/windows PRs), [#450](${REPO}/pull/450) (includes 2 release/windows PRs) |`,
  );
});

test("open PRs and PRs merged only into release/windows never appear", () => {
  const report = renderForkReport(
    data({
      windowsPrs: [{ number: 265, mergedAt: "2026-09-20T00:00:00Z" }],
      issues: [
        issue(310, "Windows support", "windows-support", "Run on Windows.", {
          labels: ["fork-feature", "fork:windows-support", "fork-status:in-progress"],
        }),
      ],
      prs: [
        pr(128, { labels: ["fork:windows-support"] }),
        pr(265, { labels: ["fork:windows-support"], baseRefName: "release/windows" }),
        pr(273, { baseRefName: "release/windows" }),
        pr(290, { labels: ["fork:windows-support"], mergedAt: null }),
        pr(291, { mergedAt: null }),
        pr(292, { mergedAt: null, headRefName: "sync/upstream-2026-10-12" }),
      ],
    }),
  );
  for (const n of [265, 273, 290, 291, 292]) assert.doesNotMatch(report, new RegExp(`#${n}\\b`));
  assert.doesNotMatch(report, /includes/);
  assert.match(report, /\| in-progress \| Run on Windows\. \| \[#128\]/);
  assert.equal(row(report, "Last sync PR"), "| Last sync PR | none merged yet |");
});

test("before the migration there are no features and every merged PR is a standalone fix", () => {
  const report = renderForkReport(data({ prs: [pr(1), pr(2)] }));
  assert.match(section(report, "Features"), /No `fork-feature` tracking issues yet\./);
  assert.match(row(report, "Active fork features"), /\*\*0\*\* \(0 in progress\), plus 0 closed, and 2 standalone fixes/);
  assert.match(renderForkReport(data()), /## Standalone fixes\n\nNone\.\n$/);
});

test("status and intent helpers", () => {
  assert.equal(featureStatus({ state: "OPEN", labels: [] }), "active");
  assert.equal(featureStatus({ state: "OPEN", labels: ["fork-status:in-progress"] }), "in-progress");
  assert.equal(featureStatus({ state: "CLOSED", labels: ["fork-status:upstreamed"] }), "upstreamed");
  assert.equal(featureStatus({ state: "CLOSED", labels: [] }), "closed");
  assert.equal(intentSentence("### Intent\n\nUse `v1.2` here. Then more."), "Use `v1.2` here.");
  assert.equal(intentSentence("### Intent\n\nNo terminal punctuation"), "No terminal punctuation");
  assert.equal(intentSentence("### Behavior contracts\n\n- only contracts"), "");
  assert.equal(intentSentence(null), "");
});
