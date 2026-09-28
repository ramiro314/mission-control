import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublishedWorkflowGraph, WorkflowContextSnapshot } from "../src/shared/workflow.ts";
import { FIXTURE_RUN_INTENT } from "./helpers/workflow-run-intent.ts";

// A fake `codex` that replays the provider's exact failure text. The mode comes from a file
// because `MISSION_CODEX_BIN` is read once; every invocation appends to a call log so the
// test can count real spawns rather than trusting the engine's own bookkeeping.
const home = mkdtempSync(join(tmpdir(), "mission-persona-provider-failure-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));
const fake = join(home, "codex");
const modePath = join(home, "mode");
const callsPath = join(home, "calls");
process.env.MISSION_CODEX_BIN = fake;
process.env.CODEX_FAKE_MODE = modePath;
process.env.CODEX_FAKE_CALLS = callsPath;

const MODEL_UNAVAILABLE = `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."}}`;
const QUOTA_EXHAUSTED = "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Oct 22nd, 2026 9:01 PM.";
writeFileSync(join(home, "model"), MODEL_UNAVAILABLE);
writeFileSync(join(home, "quota"), QUOTA_EXHAUSTED);
writeFileSync(join(home, "transient"), "");
// Codex can also report the refusal as a JSON error event on stdout, with the text nested
// under `error.message` and nothing on stderr.
const MODEL_MESSAGE = "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.";
writeFileSync(join(home, "model-stdout"), "");
writeFileSync(join(home, "model-stdout.stdout"), `${JSON.stringify({ type: "error", error: { message: MODEL_MESSAGE } })}\n`);
writeFileSync(fake, `#!/bin/sh
cat >/dev/null
echo call >> "$CODEX_FAKE_CALLS"
dir="$(dirname "$0")"
mode="$(cat "$CODEX_FAKE_MODE")"
cat "$dir/$mode" >&2
if [ -f "$dir/$mode.stdout" ]; then cat "$dir/$mode.stdout"; fi
exit 1
`);
chmodSync(fake, 0o755);

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore, workflowJson } = await import("../src/server/workflows/store.ts");
const { WorkflowEngine } = await import("../src/server/workflows/engine.ts");
const { codexRunner, classifyCodexFailure, configureCodexRunnerTransport } = await import("../src/server/llm/codex.ts");
const { LlmProviderFailure } = await import("../src/shared/llm.ts");

const graph: PublishedWorkflowGraph = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    {
      id: "p",
      kind: "persona",
      persona: {
        sourcePersonaId: "codex-reviewer",
        sourceRevision: 1,
        name: "Codex reviewer",
        description: "",
        guidanceMarkdown: "review",
        runner: "codex",
        model: "gpt-5.6-sol",
      },
      position: { x: 100, y: 0 },
    },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
  ],
  edges: [
    { id: "s-p", source: "session", sourcePort: "submitted", target: "p", targetPort: "activate" },
    { id: "p-pass", source: "p", sourcePort: "pass", target: "end", targetPort: "terminal" },
    { id: "p-fail", source: "p", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
  ],
};

const context: WorkflowContextSnapshot = {
  primaryGoal: { rawPrompt: "Review", refined: null, sourceNoteKey: "note" },
  humanDecisions: [],
  constraints: [],
  acceptanceCriteria: [],
  priorPersonaFeedback: [],
  session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
  evidence: {
    headSha: "abc",
    diffFingerprint: "diff",
    diff: "patch",
    diffTruncated: false,
    workingTreeDirty: false,
    workingTreeStatus: [],
    workingTreeStatusTruncated: false,
    transcript: [],
    transcriptAnchor: null,
    transcriptTruncated: false,
    standards: [],
    standardsTruncated: false,
  },
  compaction: { status: "fallback", runner: null, model: null, error: null },
};

