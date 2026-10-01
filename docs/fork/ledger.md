# Fork ledger

`ramiro314/mission-control` is a fork of
[`teamupstart/mission-control`](https://github.com/teamupstart/mission-control). This ledger
records everything the fork changes against upstream, one entry per fork **feature**, with the
PRs that built it. It has two readers:

- **A sync agent** checks each new upstream commit against every active entry's contracts,
  assumptions and surfaces to find conceptual conflicts that merge cleanly as text (see
  [the upstream-sync runbook](../upstream-sync.md), section 2).
- **The human** reads the status header to see where the fork stands against the original.

Rendered page: [ledger.html](ledger.html). Rules for keeping it current are at the end.

## Status

| Field | Value |
| --- | --- |
| Last synced upstream | **1.26.0**, `upstream/main` at `104a5407` (upstream #1152) |
| Sync date | 2026-09-29, fork PR #62 (merge commit `64a5dcd8`) |
| Fork commits ahead of upstream | **155** (112 excluding merge commits) |
| Upstream commits behind | **0** |
| Active fork features | **9** (plus 2 superseded or removed, and 10 standalone fixes) |
| Measured at | `origin/main` `118ca860`, 2026-09-29 |

How the numbers are measured, from the fork checkout with both remotes fetched:

```sh
git show upstream/main:package.json | grep '"version"'   # synced version
git rev-list --count upstream/main..origin/main              # ahead
git rev-list --count --no-merges upstream/main..origin/main  # ahead, excluding merges
git rev-list --count origin/main..upstream/main              # behind
```

"Ahead" counts every fork commit not in upstream, including the merge commits of fork PRs and
of syncs, so it is a size gauge rather than a feature count.

## At a glance

Every fork feature, and every merged fork PR in exactly one home. Numbers missing from the
table are pull requests closed without merging (#36 to #39, #42, #60), pull requests still open,
or issues.

| Feature | Status | PRs |
| --- | --- | --- |
| Shape tasks, grill and tickets | Active | #1, #3, #7, #9, #10 |
| Task-source relations and dependency sync | Active | #5, #8, #16, #20 |
| Decision forms | Active | #2, #6, #28, #30 |
| Per-task-kind default workflows | Active | #12 |
| MCP backlog listing and adoption across repositories | Active | #14 |
| Flake-aware testing | Active | #25, #26, #27, #29, #44, #48, #53 |
| Upstream sync process and fork ledger | Active | #59, #62, #66, weekly mission PR |
| CodeQL advanced setup | Active | #65 |
| Persona reasoning effort | Active | Pending (branch `feat/persona-effort`) |
| Complete frees the worktree | Superseded by upstream #1148 (2026-09-29, #62) | #11, #17 |
| Dependabot | Removed (2026-09-29, #62) | #35, #40, #41, #43 |
| Standalone fixes | Not a feature | #4, #13, #15, #18, #19, #21, #22, #23, #24, #33 |


## Reading an entry

Each feature entry records:

- **Status**: active, superseded by upstream, removed, or upstreamed, with the date and the sync
  PR for any change.
- **PRs** and **plan docs** behind it, and whether it is an **upstream candidate**.
- **Intent**: what it does and why the fork needs it.
- **Behavior contracts**: what the fork promises. A sync must keep these true.
- **Upstream behavior it assumes**: the upstream behavior the feature relies on. An upstream
  commit that changes one of these is a conceptual conflict even if it merges cleanly.
- **Upstream surfaces touched**: upstream modules, routes, protocol types, DB columns, MCP tools
  and UI views the feature changes. An upstream commit touching one needs a look.
- **Fork-only files**: paths upstream does not have. They never conflict textually, but they
  can stop compiling against a changed upstream API.

## Active features

### Shape tasks, grill and tickets

| Field | Value |
| --- | --- |
| Status | **Active** |
| PRs | #1 (plan), #3, #7, #9, #10. Related, not claimed: #21 (standalone fix to Shape this) |
| Plan docs | [shape-task-kind/plan.md](../plans/shape-task-kind/plan.md) sections 1 to 5; [shape-tickets-after-merge/plan.md](../plans/shape-tickets-after-merge/plan.md) (in progress) |
| Upstream candidate | Maybe. Self-contained and built on upstream pieces, but it is a second planning path and bundles third-party-derived skills (credited in `NOTICE`). |

**Intent.** A new planning kind, `shape`, beside `plan`. It interviews the human in rounds of
decision forms (grill) before writing a plan, then splits the approved plan into
dependency-gated backlog tasks (tickets), which it can mirror to a task source. Upstream `plan`
drafts first and asks afterwards, and cannot turn a plan into gated tasks or GitHub sub-issues.

**Behavior contracts.**

- `shape` always asks at least one round: one `request_plan_decisions` form per round, the
  recommended option first, plus a free-text Other. Dismissing a round stops the session. The
  plan review's follow-up is Create tickets or Stop, never `/phased-plan`.
- Dispatch is refused, naming the toggle, when a required planning skill is off
  (`PLANNING_SKILLS.shape` is `grill`, `htmlPlans`, `tickets`). After work defaults to Plan
  Validation. Shape can be put on the backlog, but schedules and MCP `create_task` cannot file it.
- The breakdown review is one decision form and nothing is created before Submit. Each ticket
  is New task or Adopt an open backlog task. On submit the skill writes
  `docs/plans/<name>/tickets.md` and its HTML, commits, then files tickets in dependency order;
  they are released when the planning PR merges.
- `push_task` mirrors only a task that depends on the calling session, is idempotent
  (`alreadyPushed: true`), links blockers only to items already in that source, and parents
  them under the planning task's item. From a tickets follow-up session it also accepts a task
  that depends on the follow-up's source shape task.
- A tickets follow-up is recorded in `shape_ticket_followups` against its merged source shape
  task (episode, session and PR URL), one row per follow-up, so a source can take another after a
  cancelled or failed one. From that follow-up's session, `create_task` with
  `dependsOnCurrentSession` links the ticket to the source shape task with an already-satisfied
  edge pinned to that merge, never to the follow-up
  ([shape-tickets-after-merge](../plans/shape-tickets-after-merge/plan.md) sections 3 and 5).
- **Shape this** works on any backlog task that is not already shape and keeps its source link,
  labels, priority and dependencies. A refused Shape this leaves the task unchanged (#21).
- Upstream's `plan` kind is unchanged.

**Upstream behavior it assumes.**

- `request_plan_decisions` and the html-plans review flow keep their form shape and follow-up
  mechanism (shape swaps `implementation-follow-up` for `shape-follow-up`).
- `TASK_KINDS` is an append-only text enum. If upstream appends its own kind, the fork's
  `"shape"` collides in `src/shared/types.ts`; kind sets are also re-derived in the backlog,
  schedule and harness-launch predicates.
- Plan publication and wrap-up (Foreman `worker.ts`, `wrapup-eligibility.ts`,
  `taskCompletionContract`) treat "complete when the planning PR merges" as they do for `plan`.
- MCP `create_task` (`/mcp/tasks`, `/mcp/v2/tasks`) and `pushTask` (in-flight claim, seen-ledger
  row and task link in one transaction) keep their semantics.
- Backlog edit and dispatch routes and the dependency cycle and new-edge refusals
  (`bulkTaskPatch`, `TaskManager.update`) keep their semantics.

**Upstream surfaces touched.**

- Modules: `src/server/{dispatcher,tasks,task-contract,routes,mission-mcp}.ts`,
  `src/server/plans/{skills,tools}.ts`, `src/server/foreman/{plan-publication,worker,wrapup-eligibility}.ts`,
  `src/mcp/server.ts`, `src/server/schedules/store.ts`, `src/server/archives/task-gateway.ts`,
  `src/server/task-sources/{push,github-issues}.ts`, `src/shared/{task,task-completion,types,protocol,task-source}.ts`,
  `src/shared/telemetry-sources/{primary-actions,action-exclusions}.ts`.
- Routes: new `POST /mcp/v3/tasks`, `POST /mcp/backlog`, `POST /mcp/push-task`,
  `POST /api/tasks/:id/shape` (#21); `GET /api/harnesses/config` and `GET /api/skills` list
  shape and grill.
- Protocol: `TASK_KINDS` (+`"shape"`), `MCP_TASK_KINDS`, `SCHEDULE_TASK_KINDS`,
  `isPlanningTaskKind`, `McpCreateTicketSchema`, `McpAdoptTicketSchema`,
  `McpCreateTaskV3Schema`, `McpListBacklogSchema`, `McpPushTaskSchema`,
  `PushDraft.blockedBy` and `.parent`.
- Registries: `PLANNING_SKILLS`, `KIND_MISSION_MCP_TOOLS.shape`, `MISSION_MCP_TOOLS`,
  `PRIMARY_ACTION_ROUTES`, `ACTION_EXCLUSIONS`.
- MCP tools: new `list_backlog_tasks` and `push_task`; `create_task` gains ticket and adopt fields.
- DB: new `shape_ticket_followups` table (created with the base schema, so an existing database
  gains it on open).
- UI: `DispatchModal.tsx`, `layouts/BacklogColumn.tsx` and `line/BacklogDrawer.tsx` (Shape this),
  `schedules/ScheduleEditor.tsx`, `src/web/lib/guided-dispatch-steps.ts`.

**Fork-only files.** `src/server/plans/shape.ts`, `src/mcp/unknown-route.ts`, `skills/grill/`,
`skills/tickets/`, `docs/plans/shape-task-kind/`,
`docs/reports/grill-tickets-implement-in-mission-control/`.

### Task-source relations and dependency sync

| Field | Value |
| --- | --- |
| Status | **Active** |
| PRs | #5, #8, #16, #20. Related, not claimed: #44 (label filters, under flake-aware testing) |
| Plan docs | [shape-task-kind/plan.md](../plans/shape-task-kind/plan.md) section 6 and "Data and compatibility" |
| Upstream candidate | Yes. A source-agnostic extension of upstream's task-source capability model and keep-updated merge, useful without shape. Sending the `SOURCE_CONTENT_GROUPS` and edge-shape additions upstream first would remove the append-only collision risk. |

**Intent.** Recover upstream blocking links (GitHub `blockedBy`) as Mission Control
dependencies, so a swept item is never scheduled before its blockers; keep those edges in sync
through keep-updated; store a sub-issue's parent for display. Upstream sweeps drop blocking
links, and shape tickets mirrored to GitHub would otherwise drift from their local edges.

**Behavior contracts.**

- A `canRelate` capability sits beside `canPush`, `canAnnotate` and `canResolve` (GitHub true,
  Jira false). Nothing branches on source kind; callers use `canRelateTo`.
- On sweep, a blocker becomes a task edge when it is already a task that can take one, and a
  `source` edge otherwise. A parent or sub-issue link never becomes an edge.
- Each sweep rechecks up to 25 waiting `source` edges, least recently checked first. Closed as
  completed satisfies the edge for good; closed as not planned raises the stopped-dependency
  warning with Remove dependency.
- An edge type this build does not know is kept, unsatisfied, and written back unchanged.
- The keep-updated `dependencies` group three-way merges only edges for this source's own items.
  A cycle holds the whole update for that task. Pushed tasks sync only this group.
- A push records the blockers it wrote as the dependencies baseline in the same transaction; a
  clean push with no blockers records an empty baseline.
- `Task.sourceParent` is display-only, owned by the source, overwritten on refresh, and shown as
  "Sub-issue of #M".

**Upstream behavior it assumes.**

- `tasks.dependencies` JSON and `parseTaskDependencies` accept extra edge variants. The fork's
  `isWorkDependency` filter keeps `registry.ts` PR reconciliation to task edges; a new upstream
  path that reads dependencies without it could release or block work on a `source` edge.
- `SOURCE_CONTENT_GROUPS` is persisted in `task_source_sync` conflicts and append-only. An
  upstream group appended after `labels` would collide with the fork's `dependencies`.
- The keep-updated three-way merge (`reconcileSourceContent`, baseline JSON, sync review UI)
  and the `sweepOnce`, `ingestSweep`, `readLinked` flow keep their structure.
- The `pushTask` transaction still writes the ledger row and task link together.
- `gh issue view/list --json blockedBy,parent,state,stateReason` and
  `gh issue create --blocked-by/--parent` keep their behavior.

**Upstream surfaces touched.**

- Modules: `src/server/db.ts` (`parseTaskDependencies`, `serializeTaskDependencies`),
  `src/server/registry.ts`, `src/server/tasks.ts`,
  `src/server/task-sources/{index,ingest,sweeper,sync,push,github-issues}.ts`,
  `src/shared/{task-source,task-source-sync,types,protocol,backlog,task-bulk}.ts`.
- Routes: none new; the sync-resolve route also returns 409 on a cycle.
- Protocol: `TaskDependency` gains `source` and `unknown`; `TaskSourceItemState`, `canRelate`,
  candidate `blockedBy` and `parent`, `SourceContent.blockedBy`, `SOURCE_CONTENT_GROUPS`
  (+`"dependencies"`), `PUSHED_SOURCE_GROUPS`, `PushResult.blockedBy`, `Task.sourceParent`.
- DB: new column `tasks.source_parent` (#20); `tasks.dependencies` JSON gains `source` and
  `unknown` edges; `task_source_sync` payload gains the `dependencies` group.
- UI: `TaskSourceSync.tsx`, `DispatchModal.tsx`, `BacklogBulkEditModal.tsx`, `ReportPanel.tsx`,
  `session-bits.tsx`, `layouts/BacklogColumn.tsx`, `line/BacklogDrawer.tsx`.

**Fork-only files.** `src/server/task-sources/relations.ts`, `src/shared/task-dependency.ts`.

### Decision forms

| Field | Value |
| --- | --- |
| Status | **Active** |
| PRs | #2, #6, #28 (plan), #30 |
| Plan docs | [shape-task-kind/plan.md](../plans/shape-task-kind/plan.md) section 7 (tickets 1 and 2), [decision-other-radio/plan.md](../plans/decision-other-radio/plan.md) |
| Upstream candidate | Yes for #2 and #30 (generic UX, no wire change; #30 fixes "cannot send Other only"). Maybe for #6 (a model call per plan-decisions review and a DB column). |

**Intent.** Decision forms open on the agent's recommendation, so accepting it is one click. An
invited Foreman may draft an answer but never send it, and its words stay attributed. On
single-choice questions Other is its own radio, so an Other-only answer can be sent. Shape's
grill rounds lean on all three.

**Behavior contracts.**

- Every `request_plan_decisions` form, and every `request_input` form with options, opens with
  its `recommended` options selected (a radio takes the first, a checkbox group all). An
  untouched Submit returns exactly the recommendation; a "Selected: ..." line shows what Submit
  sends. A form with no recommendation opens empty with Submit disabled.
- In a session Foreman is invited into, Foreman may draft on plan-decisions forms under a
  "Foreman's draft" banner. A draft never overwrites a form the human touched, "Revert to
  recommendation" affects only drafted questions, and withdrawing the invite removes the draft.
- Foreman never resolves a plan-decisions review: `ReviewManager.resolve` refuses
  `by: "foreman"` with a 400.
- Other text from a Foreman draft submitted unchanged is marked `(Foreman draft, accepted)`;
  any edit makes it the human's. The server checks this against the live draft and strips a
  forged flag.
- On a single-choice question with `allowOther`, Other is a radio in the same group; a blank
  Other is unanswered; picking a listed option keeps but does not send the Other text. The wire
  shape stays `{ selected: [], other }`. Multi-choice questions are unchanged.

**Upstream behavior it assumes.**

- `PlanDecisions.tsx` renders both `request_plan_decisions` and option-carrying `request_input`
  reviews, and `isAnswered`, `formatResponse` and conversation replay accept an Other-only answer.
- Both MCP schemas carry `recommended` and `allowOther` per option. Upstream's tool text still
  says the form "does not preselect"; the fork diverges there.
- The Foreman pipeline: `classifyPending`, tier 0, the full reviewer returning
  `answer.form.answers`, `planFromVerdict`; the note `handledMarker`; the invite resolved live;
  `ForemanPickMark` matching.
- Foreman writes notes through `PUT /api/sessions/:id/note`, and `Registry.upsertNote` and
  `retireNoteAnsweredByYou` own the note lifecycle.
- The browser reads the agent's answer through `GET /mcp/reviews/:id/wait`.

**Upstream surfaces touched.**

- Modules: `src/web/components/{PlanDecisions,ReviewModal,ReviewAnswer,ForemanSettingsPanel}.tsx`,
  `src/server/foreman/{pending,triage,verdict,worker}.ts`, `src/server/registry.ts`
  (`foremanMayDraft`, `upsertNote`), `src/server/reviews.ts`,
  `src/shared/{types,protocol,review-item}.ts`, `src/mcp/server.ts` (tool text).
- Routes: `PUT /api/sessions/:id/note` (403 on a draft for an uninvited session).
- Protocol: `PlanDecisionAnswer.foremanDraftAccepted`, the session note `draft` field, Foreman
  situation `plan-decisions-review` and triage reason `plan-decisions-draft`.
- DB: new column `session_notes.draft` (#6).
- MCP tools: `request_plan_decisions`, `request_input` (description text only).
- UI: the review modal decision form, the Foreman settings panel.

**Fork-only files.** `src/server/foreman/decision-draft.ts`, `docs/plans/decision-other-radio/`.

### Per-task-kind default workflows

| Field | Value |
| --- | --- |
| Status | **Active** |
| PRs | #12 |
| Plan docs | None |
| Upstream candidate | Maybe. Generic and useful, but the `shape` row is fork-only and the 400 on the legacy `defaultWorkflowId` field is an API change upstream would have to accept. |

**Intent.** Upstream configures only Ship's default after-work workflow; bugfix, plan and shape
were hardwired to their built-ins. The fork gives every harness-launched kind its own row, so a
duplicated workflow can become any kind's default.

**Behavior contracts.**

- **Settings → Workflows → Dispatch defaults** has one row each for ship, bugfix, plan, shape,
  scout and chat (not pipeline), stored in one `kindWorkflowDefaults` map: absent follows
  `BUILTIN_KIND_WORKFLOW_DEFAULTS`, `null` is None, a string is a workflow id.
- Every task created without an explicit workflow resolves through `taskDefaultWorkflowId`: the
  dispatch form, `POST /api/tasks`, task-source sweeps, `POST /api/tasks/:id/shape`, and the
  Recurring Mission preset (bugfix and plan). An explicit choice, None included, wins; pipeline
  always resolves to None; changing a row does not retarget tasks already in the backlog.
- The legacy `defaultWorkflowId` migrates on read; `PUT /api/workflows/config` carrying it
  returns 400; old settings backups still restore.
- A workflow named by a row cannot be archived or deleted, and the refusal names the kinds.

**Upstream behavior it assumes.**

- The built-in workflow ids (No-Mistakes Review, Plan Validation, Bug Fix Review) and which kind
  each belongs to. The fork removed upstream's `taskHasOwnDefaultWorkflow`.
- `WorkflowPolicy.defaultWorkflowId` is upstream's field. An upstream rename, its own per-kind
  defaults, or a change to how the `workflows` `app_config` entry is written conflicts directly.
- `HARNESS_LAUNCHED_TASK_KINDS` and `taskKindLaunchesHarness` decide which kinds get a row.
- The settings backup and restore registry (`APP_CONFIG_ENTRIES`, `parseSettingPayload`) and the
  workflow archive and delete routes.
- The dispatch form's Ship-default stash rules (`afterWorkForKind`) and the Recurring Mission
  editor's workflow preset.

**Upstream surfaces touched.**

- Modules: `src/shared/task.ts` (`BUILTIN_KIND_WORKFLOW_DEFAULTS`, `taskDefaultWorkflowId`,
  `kindsDefaultingToWorkflow`), `src/shared/{protocol,workflow,app-config-entries}.ts`,
  `src/server/workflows/config.ts`, `src/server/settings-backups/{config-registry,restore}.ts`,
  `src/server/routes.ts`, `src/web/lib/{api,settings-search,task-draft}.ts`.
- Routes: `GET`/`PUT /api/workflows/config` (`kindWorkflowDefaults`), `DELETE /api/workflows/:id`
  and `POST /api/workflows/:id/delete` (the guard), `POST /api/tasks`, `POST /api/tasks/:id/shape`.
- Protocol: `WorkflowPolicy.kindWorkflowDefaults`, `KindWorkflowDefaults`,
  `StoredWorkflowPolicySchema`.
- DB: none; stored in the existing `app_config` `workflows` entry.
- UI: `WorkflowSettingsPanel.tsx` (Dispatch defaults), `DispatchModal.tsx`,
  `schedules/ScheduleEditor.tsx`.

**Fork-only files.** None outside tests and specs; everything edits upstream files.

### MCP backlog listing and adoption across repositories

| Field | Value |
| --- | --- |
| Status | **Active** |
| PRs | #14 |
| Plan docs | [shape-task-kind/plan.md](../plans/shape-task-kind/plan.md) ticket 4 (#14 follows up #9) |
| Upstream candidate | No, unless shape goes upstream: it extends fork-only tools and routes. `resolveRepositorySelector` alone is a small generic helper. |

**Intent.** A shape session's ticket breakdown can list and adopt backlog tasks from a named
repository, not only its own, and adoption is locked so a guessed or stale task id cannot attach
dependency edges to another repository's work. It builds on the fork-only `list_backlog_tasks`
and `/mcp/v3/tasks` from the shape entry.

**Behavior contracts.**

- `list_backlog_tasks(repository?)` takes an absolute path or a unique directory name, resolved
  like `create_task`'s selector: no match is 400, an ambiguous name 409 with candidates. With
  `repository`, both the tasks and the `mirror` choice come from that repository.
- Without `repository` the MCP wrapper calls the v1 `/mcp/backlog` route, so older daemons keep
  working; with it, `POST /mcp/v2/backlog`, and an older daemon answers 404 ("daemon out of
  date") rather than the wrong backlog.
- `create_task` with `adoptTaskId` returns 409 unless the task's primary repository is the
  caller's (a pooled worktree counts as its main checkout) or the named `repository`.
- `McpListBacklogV2Schema` and `McpAdoptTicketSchema` are `.strict()`.

**Upstream behavior it assumes.**

- `resolveSelector` and `prepareTaskRepositories` in `src/server/task-repository-preparation.ts`
  keep their path-or-unique-name rules and 400/409 semantics.
- `resolveTaskRepoRoot` maps a pooled worktree to its main checkout.
- Every new route must be classified in `primary-actions` or `action-exclusions`, and appear in
  the route-surface oracle.
- Upstream's `/mcp/tasks` and `/mcp/v2/tasks` stay beside the fork's `/mcp/v3/tasks`.

**Upstream surfaces touched.**

- Modules: `src/server/task-repository-preparation.ts` (adds `resolveRepositorySelector`),
  `src/server/routes.ts` (`adoptMcpTask`), `src/shared/protocol.ts`,
  `src/shared/telemetry-sources/action-exclusions.ts`, `src/mcp/server.ts`.
- Routes: new `POST /mcp/v2/backlog`; extends the fork's `POST /mcp/backlog` and `POST /mcp/v3/tasks`.
- Protocol: `McpListBacklogV2Schema`, `McpAdoptTicketSchema.targetRepository`.
- MCP tools: `list_backlog_tasks`, `create_task` (adoption).
- DB and UI: none.

**Fork-only files.** None of its own; it extends `skills/tickets/SKILL.md` from the shape entry.

### Flake-aware testing

| Field | Value |
| --- | --- |
| Status | **Active** |
| PRs | #25 (plan), #26 (phase 1), #27 (phase 2), #29 (phase 3), #48 (phase 4), #53 (phase 5), #44 (phase 6) |
| Plan docs | [flake-aware-testing/plan.md](../plans/flake-aware-testing/plan.md), [phased-plan.md](../plans/flake-aware-testing/phased-plan.md) and its six phase docs |
| Upstream candidate | Maybe, in pieces. The check-test lease (#26), the label filters (#44) and Wait for CI (#48) are general; the rest is large and opinionated (about 60 fork-only files, a committed action bundle, CI permission and job changes). |

**Intent.** Workflow test checks ran the full suite on the laptop, where load made unrelated
tests time out and burned repair rounds. The fork runs only the tests a change touches locally,
leaves the full suite to GitHub CI, reports flakes instead of failing on them, and turns repeat
flakes into deflake tasks.

**Sub-capabilities.**

- Check-test lease (#26): one workflow test check at a time per OS user across all daemons;
  `checkTestLease` and `checkTestConcurrency` settings.
- Affected-tests check slot (#27): an `affected-tests` Command slot with `{files}` and `{junit}`
  placeholders, selection from `.mission/testing.json`, one local rerun, JUnit repair packets.
- CI flake reporting (#29): the `mission-flake-report` action, a "Flaky tests" check run, one
  `flaky-test` issue per test, labeled `flaky-test:actionable` at 3 occurrences in 30 days.
- Wait for CI and flake-aware Inspector (#48): a `wait_for_ci` workflow node, CI flakes in the
  Inspector prompt, and the built-in `no-mistakes-review-affected-tests` workflow.
- Testing-setup skill (#53): the `testing-setup` skill, a "Set up testing" action on
  **Settings → Trust** rows, and the `set_affected_tests_command` MCP tool.
- Flake cleanup (#44): "all of" and "none of" label filters on GitHub Issues task sources, and
  the `deflake` skill. Placed here because it is phase 6 of this plan; the filters exist so a
  task source can sweep `flaky-test:actionable` issues for the deflake skill.

**Behavior contracts.**

- Only test-slot checks (`test`, `affected-tests`) take the lease. Lint, typecheck and build
  never wait. The command timeout starts when the lease is granted; the wait has its own
  60-minute limit and counts as an infrastructure failure. Test checks get
  `MISSION_TEST_CONCURRENCY=3` by default.
- An `affected-tests` template must use `{files}` as a whole argv element and contain `{junit}`,
  or it is refused on save. Failed test files rerun once: fail twice fails the check, fail then
  pass is a reported local flake. A check that selects nothing does not spend the Command budget.
- In CI, a unit test that fails then passes on a file rerun does not fail the job. For E2E,
  Playwright `flaky` is a flake and `unexpected` a real failure.
- "Flaky tests" is posted on the PR head commit: `neutral` if anything flaked, `success`
  otherwise. Only the `flake report` job has `checks: write` and `issues: write`.
- Wait for CI passes only when every check is green and a "Flaky tests" check is present. It
  fails with a repair packet on any other failing check, blocks without spending a repair round
  on timeout or missing checks, and adds no GitHub polling of its own.
- A task source whose "none of" labels overlap its "all of" or "any of" labels is rejected.

**Upstream behavior it assumes.**

- The `.github/workflows/ci.yml` layout: unit shards through
  `.github/actions/run-unit-shard/action.yml`, Playwright E2E shards, `--test-shard`.
- `npm test` runs `node --test` with the `./test/setup-state.mjs` and `tsx` preloads and reads
  `MISSION_TEST_CONCURRENCY`.
- Workflow check slots and the Command library (`WorkflowCommandManager`, check runtime and
  supervisor, the per-run Command budget and repair packets).
- The Inspector polls each PR once and stores it in `inspector_prs` keyed by
  `observed_head_sha`; the Inspector review prompt.
- The Pull Request action node and the No-Mistakes Review built-in workflow.
- The GitHub Issues task source with `labelsAny`, and the skills catalog's `category` and
  `enforcement` model.

**Upstream surfaces touched.**

- Modules: `src/server/workflows/{engine,checks,check-runtime,check-supervisor,store,manager,recovery,builtin-workflows}.ts`,
  `src/server/inspector/{github,prompt,worker}.ts`, `src/server/{index,diff,pr,routes,mission-mcp}.ts`,
  `src/server/settings-backups/restore.ts`, `src/server/task-sources/github-issues.ts`,
  `src/mcp/server.ts`, `src/shared/{workflow,protocol,app-config-entries,builtin-workflow,task-source,skills,workflow-graph,workflow-lifecycle,workflow-stages,workflow-actions}.ts`.
- Routes: `GET`/`PUT /api/workflows/config` (adds `checkTestLease`, `checkTestConcurrency`);
  new `POST /api/repositories/testing-setup` and `POST /mcp/workflow-commands/affected-tests`.
- Protocol: workflow node kind `wait_for_ci`; Command slot `affected-tests`; `labelsAll` and
  `labelsNone` on `GithubIssuesConfigSchema`; workflow config `checkTestLease` and
  `checkTestConcurrency`.
- DB: `inspector_prs.observed_ci_json`.
- MCP tool: `set_affected_tests_command`.
- CI: `.github/workflows/ci.yml` (the `flake report` job, the E2E flake step),
  `.github/actions/run-unit-shard/action.yml`, `e2e/playwright.config.ts`.
- `package.json`: `test` delegates to `test:run`; `build:flake-report-action`; devDependency
  `esbuild`.
- UI: `WorkflowSettingsPanel.tsx` (Test checks card), `CommandLibrary.tsx`, `WorkflowRuns.tsx`,
  the workflow editor and ladder components, `TaskSourcesPanel.tsx`, `TrustPanel.tsx`.

**Fork-only files.** `.github/actions/mission-flake-report/` (generated), `.mission/testing.json`,
`scripts/build-flake-report-action.ts`, `src/flake-report-action/`,
`src/server/util/host-lease.ts`, `src/server/{test-selection,testing-config,testing-setup,testing-setup-tool}.ts`,
`src/server/workflows/affected-tests.ts`,
`src/shared/{junit,testing-config,flake-report,command-template,ci-checks,wait-for-ci}.ts`,
`src/web/workflows/WaitForCi{Fields,Panel}.tsx`, `skills/deflake/`, `skills/testing-setup/`,
`docs/flaky-tests.md`, `docs/plans/flake-aware-testing/`.

### Upstream sync process and fork ledger

| Field | Value |
| --- | --- |
| Status | **Active** |
| PRs | #59 (plan), #62 (first sync, runbook), #66 (this ledger), and the PR that recorded the weekly sync mission in the runbook (all after the original backfill range) |
| Plan docs | [upstream-sync/plan.md](../plans/upstream-sync/plan.md), [tickets.md](../plans/upstream-sync/tickets.md) |
| Upstream candidate | No. It exists only because this is a fork. |

**Intent.** Keep the fork equal to upstream plus a deliberate layer of fork changes: merge
upstream weekly through the "Sync fork with upstream" recurring mission, let upstream win, ask
before removing a fork feature, and record every fork feature here so a sync can spot
conceptual conflicts.

**Behavior contracts.**

- Syncs are merge commits on `sync/upstream-<date>` off `origin/main`, landed by PR; no rebase,
  no force-push; the human merges.
- The operator's daemon runs a recurring mission, "Sync fork with upstream", Mondays at 09:00
  local time. It files a backlog task that follows the runbook and ends without a branch or PR
  when upstream has nothing new. The mission is daemon state, not a file in this repository.
- Dependency versions equal upstream's; `package.json` differs only by the fork-only entries
  listed in the runbook.
- The fork's `Release` workflow stays disabled in GitHub and `release.yml` stays byte-identical
  to upstream's.
- Every fork PR that adds or changes a feature updates its entry here and re-renders
  `ledger.html` (the "Fork" section of `AGENTS.md`).

**Upstream behavior it assumes.**

- Upstream stays reachable as `teamupstart/mission-control` with a `main` branch, and its
  history is never rewritten (the merge model needs upstream SHAs to stay stable).
- `.github/workflows/release.yml` keeps its file name, so the GitHub disable keeps matching it.
- Recurring missions keep filing a backlog task per due instant, with the coalesce-latest,
  skip-active and auto-on-conclusion policies behaving as `docs/recurring-missions.md`
  describes. A "nothing new" run relies on auto-on-conclusion to close its task.

**Upstream surfaces touched.** `AGENTS.md` (the "Fork" section), `docs/README.md` (two links),
`.agents/memory/MEMORY.md` (one line).

**Fork-only files.** `docs/upstream-sync.md`, `docs/fork/`, `.agents/memory/upstream-sync.md`,
`docs/plans/upstream-sync/`.

### CodeQL advanced setup

| Field | Value |
| --- | --- |
| Status | **Active** |
| PRs | #65 |
| Plan docs | None; the runbook's fork-only surface list records it |
| Upstream candidate | No. The exclusion exists because upstream's test code looks new to the fork at every sync. |

**Intent.** Code scanning through a committed workflow instead of GitHub's default setup, so
`e2e/` and `test/` can be excluded. Otherwise every sync reports upstream's test code as new
alerts on the fork.

**Behavior contracts.**

- CodeQL runs on pushes and PRs to `main` and weekly, over the same four languages default setup
  scanned, with `paths-ignore: [e2e, test]`.
- The repository's CodeQL default setup stays disabled in GitHub settings.

**Upstream behavior it assumes.**

- Upstream has no `.github/workflows/codeql.yml` of its own. If it adds one, the conflict policy
  applies.
- Test code stays under `e2e/` and `test/`.

**Upstream surfaces touched.** None; both files are fork-only.

**Fork-only files.** `.github/workflows/codeql.yml`, `.github/codeql/codeql-config.yml`.

### Persona reasoning effort

| Field | Value |
| --- | --- |
| Status | **Active** |
| PRs | Pending (branch `feat/persona-effort`) |
| Plan docs | None; [docs/workflows.md](../workflows.md) "Per-node provider and model" describes it |
| Upstream candidate | Yes. It extends upstream's own Persona and node-override routing and adds no fork-only concept. |

**Intent.** An operator chooses the reasoning effort (`low` to `max`) a workflow Persona call
runs at, the same way they already choose its model. Without it every Persona call ran at the
provider default, which on Claude Opus 5.5 is `medium`, so Opus reviewers ran shallower than
intended.

**Behavior contracts.**

- Effort is optional at two levels: `Persona.effort` and `WorkflowNodeExecutionOverride.effort`.
  Resolution is node override, then Persona, then provider default, in the existing
  `resolveWorkflowNodeExecution` / `resolvePersonaExecution` path. An override without an effort
  runs at the provider default, never at the Persona's level.
- Unset effort passes no flag at all, so existing Personas, drafts, versions and bindings behave
  exactly as before with no migration step. A Persona with no effort freezes byte-identically.
- One vocabulary (`THINKING_LEVELS`) and one capability check (`launchEffortLevels`, through
  `personaEffortLevels`). An unsupported effort is refused on Persona create and update, is an
  `unsupported_effort` publish-blocking diagnostic on a node, and at run time is reported as
  `effort.unsupported` rather than passed or silently dropped: the call runs at the provider
  default, the dropped level is stored on `workflow_node_attempts.effort_unsupported`, logged
  as `persona_effort_unsupported`, and printed on the run's routing line.
- Publish freezes the Persona's effort in its snapshot and the node's in its override.
- The effort that ran is recorded on `workflow_node_attempts.effort` and
  `workflow_llm_calls.effort`, and shown beside the model on every routing line.
- Built-in Personas stay read-only; a node override is how their effort is set.

**Upstream behavior it assumes.**

- `HarnessCapabilities.effort.levelsFor` and `launchArgs` for `claude` and `codex`, and that the
  headless `LlmRunnerId` values name the same providers as those harness ids.
- `claude -p` accepts `--effort`, `codex exec` accepts `-c model_reasoning_effort=`, the Claude
  Agent SDK accepts `effort` and the Codex SDK accepts `modelReasoningEffort`.
- Persona nodes resolve through `resolveWorkflowNodeExecution`, and `personaSnapshotOf` is the one
  snapshot builder.

**Upstream surfaces touched.** `src/shared/workflow.ts` (Persona, PersonaSnapshot, override,
execution view, attempt and call types, diagnostic codes), `src/shared/protocol.ts` (Persona and
override schemas), `src/shared/workflow-graph.ts`, `src/shared/llm.ts` (`LlmRunOptions.effort`),
`src/server/db.ts` (`personas.effort`, `workflow_node_attempts.effort`,
`workflow_node_attempts.effort_unsupported`, `workflow_llm_calls.effort`), `src/server/workflows/{personas,store,engine}.ts`,
`src/server/routes.ts` (`persona_unsupported_effort`), the four LLM transports and
`src/server/claude-cli.ts`, settings-backup Persona schema, and the Persona editor, node routing
editor, version history and run views.

**Fork-only files.** `src/web/workflows/EffortSelect.tsx`, `test/persona-effort.test.ts`,
`e2e/specs/workflow-persona-effort.spec.ts`.

## Superseded and removed

### Complete frees the worktree

| Field | Value |
| --- | --- |
| Status | **Superseded by upstream** #1148, 2026-09-29, sync PR #62 |
| PRs | #11 (plan), #17 |
| Plan docs | [complete-frees-worktree/plan.md](../plans/complete-frees-worktree/plan.md) (kept as history) |
| Upstream candidate | No. Upstream solved the same problem its own way. |

**Intent (as built).** Worktrees piled up after tasks were completed. #17 added an opt-in
"Free the worktree" checkbox to the Complete dialog, backed by a safety preview at
`GET /api/tasks/:id/free-preview` that refused to free a checkout with unpushed or uncommitted work.

**What replaced it.** Upstream #1148 makes Complete always reset and return task-owned
worktrees, and returns a safely killed task's checkout automatically. The sync removed the
checkbox, the preview route, the `freeWorktree` request field, `TaskFreePreview`,
`worktreeFreeability`, and their tests, e2e spec and route-surface entry (plan decision D1). The
runbook's worked example records the resolution. Consequence: Complete now discards uncommitted
changes in task worktrees, which is upstream's intended behavior.

### Dependabot

| Field | Value |
| --- | --- |
| Status | **Removed** 2026-09-29, sync PR #62 |
| PRs | #35 (config), #40 (`@hono/node-server` 1.x to 2.x), #41 (`concurrently` 9 to 10), #43 (13 grouped minor and patch bumps) |
| Plan docs | [upstream-sync/plan.md](../plans/upstream-sync/plan.md) decisions D2 and D5 |
| Upstream candidate | No. |

**Intent (as built).** Automated dependency bumps for the fork.

**Why it was removed.** It moved versions away from upstream, which made every sync fight the
lockfile. The sync deleted `.github/dependabot.yml`, rolled every dependency back to upstream's
version, and closed the open Dependabot PRs. The fork now takes new versions only through the
sync.

## Standalone fixes

Fixes that are not part of a fork feature. None had an upstream equivalent on `upstream/main`
at `104a5407` (checked by each fix's key symbol).

| PR | Merged | What it fixes | Surface touched | Upstream candidate |
| --- | --- | --- | --- | --- |
| #4 | 2026-09-27 | The ship and bugfix handoff told sessions not to commit, so workflow Checks tested the base HEAD. Sessions now commit locally before reporting complete. | `src/shared/task-completion.ts`, `src/server/task-contract.ts`, `src/server/foreman/ship-shepherd.ts` | Yes: upstream still defers the commit. |
| #13 | 2026-09-27 | The Backlog drawer's next-up mark was clipped on narrow rows; the test preload now also clears inherited `*_BIN` overrides. | `src/web/styles.css`, `test/setup-state.mjs`, `AGENTS.md` | Maybe: the `*_BIN` preload part is generic; the CSS part follows the fork's Shape this button. |
| #15 | 2026-09-28 | The WezTerm socket locator's fixed 1 s timeout made `terminal-emulator-spawn` flaky under load; the timeout is now injectable. | `src/server/terminal/wezterm-socket.ts`, `src/server/terminal/wezterm.ts` | Yes: a generic test flake. |
| #18 | 2026-09-28 | A tooltip stayed stranded after its disabled anchor was swapped for an enabled one. | `src/web/components/Tooltip.tsx` | Maybe: the fix is generic; its spec uses the fork's shape dispatch refusal. |
| #19 | 2026-09-28 | SDK one-shots (Personas, Inspector) loaded claude.ai MCP connectors such as Gmail send and Drive share. | `src/server/llm/claude-sdk.ts`, `src/server/llm/claude-grant.ts`, `src/server/harness/claude/sdk-types.ts` | Yes: a security issue that applies upstream as is. |
| #21 | 2026-09-28 | A refused Shape this left the task converted to shape; it is now one atomic `POST /api/tasks/:id/shape`. Related to Shape tasks, grill and tickets. | `src/server/routes.ts`, `src/server/tasks.ts`, `line/BacklogDrawer.tsx`, `layouts/BacklogColumn.tsx` | No: shape does not exist upstream. |
| #22 | 2026-09-28 | Persona and Foreman verdicts were rejected when the model sent `null` for optional fields; retries now name the real schema miss. | `src/server/workflows/verdict.ts`, `src/server/foreman/verdict.ts`, `src/server/llm/structured.ts`, `src/server/workflows/engine.ts` | Yes: generic workflow reliability. |
| #23 | 2026-09-28 | A slot quarantined during acquire kept a phantom owner and could never be destroyed; reconcile recovers slots already stuck. | `src/server/worktrees/manager.ts`, `src/server/worktrees/store.ts` | Yes: #1148 changed `manager.ts` but not this path. |
| #24 | 2026-09-28 | Codex "model unsupported" and "quota exhausted" failures were retried as infrastructure failures; they are now typed, not retried, and shown. | `src/server/llm/codex.ts`, `src/shared/llm.ts`, `src/server/llm/structured.ts`, `src/server/workflows/engine.ts` | Yes: generic; adds an `error_code` value. |
| #33 | 2026-09-29 | The e2e fake `node` shim orphaned fake processes on timeout (it now `exec`s); also repairs the review-answer spec after #30. | `e2e/fixtures/conductor.ts`, `e2e/specs/review-answers-in-conversation.spec.ts` | Maybe: the shim fix is generic; the spec fix follows fork #30. |
| pending | pending | Three test files never exited: completed fixture tasks owed a worktree return that retried every 30 s forever, each try scanning every process with `ps` and `lsof`, at ~28 concurrent `ps` and near-zero idle CPU. Returns now back off to 15 min, the files use instant return seams, and `test:run` sets a 180 s per-test timeout. | `src/server/tasks.ts`, `package.json`, `test/helpers/task-manager.ts` | Yes for the backoff: upstream has the same flat 30 s retry. The `test:run` flags belong to the fork's flake-aware testing. |

## Keeping this ledger current

- **A fork PR that adds or changes a feature** updates that feature's entry here (or adds a new
  one, and a row in "At a glance") in the same PR. A standalone fix adds a row to the fixes
  table. This rule is stated in the "Fork" section of `AGENTS.md`.
- **Every upstream sync** checks the new upstream commits against each active entry before
  merging, and updates statuses and the status header afterwards, following
  [docs/upstream-sync.md](../upstream-sync.md) sections 2 and 7.
- **Re-render the HTML** whenever this file changes, in the same commit. `ledger.html` is this
  file converted with `marked` (already in `node_modules`) and wrapped in the page shell at the
  top of the current `ledger.html` (everything up to `<main>`), keeping its inline light and
  dark styles:

  ```sh
  npx marked --gfm -i docs/fork/ledger.md -o /tmp/ledger-body.html
  ```

  Replace everything between `<main>` and `</main>` in `ledger.html` with that output. Nothing
  checks this mechanically; review does.
