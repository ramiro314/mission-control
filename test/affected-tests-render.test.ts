import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowAffectedTestsReport } from "../src/shared/workflow.ts";
import { AffectedTestsDetails } from "../src/web/workflows/WorkflowRuns.tsx";
import { hasTooltip } from "./helpers/markup.ts";

const report = (over: Partial<WorkflowAffectedTestsReport> = {}): WorkflowAffectedTestsReport => ({
  selectedCount: 0,
  selected: [],
  flakeCount: 0,
  flakes: [],
  failureCount: 0,
  failures: [],
  settings: { patterns: ["test/**/*.test.ts"], includeImporters: true, smokeSet: [], localKeys: [] },
  ...over,
});

test("a long selection shows five inline and folds the rest, counting what is not listed", () => {
  const selected = Array.from({ length: 8 }, (_, i) => ({
    path: `test/t${i}.test.ts`,
    reason: i === 0 ? "changed" as const : i === 1 ? "smoke" as const : "imports" as const,
    ...(i > 1 ? { via: "src/a.ts" } : {}),
  }));
  const html = renderToStaticMarkup(createElement(AffectedTestsDetails, {
    report: report({ selectedCount: 60, selected }),
  }));
  assert.match(html, /Selected tests \(60\)/);
  const inline = html.slice(0, html.indexOf("<details"));
  assert.equal(inline.match(/<li>/g)?.length, 5);
  assert.match(inline, /\(changed\)/);
  assert.match(inline, /\(smoke set\)/);
  assert.match(inline, /\(imports src\/a\.ts\)/);
  // 3 more are listed in the fold, and 52 more lie beyond the stored cap.
  assert.match(html, /55 more selected/);
  assert.match(html, /52 more are not listed here/);
  assert.ok(hasTooltip(html, "Show the rest of the selected test files"));
});

test("flakes, twice-failed tests and local-override keys are each said", () => {
  const html = renderToStaticMarkup(createElement(AffectedTestsDetails, {
    report: report({
      selectedCount: 1,
      selected: [{ path: "test/a.test.ts", reason: "changed" }],
      flakeCount: 1,
      flakes: [{ file: "test/a.test.ts", name: "races" }],
      failureCount: 1,
      failures: [{ file: "test/a.test.ts", name: "adds", message: "1 !== 2" }],
      settings: { patterns: [], includeImporters: true, smokeSet: [], localKeys: ["tests.smokeSet"] },
    }),
  }));
  assert.match(html, /Local flakes \(1\)/);
  assert.match(html, /races \(test\/a\.test\.ts\)/);
  assert.match(html, /Failed twice \(1\)/);
  assert.match(html, /testing\.local\.json<\/code>: tests\.smokeSet/);
  assert.doesNotMatch(html, /<details/);
});

test("run detail names the source of every effective key, and keeps a local flakes key", () => {
  const html = renderToStaticMarkup(createElement(AffectedTestsDetails, {
    report: report({
      settings: {
        patterns: ["test/**/*.test.ts"],
        includeImporters: false,
        smokeSet: [],
        localKeys: ["flakes.windowDays", "tests.includeImporters"],
        sources: [
          { key: "tests.patterns", layer: "stored", scope: "" },
          { key: "tests.includeImporters", layer: "local", scope: null },
          { key: "tests.smokeSet", layer: "committed", scope: null },
        ],
      },
    }),
  }));
  assert.match(html, /Settings: <code>tests\.patterns<\/code> stored \(root\), <code>tests\.includeImporters<\/code> local, <code>tests\.smokeSet<\/code> committed/);
  assert.match(html, /Also from <code>\.mission\/testing\.local\.json<\/code>: flakes\.windowDays/);
  // An outcome recorded before sources existed keeps the line it always had.
  const legacy = renderToStaticMarkup(createElement(AffectedTestsDetails, {
    report: report({ settings: { patterns: [], includeImporters: true, smokeSet: [], localKeys: ["tests.smokeSet"] } }),
  }));
  assert.doesNotMatch(legacy, /Settings:/);
  assert.match(legacy, /testing\.local\.json<\/code>: tests\.smokeSet/);
});

