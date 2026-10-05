import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_RUN_INTENT } from "./helpers/workflow-run-intent.ts";

// What is at stake: a completed bound run must not be followed by another automatic run until
// a human gives a new instruction. The Pull Request action's own turn, an Inspector fix, a
// background wake-up - every daemon-injected turn - settles under the SAME intent episode, and
// before the latch each one claimed a fresh run on the open PR.
const home = mkdtempSync(join(tmpdir(), "mission-workflow-completion-latch-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { getQueueRow, openDb } = await import("../src/server/db.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");

const db = openDb();
const graph = JSON.stringify({
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
  ],
  edges: [],
});
const defaults = JSON.stringify({
  triggerMode: "foreman_complete",
  deliveryMode: "preview",
  maxRepairRounds: 3,
});
db.prepare(
  `INSERT INTO workflow_definitions (
     id, name, normalized_name, description, draft_graph_json, completion_policy_json,
     binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
   ) VALUES ('w', 'Latch', 'latch', '', ?, '{"kind":"none"}', ?, 1, 'v', NULL, 1, 1)`,
).run(graph, defaults);
db.prepare(
  `INSERT INTO workflow_versions (
     id, workflow_id, version, source_draft_revision, graph_json,
     completion_policy_json, binding_defaults_json, published_at
   ) VALUES ('v', 'w', 1, 1, ?, '{"kind":"none"}', ?, 1)`,
).run(graph, defaults);

const store = new WorkflowStore(db);
const OBJECTIVE = "Ship the feature";

/** One conversation with its own Foreman Complete binding. */
function conversation(name: string) {
  const noteKey = `note-${name}`;
  const binding = store.insertBinding({
    id: `binding-${name}`,
    workflowVersionId: "v",
    noteKey,
    sessionId: `session-${name}`,
    sessionAgent: "claude",
    sessionName: name,
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "foreman_complete",
    deliveryMode: "preview",
    maxRepairRounds: 3,
    now: 1,
  });
  let generation = 0;
  let claims = 0;
  const c = {
    noteKey,
    binding,
    /** An accepted human prompt: the only thing that advances the episode. */
    goal(promptRevision: number) {
      db.prepare(
        `INSERT INTO session_goals (
           note_key, objective, relationship, objective_version, prompt_revision,
           resolved_prompt_revision, updated_at
         ) VALUES (?, ?, 'initial', 1, ?, ?, 1)
         ON CONFLICT(note_key) DO UPDATE SET
           prompt_revision = excluded.prompt_revision,
           resolved_prompt_revision = excluded.resolved_prompt_revision`,
      ).run(noteKey, OBJECTIVE, promptRevision, promptRevision);
    },
    /** One settled turn: a completed work-cycle generation Foreman can consume. */
    settle() {
      generation += 1;
      db.prepare(
        `INSERT INTO session_work_cycles (logical_key, generation, active, completed_at, updated_at)
         VALUES (?, ?, 0, 10, 10)
         ON CONFLICT(logical_key) DO UPDATE SET generation = excluded.generation`,
      ).run(noteKey, generation);
    },
    prompted(promptRevision: number) {
      claims += 1;
      return store.claimForemanCompletion({
        binding,
        completionKind: "prompted",
        marker: `${name}-prompted-${claims}`,
        expectedWorkCycle: { logicalKey: noteKey, generation },
        summary: `turn ${generation}`,
        evidenceFingerprint: `fp-${claims}`,
        expectedIntent: {
          objective: OBJECTIVE,
          objectiveVersion: 1,
          promptRevision,
          episodeKey: `intent:1:${promptRevision}`,
        },
        runId: `${name}-run-${claims}`,
        submissionId: `${name}-submission-${claims}`,
        guardCwd: "/repo",
        intent: FIXTURE_RUN_INTENT,
        now: 100 + claims,
      });
    },
    /** A drained work queue: every item terminal and the drain guard armed. */
    drain() {
      claims += 1;
      db.prepare(
        `INSERT INTO foreman_queues (note_key, cwd, branch, wrapup_asked_at, updated_at)
         VALUES (?, '/repo', 'feature', NULL, 1)
         ON CONFLICT(note_key) DO UPDATE SET wrapup_asked_at = NULL, wrapup_answer = NULL`,
      ).run(noteKey);
      db.prepare(
        `INSERT INTO foreman_queue_items (
           id, note_key, seq, intent, state, round, gaps, revision, created_at, updated_at,
           completed_at
         ) VALUES (?, ?, ?, 'finish', 'verified', 1, '[]', 0, 1, 1, 1)`,
      ).run(`${name}-item-${claims}`, noteKey, claims);
      return store.claimForemanCompletion({
        binding,
        completionKind: "drain",
        marker: `${name}-drain-${claims}`,
        expectedWorkCycle: null,
        summary: "queue drained",
        evidenceFingerprint: `fp-${claims}`,
        expectedIntent: null,
        runId: `${name}-run-${claims}`,
        submissionId: `${name}-submission-${claims}`,
        intent: FIXTURE_RUN_INTENT,
        now: 100 + claims,
      });
    },
    /** Emptied, so the PR turn that follows settles as a PROMPTED completion. */
    emptyQueue() {
      db.prepare(`DELETE FROM foreman_queue_items WHERE note_key = ?`).run(noteKey);
    },
    runs() {
      return db.prepare(
        `SELECT id, status, claim_episode_key FROM workflow_runs WHERE binding_id = ? ORDER BY started_at, id`,
      ).all(binding.id) as Array<{ id: string; status: string; claim_episode_key: string | null }>;
    },
  };
  return c;
}

function finish(runId: string, status: "completed" | "cancelled" | "waiting_for_session"): void {
  db.prepare(
    `UPDATE workflow_runs SET status = ?, current_phase = ?, completed_at = ? WHERE id = ?`,
  ).run(
    status,
    status === "waiting_for_session" ? "persona_feedback" : status,
    status === "waiting_for_session" ? null : 50,
    runId,
  );
}

function stateOf(claim: { result: { claimed: boolean; state?: string } }): string | null {
  return claim.result.claimed ? claim.result.state ?? null : null;
}

function stampOf(runId: string): string | null {
  return (db.prepare(`SELECT claim_episode_key FROM workflow_runs WHERE id = ?`)
    .get(runId) as { claim_episode_key: string | null }).claim_episode_key;
}

test("a completed run latches its binding until a human prompt re-arms it", () => {
  const c = conversation("latch");
  c.goal(1);
  c.settle();
  const first = c.prompted(1);
  assert.equal(stateOf(first), "started");
  const runId = first.run!.id;
  assert.equal(stampOf(runId), "intent:1:1", "a claim that starts a run stamps its episode");
  finish(runId, "completed");

  // The Pull Request action's own turn settles under the same episode.
  c.settle();
  const latched = c.prompted(1);
  assert.deepEqual(latched.result, {
    claimed: true,
    runId,
    submissionId: null,
    state: "latched",
  });
  assert.equal(latched.created, false);
  assert.equal(c.runs().length, 1, "a latched claim creates no run");
  assert.equal(store.listSubmissions(runId).length, 1, "and resubmits nothing");
  // The generation is spent, with its reason, in the same transaction.
  const queue = getQueueRow(c.noteKey);
  assert.equal(queue?.promptedConsumedGeneration, 2);
  assert.equal(queue?.promptedDecision?.outcome, "workflow_latched");
  assert.equal(queue?.promptedDecision?.episodeKey, "intent:1:1");
  assert.equal(queue?.promptedDirectHandoff, null, "latching hands nothing off");
  // Recorded on the completed run, naming it, and NOT as one of that run's claims.
  const events = store.listEvents(runId);
  const latchEvents = events.filter((event) => event.kind === "claim_latched");
  assert.equal(latchEvents.length, 1);
  assert.equal((latchEvents[0]!.payload as { completedRunId: string }).completedRunId, runId);
  assert.equal(
    events.filter((event) => event.kind === "workflow_completion_claimed").length,
    1,
    "only the claim that started the run is one of its claims",
  );

  // A replay of the same proof answers the same way without spending anything again.
  const replay = store.claimForemanCompletion({
    binding: c.binding,
    completionKind: "prompted",
    marker: "latch-prompted-2",
    expectedWorkCycle: { logicalKey: c.noteKey, generation: 2 },
    summary: "turn 2",
    evidenceFingerprint: "fp-2",
    expectedIntent: {
      objective: OBJECTIVE,
      objectiveVersion: 1,
      promptRevision: 1,
      episodeKey: "intent:1:1",
    },
    runId: "latch-replay-run",
    submissionId: "latch-replay-submission",
    guardCwd: "/repo",
    intent: FIXTURE_RUN_INTENT,
    now: 200,
  });
  assert.deepEqual(replay.result, { claimed: true, runId, submissionId: null, state: "latched" });
  assert.equal(store.listEvents(runId).filter((event) => event.kind === "claim_latched").length, 1);

  // An Inspector fix, a background wake-up: still the same episode, still latched.
  c.settle();
  assert.equal(stateOf(c.prompted(1)), "latched");
  assert.equal(c.runs().length, 1);

  // A human prompt advances the episode. The next completion starts exactly one new run.
  c.goal(2);
  c.settle();
  const rearmed = c.prompted(2);
  assert.equal(stateOf(rearmed), "started");
  assert.equal(c.runs().length, 2);
  assert.equal(stampOf(rearmed.run!.id), "intent:1:2");
  assert.equal(getQueueRow(c.noteKey)?.promptedDecision?.outcome, "workflow_claimed");
});

test("a cancelled run does not latch", () => {
  const c = conversation("cancelled");
  c.goal(1);
  c.settle();
  const first = c.prompted(1);
  finish(first.run!.id, "cancelled");
  c.settle();
  const next = c.prompted(1);
  assert.equal(stateOf(next), "started");
  assert.equal(c.runs().length, 2);
});

test("a pre-upgrade run with no stamp does not latch, and the run after it stamps itself", () => {
  const c = conversation("legacy");
  c.goal(1);
  // Every run created before the column existed reads as an unstamped row.
  store.createInitialSubmission(
    { id: "legacy-run", binding: c.binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "manual:legacy", now: 2 },
    { id: "legacy-submission", triggerSource: "manual", triggerKey: "manual:legacy", context: {}, evidence: {}, now: 2 },
  );
  assert.equal(stampOf("legacy-run"), null);
  finish("legacy-run", "completed");
  c.settle();
  const next = c.prompted(1);
  assert.equal(stateOf(next), "started");
  assert.equal(stampOf(next.run!.id), "intent:1:1");
  finish(next.run!.id, "completed");
  c.settle();
  assert.equal(stateOf(c.prompted(1)), "latched");
  assert.equal(c.runs().length, 2, "at most one more run per pre-upgrade binding");
});

test("a resubmission restamps the run with the episode of the claim that fed it", () => {
  const c = conversation("restamp");
  c.goal(1);
  c.settle();
  const first = c.prompted(1);
  const runId = first.run!.id;
  // An in-run repair round: the run parks for the session and stays active.
  finish(runId, "waiting_for_session");
  c.goal(2);
  c.settle();
  const repaired = c.prompted(2);
  assert.equal(stateOf(repaired), "resubmitted");
  assert.equal(repaired.result.claimed && repaired.result.runId, runId);
  assert.equal(stampOf(runId), "intent:1:2");
  assert.equal(c.runs().length, 1);
});

test("a drain-started run is stamped from the goal, and its own PR turn is latched", () => {
  const c = conversation("drain");
  c.goal(1);
  const started = c.drain();
  assert.equal(stateOf(started), "started");
  const runId = started.run!.id;
  assert.equal(stampOf(runId), "intent:1:1", "the drain claim reads the same goal row");
  finish(runId, "completed");

  // The Pull Request action's turn on the emptied queue settles as a prompted completion.
  c.emptyQueue();
  c.settle();
  const latched = c.prompted(1);
  assert.equal(stateOf(latched), "latched");
  assert.equal(c.runs().length, 1);
});

test("a queue-drain claim is never refused by the latch", () => {
  const c = conversation("drain-not-latched");
  c.goal(1);
  c.settle();
  const first = c.prompted(1);
  finish(first.run!.id, "completed");
  // New queue items are human work: draining them is a new ask even in the same episode.
  const drained = c.drain();
  assert.equal(stateOf(drained), "started");
  assert.equal(c.runs().length, 2);
});

test("accepted residual: a drain claim on a session with no recorded goal leaves the stamp null", () => {
  const c = conversation("no-goal");
  const started = c.drain();
  const runId = started.run!.id;
  assert.equal(stampOf(runId), null, "no session_goals row, nothing to stamp");
  finish(runId, "completed");
  // The goal is recorded later without a human prompt bumping it: the null stamp never
  // latches, so this one extra run is the residual the plan accepts.
  c.goal(1);
  c.emptyQueue();
  c.settle();
  const next = c.prompted(1);
  assert.equal(stateOf(next), "started");
  assert.equal(c.runs().length, 2);
});

test("a human-requested PR before the first claim still gets one workflow run (dungeon-game#8)", () => {
  const c = conversation("human-pr");
  c.goal(1);
  // The human types "create the PR" before Foreman ever claimed: a new accepted prompt, and
  // the agent opens the PR in that turn. No run exists yet, so nothing can latch.
  c.goal(2);
  c.settle();
  const first = c.prompted(2);
  assert.equal(stateOf(first), "started");
  assert.equal(c.runs().length, 1, "the bound workflow runs once against the open PR");
  finish(first.run!.id, "completed");
  c.settle();
  assert.equal(stateOf(c.prompted(2)), "latched");
  assert.equal(c.runs().length, 1);
});

test("accepted residual (terminal runtime): a packet whose ledger entry is gone reads as human and re-arms the latch", async () => {
  const { Registry, noteKeyFor } = await import("../src/server/registry.ts");
  const { forgetInjections, recordInjection } = await import("../src/server/injections.ts");
  const { mkMuxHandle } = await import("./helpers/session-fixture.ts");
  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: "terminal",
    agent: "claude",
    name: "terminal",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    pid: 1,
    tty: "ttys-latch",
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: "%91" })],
    startedAt: 0,
  } as import("../src/server/discovery/correlate.ts").DiscoveredSession]);
  const session = registry.getSession("terminal")!;
  const noteKey = noteKeyFor(session);
  const hook = (event: "UserPromptSubmit" | "Stop", prompt?: string): void => {
    registry.applyHook({
      agent: "claude",
      event,
      sessionId: null,
      cwd: null,
      transcriptPath: null,
      env: { tmuxPane: "%91" },
      ...(prompt === undefined ? {} : { prompt }),
    } as import("../src/shared/protocol.ts").HookIngest);
  };
  /** The intent reconciler, accepting whatever revision the hook left pending. */
  const reconcile = (): number => {
    const revision = registry.getGoal(session.id)!.promptRevision;
    registry.upsertGoal(session.id, {
      objective: OBJECTIVE,
      relationship: revision === 1 ? "initial" : "steer",
      objectiveVersion: 1,
      promptRevision: revision,
      resolvedPromptRevision: revision,
      pendingPrompts: [],
    }, 5);
    return revision;
  };
  const binding = store.insertBinding({
    id: "binding-terminal",
    workflowVersionId: "v",
    noteKey,
    sessionId: session.id,
    sessionAgent: "claude",
    sessionName: "terminal",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "foreman_complete",
    deliveryMode: "preview",
    maxRepairRounds: 3,
    now: 1,
  });
  let claims = 0;
  /** One turn: the prompt hook echoes `prompt`, the agent stops, and Foreman claims. */
  const turn = (prompt: string) => {
    hook("UserPromptSubmit", prompt);
    hook("Stop");
    const revision = reconcile();
    const generation = registry.getSession(session.id)!.workCycle!.generation;
    claims += 1;
    return store.claimForemanCompletion({
      binding,
      completionKind: "prompted",
      marker: `terminal-${claims}`,
      expectedWorkCycle: { logicalKey: noteKey, generation },
      summary: "done",
      evidenceFingerprint: `fp-terminal-${claims}`,
      expectedIntent: {
        objective: OBJECTIVE,
        objectiveVersion: 1,
        promptRevision: revision,
        episodeKey: `intent:1:${revision}`,
      },
      runId: `terminal-run-${claims}`,
      submissionId: `terminal-submission-${claims}`,
      guardCwd: "/repo",
      intent: FIXTURE_RUN_INTENT,
      now: 300 + claims,
    });
  };

  const first = turn(OBJECTIVE);
  assert.equal(stateOf(first), "started");
  finish(first.run!.id, "completed");

  // The Pull Request action's packet, delivered and recorded: its echo is daemon-authored, so
  // the episode does not move and the claim stays latched.
  const PACKET = "Run the Pull Request action: open the pull request for this work.";
  recordInjection(session.id, PACKET, "workflow");
  const latched = turn(PACKET);
  assert.equal(registry.getGoal(session.id)!.promptRevision, 1);
  assert.equal(stateOf(latched), "latched");

  // The same kind of packet, but the daemon restarts between delivery and echo. The in-memory
  // ledger forgets it, the echo reads as human, the revision moves, and the latch re-arms:
  // one extra run, the window `injections.ts` already accepts for the Goal.
  const INSPECTOR = "Inspector found review comments on the pull request; address them.";
  recordInjection(session.id, INSPECTOR, "workflow");
  forgetInjections();
  const rearmed = turn(INSPECTOR);
  assert.equal(registry.getGoal(session.id)!.promptRevision, 2);
  assert.equal(stateOf(rearmed), "started");
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM workflow_runs WHERE binding_id = ?`)
      .get(binding.id) as { n: number }).n,
    2,
  );
});
