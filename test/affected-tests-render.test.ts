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
  flakes: [],
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
      flakes: [{ file: "test/a.test.ts", name: "races" }],
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
