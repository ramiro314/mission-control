/**
 * `scripts/ci-tree-reuse.sh`, run the way the `changes` job runs it: `bash -eo pipefail`, every
 * input through `env`, under the bash `test/helpers/script-bash.ts` picks for this platform.
 *
 * `git` and `gh` are stubs first on `PATH`, each logging its arguments. `gh` answers the three
 * calls the script makes (the commit's pull requests, the workflow's pull_request runs for a head,
 * and the run's `tested-tree` artifact) from stub env, so each case changes one answer and the
 * rest stay the green path. The artifact the green path downloads is the one `record` wrote,
 * which holds the two modes to the same file format.
 *
 * `jq` is the machine's own, never a stub. Every case that reaches it skips without it, saying
 * so, and a CI run without it fails instead (`jqSkip`).
 *
 * The one case that answers `true` is the happy path; every other condition and failure answers
 * `false`, exits 0, and says why.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jqSkip, runBashScript } from "./helpers/script-bash.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/ci-tree-reuse.sh", import.meta.url));
/** Both modes read and write their JSON with `jq`. */
const JQ = { skip: jqSkip() };

const dir = mkdtempSync(join(tmpdir(), "mission-ci-tree-reuse-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const log = join(dir, "calls");

writeFileSync(
  join(dir, "git"),
  `#!/bin/sh
printf 'git %s\\n' "$*" >> "$STUB_LOG"
[ "\${STUB_GIT_EXIT:-0}" = 0 ] || exit "$STUB_GIT_EXIT"
printf '%s\\n' "$STUB_GIT_TREE"
`,
);
writeFileSync(
  join(dir, "gh"),
  `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  "api repos/"*"/pulls")
    [ "\${STUB_PULLS_EXIT:-0}" = 0 ] || exit "$STUB_PULLS_EXIT"
    printf '%s' "$STUB_PULLS" ;;
  "api repos/"*"/runs?"*)
    [ "\${STUB_RUNS_EXIT:-0}" = 0 ] || exit "$STUB_RUNS_EXIT"
    printf '%s' "$STUB_RUNS" ;;
  "run download "*)
    [ -n "$STUB_ARTIFACT" ] || { echo "no valid artifacts found to download" >&2; exit 1; }
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --dir ]; then printf '%s' "$STUB_ARTIFACT" > "$2/tested-tree.json"; fi
      shift
    done ;;
  *) echo "unexpected gh call" >&2; exit 99 ;;
esac
`,
);
chmodSync(join(dir, "git"), 0o755);
chmodSync(join(dir, "gh"), 0o755);

/** Runs one mode with only the given env (plus `PATH`), never the test process's own. */
function run(args: string[], env: Record<string, string>) {
  rmSync(log, { force: true });
  const output = join(dir, "github-output");
  writeFileSync(output, "");
  const r = runBashScript(SCRIPT, args, dir, { STUB_LOG: log, GITHUB_OUTPUT: output, ...env });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : [];
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, output: readFileSync(output, "utf8"), calls };
}

const SHA = "a".repeat(40);
const HEAD = "b".repeat(40);
const TREE = "c".repeat(40);
const OTHER_TREE = "d".repeat(40);

/** `record`'s file, as the pull request run uploads it. */
function recorded(tree: string, docsOnly: string): string {
  const file = join(dir, `recorded-${tree.slice(0, 1)}-${docsOnly || "empty"}.json`);
  const r = run(["record", file], { STUB_GIT_TREE: tree, DOCS_ONLY: docsOnly });
  assert.equal(r.code, 0, r.stderr);
  return readFileSync(file, "utf8");
}

const pull = (number: number, merged: boolean, head = HEAD) => ({
  number,
  merged_at: merged ? "2026-10-05T12:00:00Z" : null,
  head: { sha: head },
});
const workflowRun = (id: number, createdAt: string, status: string, conclusion: string | null) => ({
  id,
  created_at: createdAt,
  status,
  conclusion,
});

/** The green path: one merged PR, its newest run green, a full-run artifact, the same tree. */
const GREEN: Record<string, string> = {
  EVENT_NAME: "push",
  REF: "refs/heads/main",
  SHA,
  REPO: "owner/repo",
  WORKFLOW: "ci.yml",
  STUB_GIT_TREE: TREE,
  STUB_PULLS: JSON.stringify([pull(7, true), pull(8, false, "e".repeat(40))]),
  // Newest first, as GitHub lists them, but the script orders by created_at itself.
  STUB_RUNS: JSON.stringify({
    workflow_runs: [
      workflowRun(41, "2026-10-05T10:00:00Z", "completed", "failure"),
      workflowRun(42, "2026-10-05T11:00:00Z", "completed", "success"),
    ],
  }),
};

function decide(over: Record<string, string> = {}) {
  return run(["decide"], { ...GREEN, STUB_ARTIFACT: recorded(TREE, "false"), ...over });
}

function assertDecision(r: ReturnType<typeof run>, value: "true" | "false") {
  assert.equal(r.code, 0, `exit 0, stderr: ${r.stderr}`);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.at(-1), `tree_reused=${value}`, r.stdout);
  assert.equal(r.output, `tree_reused=${value}\n`);
}

