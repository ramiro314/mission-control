# Phase 5: The testing setup skill

Part of [flake-aware testing](plan.md). Index: [phased-plan.md](phased-plan.md).

## 1. Outcome

Any repository can be brought into the flake-aware testing contract in one supervised task. A
**Set up flake-aware testing** action on a repository starts an agent with the `testing-setup`
skill. The agent audits the repository, proposes every change in one approval form, then opens a
PR (CI and test-script changes, the copied report action, `.mission/testing.json`, the `.gitignore`
entry) and sets the repository's `affected-tests` command in Mission Control. Finally it proves the
setup works: one local `affected-tests` run, and the "Flaky tests" check on the setup PR's own CI.
Run again later, it finds an outdated copy of the report action and offers the update.

## 2. Entry criteria and dependencies

- Phase 4 merged: the full contract exists (the `affected-tests` slot, the report action, Wait for
  CI, and the Affected tests workflow the skill recommends binding).

## 3. Scope and non-goals

In scope:

- The `testing-setup` skill in `skills/`.
- A second generated copy of the report action under the skill's assets.
- The repository row action and the route that starts the task.
- A narrowly scoped Mission MCP tool that sets the session repository's `affected-tests` command
  override, used only after the human approved it in the form.

Non-goals:

- Changing Phase 3's action source or format.
- Setting kind defaults to the new workflow. The skill may recommend it; it does not change it.
- Repositories not on GitHub.

## 4. Repository findings and inherited contracts

- Skills are `skills/<id>/SKILL.md` directories scanned by `readCatalog()` (no separate catalog
  file). Frontmatter needs a native-valid `name`, a one-line `description`,
  `metadata.mission.category` and `metadata.mission.enforcement`. `skills/` ships in the packaged
  app as source; `.github/` does not.
- Precedent for a UI action that starts a skill-driven task: retro. `dispatchRetroTask`
  (`src/server/retro.ts`) gates on the skill first (`skillInvocationForAgent`), then creates a task
  whose intent says "Invoke the retro skill and follow it". Tours show create-then-dispatch
  (`runTourRecipe`).
- There is **no per-repository action menu**. The Trust panel (`TrustPanel.tsx`) is the only
  per-repository row surface.
- New routes must be registered in the telemetry action registries or exclusions, or
  `test/telemetry-primary-actions.test.ts` fails, and the route-surface oracle fixture must be
  regenerated (`test/fixtures/route-surface.json`).
- Command overrides are machine-local rows (`workflow_command_overrides`) edited through
  `PUT /api/workflow-commands/:slot`. MCP tools reach the daemon over HTTP; nothing but the daemon
  writes SQLite.
- The generator from Phase 3 (`scripts/build-flake-report-action.ts`) is the only producer of the
  action bundle, with a drift test.
- Plan decision forms are `request_plan_decisions`.

## 5. Implementation steps

1. **Asset copy.** Extend the Phase 3 generator to also write the action into
   `skills/testing-setup/assets/mission-flake-report/`, and extend its drift test to both outputs.
   The bundle header's version is what the skill compares.
2. **The skill** `skills/testing-setup/SKILL.md` (category matching the existing shipping skills,
   enforcement `triggered`). It instructs the agent to:
   - **Audit** the repository: the test runner and whether it emits JUnit XML; a rerun command
     template with `{files}` and `{junit}`; whether CI runs the report action (and its version
     against the asset's); job-level `checks: write` and `issues: write` on the publish job; the
     check created on the PR head commit; an existing `.mission/testing.json` and the `.gitignore`
     entry for the local file; test-file patterns; and a proposed smoke set (registry-style,
     cross-cutting tests, with the reason for each).
   - **Propose** every change in one `request_plan_decisions` form: the CI diff summary, the
     `.mission/testing.json` content, the smoke set (multi-select), the `affected-tests` command
     template, and whether to recommend binding the Affected tests workflow.
   - **Apply** only what was approved: copy the action from its assets, edit CI and test scripts,
     write `.mission/testing.json` and the `.gitignore` entry, open one PR (following the
     pull-request skill), and set the command override with the MCP tool below.
   - **Verify**: run the `affected-tests` command once locally against the selection for a small
     sample; confirm the "Flaky tests" check appears on the setup PR's own CI run; report both.
   - **Re-run**: when the action exists but its version is older than the asset's, propose the
     update as the only change.
   - Mention the laptop settings from Phase 1 (`checkTestLease`, `checkTestConcurrency`) and where
     to find them.
3. **MCP tool** `set_affected_tests_command`: sets the `affected-tests` command override for the
   calling session's repository only, validates the template (must contain `{files}` and `{junit}`),
   goes through the daemon's existing command route, and is refused for any other slot or
   repository. Its description states it may be used only after the human approved the command in
   a decision form.
4. **Start route** `POST /api/repositories/testing-setup` with `{ repoRoot }`: resolve the
   repository, gate on the skill (the same refusal wording as retro), create a ship task whose
   intent invokes the skill, and dispatch it as a manual launch. Register it in the telemetry
   registry and regenerate the route-surface fixture.
5. **Row action** in `TrustPanel.tsx`: a "Set up flake-aware testing" control on each repository
   row, calling the route and showing the refusal inline, the way other panels do.
6. **Docs.** `docs/flaky-tests.md` (setting up a repository) and `docs/skills-and-settings.md` (the
   new skill).

## 6. Data, API and compatibility

- No migration.
- The route and MCP tool are additive. The MCP tool cannot reach any slot but `affected-tests`, or
  any repository but the session's.
- The skill must be enabled like every bundled skill; the route refuses with the standard sentence
  when it is not.

## 7. Tests and verification

- `test/skills-catalog.test.ts`: the new skill parses; a content test pins the audit list, the single
  approval form, "apply only what was approved", and both verification steps.
- The generator drift test covers both outputs.
- Route: skill-off refusal, task created with the skill-invoking intent and dispatched; telemetry
  manifest and route-surface oracle updated.
- MCP tool: sets only the session repository's `affected-tests` override; refuses other slots,
  repositories, and templates missing a placeholder.
- `e2e/`: the Trust panel row shows the action; clicking it with the skill off shows the refusal;
  with it on, a task is created (fake agents only).
- Dogfood: run the skill against this repository (already set up by Phases 2 and 3). It should find
  nothing to change except anything missed, which is the proof the audit reads a set-up repository
  correctly.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e` for the new spec.

## 8. Merge and exit criteria

- On a repository without the contract, the skill produces one approval form and, after approval,
  one PR whose own CI shows the "Flaky tests" check, and the repository's `affected-tests` command
  is set.
- On this repository it reports no changes needed.

## 9. Downstream handoff

- Skill id `testing-setup`, the asset path, and the MCP tool name. No later phase depends on them.

## 10. Cross-phase audit

- Against Phase 3: uses the generator as the only bundle producer; adds an output, not a fork.
- Against Phase 4: recommends the workflow by its id and explains block codes in its verification
  report.
- Against Phase 1: points at the lease and concurrency settings by name.
