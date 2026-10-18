import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { WORKFLOW_LIMITS, type WorkflowCommandView } from "../src/shared/workflow.ts";
import type { UpdateWorkflowCommand } from "../src/shared/protocol.ts";
import { CommandDocumentSchema } from "../src/shared/command-document.ts";
import type { Task } from "../src/shared/types.ts";
import {
  repositoryOverrides,
  setAffectedTestsCommand,
  storedTestingSetupIntent,
  testingSetupIntent,
  testingSetupModeLine,
} from "../src/server/testing-setup.ts";
import {
  SET_AFFECTED_TESTS_COMMAND_TOOL,
  TESTING_SETUP_STORED_LABEL,
  TESTING_SETUP_TASK_LABEL,
} from "../src/server/testing-setup-tool.ts";
import { PROPOSE_COMMAND_DOCUMENT_TOOL } from "../src/server/command-document-proposals.ts";
import { PLAN_DECISIONS_TOOL } from "../src/server/plans/tools.ts";
import type { WorkflowCommandMutation } from "../src/server/workflows/commands.ts";

// The branches of `setAffectedTestsCommand` a real store cannot be driven into on demand: an
// already-set command, a concurrent edit landing between read and write (once, then twice), and
// a full override list. A scripted manager records every read and write so each case can say
// exactly what was written, and against which revision.

const REPO = "/repos/app";
const TEMPLATE = ["npx", "vitest", "run", "--outputFile={junit}", "{files}"];
const task = { repoRoot: REPO, labels: [TESTING_SETUP_TASK_LABEL] } as unknown as Task;

function view(revision: number, overrides: WorkflowCommandView["overrides"]): WorkflowCommandView {
  return {
    slot: "affected-tests",
    defaultCommand: null,
    overrides,
    maxRuns: 1,
    revision,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** A manager whose `get` answers come from `views` in turn and whose `replace` answers from `writes`. */
function scripted(views: WorkflowCommandView[], writes: Array<"ok" | "revision_conflict">) {
  const reads: number[] = [];
  const written: UpdateWorkflowCommand[] = [];
  return {
    reads,
    written,
    manager: {
      get: () => {
        const next = views[Math.min(reads.length, views.length - 1)]!;
        reads.push(next.revision);
        return next;
      },
      replace: (_slot: string, input: UpdateWorkflowCommand): WorkflowCommandMutation => {
        written.push(input);
        const outcome = writes[written.length - 1] ?? "ok";
        if (outcome === "ok") {
          return { ok: true, view: view(input.expectedRevision + 1, input.overrides) } as WorkflowCommandMutation;
        }
        return { ok: false, reason: "revision_conflict", current: null } as unknown as WorkflowCommandMutation;
      },
    },
  };
}

test("setting the command a repository already has is a replay: replayed true, nothing written", () => {
  const f = scripted([view(4, [{ repoRoot: REPO, command: [...TEMPLATE] }])], []);
  const result = setAffectedTestsCommand({ task, command: [...TEMPLATE] }, f.manager);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.replayed, true);
  assert.equal(result.ok && result.view.revision, 4);
  assert.deepEqual(f.written, [], "a replay makes no write");

  // A different argv for the same repository is not a replay.
  const changed = scripted([view(4, [{ repoRoot: REPO, command: [...TEMPLATE] }])], ["ok"]);
  const next = [...TEMPLATE, "--bail"];
  const updated = setAffectedTestsCommand({ task, command: next }, changed.manager);
  assert.equal(updated.ok && updated.replayed, false);
  assert.deepEqual(changed.written.map((w) => w.overrides), [[{ repoRoot: REPO, command: next }]]);
});

test("a revision conflict re-reads the slot and retries once against the new revision", () => {
  const other = { repoRoot: "/repos/other", command: ["other", "{files}", "{junit}"] };
  // The second read sees an override another writer added in between; the retry must keep it.
  const f = scripted([view(1, []), view(2, [other])], ["revision_conflict", "ok"]);
  const result = setAffectedTestsCommand({ task, command: [...TEMPLATE] }, f.manager);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.replayed, false);
  assert.deepEqual(f.reads, [1, 2], "the retry re-reads the view");
  assert.deepEqual(f.written.map((w) => w.expectedRevision), [1, 2]);
  assert.deepEqual(f.written[1]!.overrides, [other, { repoRoot: REPO, command: TEMPLATE }]);
});

