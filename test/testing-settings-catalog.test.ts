import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The stored testing settings catalog: the store's compare-and-swap, the HTTP write boundary,
// and the lookup the affected-tests gate reads through. What is at stake is that an invalid row
// can never be stored, that two windows cannot silently overwrite one another, and that a row
// lands under the same canonical path the gate later asks about.

const home = mkdtempSync(join(tmpdir(), "mission-testing-settings-catalog-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { TestingSettingsCatalog } = await import("../src/server/testing-settings.ts");
const { buildApp } = await import("../src/server/routes.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

function catalog() {
  clearWorkflowTables(db);
  return new TestingSettingsCatalog(new WorkflowStore(db));
}

/** A real main checkout, canonical, because the route resolves the path through git. */
function repository(): string {
  const root = realpathSync(mkdtempSync(join(home, "repo-")));
  execFileSync("git", ["init", "-q", root]);
  return root;
}

function app(settings: InstanceType<typeof TestingSettingsCatalog>) {
  const built = buildApp({
    registry: new Registry(),
    reviews: null as never,
    tasks: null as never,
    queues: null as never,
    testingSettings: settings,
  });
  return (path: string, init?: RequestInit) =>
    built.request(path, {
      ...init,
      headers: { host: "127.0.0.1:7317", "content-type": "application/json", ...init?.headers },
    });
}

const put = (value: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(value) });

test("a first write expects revision 0, a later one the revision it read, and a stale one is refused", () => {
  const s = catalog();
  const first = s.replace({ repoRoot: "/repo", expectedRevision: 0, settings: { tests: { patterns: ["t/*.ts"] } } }, 1_000);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.view.revision, 1);
  assert.equal(first.view.createdAt, 1_000);

  // A second window that also saw "no row" cannot create it again.
  const racing = s.replace({ repoRoot: "/repo", expectedRevision: 0, settings: { tests: { smokeSet: ["x"] } } });
  assert.equal(racing.ok, false);
  if (!racing.ok) {
    assert.equal(racing.reason, "revision_conflict");
    assert.deepEqual(racing.current?.settings, { tests: { patterns: ["t/*.ts"] } });
  }

  const second = s.replace({ repoRoot: "/repo", expectedRevision: 1, settings: {} }, 2_000);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  // Clearing keeps the row, so its revision keeps rising and a stale editor is still refused.
  assert.equal(second.view.revision, 2);
  assert.equal(second.view.createdAt, 1_000);
  assert.deepEqual(s.list().map((view) => [view.repoRoot, view.revision]), [["/repo", 2]]);
  assert.equal(s.replace({ repoRoot: "/repo", expectedRevision: 1, settings: {} }).ok, false);
});

test("the store refuses a settings object the schema refuses, even past the route", () => {
  const s = catalog();
  const refused = s.store.replaceTestingSettingsCas("/repo", 0, { flakes: { label: "x" } } as never);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, "invalid");
  assert.deepEqual(s.list(), []);
});

test("an unreadable settings column reads as setting nothing and stays repairable", () => {
  const s = catalog();
  db.prepare(
    `INSERT INTO testing_settings (repo_root, settings_json, revision, created_at, updated_at)
     VALUES ('/repo', '{"flakes":{}}', 4, 1, 1)`,
  ).run();
  const [view] = s.list();
  assert.deepEqual(view, { repoRoot: "/repo", settings: {}, revision: 4, createdAt: 1, updatedAt: 1 });
  assert.equal(s.forRepoRoot("/repo") !== null && Object.keys(s.forRepoRoot("/repo")!).length, 0);
  assert.equal(s.replace({ repoRoot: "/repo", expectedRevision: 4, settings: { tests: { patterns: ["a"] } } }).ok, true);
});

test("the gate's lookup finds a root's row by its canonical path, through a symlink too", () => {
  const s = catalog();
  const root = repository();
  const link = join(home, `link-${Date.now()}`);
  symlinkSync(root, link);
  assert.equal(s.replace({ repoRoot: root, expectedRevision: 0, settings: { tests: { smokeSet: ["s.ts"] } } }).ok, true);
  assert.deepEqual(s.forRepoRoot(root), { tests: { smokeSet: ["s.ts"] } });
  assert.deepEqual(s.forRepoRoot(link), { tests: { smokeSet: ["s.ts"] } });
  assert.equal(s.forRepoRoot(join(home, "elsewhere")), null);
});

test("the route stores a root's row, and a stale save is refused with 409 carrying what is stored", async () => {
  const s = catalog();
  const request = app(s);
  const root = repository();

  const created = await request("/api/testing-settings", put({
    repoRoot: root,
    expectedRevision: 0,
    settings: { tests: { patterns: ["test/**/*.test.ts"], includeImporters: false } },
  }));
  assert.equal(created.status, 200);
  const view = await created.json() as { repoRoot: string; revision: number };
  assert.equal(view.repoRoot, root);
  assert.equal(view.revision, 1);

  const listed = await (await request("/api/testing-settings")).json() as Array<{ repoRoot: string }>;
  assert.deepEqual(listed.map((row) => row.repoRoot), [root]);

  // Window B saves revision 1 first; window A, still holding revision 1, is refused.
  assert.equal((await request("/api/testing-settings", put({
    repoRoot: root, expectedRevision: 1, settings: { tests: { smokeSet: ["test/b.test.ts"] } },
  }))).status, 200);
  const stale = await request("/api/testing-settings", put({
    repoRoot: root, expectedRevision: 1, settings: { tests: { smokeSet: ["test/a.test.ts"] } },
  }));
  assert.equal(stale.status, 409);
  const refusal = await stale.json() as { code: string; current: { revision: number; settings: unknown } };
  assert.equal(refusal.code, "testing_settings_revision_conflict");
  assert.equal(refusal.current.revision, 2);
  assert.deepEqual(refusal.current.settings, { tests: { smokeSet: ["test/b.test.ts"] } });
  assert.deepEqual(s.forRepoRoot(root), { tests: { smokeSet: ["test/b.test.ts"] } });
});

