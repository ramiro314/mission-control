/**
 * The `docs-only-ci` skill's two step scripts, run the way GitHub Actions runs a `run:` step:
 * `bash -eo pipefail <file>`, every input through `env`, under the bash `test/helpers/script-bash.ts`
 * picks for this platform.
 *
 * `git` is a stub first on `PATH`. It answers like real git: with `--no-renames` a move from
 * `src/` into `docs/` lists both paths, and without it only the new `docs/` path. Dropping the
 * flag from the script therefore turns the rename case `true` and fails it.
 *
 * `ci-result.sh` reads its input with the machine's own `jq`. Its cases skip without it, saying
 * so, and a CI run without it fails instead (`jqSkip`). One case swaps in a `jq` stub that
 * answers in CRLF lines, as `jq` on Windows does, so every platform holds the script to them.
 *
 * The last case feeds `decideWaitForCi` the check list a docs-only run produces.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ciCheckRunsFromRollup, decideWaitForCi, initialWaitForCiState } from "../src/shared/wait-for-ci.ts";
import { FLAKY_TESTS_CHECK_NAME, parseFlakeSummary, renderFlakeSummary } from "../src/shared/flake-report.ts";
import { jqSkip, runBashScript } from "./helpers/script-bash.ts";

const ASSETS = fileURLToPath(new URL("../skills/docs-only-ci/assets/", import.meta.url));
const DETECT = join(ASSETS, "detect-docs-only.sh");
const CI_RESULT = join(ASSETS, "ci-result.sh");
/** `ci-result.sh` reads `NEEDS_JSON` with `jq`. */
const JQ = { skip: jqSkip() };

const dir = mkdtempSync(join(tmpdir(), "mission-docs-only-ci-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const argsFile = join(dir, "git-args");
writeFileSync(
  join(dir, "git"),
  `#!/bin/sh
printf '%s\\n' "$@" > "$STUB_GIT_ARGS"
case " $* " in
  *" --no-renames "*) printf '%s' "$STUB_GIT_NO_RENAMES" ;;
  *) printf '%s' "$STUB_GIT_RENAMES" ;;
esac
exit "\${STUB_GIT_EXIT:-0}"
`,
);
chmodSync(join(dir, "git"), 0o755);

/** Runs one asset with only the given env (plus `PATH`), never the test process's own. */
function run(script: string, env: Record<string, string>) {
  rmSync(argsFile, { force: true });
  const output = join(dir, "github-output");
  writeFileSync(output, "");
  const r = runBashScript(script, [], dir, { STUB_GIT_ARGS: argsFile, GITHUB_OUTPUT: output, ...env });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, output: readFileSync(output, "utf8") };
}

const PR = { EVENT_NAME: "pull_request", BASE_SHA: "b".repeat(40), HEAD_SHA: "c".repeat(40) };

function detect(over: Record<string, string>, changed?: string) {
  const files = changed ?? "";
  return run(DETECT, {
    ...PR,
    DOCS_ONLY_PATHS: "docs/*",
    STUB_GIT_NO_RENAMES: files,
    STUB_GIT_RENAMES: files,
    ...over,
  });
}

function assertDecision(r: ReturnType<typeof run>, value: "true" | "false") {
  assert.equal(r.code, 0, `exit 0, stderr: ${r.stderr}`);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.at(-1), `docs_only=${value}`, r.stdout);
  assert.equal(r.output, `docs_only=${value}\n`);
}

// ---- detect-docs-only.sh -----------------------------------------------------------------

test("detect: a push, tag or dispatch is never docs-only, and never asks git", () => {
  for (const event of ["push", "workflow_dispatch", "pull_request_target", ""]) {
    const r = detect({ EVENT_NAME: event }, "docs/a.md\n");
    assertDecision(r, "false");
    assert.equal(existsSync(argsFile), false, `${event}: git should not run`);
  }
});

test("detect: a failing diff runs everything and still exits 0", () => {
  const r = detect({ STUB_GIT_EXIT: "128" }, "docs/a.md\n");
  assertDecision(r, "false");
  assert.match(r.stdout, /git diff .* failed/);
});

test("detect: zero changed files, a missing commit, or no patterns run everything", () => {
  assertDecision(detect({}, ""), "false");
  assertDecision(detect({ BASE_SHA: "" }, "docs/a.md\n"), "false");
  assertDecision(detect({ DOCS_ONLY_PATHS: " \n\n" }, "docs/a.md\n"), "false");
});