test("two conflicts in a row give up with a 409 instead of writing a third time", () => {
  const f = scripted([view(1, []), view(2, []), view(3, [])], ["revision_conflict", "revision_conflict"]);
  const result = setAffectedTestsCommand({ task, command: [...TEMPLATE] }, f.manager);
  assert.deepEqual(result, {
    ok: false,
    status: 409,
    error: "The affected-tests Command changed twice while it was being set. Try again.",
    code: "workflow_command_revision_conflict",
  });
  assert.equal(f.written.length, 2);
});

test("a full override list refuses a new repository with a 409, but still lets one already listed update", () => {
  const full = Array.from({ length: WORKFLOW_LIMITS.commandOverrides }, (_, i) => ({
    repoRoot: `/repos/r${i}`,
    command: ["t", "{files}", "{junit}"],
  }));
  const f = scripted([view(7, full)], []);
  const result = setAffectedTestsCommand({ task, command: [...TEMPLATE] }, f.manager);
  assert.deepEqual(result, {
    ok: false,
    status: 409,
    error: "The affected-tests Command has no room for another repository.",
  });
  assert.deepEqual(f.written, []);

  // Replacing an entry that is already counted does not need a new slot.
  const listed = { ...task, repoRoot: "/repos/r0" } as Task;
  const g = scripted([view(7, full)], ["ok"]);
  const updated = setAffectedTestsCommand({ task: listed, command: [...TEMPLATE] }, g.manager);
  assert.equal(updated.ok, true);
  assert.equal(g.written[0]!.overrides.length, WORKFLOW_LIMITS.commandOverrides);
});

// The committed-or-stored choice reaches the agent twice: in the launch prompt, and in the skill
// the prompt invokes. The skill branches on the exact line the prompt writes, so these cases pin
// both halves to `testingSetupModeLine` rather than to two spellings that could drift apart.

const SKILL = readFileSync(new URL("../skills/testing-setup/SKILL.md", import.meta.url), "utf8");

/** The skill's text from one `## ` heading to the next. */
function skillSection(heading: string): string {
  const start = SKILL.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `the skill has a "${heading}" section`);
  const end = SKILL.indexOf("\n## ", start + 1);
  return SKILL.slice(start, end < 0 ? undefined : end);
}

test("the committed prompt names its mode and keeps today's form, tool and template wording", () => {
  const intent = testingSetupIntent(REPO, null);
  assert.ok(intent.includes(testingSetupModeLine("committed")));
  assert.match(intent, /\.mission\/testing\.json/);
  assert.match(intent, /Invoke the testing-setup skill and follow it: it owns the audit, the single/);
  assert.match(intent, new RegExp(`approval form \\(${PLAN_DECISIONS_TOOL}\\)`));
  assert.match(intent, new RegExp(`only with ${SET_AFFECTED_TESTS_COMMAND_TOOL},\\nand only with the exact template`));
  assert.doesNotMatch(intent, new RegExp(PROPOSE_COMMAND_DOCUMENT_TOOL));
  assert.match(testingSetupIntent(REPO, TEMPLATE), /currently: npx vitest run --outputFile=\{junit\} \{files\}/);
});

test("the stored prompt names its mode, forbids a commit and the direct Command write, and lists every folder's Command", () => {
  const intent = storedTestingSetupIntent(REPO, [
    { path: "", command: ["npm", "test", "{files}", "{junit}"] },
    { path: "apps/web", command: TEMPLATE },
  ]);
  assert.ok(intent.includes(testingSetupModeLine("stored")));
  assert.match(intent, /change no file in this repository and make no commit/);
  assert.match(intent, /follow its stored mode/);
  assert.match(intent, new RegExp(`only with ${PROPOSE_COMMAND_DOCUMENT_TOOL}, as one Command document`));
  assert.match(intent, /Library › Commands/);
  assert.match(intent, new RegExp(`Do not call ${SET_AFFECTED_TESTS_COMMAND_TOOL}\\.`));
  assert.doesNotMatch(intent, new RegExp(PLAN_DECISIONS_TOOL));
  assert.match(intent, /- \(repository root\): npm test \{files\} \{junit\}\n- apps\/web: npx vitest/);
  assert.match(storedTestingSetupIntent(REPO, []), /no affected-tests Command for this repository or any folder in it yet/);
});

