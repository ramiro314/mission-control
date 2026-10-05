import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlockedPr, ServerEvent } from "../src/shared/types.ts";
import {
  waitForCiReachable,
  workflowRunActiveNodeIds,
  type PublishedWorkflowGraph,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
} from "../src/shared/workflow.ts";

// Isolate the daemon's SQLite DB before anything reads config/db.
process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "harness-pr-conflicts-"));
const { Registry } = await import("../src/server/registry.ts");
const { pollAndReconcilePrs, PrUrlPollState, reclassifyOnWorkflowRunChange } = await import(
  "../src/server/pr.ts"
);
const { PrConflictEpisodes, PrConflictTracker, unhandledReason } = await import(
  "../src/server/pr-conflicts.ts"
);
const { ForemanConfigSchema } = await import("../src/shared/protocol.ts");
const { mkSession, mkTask } = await import("./helpers/session-fixture.ts");

const PR = "https://github.com/o/r/pull/42";
const TASK_ID = "task-conflict";

const conflicting = (headSha: string, baseRef = "main") =>
  ({ state: "open", mergeable: "conflicting", baseRef, headSha }) as const;

/** Foreman live in the fixture session's repository: everything that lets it drive. */
const LIVE = ForemanConfigSchema.parse({
  enabled: true,
  mode: "live",
  repoAllowlist: ["/wt"],
});

const policy = (over: Partial<typeof LIVE> = {}) => ({ ...LIVE, ...over });

/** A reference to one PR, as `Registry.prReferences` builds it. */
const ref = (
  sessions: ReturnType<typeof mkSession>[],
  workflowOwned = false,
  workflowRunIds: string[] = workflowOwned ? ["run-1"] : [],
) => ({
  sessions,
  task: null,
  workflowOwned,
  workflowRunIds,
});

/** No workflow run gates CI. */
const noGate = () => false;

test("an episode opens on the first conflicting read and closes on mergeable, merged or closed", () => {
  for (const end of [
    { state: "open", mergeable: "mergeable", baseRef: "main", headSha: "A" },
    { state: "merged", mergeable: null, baseRef: "main", headSha: "A" },
    { state: "closed", mergeable: null, baseRef: "main", headSha: "A" },
  ] as const) {
    const episodes = new PrConflictEpisodes();
    episodes.observe(PR, { state: "open", mergeable: "mergeable", baseRef: "main", headSha: "A" }, 1);
    assert.deepEqual(episodes.list(), [], "a mergeable PR opens nothing");

    episodes.observe(PR, conflicting("A"), 5);
    assert.deepEqual(episodes.list(), [{ url: PR, since: 5, baseRef: "main", headSha: "A" }]);

    episodes.observe(PR, end, 9);
    assert.deepEqual(episodes.list(), [], `${end.state} ${end.mergeable} closes it`);
  }
});

test("an unknown current head leaves an open episode as it is", () => {
  const episodes = new PrConflictEpisodes();
  episodes.observe(PR, conflicting("A"), 5);
  episodes.observe(PR, { state: "open", mergeable: null, baseRef: "main", headSha: "B" }, 9);
  assert.deepEqual(episodes.list(), [{ url: PR, since: 5, baseRef: "main", headSha: "A" }]);

  const none = new PrConflictEpisodes();
  none.observe(PR, { state: "open", mergeable: null, baseRef: "main", headSha: "B" }, 9);
  assert.deepEqual(none.list(), [], "and opens nothing");
});

test("headSha advances on each new conflicting head without opening a new episode", () => {
  const episodes = new PrConflictEpisodes();
  episodes.observe(PR, conflicting("A"), 5);
  episodes.observe(PR, conflicting("B", "develop"), 9);
  episodes.observe(PR, conflicting("C", "develop"), 12);
  assert.deepEqual(episodes.list(), [{ url: PR, since: 5, baseRef: "develop", headSha: "C" }]);
});

test("an episode closes once no session and no task reference its PR", () => {
  const episodes = new PrConflictEpisodes();
  episodes.observe(PR, conflicting("A"), 5);
  episodes.retain((url) => url === PR);
  assert.deepEqual(episodes.urls(), [PR]);
  episodes.retain(() => false);
  assert.deepEqual(episodes.urls(), []);
});

test("session-gone: no live session owns the PR", () => {
  assert.equal(unhandledReason(ref([]), policy(), noGate), "session-gone");
  const exited = mkSession({ cwd: "/wt/app", state: "exited" });
  assert.equal(unhandledReason(ref([exited]), policy(), noGate), "session-gone", "an exited owner is not live");
});

