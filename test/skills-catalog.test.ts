import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { frontmatterBlock, parseFrontmatter, parseSkill, readCatalog } from "../src/server/skills/catalog.ts";
import { openPullRequestCommand } from "../src/shared/pr-command.mjs";

// The catalog reader. Its frontmatter parser is deliberately narrow - the files are
// authored in this repo and reviewed with it - so what matters is that anything it
// can't read is REPORTED rather than guessed at.

function skillMd(body: string): string {
  return `---\n${body}\n---\n\n# Heading\n\nsome prose\n`;
}

const GOOD = skillMd(
  `name: html-plans
description: Renders a plan as a page.
metadata:
  mission:
    category: planning
    enforcement: triggered`,
);

test("parses a well-formed skill", () => {
  const r = parseSkill("html-plans", GOOD);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.skill, {
    id: "html-plans",
    name: "html-plans",
    description: "Renders a plan as a page.",
    category: "planning",
    enforcement: "triggered",
  });
});

test("the directory name and the frontmatter name are independent", () => {
  // This is the whole reason our directory prefix costs nothing legible: the harness owns
  // the directory namespace in ~/.claude/skills, and the user still sees /html-plans.
  const r = parseSkill("html-plans", GOOD);
  assert.equal(r.ok && r.skill.id, "html-plans");
  assert.equal(r.ok && r.skill.name, "html-plans");
});

test("a description with a colon in it survives", () => {
  const r = parseSkill("x", skillMd(
    `name: x
description: Use when: the user asks for a page.
metadata:
  mission:
    category: c
    enforcement: triggered`,
  ));
  assert.equal(r.ok && r.skill.description, "Use when: the user asks for a page.");
});

test("a quoted scalar is unquoted", () => {
  const r = parseSkill("x", skillMd(
    `name: "x"
description: 'quoted'
metadata:
  mission:
    category: c
    enforcement: always-on`,
  ));
  assert.equal(r.ok && r.skill.name, "x");
  assert.equal(r.ok && r.skill.description, "quoted");
  assert.equal(r.ok && r.skill.enforcement, "always-on");
});

test("a missing enforcement is an error, never a default", () => {
  // Defaulting would be the worst failure this file has: the rung is what tells the
  // operator a skill is only a suggestion, so inventing one for a skill we failed to
  // read is the panel stating a guarantee nobody made.
  const r = parseSkill("x", skillMd(
    `name: x
description: d
metadata:
  mission:
    category: c`,
  ));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problem : "", /enforcement/);
});

test("an unknown enforcement rung is refused", () => {
  const r = parseSkill("x", skillMd(
    `name: x
description: d
metadata:
  mission:
    category: c
    enforcement: mandatory`,
  ));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problem : "", /unknown enforcement 'mandatory'/);
});

test("a missing name is an error - it must not default to the prefixed directory", () => {
  // Claude defaults `name` to the DIRECTORY name when it's omitted, which is exactly
  // what the prefix would poison: the user would be told to type /mission-html-plans.
  const r = parseSkill("html-plans", skillMd(`description: d\nmetadata:\n  mission:\n    category: c\n    enforcement: triggered`));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problem : "", /no 'name'/);
});

test("a name the native skill loaders reject is an error", () => {
  for (const name of ["Pull Request", "-pull-request", "pull--request", "pull-request-", "a".repeat(65)]) {
    const r = parseSkill("pull-request", skillMd(
      `name: ${name}
description: d
metadata:
  mission:
    category: c
    enforcement: triggered`,
    ));
    assert.equal(r.ok, false, `${name} should be refused`);
    assert.match(!r.ok ? r.problem : "", /invalid 'name'/);
  }
});

test("a missing description is an error - it's what decides if the model ever reaches for it", () => {
  const r = parseSkill("x", skillMd(`name: x\nmetadata:\n  mission:\n    category: c\n    enforcement: triggered`));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problem : "", /no 'description'/);
});

