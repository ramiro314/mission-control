import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandDocumentPreview } from "../src/shared/command-document.ts";
import type { WorkflowCommandView } from "../src/shared/workflow.ts";


// The Command document routes: preview, apply and export over the Command catalog and the stored
// testing settings catalog, for one repository. What is at stake is that apply writes exactly
// what the operator previewed, in one transaction, or nothing at all; that a preview gone stale
// is refused with a fresh one; and that a repository's own export imports back as no change.

const home = mkdtempSync(join(tmpdir(), "mission-command-documents-http-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowCommandManager } = await import("../src/server/workflows/commands.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { TestingSettingsCatalog } = await import("../src/server/testing-settings.ts");
const { CommandDocuments } = await import("../src/server/command-documents.ts");
const { buildApp } = await import("../src/server/routes.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

const AFFECTED = ["yarn", "test:affected", "--junit-file={junit}", "{files}"];

/** A real, canonical main checkout with an app folder in it, because the routes resolve through git. */
function repository(): string {
  const root = realpathSync(mkdtempSync(join(home, "repo-")));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "apps", "web"), { recursive: true });
  mkdirSync(join(root, "apps", "api"), { recursive: true });
  return root;
}

function fixture() {
  clearWorkflowTables(db);
  const registry = new Registry();
  const store = new WorkflowStore(db);
  const commands = new WorkflowCommandManager(registry, store);
  const testing = new TestingSettingsCatalog(store);
  const emitted: string[] = [];
  const upsert = registry.upsertWorkflowCommand.bind(registry);
  registry.upsertWorkflowCommand = (view: WorkflowCommandView) => {
    emitted.push(view.slot);
    upsert(view);
  };
  const app = buildApp({
    registry,
    reviews: null as never,
    tasks: null as never,
    queues: null as never,
    workflowCommands: commands,
    testingSettings: testing,
  });
  const request = (path: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: { host: "127.0.0.1:7317", "content-type": "application/json", ...init?.headers },
    });
  const post = (path: string, value: unknown) => request(path, { method: "POST", body: JSON.stringify(value) });
  return { commands, testing, emitted, request, post };
}

function slot(commands: InstanceType<typeof WorkflowCommandManager>, name: string): WorkflowCommandView {
  return commands.get(name)!;
}

