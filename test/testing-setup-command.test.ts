import assert from "node:assert/strict";
import test from "node:test";
import { WORKFLOW_LIMITS, type WorkflowCommandView } from "../src/shared/workflow.ts";
import type { UpdateWorkflowCommand } from "../src/shared/protocol.ts";
import type { Task } from "../src/shared/types.ts";
import { setAffectedTestsCommand } from "../src/server/testing-setup.ts";
import { TESTING_SETUP_TASK_LABEL } from "../src/server/testing-setup-tool.ts";
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