test("detect: one non-docs path among docs paths is not docs-only, and is named", () => {
  const r = detect({}, "docs/a.md\nsrc/server/db.ts\ndocs/b.md\npackage.json\n");
  assertDecision(r, "false");
  assert.match(r.stdout, /Not a docs path: src\/server\/db\.ts\n/);
});

test("detect: a file moved from src/ into docs/ is not docs-only, because the diff skips rename detection", () => {
  const r = detect({ STUB_GIT_NO_RENAMES: "src/moved.ts\ndocs/moved.ts\n", STUB_GIT_RENAMES: "docs/moved.ts\n" });
  assertDecision(r, "false");
  assert.match(r.stdout, /Not a docs path: src\/moved\.ts/);
  assert.deepEqual(readFileSync(argsFile, "utf8").trimEnd().split("\n"), [
    "diff",
    "--no-renames",
    "--name-only",
    `${PR.BASE_SHA}...${PR.HEAD_SHA}`,
  ]);
});

test("detect: every path under docs/, at any depth, is docs-only", () => {
  assertDecision(detect({}, "docs/a.md\ndocs/plans/x/plan.html\ndocs/images/deep/y.png\n"), "true");
});

test("detect: a nested Markdown file matches a `*.md` pattern, and patterns may be indented", () => {
  assertDecision(detect({ DOCS_ONLY_PATHS: "  docs/*\n  *.md\n" }, "README.md\npackages/web/guide/intro.md\n"), "true");
  assertDecision(detect({ DOCS_ONLY_PATHS: "docs/*\n*.md\n" }, "packages/web/intro.mdx\n"), "false");
});

// ---- ci-result.sh ------------------------------------------------------------------------

const SKIPPABLE = "gates\nunit-node-24\nunit-node-26\ne2e\n";
const ALL = ["changes", "dependencies-node-24", "docs-checks", "gates", "unit-node-24", "unit-node-26", "e2e", "flake-report"];

function needs(results: Record<string, string>): string {
  const all: Record<string, { result: string; outputs: Record<string, string> }> = {};
  for (const job of ALL) all[job] = { result: results[job] ?? "success", outputs: {} };
  return JSON.stringify(all);
}

const DOCS_ONLY_SKIPS = { gates: "skipped", "unit-node-24": "skipped", "unit-node-26": "skipped", e2e: "skipped" };

function ciResult(results: Record<string, string>, docsOnly: string) {
  return run(CI_RESULT, { NEEDS_JSON: needs(results), DOCS_ONLY: docsOnly, SKIPPABLE });
}

test("ci-result: passes when every need succeeded", JQ, () => {
  const r = ciResult({}, "false");
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /CI result: passed/);
});

test("ci-result: passes when only SKIPPABLE jobs were skipped on a docs-only run", JQ, () => {
  const r = ciResult(DOCS_ONLY_SKIPS, "true");
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /^gates: skipped \(docs-only change\)$/m);
});

const FAILS: Array<{ name: string; results: Record<string, string>; docsOnly: string; offending: string[] }> = [
  { name: "a SKIPPABLE job skipped on a full run", results: { gates: "skipped" }, docsOnly: "false", offending: ["gates: skipped"] },
  {
    name: "skips with DOCS_ONLY empty because changes failed",
    results: { changes: "failure", ...DOCS_ONLY_SKIPS },
    docsOnly: "",
    offending: ["changes: failure", "gates: skipped", "unit-node-24: skipped", "unit-node-26: skipped", "e2e: skipped"],
  },
  { name: "a failed need", results: { "unit-node-26": "failure" }, docsOnly: "false", offending: ["unit-node-26: failure"] },
  { name: "a cancelled need", results: { e2e: "cancelled" }, docsOnly: "false", offending: ["e2e: cancelled"] },
  {
    name: "a failure on a docs-only run",
    results: { ...DOCS_ONLY_SKIPS, "docs-checks": "failure" },
    docsOnly: "true",
    offending: ["docs-checks: failure"],
  },
  {
    name: "docs-checks and flake-report skipped on a docs-only run",
    results: { ...DOCS_ONLY_SKIPS, "docs-checks": "skipped", "flake-report": "skipped" },
    docsOnly: "true",
    offending: ["docs-checks: skipped", "flake-report: skipped"],
  },
  { name: "changes cancelled", results: { changes: "cancelled" }, docsOnly: "false", offending: ["changes: cancelled"] },
];

