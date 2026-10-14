import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StoredTestingSettingsSchema,
  TESTING_CONFIG_LIMITS,
  mergeTestingConfig,
  mergeTestingLayers,
  parseTestingConfig,
  parseTestingLocalConfig,
  storedTestingSettingsKeys,
  testingSettingsSourceLabel,
  type StoredTestingSettings,
} from "../src/shared/testing-config.ts";
import { readTestingConfig } from "../src/server/testing-config.ts";

// The root's three layers, lowest first: the committed file, the stored settings, the local file.
// What is at stake is that each key's effective value comes from the highest layer that sets it,
// that run detail can say which layer that was, and that nothing about the two files' existing
// rules moved - the CI action bundles the same module and a committed file outlives a release.

function committed(value: unknown) {
  const parsed = parseTestingConfig(JSON.stringify(value));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.config;
}

function local(value: unknown) {
  const parsed = parseTestingLocalConfig(JSON.stringify(value));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.config;
}

function stored(value: unknown): StoredTestingSettings {
  return StoredTestingSettingsSchema.parse(value);
}

test("layers merge committed, then stored, then local, and each key names its source", () => {
  const merged = mergeTestingLayers(
    committed({ tests: { patterns: ["test/**/*.test.ts"], smokeSet: ["test/a.test.ts", "test/slow.test.ts"] } }),
    { settings: stored({ tests: { patterns: ["spec/**/*.ts"], smokeSet: ["spec/smoke.ts"] } }), scope: "" },
    local({ tests: { smokeSet: ["spec/fast.ts"] }, flakes: { windowDays: 7 } }),
  );
  // Stored replaces committed key by key, a list for a list; local replaces stored.
  assert.deepEqual(merged.config.tests, {
    patterns: ["spec/**/*.ts"],
    includeImporters: true,
    smokeSet: ["spec/fast.ts"],
  });
  assert.equal(merged.config.flakes.windowDays, 7);
  assert.deepEqual(merged.sources, [
    { key: "tests.patterns", layer: "stored", scope: "" },
    { key: "tests.includeImporters", layer: "committed", scope: null },
    { key: "tests.smokeSet", layer: "local", scope: null },
  ]);
  // `localKeys` keeps its old meaning, flakes included.
  assert.deepEqual(merged.localKeys, ["flakes.windowDays", "tests.smokeSet"]);
  assert.deepEqual(
    merged.sources.map(testingSettingsSourceLabel),
    ["stored (root)", "committed", "local"],
  );
  assert.equal(testingSettingsSourceLabel({ layer: "stored", scope: "apps/web" }), "stored (apps/web)");
});

test("with no committed file the base is the defaults, and an unset key says so", () => {
  const merged = mergeTestingLayers(null, { settings: stored({ tests: { patterns: ["t/*.ts"] } }), scope: "" }, null);
  assert.deepEqual(merged.config.tests, { patterns: ["t/*.ts"], includeImporters: true, smokeSet: [] });
  assert.deepEqual(merged.sources.map((source) => source.layer), ["stored", "default", "default"]);
  assert.equal(merged.config.flakes.label, "flaky-test", "flakes still come from the defaults");
});

test("without a stored layer the merge is exactly the committed-plus-local merge it replaces", () => {
  const base = committed({ tests: { patterns: ["t/*.ts"] }, flakes: { actionableAfter: 5 } });
  const override = local({ tests: { includeImporters: false } });
  const layered = mergeTestingLayers(base, null, override);
  const legacy = mergeTestingConfig(base, override);
  assert.deepEqual(layered.config, legacy.config);
  assert.deepEqual(layered.localKeys, legacy.localKeys);
});

test("the stored schema allows the three tests keys only, strict and within the limits", () => {
  assert.equal(StoredTestingSettingsSchema.safeParse({}).success, true);
  assert.equal(StoredTestingSettingsSchema.safeParse({
    tests: { patterns: ["a"], includeImporters: false, smokeSet: [] },
  }).success, true);
  // flakes is never stored: CI reads it, and CI cannot read this machine's database.
  const flakes = StoredTestingSettingsSchema.safeParse({ flakes: { label: "x" } });
  assert.equal(flakes.success, false);
  if (!flakes.success) assert.match(flakes.error.issues[0]!.message, /Unrecognized key.*flakes/);
  assert.equal(StoredTestingSettingsSchema.safeParse({ tests: { smokeSets: [] } }).success, false);
  assert.equal(StoredTestingSettingsSchema.safeParse({ tests: { patterns: "a" } }).success, false);
  assert.equal(StoredTestingSettingsSchema.safeParse({
    tests: { patterns: ["x".repeat(TESTING_CONFIG_LIMITS.pattern + 1)] },
  }).success, false);
  assert.equal(StoredTestingSettingsSchema.safeParse({
    tests: { smokeSet: Array.from({ length: TESTING_CONFIG_LIMITS.patterns + 1 }, (_, i) => `t${i}`) },
  }).success, false);
  assert.equal(StoredTestingSettingsSchema.safeParse({ tests: { patterns: [""] } }).success, false);
  assert.deepEqual(storedTestingSettingsKeys(stored({ tests: { smokeSet: [], includeImporters: true } })), [
    "tests.includeImporters",
    "tests.smokeSet",
  ]);
  assert.deepEqual(storedTestingSettingsKeys(stored({})), []);
});