test("preview lists every add, change and removal, and apply writes them, leaving everything unmentioned alone", async () => {
  const { commands, testing, emitted, post } = fixture();
  const repo = repository();
  const other = repository();
  // What is stored: a default and a run budget the document must not touch, this repository's
  // rows, and another repository's row in the same slot.
  const lint = slot(commands, "lint");
  assert.equal(commands.replace("lint", {
    expectedRevision: lint.revision,
    defaultCommand: ["npm", "run", "lint"],
    maxRuns: 4,
    overrides: [
      { repoRoot: repo, command: ["old", "lint"] },
      { repoRoot: `${repo}/apps/api`, command: ["api", "lint"] },
      { repoRoot: other, command: ["other", "lint"] },
    ],
  }).ok, true);
  const test_ = slot(commands, "test");
  assert.equal(commands.replace("test", {
    expectedRevision: test_.revision,
    defaultCommand: null,
    maxRuns: 1,
    overrides: [{ repoRoot: `${repo}/apps/web`, command: ["web", "test"] }],
  }).ok, true);
  assert.equal(testing.replace({ repoRoot: `${repo}/apps/api`, expectedRevision: 0, settings: { tests: { smokeSet: ["s.ts"] } } }).ok, true);
  emitted.length = 0;

  const document = {
    version: 1,
    commands: {
      lint: [{ path: "", argv: ["yarn", "lint"] }, { path: "apps/web", argv: ["web", "lint"] }],
      test: [{ path: "apps/web", remove: true }],
      "affected-tests": [{ path: "apps/web", argv: AFFECTED }],
    },
    testing: [
      { path: "apps/web", settings: { tests: { patterns: ["src/**/*.test.ts"] } } },
      { path: "apps/api", remove: true },
    ],
  };
  const previewed = await post("/api/command-documents/preview", { repoRoot: repo, document });
  assert.equal(previewed.status, 200);
  const preview = await previewed.json() as CommandDocumentPreview;
  assert.equal(preview.repoRoot, repo);
  assert.deepEqual(preview.commands.map((change) => `${change.slot} ${change.kind} ${change.path}`), [
    "test remove apps/web",
    "lint change ",
    "lint add apps/web",
    "affected-tests add apps/web",
  ]);
  assert.deepEqual(preview.testing.map((change) => `${change.kind} ${change.path}`), ["remove apps/api", "add apps/web"]);
  assert.deepEqual(preview.problems, []);
  // Previewing writes nothing.
  assert.deepEqual(slot(commands, "lint").overrides.find((entry) => entry.repoRoot === repo)?.command, ["old", "lint"]);
  assert.deepEqual(emitted, []);

  const applied = await post("/api/command-documents/apply", { repoRoot: repo, document, basis: preview.basis });
  assert.equal(applied.status, 200);
  const body = await applied.json() as { repoRoot: string; preview: CommandDocumentPreview };
  assert.deepEqual(body.preview.commands, preview.commands);

  const after = slot(commands, "lint");
  assert.deepEqual(after.defaultCommand, ["npm", "run", "lint"]);
  assert.equal(after.maxRuns, 4);
  assert.deepEqual(after.overrides, [
    { repoRoot: repo, command: ["yarn", "lint"] },
    { repoRoot: `${repo}/apps/api`, command: ["api", "lint"] },
    { repoRoot: `${repo}/apps/web`, command: ["web", "lint"] },
    { repoRoot: other, command: ["other", "lint"] },
  ].sort((a, b) => (a.repoRoot < b.repoRoot ? -1 : 1)));
  assert.deepEqual(slot(commands, "test").overrides, []);
  assert.deepEqual(slot(commands, "affected-tests").overrides, [{ repoRoot: `${repo}/apps/web`, command: AFFECTED }]);
  const rows = new Map(testing.list().map((view) => [view.repoRoot, view.settings]));
  assert.deepEqual(rows.get(`${repo}/apps/web`), { tests: { patterns: ["src/**/*.test.ts"] } });
  assert.deepEqual(rows.get(`${repo}/apps/api`), {});
  // One event per slot that moved, after the commit.
  assert.deepEqual(emitted.sort(), ["affected-tests", "lint", "test"]);
});

test("a preview gone stale is refused with 409 and the recomputed preview, and writes nothing", async () => {
  const { commands, testing, post } = fixture();
  const repo = repository();
  const document = {
    version: 1,
    commands: { lint: [{ path: "apps/web", argv: ["web", "lint"] }] },
    testing: [{ path: "", settings: { tests: { includeImporters: false } } }],
  };
  const preview = await (await post("/api/command-documents/preview", { repoRoot: repo, document })).json() as CommandDocumentPreview;
  assert.deepEqual(preview.basis, { commands: { lint: 1 }, testing: { "": 0 } });

  // Another window saves the lint slot (in a slot the document only adds to), after the preview.
  const lint = slot(commands, "lint");
  commands.replace("lint", { expectedRevision: lint.revision, defaultCommand: null, maxRuns: 1, overrides: [{ repoRoot: `${repo}/apps/web`, command: ["theirs"] }] });

  const stale = await post("/api/command-documents/apply", { repoRoot: repo, document, basis: preview.basis });
  assert.equal(stale.status, 409);
  const refused = await stale.json() as { code: string; preview: CommandDocumentPreview };
  assert.equal(refused.code, "command_document_stale");
  // The fresh preview says what applying would now do: change their row, not add one.
  assert.deepEqual(refused.preview.commands, [
    { slot: "lint", path: "apps/web", kind: "change", before: ["theirs"], after: ["web", "lint"] },
  ]);
  assert.deepEqual(refused.preview.basis, { commands: { lint: 2 }, testing: { "": 0 } });
  // Nothing was written: not the testing row, whose own revision had not moved.
  assert.deepEqual(testing.list(), []);
  assert.deepEqual(slot(commands, "lint").overrides, [{ repoRoot: `${repo}/apps/web`, command: ["theirs"] }]);

  // A testing row saved meanwhile makes it stale the same way.
  testing.replace({ repoRoot: repo, expectedRevision: 0, settings: { tests: { smokeSet: [] } } });
  const again = await post("/api/command-documents/apply", { repoRoot: repo, document, basis: refused.preview.basis });
  assert.equal(again.status, 409);
  const fresh = (await again.json() as { preview: CommandDocumentPreview }).preview;
  assert.deepEqual(fresh.basis, { commands: { lint: 2 }, testing: { "": 1 } });
  assert.deepEqual(fresh.testing.map((change) => change.kind), ["change"]);

  // Applying against the recomputed preview lands.
  const landed = await post("/api/command-documents/apply", { repoRoot: repo, document, basis: fresh.basis });
  assert.equal(landed.status, 200);
  assert.deepEqual(slot(commands, "lint").overrides, [{ repoRoot: `${repo}/apps/web`, command: ["web", "lint"] }]);
  assert.deepEqual(testing.list()[0]?.settings, { tests: { includeImporters: false } });
});