// ---- record ----------------------------------------------------------------------------------

test("record: writes the tested tree and the run's docs_only value", JQ, () => {
  const file = join(dir, "tested-tree.json");
  const r = run(["record", file], { STUB_GIT_TREE: TREE, DOCS_ONLY: "false" });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { tree: TREE, docs_only: "false" });
  assert.deepEqual(r.calls, ["git rev-parse HEAD^{tree}"]);
});

test("record: a git failure warns, writes nothing, and never fails the pull request run", () => {
  const file = join(dir, "never-written.json");
  const r = run(["record", file], { STUB_GIT_EXIT: "128", DOCS_ONLY: "false" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(file), false);
  assert.match(r.stdout, /::warning::tree reuse: git rev-parse HEAD\^\{tree\} failed/);
});

// ---- decide ----------------------------------------------------------------------------------

test("decide: the merged PR's newest green run tested this exact tree, so it is reused", JQ, () => {
  const r = decide();
  assertDecision(r, "true");
  assert.match(r.stdout, /Run 42 of #7 tested tree c{40}/);
  assert.deepEqual(r.calls, [
    `gh api repos/owner/repo/commits/${SHA}/pulls`,
    `gh api repos/owner/repo/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=100`,
    `gh run download 42 --repo owner/repo --name tested-tree --dir ${r.calls[2]!.split(" --dir ")[1]}`,
    `git rev-parse ${SHA}^{tree}`,
  ]);
});

test("decide: anything but a push to main never reuses, and never calls the API", JQ, () => {
  const cases: Array<[event: string, ref: string]> = [
    ["pull_request", "refs/pull/7/merge"],
    ["workflow_dispatch", "refs/heads/main"],
    ["push", "refs/tags/v1.2.3"],
    ["push", "refs/heads/release/windows"],
    ["", "refs/heads/main"],
  ];
  for (const [event, ref] of cases) {
    const r = decide({ EVENT_NAME: event, REF: ref });
    assertDecision(r, "false");
    assert.deepEqual(r.calls, [], `${event} ${ref}: nothing should be called`);
  }
});

const NO_RUNS = JSON.stringify({ workflow_runs: [] });
const RUNS_NEWEST = (status: string, conclusion: string | null) =>
  JSON.stringify({
    workflow_runs: [
      workflowRun(43, "2026-10-05T12:00:00Z", status, conclusion),
      workflowRun(42, "2026-10-05T11:00:00Z", "completed", "success"),
    ],
  });

const FALSE_CASES: Array<{ name: string; over: Record<string, string>; why: RegExp }> = [
  { name: "a missing pushed commit", over: { SHA: "" }, why: /Missing SHA, REPO or WORKFLOW/ },
  { name: "a malformed pushed commit", over: { SHA: "not-a-sha" }, why: /Missing SHA, REPO or WORKFLOW/ },
  { name: "a missing repository", over: { REPO: "" }, why: /Missing SHA, REPO or WORKFLOW/ },
  { name: "a missing workflow", over: { WORKFLOW: "" }, why: /Missing SHA, REPO or WORKFLOW/ },
  { name: "a failed pull request lookup", over: { STUB_PULLS_EXIT: "1" }, why: /Listing the pull requests of a{40} failed/ },
  { name: "an unreadable pull request list", over: { STUB_PULLS: "<html>" }, why: /pull requests of a{40} could not be read/ },
  {
    name: "a commit with no merged pull request",
    over: { STUB_PULLS: JSON.stringify([pull(8, false)]) },
    why: /maps to 0 merged pull requests, not exactly one/,
  },
  {
    name: "a commit with two merged pull requests",
    over: { STUB_PULLS: JSON.stringify([pull(7, true), pull(9, true, "f".repeat(40))]) },
    why: /maps to 2 merged pull requests, not exactly one/,
  },
  {
    name: "a merged pull request without a head commit",
    over: { STUB_PULLS: JSON.stringify([{ number: 7, merged_at: "2026-10-05T12:00:00Z", head: {} }]) },
    why: /#7 has no readable head commit/,
  },
  { name: "a failed run lookup", over: { STUB_RUNS_EXIT: "1" }, why: /Listing ci\.yml runs for #7's head b{40} failed/ },
  { name: "an unreadable run list", over: { STUB_RUNS: "{}" }, why: /runs for #7's head b{40} could not be read/ },
  { name: "no pull_request run for the head", over: { STUB_RUNS: NO_RUNS }, why: /No pull_request run of ci\.yml for #7's head/ },
  {
    name: "a newer failed run after a green one",
    over: { STUB_RUNS: RUNS_NEWEST("completed", "failure") },
    why: /newest run for #7's head, 43, is completed\/failure/,
  },
  {
    name: "a newer run still in progress",
    over: { STUB_RUNS: RUNS_NEWEST("in_progress", null) },
    why: /newest run for #7's head, 43, is in_progress\/null/,
  },
  {
    name: "a newer cancelled run",
    over: { STUB_RUNS: RUNS_NEWEST("completed", "cancelled") },
    why: /43, is completed\/cancelled/,
  },
  { name: "a run without a tested-tree artifact", over: { STUB_ARTIFACT: "" }, why: /Run 42 has no tested-tree artifact/ },
  { name: "an unreadable artifact", over: { STUB_ARTIFACT: "tree" }, why: /Run 42's tested-tree artifact could not be read/ },
  {
    name: "an artifact missing its fields",
    over: { STUB_ARTIFACT: JSON.stringify({ tree: TREE }) },
    why: /Run 42's tested-tree artifact could not be read/,
  },
  {
    name: "a docs-only pull request run, which skipped the suite",
    over: { STUB_ARTIFACT: "DOCS_ONLY_TRUE" },
    why: /Run 42 recorded docs_only=true; only a full run can stand in/,
  },
  {
    name: "a run that recorded no docs_only value",
    over: { STUB_ARTIFACT: "DOCS_ONLY_EMPTY" },
    why: /Run 42 recorded docs_only=unset/,
  },
  {
    name: "a different tree, because main moved before the merge",
    over: { STUB_ARTIFACT: "OTHER_TREE" },
    why: /Run 42 tested tree d{40}, but a{40} has tree c{40}/,
  },
];

const ARTIFACTS: Record<string, () => string> = {
  DOCS_ONLY_TRUE: () => recorded(TREE, "true"),
  DOCS_ONLY_EMPTY: () => recorded(TREE, ""),
  OTHER_TREE: () => recorded(OTHER_TREE, "false"),
};

for (const c of FALSE_CASES) {
  test(`decide: runs everything, and says why, for ${c.name}`, JQ, () => {
    const artifact = c.over.STUB_ARTIFACT;
    const over = artifact && ARTIFACTS[artifact] ? { ...c.over, STUB_ARTIFACT: ARTIFACTS[artifact]() } : c.over;
    const r = decide(over);
    assertDecision(r, "false");
    assert.match(r.stdout, c.why);
    assert.match(r.stdout, /run everything\.\ntree_reused=false\n$/);
  });
}

test("decide: a failing git rev-parse of the pushed tree runs everything", JQ, () => {
  const r = decide({ STUB_GIT_EXIT: "128" });
  assertDecision(r, "false");
  assert.match(r.stdout, /git rev-parse a{40}\^\{tree\} failed/);
});

test("an unknown mode is a usage error, not a decision", () => {
  const r = run(["reuse"], GREEN);
  assert.equal(r.code, 2);
  assert.equal(r.output, "");
  assert.match(r.stderr, /usage: ci-tree-reuse\.sh record <file> \| decide/);
});
