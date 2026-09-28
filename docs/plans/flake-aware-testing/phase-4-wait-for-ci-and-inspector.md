# Phase 4: Wait for CI, the Affected tests workflow, and the Inspector's flake reading

Part of [flake-aware testing](plan.md). Index: [phased-plan.md](phased-plan.md).

## 1. Outcome

A workflow can rely on the full suite in GitHub CI. A new **Wait for CI** node, placed after the
Pull Request action, watches the PR head commit's checks. It passes on green (including green with
flakes), sends a repair packet naming each failing check on a real failure, and blocks the run with
a plain reason when CI times out, is missing, or has no "Flaky tests" check. A new built-in workflow,
**No-Mistakes Review (Affected tests)**, uses `Check(affected-tests)` locally and Wait for CI after
the PR. The Inspector reads the same "Flaky tests" summary and raises a flake only when the PR
plausibly caused it.

## 2. Entry criteria and dependencies

- Phase 3 merged: `FLAKY_TESTS_CHECK_NAME`, `parseFlakeSummary`, and this repository's CI creating
  the check on the PR head commit.
- Phase 2's `affected-tests` slot exists (through Phase 3).

## 3. Scope and non-goals

In scope:

- The Inspector's PR query gains the head commit's check runs, stored with its PR record.
- The `wait_for_ci` node kind across shared types, graph validation, stages, engine, manager, store,
  feedback, telemetry and the web editor and run views.
- The node's waiting, timeout, pass, fail and block behavior.
- The Inspector prompt's flake section and policy.
- The new built-in workflow. Kind defaults do **not** change in this phase.

Non-goals:

- Switching the kind defaults to the new workflow (a later decision, once it has proven itself).
- A second GitHub poll loop. There must not be one.
- Reading CI logs. Failure detail comes from each check run's title and summary.

## 4. Repository findings and inherited contracts

- **Only the Inspector polls GitHub.** The change contracts state the PR action "never talks to a
  provider" and that a second poll loop would double the API cost. `inspector/github.ts fetchPr`
  runs one GraphQL query (`PR_QUERY`), and its docblock requires adding fields to that one query so
  data is read at the same instant as the head SHA. The query reads only
  `statusCheckRollup { state }` today; nothing reads individual check runs.
- Node kinds are **append-only persisted identifiers** (change contracts). Every enumeration:
  `WorkflowDraftNode`/`PublishedWorkflowNode` (`src/shared/workflow.ts`), the zod discriminated
  unions in `protocol.ts`, `WORKFLOW_NODE_CAPABILITIES` (`workflow-graph.ts`), the stage model
  (`workflow-stages.ts`, members are persona or check today), the engine's activation switch,
  `pump`, `runAttempt` (`engine.ts`), `publishBuiltinGraph`, `feedback.ts`, manager disable-node
  support, telemetry `node_kind` enums, and the web files (`WorkflowNode.tsx`, `WorkflowCanvas.tsx`,
  `WorkflowProperties.tsx`, `WorkflowLibrary.tsx`, `new-node.ts`, `PipelineEditor.tsx`,
  `pipeline-bits.tsx`, `run-model.ts`, `RunPipeline.tsx`, `WorkflowLadder*.tsx`,
  `WorkflowRuns.tsx`, `WorkflowVersionHistory.tsx`). Re-grep before starting.
- **Feedback only renders verdict nodes** (`isVerdictNode`: persona or check). A CI failure reaches
  the session only if the new kind is a verdict node (`isVerdictNode`, `verdictAuthor`).
- **Waiting precedent:** the session action attempt uses state `waiting` with durable progress in
  `output_json`, and is re-observed by the manager's 15-second timer and by Inspector updates
  (`registry.onInspectionUpdated`). Waiting attempts are not in the runnable list. There is no
  wall-clock timeout on any waiting node today.
- **Where the PR and head come from:** the node runs in the continuation child submission, whose
  `continuationNodeAttemptId` points at the completed Pull Request attempt; its output carries
  `expectation` with `pullRequestUrl`, `pullRequestNumber`, `pullRequestKey` and the full
  `expectedHeadOid`. A repair round re-runs the PR action and records a fresh head.
