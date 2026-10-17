import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_DOCUMENT_LIMITS,
  CommandDocumentSchema,
  commandDocumentChangeSummary,
  parseCommandDocumentText,
  type CommandDocument,
} from "../src/shared/command-document.ts";
import { emptyWorkflowCommandView, WORKFLOW_CHECK_SLOTS, WORKFLOW_LIMITS, type WorkflowCheckSlot } from "../src/shared/workflow.ts";
import type { TestingSettingsView } from "../src/shared/testing-config.ts";
import {
  exportCommandDocument,
  planCommandDocument,
  type CommandDocumentState,
} from "../src/server/command-documents.ts";

// A Command document is one repository's Command overrides and stored testing settings as one
// file. What is at stake: a document must never reach past its rows (global defaults, run
// budgets, pool settings), every entry must meet its own catalog's rules, and applying one must
// be a merge, where only an explicit removal removes anything.

const AFFECTED = ["yarn", "test:affected", "--junit-file={junit}", "{files}"];

function problems(value: unknown): string[] {
  const parsed = parseCommandDocumentText(JSON.stringify(value));
  return parsed.ok ? [] : parsed.problems;
}

test("the plan's example document is valid", () => {
  const parsed = parseCommandDocumentText(JSON.stringify({
    version: 1,
    commands: {
      lint: [
        { path: "", argv: ["yarn", "turbo", "run", "lint", "--filter=...[origin/main...HEAD]"] },
        { path: "apps/my-account", argv: ["yarn", "lint"] },
      ],
      "affected-tests": [{ path: "apps/my-account", argv: AFFECTED }],
      test: [{ path: "apps/legacy-app", remove: true }],
    },
    testing: [
      { path: "apps/my-account", settings: { tests: { patterns: ["src/**/*.test.{ts,tsx}"] } } },
      { path: "apps/old-app", remove: true },
    ],
  }));
  assert.equal(parsed.ok, true);
});

test("a document is versioned, and a version this build does not know is refused", () => {
  assert.deepEqual(problems({ commands: {} }).length, 1);
  assert.match(problems({ version: 2 })[0]!, /^version: /);
  assert.deepEqual(problems({ version: 1 }), []);
});

test("a document cannot name a global default, a run budget, a pool setting or an unknown slot", () => {
  // Top level.
  for (const key of ["defaults", "maxRuns", "pool", "pools"]) {
    const refused = problems({ version: 1, [key]: {} });
    assert.equal(refused.length, 1, key);
    assert.match(refused[0]!, /Unrecognized key/);
  }
  // Inside commands: only the built-in slots, and inside an entry only path, argv and remove.
  assert.match(problems({ version: 1, commands: { deploy: [] } })[0]!, /^commands: Unrecognized key/);
  assert.match(
    problems({ version: 1, commands: { test: [{ path: "", argv: ["npm", "test"], maxRuns: 3 }] } })[0]!,
    /^commands\.test\[0\]: Unrecognized key/,
  );
  assert.match(
    problems({ version: 1, commands: { test: [{ path: "", defaultCommand: ["npm", "test"] }] } }).join("\n"),
    /Unrecognized key/,
  );
  // Testing settings refuse `flakes`, which is never stored.
  assert.match(
    problems({ version: 1, testing: [{ path: "", settings: { flakes: { label: "x" } } }] })[0]!,
    /^testing\[0\]\.settings: Unrecognized key/,
  );
});

test("paths are repository-relative, with the empty string for the root", () => {
  for (const path of ["", "apps/web", "a/b/c"]) {
    assert.deepEqual(problems({ version: 1, commands: { lint: [{ path, argv: ["x"] }] } }), [], path);
  }
  for (const path of ["/abs", "apps/", "apps//web", "./apps", "apps/../x", "..", "a\\b"]) {
    const refused = problems({ version: 1, commands: { lint: [{ path, argv: ["x"] }] } });
    assert.match(refused[0] ?? "", /^commands\.lint\[0\]\.path: must be repository-relative/, path);
  }
});

test("an entry is a set or a removal, never both or neither", () => {
  assert.match(problems({ version: 1, commands: { lint: [{ path: "" }] } })[0]!, /either argv or "remove": true/);
  assert.match(
    problems({ version: 1, commands: { lint: [{ path: "", argv: ["x"], remove: true }] } })[0]!,
    /either argv or "remove": true/,
  );
  assert.match(problems({ version: 1, commands: { lint: [{ path: "", remove: false }] } }).join("\n"), /remove/);
  assert.match(problems({ version: 1, testing: [{ path: "" }] })[0]!, /either settings or "remove": true/);
  // A testing row that sets no key is not a layer: clearing one is what `remove` says.
  assert.match(
    problems({ version: 1, testing: [{ path: "", settings: {} }] })[0]!,
    /^testing\[0\]\.settings: settings must set at least one tests key/,
  );
  assert.match(problems({ version: 1, testing: [{ path: "", settings: { tests: {} } }] })[0]!, /at least one tests key/);
});