test("disable-model-invocation is refused - it would load but never fire", () => {
  // It takes the skill out of the "N available" count and out of the model's reach
  // entirely, so its row's toggle would do nothing an operator could ever observe.
  const r = parseSkill("x", skillMd(
    `name: x
description: d
disable-model-invocation: true
metadata:
  mission:
    category: c
    enforcement: triggered`,
  ));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problem : "", /never fire/);
});

test("a multi-line YAML scalar is REPORTED, not read as the literal '>-'", () => {
  // `>-` and `|` are valid YAML that Claude itself reads fine; it's this deliberately
  // narrow reader that can't. Taking the marker as the value would ship a row whose
  // description is the string ">-" - nothing looks broken, and the skill is inert,
  // because the description is what decides whether the model ever reaches for it.
  for (const marker of [">-", ">", "|", "|-"]) {
    const r = parseSkill("x", skillMd(
      `name: x
description: ${marker}
  a long description
  wrapped over lines
metadata:
  mission:
    category: c
    enforcement: triggered`,
    ));
    assert.equal(r.ok, false, `${marker} should be refused`);
    assert.match(!r.ok ? r.problem : "", /multi-line YAML scalar/);
  }
});

test("a description that merely STARTS with a > is still a description", () => {
  const r = parseSkill("x", skillMd(
    `name: x
description: "> use this when rendering"
metadata:
  mission:
    category: c
    enforcement: triggered`,
  ));
  assert.equal(r.ok && r.skill.description, "> use this when rendering");
});

test("readCatalog reports an unreadable catalog as UNREADABLE, not as empty", () => {
  // The distinction the reconciler's whole safety rests on: an empty catalog means
  // "every skill was deleted, unlink them all", and a read failure must never say that.
  const prev = process.env.FLEET_SKILLS_DIR;
  process.env.FLEET_SKILLS_DIR = "/nonexistent/skills/dir";
  try {
    const c = readCatalog();
    assert.equal(c.readable, false);
    assert.deepEqual(c.skills, []);
    assert.equal(c.present.size, 0);
    assert.match(c.problems[0] ?? "", /couldn't read the skills catalog/);
  } finally {
    if (prev === undefined) delete process.env.FLEET_SKILLS_DIR;
    else process.env.FLEET_SKILLS_DIR = prev;
  }
});

test("the real catalog is readable, and every directory in it is present", () => {
  const c = readCatalog();
  assert.equal(c.readable, true);
  // `present` is what the reconciler keys on, so a parsed skill missing from it would
  // be unlinked from every session.
  for (const s of c.skills) assert.ok(c.present.has(s.id), `${s.id} should be present`);
});

test("a file with no frontmatter is an error", () => {
  const r = parseSkill("x", "# Just a heading\n");
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problem : "", /no --- frontmatter/);
});

test("a --- in the BODY is a horizontal rule, not a fence", () => {
  // The opening fence has to be the file's first line, or a skill whose prose uses a
  // rule would parse its own paragraphs as frontmatter.
  assert.equal(frontmatterBlock("# Title\n\n---\n\nprose\n"), null);
});

test("frontmatter is read only from the top of the file", () => {
  const block = frontmatterBlock(GOOD);
  assert.match(block ?? "", /name: html-plans/);
  assert.doesNotMatch(block ?? "", /some prose/);
});

test("comments and blank lines are ignored", () => {
  const fm = parseFrontmatter("# a comment\n\nname: x\n\n# another\ndescription: d\n");
  assert.equal(fm.get("name"), "x");
  assert.equal(fm.get("description"), "d");
});

test("nesting is scoped by indent - a sibling key doesn't fall into the block above", () => {
  const fm = parseFrontmatter("metadata:\n  mission:\n    category: c\nname: x\n");
  assert.equal(fm.get("name"), "x", "name is top-level, not inside metadata.mission");
  const meta = fm.get("metadata");
  assert.equal(meta instanceof Map, true);
});

// ---- what actually ships ----

