import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TestingSettingsView } from "../src/shared/testing-config.ts";
import {
  TestingSettingsSection,
  testingSettingsDraftDirty,
  testingSettingsDraftFrom,
  testingSettingsFromDraft,
  testingSettingsRevisionLine,
} from "../src/web/workflows/TestingSettingsSection.tsx";

// The affected-tests page's testing settings rows: what a typed draft stores and what a stored
// row reads back as. Typing is one glob per line, a blank field or Inherit leaves the key unset,
// and the schema's refusal reaches the operator as a sentence before anything is sent.

const view = (settings: TestingSettingsView["settings"], revision = 3): TestingSettingsView => ({
  repoRoot: "/repo",
  settings,
  revision,
  createdAt: 1,
  updatedAt: 2,
});

test("a draft stores only the keys it sets, one glob per line", () => {
  const built = testingSettingsFromDraft({
    patterns: " test/**/*.test.ts \n\n spec/*.ts",
    includeImporters: "off",
    smokeSet: "",
  });
  assert.deepEqual(built, {
    ok: true,
    settings: { tests: { patterns: ["test/**/*.test.ts", "spec/*.ts"], includeImporters: false } },
  });
  assert.deepEqual(testingSettingsFromDraft({ patterns: "", includeImporters: "inherit", smokeSet: "" }), {
    ok: true,
    settings: {},
  });
  const tooLong = testingSettingsFromDraft({ patterns: "x".repeat(501), includeImporters: "inherit", smokeSet: "" });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.match(tooLong.error, /^tests\.patterns\.0: /);
});

test("a stored row reads back as its draft, and only a real edit is dirty", () => {
  const stored = view({ tests: { smokeSet: ["a.ts", "b.ts"], includeImporters: true } });
  const draft = testingSettingsDraftFrom(stored);
  assert.deepEqual(draft, { patterns: "", includeImporters: "on", smokeSet: "a.ts\nb.ts" });
  assert.equal(testingSettingsDraftDirty(draft, stored), false);
  assert.equal(testingSettingsDraftDirty({ ...draft, smokeSet: "a.ts\n b.ts \n" }, stored), false);
  assert.equal(testingSettingsDraftDirty({ ...draft, includeImporters: "inherit" }, stored), true);
  assert.equal(testingSettingsDraftDirty(testingSettingsDraftFrom(null), null), false);
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
  assert.match(html, /Loading testing settings/);
});
