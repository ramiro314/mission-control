#!/usr/bin/env node

/**
 * One-off migration of the fork ledger into GitHub tracking issues
 * (docs/plans/fork-tracking/plan.md, "`scripts/fork-migrate.mjs`", decisions 11, 20 and 27).
 *
 *   node scripts/fork-migrate.mjs --dry-run      print the plan, read nothing from GitHub
 *   node scripts/fork-migrate.mjs                print the plan, then reconcile GitHub with it
 *
 * `--ledger <path>` reads a ledger other than the checkout's, for example
 * `git show origin/main:docs/fork/ledger.md > /tmp/ledger.md`. `--repo <owner/name>` names the
 * repository and defaults to the fork, never to whatever `gh` resolves in a checkout that also
 * has an `upstream` remote.
 *
 * The plan lists every label, every tracking issue with its slug and status, and every historic
 * PR from the "At a glance" table with the labels it gets. A real run is a reconciling upsert: it
 * reads the labels, the `fork-feature` issues and the PRs, and writes only the differences, so a
 * rerun against an unchanged ledger writes nothing. It creates missing labels, creates each
 * missing tracking issue, rewrites the title, sections, state and `fork-status:*` label of an
 * existing one where they differ (printing each section before rewriting it), posts a closed
 * entry's closing comment once (found again by its marker), and adds each historic PR's feature
 * label and `fork-delta:applied`.
 *
 * Everything but the `gh` calls is pure, and `test/fork-migrate.test.ts` covers it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { APPLIED_LABEL, normalizeSection, parseIssueBody, renderIssueBody, scanLines } from "./fork-delta.mjs";

export const DEFAULT_REPO = "ramiro314/mission-control";
export const FEATURE_LABEL = "fork-feature";
export const CLOSING_MARKER = "<!-- fork-migrate:closing -->";
/** The tracking issue's fixed sections, in order. Ledger paragraphs outside them follow. */
export const TEMPLATE_SECTIONS = [
  "Intent",
  "Behavior contracts",
  "Upstream behavior it assumes",
  "Upstream surfaces touched",
  "Fork-only files",
  "Plan docs",
  "Upstream candidate",
];
/** GitHub's documented limit is not stated; a longer label is flagged in the plan for review. */
export const LABEL_WARN_LENGTH = 50;

const LEDGER_DIR = "docs/fork";
const TABLE_FIELDS = new Set(["Status", "PRs", "Plan docs", "Upstream candidate"]);
const MISSING = "None recorded in the ledger.";
const STATUS_WORDS = [
  [/^active$/i, "active"],
  [/^in progress\b/i, "in-progress"],
  [/^superseded\b/i, "superseded"],
  [/^removed$/i, "removed"],
  [/^upstreamed$/i, "upstreamed"],
];
const STATUS_LABELS = {
  "in-progress": "An open fork feature that is not finished on main",
  superseded: "A closed fork feature superseded by upstream",
  removed: "A closed fork feature removed from the fork",
  upstreamed: "A closed fork feature that upstream took",
};