test("every skill in the repo's catalog parses", () => {
  // The catalog is baked into the repo precisely so it's reviewable with the app. A
  // SKILL.md that doesn't parse is a row that silently vanishes from the panel.
  const catalog = readCatalog();
  assert.deepEqual(catalog.problems, []);
  assert.ok(catalog.skills.length > 0, "the catalog should not be empty");
});

test("the shipped html-plans skill is a real, loadable Claude skill", () => {
  const skill = readCatalog().skills.find((s) => s.id === "html-plans");
  assert.ok(skill, "html-plans should be in the catalog");
  assert.equal(skill.name, "html-plans");
  assert.equal(skill.enforcement, "triggered");
  // The description is what Claude preloads and what decides whether it ever reaches
  // for the skill, so an empty or stub one would make the toggle meaningless.
  assert.ok(skill.description.length > 40);
  // And it has a body: a skill whose file is only frontmatter teaches nothing.
  const text = readFileSync(new URL("../skills/html-plans/SKILL.md", import.meta.url), "utf8");
  assert.ok(text.split("---")[2]!.trim().length > 200);
  assert.match(text, /implementation-follow-up/);
  assert.match(text, /Create phased implementation plan/);
  assert.match(text, /Invoke the `phased-plan` skill/);
});

test("the shipped html-report skill names the path contract the Files tab actually honors", () => {
  const skill = readCatalog().skills.find((s) => s.id === "html-report");
  assert.ok(skill, "html-report should be in the catalog");
  assert.equal(skill.name, "html-report");
  assert.equal(skill.enforcement, "triggered");
  // The description is the whole trigger for a model-invoked skill, so it has to carry
  // the words a human uses to ask for one of these.
  assert.ok(skill.description.length > 40);
  assert.match(skill.description, /investigat/i);
  assert.match(skill.description, /scout/i);

  const text = readFileSync(new URL("../skills/html-report/SKILL.md", import.meta.url), "utf8");
  assert.ok(text.split("---")[2]!.trim().length > 200);
  // Three claims the dashboard makes true and a rewrite must not quietly drop. The path
  // shape is what `matchCheckoutPaths` links and `pathDefaultsToPreview` opens rendered;
  // the no-JavaScript rule is the preview's CSP, which allows two hashed bridges and
  // nothing else; and an href inside the report resolves against the report's directory
  // (`workspaceAssetPath`), not the checkout root.
  assert.match(text, /docs\/reports\/<slug>\/report\.html/);
  assert.match(text, /\*\*No JavaScript\.\*\*/);
  assert.match(text, /\.\.\/\.\.\/\.\.\/src\/server\/registry\.ts/);
  // And it must not teach a link form the resolver refuses.
  assert.doesNotMatch(text, /Report: \/|Report: file:/);
});

