import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TestingSettingsView } from "../src/shared/testing-config.ts";
import {
  TestingSettingsSection,
  testingSettingsDraftDirty,
  testingSettingsDraftFrom,
  testingSettingsDraftTyped,
  testingSettingsFromDraft,
  testingSettingsLocationOf,
  testingSettingsRevisionLine,
  testingSettingsRowOrder,
  testingSettingsRowScope,
  type TestingSettingsDraft,
  type TestingSettingsLocation,
} from "../src/web/workflows/TestingSettingsSection.tsx";

// The affected-tests page's testing settings rows: what a typed draft stores and what a stored
// row reads back as. A list is one glob per line, and each list is either inherited (the key is
// not stored) or set by this row - where an empty list is a real value that replaces the
// committed one. The schema's refusal reaches the operator as a sentence before anything is sent.

const view = (settings: TestingSettingsView["settings"], revision = 3): TestingSettingsView => ({
  repoRoot: "/repo",
  settings,
  revision,
  createdAt: 1,
  updatedAt: 2,
});

const blank: TestingSettingsDraft = testingSettingsDraftFrom(null);

test("a draft stores only the keys it sets, one glob per line", () => {
  const built = testingSettingsFromDraft({
    ...blank,
    patternsMode: "set",
    patterns: " test/**/*.test.ts \n\n spec/*.ts",
    includeImporters: "off",
  });
  assert.deepEqual(built, {
    ok: true,
    settings: { tests: { patterns: ["test/**/*.test.ts", "spec/*.ts"], includeImporters: false } },
  });
  assert.deepEqual(testingSettingsFromDraft(blank), { ok: true, settings: {} });
  const tooLong = testingSettingsFromDraft({ ...blank, patternsMode: "set", patterns: "x".repeat(501) });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.match(tooLong.error, /^tests\.patterns\.0: /);
});

test("a list set by this row with no globs stores an explicit empty list, and Inherit stores none", () => {
  assert.deepEqual(testingSettingsFromDraft({ ...blank, smokeSetMode: "set", smokeSet: "  \n" }), {
    ok: true,
    settings: { tests: { smokeSet: [] } },
  });
  assert.deepEqual(testingSettingsFromDraft({ ...blank, patternsMode: "set" }), {
    ok: true,
    settings: { tests: { patterns: [] } },
  });
  // Text left under Inherit is not stored: Inherit is how the key is unset.
  assert.deepEqual(testingSettingsFromDraft({ ...blank, smokeSet: "a.ts" }), { ok: true, settings: {} });

  // A stored empty list reads back as set-and-empty, so it round-trips and is not dirty.
  const stored = view({ tests: { smokeSet: [] } });
  const draft = testingSettingsDraftFrom(stored);
  assert.equal(draft.smokeSetMode, "set");
  assert.equal(draft.smokeSet, "");
  assert.equal(draft.patternsMode, "inherit");
  assert.equal(testingSettingsDraftDirty(draft, stored), false);
  assert.equal(testingSettingsDraftDirty({ ...draft, smokeSetMode: "inherit" }, stored), true);
});

test("typing a glob sets the list, and emptying it keeps it set rather than inheriting", () => {
  const typed = testingSettingsDraftTyped(blank, "patterns", "test/*.ts");
  assert.equal(typed.patternsMode, "set");
  assert.equal(typed.smokeSetMode, "inherit", "only the typed list changes");
  const emptied = testingSettingsDraftTyped(typed, "patterns", "");
  assert.equal(emptied.patternsMode, "set");
  assert.equal(testingSettingsDraftTyped(blank, "smokeSet", "   ").smokeSetMode, "inherit");
});

test("a stored row reads back as its draft, and only a real edit is dirty", () => {
  const stored = view({ tests: { smokeSet: ["a.ts", "b.ts"], includeImporters: true } });
  const draft = testingSettingsDraftFrom(stored);
  assert.deepEqual(draft, {
    patternsMode: "inherit",
    patterns: "",
    includeImporters: "on",
    smokeSetMode: "set",
    smokeSet: "a.ts\nb.ts",
  });
  assert.equal(testingSettingsDraftDirty(draft, stored), false);
  assert.equal(testingSettingsDraftDirty({ ...draft, smokeSet: "a.ts\n b.ts \n" }, stored), false);
  assert.equal(testingSettingsDraftDirty({ ...draft, includeImporters: "inherit" }, stored), true);
  assert.equal(testingSettingsDraftDirty(blank, null), false);
  assert.equal(testingSettingsRevisionLine(stored), "Stored revision 3");
  assert.equal(testingSettingsRevisionLine(null), "Nothing stored yet");
});

test("the section explains the layer order before anything has loaded", () => {
  const html = renderToStaticMarkup(createElement(TestingSettingsSection, {
    overrideRoots: [],
    repos: [],
    onDirtyChange: () => {},
  }));
  assert.match(html, /<h4 id="wf-testing-settings-title">Testing settings<\/h4>/);
  assert.match(html, /committed, then stored, then local/);
  assert.match(html, /The gate runs when any of the three exists/);
  assert.match(html, /Loading testing settings/);
});

test("a row's location names its repository and subdirectory, and rows list each root before its folders", () => {
  assert.deepEqual(testingSettingsLocationOf({ repoRoot: "/r/repo", path: "/r/repo" }), { repoRoot: "/r/repo", subpath: "" });
  assert.deepEqual(testingSettingsLocationOf({ repoRoot: "/r/repo", path: "/r/repo/apps/web" }), {
    repoRoot: "/r/repo",
    subpath: "apps/web",
  });
  assert.equal(testingSettingsLocationOf({ repoRoot: "/r/repo", path: "/r/repo-old/apps" }), null);

  const locations = new Map<string, TestingSettingsLocation | null>([
    ["/r/repo", { repoRoot: "/r/repo", subpath: "" }],
    ["/r/repo/apps/web", { repoRoot: "/r/repo", subpath: "apps/web" }],
    ["/r/repo/apps/api", { repoRoot: "/r/repo", subpath: "apps/api" }],
    ["/r/repo-old", { repoRoot: "/r/repo-old", subpath: "" }],
    ["/r/gone", null],
  ]);
  // Plain path order would put /r/repo-old between /r/repo and its folders.
  assert.deepEqual(
    testingSettingsRowOrder(["/r/repo/apps/web", "/r/repo-old", "/r/gone", "/r/repo", "/r/repo/apps/api", "/r/repo"], locations),
    ["/r/gone", "/r/repo", "/r/repo/apps/api", "/r/repo/apps/web", "/r/repo-old"],
  );
});

test("a subdirectory row's globs are relative to it, and Inherit takes a key from the root", () => {
  assert.deepEqual(testingSettingsRowScope({ repoRoot: "/r", subpath: "apps/web" }), {
    globsRelativeTo: "apps/web",
    inheritFrom: "the repository root's settings",
  });
  assert.deepEqual(testingSettingsRowScope({ repoRoot: "/r", subpath: "" }), {
    globsRelativeTo: "the repository",
    inheritFrom: "the committed file or the default",
  });
  assert.deepEqual(testingSettingsRowScope(null), testingSettingsRowScope({ repoRoot: "/r", subpath: "" }));
  const html = renderToStaticMarkup(createElement(TestingSettingsSection, {
    overrideRoots: [],
    repos: [],
    onDirtyChange: () => {},
  }));
  assert.match(html, /its globs are relative to the\s+folder, and a key left to Inherit comes from the repository root/);
});