test("foreman-cannot-nudge covers every case Foreman's follow-through refuses to type", () => {
  const live = mkSession({ cwd: "/wt/app", state: "idle" });
  assert.equal(unhandledReason(ref([live]), policy(), noGate), null, "Foreman drives this one");
  const cases: Array<[string, ReturnType<typeof mkSession>, ReturnType<typeof policy>]> = [
    ["trackMergeConflicts off", live, policy({ trackMergeConflicts: false })],
    ["not invited", { ...live, foremanInvite: null }, policy()],
    ["dry-run", live, policy({ mode: "dry-run" })],
    ["Foreman off", live, policy({ enabled: false })],
    ["not allowlisted", { ...live, cwd: "/elsewhere" }, policy()],
    ["no hooks", { ...live, hooksSeen: false }, policy()],
  ];
  for (const [why, session, p] of cases) {
    assert.equal(unhandledReason(ref([session]), p, noGate), "foreman-cannot-nudge", why);
  }
});

test("work an active workflow owns is handled exactly when one of its runs reaches Wait for CI", () => {
  const gating = (id: string) => id === "gating";
  const live = mkSession({ cwd: "/wt/app", state: "idle", foremanInvite: null });
  const exited = mkSession({ cwd: "/wt/app", state: "exited" });
  for (const [why, sessions] of [["live", [live]], ["exited", [exited]], ["removed", []]] as const) {
    assert.equal(unhandledReason(ref([...sessions], true, ["gating"]), policy(), gating), null, `${why}: handled`);
    assert.equal(
      unhandledReason(ref([...sessions], true, ["past-it"]), policy(), gating),
      "workflow-not-gating",
      `${why}: not session-gone or foreman-cannot-nudge`,
    );
  }
  assert.equal(unhandledReason(ref([live], true, ["past-it", "gating"]), policy(), gating), null, "any run");
  // A multi-repo session's run for ANOTHER repository owns the session, so Foreman stays out,
  // but there is no run for this pull request's repository to gate it.
  assert.equal(unhandledReason(ref([live], true, []), policy(), gating), "workflow-not-gating");
});

/**
 * The plan's four workflow-owned cases, through the real reachability walk: Session -> Pull
 * Request action -> Wait for CI -> End, with Wait for CI's fail returning to Session, and a
 * second shape that has no Wait for CI at all.
 */
test("the four workflow-owned cases classify through the reachability walk", () => {
  const node = (id: string, kind: string) => ({ id, kind, position: { x: 0, y: 0 } });
  const edge = (source: string, sourcePort: string, target: string) =>
    ({ id: `${source}-${sourcePort}`, source, sourcePort, target, targetPort: "activate" });
  const gated = {
    nodes: [node("session", "session"), node("pr", "session_action"), node("ci", "wait_for_ci"), node("judge", "persona"), node("end", "end")],
    edges: [
      edge("session", "submitted", "pr"),
      edge("pr", "complete", "ci"),
      edge("ci", "pass", "end"),
      edge("ci", "fail", "session"),
    ],
  } as unknown as PublishedWorkflowGraph;
  const ungated = {
    nodes: [node("session", "session"), node("pr", "session_action"), node("judge", "persona"), node("end", "end")],
    edges: [edge("session", "submitted", "pr"), edge("pr", "complete", "judge"), edge("judge", "pass", "end")],
  } as unknown as PublishedWorkflowGraph;
  const at = (
    graph: PublishedWorkflowGraph,
    status: WorkflowRunStatus,
    attempts: Array<{ nodeId: string; state: "waiting" | "running" | "completed" }>,
  ) => () => waitForCiReachable(graph, workflowRunActiveNodeIds({ status, graph, attempts, continuationNodeId: null }));
  const live = mkSession({ cwd: "/wt/app", state: "idle", foremanInvite: null });
  const classify = (gatesCi: () => boolean) => unhandledReason(ref([live], true), policy(), gatesCi);

  assert.equal(classify(at(gated, "running", [{ nodeId: "ci", state: "waiting" }])), null, "at Wait for CI");
  assert.equal(
    classify(at(gated, "waiting_for_action", [{ nodeId: "pr", state: "waiting" }])),
    null,
    "on the Pull Request action upstream of it",
  );
  assert.equal(classify(at(gated, "waiting_for_session", [])), null, "in a repair round that loops back");
  assert.equal(
    classify(at(ungated, "running", [{ nodeId: "judge", state: "running" }])),
    "workflow-not-gating",
    "no Wait for CI",
  );
  assert.equal(
    classify(at(gated, "running", [{ nodeId: "end", state: "running" }, { nodeId: "ci", state: "completed" }])),
    "workflow-not-gating",
    "past the last one",
  );
});

