# Phase 2: The `affected-tests` check

Part of [flake-aware testing](plan.md). Index: [phased-plan.md](phased-plan.md).

## 1. Outcome

A workflow can run only the tests a change touched. A new Command slot, `affected-tests`, takes a
command template with `{files}` and `{junit}` placeholders. Mission Control picks the tests from
the project's `.mission/testing.json`, runs them, reruns the failures once, and fails the check only
for tests that fail twice. The repair packet names the failing tests and their messages, read from
JUnit, instead of quoting the end of the output.

## 2. Entry criteria and dependencies

- Phase 1 merged: `slotRunsTests(slot)` exists and the test lease is taken inside the executor.

## 3. Scope and non-goals

In scope:

- The `affected-tests` slot in every place slots are enumerated.
- `.mission/testing.json` and `.mission/testing.local.json`: schema, reading and merging.
- Test selection: changed tests, JS/TS importers of changed files, and the smoke set.
- The template contract, one local rerun, JUnit parsing, JUnit-based repair packets.
- Showing the selection and any local flakes in run detail.

Non-goals:

- Any change to CI, the report action, or flake issues (Phase 3). This phase owns the `flakes` block
  of the config schema only as a schema; nothing reads it yet.
- The new built-in workflow (Phase 4). Existing workflows keep `Check(test)`.
- Import resolution for languages other than JS/TS.

## 4. Repository findings and inherited contracts

- `WORKFLOW_CHECK_SLOTS` (`src/shared/workflow.ts`, about line 1974) is **append-only**, because a
  slot id is stored in published graphs. Append `affected-tests`; never reorder.
- Places that must learn the slot (from the investigation; re-grep `WORKFLOW_CHECK_SLOTS` and
  `WorkflowCheckSlot` before starting):
  - `WORKFLOW_COMMAND_PURPOSE` (a `Record`, so typecheck points at it)
  - zod enums in `src/shared/protocol.ts` for draft and published check nodes, the command, check
    evidence and check outcome
  - `check-runtime.ts defaultCheckTimeoutMs`: `test` gets 60 minutes, others 10. `affected-tests`
    must get the test timeout.
  - Settings backups: `src/server/settings-backups/catalogs.ts` and `restore.ts`, which **refuses
    a snapshot missing a Command slot**. A snapshot taken before this phase has no
    `affected-tests`; restore must accept it with an unconfigured slot.
  - UI: `CommandLibrary.tsx` (built-in slots rail), `PipelineEditor.tsx`,
    `WorkflowProperties.tsx`, `WorkflowLibrary.tsx` palette, `new-node.ts`,
    `useWorkflowRoute.ts`, `library-model.ts`, `settings-search.ts` keywords, the library tour.
  - Tests that assert the literal list: `test/workflow-check-node.test.ts`,
    `test/library-page-render.test.ts`, `test/workflow-pipeline-render.test.ts`,
    `e2e/specs/library-commands.spec.ts`.
- The store seeds slot rows lazily with `INSERT OR IGNORE`, so **no migration** is needed.
- Execution: `runCheck` (`checks.ts`) resolves the command, reserves the run budget, then calls the
  executor. Nothing may await between reservation and spawn, so selection, rerun and parsing all
  run **inside the executor** (`check-runtime.ts`), within one worktree lease and one test lease
  (Phase 1).
- The check tree is a detached worktree at the head commit sharing the main repository's refs, so
  `git merge-base` against the local `origin` default ref works without a fetch. Reuse
  `src/server/diff.ts` (`sourceRef`, `changedPathsSince`) rather than a new git helper.
  Ignored files are **not reliably present** in the check tree, so `.mission/testing.local.json`
  is read from the session's main checkout (`binding.sessionRepoRoot`), and the committed
  `.mission/testing.json` from the check tree.
- Recorded commands are capped at 32 arguments (`checkCommandArgs`). The outcome and evidence must
  record the **template**, never the argv expanded with `{files}`.
