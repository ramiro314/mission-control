import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLOSING_MARKER,
  DEFAULT_REPO,
  TEMPLATE_SECTIONS,
  absoluteLinks,
  desiredState,
  executeWrites,
  parseLedger,
  parsePrCell,
  pendingBranches,
  planWrites,
  slugFor,
  unwrap,
  type Actual,
  type Desired,
  type Write,
} from "../scripts/fork-migrate.mjs";

// What is at stake: a one-off migration that writes 18 issues, 24 labels and about 70 PR labels
// into the fork, and is rerun right before its PR merges. A rerun that rewrites what is already
// right, posts a second closing comment, or misses a ledger edit made in between is the failure.
// Every fixture is a hand-written ledger excerpt; the CLI cases talk to a fake `gh`.

const SCRIPT = fileURLToPath(new URL("../scripts/fork-migrate.mjs", import.meta.url));
const FAKE_GH = fileURLToPath(new URL("./helpers/fake-gh-fork.mjs", import.meta.url));

const LEDGER = `# Fork ledger

Intro text.

## Status

| Field | Value |
| --- | --- |
| Last synced upstream | **1.26.0** |

\`\`\`sh
### not an entry, it is in a fence
\`\`\`

## At a glance

| Feature | Status | PRs |
| --- | --- | --- |
| Shape tasks, grill and tickets | Active | #1, #3 |
| Task-source workflow default | Active | Pending (branch \`feat/task-source-workflow\`, issue #234) |
| Per-task base branch | Active (storage, API) | #151 (plan M0.1), #161, issue #136 (session Diff view) |
| CI time-to-green | In progress | #200 (plan), weekly mission PR, #215 (2026-10-05 sync) |
| Dependabot | Removed (2026-09-29, #62) | #35, #40, #41, #43 |
| Standalone fixes | Not a feature | #4, #13 |

## Reading an entry

Each entry records fields.

## Active features

### Shape tasks, grill and tickets

| Field | Value |
| --- | --- |
| Status | **Active** |
| PRs | #1 (plan), #3, #83 (plan: tickets after merge). Related, not claimed: #21 (standalone fix) |
| Plan docs | [shape-task-kind/plan.md](../plans/shape-task-kind/plan.md) sections 1 to 5 |
| Upstream candidate | Maybe. Self-contained. |

**Intent.** A new planning kind, \`shape\`, beside \`plan\`. It interviews the human in rounds
of decision forms before writing a plan.

**Behavior contracts.**

- \`shape\` always asks at least one round, the recommended option
  first, plus a free-text Other.
- Upstream's \`plan\` kind is unchanged.

**Upstream behavior it assumes.**

- \`TASK_KINDS\` is an append-only text enum.

**Upstream surfaces touched.**

- Modules: \`src/server/tasks.ts\`.

**Fork-only files.** \`src/server/plans/shape.ts\`, \`skills/grill/\`.

### Task-source workflow default

| Field | Value |
| --- | --- |
| Status | **Active** |
| PRs | Pending (branch \`feat/task-source-workflow\`, issue #234) |
| Plan docs | None |
| Upstream candidate | Maybe. |

**Intent.** Swept tasks take the source's workflow.

**Behavior contracts.**

- A source names its workflow.

**Upstream behavior it assumes.**

- Sweeps go through one path.

**Upstream surfaces touched.** \`src/server/task-sources/sweeper.ts\`.

**Fork-only files.** None.

### Per-task base branch

| Field | Value |
| --- | --- |
| Status | **Active**. The storage half of plan M0.1. |
| PRs | #151, #161, the session Diff view (issue #136) |
| Plan docs | [windows-support/plan.md](../plans/windows-support/plan.md#decisions) |
| Upstream candidate | Yes. |

**Intent.** A task can name a branch to start from.

**Behavior contracts.**

- The branch is checked on dispatch.

**Upstream behavior it assumes.**

- Worktrees are created from a ref.

**Upstream surfaces touched.** \`src/server/db.ts\` (\`tasks.base_branch\`).

**Fork-only files.** \`test/task-base-branch.test.ts\`.

### CI time-to-green

| Field | Value |
| --- | --- |
| Status | **In progress**. The measured median is pending. |
| PRs | #200 (the plan), #215 |
| Plan docs | [ci-time-to-green/plan.md](../plans/ci-time-to-green/plan.md) |
| Upstream candidate | Maybe. |

**Intent.** A pull request waited too long for \`CI result\`.

**Sub-capabilities.**

- Duration-balanced unit shards.

**Behavior contracts.**

- Node 26 runs off pull requests.

**Upstream behavior it assumes.**

- None; this is the fork's CI.

**Upstream surfaces touched.** \`.github/workflows/ci.yml\`.

**Fork-only files.** \`scripts/ci-tree-reuse.sh\`.

## Superseded and removed

### Dependabot

| Field | Value |
| --- | --- |
| Status | **Removed** 2026-09-29, sync PR #62 |
| PRs | #35 (config), #40 (\`@hono/node-server\` 1.x to 2.x), #41, #43 |
| Plan docs | [upstream-sync/plan.md](../plans/upstream-sync/plan.md) decisions D2 and D5 |
| Upstream candidate | No. |

**Intent (as built).** Automated dependency bumps for the fork.

**Why it was removed.** It moved versions away from upstream, which made every sync fight
the lockfile.

## Standalone fixes

| PR | Merged | What it fixes |
| --- | --- | --- |
| #4 | 2026-09-27 | A fix. |

## Keeping this ledger current

- Rules.
`;

