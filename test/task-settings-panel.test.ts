import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskSettingsPanel } from "../src/web/components/TaskSettingsPanel.tsx";
import type { WorkflowSettingsState } from "../src/web/useWorkflowSettings.ts";
import type { SkillsState } from "../src/web/useSkills.ts";
import type { SkillsView } from "../src/shared/types.ts";
import { DEFAULT_WORKFLOW_CONFIG, type WorkflowSummary } from "../src/shared/workflow.ts";

const REVIEW: WorkflowSummary = {
  id: "workflow-review",
  name: "Release review",
  description: "",
  draftRevision: 2,
  currentVersionId: "version-2",
  publishedVersion: 2,
  archivedAt: null,
  updatedAt: 1,
  errorCount: 0,
  warningCount: 0,
  nodeCount: 3,
  personaCount: 1,
  builtin: false,
};

function render(
  config: WorkflowSettingsState["config"],
  props: { foremanEnabled?: boolean; workflows?: WorkflowSummary[]; skills?: SkillsState } = {},
): string {
  const state: WorkflowSettingsState = {
    config,
    status: null,
    testEvidenceAudit: null,
    update: async () => true,
    error: null,
  };
  return renderToStaticMarkup(createElement(TaskSettingsPanel, { state, ...props }));
}

test("the Tasks panel offers one dispatch default per task kind", () => {
  const html = render(
    { ...DEFAULT_WORKFLOW_CONFIG, kindWorkflowDefaults: { bugfix: "workflow-review", scout: null } },
    { foremanEnabled: true, workflows: [REVIEW] },
  );
  assert.match(html, /Dispatch defaults/);
  assert.match(html, /data-anchor="tasks\/dispatch-defaults"/);
  for (const kind of ["ship", "bugfix", "document", "plan", "shape", "scout", "chat"]) {
    assert.match(html, new RegExp(`aria-label="Default after-work Workflow for ${kind} tasks"`));
  }
  assert.doesNotMatch(html, /for pipeline tasks/, "Conductor owns what runs after a pipeline");
  assert.match(html, /Release review · v2/);
  // A row with nothing stored says what it resolves to; the built-in catalog is not in this
  // fixture, so a built-in Workflow is named as unavailable and a None built-in as None.
  assert.match(html, /Built-in default \(unavailable Workflow\)/);
  assert.match(html, /Built-in default \(None\)/);
  // The selected option of each row is the stored choice.
  assert.match(html, /<option value="workflow-review" selected="">Release review · v2<\/option>/);
  assert.doesNotMatch(html, /Foreman is off/);
});

test("before the daemon answers, the rows are drawn disabled on their anchor", () => {
  const html = render(null);
  assert.match(html, /data-anchor="tasks\/dispatch-defaults"/);
  assert.match(html, /Can&#x27;t reach the daemon/);
  assert.match(html, /<select[^>]*disabled=""[^>]*aria-label="Default after-work Workflow for ship tasks"/);
});

test("a default that arms a Workflow while Foreman is off says so", () => {
  const html = render(DEFAULT_WORKFLOW_CONFIG, { foremanEnabled: false, workflows: [REVIEW] });
  assert.match(html, /Foreman is off/);
});

function skills(view: Partial<SkillsView> | null): SkillsState {
  return {
    view: view && {
      alwaysDraftPr: false,
      commitPlanHtml: false,
      planStorage: "repository",
      planGrillFirst: false,
      enabled: true,
      skills: [{ id: "grill", name: "grill", description: "", category: "planning", enforcement: "triggered", enabled: true }],
      pending: 0,
      problems: [],
      ...view,
    },
    update: async () => {},
    error: null,
  };
}

test("the Plan tasks card carries the Grill me first default on its anchor", () => {
  const off = render(DEFAULT_WORKFLOW_CONFIG, { skills: skills({}) });
  assert.match(off, /data-anchor="tasks\/grill-first"/);
  assert.match(off, /Plan tasks/);
  assert.match(off, /<label class="kb-row-label" for="plan-grill-first">Grill me first<\/label>/);
  assert.match(off, /<input id="plan-grill-first" type="checkbox" aria-describedby="[^"]+"\/>/);
  const on = render(DEFAULT_WORKFLOW_CONFIG, { skills: skills({ planGrillFirst: true }) });
  assert.match(on, /<input id="plan-grill-first" type="checkbox"[^>]* checked=""/);
  assert.doesNotMatch(on, /The grill skill is off/);
});

test("a Grill me first default whose skill is off says the dispatch would be refused", () => {
  const grillOff = skills({
    planGrillFirst: true,
    skills: [{ id: "grill", name: "grill", description: "", category: "planning", enforcement: "triggered", enabled: false }],
  });
  assert.match(render(DEFAULT_WORKFLOW_CONFIG, { skills: grillOff }), /The grill skill is off/);
  assert.match(render(DEFAULT_WORKFLOW_CONFIG, { skills: skills({ planGrillFirst: true, enabled: false }) }), /The grill skill is off/);
  // Off, nothing is refused, so nothing is said.
  assert.doesNotMatch(render(DEFAULT_WORKFLOW_CONFIG, { skills: { ...grillOff, view: { ...grillOff.view!, planGrillFirst: false } } }), /The grill skill is off/);
});

test("before the Skills config answers, the Grill me first box is drawn disabled", () => {
  assert.match(render(DEFAULT_WORKFLOW_CONFIG, { skills: skills(null) }), /<input id="plan-grill-first" type="checkbox"[^>]* disabled=""/);
});
