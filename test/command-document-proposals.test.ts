import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pending Command document proposals: which repository a session may propose for, and what one
// proposal per repository means. What is at stake is that `propose_command_document` cannot reach
// a repository its task does not own, that a newer proposal replaces the older instead of piling
// up beside it, and that applying or dismissing the older one never clears the newer.

const home = mkdtempSync(join(tmpdir(), "mission-command-document-proposals-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { CommandDocumentProposals, proposalRepository, PROPOSE_COMMAND_DOCUMENT_TOOL } = await import(
  "../src/server/command-document-proposals.ts"
);
const { captureSettingsCatalogs } = await import("../src/server/settings-backups/catalogs.ts");
const { MISSION_MCP_TOOLS } = await import("../src/server/mission-mcp.ts");

type Task = import("../src/shared/types.ts").Task;
type CommandDocument = import("../src/shared/command-document.ts").CommandDocument;
type CommandDocumentProposal = import("../src/shared/command-document.ts").CommandDocumentProposal;

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

/** The fields the guard reads, on an otherwise opaque task. */
function task(repoRoot: string, extra: Array<{ repoRoot: string; worktreePath: string | null }> = []): Task {
  return {
    id: "task-1",
    title: "Configure the monorepo",
    repoRoot,
    worktreePath: `${repoRoot}-wt`,
    branch: null,
    provider: null,
    worktreeLeaseId: null,
    baseSha: null,
    extraRepos: extra.map((entry) => ({
      repoRoot: entry.repoRoot,
      worktreePath: entry.worktreePath,
      branch: null,
      provider: null,
      worktreeLeaseId: null,
      baseSha: null,
    })),
  } as unknown as Task;
}

const identity = (path: string) => path;

const LINT: CommandDocument = { version: 1, commands: { lint: [{ path: "", argv: ["yarn", "lint"] }] } };
const TEST: CommandDocument = { version: 1, commands: { test: [{ path: "apps/web", argv: ["yarn", "test"] }] } };

test("the tool is declared, so a launch can pre-approve it", () => {
  assert.ok((MISSION_MCP_TOOLS as readonly string[]).includes(PROPOSE_COMMAND_DOCUMENT_TOOL));
});

test("a session with no task is refused", () => {
  const result = proposalRepository(undefined, undefined, identity);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 403);
});

test("a single-repository task proposes for its repository without naming it", () => {
  assert.deepEqual(proposalRepository(task("/repos/app"), undefined, identity), { ok: true, repoRoot: "/repos/app" });
});

test("another repository is refused, by path or by a slot the task does not have", () => {
  const owned = task("/repos/app");
  for (const requested of ["/repos/other", "/repos/app/apps/web", "repo-02"]) {
    const result = proposalRepository(owned, requested, identity);
    assert.equal(result.ok, false, `${requested} must be refused`);
    assert.equal(!result.ok && result.status, 403);
    assert.match(!result.ok ? result.error : "", /is not one of this task's repositories/);
    assert.match(!result.ok ? result.error : "", /repo-01 \(\/repos\/app\)/, "the refusal names what it can propose for");
  }
});

test("a task's own repositories are accepted by slot, main checkout, or the session's checkout", () => {
  const owned = task("/repos/app", [{ repoRoot: "/repos/lib", worktreePath: "/pool/lib-wt" }]);
  assert.deepEqual(proposalRepository(owned, "repo-01", identity), { ok: true, repoRoot: "/repos/app" });
  assert.deepEqual(proposalRepository(owned, "repo-02", identity), { ok: true, repoRoot: "/repos/lib" });
  assert.deepEqual(proposalRepository(owned, "/repos/lib", identity), { ok: true, repoRoot: "/repos/lib" });
  assert.deepEqual(proposalRepository(owned, "/pool/lib-wt", identity), { ok: true, repoRoot: "/repos/lib" });
  // A symlinked spelling of an owned repository is still that repository.
  const realpath = (path: string) => (path === "/link/lib" ? "/repos/lib" : path);
  assert.deepEqual(proposalRepository(owned, "/link/lib", realpath), { ok: true, repoRoot: "/repos/lib" });
});

test("a multi-repository task must name which repository, rather than defaulting to the primary", () => {
  const owned = task("/repos/app", [{ repoRoot: "/repos/lib", worktreePath: null }]);
  const result = proposalRepository(owned, undefined, identity);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 400);
  assert.match(!result.ok ? result.error : "", /repo-01 \(\/repos\/app\), repo-02 \(\/repos\/lib\)/);
});

