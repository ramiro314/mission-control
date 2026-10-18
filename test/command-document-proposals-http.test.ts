import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CommandDocumentApplied,
  CommandDocumentPreview,
  CommandDocumentProposal,
  CommandDocumentProposed,
} from "../src/shared/command-document.ts";

// `propose_command_document` over its real route, and the two ways a proposal leaves. What is at
// stake: a proposal writes no live row, only the calling session's own task repository can be
// proposed for, applying the reviewed proposal clears it while a newer one survives an apply of
// the older, and every change reaches the browser as one `command_document_proposals` frame.

const home = mkdtempSync(join(tmpdir(), "mission-command-document-proposals-http-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { WorkflowCommandManager } = await import("../src/server/workflows/commands.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { TestingSettingsCatalog } = await import("../src/server/testing-settings.ts");
const { CommandDocumentProposals } = await import("../src/server/command-document-proposals.ts");

type QueueManager = import("../src/server/queue.ts").QueueManager;
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type ServerEvent = import("../src/shared/types.ts").ServerEvent;

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

function repository(): string {
  const root = realpathSync(mkdtempSync(join(home, "repo-")));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "apps", "web"), { recursive: true });
  return root;
}

function fixture() {
  clearWorkflowTables(db);
  const registry = new Registry();
  const store = new WorkflowStore(db);
  const tasks = new TaskManager(registry);
  const commands = new WorkflowCommandManager(registry, store);
  const testing = new TestingSettingsCatalog(store);
  const proposals = new CommandDocumentProposals(store, (set) => registry.setCommandDocumentProposals(set));
  const frames: CommandDocumentProposal[][] = [];
  registry.on("event", (event: ServerEvent) => {
    if (event.type === "command_document_proposals") frames.push(event.proposals);
  });
  const app = buildApp({
    registry,
    reviews: {} as ReviewManager,
    tasks,
    queues: {} as QueueManager,
    workflowCommands: commands,
    testingSettings: testing,
    commandDocumentProposals: proposals,
  });
  const post = (path: string, value: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { ...HEADERS, ...headers }, body: JSON.stringify(value) });
  return { registry, tasks, commands, testing, proposals, frames, post };
}

let sessions = 0;

/** A running task with a live session in its worktree, as `findSessionByEnv` resolves one. */
function runningSession(f: ReturnType<typeof fixture>, repoRoot: string) {
  const task = f.tasks.create({
    repoRoot,
    title: "Configure the monorepo",
    intent: "configure it",
    kind: "ship",
    agent: "claude",
    workflowId: null,
    backlog: true,
    labels: [],
  });
  sessions += 1;
  const worktreePath = join(home, `wt-${sessions}`);
  const sessionId = `sdk:propose:${sessions}`;
  f.registry.upsertTask({ ...task, status: "running", worktreePath, sessionId, updatedAt: Date.now() });
  f.registry.registerSdkSession({
    id: sessionId,
    agent: "claude",
    name: "proposer",
    cwd: worktreePath,
    agentSessionId: `agent:${sessionId}`,
  });
  return { env: {}, sessionId: `agent:${sessionId}`, cwd: worktreePath };
}

function propose(f: ReturnType<typeof fixture>, body: unknown, token = true) {
  return f.post("/mcp/command-documents/proposals", body, token ? { "x-harness-token": ensureToken() } : {});
}

const DOCUMENT = {
  version: 1,
  commands: { lint: [{ path: "apps/web", argv: ["yarn", "workspace", "web", "lint"] }] },
  testing: [{ path: "apps/web", settings: { tests: { patterns: ["src/**/*.test.ts"] } } }],
};

test("a proposal stores the document for the session's repository, writes no live row, and answers the preview", async () => {
  const f = fixture();
  const repo = repository();
  const lintBefore = f.commands.get("lint")!;
  const response = await propose(f, { ...runningSession(f, repo), document: DOCUMENT });
  assert.equal(response.status, 200);
  const body = (await response.json()) as CommandDocumentProposed;
  assert.equal(body.proposal.repoRoot, repo);
  assert.equal(body.replaced, null);
  assert.deepEqual(body.preview.commands.map((change) => [change.slot, change.path, change.kind]), [["lint", "apps/web", "add"]]);
  assert.deepEqual(body.preview.testing.map((change) => [change.path, change.kind]), [["apps/web", "add"]]);

  assert.deepEqual(f.commands.get("lint"), lintBefore, "no Command row was written");
  assert.deepEqual(f.testing.list(), [], "no testing settings row was written");
  assert.deepEqual(f.proposals.list().map((entry) => [entry.repoRoot, entry.id, entry.taskTitle, entry.sessionName]), [
    [repo, body.proposal.id, "Configure the monorepo", "proposer"],
  ]);
  assert.deepEqual(f.frames.at(-1)?.map((entry) => entry.id), [body.proposal.id], "the browser hears of it");
  assert.deepEqual(f.registry.snapshot().commandDocumentProposals.map((entry) => entry.id), [body.proposal.id]);
});

test("the route refuses another repository, a call with no token, and an invalid document, storing nothing", async () => {
  const f = fixture();
  const repo = repository();
  const other = repository();
  const session = runningSession(f, repo);

  const elsewhere = await propose(f, { ...session, repository: other, document: DOCUMENT });
  assert.equal(elsewhere.status, 403);
  assert.equal(((await elsewhere.json()) as { code: string }).code, "command_document_proposal_refused");

  assert.equal((await propose(f, { ...session, document: DOCUMENT }, false)).status, 401);

  const invalid = await propose(f, { ...session, document: { version: 1, commands: { lint: [{ path: "/abs", argv: ["x"] }] }, maxRuns: 3 } });
  assert.equal(invalid.status, 400);
  const refusal = (await invalid.json()) as { code: string; problems: string[] };
  assert.equal(refusal.code, "command_document_invalid");
  assert.ok(refusal.problems.length >= 2, "every problem is listed");

  const nobody = await propose(f, { env: {}, sessionId: "agent:nobody", cwd: join(home, "nowhere"), document: DOCUMENT });
  assert.equal(nobody.status, 404);

  assert.deepEqual(f.proposals.list(), []);
});

