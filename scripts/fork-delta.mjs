#!/usr/bin/env node

/**
 * Work with a pull request's "Fork feature changes" section (docs/plans/fork-tracking/plan.md,
 * decision 30). It reads GitHub through `gh` and writes nothing.
 *
 *   node scripts/fork-delta.mjs check <pr>                    parse the section, report stale bases
 *   node scripts/fork-delta.mjs base <slug> "<section>" [--pr <n>]   the base a new block carries
 *   node scripts/fork-delta.mjs base <slug> Status [--pr <n>]
 *   node scripts/fork-delta.mjs show <slug> [--pr <n>]        the issue as the refresh will see it
 *   node scripts/fork-delta.mjs pending                       every unapplied PR, apply or held
 *
 * Every command also takes `--repo <owner/name>` (passed to `gh`) and `--since <YYYY-MM-DD>`,
 * which ignores PRs merged before the cut-over.
 *
 * A block's base is the first 12 hex characters of the SHA-256 of the issue section it replaces,
 * or `new` when that section or the issue does not exist. A `#### Status` block hashes the
 * feature's status line instead: `open` or `closed`, then its `fork-status:*` label or `none`.
 * Section text is compared with line endings normalized, leading blank lines dropped and
 * trailing whitespace trimmed, so the hash does not move when GitHub rewrites a body's CRLFs.
 *
 * `base` and `show` start from the tracking issue and overlay, in merge order, every merged PR
 * that still lacks `fork-delta:applied`: the text the refresh will hold once those apply. With
 * `--pr <n>` they overlay only the unapplied PRs merged before PR n, which is what the refresh
 * checks n against, and what repairing a held PR edits against.
 *
 * The refresh applies pending PRs oldest merge first. A PR with a stale base is held, and so is
 * every later PR that names any feature a held PR names: its base overlaid all of the held PR's
 * blocks, not only the stale one. A PR held that way holds its own features in turn. PRs that
 * name none of them continue. `check` exits 0 when the PR may apply and 1 when it is stale or
 * held. Every command exits 2 on a format or usage error, which the person running it fixes, and
 * 3 when it could not finish for any other reason, such as a failed `gh` call or tracking issues
 * that disagree with each other, so a caller never tells an author to fix a section that is fine.
 *
 * Everything but the `gh` fetch is pure, and `test/fork-delta.test.ts` covers it.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const APPLIED_LABEL = "fork-delta:applied";
export const STATUSES = ["active", "in-progress", "superseded", "removed", "upstreamed"];

const FEATURE_LABEL = "fork:";
const STATUS_LABEL = "fork-status:";
const SECTION_HEADING = /^##\s+Fork feature changes\s*$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A "Fork feature changes" section that does not follow the format. */
export class ForkDeltaFormatError extends Error {
  name = "ForkDeltaFormatError";
}

/** A command line that names no command, PR or feature the tool can use. */
export class UsageError extends Error {
  name = "UsageError";
}

/** The exit code for an error: 2 for a format or usage error, 3 for anything else. */
export function exitCodeFor(err) {
  if (err instanceof ForkDeltaFormatError || err instanceof UsageError) return 2;
  return typeof err?.code === "string" && err.code.startsWith("ERR_PARSE_ARGS") ? 2 : 3;
}

function formatError(message) {
  return new ForkDeltaFormatError(message);
}

/** The text a hash is taken over: LF line endings, no leading blank lines, no trailing space. */
export function normalizeSection(text) {
  return text.replace(/\r\n?/g, "\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

/** The first 12 hex characters of the SHA-256 of `text`, normalized. */
export function sectionHash(text) {
  return createHash("sha256").update(normalizeSection(text)).digest("hex").slice(0, 12);
}

/** Lines of `text`, each marked when it sits inside a fenced code block, fence lines included. */
function scanLines(text) {
  const out = [];
  let fence = null;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      out.push({ line, code: true });
    } else if (marker) {
      fence = marker;
      out.push({ line, code: true });
    } else {
      out.push({ line, code: false });
    }
  }
  return out;
}

