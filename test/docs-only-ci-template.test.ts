/**
 * Mission Control's own `ci.yml` runs the `docs-only-ci` skill's two step scripts, pasted
 * verbatim as `run: |` block scalars. This holds the two copies byte for byte, so editing one
 * without the other fails `npm test`, and holds the wiring around them: the `changes` and
 * `CI result` jobs, the docs-only and tree-reuse condition on every gated job, and the Node 26
 * jobs that stay off pull requests and so out of `CI result`. `test/ci-tree-reuse.test.ts` holds
 * the tree-reuse script itself.
 *
 * The repository has no YAML parser, so the workflow is read as text, the way
 * `test/oss-readiness.test.ts` reads it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function repoFile(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

const WORKFLOW = repoFile(".github/workflows/ci.yml");
const DETECT = repoFile("skills/docs-only-ci/assets/detect-docs-only.sh");
const CI_RESULT = repoFile("skills/docs-only-ci/assets/ci-result.sh");

const GATED = ["gates", "unit-node-24", "build-smoke-node-24", "e2e"];
/** Docs-only, beside tree reuse on a push to `main`; nothing else in ci.yml may read either. */
const GATED_IF = "if: needs.changes.outputs.docs_only != 'true' && needs.changes.outputs.tree_reused != 'true'";
/** Never run on a pull request, so `CI result` cannot need them, as it cannot need `package`. */
const OFF_PULL_REQUESTS = ["dependencies-node-26", "build-smoke-node-26", "unit-node-26"];
const OFF_PULL_REQUESTS_IF = "if: github.event_name != 'pull_request'";

/** Each top-level job's id and its body, the lines up to the next job id. */
function jobs(workflow: string): Map<string, string> {
  const lines = workflow.split("\n");
  const start = lines.indexOf("jobs:");
  assert.notEqual(start, -1, "ci.yml has a top-level jobs: key");
  const out = new Map<string, string>();
  let id: string | null = null;
  let body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const next = line.match(/^ {2}([\w-]+):\s*$/)?.[1];
    if (next || /^\S/.test(line)) {
      if (id) out.set(id, body.join("\n"));
      id = next ?? null;
      body = [];
      if (!next) break;
    } else {
      body.push(line);
    }
  }
  if (id) out.set(id, body.join("\n"));
  return out;
}

/**
 * The value of the `run: |` block scalar in the step named `step`, as YAML reads it with clip
 * chomping: dedented by the first content line's indent, trailing blank lines dropped, one
 * final newline.
 */
function runBlock(workflow: string, step: string): string {
  const lines = workflow.split("\n");
  const named = lines.findIndex((line) => line.trim() === `- name: ${step}`);
  assert.notEqual(named, -1, `ci.yml has a step named ${step}`);
  const stepIndent = lines[named]!.indexOf("-");
  let run = -1;
  for (let i = named + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() && line.search(/\S/) <= stepIndent) break;
    if (line.trim() === "run: |") {
      run = i;
      break;
    }
  }
  assert.notEqual(run, -1, `step ${step} has a run: | block`);
  const runIndent = lines[run]!.search(/\S/);
  const first = lines.slice(run + 1).find((line) => line.trim());
  assert.ok(first, `step ${step}'s run block has content`);
  const indent = first.search(/\S/);
  assert.ok(indent > runIndent, `step ${step}'s run block is indented under run:`);
  const block: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.search(/\S/) < indent) break;
    block.push(line.slice(indent));
  }
  while (block.length && !block.at(-1)!.trim()) block.pop();
  return `${block.join("\n")}\n`;
}

/** The block scalar under `key:` inside `body`, one entry per non-empty line. */
function blockLines(body: string, key: string): string[] {
  const lines = body.split("\n");
  const at = lines.findIndex((line) => line.trim() === `${key}: |`);
  assert.notEqual(at, -1, `${key} is a block scalar`);
  const keyIndent = lines[at]!.search(/\S/);
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim()) continue;
    if (line.search(/\S/) <= keyIndent) break;
    out.push(line.trim());
  }
  return out;
}

