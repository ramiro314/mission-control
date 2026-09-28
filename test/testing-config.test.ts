import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TESTING_CONFIG_DEFAULTS,
  mergeTestingConfig,
  parseTestingConfig,
  parseTestingLocalConfig,
} from "../src/shared/testing-config.ts";
import { readTestingConfig } from "../src/server/testing-config.ts";

function committed(text: string) {
  const parsed = parseTestingConfig(text);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.config;
}

test("an empty file takes every default, including the flakes block", () => {
  assert.deepEqual(committed("{}"), {
    tests: { patterns: [], includeImporters: true, smokeSet: [] },
    flakes: { ...TESTING_CONFIG_DEFAULTS.flakes },
  });
  assert.deepEqual(TESTING_CONFIG_DEFAULTS.flakes, {
    label: "flaky-test",
    actionableLabel: "flaky-test:actionable",
    actionableAfter: 3,
    windowDays: 30,
  });
});

test("an unknown key is refused with the key named, in either file", () => {
  const typo = parseTestingConfig(JSON.stringify({ tests: { smokeSets: [] } }));
  assert.equal(typo.ok, false);
  if (!typo.ok) assert.match(typo.error, /tests.*smokeSets/);
  const top = parseTestingConfig(JSON.stringify({ test: {} }));
  assert.equal(top.ok, false);
  const local = parseTestingLocalConfig(JSON.stringify({ flakes: { labl: "x" } }));
  assert.equal(local.ok, false);
  if (!local.ok) assert.match(local.error, /testing\.local\.json/);
  const notJson = parseTestingConfig("{");
  assert.equal(notJson.ok, false);
  if (!notJson.ok) assert.match(notJson.error, /not valid JSON/);
});

test("the local file overrides key by key, a list replaces a list, and provenance is kept", () => {
  const base = committed(JSON.stringify({
    tests: { patterns: ["test/**/*.test.ts"], smokeSet: ["test/a.test.ts", "test/slow.test.ts"] },
    flakes: { actionableAfter: 5 },
  }));
  const local = parseTestingLocalConfig(JSON.stringify({
    tests: { smokeSet: ["test/a.test.ts"] },
    flakes: { windowDays: 7 },
  }));
  assert.ok(local.ok);
  const merged = mergeTestingConfig(base, local.config);
  assert.deepEqual(merged.config.tests, {
    patterns: ["test/**/*.test.ts"],
    includeImporters: true,
    smokeSet: ["test/a.test.ts"],
  });
  assert.equal(merged.config.flakes.actionableAfter, 5);
  assert.equal(merged.config.flakes.windowDays, 7);
  assert.deepEqual(merged.localKeys, ["flakes.windowDays", "tests.smokeSet"]);
  assert.deepEqual(mergeTestingConfig(base, null).localKeys, []);
});

test("the committed file is read from the check tree and the override from the operator's checkout", () => {
  const tree = mkdtempSync(join(tmpdir(), "testing-config-tree-"));
  const checkout = mkdtempSync(join(tmpdir(), "testing-config-checkout-"));
  const missing = readTestingConfig(tree, checkout);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.kind, "missing");
    assert.match(missing.note, /\.mission\/testing\.json/);
  }

  mkdirSync(join(tree, ".mission"));
  mkdirSync(join(checkout, ".mission"));
  writeFileSync(join(tree, ".mission/testing.json"), JSON.stringify({ tests: { patterns: ["t/*.ts"] } }));
  // A local file inside the TREE is ignored: only the operator's checkout carries it.
  writeFileSync(join(tree, ".mission/testing.local.json"), JSON.stringify({ tests: { patterns: ["wrong"] } }));
  writeFileSync(join(checkout, ".mission/testing.local.json"), JSON.stringify({ tests: { includeImporters: false } }));
  const read = readTestingConfig(tree, checkout);
  assert.ok(read.ok);
  assert.deepEqual(read.merged.config.tests, { patterns: ["t/*.ts"], includeImporters: false, smokeSet: [] });
  assert.deepEqual(read.merged.localKeys, ["tests.includeImporters"]);

  writeFileSync(join(checkout, ".mission/testing.local.json"), "{\"nope\": 1}");
  const badLocal = readTestingConfig(tree, checkout);
  assert.equal(badLocal.ok, false);
  if (!badLocal.ok) assert.equal(badLocal.kind, "invalid-local");

  writeFileSync(join(tree, ".mission/testing.json"), "{\"tests\": {\"patterns\": \"x\"}}");
  const bad = readTestingConfig(tree, null);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.kind, "invalid");
});