for (const c of FAILS) {
  test(`ci-result: fails, naming each offending job, for ${c.name}`, JQ, () => {
    const r = ciResult(c.results, c.docsOnly);
    assert.equal(r.code, 1, r.stdout);
    const errors = r.stdout.split("\n").filter((l) => l.startsWith("::error::")).map((l) => l.slice(9));
    assert.deepEqual(errors.sort(), [...c.offending].sort());
    assert.match(r.stdout, /CI result: failed/);
  });
}

test("ci-result: an unreadable or empty NEEDS_JSON fails", JQ, () => {
  for (const json of ["", "not json", "{}"]) {
    const r = run(CI_RESULT, { NEEDS_JSON: json, DOCS_ONLY: "true", SKIPPABLE });
    assert.equal(r.code, 1, `${JSON.stringify(json)}: ${r.stdout}`);
    assert.match(r.stdout, /::error::CI result: NEEDS_JSON/);
  }
});

/** A `jq` stub first on `PATH` that answers `STUB_JQ_OUT`, whatever it is asked. */
const crlfJq = join(dir, "crlf-jq");
mkdirSync(crlfJq);
writeFileSync(join(crlfJq, "jq"), `#!/bin/sh\ncat > /dev/null\nprintf '%s' "$STUB_JQ_OUT"\n`);
chmodSync(join(crlfJq, "jq"), 0o755);

test("ci-result: reads jq's CRLF lines, as jq on Windows writes them, the way it reads LF", () => {
  const crlf = (results: Record<string, string>) => ALL.map((job) => `${job} ${results[job] ?? "success"}\r\n`).join("");
  const pass = runBashScript(CI_RESULT, [], crlfJq, { STUB_JQ_OUT: crlf(DOCS_ONLY_SKIPS), DOCS_ONLY: "true", SKIPPABLE });
  assert.equal(pass.status, 0, pass.stdout);
  assert.match(pass.stdout, /^gates: skipped \(docs-only change\)$/m);
  assert.match(pass.stdout, /^flake-report: success$/m);

  const fail = runBashScript(CI_RESULT, [], crlfJq, { STUB_JQ_OUT: crlf({ e2e: "cancelled" }), DOCS_ONLY: "false", SKIPPABLE });
  assert.equal(fail.status, 1, fail.stdout);
  assert.deepEqual(fail.stdout.split("\n").filter((l) => l.startsWith("::error::")), ["::error::e2e: cancelled"]);
});

// ---- Wait for CI ---------------------------------------------------------------------------

test("a docs-only run's checks pass Wait for CI, because flake report still publishes Flaky tests", () => {
  const HEAD = "d".repeat(40);
  const done = (name: string, conclusion: string, extra: Record<string, string> = {}) =>
    ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion, ...extra });
  // What `flake report` publishes after reading zero reports.
  const zero = renderFlakeSummary({
    version: 1,
    commit: HEAD,
    ref: "docs-branch",
    pullRequest: 9,
    runUrl: "https://github.com/owner/repo/actions/runs/1",
    flakes: [],
    failures: [],
    errors: [],
    issues: [],
  });
  const { checkRuns, flakeReport } = ciCheckRunsFromRollup([
    done("changes", "SUCCESS"),
    done("dependencies (node 24)", "SUCCESS"),
    done("dependencies (node 26)", "SUCCESS"),
    done("docs checks", "SUCCESS"),
    done("gates (typecheck, lint)", "SKIPPED"),
    done("unit (node 24, shard 1/6)", "SKIPPED"),
    done("unit (node 26, shard 1/6)", "SKIPPED"),
    done("e2e (shard 1/15)", "SKIPPED"),
    done("flake report", "SUCCESS"),
    done(FLAKY_TESTS_CHECK_NAME, "SUCCESS", { title: "No flaky tests", summary: zero }),
    done("CI result", "SUCCESS"),
    done("package (macOS arm64)", "SKIPPED"),
  ], parseFlakeSummary);
  const state = initialWaitForCiState({
    pullRequestKey: "owner/repo#9",
    pullRequestUrl: "https://github.com/owner/repo/pull/9",
    pullRequestNumber: 9,
    expectedHeadOid: HEAD,
    timeoutMinutes: 45,
    now: 0,
  });
  const decision = decideWaitForCi(state, { headSha: HEAD, observedAt: 1, checkRuns, flakeReport }, 1);
  assert.equal(decision.kind, "pass");
  assert.equal(decision.state.flakeReport?.flakes.length, 0);
});