/** `needs:` as a flow list (`[a, b]`), a block list, or a single id. */
function needs(body: string): string[] {
  const inline = body.match(/^ {4}needs:[ \t]*(\S.*?)[ \t]*$/m)?.[1];
  if (inline) return inline.replace(/^\[|\]$/g, "").split(",").map((id) => id.trim());
  const block = body.match(/^ {4}needs:[ \t]*\n((?: {6}- .+\n?)+)/m)?.[1] ?? "";
  return [...block.matchAll(/^ {6}- (.+?)\s*$/gm)].map(([, id]) => id!);
}

test("the Detect docs-only change step body is the skill's detect asset, byte for byte", () => {
  assert.equal(runBlock(WORKFLOW, "Detect docs-only change"), DETECT);
});

test("the CI result step body is the skill's summary asset, byte for byte", () => {
  assert.equal(runBlock(WORKFLOW, "CI result"), CI_RESULT);
});

test("one changed byte in either ci.yml step body breaks the match", () => {
  const cases: [step: string, asset: string, last: string][] = [
    ["Detect docs-only change", DETECT, 'decide true "Every changed path matches the docs patterns."'],
    ["CI result", CI_RESULT, 'echo "CI result: passed (docs_only=${DOCS_ONLY:-unset})."'],
  ];
  for (const [step, asset, last] of cases) {
    const line = WORKFLOW.split("\n").find((l) => l.trim() === last);
    assert.ok(line, `${step}'s last line is in ci.yml`);
    const edited = WORKFLOW.replace(line, `${line} `);
    assert.notEqual(edited, WORKFLOW);
    assert.notEqual(runBlock(edited, step), asset);
  }
});

test("changes runs on every event with full history and matches docs/ only", () => {
  const body = jobs(WORKFLOW).get("changes");
  assert.ok(body, "ci.yml has a changes job");
  assert.match(body, /^ {4}runs-on: ubuntu-latest$/m);
  assert.doesNotMatch(body, /^ {4}if:/m, "changes runs on every event");
  assert.match(body, /^ {10}fetch-depth: 0$/m);
  assert.match(body, /^ {6}docs_only: \$\{\{ steps\.detect\.outputs\.docs_only \}\}$/m);
  assert.deepEqual(blockLines(body, "DOCS_ONLY_PATHS"), ["docs/*"]);
});

test("changes records the tested tree on pull requests and decides tree reuse with read-only API access", () => {
  const body = jobs(WORKFLOW).get("changes");
  assert.ok(body, "ci.yml has a changes job");
  assert.match(body, /^ {4}permissions:\n {6}contents: read\n {6}actions: read\n {6}pull-requests: read\n {4}outputs:/m);
  assert.match(body, /^ {6}tree_reused: \$\{\{ steps\.reuse\.outputs\.tree_reused \}\}$/m);
  const steps = body.split(/^ {6}- name: /m).slice(1);
  const step = (name: string) => {
    const found = steps.find((s) => s.startsWith(`${name}\n`));
    assert.ok(found, `changes has a ${name} step`);
    return found;
  };
  assert.deepEqual(
    steps.map((s) => s.split("\n")[0]),
    ["Checkout", "Detect docs-only change", "Record tested tree", "Upload tested tree", "Detect reused tree"],
  );
  const record = step("Record tested tree");
  assert.match(record, /^ {8}if: github\.event_name == 'pull_request'$/m);
  assert.match(record, /^ {10}DOCS_ONLY: \$\{\{ steps\.detect\.outputs\.docs_only \}\}$/m);
  assert.match(record, /^ {8}run: bash scripts\/ci-tree-reuse\.sh record "\$RUNNER_TEMP\/tested-tree\.json"$/m);
  const upload = step("Upload tested tree");
  assert.match(upload, /^ {8}if: github\.event_name == 'pull_request'$/m);
  assert.match(upload, /^ {8}continue-on-error: true$/m, "a failed upload never fails changes");
  assert.match(upload, /^ {10}name: tested-tree$/m);
  assert.match(upload, /^ {10}path: \$\{\{ runner\.temp \}\}\/tested-tree\.json$/m);
  assert.match(upload, /^ {10}retention-days: 7$/m);
  const reuse = step("Detect reused tree");
  assert.doesNotMatch(reuse, /^ {8}if:/m, "the reuse step decides every event itself");
  assert.match(reuse, /^ {8}id: reuse$/m);
  assert.match(reuse, /^ {10}WORKFLOW: ci\.yml$/m);
  assert.match(reuse, /^ {10}GH_TOKEN: \$\{\{ github\.token \}\}$/m);
  assert.match(reuse, /^ {8}run: bash scripts\/ci-tree-reuse\.sh decide$/m);
  for (const [id, other] of jobs(WORKFLOW)) {
    if (id === "changes") continue;
    assert.doesNotMatch(other, /actions: read|pull-requests: read/, `${id} has no tree-reuse permissions`);
  }
});

