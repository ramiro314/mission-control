import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkTask } from "./helpers/session-fixture.ts";
import type { PlanDecision, PlanDecisionAnswer } from "../src/shared/types.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-shape-reapproval-")));
process.env.MISSION_HOME = join(home, "state");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { closeDb, openDb } = await import("../src/server/db.ts");
const { savePlan } = await import("../src/server/plans/store.ts");
const { planAuthority } = await import("../src/server/plans/authority.ts");
const managers: InstanceType<typeof WorkflowManager>[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.stop(); });
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const followUp: PlanDecision = {
  id: "shape-follow-up",
  question: "What should happen after this plan is approved?",
  options: [{ id: "create-tickets", label: "Create tickets after the plan merges", recommended: true }, { id: "stop", label: "Stop" }],
};
const approveWith = (choice: string, approval = "approve"): PlanDecisionAnswer[] => [
  { decisionId: "shape-follow-up", selected: [choice], other: null },
  { decisionId: "approve-final-bundle", selected: [approval], other: null },
];

async function fixture({ kind = "shape", storage = "repository", invited = true }: { kind?: "shape" | "plan"; storage?: "repository" | "local"; invited?: boolean } = {}) {
  const id = randomUUID(), repo = join(home, id);
  mkdirSync(repo); git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial");
  const registry = new Registry();
  registry.applyDiscovery([{ syntheticId: id, agent: "claude", name: id, nameSource: "process", cwd: repo, gitRoot: repo, repoRoot: repo, gitBranch: "main", pid: 1, tty: null, terminals: [], startedAt: 1 }]);
  registry.applyHook({ agent: "claude", event: "Stop", sessionId: id, cwd: repo, transcriptPath: null, env: {} });
  if (invited) registry.inviteForeman(id);
  const task = mkTask({ id: `task-${id}`, kind, status: "running", sessionId: id, repoRoot: repo, worktreePath: repo, baseSha: git(repo, "rev-parse", "HEAD"), workflowId: null,
    planPolicy: storage === "local" ? { version: 2, storage, commitPlanHtml: false } : { storage, commitPlanHtml: false }, planInputs: [] });
  registry.upsertTask(task);
  const personas = new PersonaManager(registry), workflows = new WorkflowManager(registry, personas.store);
  managers.push(workflows);
  const reviews = new ReviewManager(registry);
  const app = buildApp({ registry, workflows, personas, tasks: new TaskManager(registry), reviews, queues: new QueueManager(registry) });
  const authority = planAuthority(registry, registry.getSession(id)!, "repo-01");
  const files = (title: string) => [{ name: "plan.md", content: `# ${title}` }, { name: "plan.html", content: `<h1>${title}</h1>` }];
  const first = await savePlan(authority, { repoSlot: "repo-01", requestId: randomUUID(), slug: "pack-import", expectedRevision: 0, files: files("Revision 1") });
  const planId = first.manifest.planId;
  const save = (revision: number) => savePlan(planAuthority(registry, registry.getSession(id)!, "repo-01"),
    { repoSlot: "repo-01", requestId: randomUUID(), slug: "pack-import", planId, expectedRevision: revision - 1, files: files(`Revision ${revision}`) });
  const ask = async (revision: number, decisions: PlanDecision[] = [followUp]) => {
    const res = await app.request("/mcp/v2/reviews", { method: "POST", headers: { host: "127.0.0.1:7317", "content-type": "application/json", "x-harness-token": ensureToken() },
      body: JSON.stringify({ env: {}, sessionId: id, cwd: repo, kind: "plan-decisions", title: `Revision ${revision}`, body: "Review the plan.", decisions, managedPlan: { repoSlot: "repo-01", planId, revision } }) });
    assert.equal(res.status, 200, await res.clone().text());
    return registry.getReview(((await res.json()) as { id: string }).id)!;
  };
  // A redispatch: the same session and task start a new work episode, as `resetWorkEpisode` does.
  const newEpisode = () => {
    registry.resetWorkEpisode(id);
    registry.upsertTask({ ...task, status: "running" });
    registry.bindTaskToWorkEpisode(task.id, id);
  };
  return { registry, reviews, save, ask, planId, newEpisode };
}