/**
 * A PR poll against a real registry, with `gh` stood in for. With `task`, the session is a
 * task's agent and the PR binds to that task's work episode, as a dispatch leaves it.
 */
function harness({ task = false, repoRoot = null }: { task?: boolean; repoRoot?: string | null } = {}) {
  const reg = new Registry();
  reg.applyDiscovery([
    {
      syntheticId: "live",
      agent: "claude",
      name: "the agent",
      nameSource: "process",
      cwd: "/wt/app",
      gitBranch: "feat/x",
      gitRoot: repoRoot,
      repoRoot,
      pid: 1,
      tty: null,
      terminals: [],
      startedAt: 0,
    },
  ]);
  if (task) {
    // The agent's own session id is what a work episode is keyed on.
    reg.applyHook({ agent: "claude", event: "Stop", sessionId: "live-episode", cwd: "/wt/app", transcriptPath: null, env: {} });
    reg.upsertTask(mkTask({ id: TASK_ID, title: "Ship the thing", status: "running", sessionId: "live", worktreePath: "/wt/app" }));
    reg.bindTaskToWorkEpisode(TASK_ID, "live");
  }
  const frames: BlockedPr[][] = [];
  reg.subscribe((e: ServerEvent) => {
    if (e.type === "blocked_prs") frames.push(e.prs);
  });
  // The runs that can still reach a Wait for CI node, as the daemon's manager would answer.
  const gating = new Set<string>();
  const tracker = new PrConflictTracker(reg, () => LIVE, (runId) => gating.has(runId));
  // The daemon's own wiring: a run event re-derives the blocked set between polls.
  reclassifyOnWorkflowRunChange(reg, tracker);
  const urlState = new PrUrlPollState();
  let branchRead: "conflicting" | "mergeable" = "conflicting";
  type UrlRead = { state: "open" | "merged"; mergeable: "conflicting" | "mergeable" };
  let urlRead: UrlRead = { state: "open", mergeable: "conflicting" };
  const askedByUrl: string[] = [];
  const operational: string[][] = [];
  const realMerges = reg.reconcilePrMerges.bind(reg);
  reg.reconcilePrMerges = (merged: Map<string, number>) => {
    operational.push([...merged.keys()]);
    realMerges(merged);
  };
  let now = 1_000_000;
  const poll = () =>
    pollAndReconcilePrs(
      reg,
      async () => ({
        url: PR,
        number: 42,
        state: "open" as const,
        checks: null,
        // Now, so a task's work episode accepts it as opened during the episode.
        createdAt: Date.now(),
        mergedAt: null,
        headSha: "A",
        worktreeHeadSha: "A",
        mergeable: branchRead,
        baseRef: "main",
      }),
      async (url) => {
        askedByUrl.push(url);
        return {
          state: urlRead.state,
          mergedAt: urlRead.state === "merged" ? 7 : null,
          mergeable: urlRead.mergeable,
          baseRef: "main",
          headSha: "B",
        };
      },
      urlState,
      (now += 10 * 60_000),
      async () => null,
      () => [],
      tracker,
    );
  return {
    reg,
    frames,
    tracker,
    gating,
    askedByUrl,
    operational,
    poll,
    setBranch: (v: typeof branchRead) => (branchRead = v),
    setUrl: (v: UrlRead) => (urlRead = v),
  };
}

test("blocked_prs is emitted only when the blocked set changes", async () => {
  const h = harness();
  await h.poll();
  assert.equal(h.frames.length, 1);
  assert.equal(h.frames[0]![0]!.reason, "foreman-cannot-nudge", "discovered sessions are uninvited");
  assert.equal(h.frames[0]![0]!.repo, "o/r");
  assert.equal(h.frames[0]![0]!.baseRef, "main");
  assert.deepEqual(h.reg.snapshot().blockedPrs, h.frames[0], "and it rides the snapshot");

  await h.poll();
  await h.poll();
  assert.equal(h.frames.length, 1, "the same set is not re-sent");

  h.setBranch("mergeable");
  await h.poll();
  assert.deepEqual(h.frames.at(-1), [], "the fix clears it");
  assert.equal(h.frames.length, 2);
});