/** The section's lines without its heading, or null when the body has none. */
function findSection(body) {
  const lines = scanLines(body ?? "");
  const starts = lines.flatMap((l, i) => (!l.code && SECTION_HEADING.test(l.line) ? [i] : []));
  if (!starts.length) return null;
  if (starts.length > 1) {
    throw formatError(`the body has ${starts.length} "## Fork feature changes" sections; keep one`);
  }
  const rest = lines.slice(starts[0] + 1);
  const end = rest.findIndex((l) => !l.code && /^#{1,2}\s/.test(l.line));
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Parse a PR body's "Fork feature changes" section. Null when the body has none, `none: true`
 * for the word `none`, otherwise one entry per `### fork:<slug>` group holding its `####` blocks.
 */
export function parseForkChanges(body) {
  const section = findSection(body);
  if (!section) return null;
  const content = section.map((l) => l.line).join("\n").trim();
  if (!content) {
    throw formatError('the "Fork feature changes" section is empty; write "none" or a "### fork:<slug>" group per feature');
  }
  if (/^none$/i.test(content)) return { none: true, features: [] };

  const features = [];
  let feature = null;
  let block = null;
  for (const { line, code } of section) {
    const group = code ? null : /^###\s+(.*?)\s*$/.exec(line);
    const heading = code ? null : /^####\s+(.*?)\s*$/.exec(line);
    if (group) {
      const slug = /^fork:(\S+)$/.exec(group[1])?.[1];
      if (!slug || !SLUG.test(slug)) {
        throw formatError(`"${line}" is not a feature group; expected "### fork:<slug>" with a lowercase, hyphenated slug`);
      }
      if (features.some((f) => f.slug === slug)) throw formatError(`"### fork:${slug}" appears twice; merge its blocks into one group`);
      feature = { slug, blocks: [] };
      features.push(feature);
      block = null;
    } else if (heading) {
      if (!feature) throw formatError(`"${line}" comes before any "### fork:<slug>" group`);
      const name = heading[1];
      if (!name) throw formatError(`fork:${feature.slug} has a "####" heading with no section name`);
      if (feature.blocks.some((b) => b.name === name)) {
        throw formatError(`fork:${feature.slug} has two "#### ${name}" blocks; keep one`);
      }
      block = { name, lines: [] };
      feature.blocks.push(block);
    } else if (block) {
      block.lines.push(line);
    } else if (line.trim()) {
      throw formatError(
        feature
          ? `text under "### fork:${feature.slug}" must sit in a "#### <Section>" block: "${line}"`
          : `expected "none" or "### fork:<slug>", found "${line}"`,
      );
    }
  }
  return {
    none: false,
    features: features.map((f) => {
      if (!f.blocks.length) throw formatError(`"### fork:${f.slug}" has no "#### <Section>" blocks`);
      return { slug: f.slug, blocks: f.blocks.map((b) => finishBlock(f.slug, b)) };
    }),
  };
}

function finishBlock(slug, { name, lines }) {
  const first = lines.findIndex((l) => l.trim());
  const base = first === -1 ? null : /^base:\s*(new|[0-9a-f]{12})$/i.exec(lines[first].trim())?.[1]?.toLowerCase();
  if (!base) {
    throw formatError(
      `fork:${slug} / ${name}: the first line must be "base: <12 hex characters>" or "base: new"; print it with \`node scripts/fork-delta.mjs base ${slug} "${name}"\``,
    );
  }
  const text = normalizeSection(lines.slice(first + 1).join("\n"));
  if (name !== "Status") return { name, base, text };
  const status = /^[a-z-]*/.exec(text)?.[0] ?? "";
  if (!STATUSES.includes(status)) {
    const found = text.split(/\s/, 1)[0];
    throw formatError(`fork:${slug} / Status: the block must start with one of ${STATUSES.join(", ")}, found "${found}"`);
  }
  return { name, base, text, status, note: text.slice(status.length).replace(/^[\s,:;.-]+/, "") };
}

/** A tracking issue body split at its `### <Section>` headings. */
export function parseIssueBody(body) {
  const preamble = [];
  const sections = [];
  for (const { line, code } of scanLines(body ?? "")) {
    const heading = code ? null : /^###\s+(.*?)\s*$/.exec(line);
    if (heading) sections.push({ name: heading[1], lines: [] });
    else (sections.at(-1)?.lines ?? preamble).push(line);
  }
  return {
    preamble: normalizeSection(preamble.join("\n")),
    sections: sections.map((s) => ({ name: s.name, text: normalizeSection(s.lines.join("\n")) })),
  };
}

/** An issue body for `feature`, preamble first and sections in order. */
export function renderIssueBody(feature) {
  const parts = feature.sections.map((s) => (s.text ? `### ${s.name}\n\n${s.text}` : `### ${s.name}`));
  return `${[feature.preamble, ...parts].filter(Boolean).join("\n\n")}\n`;
}

/** The status line a Status block's base is taken over, for example `open none`. */
export function statusLine(feature) {
  return `${feature.state} ${feature.statusLabels.join(",") || "none"}`;
}

function statusFields(status) {
  if (status === "active") return { state: "open", statusLabels: [] };
  if (status === "in-progress") return { state: "open", statusLabels: [`${STATUS_LABEL}in-progress`] };
  return { state: "closed", statusLabels: [`${STATUS_LABEL}${status}`] };
}

function emptyFeature(slug) {
  return { slug, issue: null, exists: false, state: "open", statusLabels: [], preamble: "", sections: [] };
}

/** Each feature's state, keyed by slug, from its tracking issue. */
export function featuresFromIssues(issues) {
  const features = new Map();
  for (const issue of issues) {
    for (const label of issue.labels) {
      if (!label.startsWith(FEATURE_LABEL)) continue;
      const slug = label.slice(FEATURE_LABEL.length);
      const other = features.get(slug);
      if (other) throw new Error(`${label} is on more than one tracking issue: #${other.issue} and #${issue.number}`);
      const { preamble, sections } = parseIssueBody(issue.body);
      const names = sections.map((s) => s.name);
      const repeated = names.find((name, i) => names.indexOf(name) !== i);
      if (repeated) throw new Error(`issue #${issue.number} has two "### ${repeated}" sections`);
      features.set(slug, {
        slug,
        issue: issue.number,
        exists: true,
        state: issue.state.toLowerCase() === "closed" ? "closed" : "open",
        statusLabels: issue.labels.filter((l) => l.startsWith(STATUS_LABEL)).sort(),
        preamble,
        sections,
      });
    }
  }
  return features;
}

/** `features` after a PR's parsed changes apply. The input is left untouched. */
export function applyChanges(features, changes) {
  const next = new Map(features);
  for (const { slug, blocks } of changes.features) {
    const feature = structuredClone(next.get(slug) ?? emptyFeature(slug));
    feature.exists = true;
    for (const block of blocks) {
      if (block.status) {
        Object.assign(feature, statusFields(block.status));
        continue;
      }
      const section = feature.sections.find((s) => s.name === block.name);
      if (section) section.text = block.text;
      else feature.sections.push({ name: block.name, text: block.text });
    }
    next.set(slug, feature);
  }
  return next;
}

/** The base a block replacing `section` of `slug` must carry now: a 12-hex hash, or `new`. */
export function currentBase(features, slug, section) {
  const feature = features.get(slug);
  if (!feature?.exists) return "new";
  if (section === "Status") return sectionHash(statusLine(feature));
  const found = feature.sections.find((s) => s.name === section);
  return found ? sectionHash(found.text) : "new";
}

/** Every block whose base no longer matches the section it replaces. */
export function staleBlocks(features, changes) {
  return changes.features.flatMap(({ slug, blocks }) =>
    blocks.flatMap((block) => {
      const current = currentBase(features, slug, block.name);
      return block.base === current ? [] : [{ slug, section: block.name, base: block.base, current }];
    }),
  );
}

function byMergeOrder(a, b) {
  return a.mergedAt < b.mergedAt ? -1 : a.mergedAt > b.mergedAt ? 1 : a.number - b.number;
}

/** Merged PRs the refresh still has to apply, oldest merge first. */
export function pendingPrs(prs) {
  return prs
    .filter(
      (pr) =>
        pr.mergedAt &&
        !pr.labels.includes(APPLIED_LABEL) &&
        (pr.labels.some((l) => l.startsWith(FEATURE_LABEL)) || hasSection(pr.body)),
    )
    .sort(byMergeOrder);
}

function hasSection(body) {
  return scanLines(body ?? "").some((l) => !l.code && SECTION_HEADING.test(l.line));
}

function tryParse(body) {
  try {
    return { changes: parseForkChanges(body), error: null };
  } catch (err) {
    if (!(err instanceof ForkDeltaFormatError)) throw err;
    return { changes: null, error: err.message };
  }
}

/** The features a PR names, read leniently so a malformed section still holds them. */
function namedSlugs(pr) {
  const fromLabels = pr.labels.filter((l) => l.startsWith(FEATURE_LABEL)).map((l) => l.slice(FEATURE_LABEL.length));
  const fromHeadings = scanLines(pr.body ?? "").flatMap((l) => {
    const slug = l.code ? null : /^###\s+fork:(\S+)\s*$/.exec(l.line)?.[1];
    return slug ? [slug] : [];
  });
  return [...new Set([...fromLabels, ...fromHeadings])];
}

/**
 * The issues with every pending PR overlaid in merge order. With `cutoff`, a PR, only the ones
 * merged before it, never the cutoff PR itself; an unmerged cutoff merges after all of them.
 * A pending PR whose section does not parse cannot be overlaid and is listed in `skipped`.
 */
export function overlayFor(issues, prs, cutoff = null) {
  let features = featuresFromIssues(issues);
  const skipped = [];
  for (const pr of pendingPrs(prs)) {
    if (cutoff && (pr.number === cutoff.number || (cutoff.mergedAt && byMergeOrder(pr, cutoff) > 0))) continue;
    const { changes, error } = tryParse(pr.body);
    if (error) skipped.push(pr.number);
    else if (changes) features = applyChanges(features, changes);
  }
  return { features, skipped };
}

/**
 * What the refresh does with each pending PR, in merge order: `apply`, `stale` (a block's base
 * does not match), `held` (it names a feature an earlier stale, held or invalid PR names), or
 * `invalid` (its section does not parse). `features` is the state after every `apply`.
 */
export function planRefresh(issues, prs) {
  let features = featuresFromIssues(issues);
  const holders = new Map();
  const entries = [];
  for (const pr of pendingPrs(prs)) {
    const { changes, error } = tryParse(pr.body);
    const slugs = changes ? changes.features.map((f) => f.slug) : error ? namedSlugs(pr) : [];
    const heldBehind = [...new Set(slugs.flatMap((slug) => [...(holders.get(slug) ?? [])]))].sort((a, b) => a - b);
    const stale = changes && !heldBehind.length ? staleBlocks(features, changes) : [];
    const verdict = error ? "invalid" : heldBehind.length ? "held" : stale.length ? "stale" : "apply";
    if (verdict === "apply") {
      if (changes) features = applyChanges(features, changes);
    } else {
      for (const slug of slugs) holders.set(slug, (holders.get(slug) ?? new Set()).add(pr.number));
    }
    entries.push({ number: pr.number, verdict, features: slugs, stale, heldBehind, error, missingSection: !changes && !error });
  }
  return { entries, features };
}

/**
 * Whether `target` may apply: its section parses (or this throws), every base matches the
 * issues with the unapplied PRs merged before it overlaid, and no earlier pending PR that names
 * one of its features is held. An unmerged target is checked as if it merged next.
 */
export function checkPr(target, issues, prs) {
  const changes = parseForkChanges(target.body);
  const applied = target.labels.includes(APPLIED_LABEL);
  const result = { number: target.number, changes, applied, stale: [], heldBehind: [], ok: true };
  if (applied || !changes || changes.none) return result;
  const stale = staleBlocks(overlayFor(issues, prs, target).features, changes);
  const earlier = prs.filter((pr) => pr.number !== target.number && (!target.mergedAt || byMergeOrder(pr, target) < 0));
  const slugs = new Set(changes.features.map((f) => f.slug));
  const heldBehind = planRefresh(issues, earlier)
    .entries.filter((e) => e.verdict !== "apply" && e.features.some((slug) => slugs.has(slug)))
    .map((e) => e.number);
  return { ...result, stale, heldBehind, ok: !stale.length && !heldBehind.length };
}

/** `show`'s output: which issue, its status line, then the body the refresh will write. */
export function renderShow(features, slug) {
  const feature = features.get(slug);
  if (!feature?.exists) throw new UsageError(`no tracking issue carries fork:${slug}, and no pending PR creates it`);
  const where = feature.issue ? `#${feature.issue}` : "not created yet";
  return `fork:${slug} (${where})\nStatus: ${statusLine(feature)}\n\n${renderIssueBody(feature)}`;
}

/** `check`'s report and exit code. */
export function formatCheck(result) {
  const n = `PR #${result.number}`;
  if (result.applied) return { text: `${n}: already applied (${APPLIED_LABEL})`, code: 0 };
  if (!result.changes) return { text: `${n}: no "Fork feature changes" section, nothing to apply`, code: 0 };
  if (result.changes.none) return { text: `${n}: none, nothing to apply`, code: 0 };
  const lines = [];
  for (const s of result.stale) {
    lines.push(`  fork:${s.slug} / ${s.section}: written against ${s.base}, now ${s.current}`);
  }
  if (result.stale.length) {
    const cli = "node scripts/fork-delta.mjs";
    lines.push("  Repair: rewrite each stale block against its feature, keeping both changes:");
    for (const slug of new Set(result.stale.map((s) => s.slug))) {
      lines.push(`    ${cli} show ${slug} --pr ${result.number}`);
    }
    lines.push("  then set each block's base from:");
    for (const s of result.stale) {
      lines.push(`    ${cli} base ${s.slug} "${s.section}" --pr ${result.number}`);
    }
  }
  if (result.heldBehind.length) {
    lines.push(`  held behind ${result.heldBehind.map((h) => `#${h}`).join(", ")}, which name the same features; repair those first`);
  }
  if (result.ok) {
    const blocks = result.changes.features.reduce((sum, f) => sum + f.blocks.length, 0);
    const slugs = result.changes.features.map((f) => `fork:${f.slug}`).join(", ");
    return { text: `${n}: ok, ${blocks} block(s) across ${slugs} match their base`, code: 0 };
  }
  return { text: [`${n}: ${result.stale.length ? "stale" : "held"}`, ...lines].join("\n"), code: 1 };
}

/** `pending`'s report: one line per pending PR. */
export function formatPlan(entries) {
  if (!entries.length) return "no merged PR is waiting to be applied";
  return entries
    .map((e) => {
      const named = e.features.map((s) => `fork:${s}`).join(", ") || (e.missingSection ? "(no section)" : "(none)");
      const why = e.error
        ? `: ${e.error}`
        : e.heldBehind.length
          ? `: behind ${e.heldBehind.map((h) => `#${h}`).join(", ")}`
          : e.stale.length
            ? `: ${e.stale.map((s) => `fork:${s.slug} / ${s.section}`).join(", ")}`
            : "";
      return `#${e.number} ${e.verdict.padEnd(7)} ${named}${why}`;
    })
    .join("\n");
}

function gh(args, repo) {
  const bin = process.env.MISSION_GH_BIN || "gh";
  const out = execFileSync(bin, repo ? [...args, "--repo", repo] : args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(out);
}

function labelNames(labels) {
  return labels.map((l) => l.name);
}

function fetchIssues(repo) {
  const json = "number,state,labels,body";
  return gh(["issue", "list", "--label", "fork-feature", "--state", "all", "--limit", "1000", "--json", json], repo).map(
    (issue) => ({ ...issue, labels: labelNames(issue.labels) }),
  );
}

function fetchPendingCandidates(repo, since) {
  const search = ["base:main", `-label:"${APPLIED_LABEL}"`, since ? `merged:>=${since}` : ""].filter(Boolean).join(" ");
  const args = ["pr", "list", "--state", "merged", "--search", search, "--limit", "1000", "--json", "number,mergedAt,labels,body"];
  return gh(args, repo).map((pr) => ({ ...pr, labels: labelNames(pr.labels) }));
}

function fetchPr(number, repo) {
  const pr = gh(["pr", "view", String(number), "--json", "number,state,baseRefName,mergedAt,labels,body"], repo);
  const merged = pr.state === "MERGED" && pr.baseRefName === "main";
  return { number: pr.number, mergedAt: merged ? pr.mergedAt : null, labels: labelNames(pr.labels), body: pr.body };
}

function usage() {
  return [
    "usage: node scripts/fork-delta.mjs check <pr>",
    '       node scripts/fork-delta.mjs base <slug> "<section>" [--pr <n>]',
    "       node scripts/fork-delta.mjs show <slug> [--pr <n>]",
    "       node scripts/fork-delta.mjs pending",
    "       (each also takes --repo <owner/name> and --since <YYYY-MM-DD>)",
  ].join("\n");
}

function prNumber(value) {
  if (!/^\d+$/.test(value ?? "")) throw new UsageError(`expected a PR number, got ${JSON.stringify(value)}`);
  return Number(value);
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { pr: { type: "string" }, repo: { type: "string" }, since: { type: "string" } },
  });
  const [command, ...rest] = positionals;
  const { repo, since } = values;
  const slugArg = (value) => {
    const slug = (value ?? "").replace(/^fork:/, "");
    if (!SLUG.test(slug)) throw new UsageError(`expected a feature slug, got ${JSON.stringify(value)}`);
    return slug;
  };

  if (command === "check" && rest.length === 1) {
    const target = fetchPr(prNumber(rest[0]), repo);
    const result = checkPr(target, fetchIssues(repo), fetchPendingCandidates(repo, since));
    const { text, code } = formatCheck(result);
    process.stdout.write(`${text}\n`);
    return code;
  }
  if (command === "pending" && rest.length === 0) {
    process.stdout.write(`${formatPlan(planRefresh(fetchIssues(repo), fetchPendingCandidates(repo, since)).entries)}\n`);
    return 0;
  }
  if ((command === "base" && rest.length === 2) || (command === "show" && rest.length === 1)) {
    const slug = slugArg(rest[0]);
    const cutoff = values.pr === undefined ? null : fetchPr(prNumber(values.pr), repo);
    const { features, skipped } = overlayFor(fetchIssues(repo), fetchPendingCandidates(repo, since), cutoff);
    if (skipped.length) {
      process.stderr.write(`warning: not overlaid, their sections do not parse: ${skipped.map((n) => `#${n}`).join(", ")}\n`);
    }
    const out = command === "base" ? `base: ${currentBase(features, slug, rest[1])}\n` : renderShow(features, slug);
    process.stdout.write(out);
    return 0;
  }
  throw new UsageError(usage());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(err instanceof ForkDeltaFormatError ? `fork-delta: format error: ${message}` : `fork-delta: ${message}`);
    process.exitCode = exitCodeFor(err);
  }
}