test("an affected-tests argv is held to the template rule, and other slots are not", () => {
  const refused = problems({ version: 1, commands: { "affected-tests": [{ path: "apps/web", argv: ["yarn", "test"] }] } });
  assert.equal(refused.length, 1);
  assert.match(refused[0]!, /^commands\.affected-tests\[0\]\.argv: An affected-tests command must contain/);
  assert.match(refused[0]!, /\{files\}/);
  assert.match(refused[0]!, /\{junit\}/);
  // `{files}` must be a whole element, exactly as the Command editor requires.
  assert.equal(
    problems({ version: 1, commands: { "affected-tests": [{ path: "", argv: ["jest", "--junit={junit}", "--files={files}"] }] } }).length,
    1,
  );
  assert.deepEqual(problems({ version: 1, commands: { "affected-tests": [{ path: "", argv: AFFECTED }] } }), []);
  assert.deepEqual(problems({ version: 1, commands: { test: [{ path: "", argv: ["yarn", "test"] }] } }), []);
  // A removal has no argv to check.
  assert.deepEqual(problems({ version: 1, commands: { "affected-tests": [{ path: "", remove: true }] } }), []);
});

test("a path listed twice in one slot or in testing is refused, while one path in two slots is fine", () => {
  assert.match(
    problems({ version: 1, commands: { lint: [{ path: "apps/web", argv: ["a"] }, { path: "apps/web", remove: true }] } })[0]!,
    /^commands\.lint: lists apps\/web more than once/,
  );
  assert.match(
    problems({ version: 1, testing: [{ path: "", remove: true }, { path: "", settings: { tests: { includeImporters: false } } }] })[0]!,
    /^testing: lists the repository root more than once/,
  );
  assert.deepEqual(
    problems({ version: 1, commands: { lint: [{ path: "apps/web", argv: ["a"] }], test: [{ path: "apps/web", argv: ["b"] }] } }),
    [],
  );
});

test("argv keeps the Command catalog's own limits, and an entry list is bounded", () => {
  assert.match(problems({ version: 1, commands: { lint: [{ path: "", argv: [] }] } })[0]!, /^commands\.lint\[0\]\.argv: /);
  assert.match(problems({ version: 1, commands: { lint: [{ path: "", argv: [""] }] } })[0]!, /^commands\.lint\[0\]\.argv\[0\]: /);
  const many = Array.from({ length: COMMAND_DOCUMENT_LIMITS.commandEntries + 1 }, (_, i) => ({ path: `p${i}`, argv: ["x"] }));
  assert.match(problems({ version: 1, commands: { lint: many } })[0]!, /^commands\.lint: /);
});

test("text that is not JSON, or nothing at all, is refused before any rule", () => {
  const empty = parseCommandDocumentText("   ");
  assert.deepEqual(empty, { ok: false, problems: ["Paste or upload a document first."] });
  const broken = parseCommandDocumentText("{ version: 1 ");
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.match(broken.problems[0]!, /^Not valid JSON: /);
});

// ---- The merge -------------------------------------------------------------------------------

const REPO = "/repo";
const OTHER = "/elsewhere";

function testingView(path: string, settings: TestingSettingsView["settings"], revision = 1): TestingSettingsView {
  return { repoRoot: path === "" ? REPO : `${REPO}/${path}`, settings, revision, createdAt: 0, updatedAt: 0 };
}

/** What is stored, as the planner reads it: slot rows keyed by path, testing rows by path. */
function state(
  rows: Partial<Record<WorkflowCheckSlot, Array<[repoRoot: string, command: string[]]>>>,
  testing: TestingSettingsView[] = [],
  revisions: Partial<Record<WorkflowCheckSlot, number>> = {},
): CommandDocumentState {
  const slots = new Map(WORKFLOW_CHECK_SLOTS.map((slot) => {
    const overrides = (rows[slot] ?? []).map(([repoRoot, command]) => ({ repoRoot, command }));
    const view = { ...emptyWorkflowCommandView(slot), defaultCommand: ["default"], maxRuns: 3, overrides, revision: revisions[slot] ?? 1 };
    const mine = new Map(overrides
      .filter((entry) => entry.repoRoot === REPO || entry.repoRoot.startsWith(`${REPO}/`))
      .map((entry) => [entry.repoRoot === REPO ? "" : entry.repoRoot.slice(REPO.length + 1), { key: entry.repoRoot, command: entry.command }]));
    return [slot, { view, rows: mine }] as const;
  }));
  return {
    repoRoot: REPO,
    slots,
    testing: new Map(testing.map((view) => [view.repoRoot === REPO ? "" : view.repoRoot.slice(REPO.length + 1), view])),
  };
}

