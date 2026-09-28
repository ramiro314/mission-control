import {
  FLAKE_COUNT_MARKER,
  flakeIssueMarker,
  flakeOccurrenceMarker,
  parseFlakeIssueKey,
  parseFlakeOccurrences,
  type FlakeReport,
  type FlakeReportIssue,
  type FlakeReportTest,
} from "@shared/flake-report.ts";
import type { TestingConfig } from "@shared/testing-config.ts";
import type { RunContext } from "./context.ts";
import { GitHubError, type GitHubClient } from "./github.ts";

// Flake history as GitHub issues: one issue per flaky test, one occurrence per CI run.
//
// The action owns the two labels it is configured with. An issue gains the actionable label
// once its occurrences within the window, counted from its most recent reopen, reach the
// threshold. The fix PR closes it; a closed issue loses the actionable label; a closed issue
// whose test flakes again is reopened and counted from scratch.

type Flakes = TestingConfig["flakes"];

interface IssueLabel {
  name?: string;
}
interface Issue {
  number: number;
  html_url: string;
  state: "open" | "closed";
  body?: string | null;
  created_at?: string;
  labels?: (IssueLabel | string)[];
  pull_request?: unknown;
}
interface IssueComment {
  body?: string | null;
  created_at?: string;
}
interface IssueEvent {
  event?: string;
  created_at?: string;
}

const enc = encodeURIComponent;
const TITLE_LIMIT = 256;
const DAY_MS = 24 * 60 * 60 * 1000;

function labelNames(issue: Issue): string[] {
  return (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name ?? "");
}

