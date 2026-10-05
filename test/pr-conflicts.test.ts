import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlockedPr, ServerEvent } from "../src/shared/types.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";

// Isolate the daemon's SQLite DB before anything reads config/db.
process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "harness-pr-conflicts-"));
const { Registry } = await import("../src/server/registry.ts");
const { pollAndReconcilePrs, PrUrlPollState } = await import("../src/server/pr.ts");
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
const ref = (sessions: ReturnType<typeof mkSession>[], workflowOwned = false) => ({
  sessions,
  task: null,
  workflowOwned,
});

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
    assert.deepEqual(episodes.list(), [{ url: PR, since: 5, baseRef: "main", headSha: "A", escalated: false, escalatedHead: null }]);

    episodes.observe(PR, end, 9);
    assert.deepEqual(episodes.list(), [], `${end.state} ${end.mergeable} closes it`);
  }
});

test("an unknown current head leaves an open episode as it is", () => {
  const episodes = new PrConflictEpisodes();
  episodes.observe(PR, conflicting("A"), 5);
  episodes.observe(PR, { state: "open", mergeable: null, baseRef: "main", headSha: "B" }, 9);
  assert.deepEqual(episodes.list(), [{ url: PR, since: 5, baseRef: "main", headSha: "A", escalated: false, escalatedHead: null }]);

  const none = new PrConflictEpisodes();
  none.observe(PR, { state: "open", mergeable: null, baseRef: "main", headSha: "B" }, 9);
  assert.deepEqual(none.list(), [], "and opens nothing");
});

test("headSha advances on each new conflicting head without opening a new episode", () => {
  const episodes = new PrConflictEpisodes();
  episodes.observe(PR, conflicting("A"), 5);
  episodes.observe(PR, conflicting("B", "develop"), 9);
  episodes.observe(PR, conflicting("C", "develop"), 12);
  assert.deepEqual(episodes.list(), [{ url: PR, since: 5, baseRef: "develop", headSha: "C", escalated: false, escalatedHead: null }]);
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
  assert.equal(unhandledReason(ref([]), policy()), "session-gone");
  const exited = mkSession({ cwd: "/wt/app", state: "exited" });
  assert.equal(unhandledReason(ref([exited]), policy()), "session-gone", "an exited owner is not live");
});

test("foreman-cannot-nudge covers every case Foreman's follow-through refuses to type", () => {
  const live = mkSession({ cwd: "/wt/app", state: "idle" });
  assert.equal(unhandledReason(ref([live]), policy()), null, "Foreman drives this one");
  const cases: Array<[string, ReturnType<typeof mkSession>, ReturnType<typeof policy>]> = [
    ["trackMergeConflicts off", live, policy({ trackMergeConflicts: false })],
    ["not invited", { ...live, foremanInvite: null }, policy()],
    ["dry-run", live, policy({ mode: "dry-run" })],
    ["Foreman off", live, policy({ enabled: false })],
    ["not allowlisted", { ...live, cwd: "/elsewhere" }, policy()],
    ["no hooks", { ...live, hooksSeen: false }, policy()],
  ];
  for (const [why, session, p] of cases) {
    assert.equal(unhandledReason(ref([session]), p), "foreman-cannot-nudge", why);
  }
});

test("work an active workflow owns is not reported here, live or not", () => {
  const live = mkSession({ cwd: "/wt/app", state: "idle", foremanInvite: null });
  assert.equal(unhandledReason(ref([live], true), policy()), null);
  const exited = mkSession({ cwd: "/wt/app", state: "exited" });
  assert.equal(unhandledReason(ref([exited], true), policy()), null, "not session-gone");
  assert.equal(unhandledReason(ref([], true), policy()), null, "nor once the session is removed");
});

/**
 * A PR poll against a real registry, with `gh` stood in for. With `task`, the session is a
 * task's agent and the PR binds to that task's work episode, as a dispatch leaves it.
 */