- `WorkflowCheckOutcome` and its zod schema (`WorkflowCheckOutcomeSchema`, a non-strict object that
  strips unknown keys) must both gain any new field, or readers drop it.
- Repo file reading precedent: `src/server/util/repo-doc.ts readRepoDoc` (realpath, containment,
  capped read). Use it for both config files.
- No XML parser, glob or import-graph library is available at runtime, and the packaged app ships
  no `node_modules`. `path.matchesGlob` exists on Node 24 and 26. Node's JUnit reporter puts a
  `file` attribute on every `<testcase>` on Node 24 and 26; a failure is a `<failure>` child with a
  `message` attribute.
- `checkVerdict` (`engine.ts`) builds the repair packet from the output tail. It is the one place
  to change for JUnit-based requested changes.

## 5. Implementation steps

1. **Slot.** Append `"affected-tests"` to `WORKFLOW_CHECK_SLOTS`, add its purpose sentence, make
   `slotRunsTests` return true for it, give it the test timeout, and follow typecheck through every
   `Record` and enum listed above. Update the literal-list tests.
2. **Config schema** in `src/shared/testing-config.ts` (browser-safe, no `node:` imports):
   - `TestingConfigSchema` (zod) with `tests: { patterns: string[], includeImporters: boolean,
     smokeSet: string[] }` and `flakes: { label, actionableLabel, actionableAfter, windowDays }`
     with the defaults in the source plan (`flaky-test`, `flaky-test:actionable`, 3, 30).
   - `mergeTestingConfig(committed, local)`: key by key, a list replaces a list, and it returns
     which keys came from the local file.
   - Unknown keys are refused with a readable error (a typo must not silently do nothing).
3. **Config reader** in `src/server/testing-config.ts`: read `.mission/testing.json` from the check
   tree and `.mission/testing.local.json` from the main checkout with `readRepoDoc`, parse, merge.
   A missing committed file means the check cannot select and is **skipped with a note** naming the
   file, like an unconfigured slot.
4. **JUnit parser** in `src/shared/junit.ts`: parse the subset the runners emit (`testsuites`,
   `testsuite`, `testcase` with `name`, `file`, `classname`, and `failure`/`error` children with
   `message` and text). No dependency. Return `{ cases: [{ file, name, status, message, detail }] }`
   and refuse malformed input with a readable error. Keep it pure so Phase 3 bundles it into the
   report action.
5. **Selection** in `src/server/test-selection.ts`:
   - changed files: `changedPathsSince(treePath)` against the default branch's merge base
   - (1) changed files matching `tests.patterns` (via `path.matchesGlob`)
   - (2) when `includeImporters`: build a reverse import map of JS/TS files under the patterns'
     roots with a lexical scanner (static `import`/`export ... from`, `import()`, `require()` with
     string literals), resolving relative specifiers and `tsconfig.json` `compilerOptions.paths`
     aliases, and add every test that reaches a changed file transitively. Unresolvable
     specifiers are ignored.
   - (3) every file matching `tests.smokeSet`
   - Return the sorted, de-duplicated list plus a reason per file (changed, imports X, smoke) for
     run detail. Cap the list for display only; the command receives every file.
6. **Template expansion.** In the executor, replace an argv element that is exactly `{files}` with
   one argv element per selected file, and substitute `{junit}` with a path in a per-attempt temp
   directory. A template without `{files}` or `{junit}` is refused when saved (validation in the
   command catalog for this slot only) and, defensively, fails the check with a note if found at
   run time.
7. **Run, parse, rerun** inside one executor call:
   - empty selection: skip with a note ("No tests were selected for this change.")
   - run; if the exit code is 0, pass
   - on failure, parse `{junit}`. Unparseable or missing results: fail with the output tail, as
     today, and a note saying the results could not be read.
   - rerun only the failed files once with a fresh `{junit}` path; tests failing in both runs are
     **real failures**; tests that failed then passed are **local flakes**
   - the check fails only when real failures exist
