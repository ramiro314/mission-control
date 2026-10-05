import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currentMergeability,
  nextMergeability,
  prMergeableFromGitHub,
} from "../src/shared/pr-mergeable.ts";

const NONE = { prMergeable: null, prBaseRef: null, prHeadSha: null };

test("GitHub's MERGEABLE and CONFLICTING are states, UNKNOWN is no observation", () => {
  assert.equal(prMergeableFromGitHub("MERGEABLE"), "mergeable");
  assert.equal(prMergeableFromGitHub("CONFLICTING"), "conflicting");
  assert.equal(prMergeableFromGitHub("UNKNOWN"), null);
  assert.equal(prMergeableFromGitHub(undefined), null);
});

test("currentMergeability answers only for the head the observation was made on", () => {
  const observed = { state: "conflicting", headSha: "A" } as const;
  assert.equal(currentMergeability({ prMergeable: observed, prHeadSha: "A" }), "conflicting");
  assert.equal(currentMergeability({ prMergeable: observed, prHeadSha: "B" }), null);
  assert.equal(currentMergeability({ prMergeable: null, prHeadSha: "A" }), null);
});

test("a definitive read is bound to its head; UNKNOWN advances the head and keeps the rest", () => {
  const a = nextMergeability(NONE, { open: true, mergeable: "conflicting", baseRef: "main", headSha: "A" });
  assert.deepEqual(a, {
    prMergeable: { state: "conflicting", headSha: "A" },
    prBaseRef: "main",
    prHeadSha: "A",
  });

  const b = nextMergeability(a, { open: true, mergeable: null, baseRef: "main", headSha: "B" });
  assert.deepEqual(b.prMergeable, { state: "conflicting", headSha: "A" }, "kept whole, old head included");
  assert.equal(b.prHeadSha, "B");
  assert.equal(currentMergeability(b), null, "unknown on B, never conflicting on B");

  const resolved = nextMergeability(b, { open: true, mergeable: "mergeable", baseRef: "main", headSha: "B" });
  assert.equal(currentMergeability(resolved), "mergeable");
});

test("a merged or closed pull request has no mergeability", () => {
  const a = nextMergeability(NONE, { open: true, mergeable: "conflicting", baseRef: "main", headSha: "A" });
  const merged = nextMergeability(a, { open: false, mergeable: null, baseRef: "main", headSha: "A" });
  assert.equal(merged.prMergeable, null);
  assert.equal(currentMergeability(merged), null);
});
