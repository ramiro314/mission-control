import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// What is at stake: the repository action starts an agent that edits CI, and its one tool writes
// a Command the daemon will EXECUTE in every later affected-tests gate. So the start refuses
// before creating anything when the skill that carries the approval step is off, and the tool
// can reach exactly one slot of exactly one repository: the calling testing-setup task's own.

const home = mkdtempSync(join(tmpdir(), "mission-testing-setup-http-"));
const repos = mkdtempSync(join(tmpdir(), "mission-testing-setup-repos-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { WorkflowCommandManager } = await import("../src/server/workflows/commands.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { setSkillsConfig } = await import("../src/server/skills/config.ts");
const { skillsDirFor } = await import("../src/server/skills/reconcile.ts");
const { CLAUDE_SKILLS } = await import("../src/shared/harness-capabilities.ts");
const { TESTING_SETUP_SKILL, missionSkillDirName } = await import("../src/shared/skills.ts");
const { SET_AFFECTED_TESTS_COMMAND_TOOL, TESTING_SETUP_STORED_LABEL, TESTING_SETUP_TASK_LABEL } = await import("../src/server/testing-setup-tool.ts");
const { PLAN_DECISIONS_TOOL } = await import("../src/server/plans/tools.ts");
const { PROPOSE_COMMAND_DOCUMENT_TOOL } = await import("../src/server/command-document-proposals.ts");
const { testingSetupModeLine } = await import("../src/server/testing-setup.ts");
const { MISSION_MCP_TOOLS } = await import("../src/server/mission-mcp.ts");

type Task = import("../src/shared/types.ts").Task;
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

const db = openDb();
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repos, { recursive: true, force: true });
});

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };
const TEMPLATE = ["npx", "vitest", "run", "--reporter=junit", "--outputFile={junit}", "{files}"];

function installSkill(): void {
  const dir = skillsDirFor(CLAUDE_SKILLS);
  mkdirSync(dir, { recursive: true });
  try {
    symlinkSync(join(process.cwd(), "skills", TESTING_SETUP_SKILL), join(dir, missionSkillDirName(TESTING_SETUP_SKILL)), "dir");
  } catch {
    // Linked by an earlier case.
  }
}