test("a write that loses its race inside the transaction rolls the whole document back", () => {
  const { commands, testing } = fixture();
  const repo = repository();
  const documents = new CommandDocuments(commands, testing);
  const document = {
    version: 1 as const,
    commands: { lint: [{ path: "", argv: ["yarn", "lint"] }] },
    testing: [{ path: "", settings: { tests: { patterns: ["t/*.ts"] } } }],
  };
  const preview = documents.preview(repo, document);
  // Between the basis check and the testing write, another writer claims the testing row. The
  // store's compare-and-swap refuses the write, and the lint slot written before it rolls back.
  const replace = testing.store.replaceTestingSettingsCas.bind(testing.store);
  let raced = false;
  testing.store.replaceTestingSettingsCas = (key, expected, settings, now) => {
    if (!raced) {
      raced = true;
      replace(key, expected, { tests: { smokeSet: ["theirs"] } }, now);
    }
    return replace(key, expected, settings, now);
  };
  const result = documents.apply(repo, document, preview.basis);
  testing.store.replaceTestingSettingsCas = replace;
  assert.equal(result.kind, "stale");
  // Rolled back: neither the slot nor the racing write survived the transaction.
  assert.deepEqual(slot(commands, "lint").overrides, []);
  assert.equal(slot(commands, "lint").revision, 1);
  assert.deepEqual(testing.list(), []);
});

test("export then import round-trips: the preview changes nothing and apply writes nothing", async () => {
  const { commands, testing, emitted, request, post } = fixture();
  const repo = repository();
  const affected = slot(commands, "affected-tests");
  commands.replace("affected-tests", {
    expectedRevision: affected.revision,
    defaultCommand: null,
    maxRuns: 1,
    overrides: [{ repoRoot: `${repo}/apps/web`, command: AFFECTED }, { repoRoot: repo, command: AFFECTED }],
  });
  testing.replace({ repoRoot: `${repo}/apps/web`, expectedRevision: 0, settings: { tests: { smokeSet: ["smoke/*.ts"], patterns: ["src/**/*.test.ts"] } } });
  testing.replace({ repoRoot: `${repo}/apps/api`, expectedRevision: 0, settings: {} });
  emitted.length = 0;

  const exported = await request(`/api/command-documents/export?repoRoot=${encodeURIComponent(repo)}`);
  assert.equal(exported.status, 200);
  const { repoRoot, document } = await exported.json() as { repoRoot: string; document: unknown };
  assert.equal(repoRoot, repo);
  assert.deepEqual(document, {
    version: 1,
    commands: { "affected-tests": [{ path: "", argv: AFFECTED }, { path: "apps/web", argv: AFFECTED }] },
    // The empty apps/api row is no layer, so it is not exported.
    testing: [{ path: "apps/web", settings: { tests: { patterns: ["src/**/*.test.ts"], smokeSet: ["smoke/*.ts"] } } }],
  });

  const preview = await (await post("/api/command-documents/preview", { repoRoot: repo, document })).json() as CommandDocumentPreview;
  assert.deepEqual([preview.commands, preview.testing, preview.problems], [[], [], []]);
  assert.equal(preview.unchanged, 3);
  const before = { lint: slot(commands, "affected-tests").revision, rows: testing.list().map((view) => view.revision) };
  const applied = await post("/api/command-documents/apply", { repoRoot: repo, document, basis: preview.basis });
  assert.equal(applied.status, 200);
  assert.deepEqual({ lint: slot(commands, "affected-tests").revision, rows: testing.list().map((view) => view.revision) }, before);
  assert.deepEqual(emitted, []);
});