const SLUGS = ["shape-tasks-grill-and-tickets", "task-source-workflow-default", "per-task-base-branch", "ci-time-to-green", "dependabot"];

/**
 * GitHub after a migration of `desired` succeeded, as `fetchState` would read it. Each pending
 * branch has merged as PR 243, 244 and so on.
 */
function migrated(desired: Desired): Actual {
  const pending = [...desired.pending].map(([branch, labels], i) => ({ branch, labels, number: 243 + i }));
  return {
    labels: desired.labels.map((l) => l.name),
    issues: desired.issues.map((issue, i) => ({
      number: 300 + i,
      title: issue.title,
      state: issue.state.toUpperCase(),
      labels: issue.labels,
      body: issue.body.replace(/\n/g, "\r\n"),
      comments: issue.closingComment ? [issue.closingComment] : [],
    })),
    prs: new Map([...desired.prs, ...pending.map((p): [number, string[]] => [p.number, p.labels])].map(([n, labels]) => [n, [...labels]])),
    merged: new Map(pending.map((p) => [p.branch, [p.number]])),
  };
}

const desiredOf = (text: string) => desiredState(parseLedger(text));

function defined<T>(value: T | undefined, what: string): T {
  assert.ok(value !== undefined, `${what} is missing`);
  return value;
}

function only<Op extends Write["op"]>(write: Write | undefined, op: Op): Extract<Write, { op: Op }> {
  assert.equal(write?.op, op);
  return write as Extract<Write, { op: Op }>;
}

test("slugs are the headings lowercased and hyphenated", () => {
  assert.equal(slugFor("Shape tasks, grill and tickets"), "shape-tasks-grill-and-tickets");
  assert.equal(slugFor("PR merge-conflict reactions"), "pr-merge-conflict-reactions");
  assert.equal(slugFor("CI time-to-green"), "ci-time-to-green");
  assert.equal(slugFor("Upstream sync process and fork ledger"), "upstream-sync-process-and-fork-ledger");
  // GitHub refuses a label over 50 characters, so this heading's slug is chosen by hand.
  assert.equal(slugFor("MCP backlog listing and adoption across repositories"), "mcp-backlog-across-repositories");
});

test("a heading whose label GitHub would refuse stops the plan", () => {
  const long = "A heading long enough that its derived label passes fifty";
  assert.throws(() => desiredOf(LEDGER.replaceAll("Task-source workflow default", long)), /GitHub refuses a label name over 50 characters: fork:a-heading-long-enough/);
});