test("an open episode keeps an exited task-less session's PR on the by-URL poller, never as operational", async () => {
  const h = harness();
  await h.poll();
  assert.deepEqual(h.askedByUrl, [], "the branch poller answers for a live session");

  // The session exits. No task names the PR, so only the open episode keeps it polled.
  h.reg.applyDiscovery([]);
  assert.equal(h.reg.getSession("live")!.state, "exited");
  // GitHub answers "merged": were the episode's URL operational, the merge would reach
  // `reconcilePrMerges`. It must not.
  h.setUrl({ state: "merged", mergeable: "conflicting" });
  await h.poll();
  assert.deepEqual(h.askedByUrl, [PR], "the episode's URL is harvested");
  assert.deepEqual(h.operational.at(-1), [], "but gains no merge-completion authority");
});

test("an exited session's conflict reads session-gone and clears when the PR is mergeable", async () => {
  const h = harness();
  await h.poll();
  h.reg.applyDiscovery([]);
  await h.poll();
  const row = h.frames.at(-1)![0]!;
  assert.equal(row.reason, "session-gone");
  assert.equal(row.headSha, "B", "the latest conflicting head, from the by-URL read");
  assert.equal(row.sessionName, "the agent", "the exited session still names the row");
  assert.equal(h.frames.length, 2, "a reason change is one frame");

  h.setUrl({ state: "open", mergeable: "mergeable" });
  await h.poll();
  assert.deepEqual(h.frames.at(-1), []);
  assert.deepEqual(h.tracker.episodes.urls(), [], "and its PR leaves the harvest");
  const asked = h.askedByUrl.length;
  await h.poll();
  assert.equal(h.askedByUrl.length, asked, "nothing asks about it any more");
});

test("session_remove closes the episode of a PR no task references", async (t) => {
  const h = harness();
  await h.poll();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  h.reg.applyDiscovery([]);
  await h.poll();
  assert.equal(h.frames.at(-1)![0]!.reason, "session-gone", "exited, but still held");

  // The exit linger runs out and the registry removes the session: `session_remove`.
  t.mock.timers.tick(10_000);
  assert.equal(h.reg.getSession("live"), undefined);
  await h.poll();
  assert.deepEqual(h.tracker.episodes.urls(), []);
  assert.deepEqual(h.frames.at(-1), []);
  const asked = h.askedByUrl.length;
  await h.poll();
  assert.equal(h.askedByUrl.length, asked, "the PR is no longer asked about by URL");
});

test("a task's reference keeps the episode open after session_remove, as session-gone", async (t) => {
  const h = harness({ task: true });
  await h.poll();
  assert.equal(h.reg.getSession("live")!.prUrl, PR, "the task's episode adopted the PR");
  assert.ok(h.reg.taskPrPollTargets().includes(PR), "and the task binding carries it");

  t.mock.timers.enable({ apis: ["setTimeout"] });
  h.reg.applyDiscovery([]);
  t.mock.timers.tick(10_000);
  assert.equal(h.reg.getSession("live"), undefined, "the session was removed");
  await h.poll();
  assert.deepEqual(h.tracker.episodes.urls(), [PR]);
  const row = h.frames.at(-1)![0]!;
  assert.equal(row.reason, "session-gone");
  assert.equal(row.taskId, TASK_ID);
  assert.equal(row.taskTitle, "Ship the thing");
  assert.equal(row.sessionId, null, "no session left to link");
});

test("workflowOwnsSession matches a non-terminal run by session id or note key", () => {
  const { reg } = harness();
  const s = reg.getSession("live")!;
  const run = (id: string, over: Partial<WorkflowRunSummary>) =>
    ({ id, status: "running", sessionId: null, noteKey: "someone-else", ...over }) as WorkflowRunSummary;
  assert.equal(reg.workflowOwnsSession(s), false, "no runs");
  reg.upsertWorkflowRun(run("other", { sessionId: "another-session" }));
  assert.equal(reg.workflowOwnsSession(s), false, "another session's run");
  reg.upsertWorkflowRun(run("done", { sessionId: s.id, status: "completed" }));
  assert.equal(reg.workflowOwnsSession(s), false, "a terminal run has released it");
  reg.upsertWorkflowRun(run("by-id", { sessionId: s.id }));
  assert.equal(reg.workflowOwnsSession(s), true, "matched by session id");
  reg.removeWorkflowRun("by-id");
  reg.upsertWorkflowRun(run("by-key", { noteKey: s.agentSessionId ?? s.id }));
  assert.equal(reg.workflowOwnsSession(s), true, "matched by note key");
});

