import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectorFindingPostedLine,
  omittedFindingsLine,
  renderInspectorFindings,
} from "../src/server/inspector/findings-text.ts";
import { WORKFLOW_LIMITS } from "../src/shared/workflow.ts";
import type { InspectorComment } from "../src/shared/types.ts";

// What is at stake: this section is what a session reads to decide where a finding lives.
// A draft called "posted" sends the agent hunting for a thread that does not exist; a
// posted finding called "the only copy" hides the conversation already on it. And a
// section clipped mid-finding hands over half an instruction with no word that the rest
// exists, which is why the budget drops whole findings and counts them instead.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

function finding(
  fingerprint: string,
  severity: InspectorComment["severity"] = "major",
  over: Partial<InspectorComment> = {},
): InspectorComment {
  return {
    id: fingerprint,
    prKey: "owner/repo#7",
    fingerprint,
    path: "src/a.ts",
    line: 12,
    title: `${severity} ${fingerprint}`,
    body: `${severity} detail for ${fingerprint}`,
    severity,
    round: 1,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    postedAt: 1_000,
    githubUrl: `https://github.com/owner/repo/pull/7#discussion_r${fingerprint}`,
    legacyPosted: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const ONLY_COPY = "Not posted on GitHub. This message is the only copy.";

test("every phase 2 posted marker reads what the row proves", () => {
  const cases: Array<[string, Partial<InspectorComment>, string]> = [
    ["posted with a link", {}, "Posted on GitHub: https://github.com/owner/repo/pull/7#discussion_rf"],
    ["posted, link not captured", { githubUrl: null }, "Posted on GitHub (link not captured yet)"],
    [
      "demoted into the review summary",
      { line: null, githubUrl: "https://github.com/owner/repo/pull/7#pullrequestreview-9" },
      "Posted on GitHub in the review summary: https://github.com/owner/repo/pull/7#pullrequestreview-9",
    ],
    ["a draft never posted", { status: "drafted", postedAt: null, githubUrl: null }, ONLY_COPY],
    [
      "a draft whose earlier version was posted",
      { status: "drafted", postedAt: 500, githubUrl: "https://github.com/owner/repo/pull/7#discussion_r1" },
      "Not posted again. An earlier version was posted on GitHub: https://github.com/owner/repo/pull/7#discussion_r1",
    ],
    ["being posted", { status: "posting", postedAt: null, githubUrl: null }, "Being posted now"],
  ];
  for (const [name, over, line] of cases) {
    assert.equal(inspectorFindingPostedLine(finding("f", "major", over)), line, name);
    const section = renderInspectorFindings([finding("f", "major", over)], { budgetBytes: 8_000 });
    assert.ok(section.text.split("\n").includes(line), `${name}: the section carries its marker`);
  }
});

test("a draft posted earlier is never called the only copy", () => {
  const earlier: Array<[string, Partial<InspectorComment>]> = [
    ["by postedAt, with the earlier link", { status: "drafted", postedAt: 500 }],
    ["by the legacy backfill", { status: "drafted", postedAt: null, legacyPosted: "posted" }],
    ["with no link captured", { status: "drafted", postedAt: 500, githubUrl: null }],
  ];
  for (const [name, over] of earlier) {
    const line = inspectorFindingPostedLine(finding("f", "major", over));
    assert.match(line, /^Not posted again\. An earlier version was posted on GitHub/, name);
    const section = renderInspectorFindings([finding("f", "major", over)], { budgetBytes: 8_000 });
    assert.doesNotMatch(section.text, /only copy/, name);
  }
  // A legacy-unknown row is reachable only once resolved, and says it is unknown, never "only copy".
  const unknown = inspectorFindingPostedLine(
    finding("f", "major", { status: "resolved", postedAt: null, legacyPosted: "unknown" }),
  );
  assert.match(unknown, /^Not known whether this was posted on GitHub/);
});

test("each finding keeps today's shape, dedupe and severity order", () => {
  const rows = [
    finding("minor", "minor"),
    finding("blocker", "blocker", { path: "z.ts" }),
    finding("major", "major"),
    finding("nit", "nit", { path: null, line: null, body: null }),
    finding("major", "major", { title: "a duplicate of the same fingerprint" }),
  ];
  // Caller order never decides which duplicate is kept, so a frozen packet cannot drift.
  const first = renderInspectorFindings(rows, { budgetBytes: 8_000 });
  const second = renderInspectorFindings([...rows].reverse(), { budgetBytes: 8_000 });
  assert.equal(first.text, second.text);
  assert.deepEqual([first.shown, first.omitted, first.truncated], [4, 0, false]);
  assert.equal(first.text.match(/Fingerprint: major/g)?.length, 1);
  assert.equal(first.text.match(/^## MAJOR/gm)?.length, 1);
  const headings = first.text.split("\n").filter((line) => line.startsWith("## "))
    .map((line) => line.split(" - ")[0]);
  assert.deepEqual(headings, ["## BLOCKER", "## MAJOR", "## MINOR", "## NIT"]);
  assert.ok(first.text.startsWith([
    "## BLOCKER - blocker blocker",
    "Location: z.ts:12",
    "Posted on GitHub: https://github.com/owner/repo/pull/7#discussion_rblocker",
    "blocker detail for blocker",
    "Fingerprint: blocker",
    "",
    "## MAJOR",
  ].join("\n")));
  assert.match(first.text, /Location: general\nPosted on GitHub in the review summary: \S+\nLegacy finding detail is unavailable/);
  assert.doesNotMatch(first.text, /more unresolved finding/);
});

test("fields still clip at the per-field limit, and the finding stays whole", () => {
  const huge = "ø".repeat(10_000);
  const section = renderInspectorFindings(
    [finding("huge", "major", { body: huge }), finding("small", "minor")],
    { budgetBytes: 20_000 },
  );
  assert.equal(section.truncated, true);
  assert.deepEqual([section.shown, section.omitted], [2, 0]);
  const body = section.text.split("\n").find((line) => line.startsWith("ø"))!;
  assert.equal(bytes(body), WORKFLOW_LIMITS.feedbackFieldBytes);
  assert.match(section.text, /Fingerprint: huge/);
  assert.match(section.text, /Fingerprint: small/);
});

test("past the budget whole findings drop from the tail, lowest severity first, and are counted", () => {
  const severities = ["nit", "blocker", "minor", "major"] as const;
  const rows = Array.from({ length: 12 }, (_, index) =>
    finding(`f${String(index).padStart(2, "0")}`, severities[index % 4], { body: "d".repeat(400) }));
  const all = renderInspectorFindings(rows, { budgetBytes: 100_000 });
  const budgetBytes = Math.floor(bytes(all.text) / 2);
  const section = renderInspectorFindings(rows, { budgetBytes });

  assert.ok(bytes(section.text) <= budgetBytes);
  assert.ok(section.shown > 0 && section.omitted > 0);
  assert.equal(section.shown + section.omitted, 12);
  assert.equal(section.truncated, false, "no field was clipped to make room");
  // Every listed finding is complete; every left-out one is wholly absent.
  const shownFingerprints = [...section.text.matchAll(/^Fingerprint: (\S+)$/gm)].map((match) => match[1]);
  assert.equal(shownFingerprints.length, section.shown);
  assert.equal(section.text.match(/^## /gm)?.length, section.shown);
  assert.equal(section.text.match(/d{400}/g)?.length, section.shown);
  // The kept set is the head of the severity order, so whatever was dropped ranks no higher.
  const rank = { blocker: 0, major: 1, minor: 2, nit: 3 };
  const kept = rows.filter((row) => shownFingerprints.includes(row.fingerprint));
  const dropped = rows.filter((row) => !shownFingerprints.includes(row.fingerprint));
  const worstKept = Math.max(...kept.map((row) => rank[row.severity]));
  const bestDropped = Math.min(...dropped.map((row) => rank[row.severity]));
  assert.ok(worstKept <= bestDropped, "a higher-severity finding was dropped before a lower one");
  assert.ok(dropped.some((row) => row.severity === "nit"));
  assert.ok(kept.some((row) => row.severity === "blocker"));
  assert.ok(section.text.endsWith(`\n\n${omittedFindingsLine(section.omitted)}`));
  assert.match(
    omittedFindingsLine(section.omitted),
    new RegExp(`^${section.omitted} more unresolved findings are not listed here, to keep this message short\\. They stay open and come back in the next relay\\.$`),
  );
});

test("the omitted count reads in the singular for one finding", () => {
  const rows = [finding("a", "major"), finding("b", "nit")];
  const both = renderInspectorFindings(rows, { budgetBytes: 100_000 });
  const firstOnly = bytes(both.text.split("\n\n")[0]!);
  const section = renderInspectorFindings(rows, {
    budgetBytes: firstOnly + 2 + bytes(omittedFindingsLine(1)),
  });
  assert.deepEqual([section.shown, section.omitted], [1, 1]);
  assert.ok(section.text.endsWith(
    "1 more unresolved finding is not listed here, to keep this message short. It stays open and comes back in the next relay.",
  ));
  assert.doesNotMatch(section.text, /Fingerprint: b/);
});

test("the highest-severity finding is kept, shortened, when not even it fits whole", () => {
  const rows = [finding("top", "blocker", { body: "b".repeat(3_000) }), finding("next", "minor")];
  const budgetBytes = 600;
  const section = renderInspectorFindings(rows, { budgetBytes });
  assert.ok(bytes(section.text) <= budgetBytes);
  assert.deepEqual([section.shown, section.omitted, section.truncated], [1, 1, true]);
  assert.match(section.text, /^## BLOCKER - blocker top\nLocation: src\/a\.ts:12\nPosted on GitHub: \S+\nb+\nFingerprint: top\n\n1 more/);

  const nothing = renderInspectorFindings(rows, { budgetBytes: 10 });
  assert.ok(bytes(nothing.text) <= 10);
  assert.deepEqual([nothing.shown, nothing.omitted], [0, 2]);
  assert.deepEqual(renderInspectorFindings([], { budgetBytes: 100 }), {
    text: "",
    shown: 0,
    omitted: 0,
    truncated: false,
  });
});

// Distinct from the packet-level control test in `workflow-security.test.ts`: Foreman's relay
// types this section without `finalizePacket`, so the section must be safe on its own.
test("the section is sanitized for a terminal before it is measured", () => {
  const section = renderInspectorFindings([
    finding("ctl", "major", {
      title: "Fix\u001b[2Jtitle",
      body: "Body\u0000with\u009fcontrols\r\nand\ttabs",
      githubUrl: "https://github.com/owner/repo/pull/7#discussion_r1\u0007",
    }),
  ], { budgetBytes: 8_000 });
  const forbidden = [...section.text].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x09
      || (codePoint >= 0x0b && codePoint <= 0x1f)
      || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
  assert.equal(forbidden, false);
  assert.match(section.text, /Bodywithcontrols\nand  tabs/);
});

// Foreman's worker talks to the daemon over HTTP and never touches SQLite. If this module
// ever reaches the database or a network client, Foreman would load that too.
test("the renderer's import graph reaches no database or network module", () => {
  const entry = join(repoRoot, "src/server/inspector/findings-text.ts");
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  const specifiers = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(specifiers)) {
      const specifier = match[1] ?? match[2] ?? match[3]!;
      let target: string | null = null;
      if (specifier.startsWith("@shared/")) target = join(repoRoot, "src/shared", specifier.slice(8));
      else if (specifier.startsWith(".")) target = resolve(dirname(file), specifier);
      if (!target) {
        external.add(specifier);
        continue;
      }
      const candidates = [target, target.replace(/\.js$/, ".ts"), `${target}.ts`];
      const found = candidates.find((candidate) => existsSync(candidate) && candidate.match(/\.(ts|mjs|js)$/));
      assert.ok(found, `unresolved import ${specifier} in ${relative(repoRoot, file)}`);
      queue.push(found);
    }
  }
  const local = [...seen].map((file) => relative(repoRoot, file)).sort();
  const outsideShared = local.filter((file) => !file.startsWith("src/shared/"));
  assert.deepEqual(outsideShared, [
    "src/server/inspector/findings-text.ts",
    "src/server/util/utf8.ts",
    "src/server/workflows/packet-text.ts",
  ]);
  const forbidden = [...external].filter((specifier) =>
    /^node:(sqlite|http|https|http2|net|tls|dgram|child_process|worker_threads)$/.test(specifier));
  assert.deepEqual(forbidden, [], `forbidden imports: ${forbidden.join(", ")}`);
});