test("the gate has settings when any layer exists, and is skipped when none does", () => {
  const tree = mkdtempSync(join(tmpdir(), "testing-layers-tree-"));
  const checkout = mkdtempSync(join(tmpdir(), "testing-layers-checkout-"));
  const root = (settings: unknown) => ({ settings: stored(settings), scope: "" });

  // No layer at all: skipped, and the note names all three.
  const none = readTestingConfig(tree, checkout, null);
  assert.equal(none.ok, false);
  if (!none.ok) {
    assert.equal(none.kind, "missing");
    assert.match(none.note, /\.mission\/testing\.json, no stored testing settings and no \.mission\/testing\.local\.json/);
  }
  // Without an operator checkout there is no local layer to find either.
  assert.equal(readTestingConfig(tree, null, null).ok, false);
  // A stored row that sets nothing is not a layer.
  const empty = readTestingConfig(tree, checkout, root({ tests: {} }));
  assert.equal(!empty.ok && empty.kind, "missing");

  // Stored settings and no committed file: the gate runs.
  const storedOnly = readTestingConfig(tree, checkout, root({ tests: { patterns: ["t/*.ts"] } }));
  assert.ok(storedOnly.ok);
  assert.deepEqual(storedOnly.merged.config.tests.patterns, ["t/*.ts"]);
  assert.equal(storedOnly.merged.sources[0]!.layer, "stored");

  // The local file alone is a layer too: it runs the gate over the defaults.
  mkdirSync(join(checkout, ".mission"));
  writeFileSync(join(checkout, ".mission/testing.local.json"), JSON.stringify({ tests: { patterns: ["l/*.ts"] } }));
  const localOnly = readTestingConfig(tree, checkout, null);
  assert.ok(localOnly.ok);
  assert.deepEqual(localOnly.merged.config.tests, { patterns: ["l/*.ts"], includeImporters: true, smokeSet: [] });
  assert.deepEqual(localOnly.merged.sources.map((source) => source.layer), ["local", "default", "default"]);
  assert.deepEqual(localOnly.merged.localKeys, ["tests.patterns"]);
  // An invalid local file with nothing else is the operator's machine, so unavailable, not skipped.
  writeFileSync(join(checkout, ".mission/testing.local.json"), "{\"tests\": {\"pattern\": []}}");
  const badLocalOnly = readTestingConfig(tree, checkout, null);
  assert.equal(!badLocalOnly.ok && badLocalOnly.kind, "invalid-local");
  writeFileSync(join(checkout, ".mission/testing.local.json"), JSON.stringify({ tests: { patterns: ["l/*.ts"] } }));
  // ...and it is still the last word over stored settings.
  const withLocal = readTestingConfig(tree, checkout, root({ tests: { patterns: ["t/*.ts"], smokeSet: ["t/s.ts"] } }));
  assert.ok(withLocal.ok);
  assert.deepEqual(withLocal.merged.config.tests.patterns, ["l/*.ts"]);
  assert.deepEqual(withLocal.merged.sources.map((source) => source.layer), ["local", "default", "stored"]);

  // The committed and local file rules are unchanged: an invalid committed file fails even with
  // stored settings beside it, and an invalid local file makes the gate unavailable.
  mkdirSync(join(tree, ".mission"));
  writeFileSync(join(tree, ".mission/testing.json"), "{\"tests\": {\"patterns\": \"x\"}}");
  const badCommitted = readTestingConfig(tree, checkout, root({ tests: { patterns: ["t/*.ts"] } }));
  assert.equal(!badCommitted.ok && badCommitted.kind, "invalid");
  writeFileSync(join(tree, ".mission/testing.json"), "{}");
  writeFileSync(join(checkout, ".mission/testing.local.json"), "{\"flakes\": {\"labl\": 1}}");
  const badLocal = readTestingConfig(tree, checkout, root({ tests: { patterns: ["t/*.ts"] } }));
  assert.equal(!badLocal.ok && badLocal.kind, "invalid-local");
});