test("an invalid document is refused with every problem in words, before and after the merge", async () => {
  const { commands, post } = fixture();
  const repo = repository();
  const refused = await post("/api/command-documents/preview", {
    repoRoot: repo,
    document: { version: 1, maxRuns: 3, commands: { "affected-tests": [{ path: "", argv: ["yarn", "test"] }] } },
  });
  assert.equal(refused.status, 400);
  const body = await refused.json() as { code: string; problems: string[] };
  assert.equal(body.code, "command_document_invalid");
  assert.equal(body.problems.length, 2);
  assert.ok(body.problems.some((line) => /Unrecognized key\(s\) in object: 'maxRuns'/.test(line)));
  assert.ok(body.problems.some((line) => line.startsWith("commands.affected-tests[0].argv: An affected-tests command must contain")));

  // A folder that does not exist, one reached through a symlink, and one inside a nested
  // repository: the preview lists them as problems and apply refuses.
  symlinkSync(join(repo, "apps", "web"), join(repo, "web-link"));
  mkdirSync(join(repo, "vendor", "lib"), { recursive: true });
  execFileSync("git", ["init", "-q", join(repo, "vendor", "lib")]);
  const document = {
    version: 1,
    commands: {
      lint: [
        { path: "apps/missing", argv: ["x"] },
        { path: "web-link", argv: ["x"] },
        { path: "vendor/lib", argv: ["x"] },
        { path: "apps/web", argv: ["fine"] },
      ],
    },
  };
  const preview = await (await post("/api/command-documents/preview", { repoRoot: repo, document })).json() as CommandDocumentPreview;
  assert.deepEqual(preview.problems, [
    "lint · apps/missing: no such folder in this repository",
    "lint · web-link: reached through a symlink; name the folder by its own path",
    "lint · vendor/lib: inside a nested repository or submodule, which keeps its own rows",
  ]);
  const applied = await post("/api/command-documents/apply", { repoRoot: repo, document, basis: preview.basis });
  assert.equal(applied.status, 400);
  assert.equal((await applied.json() as { code: string }).code, "command_document_invalid");
  assert.deepEqual(slot(commands, "lint").overrides, []);
});

test("the repository must be a main checkout, and a subdirectory names its repository", async () => {
  const { post, request } = fixture();
  const notRepo = mkdtempSync(join(home, "plain-"));
  const refused = await post("/api/command-documents/preview", { repoRoot: notRepo, document: { version: 1 } });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json() as { code: string }).code, "command_document_not_a_repository");
  assert.equal((await request(`/api/command-documents/export?repoRoot=${encodeURIComponent(notRepo)}`)).status, 400);
  assert.equal((await request("/api/command-documents/export")).status, 400);

  const repo = repository();
  const fromSub = await post("/api/command-documents/preview", { repoRoot: join(repo, "apps", "web"), document: { version: 1 } });
  assert.equal(fromSub.status, 200);
  assert.equal((await fromSub.json() as CommandDocumentPreview).repoRoot, repo);
});