function harness({ task = false }: { task?: boolean } = {}) {
  const reg = new Registry();
  reg.applyDiscovery([
    {
      syntheticId: "live",
      agent: "claude",
      name: "the agent",
      nameSource: "process",
      cwd: "/wt/app",
      gitBranch: "feat/x",
      gitRoot: null,
      repoRoot: null,
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
  const tracker = new PrConflictTracker(reg, () => LIVE);
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

test("a conflict in a session an active workflow owns raises no blocked row", async () => {
  const h = harness();
  h.reg.upsertWorkflowRun({ id: "owner", status: "running", sessionId: "live", noteKey: "live" } as WorkflowRunSummary);
  await h.poll();
  assert.deepEqual(h.tracker.episodes.urls(), [PR], "the episode is open");
  assert.equal(h.frames.length, 0, "but nothing is blocked");
});

test("a workflow run still active after its agent exits keeps the conflict out of the inbox", async (t) => {
  const h = harness({ task: true });
  // Bound by note key, as a workflow binding is: the run outlives the session it drove.
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
  // `orphanBinding` nulls the run's session id; the note key and the task's binding remain.
  h.reg.upsertWorkflowRun({ id: "step", status: "blocked", sessionId: null, noteKey: "live-episode" } as WorkflowRunSummary);
  await h.poll();
  assert.equal(h.frames.length, 0, "and after removal, through the task's work-episode binding");
  assert.deepEqual(h.tracker.episodes.urls(), [PR], "the episode itself stays open");

  // Once the run is over, nothing owns the work, and the conflict is the operator's.
  h.reg.upsertWorkflowRun({ id: "step", status: "failed", sessionId: null, noteKey: "live-episode" } as WorkflowRunSummary);
  await h.poll();
  assert.equal(h.frames.at(-1)![0]!.reason, "session-gone");
});

// ---- Foreman's escalation ----

const { buildApp } = await import("../src/server/routes.ts");
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

test("escalating on head 4, after nudges on heads 1 to 3, marks the open episode escalated", () => {
  const episodes = new PrConflictEpisodes();
  for (const [i, head] of ["A", "B", "C", "D"].entries()) episodes.observe(PR, conflicting(head), i);
  assert.equal(episodes.escalate(PR, "D"), true, "found by URL alone, whichever head it opened on");
  assert.deepEqual(episodes.list(), [
    { url: PR, since: 0, baseRef: "main", headSha: "D", escalated: true, escalatedHead: "D" },
  ]);
  assert.deepEqual([...episodes.escalatedUrls()], [PR]);

  episodes.observe(PR, conflicting("E"), 9);
  assert.equal(episodes.list()[0]!.escalated, true, "a later conflicting head keeps it escalated");
  assert.equal(episodes.escalate(PR, "E"), true, "and a re-send is idempotent");
});

test("an escalation with no open episode for the URL is ignored", () => {
  const episodes = new PrConflictEpisodes();
  assert.equal(episodes.escalate(PR, "A"), false);
  assert.deepEqual(episodes.list(), [], "it opens nothing");

  episodes.observe(PR, conflicting("A"), 1);
  episodes.observe(PR, { state: "open", mergeable: "mergeable", baseRef: "main", headSha: "B" }, 2);
  assert.equal(episodes.escalate(PR, "A"), false, "nor reaches a closed one");
});

test("the escalation lives and dies with its episode: a mergeable read re-arms it", () => {
  const episodes = new PrConflictEpisodes();
  episodes.observe(PR, conflicting("A"), 1);
  episodes.escalate(PR, "A");
  episodes.observe(PR, { state: "open", mergeable: "mergeable", baseRef: "main", headSha: "B" }, 2);
  episodes.observe(PR, conflicting("C"), 3);
  assert.equal(episodes.list()[0]!.escalated, false, "a new episode starts un-escalated");
});

test("nudges-exhausted: a live owner whose episode Foreman escalated", () => {
  const live = mkSession({ id: "live", state: "idle", foremanInvite: "dispatch", cwd: "/wt/app" });
  assert.equal(unhandledReason(ref([live]), LIVE, true), "nudges-exhausted");
  assert.equal(unhandledReason(ref([live]), LIVE, false), null, "un-escalated, Foreman is handling it");
  const exited = mkSession({ id: "gone", state: "exited", cwd: "/wt/app" });
  assert.equal(unhandledReason(ref([exited]), LIVE, true), "session-gone", "an ended session outranks it");
  assert.equal(unhandledReason(ref([live], true), LIVE, true), null, "and a workflow still owns its own");
});

test("an escalation is published at once: the row reads nudges-exhausted and the snapshot carries the flag", async () => {
  const h = harness();
  await h.poll();
  assert.equal(h.reg.getSession("live")!.prConflictEscalated, false);
  const before = h.frames.length;

  assert.equal(h.tracker.escalate(PR, "A"), true);
  assert.equal(h.frames.length, before + 1, "published without waiting for the next tick");
  assert.equal(h.frames.at(-1)![0]!.reason, "nudges-exhausted");
  assert.equal(h.reg.getSession("live")!.prConflictEscalated, true, "Foreman reads it off the snapshot");

  await h.poll();
  assert.equal(h.frames.at(-1)![0]!.reason, "nudges-exhausted", "and the next tick keeps it");

  h.setBranch("mergeable");
  await h.poll();
  assert.deepEqual(h.frames.at(-1), [], "the fix clears the row");
  assert.equal(h.reg.getSession("live")!.prConflictEscalated, false, "and re-arms the flag");
});

test("a restarted daemon is re-marked nudges-exhausted by Foreman's re-send", async () => {
  const h = harness();
  await h.poll();
  // A fresh tracker: what the daemon holds after a restart, with the episode re-derived from
  // the first poll and no memory of the escalation.
  const restarted = new PrConflictTracker(h.reg, () => LIVE);
  await pollAndReconcilePrs(
    h.reg,
    async () => ({
      url: PR, number: 42, state: "open" as const, checks: null, createdAt: Date.now(),
      mergedAt: null, headSha: "A", worktreeHeadSha: "A", mergeable: "conflicting", baseRef: "main",
    }),
    async () => null,
    new PrUrlPollState(),
    Date.now(),
    async () => null,
    () => [],
    restarted,
  );
  assert.equal(h.frames.at(-1)![0]!.reason, "foreman-cannot-nudge");
  assert.equal(restarted.escalate(PR, "A"), true, "the re-send lands on the re-derived episode");
  assert.equal(h.frames.at(-1)![0]!.reason, "nudges-exhausted");
});

test("POST /api/pr-conflicts/escalate marks the open episode, ignores an unknown one, and validates its body", async () => {
  const h = harness();
  await h.poll();
  const app = buildApp({
    registry: h.reg,
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
    prConflicts: h.tracker,
  });
  const headers = { host: "127.0.0.1:7317", "content-type": "application/json" };
  const post = (body: unknown) =>
    app.request("/api/pr-conflicts/escalate", { method: "POST", headers, body: JSON.stringify(body) });

  const unknown = await post({ prUrl: "https://github.com/o/r/pull/999", headSha: "A" });
  assert.equal(unknown.status, 200);
  assert.deepEqual(await unknown.json(), { ok: true, escalated: false });
  assert.equal(h.frames.at(-1)![0]!.reason, "foreman-cannot-nudge", "nothing moved");

  const marked = await post({ prUrl: PR, headSha: "D" });
  assert.deepEqual(await marked.json(), { ok: true, escalated: true });
  assert.equal(h.frames.at(-1)![0]!.reason, "nudges-exhausted");

  assert.equal((await post({ prUrl: PR })).status, 400, "headSha is required");
  assert.equal((await post({ prUrl: "", headSha: "A" })).status, 400, "and prUrl must be non-empty");

  const untracked = buildApp({
    registry: h.reg,
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
  });
  const refused = await untracked.request("/api/pr-conflicts/escalate", {
    method: "POST",
    headers,
    body: JSON.stringify({ prUrl: PR, headSha: "A" }),
  });
  assert.equal(refused.status, 503, "a daemon without the tracker says so");
});