function seed(id: string): InstanceType<typeof WorkflowStore> {
  const db = openDb();
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, '', '{"nodes":[],"edges":[]}', '{"kind":"none"}', ?, 1, ?, NULL, 1, 1)`,
  ).run(`workflow-${id}`, `Review ${id}`, `review-${id}`, defaults, `version-${id}`);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES (?, ?, 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(`version-${id}`, `workflow-${id}`, JSON.stringify(graph), defaults);
  const store = new WorkflowStore();
  const binding = store.insertBinding({
    id: `binding-${id}`,
    workflowVersionId: `version-${id}`,
    noteKey: `note-${id}`,
    sessionId: `session-${id}`,
    sessionAgent: "claude",
    sessionName: id,
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });
  store.createInitialSubmission(
    { id: `run-${id}`, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: `manual:${id}`, now: 2 },
    { id: `submission-${id}`, triggerSource: "manual", triggerKey: `manual:${id}`, context: {}, evidence: {}, now: 2 },
  );
  store.updateSubmissionCapture(`submission-${id}`, {
    context: workflowJson(context),
    evidence: workflowJson(context.evidence),
    fingerprint: `fingerprint-${id}`,
    status: "running",
  }, 3);
  return store;
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for workflow engine");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Run one Persona review against the fake in `mode`, and report what it cost and recorded. */
async function review(mode: "model" | "quota" | "transient") {
  writeFileSync(modePath, mode);
  writeFileSync(callsPath, "");
  const store = seed(mode);
  const engine = new WorkflowEngine(store, () => {}, {
    runnerFor: () => codexRunner,
    resolveExecution: () => ({
      runner: { id: "codex", source: "config", unknown: null },
      model: { id: "gpt-5.6-sol", source: "config" },
    }),
    retryBaseMs: 1,
  });
  try {
    engine.start();
    engine.activateSubmission(`submission-${mode}`);
    await waitFor(() => store.getRun(`run-${mode}`)?.status === "blocked");
  } finally {
    await engine.stop();
  }
  const rows = openDb().prepare(
    `SELECT state, error_code FROM workflow_llm_calls WHERE run_id = ? ORDER BY attempt`,
  ).all(`run-${mode}`).map((row) => ({ ...(row as { state: string; error_code: string | null }) }));
  const spawns = readFileSync(callsPath, "utf8").split("\n").filter(Boolean).length;
  const attempts = store.listAttempts(`submission-${mode}`).filter((attempt) => attempt.nodeId === "p");
  return { rows, spawns, attempts, run: store.getRun(`run-${mode}`)! };
}

test("an unavailable model is recorded as model_unavailable and costs one call", async () => {
  const { rows, spawns, attempts } = await review("model");
  assert.equal(spawns, 1);
  assert.deepEqual(rows, [{ state: "failed", error_code: "model_unavailable" }]);
  assert.deepEqual(attempts.map((attempt) => attempt.state), ["error"]);
  assert.match(attempts[0]!.error ?? "", /^Codex reviewer Persona could not run: Codex account cannot use model gpt-5\.6-sol\. /);
  // The provider's exact text survives after the sentence.
  assert.ok(attempts[0]!.error?.includes(`codex exited 1: ${MODEL_UNAVAILABLE}`));
});

test("an exhausted quota is recorded as quota_exhausted, keeps its reset time, and costs one call", async () => {
  const { rows, spawns, attempts, run } = await review("quota");
  assert.equal(spawns, 1);
  assert.deepEqual(rows, [{ state: "failed", error_code: "quota_exhausted" }]);
  assert.deepEqual(attempts.map((attempt) => attempt.attempt), [1]);
  assert.match(attempts[0]!.error ?? "", /Codex usage limit reached; resets Oct 22nd, 2026 9:01 PM\./);
  assert.ok(attempts[0]!.error?.includes(`codex exited 1: ${QUOTA_EXHAUSTED}`));
  assert.equal(run.currentPhase, "infrastructure_error");
});

test("an unrecognised non-zero exit stays persona_infrastructure and is retried as before", async () => {
  const { rows, spawns, attempts } = await review("transient");
  assert.equal(spawns, 2);
  assert.deepEqual(rows, [
    { state: "failed", error_code: "persona_infrastructure" },
    { state: "failed", error_code: "persona_infrastructure" },
  ]);
  assert.match(attempts[0]!.error ?? "", /codex exited 1: no provider failure detail/);
});

test("classifyCodexFailure reads the reset time when present and declines unknown text", () => {
  const quota = classifyCodexFailure(`codex exited 1: ${QUOTA_EXHAUSTED}`);
  assert.equal(quota?.kind, "quota_exhausted");
  assert.equal(quota?.resetsAt, "Oct 22nd, 2026 9:01 PM");
  const bare = classifyCodexFailure("codex exited 1: You've hit your usage limit.");
  assert.equal(bare?.summary, "Codex usage limit reached");
  assert.equal(bare?.resetsAt, null);
  assert.equal(classifyCodexFailure("codex exited 1: connection reset by peer"), null);
});

test("a JSON error event on stdout is read from its nested message and classified", async () => {
  writeFileSync(modePath, "model-stdout");
  const error = await codexRunner.run("review", { model: "gpt-5.6-sol" }).then(
    () => assert.fail("the run should reject"),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof LlmProviderFailure);
  assert.equal(error.kind, "model_unavailable");
  assert.equal(error.message, `codex exited 1: ${MODEL_MESSAGE}`);
  assert.equal(error.summary, "Codex account cannot use model gpt-5.6-sol");
});

test("the SDK transport classifies permanent failures and leaves others plain", async () => {
  async function sdkRejection(text: string): Promise<unknown> {
    const restore = configureCodexRunnerTransport(() => "sdk", {
      createClient: () => ({
        startThread: () => ({
          run: async () => {
            throw new Error(text);
          },
        }),
      }),
    });
    try {
      return await codexRunner.run("review", { model: "gpt-5.6-sol" }).then(
        () => assert.fail("the run should reject"),
        (caught: unknown) => caught,
      );
    } finally {
      restore();
    }
  }
  const quota = await sdkRejection(QUOTA_EXHAUSTED);
  assert.ok(quota instanceof LlmProviderFailure);
  assert.equal(quota.kind, "quota_exhausted");
  assert.equal(quota.resetsAt, "Oct 22nd, 2026 9:01 PM");
  const model = await sdkRejection(MODEL_UNAVAILABLE);
  assert.ok(model instanceof LlmProviderFailure);
  assert.equal(model.kind, "model_unavailable");
  const other = await sdkRejection("stream disconnected before completion");
  assert.ok(other instanceof Error);
  assert.equal(other instanceof LlmProviderFailure, false);
});