- **Side effects of a node after the PR action:** `sessionActionContinuationReachesOnlyEnd`
  becomes false, which removes the continuation's evidence-readiness exemption and the UI's
  "verified shipping" label. And the PR action's CI follow-through contract
  (`workflowPullRequestCiContract`, added when Foreman's `trackCiFailures` is on) would make the agent
  chase CI while the node also does.
- Wait reasons and block codes are `Record` keys in `run-model.ts`; adding one requires its human
  sentence. Run phases must stay in step with `workflow-lifecycle.ts` and `recovery.ts`.
- Built-in workflows are app data (`src/server/workflows/builtin-workflows.ts`), with ids from
  `src/shared/builtin-workflow.ts`. Version ids are append-only and guarded by literal tables in
  `test/builtin-workflows.test.ts`. No-Mistakes Review's latest pipeline (`NO_MISTAKES_REVIEW_V19`)
  runs typecheck, test and lint checks, then reviewer stages, then the Pull Request action, and is
  wrapped by `appendGpt6Version`.
- Inspector prompt: `buildReviewPrompt` (`inspector/prompt.ts`) with fenced untrusted sections and
  `REVIEW_PROMPT_CAPS`. `planReview` drops findings on files outside the diff, so a flake finding
  can only land on a changed file.
- Failing check conclusions to reuse: `pr.ts` `FAIL_CONCLUSIONS` and `FAIL_STATES`.

## 5. Implementation steps

1. **Check runs in the Inspector snapshot.**
   - Extend `PR_QUERY`'s head commit selection with
     `statusCheckRollup { state contexts(first: 100) { nodes { ... on CheckRun { name status
     conclusion detailsUrl title summary } ... on StatusContext { context state targetUrl
     description } } } }`.
   - Map it in `toSnapshot` to `checkRuns: [{ name, state: "pending" | "passing" | "failing",
     detailsUrl, title, summary }]`, capping each summary.
   - Persist the head's check runs with the Inspector's PR record (a JSON column added in
     `db.ts` next to its upgrade path, following the migration rules), keyed to the head SHA it was
     read for, and fire the existing inspection-updated event when they change.
2. **Node kind** `wait_for_ci` (append to the kind unions): a verdict node with target port
   `activate` and source ports `pass` and `fail`, config `{ timeoutMinutes: number }` (default 45,
   range 5-240). Add it to `WORKFLOW_NODE_CAPABILITIES` (role: evaluation), `isVerdictNode`,
   `verdictAuthor` ("Wait for CI"), the stage model as a stage member, telemetry `node_kind` enums,
   and every `Record` typecheck points at. Graph validation: it must be reachable only after a
   Pull Request session action's `complete` port.
3. **Engine and manager behavior.**
   - Activation creates a `waiting` attempt (like a session action), recording `waitingSince`, the
     PR key and URL, and the `expectedHeadOid` read from the continuation source attempt's
     `expectation`. No PR expectation (misconfigured graph) blocks the run with a clear code.
   - Re-observe waiting CI attempts on Inspector updates and on the manager's existing 15-second
     timer. On each observation read the stored check runs for the PR:
     - stored head differs from `expectedHeadOid`: keep waiting (the node never judges another head)
     - any check still pending: keep waiting
     - any failing check other than "Flaky tests": complete with a **fail** verdict, one requested
       change per failing check (name, conclusion, link, title and summary excerpt), which routes to
       the session through the existing feedback path
     - all complete and passing, with a "Flaky tests" check: **pass**, recording the parsed flake
       report in the attempt output
     - all complete and passing without a "Flaky tests" check: **block** the run with new block code
       `ci_flake_report_missing`
     - no checks at all after the timeout, or still pending at the timeout: **block** with
       `ci_missing` or `ci_timeout`
   - Blocked runs use the existing blocked-run recovery (the operator retries the node after fixing
     CI). Add the block codes, their sentences in `run-model.ts`, and recovery policy entries.
   - Disabling the node (existing disable support for verdict nodes) auto-passes it, stated plainly.
4. **Shipping continuation.** Extend `sessionActionContinuationReachesOnlyEnd` so a path of
   `wait_for_ci` nodes to End still counts as shipping-only (evidence readiness exemption and the
   "verified shipping" label keep working). In the manager where `pullRequestCi` is decided, turn the
   CI follow-through contract **off** when a `wait_for_ci` node follows the action, so the node owns
   CI.
5. **Inspector flake reading.** Add `flakeSummary` to `ReviewPromptInput`, built from the stored
   "Flaky tests" check run for the head via `parseFlakeSummary`, rendered compactly (test, file,
   message, issue link), fenced as untrusted data, and capped in `REVIEW_PROMPT_CAPS`. Add a policy
   paragraph: flakes are informational; raise a finding only when the flaky test's file is in the
   diff or the change plausibly introduced the flakiness, and link the history issue. Update
   `docs/inspector-and-shipping.md`.
6. **Built-in workflow.** Add slug `no-mistakes-review-affected-tests` and its id constants. Define
   **No-Mistakes Review (Affected tests)** as No-Mistakes Review's latest pipeline with the `test`
   check replaced by `affected-tests` and a Wait for CI stage after the Pull Request action, same
   completion policy and settings, and the same `appendGpt6Version` treatment. Kind defaults are
   unchanged.
7. **Web.** The editor palette and properties (timeout field), canvas and node rendering, and the
   run views: a Wait for CI card showing what it is waiting for (PR, head, elapsed and limit), the
   check list with states, the failing checks on fail, the flake list on pass, and the block
   sentence when blocked.
8. **Docs.** `docs/workflows.md` (the node, its outcomes, its placement rule, the new built-in
   workflow) and `docs/flaky-tests.md` (how the Inspector and Wait for CI use the report).

## 6. Data, API and compatibility

- One additive migration: the Inspector PR record's check-runs JSON column, added in `db.ts` next to
  its upgrade path, nullable, so existing databases keep opening.
- Node kind, block codes and the built-in workflow's version ids are append-only.
- Published graphs without the node behave exactly as before, including the CI follow-through
  contract.
- The Inspector's API cost does not grow: the same single query per poll, with more fields.

## 7. Tests and verification

- Inspector: `toSnapshot` mapping of check runs (CheckRun and StatusContext), persistence keyed to
  head, and the prompt's fenced, capped flake section (`test/inspector-prompt.test.ts`).
- Node: graph validation (only after a PR action's `complete`); engine and manager tests driving a
  waiting attempt through each outcome with seeded Inspector snapshots, including a head change,
  pending, fail with requested changes, pass with flakes, missing "Flaky tests", missing CI, and
  timeout; feedback rendering of a CI failure; disable auto-pass.
- Continuation: the evidence exemption and "verified shipping" still hold with Wait for CI before
  End; the CI follow-through contract is omitted when the node exists and present when it does not.
- Built-in workflow literal tables updated and passing.
- `e2e/`: add the node in the workflow editor and save; a seeded run showing Wait for CI waiting,
  passed with a flake, and failed with a named check. Specs never spend model tokens and never
  reach GitHub.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e` for the new specs.

## 8. Merge and exit criteria

- A ship task bound to No-Mistakes Review (Affected tests) in this repository reaches End only
  after its PR's CI is green, sends a repair packet naming the failing check on a real failure, and
  passes when the only problems were flakes.
- The Inspector's review of a PR with flakes mentions them, and raises a finding only for a flaky
  test the PR touched.

## 9. Downstream handoff

Later phases may rely on, and must not change:

- The node kind id `wait_for_ci` and the built-in workflow id
  `builtin-workflow:no-mistakes-review-affected-tests`.
- The block codes `ci_flake_report_missing`, `ci_missing`, `ci_timeout`.
- The Inspector snapshot's `checkRuns` for the head.

## 10. Cross-phase audit

- Against Phase 3: the check is created on the PR head commit and named by `FLAKY_TESTS_CHECK_NAME`;
  `parseFlakeSummary` is the only reader of its content.
- Against Phase 2: the new workflow uses the `affected-tests` slot; an unconfigured slot skips with
  a note, which is why Phase 5's setup skill configures it.
- Phase 5 relies on the workflow id and block codes to verify setup and explain failures.