test("the shipped phased-plan skill audits compatibility and schedules direct task dependencies", () => {
  const skill = readCatalog().skills.find((s) => s.id === "phased-plan");
  assert.ok(skill, "phased-plan should be in the catalog");
  assert.equal(skill.name, "phased-plan");
  assert.equal(skill.category, "planning");
  assert.equal(skill.enforcement, "triggered");
  assert.match(skill.description, /existing.*plan/i);

  const text = readFileSync(new URL("../skills/phased-plan/SKILL.md", import.meta.url), "utf8");
  assert.match(text, /Re-read the source plan/);
  assert.match(text, /Edit any earlier phase/);
  assert.match(text, /create_task/);
  assert.match(text, /dependsOnTaskIds/);
  assert.match(text, /dependsOnCurrentSession` to `true` on every call/);
  assert.match(text, /Do not flatten\s+the graph into a serial chain/);
  assert.match(text, /repository` and `additionalRepositories/);
  assert.match(text, /B as `repository`/);
  assert.match(text, /context-only/);
  assert.match(text, /canonical repository set returned by `create_task`/);
  assert.match(text, /Report the unscheduled phase/);
  assert.match(text, /Never fall back to the source repository, drop an attachment/);
  assert.doesNotMatch(text, /You cannot schedule it here/);
  assert.doesNotMatch(text, /must be dispatched from the dashboard/);

  // Small work stays one-shot even when it crosses layers. Larger work is split only when the
  // effort, complexity, and execution order make another merge unit safer for a mid-tier model.
  assert.match(text, /200 or fewer non-test implementation lines/);
  assert.match(text, /exactly one phase and\s+schedule exactly one one-shot implementation task/);
  assert.match(text, /An application-layer boundary is not by itself a phase boundary/);
  assert.match(text, /mid-tier model/);
  assert.match(text, /sizing estimate and phase-count rationale/);

  // The task text is the agent's prompt and is judged as the human's requirement, so the skill must
  // keep it at goal altitude and point at the phase file instead of pasting it in.
  assert.match(text, /Keep the task text at goal altitude/);
  assert.match(text, /proposed route, not a specification/);
  assert.doesNotMatch(text, /embed the complete phase Markdown/);
  assert.doesNotMatch(text, /Authoritative phase\s+instructions/);

  // Concision is only safe if the referenced files are published first. The skill has to close that
  // chain itself, not assume it.
  assert.match(text, /committed and pushed on this session's branch/);
  assert.match(text, /If you cannot commit and push the artifacts, do not create the tasks/);
  assert.match(text, /get_plan_publication_context/);
  assert.match(text, /owner: "workflow"/);
  assert.match(text, /report that planning is complete and end the turn/);
  assert.match(text, /Do not treat an unknown binding as absent/);

  // No owner lets the planning session open its own pull request: an unbound plan defers to
  // Foreman's wrap-up exactly as a bound one defers to its workflow, and a phase task commits
  // and lets Mission Control publish it.
  assert.match(text, /never opens the planning pull request on its own initiative/);
  assert.match(text, /Foreman's Ship it\? card or Straight to PR path opens the planning pull request/);
  assert.doesNotMatch(text, /Direct publication when no workflow is bound/);
  assert.doesNotMatch(text, /open a\s+reviewable pull request/);
  assert.doesNotMatch(text, /open the reviewable docs-site pull request/);
  assert.match(text, /commit the phase; Mission\s+Control publishes it as a reviewable pull request/);

  const mcp = readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
  // The ownership read the skill calls offers no direct PR path: either owner yields to a
  // Mission Control publisher. The owner values themselves are unchanged on the wire.
  const publicationStart = mcp.indexOf('"get_plan_publication_context"');
  const publicationEnd = mcp.indexOf("inputSchema", publicationStart);
  assert.ok(publicationStart >= 0 && publicationEnd > publicationStart, "get_plan_publication_context should be registered");
  const publication = mcp.slice(publicationStart, publicationEnd);
  assert.doesNotMatch(publication, /direct PR path/);
  assert.match(publication, /Foreman's Ship it\? or Straight to PR path opens it/);
  assert.match(publication, /never authorizes opening a pull request/);

  const start = mcp.indexOf('"create_task"');
  const end = mcp.indexOf("// This is the replacement", start);
  assert.ok(start >= 0 && end > start, "create_task should be registered before request_input");
  const tool = mcp.slice(start, end);
  assert.match(tool, /dependsOnCurrentSession/);
  assert.match(tool, /repository:/);
  assert.match(tool, /additionalRepositories:/);
  assert.match(tool, /MAX_TASK_EXTRA_REPOS/);
  assert.match(tool, /explicitRepositories \? "\/mcp\/v2\/tasks" : "\/mcp\/tasks"/);
  assert.match(tool, /isUnknownRoute\(res\)/);
  assert.doesNotMatch(tool, /isUnknownRoute\(res\)[\s\S]*http\("\/mcp\/tasks"/, "selectors never retry legacy");
  assert.doesNotMatch(tool, /\n\s*agent:/, "omission preserves the dispatch default agent");
  assert.doesNotMatch(tool, /\n\s*effort:/, "omission preserves the harness default effort");
});

// The published task's own `intent` is verified end to end in `phased-plan-task-intent.test.ts`,
// which pushes the skill's worked example through the create_task route and checks the stored value.

test("the shipped pull-request skill is a real, triggered Mission Control skill", () => {
  const skill = readCatalog().skills.find((s) => s.id === "pull-request");
  assert.ok(skill, "pull-request should be in the catalog");
  assert.equal(skill.name, "pull-request");
  assert.equal(skill.category, "shipping");
  assert.equal(skill.enforcement, "triggered");
  assert.match(skill.description, /opening.*pull request/i);

  const text = readFileSync(new URL("../skills/pull-request/SKILL.md", import.meta.url), "utf8");

  // The skill opens a pull request only under a grant, and names all four holders, so a task
  // text that merely mentions a PR never reads as permission to open one.
  assert.match(text, /\n## Precondition: a pull-request grant\n/);
  assert.match(text, /workflow Pull Request\s+action/);
  assert.match(text, /"Ask the session to open a PR" handoff/);
  assert.match(text, /Foreman pull-request instruction/);
  assert.match(text, /human-typed message in\s+this session that asks for one/);
  assert.match(text, /mentioning a pull\s+request is not a grant/);

  // The description is split by audience, and each section is a literal heading rather than a
  // described convention, so the order is part of the contract: the approver's section first,
  // the implementation detail second. Asserted in sequence so dropping one is a failure even
  // though every heading below would still be found somewhere in the file.
  let at = -1;
  for (const heading of [
    "## For Humans",
    "### Why",
    "### What changed",
    "### Tradeoffs",
    "### Known gaps",
    "### Evidence",
    "### Follow-up work",
    "## For Agents",
  ]) {
    const found = text.indexOf(`\n${heading}\n`, at + 1);
    assert.ok(found > at, `the PR description contract needs '${heading}', in this order`);
    at = found;
  }

  // What each side of the split owes a reader. Human prose stays short and scannable. The agent
  // section links existing design sources instead of duplicating them, omits a test inventory,
  // and preserves deliberate failure-mode context.
  assert.match(text, /screenshots/i);
  assert.match(text, /durable/i);
  assert.match(text, /pull request description/i);
  assert.match(text, /pull request comment/i);
  assert.match(text, /never committed/i);
  assert.match(text, /gitignored/i);
  assert.match(text, /2\.100\.0/);
  // The pull request is opened through REST, by the exact command Mission Control adopts from.
  assert.ok(text.includes(openPullRequestCommand("main")), "the skill gives the REST open command");
  assert.doesNotMatch(text, /gh pr create --/);
  for (const command of ["gh pr edit", "gh pr comment"]) {
    assert.match(text, new RegExp(command));
  }
  assert.match(text, /--attach/);
  assert.match(text, /signed-in web interface/i);
  assert.match(text, /render.*attachments/is);
  assert.match(text, /secrets.*credentials.*personal data/is);
  assert.match(text, /cannot be safely redacted.*unavailable/is);
  assert.match(text, /Concision is a requirement/i);
  assert.match(text, /use bullets wherever possible/i);
  assert.match(text, /Remove filler/i);
  assert.match(text, /plan document exists.*link directly/is);
  assert.match(text, /link directly to any\s+technical documentation/i);
  assert.match(text, /Do not repeat design decisions or implementation detail/i);
  assert.match(text, /Do not list tests added or modified/i);
  assert.match(text, /Always list the failure modes and edge cases/i);
});

test("the shipped deflake skill reproduces first, limits timeouts, and proves the fix", () => {
  const skill = readCatalog().skills.find((s) => s.id === "deflake");
  assert.ok(skill, "deflake should be in the catalog");
  assert.equal(skill.name, "deflake");
  assert.equal(skill.enforcement, "triggered");
  assert.match(skill.description, /flaky/i);
  assert.match(skill.description, /Flaky test:/);

  const text = readFileSync(new URL("../skills/deflake/SKILL.md", import.meta.url), "utf8");
  // It reads the issue through Phase 3's v1 markers, spelled exactly as the action writes them.
  assert.match(text, /<!-- mission-flake:v1 key=<key> -->/);
  assert.match(text, /<!-- mission-flake-occurrence:v1 at=<ISO time> -->/);
  // Reproduce before changing anything, under load, with a measured rate.
  assert.match(text, /\*\*reproduce first\.\*\*/);
  assert.match(text, /Before changing anything, make the test fail/);
  assert.match(text, /Starve the CPU/);
  // A timeout is loosened only when the limit is wrong, and the PR says why.
  assert.match(text, /\*\*Loosen a timeout only when the limit itself is wrong\*\*/);
  // Same command, same load, before and after.
  assert.match(text, /\*\*same\*\* command under the \*\*same\*\* load/);
  assert.match(text, /before: .*\n.*after: /);
  // Merging the fix closes the issue.
  assert.match(text, /`Fixes #<issue>`/);
  // The agent commits and reports; the workflow or Foreman opens the pull request, and the
  // closing keyword reaches its description through the commit message and the report.
  assert.match(text, /## 5\. Commit the fix and report/);
  assert.match(text, /Do not push or open a pull request yourself/);
  assert.match(text, /`Fixes #<issue>`, in both the commit message and the completion report/);
  assert.doesNotMatch(text, /Open the fix pull request/);
});

test("the shipped testing-setup skill audits, asks once, applies only what was approved, and verifies twice", () => {
  const skill = readCatalog().skills.find((s) => s.id === "testing-setup");
  assert.ok(skill, "testing-setup should be in the catalog");
  assert.equal(skill.name, "testing-setup");
  assert.equal(skill.category, "testing");
  assert.equal(skill.enforcement, "triggered");
  assert.match(skill.description, /Set up flake-aware testing/);

  const text = readFileSync(new URL("../skills/testing-setup/SKILL.md", import.meta.url), "utf8");
  // The audit list, each item named.
  for (const item of [
    /\*\*Test runner and JUnit XML\.\*\*/,
    /\*\*Rerun command template\.\*\*[\s\S]*`\{files\}`[\s\S]*`\{junit\}`/,
    /\*\*The report action in CI\.\*\*[\s\S]*version against this skill's asset/,
    /\*\*Permissions\.\*\*[\s\S]*`checks: write` and\s+`issues: write`/,
    /\*\*The check on the PR head commit\.\*\*/,
    /\*\*`\.mission\/testing\.json`\.\*\*/,
    /\*\*The `\.gitignore` entry\*\* for `\.mission\/testing\.local\.json`/,
    /\*\*Test-file patterns\.\*\*/,
    /\*\*A proposed smoke set\.\*\*[\s\S]*reason for each/,
  ]) assert.match(text, item);
  // One approval form, never prose or several forms.
  assert.match(text, /## 2\. Propose, in one form/);
  assert.match(text, /\*\*`request_plan_decisions`\*\* once, with every proposed change/);
  assert.match(text, /never split the proposal across several forms/);
  assert.match(text, /`smoke-set`: `multiSelect: true`/);
  assert.match(text, /`builtin-workflow:no-mistakes-review-affected-tests`/);
  // Apply only what was approved, with the one scoped tool.
  assert.match(text, /\*\*apply only what was approved\.\*\*/);
  assert.match(text, /## 3\. Apply only what was approved/);
  assert.match(text, /\*\*`set_affected_tests_command`\*\* with the exact approved argv/);
  assert.match(text, /`assets\/mission-flake-report\/`/);
  // Both verification steps.
  assert.match(text, /\*\*One local `affected-tests` run\.\*\*/);
  assert.match(text, /\*\*The "Flaky tests" check on the setup pull request's own CI\.\*\*/);
  assert.match(text, /`ci_flake_report_missing`/);
  // The agent commits; the workflow or Foreman opens the setup pull request.
  assert.match(text, /\*\*Commit all of it\*\* on the task branch\. Do not push or open a pull request yourself/);
  assert.doesNotMatch(text, /Open one pull request/);
  assert.doesNotMatch(skill.description, /apply only what the human approved \(a pull request/);
  // A later run offers only the action update.
  assert.match(text, /propose the update as the \*\*only\*\* change/);
  // The laptop settings, by name.
  assert.match(text, /`checkTestLease`/);
  assert.match(text, /`checkTestConcurrency`/);
});

test("the shipped retro skill's own-task path commits and leaves publishing to Mission Control", () => {
  const text = readFileSync(new URL("../skills/retro/SKILL.md", import.meta.url), "utf8");
  assert.match(text, /\*\*Dispatched as its own task\*\*[\s\S]*Do not push or open a pull request yourself/);
  assert.doesNotMatch(text, /open or update this task's own pull request/);
});

test("the testing-setup skill ships the generated report action it copies", () => {
  const asset = new URL("../skills/testing-setup/assets/mission-flake-report/", import.meta.url);
  assert.match(readFileSync(new URL("index.mjs", asset), "utf8"), /^\/\/ mission-flake-report \d+\.\d+\.\d+\n/);
  assert.match(readFileSync(new URL("action.yml", asset), "utf8"), /^# mission-flake-report \d+\.\d+\.\d+\n/);
});

test("the shipped docs-only-ci skill audits, asks once, applies only what was approved, and never edits protection", () => {
  const skill = readCatalog().skills.find((s) => s.id === "docs-only-ci");
  assert.ok(skill, "docs-only-ci should be in the catalog");
  assert.equal(skill.name, "docs-only-ci");
  assert.equal(skill.category, "testing");
  assert.equal(skill.enforcement, "triggered");
  assert.match(skill.description, /docs-only/);

  const text = readFileSync(new URL("../skills/docs-only-ci/SKILL.md", import.meta.url), "utf8");
  // Read-only audit, with the two early stops.
  assert.match(text, /## 1\. Audit\n\nRead the repository; change nothing yet\./);
  assert.match(text, /\*\*CI system\.\*\* Only GitHub Actions is supported\.[\s\S]*"not\s+supported": no form, no commit/);
  assert.match(text, /\*\*Already installed\.\*\*[\s\S]*report that the gate is\s+installed and stop: no form, no commit/);
  // flake-report keeps running, and the form proposes the status function it needs.
  assert.match(text, /\*\*The testing-setup `flake-report` job\.\*\*[\s\S]*\*\*never gated\*\*/);
  assert.match(text, /`!cancelled\(\)` or `always\(\)`[\s\S]*propose\s+`if: \$\{\{ !cancelled\(\) \}\}`/);
  assert.match(text, /Never offer\s+`flake-report`/);
  // A job its own `if:` can skip on an ordinary pull request would turn CI result red on a full
  // run, so it stays out of CI result's needs and SKIPPABLE, and the form says so.
  assert.match(text, /\*\*Jobs with their own skip condition\.\*\*[\s\S]*\*\*out of `CI result`'s `needs` and out of `SKIPPABLE`\*\*/);
  assert.match(text, /needs: \[changes, <every other job that runs on every pull request>\]/);
  assert.match(text, /every job left out\s+of `CI result`'s `needs` and why/);
  // One approval form, then only what was approved, in one commit.
  assert.match(text, /\*\*`request_plan_decisions`\*\* once, with every proposed change/);
  assert.match(text, /never split the proposal across several forms/);
  assert.match(text, /\*\*apply only what was approved\.\*\*/);
  assert.match(text, /\*\*Commit all of it\*\* on the task branch, in one commit\. Do not push or open a pull request\s+yourself/);
  // The assets, pasted verbatim.
  assert.match(text, /`assets\/detect-docs-only\.sh`/);
  assert.match(text, /`assets\/ci-result\.sh`/);
  // Required checks are reported, never edited.
  assert.match(text, /## 4\. Report required checks\n\nYou never edit branch protection or rulesets\./);
  assert.match(text, /could not read branch protection", never "no required checks"/);
  // Verified on the setup pull request's own CI.
  assert.match(text, /## 5\. Verify[\s\S]*`CI result` passed/);
});