test("CI result lets the gated jobs skip on a docs-only run or a reused tree", () => {
  const body = jobs(WORKFLOW).get("ci-result");
  assert.ok(body, "ci.yml has a ci-result job");
  assert.match(
    body,
    /^ {10}DOCS_ONLY: \$\{\{ \(needs\.changes\.outputs\.docs_only == 'true' \|\| needs\.changes\.outputs\.tree_reused == 'true'\) && 'true' \|\| 'false' \}\}$/m,
  );
});

test("every gated job needs changes and skips on a docs-only or tree-reused run", () => {
  const all = jobs(WORKFLOW);
  for (const id of GATED) {
    const body = all.get(id);
    assert.ok(body, `ci.yml has a ${id} job`);
    assert.ok(needs(body).includes("changes"), `${id} needs changes`);
    assert.ok(body.split("\n").includes(`    ${GATED_IF}`), `${id} carries the docs-only and tree-reuse condition`);
  }
  for (const [id, body] of all) {
    if (GATED.includes(id)) continue;
    assert.ok(!body.includes("docs_only != 'true'"), `${id} is not gated`);
    if (id === "changes" || id === "ci-result") continue;
    assert.ok(!body.includes("tree_reused"), `${id} does not skip on tree reuse`);
  }
});

test("the Node 26 jobs skip only on a pull request and need nothing that can skip", () => {
  const all = jobs(WORKFLOW);
  for (const id of OFF_PULL_REQUESTS) {
    const body = all.get(id);
    assert.ok(body, `ci.yml has a ${id} job`);
    assert.deepEqual(body.match(/^ {4}if:.*$/gm), [`    ${OFF_PULL_REQUESTS_IF}`], `${id}'s only condition is the event`);
    assert.ok(needs(body).every((need) => OFF_PULL_REQUESTS.includes(need)), `${id} needs only Node 26 jobs`);
  }
});

test("CI result always runs, needs every pull-request job, and lets only the gated jobs skip", () => {
  const all = jobs(WORKFLOW);
  const body = all.get("ci-result");
  assert.ok(body, "ci.yml has a ci-result job");
  assert.match(body, /^ {4}name: CI result$/m);
  assert.match(body, /^ {4}runs-on: ubuntu-latest$/m);
  assert.match(body, /^ {4}if: always\(\)$/m);
  assert.deepEqual(
    needs(body).toSorted(),
    [...all.keys()]
      .filter((id) => id !== "ci-result" && id !== "package" && !OFF_PULL_REQUESTS.includes(id))
      .toSorted(),
  );
  assert.deepEqual(blockLines(body, "SKIPPABLE"), GATED);
});