8. **Outcome and repair packet.**
   - Add optional `selection` (count, capped file list with reasons) and `flakes` (list of
     `{ file, name }`) to `WorkflowCheckOutcome` and its schema.
   - The note states counts ("Ran 14 selected tests; 1 flaked and passed on rerun.").
   - `checkVerdict` emits one requested change per failing test (title with the test name, rationale
     from its JUnit message and detail, capped), falling back to today's tail when no JUnit exists.
9. **Run detail UI.** `WorkflowRuns.tsx` `CheckCard` shows the selection (with reasons, collapsed
   past a few) and any local flakes. The outcome also records the effective testing settings with
   the keys that came from `.mission/testing.local.json`, and the card lists those keys, so a
   selection shaped by a local override is visible where it matters.
10. **Docs.** `docs/workflows.md`: the new slot, the template contract, the selection rules, and
    `.mission/testing.json` with its local override. Add `.mission/testing.local.json` to this
    repository's `.gitignore` and commit a `.mission/testing.json` for this repository (patterns
    `test/**/*.test.ts`, importers on, a smoke set of the registry-style tests such as
    `test/route-surface-oracle.test.ts` and `test/telemetry-primary-actions.test.ts`).

## 6. Data, API and compatibility

- No migration. The slot row is seeded lazily; old databases read an unconfigured slot.
- Published graphs are unaffected; nothing uses the slot until a workflow adds it.
- Settings backup restore accepts snapshots without the new slot.
- `.mission/testing.json` is a new, versionless file. Its schema is owned here; Phase 3 reads the
  `flakes` block, and changes to it after this phase must stay backward compatible.

## 7. Tests and verification

- `test/junit.test.ts`: Node 24/26 reporter output samples (flat and `describe` suites), failures
  with messages, malformed input.
- `test/testing-config.test.ts`: defaults, unknown key refusal, key-by-key merge with lists
  replacing, provenance of local keys.
- `test/test-selection.test.ts`: a fixture repository with changed test files, a changed source
  file imported directly and transitively (relative and `@shared` alias), smoke set, and no
  changes.
- Executor tests with a stub spawn: empty selection skip; pass; fail then pass on rerun (flake,
  check passes); fail twice (check fails, one requested change per test); missing JUnit fallback;
  the recorded command is the template.
- Settings backup restore of a pre-slot snapshot.
- Literal slot-list tests updated.
- `e2e/`: a spec that configures the `affected-tests` command in the Library and shows the slot in
  the Commands rail; and a run-detail spec showing a check with a selection and a local flake,
  seeded the way existing run-detail specs seed runs.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e` for the new specs.

## 8. Merge and exit criteria

- With `.mission/testing.json` committed and the slot's command set to
  `node --test --import ./test/setup-state.mjs --import tsx --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination={junit} {files}`,
  a workflow using `Check(affected-tests)` on a small change in this repository runs only the
  selected tests, under the Phase 1 lease.
- A forced flaky test passes the check and is listed as a local flake; a forced failure fails it with
  the test named in the repair packet.

## 9. Downstream handoff

Later phases may rely on, and must not change:

- The slot id `affected-tests`.
- `src/shared/testing-config.ts`: the schema (including the `flakes` block and its defaults) and
  `mergeTestingConfig`.
- `src/shared/junit.ts`: pure, dependency-free, safe to bundle into the report action.
- The template placeholders `{files}` (one argv element per file) and `{junit}` (one results path).
- The rule that outcomes record the template, not the expanded argv.

## 10. Cross-phase audit

- Against Phase 1: the rerun loop runs inside one executor call, so it holds the test lease once for
  select, run and rerun. `slotRunsTests` is extended here, not redefined.
- Phase 3's audit confirmed `junit.ts` and `testing-config.ts` are browser-safe and bundle into the
  action unchanged.
- Final audit: added the effective-settings provenance to step 9. The source plan requires Mission
  Control to show which values came from the local file, and no other phase owned it.