/** `fork:<slug>`'s slug: the heading lowercased, every run of other characters one hyphen. */
export function slugFor(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `text` split at commas outside parentheses and backticks. */
function splitItems(text) {
  const items = [];
  let depth = 0;
  let tick = false;
  let current = "";
  for (const ch of text) {
    if (ch === "`") tick = !tick;
    else if (!tick && ch === "(") depth++;
    else if (!tick && ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && !depth && !tick) {
      items.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) items.push(current.trim());
  return items.filter(Boolean);
}

/** The PR numbers a PRs cell names, and the items that are not one (pending, issues, prose). */
export function parsePrCell(cell) {
  const prs = [];
  const skipped = [];
  for (const item of splitItems(cell)) {
    const number = /^issue\s/i.test(item) ? null : /^#(\d+)\b/.exec(item)?.[1];
    if (number) prs.push(Number(number));
    else skipped.push(item);
  }
  return { prs, skipped };
}

/**
 * Hard-wrapped ledger prose as one line per paragraph or list item. GitHub renders a single
 * newline in an issue body as a line break, so the ledger's wrapping would show mid-sentence.
 */
export function unwrap(text) {
  const out = [];
  let joinable = false;
  for (const { line, code } of scanLines(text)) {
    const trimmed = line.trim();
    const starts = code || !trimmed || /^(?:[-*+]\s|\d+[.)]\s|\||#|>)/.test(trimmed);
    if (joinable && !starts) out[out.length - 1] += ` ${trimmed}`;
    else out.push(line);
    joinable = !code && Boolean(trimmed) && !trimmed.startsWith("|");
  }
  return out.join("\n");
}

/** Relative links rewritten against the ledger's directory into links on the repository's main. */
export function absoluteLinks(text, repo) {
  return text.replace(/\]\(([^)\s]+)\)/g, (match, target) => {
    if (/^(?:[a-z]+:|#|\/)/i.test(target)) return match;
    return `](https://github.com/${repo}/blob/main/${posix.normalize(posix.join(LEDGER_DIR, target))})`;
  });
}

function statusOf(name, value) {
  const word = /^\*\*([^*]+)\*\*/.exec(value)?.[1]?.trim() ?? "";
  const status = STATUS_WORDS.find(([pattern]) => pattern.test(word))?.[1];
  if (!status) throw new Error(`${name}: cannot read a status from "${value}"`);
  return status;
}

function parseEntry({ name, lines }, repo) {
  const fields = new Map();
  const paragraphs = [];
  let current = null;
  for (const { line, code } of lines) {
    const row = code || current ? null : /^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    const bold = code ? null : /^\*\*([^*]+?)\.\*\*\s?(.*)$/.exec(line);
    if (row) {
      if (row[1] === "Field" || /^:?-+:?$/.test(row[1])) continue;
      if (!TABLE_FIELDS.has(row[1])) throw new Error(`${name}: unknown field "${row[1]}"`);
      fields.set(row[1], row[2]);
    } else if (bold) {
      current = { name: bold[1].replace(/\s*\([^)]*\)$/, ""), lines: [bold[2]] };
      if (paragraphs.some((p) => p.name === current.name)) throw new Error(`${name}: two "${current.name}" paragraphs`);
      paragraphs.push(current);
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      throw new Error(`${name}: text outside the field table and the bold-titled paragraphs: "${line}"`);
    }
  }
  for (const field of ["Status", "PRs"]) {
    if (!fields.has(field)) throw new Error(`${name}: the field table has no ${field} row`);
  }
  const text = (raw) => normalizeSection(absoluteLinks(unwrap(raw), repo));
  const found = new Map([
    ...paragraphs.map((p) => [p.name, text(p.lines.join("\n"))]),
    ...["Plan docs", "Upstream candidate"].filter((f) => fields.has(f)).map((f) => [f, text(fields.get(f))]),
  ]);
  const sections = [
    ...TEMPLATE_SECTIONS.map((section) => ({ name: section, text: found.get(section) || MISSING })),
    ...paragraphs.filter((p) => !TEMPLATE_SECTIONS.includes(p.name)).map((p) => ({ name: p.name, text: found.get(p.name) })),
  ];
  const statusText = fields.get("Status").replace(/\*\*/g, "");
  const claimed = fields.get("PRs").split(/related, not claimed/i)[0];
  return { name, slug: slugFor(name), status: statusOf(name, fields.get("Status")), statusText, sections, entryPrs: parsePrCell(claimed).prs };
}

function parseGlance(lines) {
  const rows = [];
  for (const { line, code } of lines) {
    if (code || !line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.length !== 3) throw new Error(`"At a glance" row does not have three cells: "${line}"`);
    if (cells[0] === "Feature" || /^:?-+:?$/.test(cells[0])) continue;
    rows.push({ name: cells[0], ...parsePrCell(cells[2]) });
  }
  return rows;
}

/**
 * The ledger's entries (every `###` heading) and its "At a glance" rows. Each entry carries its
 * slug, status, and the tracking issue's sections; its PRs field is read only to warn about PRs
 * the table leaves out.
 */
export function parseLedger(text, { repo = DEFAULT_REPO } = {}) {
  const blocks = [];
  for (const { line, code } of scanLines(text)) {
    const heading = code ? null : /^(#{1,3})\s+(.*?)\s*$/.exec(line);
    if (heading) blocks.push({ level: heading[1].length, name: heading[2], lines: [] });
    else blocks.at(-1)?.lines.push({ line, code });
  }
  const glance = blocks.find((b) => b.level === 2 && b.name === "At a glance");
  if (!glance) throw new Error('the ledger has no "## At a glance" section');
  const entries = blocks.filter((b) => b.level === 3).map((b) => parseEntry(b, repo));
  const slugs = entries.map((e) => e.slug);
  const repeated = slugs.find((slug, i) => slugs.indexOf(slug) !== i);
  if (repeated) throw new Error(`two entries derive the slug ${repeated}`);
  return { entries, glance: parseGlance(glance.lines) };
}

function statusLabelOf(status) {
  return status in STATUS_LABELS ? `fork-status:${status}` : null;
}

function closingComment(entry) {
  return `Closed by the fork ledger migration. Ledger status: ${entry.statusText}.\n\n${CLOSING_MARKER}\n`;
}

/** What GitHub should hold once the migration has run: labels, tracking issues, PR labels. */
export function desiredState(ledger) {
  const labels = [
    { name: FEATURE_LABEL, color: "0e8a16", description: "A fork feature's tracking issue" },
    ...ledger.entries.map((e) => ({ name: `fork:${e.slug}`, color: "1d76db", description: `Fork feature: ${e.name}`.slice(0, 100) })),
    ...Object.entries(STATUS_LABELS).map(([status, description]) => ({ name: `fork-status:${status}`, color: "fbca04", description })),
    { name: APPLIED_LABEL, color: "c5def5", description: "The refresh has applied this PR's Fork feature changes" },
  ];
  const issues = ledger.entries.map((entry) => {
    const closed = !["active", "in-progress"].includes(entry.status);
    const statusLabel = statusLabelOf(entry.status);
    return {
      slug: entry.slug,
      title: `Fork feature: ${entry.name}`,
      body: renderIssueBody({ preamble: `Migrated from the fork ledger. Ledger status: ${entry.statusText}`, sections: entry.sections }),
      state: closed ? "closed" : "open",
      labels: [FEATURE_LABEL, `fork:${entry.slug}`, ...(statusLabel ? [statusLabel] : [])],
      closingComment: closed ? closingComment(entry) : null,
    };
  });
  const bySlug = new Map(ledger.entries.map((e) => [e.name, e.slug]));
  const prs = new Map();
  const notes = [];
  for (const row of ledger.glance) {
    const slug = bySlug.get(row.name);
    if (!slug) {
      notes.push(`"${row.name}" has no entry, so its PRs are not labeled: ${row.prs.map((n) => `#${n}`).join(", ") || "none"}`);
      continue;
    }
    for (const item of row.skipped) notes.push(`fork:${slug}: skipped "${item}"`);
    for (const number of row.prs) {
      const set = prs.get(number) ?? new Set();
      prs.set(number, set.add(`fork:${slug}`).add(APPLIED_LABEL));
    }
  }
  for (const entry of ledger.entries) {
    const tabled = new Set(ledger.glance.find((r) => r.name === entry.name)?.prs ?? []);
    const missing = entry.entryPrs.filter((n) => !tabled.has(n));
    if (missing.length) {
      notes.push(`fork:${entry.slug}: in the entry's PRs field but not the "At a glance" table, so not labeled: ${missing.map((n) => `#${n}`).join(", ")}`);
    }
  }
  for (const { name } of labels) {
    if (name.length > LABEL_WARN_LENGTH) notes.push(`label ${name} is ${name.length} characters; GitHub may refuse a name over ${LABEL_WARN_LENGTH}`);
  }
  return { labels, issues, prs: new Map([...prs].sort((a, b) => a[0] - b[0]).map(([n, set]) => [n, [...set]])), notes };
}

/** The plan every run prints first, and all `--dry-run` prints. */
export function formatPlan(desired) {
  const lines = [`Labels (${desired.labels.length}):`, ...desired.labels.map((l) => `  ${l.name}`), ""];
  lines.push(`Tracking issues (${desired.issues.length}):`);
  for (const issue of desired.issues) {
    const status = [issue.state, ...issue.labels.filter((l) => l.startsWith("fork-status:"))].join(", ");
    lines.push(`  fork:${issue.slug}  [${status}]  ${issue.title}`);
  }
  lines.push("", `Historic PRs (${desired.prs.size}):`);
  for (const [number, labels] of desired.prs) lines.push(`  #${number}  ${labels.join(", ")}`);
  if (desired.notes.length) lines.push("", "Notes:", ...desired.notes.map((n) => `  ${n}`));
  return `${lines.join("\n")}\n`;
}

function sameBody(a, b) {
  return renderIssueBody(parseIssueBody(a)) === renderIssueBody(parseIssueBody(b));
}

/** Each section that differs between two bodies, the preamble included, with both texts. */
function changedSections(current, next) {
  const a = parseIssueBody(current);
  const b = parseIssueBody(next);
  const changes = a.preamble === b.preamble ? [] : [{ name: "(preamble)", current: a.preamble, next: b.preamble }];
  for (const name of new Set([...a.sections, ...b.sections].map((s) => s.name))) {
    const was = a.sections.find((s) => s.name === name)?.text ?? null;
    const now = b.sections.find((s) => s.name === name)?.text ?? null;
    if (was !== now) changes.push({ name, current: was, next: now });
  }
  return changes;
}

/**
 * The writes that bring `actual` GitHub state to `desired`, in the order they run. `actual` is
 * `{ labels: string[], issues: { number, title, state, labels, body, comments }[], prs: Map }`,
 * where `comments` are comment bodies and `prs` maps a PR number to its labels.
 */
export function planWrites(desired, actual) {
  const writes = [];
  const warnings = [];
  const existing = new Set(actual.labels);
  for (const label of desired.labels) if (!existing.has(label.name)) writes.push({ op: "create-label", ...label });

  for (const want of desired.issues) {
    const matches = actual.issues.filter((i) => i.labels.includes(`fork:${want.slug}`));
    if (matches.length > 1) {
      throw new Error(`fork:${want.slug} is on more than one issue: ${matches.map((i) => `#${i.number}`).join(", ")}; fix that by hand`);
    }
    const [issue] = matches;
    if (!issue) {
      writes.push({ op: "create-issue", slug: want.slug, title: want.title, body: want.body, labels: want.labels });
      if (want.closingComment) {
        writes.push({ op: "comment-issue", slug: want.slug, number: null, body: want.closingComment });
        writes.push({ op: "close-issue", slug: want.slug, number: null });
      }
      continue;
    }
    const state = issue.state.toLowerCase();
    const edit = { op: "edit-issue", slug: want.slug, number: issue.number, title: null, body: null, sections: [], addLabels: [], removeLabels: [] };
    if (issue.title !== want.title) edit.title = want.title;
    if (!sameBody(issue.body ?? "", want.body)) {
      edit.body = want.body;
      edit.sections = changedSections(issue.body ?? "", want.body);
    }
    edit.addLabels = want.labels.filter((l) => !issue.labels.includes(l));
    edit.removeLabels = issue.labels.filter((l) => l.startsWith("fork-status:") && !want.labels.includes(l));
    if (edit.title || edit.body || edit.addLabels.length || edit.removeLabels.length) writes.push(edit);
    if (want.closingComment && !issue.comments.some((c) => c.includes(CLOSING_MARKER))) {
      writes.push({ op: "comment-issue", slug: want.slug, number: issue.number, body: want.closingComment });
    }
    if (want.state === "closed" && state !== "closed") writes.push({ op: "close-issue", slug: want.slug, number: issue.number });
    if (want.state === "open" && state === "closed") writes.push({ op: "reopen-issue", slug: want.slug, number: issue.number });
  }

  for (const [number, labels] of desired.prs) {
    const have = actual.prs.get(number);
    if (!have) {
      warnings.push(`#${number} is not a pull request in this repository; not labeled`);
      continue;
    }
    const add = labels.filter((l) => !have.includes(l));
    if (add.length) writes.push({ op: "label-pr", number, addLabels: add });
  }
  return { writes, warnings };
}

function indent(text, prefix) {
  return text === null ? `${prefix}(absent)` : text.split("\n").map((l) => `${prefix}${l}`).join("\n");
}

/** One write as the run prints it before making it. */
export function formatWrite(write, number = write.number) {
  const issue = number ? `#${number}` : "(new issue)";
  switch (write.op) {
    case "create-label":
      return `create label ${write.name}`;
    case "create-issue":
      return `create issue fork:${write.slug} "${write.title}" [${write.labels.join(", ")}]`;
    case "edit-issue": {
      const parts = [
        write.title && `title "${write.title}"`,
        write.body && "body",
        write.addLabels.length && `add ${write.addLabels.join(", ")}`,
        write.removeLabels.length && `remove ${write.removeLabels.join(", ")}`,
      ].filter(Boolean);
      const lines = [`edit issue ${issue} fork:${write.slug}: ${parts.join("; ")}`];
      for (const s of write.sections) {
        lines.push(`  section ${s.name}, current:`, indent(s.current, "    - "), `  section ${s.name}, from the ledger:`, indent(s.next, "    + "));
      }
      return lines.join("\n");
    }
    case "comment-issue":
      return `comment on issue ${issue} fork:${write.slug}: closing comment`;
    case "close-issue":
      return `close issue ${issue} fork:${write.slug}`;
    case "reopen-issue":
      return `reopen issue ${issue} fork:${write.slug}`;
    case "label-pr":
      return `label PR #${write.number}: ${write.addLabels.join(", ")}`;
    default:
      throw new Error(`unknown write ${write.op}`);
  }
}

/** `gh` for `repo`: `run(args, input)` returns stdout. */
export function ghRunner(repo) {
  const bin = process.env.MISSION_GH_BIN || "gh";
  return (args, input) => execFileSync(bin, [...args, "--repo", repo], { encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
}

const labelNames = (labels) => labels.map((l) => l.name);

/** The labels, `fork-feature` issues with their comments, and every PR's labels. */
export function fetchState(run) {
  const labels = labelNames(JSON.parse(run(["label", "list", "--limit", "1000", "--json", "name"])));
  const issues = labels.includes(FEATURE_LABEL)
    ? JSON.parse(
        run(["issue", "list", "--label", FEATURE_LABEL, "--state", "all", "--limit", "1000", "--json", "number,title,state,labels,body,comments"]),
      ).map((i) => ({ ...i, labels: labelNames(i.labels), comments: (i.comments ?? []).map((c) => c.body) }))
    : [];
  const prs = new Map(
    JSON.parse(run(["pr", "list", "--state", "all", "--limit", "1000", "--json", "number,labels"])).map((p) => [p.number, labelNames(p.labels)]),
  );
  return { labels, issues, prs };
}

/** Make each write in order, printing it first. A new issue's number is read from `gh`'s URL. */
export function executeWrites(writes, run, print) {
  const created = new Map();
  for (const write of writes) {
    const number = write.number ?? created.get(write.slug) ?? null;
    print(formatWrite(write, number));
    const n = String(number);
    switch (write.op) {
      case "create-label":
        run(["label", "create", write.name, "--color", write.color, "--description", write.description]);
        break;
      case "create-issue": {
        const url = run(["issue", "create", "--title", write.title, "--body-file", "-", ...write.labels.flatMap((l) => ["--label", l])], write.body);
        const made = /\/issues\/(\d+)\s*$/.exec(url)?.[1];
        if (!made) throw new Error(`gh issue create printed no issue URL: ${url}`);
        created.set(write.slug, Number(made));
        print(`  created #${made}`);
        break;
      }
      case "edit-issue":
        run(
          [
            "issue",
            "edit",
            n,
            ...(write.title ? ["--title", write.title] : []),
            ...(write.body ? ["--body-file", "-"] : []),
            ...(write.addLabels.length ? ["--add-label", write.addLabels.join(",")] : []),
            ...(write.removeLabels.length ? ["--remove-label", write.removeLabels.join(",")] : []),
          ],
          write.body ?? undefined,
        );
        break;
      case "comment-issue":
        run(["issue", "comment", n, "--body-file", "-"], write.body);
        break;
      case "close-issue":
        run(["issue", "close", n]);
        break;
      case "reopen-issue":
        run(["issue", "reopen", n]);
        break;
      case "label-pr":
        run(["pr", "edit", n, "--add-label", write.addLabels.join(",")]);
        break;
      default:
        throw new Error(`unknown write ${write.op}`);
    }
  }
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { "dry-run": { type: "boolean" }, ledger: { type: "string" }, repo: { type: "string" } },
  });
  const repo = values.repo ?? DEFAULT_REPO;
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const path = values.ledger ?? join(root, LEDGER_DIR, "ledger.md");
  const desired = desiredState(parseLedger(readFileSync(path, "utf8"), { repo }));
  const print = (text) => process.stdout.write(`${text}\n`);
  print(`Ledger: ${path}\nRepository: ${repo}\n`);
  print(formatPlan(desired));
  if (values["dry-run"]) {
    print("Dry run: nothing read from or written to GitHub.");
    return;
  }
  const run = ghRunner(repo);
  const { writes, warnings } = planWrites(desired, fetchState(run));
  for (const warning of warnings) print(`warning: ${warning}`);
  if (!writes.length) {
    print("0 writes: GitHub already matches the ledger.");
    return;
  }
  print(`${writes.length} write(s):`);
  executeWrites(writes, run, print);
  print(`Done: ${writes.length} write(s).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`fork-migrate: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