const anyFolder = () => null;

function doc(value: Omit<CommandDocument, "version">): CommandDocument {
  return CommandDocumentSchema.parse({ version: 1, ...value });
}

test("unmentioned rows are untouched, listed rows are added or replaced, and only explicit removals remove", () => {
  const current = state({
    lint: [[REPO, ["npm", "run", "lint"]], [`${REPO}/apps/a`, ["a-lint"]], [`${REPO}/apps/b`, ["b-lint"]], [OTHER, ["other-lint"]]],
    test: [[`${REPO}/apps/legacy`, ["legacy-test"]], [`${REPO}/apps/keep`, ["keep-test"]]],
    build: [[`${REPO}/apps/a`, ["a-build"]]],
  }, [
    testingView("apps/a", { tests: { patterns: ["src/**/*.test.ts"] } }, 4),
    testingView("apps/old", { tests: { smokeSet: ["smoke.ts"] } }, 2),
    testingView("apps/keep", { tests: { includeImporters: false } }, 1),
  ], { lint: 7, test: 3 });
  const plan = planCommandDocument(doc({
    commands: {
      // The root changes, apps/a is unchanged, apps/new is added; apps/b is not mentioned.
      lint: [
        { path: "", argv: ["yarn", "lint"] },
        { path: "apps/a", argv: ["a-lint"] },
        { path: "apps/new", argv: ["new-lint"] },
      ],
      // One explicit removal, and one removal of a row that is not there.
      test: [{ path: "apps/legacy", remove: true }, { path: "apps/never", remove: true }],
    },
    testing: [
      { path: "apps/a", settings: { tests: { patterns: ["src/**/*.spec.ts"] } } },
      { path: "apps/new", settings: { tests: { includeImporters: true } } },
      { path: "apps/old", remove: true },
    ],
  }), current, anyFolder);

  // In slot order (`WORKFLOW_CHECK_SLOTS`), then by path.
  assert.deepEqual(plan.preview.commands, [
    { slot: "test", path: "apps/legacy", kind: "remove", before: ["legacy-test"], after: null },
    { slot: "lint", path: "", kind: "change", before: ["npm", "run", "lint"], after: ["yarn", "lint"] },
    { slot: "lint", path: "apps/new", kind: "add", before: null, after: ["new-lint"] },
  ]);
  assert.deepEqual(plan.preview.testing, [
    { path: "apps/a", kind: "change", before: { tests: { patterns: ["src/**/*.test.ts"] } }, after: { tests: { patterns: ["src/**/*.spec.ts"] } } },
    { path: "apps/new", kind: "add", before: null, after: { tests: { includeImporters: true } } },
    { path: "apps/old", kind: "remove", before: { tests: { smokeSet: ["smoke.ts"] } }, after: null },
  ]);
  assert.equal(plan.preview.unchanged, 2);
  assert.deepEqual(plan.preview.problems, []);
  assert.equal(commandDocumentChangeSummary(plan.preview), "2 to add, 2 to change, 2 to remove");

  // The writes: each touched slot's WHOLE list, other repositories and unmentioned rows kept.
  assert.deepEqual(plan.commandWrites, [
    { slot: "test", expectedRevision: 3, overrides: [{ repoRoot: `${REPO}/apps/keep`, command: ["keep-test"] }] },
    {
      slot: "lint",
      expectedRevision: 7,
      overrides: [
        { repoRoot: OTHER, command: ["other-lint"] },
        { repoRoot: REPO, command: ["yarn", "lint"] },
        { repoRoot: `${REPO}/apps/a`, command: ["a-lint"] },
        { repoRoot: `${REPO}/apps/b`, command: ["b-lint"] },
        { repoRoot: `${REPO}/apps/new`, command: ["new-lint"] },
      ],
    },
  ]);
  // A testing removal empties the row rather than deleting it, under its own revision.
  assert.deepEqual(plan.testingWrites, [
    { key: `${REPO}/apps/a`, expectedRevision: 4, settings: { tests: { patterns: ["src/**/*.spec.ts"] } } },
    { key: `${REPO}/apps/new`, expectedRevision: 0, settings: { tests: { includeImporters: true } } },
    { key: `${REPO}/apps/old`, expectedRevision: 2, settings: {} },
  ]);
  // The basis names every slot and testing path the document mentions, changed or not.
  assert.deepEqual(plan.preview.basis, {
    commands: { lint: 7, test: 3 },
    testing: { "apps/a": 4, "apps/new": 0, "apps/old": 2 },
  });
});

