#!/usr/bin/env node

/**
 * Render the "Mission Control fork status" snapshot (docs/plans/fork-tracking/plan.md, section
 * "`scripts/fork-report.mjs`", decisions 6, 7, 15 and 25) as markdown. It reads GitHub through
 * `gh` and the repository through `git`, and writes nothing but its output file.
 *
 *   node scripts/fork-report.mjs [--out <path>] [--repo <owner/name>]
 *
 * `--out` defaults to `.tmp/fork-report.md`, which is gitignored. It fetches `origin/main` and
 * `upstream/main` first, so the counts describe the remotes as they stand now.
 *
 * The last synced upstream commit is `git merge-base upstream/main origin/main`, because every
 * sync merges upstream into `main`. Its SHA and its `package.json` version are what the header
 * reports as synced. `upstream/main` keeps moving between syncs, so its tip is used only for the
 * behind count, and named beside it when it differs from the merge-base.
 *
 * Only PRs merged into `main` are shown. Open PRs and PRs merged into `release/windows` never
 * appear; the one exception is a count of the latter, carried on the row of each PR that merges
 * `release/windows` into `main` and counting only the branch PRs that merge brought in.
 *
 * `renderForkReport` is pure, and `test/fork-report.test.ts` covers it from fixture data.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { parseIssueBody } from "./fork-delta.mjs";

export const WINDOWS_SLUG = "windows-support";
export const WINDOWS_BRANCH = "release/windows";

const FEATURE_LABEL = "fork:";
const STATUS_LABEL = "fork-status:";
const SYNC_BRANCH = /^sync\/upstream-/;
const ISSUE_TITLE_PREFIX = /^Fork feature:\s*/i;

const short = (sha) => sha.slice(0, 12);
const day = (iso) => iso.slice(0, 10);

