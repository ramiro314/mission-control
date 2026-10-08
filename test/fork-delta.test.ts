import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  APPLIED_LABEL,
  ForkDeltaFormatError,
  checkPr,
  currentBase,
  featuresFromIssues,
  formatCheck,
  formatPlan,
  overlayFor,
  parseForkChanges,
  parseIssueBody,
  planRefresh,
  renderIssueBody,
  renderShow,
  sectionHash,
  statusLine,
  type Issue,
  type MergedPr,
} from "../scripts/fork-delta.mjs";

// What is at stake: a refresh that overwrites one PR's contract edit with another's. Every
// fixture here is a hand-built issue or PR body; nothing reaches GitHub.

type Blocks = Record<string, Record<string, { base: string; text: string }>>;

function issue(number: number, slug: string, sections: Record<string, string>, status: string[] = [], state = "OPEN"): Issue {
  const body = Object.entries(sections)
    .map(([name, text]) => `### ${name}\n\n${text}`)
    .join("\n\n");
  return { number, state, labels: ["fork-feature", `fork:${slug}`, ...status], body };
}

function section(blocks: Blocks): string {
  return Object.entries(blocks)
    .map(([slug, named]) =>
      [`### fork:${slug}`, ...Object.entries(named).map(([name, b]) => `#### ${name}\nbase: ${b.base}\n${b.text}`)].join("\n"),
    )
    .join("\n\n");
}

function pr(number: number, mergedAt: string | null, blocks: Blocks): MergedPr {
  const labels = Object.keys(blocks).map((slug) => `fork:${slug}`);
  const body = `## Summary\n\nA change.\n\n## Fork feature changes\n\n${section(blocks)}\n\n## Test plan\n\n- ran it\n`;
  return { number, mergedAt, labels, body };
}

const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}T12:00:00Z`;

/** The base an author copies into a block: `base <slug> "<section>" [--pr <n>]`. */
function base(issues: Issue[], prs: MergedPr[], slug: string, name: string, cutoff: MergedPr | null = null) {
  return currentBase(overlayFor(issues, prs, cutoff).features, slug, name);
}

/** One refresh: apply what may apply, write the issues back, label the applied PRs. */
function refresh(issues: Issue[], prs: MergedPr[]) {
  const { entries, features } = planRefresh(issues, prs);
  const applied = new Set(entries.filter((e) => e.verdict === "apply").map((e) => e.number));
  let next = 900;
  const written = [...features.values()].map((f) => ({
    number: f.issue ?? next++,
    state: f.state.toUpperCase(),
    labels: ["fork-feature", `fork:${f.slug}`, ...f.statusLabels],
    body: renderIssueBody(f),
  }));
  const labelled = prs.map((p) => (applied.has(p.number) ? { ...p, labels: [...p.labels, APPLIED_LABEL] } : p));
  return { entries, issues: written, prs: labelled };
}

const verdicts = (entries: { number: number; verdict: string }[]) => entries.map((e) => [e.number, e.verdict]);

test("parses none, per-feature groups and section blocks, and a body with no section", () => {
  assert.equal(parseForkChanges("## Summary\n\nNo feature here.\n"), null);
  assert.deepEqual(parseForkChanges("## Fork feature changes\n\nnone\n\n## Test plan\n- x"), { none: true, features: [] });

  const parsed = parseForkChanges(
    [
      "## Fork feature changes",
      "",
      "### fork:per-task-base-branch",
      "#### Behavior contracts",
      "base: 3F9A1C07BE42",
      "- the complete new list",
      "```md",
      "### not a heading inside a fence",
      "```",
      "#### Upstream surfaces touched",
      "base: new",
      "src/server/tasks.ts",
      "",
      "### fork:windows-support",
      "#### Status",
      "base: 51c0e8d2a7b3",
      "superseded by upstream's own port",
      "",
      "## Test plan",
      "- not part of the section",
    ].join("\r\n"),
  );
  assert.deepEqual(parsed, {
    none: false,
    features: [
      {
        slug: "per-task-base-branch",
        blocks: [
          {
            name: "Behavior contracts",
            base: "3f9a1c07be42",
            text: "- the complete new list\n```md\n### not a heading inside a fence\n```",
          },
          { name: "Upstream surfaces touched", base: "new", text: "src/server/tasks.ts" },
        ],
      },
      {
        slug: "windows-support",
        blocks: [
          {
            name: "Status",
            base: "51c0e8d2a7b3",
            text: "superseded by upstream's own port",
            status: "superseded",
            note: "by upstream's own port",
          },
        ],
      },
    ],
  });
});