/** A fenced block that no run of backticks inside the text can close. */
function fenced(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function occurrenceBlock(entries: FlakeReportTest[], ctx: RunContext, at: Date): string {
  const where = ctx.pullRequest !== null
    ? `pull request #${ctx.pullRequest} (\`${ctx.ref}\`)`
    : `\`${ctx.ref || "(no branch)"}\``;
  const jobs = [...new Set(entries.flatMap((entry) => entry.job ? [entry.job] : []))];
  const inJobs = jobs.length > 0 ? `, in ${jobs.join(", ")}` : "";
  const message = entries.find((entry) => entry.message)?.message ?? "";
  return [
    flakeOccurrenceMarker(at),
    `Flaked on ${where} at \`${ctx.commit.slice(0, 12)}\` ([CI run](${ctx.runUrl}))${inJobs}.`,
    ...(message ? ["", fenced(message)] : []),
  ].join("\n");
}

function countLine(count: number, flakes: Flakes): string {
  return `${FLAKE_COUNT_MARKER}Occurrences counted: **${count}** in the last ${flakes.windowDays} days` +
    ` (the \`${flakes.actionableLabel}\` label is added at ${flakes.actionableAfter}).`;
}

function issueBody(entry: FlakeReportTest, flakes: Flakes, occurrence: string): string {
  return [
    flakeIssueMarker(entry.key),
    `A test failed in CI and then passed when its file was rerun.`,
    "",
    `- Test: \`${entry.name}\``,
    `- File: \`${entry.file}\``,
    `- Runner: \`${entry.runner}\``,
    "",
    countLine(1, flakes),
    "",
    "Each later occurrence is a comment on this issue. Close it from the pull request that fixes " +
      "the flake (`Fixes #n`). If the test flakes again, CI reopens it and counting starts over.",
    "",
    "## First occurrence",
    "",
    occurrence,
  ].join("\n");
}

function issueTitle(entry: FlakeReportTest): string {
  const title = `Flaky test: ${entry.name} (${entry.file})`;
  return title.length <= TITLE_LIMIT ? title : `${title.slice(0, TITLE_LIMIT - 3)}...`;
}

async function ensureLabel(client: GitHubClient, repo: string, name: string, color: string, description: string) {
  try {
    await client.request("GET", `/repos/${repo}/labels/${enc(name)}`);
    return;
  } catch (err) {
    if (!(err instanceof GitHubError) || err.status !== 404) throw err;
  }
  try {
    await client.request("POST", `/repos/${repo}/labels`, { name, color, description });
  } catch (err) {
    // 422: another job created it between the GET and the POST.
    if (!(err instanceof GitHubError) || err.status !== 422) throw err;
  }
}

/** When the issue was last reopened, or null if it never was. */
async function lastReopened(client: GitHubClient, repo: string, issue: number): Promise<Date | null> {
  const events = await client.paginate<IssueEvent>(`/repos/${repo}/issues/${issue}/events`);
  let latest: Date | null = null;
  for (const event of events) {
    if (event.event !== "reopened" || !event.created_at) continue;
    const at = new Date(event.created_at);
    if (!latest || at > latest) latest = at;
  }
  return latest;
}

export interface UpdateFlakeIssuesOptions {
  client: GitHubClient;
  ctx: RunContext;
  flakes: Flakes;
  report: FlakeReport;
  now: Date;
}

/** Record this run's flakes on their issues and return where each one's history lives. */
export async function updateFlakeIssues(opts: UpdateFlakeIssuesOptions): Promise<FlakeReportIssue[]> {
  const { client, ctx, flakes, now } = opts;
  const repo = ctx.repository;
  await ensureLabel(client, repo, flakes.label, "d4c5f9", "A test that failed and then passed on rerun in CI");
  await ensureLabel(client, repo, flakes.actionableLabel, "b60205", "A flaky test that crossed the occurrence threshold");

  const listed = await client.paginate<Issue>(`/repos/${repo}/issues?labels=${enc(flakes.label)}&state=all`);
  const byKey = new Map<string, Issue>();
  for (const issue of listed) {
    if (issue.pull_request) continue;
    const key = parseFlakeIssueKey(issue.body);
    if (key && !byKey.has(key)) byKey.set(key, issue);
  }

  // One occurrence per test per run, however many jobs saw it flake.
  const groups = new Map<string, FlakeReportTest[]>();
  for (const entry of opts.report.flakes) {
    const group = groups.get(entry.key);
    if (group) group.push(entry);
    else groups.set(entry.key, [entry]);
  }

  const windowStart = new Date(now.getTime() - flakes.windowDays * DAY_MS);
  const results: FlakeReportIssue[] = [];
  for (const [key, entries] of groups) {
    const occurrence = occurrenceBlock(entries, ctx, now);
    const existing = byKey.get(key);
    if (!existing) {
      const actionable = flakes.actionableAfter <= 1;
      const created = await client.request<Issue>("POST", `/repos/${repo}/issues`, {
        title: issueTitle(entries[0]!),
        body: issueBody(entries[0]!, flakes, occurrence),
        labels: actionable ? [flakes.label, flakes.actionableLabel] : [flakes.label],
      });
      results.push({ key, number: created.number, url: created.html_url, occurrences: 1, actionable });
      continue;
    }

    const issuePath = `/repos/${repo}/issues/${existing.number}`;
    let earlier = 0;
    const reopening = existing.state === "closed";
    if (reopening) {
      await client.request("PATCH", issuePath, { state: "open" });
    } else {
      // Counted before this run's comment is posted, so a lagging list cannot miss or
      // double-count it. Occurrences are dated by GitHub's own timestamps, the same clock as
      // the reopen event: the marker's time is this runner's clock, taken before the reopen.
      const reopenedAt = await lastReopened(client, repo, existing.number);
      const since = reopenedAt && reopenedAt > windowStart ? reopenedAt : windowStart;
      const comments = await client.paginate<IssueComment>(`${issuePath}/comments`);
      const dated = [
        { text: existing.body, at: existing.created_at },
        ...comments.map((comment) => ({ text: comment.body, at: comment.created_at })),
      ];
      earlier = dated.filter((item) =>
        item.at !== undefined && new Date(item.at) > since && parseFlakeOccurrences(item.text).length > 0).length;
    }
    await client.request("POST", `${issuePath}/comments`, { body: occurrence });

    const occurrences = earlier + 1;
    const actionable = occurrences >= flakes.actionableAfter;
    const hasActionable = labelNames(existing).includes(flakes.actionableLabel);
    if (actionable && !hasActionable) {
      await client.request("POST", `${issuePath}/labels`, { labels: [flakes.actionableLabel] });
    } else if (!actionable && hasActionable && reopening) {
      await client.request("DELETE", `${issuePath}/labels/${enc(flakes.actionableLabel)}`);
    }
    const body = existing.body ?? "";
    const countAt = body.indexOf(FLAKE_COUNT_MARKER);
    const lineEnd = countAt === -1 ? -1 : body.indexOf("\n", countAt);
    const counted = countAt === -1
      ? body
      : `${body.slice(0, countAt)}${countLine(occurrences, flakes)}${lineEnd === -1 ? "" : body.slice(lineEnd)}`;
    if (counted !== body) await client.request("PATCH", issuePath, { body: counted });
    results.push({ key, number: existing.number, url: existing.html_url, occurrences, actionable });
  }

  // A closed issue is fixed: it should not stay on the actionable list.
  for (const issue of listed) {
    if (issue.pull_request || issue.state !== "closed") continue;
    const key = parseFlakeIssueKey(issue.body);
    if (key && groups.has(key)) continue;
    if (!labelNames(issue).includes(flakes.actionableLabel)) continue;
    await client.request("DELETE", `/repos/${repo}/issues/${issue.number}/labels/${enc(flakes.actionableLabel)}`);
  }
  return results;
}