/** Text safe inside a markdown table cell: one line, pipes escaped. */
function cell(text) {
  return text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

function prLink(pr) {
  return `[#${pr.number}](${pr.url})`;
}

function featureSlugs(labels) {
  return labels.filter((l) => l.startsWith(FEATURE_LABEL)).map((l) => l.slice(FEATURE_LABEL.length));
}

/** `active`, `in-progress`, or a closed issue's `fork-status:*` reason (`closed` when it has none). */
export function featureStatus(issue) {
  const status = issue.labels.find((l) => l.startsWith(STATUS_LABEL))?.slice(STATUS_LABEL.length);
  if (issue.state.toLowerCase() === "closed") return status ?? "closed";
  return status === "in-progress" ? "in-progress" : "active";
}

/** The first sentence of the issue's `### Intent` section, on one line. Empty when it has none. */
export function intentSentence(body) {
  const intent = parseIssueBody(body).sections.find((s) => s.name.toLowerCase() === "intent");
  const text = (intent?.text ?? "").replace(/\s+/g, " ").trim();
  return /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
}

/** Only PRs that merged into `main`: the report never shows open or `release/windows` PRs. */
function mergedIntoMain(prs) {
  return prs.filter((pr) => pr.mergedAt && pr.baseRefName === "main");
}

function isSync(pr) {
  return SYNC_BRANCH.test(pr.headRefName);
}

function isBot(pr) {
  return pr.author?.login?.startsWith("app/") ?? false;
}

function byNumber(a, b) {
  return a.number - b.number;
}

/**
 * For each PR that merged `release/windows` into `main`, how many `fork:windows-support` PRs
 * merged into the branch after the previous such merge and no later than this one. A branch PR
 * merged after the last merge has not reached `main` and is not counted anywhere.
 */
export function windowsIncludes(prs, windowsPrs) {
  const time = (pr) => Date.parse(pr.mergedAt);
  const merges = prs.filter((pr) => pr.headRefName === WINDOWS_BRANCH).sort((a, b) => time(a) - time(b));
  const counts = new Map();
  merges.forEach((merge, i) => {
    const after = i ? time(merges[i - 1]) : -Infinity;
    counts.set(merge.number, windowsPrs.filter((w) => w.mergedAt && time(w) > after && time(w) <= time(merge)).length);
  });
  return counts;
}

/** Features in display order: open issues first, then closed, each by issue number. */
function featureRows(issues, prs, includes) {
  const open = (issue) => (issue.state.toLowerCase() === "closed" ? 1 : 0);
  return [...issues]
    .sort((a, b) => open(a) - open(b) || byNumber(a, b))
    .map((issue) => {
      const slugs = featureSlugs(issue.labels);
      const linked = prs.filter((pr) => featureSlugs(pr.labels).some((s) => slugs.includes(s))).sort(byNumber);
      const links = linked.map((pr) => {
        const windowsMerge = slugs.includes(WINDOWS_SLUG) && includes.has(pr.number);
        return windowsMerge ? `${prLink(pr)} (includes ${includes.get(pr.number)} ${WINDOWS_BRANCH} PRs)` : prLink(pr);
      });
      return {
        open: !open(issue),
        name: `[${cell(issue.title.replace(ISSUE_TITLE_PREFIX, ""))}](${issue.url})`,
        status: featureStatus(issue),
        intent: cell(intentSentence(issue.body)),
        prs: links.join(", ") || "none yet",
      };
    });
}

/**
 * The report's markdown. `data` holds every `fork-feature` issue, the merged PRs (anything not
 * merged into `main` is dropped here), the `fork:windows-support` PRs merged into
 * `release/windows` with their merge times, and the git measurements.
 */
export function renderForkReport(data) {
  const { git, measuredAt } = data;
  const prs = mergedIntoMain(data.prs);
  const features = featureRows(data.issues, prs, windowsIncludes(prs, data.windowsPrs));
  const fixes = prs.filter((pr) => !featureSlugs(pr.labels).length && !isSync(pr) && !isBot(pr)).sort(byNumber);
  // A fork:* label keeps a PR out of the fixes, so one no tracking issue carries (a typo, or a
  // feature whose issue the refresh has not created yet) would otherwise vanish from the report.
  const tracked = new Set(data.issues.flatMap((issue) => featureSlugs(issue.labels)));
  const unmatched = prs
    .map((pr) => ({ pr, slugs: featureSlugs(pr.labels).filter((s) => !tracked.has(s)) }))
    .filter((u) => u.slugs.length)
    .sort((a, b) => byNumber(a.pr, b.pr));
  const lastSync = prs.filter(isSync).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))[0];

  const active = features.filter((f) => f.open);
  const inProgress = active.filter((f) => f.status === "in-progress").length;
  const closed = features.length - active.length;
  const behindTip = git.upstreamTip === git.mergeBase ? "" : ` (\`upstream/main\` at \`${short(git.upstreamTip)}\`)`;

  const lines = [
    "# Mission Control fork status",
    "",
    // One line per paragraph: the Claude Docs connector folds a soft line break into a space,
    // and the doc is meant to hold exactly what this prints.
    "Generated by `scripts/fork-report.mjs` from GitHub and git. Every refresh replaces this whole doc, so do not edit it by hand. Only pull requests merged into `main` are counted.",
    "",
    "## Status",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Last synced upstream | **${git.mergeBaseVersion}**, merge-base \`${short(git.mergeBase)}\` |`,
    `| Last sync PR | ${lastSync ? `${prLink(lastSync)} ${cell(lastSync.title)}, merged ${day(lastSync.mergedAt)}` : "none merged yet"} |`,
    `| Fork commits ahead of upstream | **${git.ahead}** (${git.aheadNoMerges} excluding merge commits) |`,
    `| Upstream commits behind | **${git.behind}**${behindTip} |`,
    `| Active fork features | **${active.length}** (${inProgress} in progress), plus ${closed} closed, and ${fixes.length} standalone fixes |`,
    `| Measured at | \`origin/main\` \`${short(measuredAt.sha)}\`, ${measuredAt.time} |`,
    "",
    "## Features",
    "",
  ];
  if (features.length) {
    lines.push("| Feature | Status | Intent | PRs |", "| --- | --- | --- | --- |");
    for (const f of features) lines.push(`| ${f.name} | ${f.status} | ${f.intent} | ${f.prs} |`);
  } else {
    lines.push("No `fork-feature` tracking issues yet.");
  }
  if (unmatched.length) {
    lines.push(
      "",
      "## Unmatched fork labels",
      "",
      "These merged PRs carry a `fork:*` label that no tracking issue carries, so that work is missing",
      "from the features above. Fix the label, or let the refresh create the feature's issue.",
      "",
      "| PR | Title | Unmatched labels | Merged |",
      "| --- | --- | --- | --- |",
    );
    for (const { pr, slugs } of unmatched) {
      const labels = slugs.map((s) => `\`${FEATURE_LABEL}${s}\``).join(", ");
      lines.push(`| ${prLink(pr)} | ${cell(pr.title)} | ${labels} | ${day(pr.mergedAt)} |`);
    }
  }
  lines.push("", "## Standalone fixes", "");
  if (fixes.length) {
    lines.push("| PR | Title | Merged |", "| --- | --- | --- |");
    for (const pr of fixes) lines.push(`| ${prLink(pr)} | ${cell(pr.title)} | ${day(pr.mergedAt)} |`);
  } else {
    lines.push("None.");
  }
  return `${lines.join("\n")}\n`;
}