test("an empty stored testing row is no layer: setting it is an add, removing it changes nothing", () => {
  const current = state({}, [testingView("apps/a", {}, 5)]);
  const added = planCommandDocument(doc({ testing: [{ path: "apps/a", settings: { tests: { smokeSet: [] } } }] }), current, anyFolder);
  assert.equal(added.preview.testing[0]?.kind, "add");
  assert.deepEqual(added.testingWrites, [{ key: `${REPO}/apps/a`, expectedRevision: 5, settings: { tests: { smokeSet: [] } } }]);
  const removed = planCommandDocument(doc({ testing: [{ path: "apps/a", remove: true }] }), current, anyFolder);
  assert.deepEqual(removed.preview.testing, []);
  assert.equal(removed.preview.unchanged, 1);
  assert.deepEqual(removed.testingWrites, []);
});

test("testing settings compare by value, whatever order their keys were written in", () => {
  const current = state({}, [testingView("", { tests: { smokeSet: ["s"], patterns: ["p"] } })]);
  const plan = planCommandDocument(doc({ testing: [{ path: "", settings: { tests: { patterns: ["p"], smokeSet: ["s"] } } }] }), current, anyFolder);
  assert.deepEqual(plan.preview.testing, []);
  assert.equal(plan.preview.unchanged, 1);
});

test("a slot merged past its override cap is a problem, counted across every repository", () => {
  const full = Array.from({ length: WORKFLOW_LIMITS.commandOverrides }, (_, i) => [`${OTHER}/${i}`, ["x"]] as [string, string[]]);
  const plan = planCommandDocument(doc({ commands: { lint: [{ path: "", argv: ["y"] }] } }), state({ lint: full }), anyFolder);
  assert.equal(plan.preview.problems.length, 1);
  assert.match(plan.preview.problems[0]!, /^lint: would hold 201 overrides across every repository, and a Command holds at most 200$/);
  // Replacing a row in a full slot does not grow it.
  const replacing = planCommandDocument(
    doc({ commands: { lint: [{ path: "", argv: ["z"] }] } }),
    state({ lint: [...full.slice(1), [REPO, ["y"]]] }),
    anyFolder,
  );
  assert.deepEqual(replacing.preview.problems, []);
});

test("a new or changed row at a path that is not a folder here is a problem; a removal or an unchanged row is not checked", () => {
  const missing = (path: string) => (path === "apps/gone" ? "no such folder in this repository" : null);
  const current = state({ lint: [[`${REPO}/apps/gone`, ["old"]]] }, [testingView("apps/gone", { tests: { includeImporters: true } })]);
  const unchanged = planCommandDocument(doc({
    commands: { lint: [{ path: "apps/gone", argv: ["old"] }] },
    testing: [{ path: "apps/gone", settings: { tests: { includeImporters: true } } }],
  }), current, missing);
  assert.deepEqual(unchanged.preview.problems, []);
  const removing = planCommandDocument(doc({ commands: { test: [{ path: "apps/gone", remove: true }] }, testing: [{ path: "apps/gone", remove: true }] }), current, missing);
  assert.deepEqual(removing.preview.problems, []);
  const changing = planCommandDocument(doc({
    commands: { lint: [{ path: "apps/gone", argv: ["new"] }] },
    testing: [{ path: "apps/gone", settings: { tests: { includeImporters: false } } }],
  }), current, missing);
  assert.deepEqual(changing.preview.problems, [
    "lint · apps/gone: no such folder in this repository",
    "testing · apps/gone: no such folder in this repository",
  ]);
});

test("export lists this repository's rows only, sorted, and importing it back changes nothing", () => {
  const current = state({
    lint: [[`${REPO}/apps/b`, ["b"]], [REPO, ["root"]], [OTHER, ["other"]]],
    "affected-tests": [[`${REPO}/apps/a`, AFFECTED]],
  }, [
    testingView("apps/a", { tests: { smokeSet: ["s"], includeImporters: false } }),
    testingView("apps/empty", {}),
  ]);
  const exported = exportCommandDocument(current);
  assert.deepEqual(exported, {
    version: 1,
    commands: {
      lint: [{ path: "", argv: ["root"] }, { path: "apps/b", argv: ["b"] }],
      "affected-tests": [{ path: "apps/a", argv: AFFECTED }],
    },
    testing: [{ path: "apps/a", settings: { tests: { includeImporters: false, smokeSet: ["s"] } } }],
  });
  // The exported value is a valid document, and merging it back is all "unchanged".
  const reparsed = parseCommandDocumentText(JSON.stringify(exported, null, 2));
  assert.equal(reparsed.ok, true);
  if (!reparsed.ok) return;
  const plan = planCommandDocument(reparsed.document, current, anyFolder);
  assert.deepEqual([plan.preview.commands, plan.preview.testing, plan.commandWrites, plan.testingWrites], [[], [], [], []]);
  assert.equal(plan.preview.unchanged, 4);
  assert.equal(commandDocumentChangeSummary(plan.preview), "No changes");
});