test("a PRs cell yields its PR numbers and skips pending cells, issue numbers and prose", () => {
  assert.deepEqual(parsePrCell("Pending (branch `feat/x`, issue #234)"), { prs: [], skipped: ["Pending (branch `feat/x`, issue #234)"] });
  assert.deepEqual(parsePrCell("#151 (plan M0.1), #161, issue #136 (session Diff view)"), {
    prs: [151, 161],
    skipped: ["issue #136 (session Diff view)"],
  });
  assert.deepEqual(parsePrCell("#59 (plan), weekly mission PR, #175 (2026-10-05 sync), pending (branch `feat/a, b`)"), {
    prs: [59, 175],
    skipped: ["weekly mission PR", "pending (branch `feat/a, b`)"],
  });
  assert.deepEqual(pendingBranches(["Pending (branch `feat/x`, issue #234)", "pending (tickets marker, issue #82)", "weekly mission PR", "issue #136 (branch `fix/y`)"]), ["feat/x"]);
});

test("prose is unwrapped per paragraph and list item, and relative links point at main", () => {
  assert.equal(unwrap("One\ntwo.\n\n- a\n  b\n- c\n\n| x |\n| y |"), "One two.\n\n- a b\n- c\n\n| x |\n| y |");
  assert.equal(unwrap("```\nkeep\nlines\n```"), "```\nkeep\nlines\n```");
  assert.equal(
    absoluteLinks("[p](../plans/a/plan.md#d) [s](../upstream-sync.md) [x](https://e.com) [h](#top)", "o/r"),
    "[p](https://github.com/o/r/blob/main/docs/plans/a/plan.md#d) [s](https://github.com/o/r/blob/main/docs/upstream-sync.md) [x](https://e.com) [h](#top)",
  );
});