function run(bin, args) {
  return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
}

function gh(args, repo) {
  return JSON.parse(run(process.env.MISSION_GH_BIN || "gh", repo ? [...args, "--repo", repo] : args));
}

const git = (...args) => run("git", args);
const count = (range, ...flags) => Number(git("rev-list", "--count", ...flags, range));
const labelNames = (labels) => labels.map((l) => l.name);

function fetchData(repo) {
  git("fetch", "--quiet", "origin", "main");
  git("fetch", "--quiet", "upstream", "main");
  const mergeBase = git("merge-base", "upstream/main", "origin/main");
  const issues = gh(
    ["issue", "list", "--label", "fork-feature", "--state", "all", "--limit", "1000", "--json", "number,title,state,labels,body,url"],
    repo,
  ).map((issue) => ({ ...issue, labels: labelNames(issue.labels) }));
  const json = "number,title,labels,headRefName,baseRefName,mergedAt,url,author";
  const prs = gh(["pr", "list", "--state", "merged", "--base", "main", "--limit", "1000", "--json", json], repo).map((pr) => ({
    ...pr,
    labels: labelNames(pr.labels),
  }));
  const windowsPrs = gh(
    ["pr", "list", "--state", "merged", "--base", WINDOWS_BRANCH, "--label", `${FEATURE_LABEL}${WINDOWS_SLUG}`, "--limit", "1000", "--json", "number,mergedAt"],
    repo,
  );
  return {
    issues,
    prs,
    windowsPrs,
    git: {
      mergeBase,
      mergeBaseVersion: JSON.parse(git("show", `${mergeBase}:package.json`)).version,
      upstreamTip: git("rev-parse", "upstream/main"),
      ahead: count("upstream/main..origin/main"),
      aheadNoMerges: count("upstream/main..origin/main", "--no-merges"),
      behind: count("origin/main..upstream/main"),
    },
    measuredAt: { sha: git("rev-parse", "origin/main"), time: `${new Date().toISOString().slice(0, 16)}Z` },
  };
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: "string", default: ".tmp/fork-report.md" }, repo: { type: "string" } },
  });
  const report = renderForkReport(fetchData(values.repo));
  mkdirSync(dirname(resolve(values.out)), { recursive: true });
  writeFileSync(values.out, report);
  process.stdout.write(`wrote ${values.out}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`fork-report: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