test("a malformed section gets a format error naming what is wrong", () => {
  const cases: [string, RegExp][] = [
    ["", /empty; write "none"/],
    ["#### Intent\nbase: new\nx", /before any "### fork:<slug>" group/],
    ["stray text", /expected "none" or "### fork:<slug>"/],
    ["### Per task base branch\n#### Intent\nbase: new\nx", /not a feature group/],
    ["### fork:Per_Task\n#### Intent\nbase: new\nx", /not a feature group/],
    ["### fork:a\nloose line", /must sit in a "#### <Section>" block/],
    ["### fork:a", /has no "#### <Section>" blocks/],
    ["### fork:a\n#### Intent\nx", /first line must be "base: <12 hex characters>" or "base: new"/],
    ["### fork:a\n#### Intent\nbase: 3f9a1c07\nx", /first line must be "base:/],
    ["### fork:a\n#### Intent\nbase: new\nx\n#### Intent\nbase: new\ny", /two "#### Intent" blocks/],
    ["### fork:a\n#### Intent\nbase: new\nx\n### fork:a\n#### Plan docs\nbase: new\ny", /appears twice/],
    ["### fork:a\n#### Status\nbase: new\nfinished", /must start with one of active, in-progress/],
  ];
  for (const [content, message] of cases) {
    assert.throws(
      () => parseForkChanges(`## Fork feature changes\n\n${content}\n`),
      (err: unknown) => err instanceof ForkDeltaFormatError && message.test(err.message),
      JSON.stringify(content),
    );
  }
  assert.throws(
    () => parseForkChanges("## Fork feature changes\nnone\n## Fork feature changes\nnone"),
    /2 "## Fork feature changes" sections/,
  );
});

test("the hash is the first 12 hex characters of SHA-256 over the section text, stable across runs", () => {
  const text = "- Each task records its own base branch.";
  assert.equal(sectionHash(text), createHash("sha256").update(text).digest("hex").slice(0, 12));
  // Pinned: a hash that moved between runs or releases would hold back every pending PR.
  assert.equal(sectionHash(text), "c02a38803abf");
  assert.equal(sectionHash(`\r\n\n${text}  \r\n\r\n`), "c02a38803abf");

  const [feature] = featuresFromIssues([issue(7, "a", { Intent: text })]).values();
  assert.ok(feature);
  assert.equal(currentBase(featuresFromIssues([issue(7, "a", { Intent: text })]), "a", "Intent"), "c02a38803abf");
  // A body written back by the refresh hashes the same as the one it was read from.
  assert.deepEqual(parseIssueBody(renderIssueBody(feature)).sections, feature.sections);
});

test("the Status hash is taken over open or closed plus the fork-status label or none", () => {
  const features = featuresFromIssues([
    issue(1, "active-one", {}),
    issue(2, "wip", {}, ["fork-status:in-progress"]),
    issue(3, "gone", {}, ["fork-status:superseded"], "CLOSED"),
  ]);
  const line = (slug: string) => statusLine(features.get(slug)!);
  assert.equal(line("active-one"), "open none");
  assert.equal(line("wip"), "open fork-status:in-progress");
  assert.equal(line("gone"), "closed fork-status:superseded");
  assert.equal(currentBase(features, "active-one", "Status"), "8349ab9d8214");
  assert.equal(currentBase(features, "wip", "Status"), sectionHash("open fork-status:in-progress"));
  assert.equal(currentBase(features, "missing", "Status"), "new");
  assert.equal(currentBase(features, "active-one", "Fork-only files"), "new");
});

test("a PR written while another PR for the same feature is merged but unapplied is not stale", () => {
  const issues = [issue(10, "a", { "Behavior contracts": "- one" })];
  const first = pr(101, day(1), { a: { "Behavior contracts": { base: base(issues, [], "a", "Behavior contracts"), text: "- one\n- two" } } });

  // Written after #101 merged and before the refresh applied it: the base overlays #101.
  const secondBase = base(issues, [first], "a", "Behavior contracts");
  assert.equal(secondBase, sectionHash("- one\n- two"));
  assert.notEqual(secondBase, currentBase(featuresFromIssues(issues), "a", "Behavior contracts"));
  const second = pr(102, null, { a: { "Behavior contracts": { base: secondBase, text: "- one\n- two\n- three" } } });

  assert.equal(checkPr(second, issues, [first]).ok, true);
  const merged = { ...second, mergedAt: day(2) };
  assert.equal(checkPr(merged, issues, [first, merged]).ok, true);
  assert.deepEqual(verdicts(planRefresh(issues, [first, merged]).entries), [[101, "apply"], [102, "apply"]]);
});

test("two PRs edited against the same base: the second is reported stale and not applied", () => {
  const issues = [issue(10, "a", { "Behavior contracts": "- one" })];
  const h = base(issues, [], "a", "Behavior contracts");
  const first = pr(101, day(1), { a: { "Behavior contracts": { base: h, text: "- one\n- two" } } });
  const second = pr(102, day(2), { a: { "Behavior contracts": { base: h, text: "- one\n- three" } } });

  const plan = planRefresh(issues, [second, first]);
  assert.deepEqual(verdicts(plan.entries), [[101, "apply"], [102, "stale"]]);
  assert.deepEqual(plan.entries[1]?.stale, [
    { slug: "a", section: "Behavior contracts", base: h, current: sectionHash("- one\n- two") },
  ]);
  assert.equal(plan.features.get("a")?.sections[0]?.text, "- one\n- two");

  const result = checkPr(second, issues, [first, second]);
  assert.equal(result.ok, false);
  const { text, code } = formatCheck(result);
  assert.equal(code, 1);
  assert.match(text, /^PR #102: stale\n {2}fork:a \/ Behavior contracts: written against [0-9a-f]{12}, now [0-9a-f]{12}/);
  assert.match(text, /base a "<section>" --pr 102/);
});

test("two concurrent Status blocks: the second is stale", () => {
  const issues = [issue(10, "a", {}, ["fork-status:in-progress"])];
  const h = base(issues, [], "a", "Status");
  const done = pr(101, day(1), { a: { Status: { base: h, text: "active" } } });
  const dropped = pr(102, day(2), { a: { Status: { base: h, text: "removed, replaced by fork:b" } } });
  const plan = planRefresh(issues, [done, dropped]);
  assert.deepEqual(verdicts(plan.entries), [[101, "apply"], [102, "stale"]]);
  assert.equal(statusLine(plan.features.get("a")!), "open none");
});

test("a held PR holds back every later PR naming any of its features, and others continue", () => {
  const issues = [
    issue(10, "a", { Intent: "a0" }),
    issue(11, "b", { Intent: "b0" }),
    issue(12, "c", { Intent: "c0" }),
    issue(13, "d", { Intent: "d0" }),
  ];
  const h = (slug: string) => base(issues, [], slug, "Intent");
  const first = pr(101, day(1), { a: { Intent: { base: h("a"), text: "a1" } } });
  // Stale on a, and also names b, whose block was fine.
  const held = pr(102, day(2), { a: { Intent: { base: h("a"), text: "a2" } }, b: { Intent: { base: h("b"), text: "b1" } } });
  const prs = [first, held];
  // Written after #102 merged, so its b base overlays #102's b block.
  const onB = pr(103, day(3), { b: { Intent: { base: base(issues, prs, "b", "Intent"), text: "b2" } }, c: { Intent: { base: h("c"), text: "c1" } } });
  prs.push(onB);
  // Names only c: held because #103, held itself, names c too.
  const onC = pr(104, day(4), { c: { Intent: { base: base(issues, prs, "c", "Intent"), text: "c2" } } });
  const onD = pr(105, day(5), { d: { Intent: { base: h("d"), text: "d1" } } });
  const none: MergedPr = { number: 106, mergedAt: day(6), labels: ["fork:a"], body: "## Fork feature changes\n\nnone\n" };
  prs.push(onC, onD, none);

  const { entries } = planRefresh(issues, prs);
  assert.deepEqual(verdicts(entries), [
    [101, "apply"],
    [102, "stale"],
    [103, "held"],
    [104, "held"],
    [105, "apply"],
    [106, "apply"],
  ]);
  assert.deepEqual(entries[2]?.heldBehind, [102]);
  assert.deepEqual(entries[3]?.heldBehind, [103]);
  // #103's own blocks match the overlay; it is held only for the feature it shares.
  const result = checkPr(onB, issues, prs);
  assert.deepEqual([result.stale, result.heldBehind, result.ok], [[], [102], false]);
  assert.deepEqual(formatCheck(result), { text: "PR #103: held\n  held behind #102, which name the same features; repair those first", code: 1 });
  assert.deepEqual(formatCheck(checkPr(onD, issues, prs)), { text: "PR #105: ok, 1 block(s) across fork:d match their base", code: 0 });

  // `pending` reports each verdict, and why a PR is not applied.
  assert.deepEqual(formatPlan(entries).split("\n"), [
    "#101 apply   fork:a",
    "#102 stale   fork:a, fork:b: fork:a / Intent",
    "#103 held    fork:b, fork:c: behind #102",
    "#104 held    fork:c: behind #103",
    "#105 apply   fork:d",
    "#106 apply   (none)",
  ]);
  assert.equal(formatPlan([]), "no merged PR is waiting to be applied");
});

test("a PR whose section does not parse holds back the features it names", () => {
  const issues = [issue(10, "a", { Intent: "a0" })];
  const broken: MergedPr = { number: 101, mergedAt: day(1), labels: ["fork:a"], body: "## Fork feature changes\n\n### fork:a\n#### Intent\na1\n" };
  const later = pr(102, day(2), { a: { Intent: { base: base(issues, [], "a", "Intent"), text: "a2" } } });
  const { entries } = planRefresh(issues, [broken, later]);
  assert.deepEqual(verdicts(entries), [[101, "invalid"], [102, "held"]]);
  assert.match(entries[0]?.error ?? "", /first line must be "base:/);
  assert.deepEqual(overlayFor(issues, [broken, later]).skipped, [101]);
  assert.throws(() => checkPr(broken, issues, [broken, later]), ForkDeltaFormatError);
  assert.deepEqual(formatPlan(entries).split("\n"), [
    `#101 invalid fork:a: ${entries[0]?.error}`,
    "#102 held    fork:a: behind #101",
  ]);
});

test("a slug on two tracking issues, or a section heading repeated in one, is refused", () => {
  assert.throws(
    () => featuresFromIssues([issue(1, "a", { Intent: "x" }), issue(2, "a", { Intent: "y" })]),
    /fork:a is on more than one tracking issue: #1 and #2/,
  );
  const repeated = { ...issue(1, "a", {}), body: "### Intent\n\nx\n\n### Intent\n\ny\n" };
  assert.throws(() => featuresFromIssues([repeated]), /issue #1 has two "### Intent" sections/);
});

test("the --pr cutoff excludes PR n and anything merged after it from the overlay", () => {
  const issues = [issue(10, "a", { Intent: "a0" })];
  const prs = [
    pr(101, day(1), { a: { Intent: { base: sectionHash("a0"), text: "a1" } } }),
    pr(102, day(2), { a: { Intent: { base: sectionHash("a1"), text: "a2" } } }),
    pr(103, day(3), { a: { Intent: { base: sectionHash("a2"), text: "a3" } } }),
    { ...pr(99, day(1), { a: { Intent: { base: sectionHash("a0"), text: "applied" } } }), labels: ["fork:a", APPLIED_LABEL] },
  ];
  const text = (cutoff: MergedPr | null) => overlayFor(issues, prs, cutoff).features.get("a")?.sections[0]?.text;
  assert.equal(text(null), "a3");
  assert.equal(text(prs[0]!), "a0");
  assert.equal(text(prs[1]!), "a1");
  assert.equal(text(prs[2]!), "a2");
  // An unmerged PR merges after every one of them.
  assert.equal(text({ number: 120, mergedAt: null, labels: [], body: "" }), "a3");
  assert.match(renderShow(overlayFor(issues, prs, prs[1]!).features, "a"), /^fork:a \(#10\)\nStatus: open none\n\n### Intent\n\na1\n$/);
});

test("a held PR repaired with base --pr passes check, and so do the PRs held behind it, in order", () => {
  let issues = [issue(10, "a", { "Behavior contracts": "- one", "Upstream surfaces touched": "src/a.ts" }), issue(11, "b", { Intent: "b0" })];
  const h = base(issues, [], "a", "Behavior contracts");
  let prs = [
    pr(101, day(1), { a: { "Behavior contracts": { base: h, text: "- one\n- two" } } }),
    pr(102, day(2), { a: { "Behavior contracts": { base: h, text: "- one\n- three" } } }),
  ];
  // Written after #102 merged: another section of a, and feature b.
  prs.push(
    pr(103, day(3), {
      a: { "Upstream surfaces touched": { base: base(issues, prs, "a", "Upstream surfaces touched"), text: "src/a.ts\nsrc/c.ts" } },
      b: { Intent: { base: base(issues, prs, "b", "Intent"), text: "b1" } },
    }),
  );
  // Also written after #102 merged, over #102's stale version of the same section.
  prs.push(pr(104, day(4), { a: { "Behavior contracts": { base: base(issues, prs, "a", "Behavior contracts"), text: "- one\n- three\n- four" } } }));

  let run = refresh(issues, prs);
  assert.deepEqual(verdicts(run.entries), [[101, "apply"], [102, "stale"], [103, "held"], [104, "held"]]);
  ({ issues, prs } = run);

  // Repair #102 against `show a --pr 102`, keeping both changes, with `base --pr 102`.
  const shown = renderShow(overlayFor(issues, prs, prs[1]!).features, "a");
  assert.match(shown, /### Behavior contracts\n\n- one\n- two\n/);
  const repairedBase = base(issues, prs, "a", "Behavior contracts", prs[1]!);
  assert.equal(repairedBase, sectionHash("- one\n- two"));
  prs[1] = { ...pr(102, day(2), { a: { "Behavior contracts": { base: repairedBase, text: "- one\n- two\n- three" } } }) };

  assert.deepEqual(formatCheck(checkPr(prs[1], issues, prs)), {
    text: "PR #102: ok, 1 block(s) across fork:a match their base",
    code: 0,
  });
  assert.equal(checkPr(prs[2]!, issues, prs).ok, true);
  // #104's base included #102's old block, so it is reported stale in turn.
  assert.deepEqual(checkPr(prs[3]!, issues, prs).stale.map((s) => s.section), ["Behavior contracts"]);

  run = refresh(issues, prs);
  assert.deepEqual(verdicts(run.entries), [[102, "apply"], [103, "apply"], [104, "stale"]]);
  ({ issues, prs } = run);
  const features = featuresFromIssues(issues);
  assert.deepEqual(features.get("a")?.sections, [
    { name: "Behavior contracts", text: "- one\n- two\n- three" },
    { name: "Upstream surfaces touched", text: "src/a.ts\nsrc/c.ts" },
  ]);
  assert.equal(features.get("b")?.sections[0]?.text, "b1");

  // Repaired the same way, #104 applies on the next run.
  prs[3] = pr(104, day(4), {
    a: { "Behavior contracts": { base: base(issues, prs, "a", "Behavior contracts", prs[3]!), text: "- one\n- two\n- three\n- four" } },
  });
  assert.equal(checkPr(prs[3], issues, prs).ok, true);
  assert.deepEqual(verdicts(refresh(issues, prs).entries), [[104, "apply"]]);
});

test("a PR for a feature with no tracking issue carries base: new and creates it", () => {
  const prs = [
    pr(101, day(1), {
      "new-thing": {
        Intent: { base: "new", text: "Do a new thing." },
        Status: { base: "new", text: "in-progress" },
      },
    }),
  ];
  assert.equal(base([], [], "new-thing", "Intent"), "new");
  assert.equal(base([], prs, "new-thing", "Intent"), sectionHash("Do a new thing."));
  assert.throws(() => renderShow(overlayFor([], []).features, "new-thing"), /no tracking issue carries fork:new-thing/);
  assert.equal(
    renderShow(overlayFor([], prs).features, "new-thing"),
    "fork:new-thing (not created yet)\nStatus: open fork-status:in-progress\n\n### Intent\n\nDo a new thing.\n",
  );
  const run = refresh([], prs);
  assert.deepEqual(verdicts(run.entries), [[101, "apply"]]);
  assert.equal(run.issues[0]?.body, "### Intent\n\nDo a new thing.\n");
});

test("check reports none, a missing section and an applied PR as nothing to apply", () => {
  const labelled = (body: string, labels = ["fork:a"]): MergedPr => ({ number: 5, mergedAt: day(1), labels, body });
  assert.equal(formatCheck(checkPr(labelled("## Fork feature changes\nnone"), [], [])).text, "PR #5: none, nothing to apply");
  assert.match(formatCheck(checkPr(labelled("## Summary"), [], [])).text, /no "Fork feature changes" section/);
  assert.match(formatCheck(checkPr(labelled("## Summary", [APPLIED_LABEL]), [], [])).text, /already applied/);
  const entries = planRefresh([], [labelled("## Summary"), { ...labelled("## Summary", []), number: 6 }]).entries;
  assert.deepEqual(entries.map((e) => [e.number, e.verdict, e.missingSection]), [[5, "apply", true]]);
});