test("each entry becomes the issue template's sections, without the PRs field", () => {
  const { entries } = parseLedger(LEDGER);
  assert.deepEqual(entries.map((e) => e.slug), SLUGS);
  assert.deepEqual(entries.map((e) => e.status), ["active", "active", "active", "in-progress", "removed"]);

  const shape = defined(entries[0], "the shape entry");
  assert.deepEqual(shape.sections.map((s) => s.name), TEMPLATE_SECTIONS);
  const text = Object.fromEntries(shape.sections.map((s) => [s.name, s.text]));
  assert.equal(text.Intent, "A new planning kind, `shape`, beside `plan`. It interviews the human in rounds of decision forms before writing a plan.");
  assert.equal(
    text["Behavior contracts"],
    "- `shape` always asks at least one round, the recommended option first, plus a free-text Other.\n- Upstream's `plan` kind is unchanged.",
  );
  assert.equal(text["Fork-only files"], "`src/server/plans/shape.ts`, `skills/grill/`.");
  assert.equal(text["Plan docs"], `[shape-task-kind/plan.md](https://github.com/${DEFAULT_REPO}/blob/main/docs/plans/shape-task-kind/plan.md) sections 1 to 5`);
  assert.equal(text["Upstream candidate"], "Maybe. Self-contained.");
  assert.ok(!shape.sections.some((s) => /#83|Related, not claimed/.test(s.text)), "the PRs field is not copied");

  // A paragraph outside the template keeps its text, after the fixed sections.
  assert.deepEqual(defined(entries[3], "the CI entry").sections.map((s) => s.name), [...TEMPLATE_SECTIONS, "Sub-capabilities"]);
  // "Intent (as built)" is the Intent; sections a closed entry never had say so.
  const dependabot = Object.fromEntries(defined(entries[4], "the Dependabot entry").sections.map((s) => [s.name, s.text]));
  assert.equal(dependabot.Intent, "Automated dependency bumps for the fork.");
  assert.equal(dependabot["Behavior contracts"], "None recorded in the ledger.");
  assert.equal(dependabot["Why it was removed"], "It moved versions away from upstream, which made every sync fight the lockfile.");
});

test("the plan labels claimed PRs, Dependabot's under fork:dependabot, waits on pending branches, and lists the rest as notes", () => {
  const desired = desiredOf(LEDGER);
  assert.equal(desired.labels.length, 1 + SLUGS.length + 4 + 1);
  // #83 is claimed only in its entry's PRs field, #250 in words PROSE_CLAIMS maps; #21 is
  // related, not claimed.
  assert.deepEqual([...desired.prs.keys()], [1, 3, 35, 40, 41, 43, 83, 151, 161, 200, 215, 250]);
  assert.deepEqual(desired.prs.get(250), ["fork:per-task-base-branch", "fork-delta:applied"]);
  assert.deepEqual(desired.prs.get(83), ["fork:shape-tasks-grill-and-tickets", "fork-delta:applied"]);
  assert.deepEqual([...desired.pending], [["feat/task-source-workflow", ["fork:task-source-workflow-default", "fork-delta:applied"]]]);
  for (const n of [40, 41, 43]) assert.deepEqual(desired.prs.get(n), ["fork:dependabot", "fork-delta:applied"]);

  const issue = (slug: string) => defined(desired.issues.find((i) => i.slug === slug), slug);
  assert.deepEqual(issue("ci-time-to-green").labels, ["fork-feature", "fork:ci-time-to-green", "fork-status:in-progress"]);
  assert.equal(issue("ci-time-to-green").state, "open");
  assert.equal(issue("dependabot").state, "closed");
  assert.deepEqual(issue("dependabot").labels, ["fork-feature", "fork:dependabot", "fork-status:removed"]);
  assert.match(issue("dependabot").closingComment ?? "", /Ledger status: Removed 2026-09-29, sync PR #62\./);
  assert.equal(issue("shape-tasks-grill-and-tickets").closingComment, null);

  assert.ok(desired.notes.some((n) => n.includes('"Standalone fixes" has no entry') && n.includes("#4, #13")));
  assert.ok(desired.notes.some((n) => n.includes("fork:shape-tasks-grill-and-tickets: labeled from the entry's PRs field") && n.includes("#83")));
  assert.ok(!desired.notes.some((n) => n.includes("feat/task-source-workflow")), "a pending branch is planned, not skipped");
  assert.ok(!desired.notes.some((n) => n.includes("#21")), "a related, unclaimed PR is not reported");
});

test("an unchanged ledger plans zero writes against the GitHub it produced", () => {
  const desired = desiredOf(LEDGER);
  assert.deepEqual(planWrites(desired, migrated(desired)), { writes: [], warnings: [] });
});

test("a changed ledger rewrites only the differing section, and labels a PR newly added to the table", () => {
  const before = desiredOf(LEDGER);
  const after = desiredOf(
    LEDGER.replace("- The branch is checked on dispatch.", "- The branch is checked on dispatch and on reset.").replace(
      "| Per-task base branch | Active (storage, API) | #151 (plan M0.1), #161,",
      "| Per-task base branch | Active (storage, API) | #151 (plan M0.1), #161, #163,",
    ),
  );
  const actual = migrated(before);
  actual.prs.set(163, ["bug"]);
  const { writes } = planWrites(after, actual);
  assert.deepEqual(
    writes.map((w) => w.op),
    ["edit-issue", "label-pr"],
  );
  const edit = only(writes[0], "edit-issue");
  const label = only(writes[1], "label-pr");
  assert.equal(edit.number, 302);
  assert.equal(edit.title, null);
  assert.deepEqual(edit.sections, [
    { name: "Behavior contracts", current: "- The branch is checked on dispatch.", next: "- The branch is checked on dispatch and on reset." },
  ]);
  assert.deepEqual(label, { op: "label-pr", number: 163, addLabels: ["fork:per-task-base-branch", "fork-delta:applied"] });
});

test("status is reconciled, and the closing comment is posted only when its marker is missing", () => {
  const desired = desiredOf(LEDGER);
  const actual = migrated(desired);
  const ci = actual.issues.find((i) => i.labels.includes("fork:ci-time-to-green"))!;
  ci.labels = ["fork-feature", "fork:ci-time-to-green", "fork-status:removed"];
  ci.state = "CLOSED";
  const dependabot = actual.issues.find((i) => i.labels.includes("fork:dependabot"))!;
  dependabot.state = "OPEN";
  dependabot.comments = ["An unrelated comment."];

  const { writes } = planWrites(desired, actual);
  assert.deepEqual(
    writes.map((w) => [w.op, "number" in w ? w.number : null]),
    [
      ["edit-issue", ci.number],
      ["reopen-issue", ci.number],
      ["comment-issue", dependabot.number],
      ["close-issue", dependabot.number],
    ],
  );
  const edit = only(writes[0], "edit-issue");
  assert.deepEqual([edit.addLabels, edit.removeLabels], [["fork-status:in-progress"], ["fork-status:removed"]]);

  dependabot.comments.push(`Closed earlier.\n\n${CLOSING_MARKER}`);
  assert.ok(!planWrites(desired, actual).writes.some((w) => w.op === "comment-issue"));
});

test("a PR claimed in words is labeled only while its entry still says them", () => {
  assert.ok(desiredOf(LEDGER).notes.includes('fork:per-task-base-branch: #250 labeled for the entry\'s words "the session Diff view (issue #136)"'));
  const edited = desiredOf(LEDGER.replace("#151, #161, the session Diff view (issue #136)", "#151, #161"));
  assert.ok(!edited.prs.has(250));
  assert.ok(edited.notes.includes('"Per-task base branch" no longer says "the session Diff view (issue #136)", so #250 is not labeled for it'));
});

test("a pending branch labels the one PR merged from it into main, and is warned about otherwise", () => {
  const desired = desiredOf(LEDGER);
  const actual = migrated(desired);
  actual.prs.set(243, ["enhancement"]);
  const { writes, warnings } = planWrites(desired, actual);
  assert.deepEqual(writes, [{ op: "label-pr", number: 243, addLabels: ["fork:task-source-workflow-default", "fork-delta:applied"] }]);
  assert.deepEqual(warnings, []);

  actual.prs.set(243, ["enhancement", "fork:task-source-workflow-default", "fork-delta:applied"]);
  assert.deepEqual(planWrites(desired, actual), { writes: [], warnings: [] });

  for (const [numbers, found] of [
    [[], "no PR"],
    [[243, 250], "2 PRs (#243, #250)"],
  ] as const) {
    actual.merged.set("feat/task-source-workflow", [...numbers]);
    assert.deepEqual(planWrites(desired, actual), { writes: [], warnings: [`branch feat/task-source-workflow: ${found} merged into main; not labeled`] });
  }
});

test("a feature label on two issues stops the plan", () => {
  const desired = desiredOf(LEDGER);
  const actual = migrated(desired);
  actual.issues.push({ ...defined(actual.issues[0], "the first issue"), number: 999 });
  assert.throws(() => planWrites(desired, actual), /fork:shape-tasks-grill-and-tickets is on more than one issue: #300, #999/);
});

test("a renamed heading stops the plan instead of creating a second issue beside the orphaned one", () => {
  const before = desiredOf(LEDGER);
  const renamed = desiredOf(LEDGER.replaceAll("Task-source workflow default", "Source workflow default"));
  assert.throws(
    () => planWrites(renamed, migrated(before)),
    /no ledger entry derives #301 \(fork:task-source-workflow-default\); if a heading was renamed, relabel the issue/,
  );

  // Relabelled by hand, the rerun only reconciles the title and adds the new label to the
  // feature's merged PR.
  const actual = migrated(before);
  const issue = defined(actual.issues[1], "the task-source issue");
  issue.labels = ["fork-feature", "fork:source-workflow-default"];
  actual.labels.push("fork:source-workflow-default");
  const { writes } = planWrites(renamed, actual);
  assert.deepEqual(
    writes.map((w) => w.op),
    ["edit-issue", "label-pr"],
  );
  assert.deepEqual(only(writes[1], "label-pr").addLabels, ["fork:source-workflow-default"]);
  assert.equal(only(writes[0], "edit-issue").title, "Fork feature: Source workflow default");
});

test("a ledger entry with text outside its table and titled paragraphs is refused", () => {
  assert.throws(() => parseLedger(LEDGER.replace("**Intent.** Swept", "Stray line.\n\n**Intent.** Swept")), /Task-source workflow default: text outside/);
});

test("a malformed ledger is refused with a message naming what is wrong", () => {
  const cases: [string, string, string, RegExp][] = [
    ["unknown field", "| Upstream candidate | Maybe. Self-contained. |", "| Owner | me |\n| Upstream candidate | Maybe. Self-contained. |", /Shape tasks, grill and tickets: unknown field "Owner"/],
    ["missing PRs row", "| PRs | #200 (the plan), #215 |\n", "", /CI time-to-green: the field table has no PRs row/],
    ["unreadable status", "| Status | **Removed** 2026-09-29", "| Status | **Gone** 2026-09-29", /Dependabot: cannot read a status from "\*\*Gone\*\*/],
    ["repeated paragraph", "**Fork-only files.** None.", "**Intent.** Again.\n\n**Fork-only files.** None.", /Task-source workflow default: two "Intent" paragraphs/],
    ["duplicate slug", "### Task-source workflow default", "### Shape tasks: grill and tickets", /two entries derive the slug shape-tasks-grill-and-tickets/],
    ["no At a glance", "## At a glance", "## Overview", /the ledger has no "## At a glance" section/],
    ["two-cell glance row", "| Dependabot | Removed (2026-09-29, #62) | #35, #40, #41, #43 |", "| Dependabot | #35 |", /"At a glance" row does not have three cells: "\| Dependabot \| #35 \|"/],
  ];
  for (const [name, from, to, message] of cases) {
    assert.equal(LEDGER.split(from).length, 2, `${name}: the mutation matches the fixture once`);
    assert.throws(() => parseLedger(LEDGER.replace(from, to)), message, name);
  }
});

test("a table PR GitHub does not know is warned about and never labeled", () => {
  const desired = desiredOf(LEDGER);
  const actual = migrated(desired);
  actual.prs.delete(41);
  for (const labels of actual.prs.values()) labels.splice(0);
  const { writes, warnings } = planWrites(desired, actual);
  assert.deepEqual(warnings, ["#41 is not a pull request in this repository; not labeled"]);
  const labeled = writes.flatMap((w) => (w.op === "label-pr" ? [w.number] : []));
  assert.ok(!labeled.includes(41));
  assert.equal(labeled.length, desired.prs.size - 1 + desired.pending.size, "every other claimed PR is still labeled");
});

test("a title that differs from the ledger heading is the only thing rewritten", () => {
  const desired = desiredOf(LEDGER);
  const actual = migrated(desired);
  defined(actual.issues[0], "the shape issue").title = "Fork feature: Shape tasks";
  const { writes } = planWrites(desired, actual);
  assert.equal(writes.length, 1);
  const edit = only(writes[0], "edit-issue");
  assert.deepEqual(
    [edit.number, edit.title, edit.body, edit.sections, edit.addLabels, edit.removeLabels],
    [300, "Fork feature: Shape tasks, grill and tickets", null, [], [], []],
  );
});

test("an issue create that prints no URL stops the run before the writes that need its number", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return "";
  };
  const writes: Write[] = [
    { op: "create-issue", slug: "dependabot", title: "Fork feature: Dependabot", body: "x\n", labels: ["fork-feature"] },
    { op: "comment-issue", slug: "dependabot", number: null, body: "closing" },
    { op: "close-issue", slug: "dependabot", number: null },
  ];
  assert.throws(() => executeWrites(writes, run, () => {}), /gh issue create printed no issue URL: $/);
  assert.equal(calls.length, 1);
});

// The CLI, against a fake `gh` that keeps GitHub's state in a JSON file.

type FakeState = {
  labels: string[];
  issues: { number: number; title: string; state: string; labels: string[]; body: string; comments: string[] }[];
  prs: Record<string, string[]>;
  calls: string[][];
};

function fakeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "fork-migrate-"));
  const gh = join(dir, "gh");
  writeFileSync(gh, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_GH}" "$@"\n`, { mode: 0o755 });
  const statePath = join(dir, "state.json");
  const prs = Object.fromEntries([1, 3, 35, 40, 41, 43, 83, 151, 161, 163, 200, 215, 250].map((n) => [String(n), []]));
  writeFileSync(statePath, JSON.stringify({ labels: ["bug"], issues: [], prs, calls: [] }));
  const ledger = join(dir, "ledger.md");
  const state = () => JSON.parse(readFileSync(statePath, "utf8")) as FakeState;
  const run = (text: string, ...args: string[]) => {
    writeFileSync(ledger, text);
    const before = state().calls.length;
    const res = spawnSync(process.execPath, [SCRIPT, "--ledger", ledger, ...args], {
      encoding: "utf8",
      env: { ...process.env, MISSION_GH_BIN: gh, FAKE_GH_STATE: statePath },
    });
    assert.equal(res.status, 0, res.stderr);
    const calls = state().calls.slice(before);
    const writes = calls.filter((c) => !/^(label|issue|pr) list$/.test(`${c[0]} ${c[1]}`));
    return { stdout: res.stdout, calls, writes };
  };
  return { run, state };
}