test("applying the reviewed proposal clears it; applying a replaced one leaves the newer pending", async () => {
  const f = fixture();
  const repo = repository();
  const session = runningSession(f, repo);
  const first = (await (await propose(f, { ...session, document: DOCUMENT })).json()) as CommandDocumentProposed;
  const second = (await (await propose(f, {
    ...session,
    document: { version: 1, commands: { test: [{ path: "", argv: ["yarn", "test"] }] } },
  })).json()) as CommandDocumentProposed;
  assert.equal(second.replaced, first.proposal.id);

  // The operator applies the OLDER proposal they had open: it is written, but the newer stays.
  const preview = (await (await f.post("/api/command-documents/preview", { repoRoot: repo, document: DOCUMENT })).json()) as CommandDocumentPreview;
  const stale = await f.post("/api/command-documents/apply", {
    repoRoot: repo,
    document: DOCUMENT,
    basis: preview.basis,
    proposalId: first.proposal.id,
  });
  assert.equal(stale.status, 200);
  assert.equal(((await stale.json()) as CommandDocumentApplied).proposalCleared, false);
  assert.deepEqual(f.commands.get("lint")!.overrides, [{ repoRoot: `${repo}/apps/web`, command: ["yarn", "workspace", "web", "lint"] }]);
  assert.equal(f.proposals.get(repo)?.id, second.proposal.id, "the newer proposal is still pending");

  const current = f.proposals.get(repo)!;
  const fresh = (await (await f.post("/api/command-documents/preview", { repoRoot: repo, document: current.document })).json()) as CommandDocumentPreview;
  const applied = await f.post("/api/command-documents/apply", {
    repoRoot: repo,
    document: current.document,
    basis: fresh.basis,
    proposalId: current.id,
  });
  assert.equal(applied.status, 200);
  assert.equal(((await applied.json()) as CommandDocumentApplied).proposalCleared, true);
  assert.deepEqual(f.commands.get("test")!.overrides, [{ repoRoot: repo, command: ["yarn", "test"] }]);
  assert.equal(f.proposals.get(repo), null);
  assert.deepEqual(f.frames.at(-1), [], "the browser hears it is gone");
});

test("an apply that is refused leaves the proposal pending and writes nothing", async () => {
  const f = fixture();
  const repo = repository();
  const made = (await (await propose(f, { ...runningSession(f, repo), document: DOCUMENT })).json()) as CommandDocumentProposed;
  const preview = (await (await f.post("/api/command-documents/preview", { repoRoot: repo, document: DOCUMENT })).json()) as CommandDocumentPreview;

  // Another window saves the lint slot after the preview was computed, so its basis is stale.
  const lint = f.commands.get("lint")!;
  const other = { repoRoot: `${repo}/apps/web`, command: ["pnpm", "lint"] };
  assert.equal(f.commands.replace("lint", {
    expectedRevision: lint.revision,
    defaultCommand: lint.defaultCommand,
    maxRuns: lint.maxRuns,
    overrides: [other],
  }).ok, true);
  const framesBefore = f.frames.length;

  const stale = await f.post("/api/command-documents/apply", {
    repoRoot: repo,
    document: DOCUMENT,
    basis: preview.basis,
    proposalId: made.proposal.id,
  });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { code: string }).code, "command_document_stale");
  assert.equal(f.proposals.get(repo)?.id, made.proposal.id, "a stale apply keeps the proposal pending");
  assert.deepEqual(f.commands.get("lint")!.overrides, [other], "only the other window's save is stored");
  assert.deepEqual(f.testing.list(), [], "no testing settings row was written");

  // An invalid document, refused before anything is read, keeps it pending too.
  const invalid = await f.post("/api/command-documents/apply", {
    repoRoot: repo,
    document: { version: 1, commands: { lint: [{ path: "/absolute", argv: ["x"] }] } },
    basis: preview.basis,
    proposalId: made.proposal.id,
  });
  assert.equal(invalid.status, 400);
  assert.equal(f.proposals.get(repo)?.id, made.proposal.id, "a refused apply keeps the proposal pending");
  assert.equal(f.frames.length, framesBefore, "no proposals frame: the set did not move");
});

test("dismissing clears the proposal and writes nothing; a second dismissal is a 404", async () => {
  const f = fixture();
  const repo = repository();
  const made = (await (await propose(f, { ...runningSession(f, repo), document: DOCUMENT })).json()) as CommandDocumentProposed;
  const lintBefore = f.commands.get("lint")!;

  const dismissed = await f.post("/api/command-documents/proposals/dismiss", { repoRoot: repo, proposalId: made.proposal.id });
  assert.equal(dismissed.status, 200);
  assert.equal(f.proposals.get(repo), null);
  assert.deepEqual(f.commands.get("lint"), lintBefore);
  assert.deepEqual(f.testing.list(), []);

  const again = await f.post("/api/command-documents/proposals/dismiss", { repoRoot: repo, proposalId: made.proposal.id });
  assert.equal(again.status, 404);
  assert.equal(((await again.json()) as { code: string }).code, "command_document_proposal_gone");
});