test("a stored-mode setup cannot set the Command directly: refused with 403 before the catalog is read", () => {
  const stored = { repoRoot: REPO, labels: [TESTING_SETUP_TASK_LABEL, TESTING_SETUP_STORED_LABEL] } as unknown as Task;
  const s = scripted([view(1, [])], ["ok"]);
  const refused = setAffectedTestsCommand({ task: stored, command: [...TEMPLATE] }, s.manager);
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.status === 403);
  assert.match(!refused.ok ? refused.error : "", new RegExp(`propose its affected-tests Commands with ${PROPOSE_COMMAND_DOCUMENT_TOOL}`));
  assert.deepEqual(s.reads, []);
  assert.deepEqual(s.written, []);
});

test("repositoryOverrides keeps the root and its folders, repository-relative and in path order", () => {
  assert.deepEqual(
    repositoryOverrides(REPO, [
      { repoRoot: `${REPO}/apps/web`, command: ["b"] },
      { repoRoot: "/repos/application", command: ["prefix-only"] },
      { repoRoot: `${REPO}-two/apps/web`, command: ["sibling"] },
      { repoRoot: REPO, command: ["root"] },
      { repoRoot: `${REPO}/apps/admin`, command: ["a"] },
    ]),
    [
      { path: "", command: ["root"] },
      { path: "apps/admin", command: ["a"] },
      { path: "apps/web", command: ["b"] },
    ],
  );
});

test("the skill routes each mode by the prompt's own line, and keeps the committed path unchanged", () => {
  const choose = skillSection("Choose the mode");
  assert.ok(choose.includes(`**\`${testingSetupModeLine("committed")}\`**`));
  assert.ok(choose.includes(`**\`${testingSetupModeLine("stored")}\`**`));
  assert.match(choose, /Follow sections 1 to 4 below/);
  assert.match(choose, /Follow \[Stored mode\]\(#stored-mode\) instead of sections 2 to\s+4/);
  assert.match(choose, /Never switch modes on your own/);

  // Committed: still writes the testing file and sets the Command through its one tool.
  const apply = skillSection("3. Apply only what was approved");
  assert.match(apply, /\*\*Write `\.mission\/testing\.json`\*\*/);
  assert.match(apply, /\*\*`set_affected_tests_command`\*\* with the exact approved argv/);
});

test("the skill's stored mode changes no file, proposes one document, and never writes a Command itself", () => {
  const stored = skillSection("Stored mode");
  assert.match(stored, /\*\*change no file in the repository and make no commit\.\*\*/);
  assert.match(stored, /You do not ask in a decision form/);
  assert.doesNotMatch(stored, /request_plan_decisions/);
  assert.match(stored, /Submit everything with \*\*`propose_command_document`\*\*, as one version 1 document/);
  assert.match(stored, /Use only the `affected-tests` slot under `commands`/);
  assert.match(stored, /Never\s+`flakes`/);
  assert.match(stored, /Never call\s+`set_affected_tests_command` in this mode/);
  assert.match(stored, /a newer proposal replaces the pending one/);
  assert.match(stored, /Run each proposed `affected-tests` argv once, in its folder/);
  assert.match(stored, /There is no pull request and no "Flaky tests" check in this mode/);

  // The document example is a valid version 1 document whose templates pass the slot's rule, so
  // an agent copying its shape is not refused on the first try.
  const example = /```json\n([\s\S]*?)\n```/.exec(stored);
  assert.ok(example, "the stored section shows a document");
  const parsed = CommandDocumentSchema.safeParse(JSON.parse(example[1]!));
  assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
  assert.deepEqual(Object.keys(parsed.data.commands ?? {}), ["affected-tests"]);
});