let serial = 0;
function gitRepo(name: string): string {
  const dir = join(repos, `${name}-${serial}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q"]);
  return realpathSync(dir);
}

function fixture() {
  serial += 1;
  clearWorkflowTables(db);
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const commands = new WorkflowCommandManager(registry, new WorkflowStore(db));
  const launches: Array<{ id: string; tools: readonly string[] | undefined }> = [];
  tasks.dispatch = async (id, options) => {
    launches.push({ id, tools: options?.missionMcp?.tools });
    const current = tasks.get(id)!;
    registry.upsertTask({ ...current, status: "dispatching", updatedAt: Date.now() });
    return { ok: true as const, task: tasks.get(id)! };
  };
  const app = buildApp({
    registry,
    reviews: {} as ReviewManager,
    tasks,
    queues: {} as QueueManager,
    workflowCommands: commands,
  });
  return { registry, tasks, commands, app, launches };
}

/** Start a setup in `mode`; `null` sends no mode at all, as a caller from before the choice would. */
async function start(app: ReturnType<typeof fixture>["app"], repoRoot: string, mode: string | null = "committed") {
  return app.request("/api/repositories/testing-setup", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(mode === null ? { repoRoot } : { repoRoot, mode }),
  });
}

test("with the skill off, the start is refused with the skill sentence and nothing is created", async () => {
  installSkill();
  setSkillsConfig({ enabled: true, skills: { [TESTING_SETUP_SKILL]: false } });
  const f = fixture();
  const repo = gitRepo("off");
  const before = f.tasks.list().length;

  const response = await start(f.app, repo);
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /^Enable Skills and the testing-setup skill before sending this instruction\./);
  assert.match(body.error, /cannot load the procedure its intent names/);
  assert.equal(f.tasks.list().length, before, "a refused start files no task");
  assert.equal(f.launches.length, 0);
});

test("with the skill on, one ship task invoking the skill is created and launched with its two tools", async () => {
  installSkill();
  setSkillsConfig({ enabled: true, skills: { [TESTING_SETUP_SKILL]: true } });
  const f = fixture();
  const repo = gitRepo("on");

  const response = await start(f.app, repo);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { task: Task; launched: boolean };
  assert.equal(body.launched, true);
  assert.equal(body.task.kind, "ship");
  assert.equal(body.task.repoRoot, repo);
  assert.equal(body.task.workflowId, null, "the skill owns its pull request; no review workflow is bound");
  assert.deepEqual(body.task.labels, [TESTING_SETUP_TASK_LABEL]);
  assert.match(body.task.intent, /Invoke the testing-setup skill and follow it/);
  assert.match(body.task.intent, /Change nothing\s+the human did not approve/);
  assert.match(body.task.intent, /has no affected-tests Command for this repository yet/);
  assert.ok(body.task.intent.includes(testingSetupModeLine("committed")), "the prompt carries the committed choice");
  assert.doesNotMatch(body.task.intent, new RegExp(PROPOSE_COMMAND_DOCUMENT_TOOL));
  assert.equal(body.task.title, `Set up flake-aware testing: ${basename(repo)}`);
  assert.deepEqual(f.launches, [{ id: body.task.id, tools: [PLAN_DECISIONS_TOOL, SET_AFFECTED_TESTS_COMMAND_TOOL] }]);
  assert.ok((MISSION_MCP_TOOLS as readonly string[]).includes(SET_AFFECTED_TESTS_COMMAND_TOOL));
});

test("the stored choice launches a no-commit setup that proposes a Command document, and only that tool", async () => {
  installSkill();
  setSkillsConfig({ enabled: true, skills: { [TESTING_SETUP_SKILL]: true } });
  const f = fixture();
  const repo = gitRepo("stored");
  // The repository's own root and app overrides are listed for the agent; another repository's,
  // and a sibling whose path merely starts with the same characters, are not.
  const seeded = f.commands.replace("affected-tests", {
    expectedRevision: 1,
    defaultCommand: null,
    maxRuns: 1,
    overrides: [
      { repoRoot: `${repo}/apps/web`, command: ["yarn", "vitest", "--outputFile={junit}", "{files}"] },
      { repoRoot: repo, command: ["npm", "test", "--", "--junit={junit}", "{files}"] },
      { repoRoot: `${repo}-sibling`, command: ["sibling", "{files}", "{junit}"] },
      { repoRoot: "/elsewhere", command: ["other", "{files}", "{junit}"] },
    ],
  });
  assert.ok(seeded.ok);

  const response = await start(f.app, repo, "stored");
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as { task: Task; launched: boolean };
  assert.equal(body.launched, true);
  assert.equal(body.task.kind, "ship");
  assert.equal(body.task.workflowId, null);
  assert.deepEqual(body.task.labels, [TESTING_SETUP_TASK_LABEL, TESTING_SETUP_STORED_LABEL]);
  assert.equal(body.task.title, `Set up flake-aware testing (stored): ${basename(repo)}`);

  const intent = body.task.intent;
  assert.ok(intent.includes(testingSetupModeLine("stored")), "the prompt carries the stored choice");
  assert.match(intent, /Invoke the testing-setup skill and follow its stored mode/);
  assert.match(intent, /change no file in this repository and make no commit/);
  assert.match(intent, new RegExp(`Submit the result only with ${PROPOSE_COMMAND_DOCUMENT_TOOL}`));
  assert.match(intent, new RegExp(`Do not call ${SET_AFFECTED_TESTS_COMMAND_TOOL}\\.`));
  assert.match(intent, /- \(repository root\): npm test -- --junit=\{junit\} \{files\}\n- apps\/web: yarn vitest/);
  assert.doesNotMatch(intent, /sibling|elsewhere/);

  // No decision form and no direct Command write: the proposal and its preview are the approval.
  assert.deepEqual(f.launches, [{ id: body.task.id, tools: [PROPOSE_COMMAND_DOCUMENT_TOOL] }]);
  assert.ok((MISSION_MCP_TOOLS as readonly string[]).includes(PROPOSE_COMMAND_DOCUMENT_TOOL));

  // One setup per repository whichever mode it runs in: a committed start is refused meanwhile.
  const committed = await start(f.app, repo, "committed");
  assert.equal(committed.status, 409);
  assert.equal(f.launches.length, 1);
});

test("a start that does not name a mode, or names an unknown one, is refused before anything is filed", async () => {
  installSkill();
  setSkillsConfig({ enabled: true, skills: { [TESTING_SETUP_SKILL]: true } });
  const f = fixture();
  const repo = gitRepo("no-mode");
  const before = f.tasks.list().length;

  const missing = await start(f.app, repo, null);
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /mode/);
  assert.equal((await start(f.app, repo, "local")).status, 400);

  assert.equal(f.tasks.list().length, before, "neither refusal files a task");
  assert.equal(f.launches.length, 0);
});

test("a path that is not a repository is refused before the skill is even asked", async () => {
  const f = fixture();
  const before = f.tasks.list().length;
  const response = await start(f.app, join(repos, "missing"));
  assert.equal(response.status, 400);
  assert.equal(f.tasks.list().length, before);
});

test("a launch refused after creation keeps the task in the backlog and says why", async () => {
  installSkill();
  setSkillsConfig({ enabled: true, skills: { [TESTING_SETUP_SKILL]: true } });
  const f = fixture();
  f.tasks.dispatch = async (id) => ({ ok: false as const, error: "no free worktree", task: f.tasks.get(id)! });
  const response = await start(f.app, gitRepo("queued"));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { task: Task; launched: boolean; reason: string };
  assert.equal(body.launched, false);
  assert.equal(body.reason, "no free worktree");
  assert.equal(f.tasks.get(body.task.id)?.status, "backlog");
});

let sessions = 0;

/** A running task with a live session in its worktree, as the MCP route resolves one. */
function runningSession(
  f: ReturnType<typeof fixture>,
  repoRoot: string,
  labels: string[],
): { payload: { env: Record<string, never>; sessionId: string; cwd: string } } {
  const task = f.tasks.create({
    repoRoot,
    title: "setup",
    intent: "set up",
    kind: "ship",
    agent: "claude",
    workflowId: null,
    backlog: true,
    labels,
  });
  sessions += 1;
  const worktreePath = join(repos, `wt-${sessions}`);
  const sessionId = `sdk:setup:${sessions}`;
  f.registry.upsertTask({ ...task, status: "running", worktreePath, sessionId, updatedAt: Date.now() });
  f.registry.registerSdkSession({
    id: sessionId,
    agent: "claude",
    name: "setup",
    cwd: worktreePath,
    agentSessionId: `agent:${sessionId}`,
  });
  return { payload: { env: {}, sessionId: `agent:${sessionId}`, cwd: worktreePath } };
}

async function setCommand(f: ReturnType<typeof fixture>, body: unknown, token = true) {
  return f.app.request("/mcp/workflow-commands/affected-tests", {
    method: "POST",
    headers: token ? { ...HEADERS, "x-harness-token": ensureToken() } : HEADERS,
    body: JSON.stringify(body),
  });
}

test("the tool sets only the session repository's affected-tests override, keeping every other entry", async () => {
  const f = fixture();
  const repo = gitRepo("mcp");
  // Another repository's override, a default, and another slot, all of which must survive.
  const seeded = f.commands.replace("affected-tests", {
    expectedRevision: 1,
    defaultCommand: ["run-default", "{files}", "{junit}"],
    maxRuns: 2,
    overrides: [{ repoRoot: "/elsewhere", command: ["other", "{files}", "--junit={junit}"] }],
  });
  assert.ok(seeded.ok);
  const testBefore = f.commands.get("test");
  const { payload } = runningSession(f, repo, [TESTING_SETUP_TASK_LABEL]);

  assert.equal((await setCommand(f, { ...payload, command: TEMPLATE }, false)).status, 401);

  const response = await setCommand(f, { ...payload, command: TEMPLATE });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { repoRoot: repo, command: TEMPLATE, replayed: false });

  const view = f.commands.get("affected-tests")!;
  assert.deepEqual(view.defaultCommand, ["run-default", "{files}", "{junit}"]);
  assert.equal(view.maxRuns, 2);
  assert.deepEqual(view.overrides, [
    { repoRoot: "/elsewhere", command: ["other", "{files}", "--junit={junit}"] },
    { repoRoot: repo, command: TEMPLATE },
  ]);
  assert.deepEqual(f.commands.get("test"), testBefore, "no other slot moves");

  const replay = await setCommand(f, { ...payload, command: TEMPLATE });
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { replayed: boolean }).replayed, true);
  assert.equal(f.commands.get("affected-tests")!.revision, view.revision, "a replay writes nothing");
});

test("the tool refuses a named slot or repository, a session that is not a testing setup, and a bad template", async () => {
  const f = fixture();
  const repo = gitRepo("refusals");
  const { payload } = runningSession(f, repo, [TESTING_SETUP_TASK_LABEL]);
  const before = f.commands.get("affected-tests")!;

  // The body has no slot or repository to name: a caller that tries is refused outright.
  assert.equal((await setCommand(f, { ...payload, command: TEMPLATE, slot: "test" })).status, 400);
  assert.equal((await setCommand(f, { ...payload, command: TEMPLATE, repoRoot: "/elsewhere" })).status, 400);

  const missingFiles = await setCommand(f, { ...payload, command: ["npx", "vitest", "--outputFile={junit}"] });
  assert.equal(missingFiles.status, 400);
  assert.match(((await missingFiles.json()) as { error: string }).error, /exactly \{files\}/);
  const missingJunit = await setCommand(f, { ...payload, command: ["npx", "vitest", "{files}"] });
  assert.equal(missingJunit.status, 400);
  assert.match(((await missingJunit.json()) as { error: string }).error, /\{junit\}/);

  const other = runningSession(f, gitRepo("ordinary"), ["bug"]);
  const ordinary = await setCommand(f, { ...other.payload, command: TEMPLATE });
  assert.equal(ordinary.status, 403);
  assert.match(((await ordinary.json()) as { error: string }).error, /only to a session running a testing-setup task/);

  // A stored-mode setup proposes its Commands; it never writes one through this tool.
  const stored = runningSession(f, gitRepo("stored-tool"), [TESTING_SETUP_TASK_LABEL, TESTING_SETUP_STORED_LABEL]);
  const storedWrite = await setCommand(f, { ...stored.payload, command: TEMPLATE });
  assert.equal(storedWrite.status, 403);
  assert.match(((await storedWrite.json()) as { error: string }).error, /not available to a stored testing setup/);

  const unknown = await setCommand(f, { env: {}, sessionId: "agent:nobody", cwd: "/nowhere", command: TEMPLATE });
  assert.equal(unknown.status, 404);

  assert.deepEqual(f.commands.get("affected-tests"), before, "no refusal wrote anything");
});

test("a second start is refused while the repository's setup task is open, and allowed once it is finished", async () => {
  installSkill();
  setSkillsConfig({ enabled: true, skills: { [TESTING_SETUP_SKILL]: true } });
  const f = fixture();
  const repo = gitRepo("duplicate");

  const first = await start(f.app, repo);
  assert.equal(first.status, 200);
  const { task } = (await first.json()) as { task: Task };
  const count = f.tasks.list().length;

  const second = await start(f.app, repo);
  assert.equal(second.status, 409);
  assert.match(((await second.json()) as { error: string }).error, /already open .*Finish or cancel it before starting another/);
  assert.equal(f.tasks.list().length, count, "the refused start files no second task");
  assert.equal(f.launches.length, 1, "and launches no second agent");

  // Another repository is not blocked by it.
  assert.equal((await start(f.app, gitRepo("duplicate-other"))).status, 200);

  // Once the first one is finished, running the setup again is allowed.
  f.registry.upsertTask({ ...f.tasks.get(task.id)!, status: "done", updatedAt: Date.now() });
  assert.equal((await start(f.app, repo)).status, 200);
});