test("the route refuses flakes, unknown keys, a non-canonical spelling, and a non-repository", async () => {
  const s = catalog();
  const request = app(s);
  const root = repository();
  const refused = async (body: unknown) => (await request("/api/testing-settings", put(body))).status;

  assert.equal(await refused({ repoRoot: root, expectedRevision: 0, settings: { flakes: { label: "x" } } }), 400);
  assert.equal(await refused({ repoRoot: root, expectedRevision: 0, settings: { tests: { smokeSets: [] } } }), 400);
  assert.equal(await refused({ repoRoot: root, expectedRevision: 0, settings: {}, extra: 1 }), 400);
  // A subdirectory spelled through a symlink would be stored under a key the gate never asks
  // about, so it is refused with the canonical spelling.
  mkdirSync(join(root, "apps"));
  const link = join(home, `apps-link-${Date.now()}`);
  symlinkSync(join(root, "apps"), link);
  const aliased = await request("/api/testing-settings", put({ repoRoot: link, expectedRevision: 0, settings: {} }));
  assert.equal(aliased.status, 400);
  assert.deepEqual(await aliased.json(), {
    error: `Testing settings are stored by canonical path. Use ${join(root, "apps")}.`,
    code: "testing_settings_not_canonical",
  });
  const missing = await request("/api/testing-settings", put({
    repoRoot: join(root, "nowhere"), expectedRevision: 0, settings: {},
  }));
  assert.equal(missing.status, 400);
  const outside = await request("/api/testing-settings", put({
    repoRoot: realpathSync(mkdtempSync(join(tmpdir(), "not-a-repo-"))), expectedRevision: 0, settings: {},
  }));
  assert.equal(outside.status, 400);
  assert.deepEqual(s.list(), [], "no refusal stored anything");
});

test("the route stores a subdirectory's row under its canonical path, beside the root's", async () => {
  const s = catalog();
  const request = app(s);
  const root = repository();
  const web = join(root, "apps", "web");
  mkdirSync(web, { recursive: true });
  const saved = await request("/api/testing-settings", put({
    repoRoot: web, expectedRevision: 0, settings: { tests: { patterns: ["src/**/*.test.ts"] } },
  }));
  assert.equal(saved.status, 200);
  assert.equal((await saved.json() as { repoRoot: string }).repoRoot, web);
  assert.equal((await request("/api/testing-settings", put({
    repoRoot: root, expectedRevision: 0, settings: { tests: { includeImporters: false } },
  }))).status, 200);
  assert.deepEqual(s.forRepository(root), [
    { scope: "", settings: { tests: { includeImporters: false } } },
    { scope: "apps/web", settings: { tests: { patterns: ["src/**/*.test.ts"] } } },
  ]);
});

test("the gate's repository lookup returns the root and its subdirectories, through a symlink too, and nothing else", () => {
  const s = catalog();
  const root = repository();
  const link = join(home, `repo-link-${Date.now()}`);
  symlinkSync(root, link);
  const write = (path: string, smoke: string) => assert.equal(
    s.replace({ repoRoot: path, expectedRevision: 0, settings: { tests: { smokeSet: [smoke] } } }).ok,
    true,
  );
  write(join(root, "apps/b"), "b.ts");
  write(root, "root.ts");
  write(join(root, "apps/a"), "a.ts");
  write(join(root, "apps/a/nested"), "n.ts");
  // A sibling whose name only starts like the repository's is a different repository.
  write(`${root}-backup`, "other.ts");
  write(`${root}-backup/apps/a`, "other.ts");

  const expected = [
    { scope: "", settings: { tests: { smokeSet: ["root.ts"] } } },
    { scope: "apps/a", settings: { tests: { smokeSet: ["a.ts"] } } },
    { scope: "apps/a/nested", settings: { tests: { smokeSet: ["n.ts"] } } },
    { scope: "apps/b", settings: { tests: { smokeSet: ["b.ts"] } } },
  ];
  assert.deepEqual(s.forRepository(root), expected);
  assert.deepEqual(s.forRepository(link), expected);
  assert.deepEqual(s.forRepository(join(home, "elsewhere")), []);
});

test("without a catalog the routes answer 503", async () => {
  const built = buildApp({ registry: new Registry(), reviews: null as never, tasks: null as never, queues: null as never });
  const response = await built.request("/api/testing-settings", { headers: { host: "127.0.0.1:7317" } });
  assert.equal(response.status, 503);
});
