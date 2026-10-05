import assert from "node:assert/strict";
import test from "node:test";
import {
  waitForCiReachable,
  workflowRunActiveNodeIds,
  type PublishedWorkflowGraph,
} from "../src/shared/workflow.ts";

/**
 * Whether a workflow run will see its pull request's merge conflict on its own. Both functions
 * are pure: the conflict episodes ask the daemon's manager, which reads the run's graph and
 * attempts and hands them here. See docs/plans/pr-merge-conflicts/plan.md, section 2.
 */

const node = (id: string, kind: string) => ({ id, kind, position: { x: 0, y: 0 } });
const edge = (source: string, sourcePort: string, target: string) =>
  ({ id: `${source}-${sourcePort}-${target}`, source, sourcePort, target, targetPort: "activate" });

// Session -> judge -> Pull Request -> Wait for CI -> review -> End. Every verdict's fail returns
// to Session; `review` passes to End, so it is past the last Wait for CI only through Session.
const GRAPH = {
  nodes: [
    node("session", "session"),
    node("judge", "persona"),
    node("pr", "session_action"),
    node("ci", "wait_for_ci"),
    node("review", "persona"),
    node("end", "end"),
  ],
  edges: [
    edge("session", "submitted", "judge"),
    edge("judge", "pass", "pr"),
    edge("judge", "fail", "session"),
    edge("pr", "complete", "ci"),
    edge("ci", "pass", "review"),
    edge("ci", "fail", "session"),
    edge("review", "pass", "end"),
  ],
} as unknown as PublishedWorkflowGraph;

test("a Wait for CI node that is active, or reachable on any port, counts", () => {
  assert.equal(waitForCiReachable(GRAPH, ["ci"]), true, "active");
  assert.equal(waitForCiReachable(GRAPH, ["pr"]), true, "the Pull Request action upstream");
  assert.equal(waitForCiReachable(GRAPH, ["judge"]), true, "further upstream");
  assert.equal(waitForCiReachable(GRAPH, ["session"]), true, "a repair round's Session");
  assert.equal(waitForCiReachable(GRAPH, ["end"]), false, "past it");
  assert.equal(waitForCiReachable(GRAPH, []), false, "nowhere");
  assert.equal(waitForCiReachable(GRAPH, ["end", "pr"]), true, "any active node");
});

test("a graph with no Wait for CI reaches none, and a cycle terminates", () => {
  const cyclic = {
    nodes: [node("session", "session"), node("judge", "persona"), node("end", "end")],
    edges: [edge("session", "submitted", "judge"), edge("judge", "fail", "session"), edge("judge", "pass", "end")],
  } as unknown as PublishedWorkflowGraph;
  assert.equal(waitForCiReachable(cyclic, ["session"]), false);
});

test("a Wait for CI the operator disabled for the run is walked through but never counts", () => {
  assert.equal(waitForCiReachable(GRAPH, ["pr"], ["ci"]), false);
  assert.equal(waitForCiReachable(GRAPH, ["ci"], ["ci"]), false);
});

test("a run is at its attempts that are still going", () => {
  const ids = workflowRunActiveNodeIds({
    status: "running",
    graph: GRAPH,
    attempts: [
      { nodeId: "judge", state: "completed" },
      { nodeId: "ci", state: "waiting" },
      { nodeId: "review", state: "queued" },
      { nodeId: "review", state: "retry_wait" },
    ],
    continuationNodeId: null,
  });
  assert.deepEqual(ids, ["ci", "review"]);
});

test("a run between attempts is at Session for a round, or at the action it continues", () => {
  const between = (status: Parameters<typeof workflowRunActiveNodeIds>[0]["status"], continuationNodeId: string | null) =>
    workflowRunActiveNodeIds({ status, graph: GRAPH, attempts: [{ nodeId: "judge", state: "completed" }], continuationNodeId });
  assert.deepEqual(between("waiting_for_session", "pr"), ["session"], "a repair round starts at Session");
  assert.deepEqual(between("capturing", null), ["session"]);
  assert.deepEqual(between("capturing", "pr"), ["pr"], "a continuation takes the action's own edges");
  assert.deepEqual(between("waiting_for_evidence_readiness", "pr"), ["pr"]);
});

test("a stopped run, or one past End at the Inspector's gate, is at no node", () => {
  for (const status of ["blocked", "completed", "cancelled", "failed", "waiting_for_pr", "waiting_for_inspector", "waiting_for_new_head"] as const) {
    const ids = workflowRunActiveNodeIds({
      status,
      graph: GRAPH,
      attempts: status === "blocked" ? [{ nodeId: "ci", state: "waiting" }] : [],
      continuationNodeId: null,
    });
    assert.deepEqual(ids, [], status);
  }
});