test("after the human approves a shape plan, Foreman approves later revisions with the same answers", async () => {
  const f = await fixture();
  const first = await f.ask(1);
  assert.equal(first.status, "pending", "the first approval is the human's");
  f.reviews.resolve(first.id, "answer", null, "human", approveWith("create-tickets"));
  await f.save(2);
  const second = await f.ask(2);
  assert.equal(second.status, "answered");
  assert.equal(second.resolvedBy, "foreman");
  assert.deepEqual(second.selections, approveWith("create-tickets"));
  assert.match(second.response!, /^Foreman approved revision 2 on the operator's behalf, carrying forward their approval of revision 1\./);
  assert.match(second.response!, /Create tickets after the plan merges/);
  assert.equal(f.registry.pendingReviews().length, 0, "nothing is left for the human to answer");
  // A repository plan publishes by merging its pull request; no publication gate reads this
  // approval (`publish_plan` and `readiness` serve local plans only). What the review cycle
  // does need is the carried answer bound to the exact revision it approved, as a human's is.
  assert.deepEqual(openDb().prepare("SELECT review_id, revision FROM managed_plan_reviews WHERE plan_id = ? ORDER BY revision").all(f.planId)
    .map((row) => ({ ...row })), [{ review_id: first.id, revision: 1 }, { review_id: second.id, revision: 2 }]);
  await f.save(3);
  const third = await f.ask(3);
  assert.equal(third.resolvedBy, "foreman", "a Foreman approval never replaces the human's as the carried source");
  assert.match(third.response!, /carrying forward their approval of revision 1\./);
});

test("the human still answers a new question, a refusal, or a plan Foreman may not act on", async () => {
  const newQuestion = await fixture();
  newQuestion.reviews.resolve((await newQuestion.ask(1)).id, "answer", null, "human", approveWith("create-tickets"));
  await newQuestion.save(2);
  const scope: PlanDecision = { id: "scope", question: "Include exports?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] };
  assert.equal((await newQuestion.ask(2, [scope, followUp])).status, "pending", "a question the human never answered");
  const changedOptions = await fixture();
  changedOptions.reviews.resolve((await changedOptions.ask(1)).id, "answer", null, "human", approveWith("create-tickets"));
  await changedOptions.save(2);
  assert.equal((await changedOptions.ask(2, [{ ...followUp, options: [...followUp.options, { id: "phase", label: "Phase it" }] }])).status, "pending", "changed options");
  const reworded = await fixture();
  reworded.reviews.resolve((await reworded.ask(1)).id, "answer", null, "human", approveWith("create-tickets"));
  await reworded.save(2);
  assert.equal((await reworded.ask(2, [{ ...followUp, question: "What should happen after this plan merges?" }])).status, "pending", "same option ids, reworded question");

  const qualified = await fixture();
  qualified.reviews.resolve((await qualified.ask(1)).id, "answer", null, "human",
    [approveWith("create-tickets")[0]!, { decisionId: "approve-final-bundle", selected: ["approve"], other: "Only if exports stay out" }]);
  await qualified.save(2);
  assert.equal((await qualified.ask(2)).status, "pending", "an approval with Other text is not a plain approval");

  const redispatched = await fixture();
  redispatched.reviews.resolve((await redispatched.ask(1)).id, "answer", null, "human", approveWith("create-tickets"));
  redispatched.newEpisode();
  await redispatched.save(2);
  const nextEpisode = await redispatched.ask(2);
  assert.equal(nextEpisode.status, "pending", "an earlier work episode's approval never authorizes a new episode's revision");
  assert.equal(nextEpisode.resolvedBy, null);

  const refused = await fixture();
  refused.reviews.resolve((await refused.ask(1)).id, "answer", null, "human", approveWith("create-tickets"));
  await refused.save(2);
  refused.reviews.resolve((await refused.ask(2, [followUp, { ...followUp, id: "note", question: "Anything else?" }])).id, "answer", null, "human", approveWith("create-tickets", "revise"));
  await refused.save(3);
  assert.equal((await refused.ask(3)).status, "pending", "the human's latest answer asked for revision");

  const dismissed = await fixture();
  dismissed.reviews.resolve((await dismissed.ask(1)).id, "dismiss", null, "human");
  await dismissed.save(2);
  assert.equal((await dismissed.ask(2)).status, "pending", "a dismissal is not approval");

  for (const options of [{ invited: false }, { kind: "plan" as const }, { storage: "local" as const }]) {
    const f = await fixture(options);
    f.reviews.resolve((await f.ask(1)).id, "answer", null, "human", approveWith("create-tickets"));
    await f.save(2);
    assert.equal((await f.ask(2)).status, "pending", JSON.stringify(options));
  }
});