test("a workflow that can reach Wait for CI handles the conflict, and one past it does not", async () => {
  const h = harness();
  h.gating.add("owner");
  h.reg.upsertWorkflowRun({ id: "owner", status: "running", sessionId: "live", noteKey: "live" } as WorkflowRunSummary);
  await h.poll();
  assert.deepEqual(h.tracker.episodes.urls(), [PR], "the episode is open");
  assert.equal(h.frames.length, 0, "but nothing is blocked");

  // From here on there is no poll and no manual reclassify: only the run's own events.
  // The run moves between nodes that can all still reach Wait for CI: nothing is published.
  h.reg.upsertWorkflowRun({ id: "owner", status: "waiting_for_session", sessionId: "live", noteKey: "live" } as WorkflowRunSummary);
  assert.equal(h.frames.length, 0, "no flap");

  // The run moves past its last Wait for CI: its upsert re-derives the blocked set.
  h.gating.delete("owner");
  h.reg.upsertWorkflowRun({ id: "owner", status: "running", sessionId: "live", noteKey: "live" } as WorkflowRunSummary);
  assert.equal(h.frames.length, 1, "the run event published the change");
  assert.equal(h.frames[0]![0]!.reason, "workflow-not-gating");

  // The last owning run is removed: nothing owns the work, so the row says why now.
  h.reg.removeWorkflowRun("owner");
  assert.equal(h.frames.length, 2, "the removal published the change");
  assert.equal(h.frames[1]![0]!.reason, "foreman-cannot-nudge", "discovered sessions are uninvited");

  await h.poll();
  assert.equal(h.frames.length, 2, "and the next poll agrees");
});

test("only a run reviewing the pull request's own repository can gate it", async () => {
  const h = harness({ repoRoot: "/wt" });
  const run = (id: string, repoRoot: string) =>
    ({ id, status: "running", sessionId: "live", noteKey: "live", repoRoot }) as WorkflowRunSummary;
  // A multi-repo session's run for its secondary repository owns the session, so Foreman
  // stays out, but it has no Wait for CI for the primary's pull request.
  h.gating.add("secondary");
  h.reg.upsertWorkflowRun(run("secondary", "/other-repo"));
  await h.poll();
  const reference = h.reg.prReferences().get(PR)!;
  assert.equal(reference.workflowOwned, true);
  assert.deepEqual(reference.workflowRunIds, []);
  assert.equal(h.frames.at(-1)![0]!.reason, "workflow-not-gating");

  h.gating.add("primary");
  h.reg.upsertWorkflowRun(run("primary", "/wt"));
  assert.deepEqual(h.reg.prReferences().get(PR)!.workflowRunIds, ["primary"]);
  assert.deepEqual(h.frames.at(-1), [], "the primary's run handles it, from its upsert alone");
});

test("a workflow run still active after its agent exits keeps classifying the conflict", async (t) => {
  const h = harness({ task: true });
  // Bound by note key, as a workflow binding is: the run outlives the session it drove.
  h.gating.add("step");
  h.reg.upsertWorkflowRun({ id: "step", status: "running", sessionId: "live", noteKey: "live-episode" } as WorkflowRunSummary);
  await h.poll();
  assert.equal(h.frames.length, 0, "owned while live");

  t.mock.timers.enable({ apis: ["setTimeout"] });
  h.reg.applyDiscovery([]);
  assert.equal(h.reg.getSession("live")!.state, "exited");
  await h.poll();
  assert.equal(h.frames.length, 0, "still owned after the agent exits, not session-gone");

  t.mock.timers.tick(10_000);
  assert.equal(h.reg.getSession("live"), undefined, "the session was removed");
  assert.deepEqual(h.reg.prReferences().get(PR)?.workflowRunIds, ["step"], "through the task's work-episode binding");
  // `orphanBinding` nulls the run's session id and blocks it: a blocked run reaches nothing.
  h.gating.delete("step");
  h.reg.upsertWorkflowRun({ id: "step", status: "blocked", sessionId: null, noteKey: "live-episode" } as WorkflowRunSummary);
  await h.poll();
  assert.equal(h.frames.at(-1)![0]!.reason, "workflow-not-gating");
  assert.deepEqual(h.tracker.episodes.urls(), [PR], "the episode itself stays open");

  // Once the run is over, nothing owns the work, and the conflict is the operator's.
  h.reg.upsertWorkflowRun({ id: "step", status: "failed", sessionId: null, noteKey: "live-episode" } as WorkflowRunSummary);
  await h.poll();
  assert.equal(h.frames.at(-1)![0]!.reason, "session-gone");
});
