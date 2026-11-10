import { useState } from "react";
import type { WorkflowConfig, WorkflowSummary } from "@shared/workflow.ts";
import type { WorkflowSettingsState } from "../useWorkflowSettings.ts";
import type { SkillsState } from "../useSkills.ts";
import {
  BUILTIN_KIND_WORKFLOW_DEFAULTS,
  HARNESS_LAUNCHED_TASK_KINDS,
  TASK_KIND_INFO,
  taskDefaultWorkflowId,
} from "@shared/task.ts";
import { Tooltip } from "./Tooltip.tsx";
import { ConsoleCard } from "./settings-console.tsx";

/** Select values for a dispatch-default row that follows its built-in, or is explicitly None. */
const BUILTIN_OPTION = "__builtin";
const NONE_OPTION = "__none";

// Settings that shape what each kind of task is dispatched with.
//
// The per-kind after-work Workflow rows used to be a card under Settings › Workflows. They
// moved here because they are a property of the task kind, not of the Workflow subsystem's
// policy, and this category is where other per-kind task settings land. The rows still write
// the Workflow config's `kindWorkflowDefaults`, through the same `useWorkflowSettings` state
// Settings › Workflows and Trust read, so no screen polls a second copy of that blob.
//
// Grill me first is the Plan kind's own setting. It is stored with the other plan policy in
// the Skills config, because like Plan storage it is pinned on each plan task at creation,
// and it is drawn from the same `useSkills` state Settings › Skills reads.
export function TaskSettingsPanel({
  state,
  skills,
  workflows = [],
  foremanEnabled = false,
}: {
  state: WorkflowSettingsState;
  /** The Skills config and catalog, which carry the Grill me first default. */
  skills?: SkillsState;
  /** Live catalog; only active published workflows are valid dispatch defaults. */
  workflows?: WorkflowSummary[];
  /** The completion detector that turns the default into an automatic run. */
  foremanEnabled?: boolean;
}): React.JSX.Element {
  const { config, update, error } = state;
  const [busy, setBusy] = useState(false);
  const publishedWorkflows = workflows.filter(
    (workflow) => workflow.archivedAt === null && workflow.currentVersionId !== null,
  );

  const save = async (next: WorkflowConfig): Promise<void> => {
    setBusy(true);
    try {
      await update(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section sc-section">
      <p className="settings-hint sc-lede">
        What each kind of task starts with when nothing names its own choice: a task from the
        dispatch form, the API, a task source or a recurring mission alike.
      </p>

      {!config && (
        <p className="settings-warn">
          Can't reach the daemon, so the stored defaults are unknown. The controls below are
          showing defaults, not its current state.
        </p>
      )}

      <ConsoleCard title="Dispatch defaults" anchor="tasks/dispatch-defaults">
        <p className="settings-hint">
          The Workflow each kind of task arms after its work. The dispatch form shows this
          choice inline and can override it per task. Built-in defaults follow Mission
          Control; a Workflow you choose here stays until you change it.
        </p>
        <div className="wf-default-rows">
          {HARNESS_LAUNCHED_TASK_KINDS.map((kind) => {
            const label = TASK_KIND_INFO[kind].label;
            const chosen = config?.kindWorkflowDefaults[kind];
            const builtinId = BUILTIN_KIND_WORKFLOW_DEFAULTS[kind];
            const builtinName = builtinId
              ? workflows.find((workflow) => workflow.id === builtinId)?.name ?? "unavailable Workflow"
              : "None";
            const unavailable = typeof chosen === "string"
              && !publishedWorkflows.some((workflow) => workflow.id === chosen);
            return (
              <div className="wf-default-row" key={kind}>
                <span className="wf-default-kind" aria-hidden>{label}</span>
                <Tooltip label={`Workflow preselected for every new ${label} task`}>
                  <select
                    className="field-input wf-default-select"
                    value={chosen === undefined ? BUILTIN_OPTION : chosen ?? NONE_OPTION}
                    disabled={!config || busy}
                    aria-label={`Default after-work Workflow for ${label} tasks`}
                    onChange={(event) => {
                      if (!config) return;
                      const { [kind]: _previous, ...rest } = config.kindWorkflowDefaults;
                      const value = event.target.value;
                      void save({
                        ...config,
                        kindWorkflowDefaults: value === BUILTIN_OPTION
                          ? rest
                          : { ...rest, [kind]: value === NONE_OPTION ? null : value },
                      });
                    }}
                  >
                    <option value={BUILTIN_OPTION}>Built-in default ({builtinName})</option>
                    <option value={NONE_OPTION}>None</option>
                    {publishedWorkflows.map((workflow) => (
                      <option key={workflow.id} value={workflow.id}>
                        {workflow.name} · v{workflow.publishedVersion}
                      </option>
                    ))}
                    {unavailable && <option value={chosen}>Unavailable Workflow</option>}
                  </select>
                </Tooltip>
              </div>
            );
          })}
        </div>
        {config
          && HARNESS_LAUNCHED_TASK_KINDS.some(
            (kind) => taskDefaultWorkflowId(kind, config.kindWorkflowDefaults) !== null,
          )
          && !foremanEnabled && (
          <p className="settings-warn wf-default-warning">
            Foreman is off. Turn it on before dispatching with these defaults, or choose None
            in the dispatch form.
          </p>
        )}
        {publishedWorkflows.length === 0 && (
          <p className="settings-hint wf-settings-empty">
            Publish a Workflow before choosing a dispatch default.
          </p>
        )}
      </ConsoleCard>

      {skills && <GrillFirstCard skills={skills} />}

      {error && <p className="settings-error" role="alert">{error}</p>}
    </section>
  );
}

/** The `grill` skill a Grill me first plan task invokes before drafting. */
const GRILL_SKILL_ID = "grill";

/**
 * Plan tasks: the Grill me first default every new plan task is pinned with. The dispatch
 * form overrides it per task. Says so when the skill it needs is off, because the dispatch
 * gate then refuses every plan task this default turns it on for.
 */
function GrillFirstCard({ skills }: { skills: SkillsState }): React.JSX.Element {
  const { view, update, error } = skills;
  const grill = view?.skills.find((row) => row.id === GRILL_SKILL_ID);
  const grillOff = view !== null && (!view.enabled || grill?.enabled !== true);
  return (
    <ConsoleCard title="Plan tasks" anchor="tasks/grill-first">
      <div className="kb-row">
        <div className="kb-row-text">
          <label className="kb-row-label" htmlFor="plan-grill-first">Grill me first</label>
          <span className="kb-row-desc">
            A new plan task interviews you in rounds of decision forms, each asking every
            question that can be asked so far, before it drafts the plan. The plan is then
            written, reviewed and optionally phased as usual. The dispatch form can turn it on
            or off per task; existing tasks keep what they were filed with.
          </span>
        </div>
        <Tooltip label="Default for new plan tasks: interview me before the plan is drafted">
          <input
            id="plan-grill-first"
            type="checkbox"
            checked={view?.planGrillFirst ?? false}
            disabled={!view}
            onChange={(event) => void update({ planGrillFirst: event.target.checked })}
          />
        </Tooltip>
      </div>
      {view?.planGrillFirst && grillOff && (
        <p className="settings-warn">
          The grill skill is off, so a plan task that grills first is refused at dispatch.
          Turn it on under Settings › Skills.
        </p>
      )}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </ConsoleCard>
  );
}