test("run detail lists each subdirectory scope's sources and the selection notes, and counts unlisted scopes", () => {
  const html = renderToStaticMarkup(createElement(AffectedTestsDetails, {
    report: report({
      settings: {
        patterns: [],
        includeImporters: true,
        smokeSet: [],
        localKeys: [],
        sources: [
          { key: "tests.patterns", layer: "stored", scope: "" },
          { key: "tests.includeImporters", layer: "default", scope: null },
          { key: "tests.smokeSet", layer: "stored", scope: "" },
        ],
        scopes: [{
          path: "apps/web",
          sources: [
            { key: "tests.patterns", layer: "stored", scope: "apps/web" },
            { key: "tests.includeImporters", layer: "default", scope: null },
            { key: "tests.smokeSet", layer: "stored", scope: "" },
          ],
        }],
        scopeCount: 3,
      },
      diagnostics: ["Per-app aliases are not resolved yet."],
    }),
  }));
  assert.match(html, /<ul[^>]*aria-label="Testing scopes"><li><code>apps\/web<\/code>: <code>tests\.patterns<\/code> stored \(apps\/web\), <code>tests\.includeImporters<\/code> default, <code>tests\.smokeSet<\/code> stored \(root\)<\/li><\/ul>/);
  assert.match(html, /2 more testing scopes are not listed here\./);
  assert.match(html, /<h5>Selection notes<\/h5><ul aria-label="Selection notes"><li>Per-app aliases are not resolved yet\.<\/li><\/ul>/);

  // An outcome without scopes or notes shows neither.
  const plain = renderToStaticMarkup(createElement(AffectedTestsDetails, { report: report() }));
  assert.doesNotMatch(plain, /Testing scopes|Selection notes/);
});

test("a capped failure or flake list says how many it leaves out", () => {
  const failures = Array.from({ length: 20 }, (_, i) => ({ file: "test/a.test.ts", name: `f${i}`, message: "x" }));
  const html = renderToStaticMarkup(createElement(AffectedTestsDetails, {
    report: report({
      selectedCount: 1,
      selected: [{ path: "test/a.test.ts", reason: "changed" }],
      failureCount: 25,
      failures,
      flakeCount: 3,
      flakes: [{ file: null, name: "only one listed" }],
    }),
  }));
  assert.match(html, /Failed twice \(25\)/);
  assert.match(html, /Local flakes \(3\)/);
  assert.match(html, /5 more are not listed here/);
  assert.match(html, /2 more are not listed here/);
});

const partition = (over: Partial<NonNullable<WorkflowAffectedTestsReport["partitions"]>[number]> = {}) => ({
  subpath: "apps/web",
  command: ["npm", "test", "--", "{junit}", "{files}"],
  source: "override" as const,
  fileCount: 3,
  status: "passed" as const,
  exitCode: 0,
  note: "Ran 3 selected test files; all passed.",
  output: "web tail",
  truncatedBytes: 0,
  ...over,
});

test("each partition shows its folder, Command, file count, outcome and folded output tail", () => {
  const html = renderToStaticMarkup(createElement(AffectedTestsDetails, {
    report: report({
      selectedCount: 6,
      partitions: [
        partition({ subpath: "", source: "default", fileCount: 1, note: "Ran 1 selected test file; all passed.", output: "root tail" }),
        partition({ subpath: "apps/api", status: "failed", exitCode: 1, fileCount: 2, truncatedBytes: 40, output: "api tail" }),
        partition(),
      ],
    }),
  }));
  assert.match(html, /Partitions \(3\)/);
  assert.match(html, /<ul class="wf-run-partitions" aria-label="Partitions">/);
  assert.match(html, /aria-label="Partition repository root"[^]*?<code>repository root<\/code>[^]*?1 file · exit 0 · global default/);
  assert.match(html, /class="wf-run-partition is-failed" aria-label="Partition apps\/api"[^]*?>Failed<[^]*?2 files · exit 1</);
  assert.match(html, /<code class="wf-run-partition-command">npm test -- \{junit\} \{files\}<\/code>/);
  assert.match(html, /<pre class="wf-run-partition-output">api tail<\/pre>[^]*?Earlier 40 bytes of output were omitted\./);
  assert.ok(hasTooltip(html, "Show the end of this partition's output"));
});

test("selected tests no Command could run are every one listed apart, with the gate's rule said", () => {
  const unrun = Array.from({ length: 7 }, (_, i) => `packages/p${i}/a.test.ts`);
  const html = renderToStaticMarkup(createElement(AffectedTestsDetails, {
    report: report({ selectedCount: 7, unrun }),
  }));
  assert.match(html, /Selected but unrun \(7\)/);
  assert.match(html, /The gate decided on the partitions that ran\./);
  // Five inline, and the other two folded beneath them: every one is listed.
  assert.match(html, /<ul aria-label="Selected but unrun tests"><li><code>packages\/p0\/a\.test\.ts<\/code><\/li>/);
  assert.match(html, /<summary[^>]*>2 more unrun<\/summary>[^]*?<ul aria-label="More selected but unrun tests">/);
  for (const path of unrun) assert.ok(html.includes(`<li><code>${path}</code></li>`), path);
  assert.ok(hasTooltip(html, "Show the rest of the selected tests that did not run"));
  assert.doesNotMatch(html, /not listed here/);
});

test("an outcome recorded before partitions existed shows neither section", () => {
  const html = renderToStaticMarkup(createElement(AffectedTestsDetails, { report: report({ selectedCount: 1 }) }));
  assert.doesNotMatch(html, /Partitions|Selected but unrun/);
});