test("--dry-run prints the plan and never calls gh", () => {
  const { run } = fakeRepo();
  const { stdout, calls } = run(LEDGER, "--dry-run");
  assert.deepEqual(calls, []);
  assert.match(stdout, /^Labels \(11\):$/m);
  assert.match(stdout, /^Tracking issues \(5\):$/m);
  assert.match(stdout, /^ {2}fork:dependabot {2}\[closed, fork-status:removed\] {2}Fork feature: Dependabot$/m);
  assert.match(stdout, /^ {2}#40 {2}fork:dependabot, fork-delta:applied$/m);
});

test("a real run migrates, a rerun writes nothing, and a changed ledger writes exactly the difference", () => {
  const { run, state } = fakeRepo();

  const first = run(LEDGER);
  assert.ok(first.calls.every((c) => c.at(-2) === "--repo" && c.at(-1) === DEFAULT_REPO), "every gh call names the fork");
  const after = state();
  assert.equal(after.labels.length, 1 + 11);
  assert.equal(after.issues.length, 5);
  const dependabot = after.issues.find((i) => i.labels.includes("fork:dependabot"))!;
  assert.equal(dependabot.state, "CLOSED");
  assert.equal(dependabot.comments.length, 1);
  assert.match(dependabot.body, /^### Why it was removed$/m);
  assert.deepEqual(after.prs["41"], ["fork:dependabot", "fork-delta:applied"]);
  assert.deepEqual(after.prs["163"], []);

  const rerun = run(LEDGER);
  assert.deepEqual(rerun.writes, []);
  assert.match(rerun.stdout, /0 writes: GitHub already matches the ledger\./);

  const changed = LEDGER.replace("Swept tasks take the source's workflow.", "Swept tasks take the source's own workflow.").replace(
    "#151 (plan M0.1), #161,",
    "#151 (plan M0.1), #161, #163,",
  );
  const third = run(changed);
  assert.deepEqual(
    third.writes.map((c) => c.slice(0, 3)),
    [
      ["issue", "edit", String(after.issues.find((i) => i.labels.includes("fork:task-source-workflow-default"))!.number)],
      ["pr", "edit", "163"],
    ],
  );
  assert.match(third.stdout, /section Intent, current:\n {4}- Swept tasks take the source's workflow\.\n {2}section Intent, from the ledger:\n {4}\+ Swept tasks take the source's own workflow\./);
  assert.deepEqual(run(changed).writes, []);
  assert.equal(state().issues.find((i) => i.labels.includes("fork:dependabot"))!.comments.length, 1, "the closing comment is posted once");
});