function owner() {
  clearWorkflowTables(db);
  const published: CommandDocumentProposal[][] = [];
  let ids = 0;
  const proposals = new CommandDocumentProposals(
    new WorkflowStore(db),
    (set) => published.push(set),
    () => `proposal-${++ids}`,
  );
  return { proposals, published };
}

const ORIGIN = { task: { id: "task-1", title: "Configure the monorepo" }, session: { id: "s1", name: "agent" } };

test("a newer proposal replaces the older one for the same repository, and leaves other repositories alone", () => {
  const { proposals, published } = owner();
  const first = proposals.propose("/repos/app", LINT, ORIGIN, 1_000);
  const elsewhere = proposals.propose("/repos/other", LINT, ORIGIN, 1_500);
  const second = proposals.propose("/repos/app", TEST, ORIGIN, 2_000);
  assert.ok(first.ok && elsewhere.ok && second.ok);
  assert.equal(first.replaced, null);
  assert.equal(second.replaced, first.proposal.id, "the answer names the proposal it replaced");

  const pending = proposals.list();
  assert.deepEqual(pending.map((entry) => [entry.repoRoot, entry.id]), [
    ["/repos/app", second.proposal.id],
    ["/repos/other", elsewhere.proposal.id],
  ], "one pending proposal per repository");
  assert.deepEqual(proposals.get("/repos/app")?.document, TEST, "the newer document is the one pending");
  assert.equal(proposals.get("/repos/app")?.taskTitle, "Configure the monorepo");
  assert.deepEqual(published.at(-1), pending, "every change publishes the whole set");
});

test("clearing the replaced proposal leaves the newer one pending; clearing the current one removes it", () => {
  const { proposals, published } = owner();
  const first = proposals.propose("/repos/app", LINT, ORIGIN);
  const second = proposals.propose("/repos/app", TEST, ORIGIN);
  assert.ok(first.ok && second.ok);
  const publishedBefore = published.length;

  assert.equal(proposals.clear("/repos/app", first.proposal.id), false);
  assert.equal(proposals.get("/repos/app")?.id, second.proposal.id);
  assert.equal(published.length, publishedBefore, "a clear that removed nothing publishes nothing");

  assert.equal(proposals.clear("/repos/app", second.proposal.id), true);
  assert.equal(proposals.get("/repos/app"), null);
  assert.deepEqual(published.at(-1), []);
});

test("a stored proposal survives a restart: a new owner publishes what is stored", () => {
  const { proposals } = owner();
  const made = proposals.propose("/repos/app", LINT, ORIGIN);
  assert.ok(made.ok);
  const published: CommandDocumentProposal[][] = [];
  new CommandDocumentProposals(new WorkflowStore(db), (set) => published.push(set));
  assert.deepEqual(published, [[proposals.get("/repos/app")]]);
});

test("a document over the proposal bound is refused and nothing is stored", () => {
  const { proposals } = owner();
  const huge: CommandDocument = {
    version: 1,
    commands: {
      lint: Array.from({ length: 300 }, (_, index) => ({ path: `apps/a${index}`, argv: Array(32).fill("x".repeat(40)) })),
    },
  };
  const result = proposals.propose("/repos/app", huge, ORIGIN);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /at most 256 KiB/);
  assert.deepEqual(proposals.list(), []);
});

test("pending proposals are machine state: no settings backup domain captures them", () => {
  const { proposals } = owner();
  const made = proposals.propose("/repos/app", LINT, ORIGIN);
  assert.ok(made.ok);
  const captured = JSON.stringify(captureSettingsCatalogs(new WorkflowStore(db)));
  assert.doesNotMatch(captured, new RegExp(made.proposal.id), "no captured domain carries the proposal");
  assert.doesNotMatch(captured, /\/repos\/app/);
});
