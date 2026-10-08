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
| Last synced upstream | **1.26.0**, `upstream/main` at `2012e91b` (upstream #1164) |
| Sync date | 2026-10-05, fork PR #175 (merge commit `fdf3e845`) |
| Fork commits ahead of upstream | **341** (247 excluding merge commits) |
| Upstream commits behind | **0** |
| Active fork features | **14** (plus 3 superseded or removed, and 12 standalone fixes) |
| Measured at | `sync/upstream-2026-10-05` `3cc1b233`, 2026-10-05 |

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
| Upstream sync process and fork ledger | Active | #59, #62, #66, weekly mission PR, #175 (2026-10-05 sync) |
| Persona reasoning effort | Active | Pending (branch `feat/persona-effort`) |
| PR merge-conflict reactions | Active (signal, chip, Blocked pull requests inbox and alert, workflow repair rounds) | #108, #125, #145, pending (branch `feat/workflow-merge-conflicts`) |
| Per-task base branch | Active (storage, API, MCP, dispatch, reset, PR base, checks, conflicts, merge watcher, recurring-mission template, task form field and card label) | #151 (plan M0.1), #161, #162, #163 |
| Docs-only CI | Active (the `docs checks` job, the `docs-only-ci` skill, and the docs-only skip with `CI result` in this repository) | #164, #168, #171 |
| CI time-to-green | In progress (Node 26 off pull requests, one build-and-smoke job per Node release, one provisioning path in the unit shard, `main`-push tree reuse, duration-balanced unit shards, shard counts from a 20-job budget, and one E2E `dist/` built by `build-smoke-node-24`; the measured median is pending) | #200 (plan), #215 (Node 26 and build-smoke), #214 (one provisioning path), #218 (tree reuse), #219 (balanced unit shards), #221 (shard budget), #222 (shared E2E `dist/`) |
| Windows support | In progress on `release/windows` (plan, `.gitattributes`, the four platform seams and the weekly sync runbook on `main`; Windows CI, the win32 seams, state home, harness and runtime availability, Keep Awake, Setup checks, the Electron dev shell and the Windows docs on the branch) | #128 (plan), #147, #152, #154, #158, #176, #184, #185, #224, #187, #191, #192, #196, #197, #201, #209, #210, #220, #225, #233, pending (gate readiness, M2.12), pending (Windows CI wall time), pending (repository index path delimiter), pending (shell-script tests under Git Bash) |
| PR publication ownership | Active | #110 (plan), #119 (deferred publication), #120 (completion latch), #122 (unbound plan and shape), pending (branch `feat/pr-grant-authorization`) |
| Complete frees the worktree | Superseded by upstream #1148 (2026-09-29, #62) | #11, #17 |
| Dependabot | Removed (2026-09-29, #62) | #35, #40, #41, #43 |
| CodeQL advanced setup | Removed (2026-10-04, pending) | #65 |
| Standalone fixes | Not a feature | #4, #13, #15, #18, #19, #21, #22, #23, #24, #33, #77, #91 |


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
| PRs | #1 (plan), #3, #7, #9, #10, #83 (plan: tickets after merge), #87, #92, #99 (tickets start at merge), pending (tickets marker, issue #82), pending (MCP `create_task` files scout, plan and shape). Related, not claimed: #21 (standalone fix to Shape this) |
| Plan docs | [shape-task-kind/plan.md](../plans/shape-task-kind/plan.md) sections 1 to 5; [shape-tickets-after-merge/plan.md](../plans/shape-tickets-after-merge/plan.md) (in progress) |
| Upstream candidate | Maybe. Self-contained and built on upstream pieces, but it is a second planning path and bundles third-party-derived skills (credited in `NOTICE`). |

**Intent.** A new planning kind, `shape`, beside `plan`. It interviews the human in rounds of
decision forms (grill) before writing a plan, then splits the approved plan into
dependency-gated backlog tasks (tickets), which it can mirror to a task source. Upstream `plan`
drafts first and asks afterwards, and cannot turn a plan into gated tasks or GitHub sub-issues.

**Behavior contracts.**

- `shape` always asks at least one round: one `request_plan_decisions` form per round, the
  recommended option first, plus a free-text Other. Dismissing a round stops the session. The
  plan review's follow-up is Create tickets after the plan merges or Stop (decision
  `shape-follow-up`, options `create-tickets` and `stop`), never `/phased-plan`. The shaping
  turn does not invoke `tickets` and files no tasks; a workflow-bound shape task's completion
  contract (`taskCompletionContract("shape", true)`) is the plan's minus phases, and expects no
  ticket or phase tasks. The plan kind's contract is unchanged.
- Tickets after merge ([shape-tickets-after-merge](../plans/shape-tickets-after-merge/plan.md)
  sections 2 and 4). `tasks.shape_tickets` records the choice, written only by its own
  compare-and-set accessor (never `upsertTask`), through named transitions in
  `shape-tickets.ts` that each take the Registry as `ShapeTicketsPublisher` and re-send the task
  whenever the row moved. It is stamped `awaiting-review` when a shaping
  task (not a follow-up) is delivered its contract at either seam, so every row from before this
  change and every other kind stays NULL and is never acted on. An answered plan-decisions
  review carrying `shape-follow-up` sets `pending` or `stop` (latest wins, dismissal writes
  nothing). When a shape task completes with its merge quorum (`mergeOutcomeFor`, checked in
  `finishCompletion`) and the choice is `pending` or `lapsed`, `TaskManager` starts the
  follow-up through the manual action's service, so the same acceptance rule allows exactly one.
  The choice becomes `started` only once dispatch is accepted, or `queued` when it is refused;
  `queued` becomes `started` when `TaskManager.dispatch` later accepts that follow-up. A
  completion without the merge, a cancel or a failure lapses `pending`, as does
  `Registry.onTaskPrClosed`: the by-URL PR poller now reports a task-bound URL whose raw state is
  `CLOSED`, and the registry announces it once per (task, current episode, URL). `lapsed` is not
  final: a later merge-quorum completion still starts the follow-up. Workflow run state is never
  read. `Task.shapeTickets.state` carries the choice on the wire.
- The tickets marker ([shape-tickets-after-merge](../plans/shape-tickets-after-merge/plan.md)
  section 8) reads `Task.shapeTickets` through `shapeTicketsMarker` (`src/web/lib/shape-tickets.ts`)
  and is drawn by one component, `ShapeTicketsMarker`, on the board card's flag row, in the board
  drawer's detail band, and on the Sitrep's Recent outcomes row (where a finished shape task
  lives once its session closes at the merge): `pending` is the note **Tickets after merge**,
  `queued` **Tickets queued** and `started` **Tickets**, each a link-role button opening
  `followupTaskId` through the app's one `openTask`, which lands where `taskOpenTarget`
  (`src/web/lib/open-task.ts`) says: a session that has not exited, the backlog editor, or, for a
  finished task only, the Sitrep scrolled to its Recent outcomes row and marked `aria-current`;
  an in-flight task with no session yet shows the fleet and is opened once one of those exists,
  but only within 30 s and while the view is the one the click left (`pendingTaskOpenState`),
  and `lapsed` the note **Tickets lapsed**. Every other state, a queued or started choice with no
  follow-up left to open, and every non-shape task draw nothing.
- Dispatch is refused, naming the toggle, when a required planning skill is off
  (`PLANNING_SKILLS.shape` is `grill`, `htmlPlans`, `tickets`). After work defaults to Plan
  Validation. Shape can be put on the backlog and filed by MCP `create_task` (v3 route, with
  scout and plan; chat and pipeline stay refused), but schedules cannot file it, and Foreman's
  autopilot never launches it.
- The breakdown review is one decision form and nothing is created before Submit. Each ticket
  is New task or Adopt an open backlog task. In-session mode (a shape session dispatched before
  tickets moved after the merge) writes `docs/plans/<name>/tickets.md` and its HTML, commits,
  then files tickets in dependency order; they are released when the planning PR merges.
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
- **Create tickets** on a merged shape task (the Sitrep's Recent outcomes row) creates and
  dispatches `Tickets: <shape title>`, a linked shape task in tickets-only mode, through
  `POST /api/tasks/:id/shape-tickets`. Accepted only for a done shape task with a merged PR
  posture (`retroPrPostureForTask`, the post-merge Retro's check), no live follow-up, none done
  with its tickets filed, and none that ended otherwise (cancelled, failed, dismissed, deleted)
  after filing any ticket: a task edge to the source selected at or after that follow-up was
  created. A dismissed breakdown that filed nothing does not block a retry, a refinement of the
  plan's decision 12. Otherwise 409 with the reason. Deleting a follow-up, or a ticket one
  filed, re-sends the source. The follow-up keeps the source's repositories, has
  After work None (`workflowId: null`), and runs on the source's agent, or the configured shape
  agent when that one cannot run `tickets`. A refused launch leaves it in the backlog with the
  reason as its error. The wire `Task.shapeTickets` (`followupTaskId`, `canCreate`) is derived
  by the Registry on every publish of a shape task, and a follow-up's status change re-sends its
  source.
- The tickets-only contract names the source task, its merged PR and branch, invokes only
  `tickets`, and asks with `request_input` when the merged PR does not show exactly one plan.
  `complete_shape_tickets` (`filed` or `dismissed`), granted only to follow-up launches, completes
  the follow-up and closes its session; it is refused for any other session and idempotent on
  replay. The tickets skill's follow-up mode skips the tickets file, its commit and push, and the
  "record the ids" step; in-session mode is unchanged
  ([shape-tickets-after-merge](../plans/shape-tickets-after-merge/plan.md) sections 5 to 7).
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
- Merge completion runs through `TaskManager.finishCompletion`, and `mergeOutcomeFor` is the
  merge-quorum predicate every merge path completes on. Cancel and agent-gone failures publish a
  `task_upsert` with the terminal status. `reviews` resolution stays in
  `ReviewManager.resolve` with `selections` as `PlanDecisionAnswer[]`.
- The PR poller asks `gh pr view <url> --json state,mergedAt` for task-bound URLs
  (`taskPrPollTargets`) that no live branch lookup observed, and the branch lookup still drops a
  closed, unmerged PR.
- MCP `create_task` (`/mcp/tasks`, `/mcp/v2/tasks`) and `pushTask` (in-flight claim, seen-ledger
  row and task link in one transaction) keep their semantics.
- Backlog edit and dispatch routes and the dependency cycle and new-edge refusals
  (`bulkTaskPatch`, `TaskManager.update`) keep their semantics.

**Upstream surfaces touched.**

- Modules: `src/server/{dispatcher,tasks,task-contract,routes,mission-mcp,reviews,pr}.ts`,
  `src/server/plans/{skills,tools}.ts`, `src/server/foreman/{plan-publication,worker,wrapup-eligibility}.ts`,
  `src/mcp/server.ts`, `src/server/schedules/store.ts`, `src/server/archives/task-gateway.ts`,
  `src/server/task-sources/{push,github-issues}.ts`, `src/shared/{task,task-completion,types,protocol,task-source}.ts`,
  `src/shared/telemetry-sources/{primary-actions,action-exclusions}.ts`, `src/server/registry.ts`
  (derives `Task.shapeTickets` on publish; `onTaskPrClosed`, `reconcilePrClosures`,
  `republishShapeTickets` made public as the transitions' publisher).
- Routes: new `POST /mcp/v3/tasks`, `POST /mcp/backlog`, `POST /mcp/push-task`,
  `POST /api/tasks/:id/shape` (#21), `POST /api/tasks/:id/shape-tickets`,
  `POST /mcp/shape-tickets/complete`; `GET /api/harnesses/config` and `GET /api/skills` list
  shape and grill.
- Protocol: `TASK_KINDS` (+`"shape"`), `MCP_TASK_KINDS`, `SCHEDULE_TASK_KINDS`,
  `isPlanningTaskKind`, `McpCreateTicketSchema`, `McpAdoptTicketSchema`,
  `McpCreateTaskV3Schema`, `McpListBacklogSchema`, `McpPushTaskSchema`,
  `PushDraft.blockedBy` and `.parent`, `CompleteShapeTicketsSchema`, `Task.shapeTickets`
  (with `state`), `SHAPE_TICKETS_STATES`.
- Registries: `PLANNING_SKILLS`, `KIND_MISSION_MCP_TOOLS.shape`, `MISSION_MCP_TOOLS`,
  `PRIMARY_ACTION_ROUTES`, `ACTION_EXCLUSIONS`.
- MCP tools: new `list_backlog_tasks`, `push_task` and `complete_shape_tickets`; `create_task`
  gains ticket and adopt fields, and its `kind` takes `scout`, `plan` and `shape` beside `ship`
  and `bugfix`.
- DB: new `shape_ticket_followups` table (created with the base schema, so an existing database
  gains it on open); new nullable `tasks.shape_tickets` column (`addColumn` in the migration
  path, no backfill).
- UI: `DispatchModal.tsx`, `layouts/BacklogColumn.tsx` and `line/BacklogDrawer.tsx` (Shape this),
  `ReportPanel.tsx` (Create tickets and the tickets marker), `schedules/ScheduleEditor.tsx`,
  `src/web/lib/guided-dispatch-steps.ts`; the tickets marker in `layouts/SessionTile.tsx`,
  `layouts/ConsoleDetail.tsx`, `layouts/BoardView.tsx`, `layouts/types.ts`
  (`SessionViewProps.onOpenTask`, `shapeTaskForSession`), `App.tsx` (`openTask`, shared with the
  ensemble member list) and `styles.css`.

**Fork-only files.** `src/server/plans/shape.ts`, `src/server/shape-tickets.ts`,
`src/server/shape-tickets-followup.ts`, `src/web/lib/shape-tickets.ts`,
`src/web/components/ShapeTicketsMarker.tsx`, `src/mcp/unknown-route.ts`, `skills/grill/`,
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
- Upstream's own specs and tests still write `defaultWorkflowId`, which the fork refuses. A sync
  repoints each new one at `kindWorkflowDefaults` (2026-10-05: upstream #1155's
  `e2e/specs/workflow-elapsed-clock.spec.ts`).

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
| PRs | #59 (plan), #62 (first sync, runbook), #66 (this ledger), the PR that recorded the weekly sync mission in the runbook (all after the original backfill range), and #175 (the 2026-10-05 sync) |
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

### PR merge-conflict reactions

| Field | Value |
| --- | --- |
| Status | **Active**, tickets 1 to 3, the workflow ticket and the Foreman nudge ticket: the mergeability signal, the PR chip mark, conflict episodes, the Blocked pull requests inbox and its `pr-conflict` alert, Wait for CI's conflict repair round, and Foreman's conflict nudges and escalation |
| PRs | #108, #125, #145, #148, pending (the Foreman nudge ticket) |
| Plan docs | [docs/plans/pr-merge-conflicts/plan.md](../plans/pr-merge-conflicts/plan.md) |
| Upstream candidate | Yes. It extends upstream's own PR poller and chip and adds no fork-only concept. |

**Intent.** A session's pull request that conflicts with its base was invisible: GitHub reports
it `CONFLICTING`, CI often stops running, and nothing in Mission Control said so. This ticket
adds the one mergeability signal every later conflict reaction (Foreman nudges, workflow repair
rounds, the Blocked pull requests inbox) reads, and shows it as a "Conflicts with `<base>`" mark
on the PR chip on cards, in the session header and on the rail. Ticket 2 adds the daemon's single
owner of "is this conflict handled?" and the inbox section for the conflicts nothing handles.
Ticket 3 adds one desktop alert per PR entering that section. The workflow ticket gives a
workflow-owned session its conflict as an ordinary repair round from Wait for CI, instead of a
45-minute wait for `ci_missing`, and sends the conflict to the inbox as `workflow-not-gating`
when the run can no longer reach a Wait for CI node.
The Foreman nudge ticket makes Foreman nudge a live session it drives to merge its base in, at
most 3 times per episode, and hand the conflict to the operator when the nudges do not resolve it.

**Behavior contracts.**

- The branch poller requests `mergeable` and `baseRefName`; the by-URL poller requests
  `mergeable`, `baseRefName` and `headRefOid`. GitHub's value normalises to `PrMergeable`
  (`"mergeable" | "conflicting"`), and `UNKNOWN` is no observation.
- `Session` and every `RepoPrFeedback` carry `prMergeable: { state, headSha } | null`,
  `prBaseRef` and `prHeadSha`, set and cleared with `prState`/`prChecks`. On `UNKNOWN`,
  `prHeadSha` advances and the observation is kept whole, old head included. A merged or
  closed pull request has no observation.
- `currentMergeability(pr)` (`src/shared/pr-mergeable.ts`) answers only when the observation's
  head is `prHeadSha`. The chip reads through it.
- A by-URL result writes only those three fields onto every session whose `prUrl` matches,
  exited sessions included, and onto matching live per-repo observations. It has no authority
  over `prState` or completion.
- `reconcilePrs` leaves an exited session's PR fields alone when the branch poller did not
  report it (exited sessions are never polled), so the link survives the exit linger.
- No schema migration: these are live, in-memory observations like `prChecks`.
- Conflict episodes (`src/server/pr-conflicts.ts`) are in memory and keyed by PR URL alone. An
  episode opens on the first `conflicting` read of the current head from either poll path,
  advances `headSha` on each new conflicting head, and closes on `mergeable`, merged, closed,
  or once no session (until `session_remove`) and no task references the URL. An unknown
  current head leaves it as it is.
- Every open episode's URL joins the by-URL poller's `linkedUrls`, never `operationalUrls`, so
  an exited, task-less session's PR is still polled and gains no merge-completion authority.
- An open episode is blocked as `session-gone` when no live session owns the PR, or
  `foreman-cannot-nudge` when `trackMergeConflicts` is off or `foremanCannotDrive` /
  `foremanMayActLive` refuse the live session (the same predicates `decideReviewFollowup`
  reads). Work an active workflow run owns is matched through every session naming the PR
  (exited ones included) and the task's work-episode binding, which outlives the session, through
  one rule (`Registry.owningRuns`) for both ownership and the runs that may gate the PR. It is
  handled when one of its non-terminal runs for the PR's own repository can still reach a Wait
  for CI node (`WorkflowManager.waitForCiReachable`), and `workflow-not-gating` otherwise. The
  set is published as the `blocked_prs` event, only on change, and on the snapshot as
  `blockedPrs`. A `workflow_run_upsert` or `workflow_run_remove` re-derives it between polls
  (`PrConflictTracker.reclassify`) while any episode is open.
- Reachability is two pure functions in `src/shared/workflow.ts`. `workflowRunActiveNodeIds`
  is the latest submission's queued, running, retrying or waiting attempts; with none, Session
  for `waiting_for_session`, the continued action (or Session) while capturing, and nothing for
  a blocked or terminal run or one at the Inspector's completion gate. `waitForCiReachable`
  walks every edge, any port, from those nodes, and a Wait for CI the operator disabled for the
  run is walked through but never counts.
- `decideWaitForCi` takes `mergeability: { mergeable, headSha, baseRef } | null`, read by the
  manager through the same seam as the CI observation (`WaitForCiReaders`), from the bound
  session's `prMergeable` / `prBaseRef` or its `repoPrs` entry (`sessionPrMergeability`).
  `headSha` is the observation's own head. Conflicting on `expectedHeadOid` returns `fail` with
  `conflict: { baseRef }` before every other branch; on any other head it waits.
  `waitForCiVerdict` turns it into one requested change, "Resolve merge conflicts with
  `<base>`", whose rationale is `mergeConflictResolutionSteps` (`src/shared/pr-mergeable.ts`):
  merge the base in, never rebase or force-push. The `fail` edge is an ordinary repair round.
- With `trackMergeConflicts` on, a workflow Pull Request action packet with no Wait for CI after
  it (`waitForCiFollows`) carries `workflowPullRequestConflictContract`, whose method is
  `mergeConflictResolutionSteps`, the same one the Wait for CI repair uses, independent of
  `trackCiFailures` and frozen with the packet. It counts toward the session action envelope
  allowance.
- `ForemanConfig.trackMergeConflicts` (default true) sits beside `trackCiFailures`; its
  checkbox is **Keep sessions on track with merge conflicts**, and follow-through gate 1 skips
  only when all three toggles are off.
- The attention inbox's **Blocked pull requests** section follows Pipeline halts, each row one
  answer owed, read-only.
- `AlertKind` `"pr-conflict"` (attention, id `pr-conflict:<url>`) fires from `detectAlerts` when
  a PR enters `AlertScope.blockedPrs`; a reason change while it stays blocked does not re-fire.
  `useNotifier` holds `alertedPrConflicts` (PR URL to when it was last seen blocked or seen
  leaving) for the page's lifetime and passes it as `AlertMemory`, so a PR re-alerts only after
  `PR_CONFLICT_REALERT_MS` (5 minutes) out of the set, never after a reconnect or daemon restart.
  Only the browser raises it: the away watcher's scope carries no `blockedPrs`.
- Foreman's follow-through has a third dimension (the Foreman nudge ticket). `FollowupPr` carries the head-bound
  `mergeable` observation, `baseRef`, `headSha` and the snapshot's `conflictEscalated`;
  `feedbackState.conflicting` is `trackMergeConflicts && currentMergeability(pr) ===
  "conflicting"`. `FollowupMark` gains `conflictHead`, `conflictNudges`, `conflictNudgedAt`,
  `conflictEscalated` and `conflictEscalatedAt`; `advanceFollowupMark` re-arms them only on a
  current head observed `mergeable`, leaves them on an unknown head, and seeds
  `conflictEscalated` from the snapshot.
- A conflict nudge needs a conflicting current head that is not `conflictHead`, fewer than 3
  nudges (`CONFLICT_NUDGE_CAP`), and no escalation on either side, plus every existing gate and
  the stamp-then-inject delivery with rollback. Its payload line is "it has merge conflicts with
  `<base>`", with the fetch, merge, resolve, focused-tests and no-rebase steps, in one payload
  with CI and findings.
- `decideReviewFollowup` returns `escalate`, ahead of the pane gates and behind only workflow
  ownership, on a new conflicting head after 3 nudges, or after `CONFLICT_GIVE_UP_MS` (2
  minutes) settled-idle on the nudged, still-conflicting head, counted from the nudge too. An
  escalated mark re-sends every `CONFLICT_ESCALATE_RESEND_MS` (1 minute) while the head is
  conflicting. The worker posts `POST /api/pr-conflicts/escalate { prUrl, headSha }`
  (`EscalatePrConflictSchema`) only while it holds the lease, restores the mark on failure, and
  logs and records a `pr-conflict` episode on the first send only. A failed record is logged and
  costs nothing else.
- The route marks the open episode found by URL alone `escalated` (`503` with no tracker,
  `{ escalated: false }` with no open episode). The flag lives with the episode, so a mergeable
  read re-arms it. An escalated live owner is blocked as `nudges-exhausted`, after
  `session-gone` and ahead of `foreman-cannot-nudge`. `Session.prConflictEscalated` and
  `RepoPrFeedback.prConflictEscalated` carry it, set by `Registry.setEscalatedPrUrls`.

**Upstream behavior it assumes.**

- `gh pr list --json` and `gh pr view --json` accept `mergeable`, `baseRefName` and
  `headRefOid`.
- `pollAndReconcilePrs` runs the branch passes (`reconcilePrs`, `reconcileRepoPrs`) after the
  by-URL lookups in one tick, and `prPollTargets` excludes exited sessions.
- Exited sessions are removed `EXIT_LINGER_MS` after exit through `beginEviction`.
- `prChipView` is the one decision behind `PrChip`, `PrTileFlag` and `PrRailMark`.
- `taskPrPollTargets` covers every task in a `completableByMerge` status, so a dispatched task's
  PR stays referenced after its session is removed.
- `foldAttention` sections never interleave, and the inbox draws one arm per item kind.
- Wait for CI is decided only by `WorkflowEngine.observeWaitForCi`, called from the manager's
  sweep, and its `fail` edge returns to Session as a repair round like any verdict node.
- A removed session's binding is orphaned and its run blocked (`orphanBinding`). Since upstream
  #1161 a binding a runtime transfer protects is not orphaned; it moves to the terminal
  successor session instead.

**Upstream surfaces touched.** `src/server/pr.ts` (both `gh` queries, by-URL result
collection), `src/server/registry.ts` (`PrMatch`, `LivePrObservation`, `reconcilePrs`,
`reconcileRepoPrs`, `repoPrFeedbackFor`, new `reconcilePrUrlMergeability`, session comparator,
session construction sites), `src/shared/types.ts` (`Session`, `RepoPrFeedback`, new
`PrMergeable` types), `src/web/components/session-bits.tsx` (`prChipView`, `PrChip`,
`PrTileFlag`, `PrRailMark`), `src/web/styles.css`, `src/web/lib/board-card-preview.ts`, the e2e
fake `gh` (`pr view` output), and every test `Session` literal. Ticket 2: `src/server/pr.ts`
(the episode harvest and `startPrPoller`'s Foreman config), `src/server/registry.ts`
(`taskPrUrlOwners`, `prReferences`, `workflowOwnsSession`, `setBlockedPrs`, snapshot),
`src/server/index.ts`, `src/server/foreman/review-followup.ts` (`foremanCannotDrive`, gate 1),
`src/server/foreman/worker.ts`, `src/shared/protocol.ts`, `src/shared/app-config-entries.ts`,
`src/shared/types.ts` (`BlockedPr`, `blocked_prs`, snapshot), `src/web/useEventStream.ts`,
`src/web/App.tsx`, `src/web/lib/attention.ts`, `src/web/components/AttentionInbox.tsx`,
`src/web/components/ForemanBar.tsx`, `src/web/styles.css`, and every test `ForemanConfig`
literal. Ticket 3: `src/shared/alerts.ts` (`AlertKind`, `AlertScope`, `detectAlerts`),
`src/web/useNotifier.ts` and `src/web/App.tsx` (the alert scope). Workflow ticket:
`src/shared/wait-for-ci.ts` (`decideWaitForCi`, `WaitForCiDecision`), `src/shared/workflow.ts`
(new `waitForCiReachable`, `workflowRunActiveNodeIds`), `src/shared/types.ts`
(`BlockedPrReason`), `src/server/workflows/engine.ts` (`waitForCiVerdict`, `observeWaitForCi`),
`src/server/workflows/manager.ts` (options, packet preparation, `observeWaitForCiAttempt`, new
`waitForCiReachable`, `sessionPrMergeability`), `src/server/workflows/feedback.ts`
(`renderSessionAction`), `src/server/workflows/agent-contract.ts`, `src/server/registry.ts`
(`taskPrUrlOwners`, `prReferences`, `owningRuns`), `src/server/pr.ts` (`startPrPoller`,
`reclassifyOnWorkflowRunChange`) and `src/server/index.ts`. The Foreman nudge ticket: `src/server/foreman/review-followup.ts` (`FollowupPr`, `FollowupMark`,
`advanceFollowupMark`, `decideReviewFollowup`, `buildPayload`), `src/server/foreman/worker.ts`
(`runReviewFollowup`, new `escalateConflict`), `src/server/foreman/client.ts`,
`src/server/routes.ts` (`RouteDeps.prConflicts`, the escalate route), `src/server/pr.ts`
(`startPrPoller` takes the tracker), `src/server/index.ts`, `src/server/registry.ts`
(`setEscalatedPrUrls`, `repoPrFeedbackFor`, session comparator and construction sites),
`src/shared/protocol.ts`, `src/shared/types.ts`, `src/shared/telemetry-sources/action-exclusions.ts`
(the escalate route's exclusion), `test/fixtures/route-surface.json` (its oracle line), and every
test `Session` literal.

**Fork-only files.** `src/shared/pr-mergeable.ts`, `src/server/pr-conflicts.ts`,
`test/pr-mergeable.test.ts`, `test/pr-conflicts.test.ts`, `test/blocked-prs-attention.test.ts`,
`test/pr-conflict-alerts.test.ts`, `test/workflow-ci-reachability.test.ts`,
`test/foreman-conflict-escalation.test.ts`, `e2e/specs/pr-merge-conflicts.spec.ts`,
`e2e/specs/workflow-merge-conflicts.spec.ts`.

### PR publication ownership

| Field | Value |
| --- | --- |
| Status | **Active**. Part A (completion latch, #120) and all of Part B: the deferred publication for the multi-repo manifest, the retro, deflake and testing-setup skills, the retro task intents, and the no-workflow ensemble winner (items 2 and 5, #119); unbound plan and shape with the phased-plan intent template (items 3 and 4, #122); and the execution-authorization split, unbound chat, and the pull-request skill precondition (items 1, 6 and the rest of 5, branch `feat/pr-grant-authorization`). The `gh pr create` block stays a recorded follow-up. |
| PRs | #110 (plan), #119 (deferred publication), #120 (completion latch), #122 (unbound plan and shape), pending (branch `feat/pr-grant-authorization`) |
| Plan docs | [pr-publication-ownership/plan.md](../plans/pr-publication-ownership/plan.md) |
| Upstream candidate | Mostly. Upstream has the same post-completion re-run: its Foreman claim and store are unchanged here apart from the latch. The manifest, retro and ensemble changes remove self-publishing text that contradicts upstream's own ship handoff. The deflake and testing-setup changes ride the fork-only Flake-aware testing skills. |

**Intent.** A pull request is opened only by the workflow's Pull Request action, by Foreman's
wrap-up, or by a direct command of the human, never on an agent's own initiative from a task
prompt or skill. Forensics found the visible symptom was not an early PR but a **new workflow
run starting after the PR existed**: the Pull Request action's own turn, Inspector fixes and
background wake-ups each settled under unchanged intent and claimed a fresh run on the binding.
The completion latch stops that. Separately, prompts and skills that told the agent to push and
open its own pull request now commit and report, and name the publisher. PR authority itself is
a grant, not a standing permission: no initial task prompt carries it, and only its holders (the
workflow Pull Request action, the Runs UI "Ask the session to open a PR", Foreman's Ship it?
card, Straight to PR and ship-shepherd handoff, and a human-typed request in the session) do.

**Behavior contracts.**

- Every Foreman claim that starts or resubmits a run, prompted or queue-drain, stamps
  `workflow_runs.claim_episode_key` with `intent:<objective_version>:<prompt_revision>` read
  from `session_goals` in the claim transaction.
- A prompted claim with no active run, on a binding with a `completed` run stamped with the
  claim's episode, is **latched**: it consumes the generation with the `workflow_latched`
  outcome, appends `claim_latched` on the completed run, starts and resubmits nothing, and
  answers `claimed: true` with state `latched`, so Foreman does not fall through to the Ship it?
  card or Straight to PR.
- Only an accepted human prompt advances the episode and re-arms the binding, for exactly one
  run. Cancelled runs and unstamped (pre-upgrade) runs never latch; queue-drain claims are never
  refused; in-run repair rounds still resubmit the same run.
- `workflow_latched` is appended to `PROMPTED_COMPLETION_OUTCOMES` and, like `workflow_claimed`,
  is refused on the ordinary consume route.
- Accepted residuals: a drain claim on a session with no recorded goal leaves the stamp null,
  and on the terminal runtime a daemon restart between a packet's delivery and its echo makes
  that packet read as human and re-arms the latch.
- The multi-repo manifest tells the agent to commit in each repository it changes, not to push
  or open a pull request, and that the workflow or Foreman opens one pull request per changed
  repository. An unchanged repository still needs no commit and no pull request.
- The retro (dispatched as its own task), deflake and testing-setup skills, and both retro task
  intents in `src/server/retro.ts`, commit and report complete, and name the publisher: the
  bound workflow's Pull Request action, or Foreman's wrap-up when no workflow is bound. A retro
  riding a session's own open review still pushes to it, because updating an existing pull
  request is allowed.
- Deflake carries `Fixes #<issue>` in its commit message and completion report, so the
  pull-request skill writes it into the description.
- Testing-setup verifies the "Flaky tests" check only after the publish instruction opened the
  pull request.
- The no-workflow ensemble winner commits and reports complete, and Foreman's Ship it? card
  publishes it.
- An unbound ship-kind session (testing-setup and the retro follow-up: `workflowId: null`)
  reaches a Foreman publish instruction after a committed turn: the Ship it? card under the
  default `ask` wrap-up, `WRAPUP_PR` under Straight to PR. Pinned in
  `test/prompted-wrapup-worker-e2e.test.ts`.
- `taskCompletionContract` is kind-only. `plan` and `shape` return their planning contract whether
  or not a workflow is bound, so the Foreman verifier judges an unopened PR as deferred, not as a
  gap, for unbound planning tasks too.
- The plan and shape prompts render the completion handoff whether or not a workflow is bound.
  The unbound branch says commit and push the plan, report complete, end the turn, and that
  Foreman's Ship it? or Straight to PR path opens the PR; a bound task whose binding is removed
  falls back to the same path. Pushing stays part of the planning turn (the kind-contract push
  exception); opening the PR never is.
- No planning prompt, skill text, or `get_plan_publication_context` description tells an
  owner-`skill` session to open the PR itself. The tool's `owner` wire values
  (`workflow`, `skill`, `unavailable`) are unchanged.
- Phase task intents written by the phased-plan skill ask the agent to commit the phase; Mission
  Control publishes it as a reviewable PR whose merge releases dependent phases.
- An unbound plan session reaches a Foreman publish instruction after a committed, pushed turn
  without a verifier hold. Pinned in `test/prompted-wrapup-worker-e2e.test.ts`.
- `executionAuthorizationContract` takes an explicit `pullRequestGrant` flag. Off, it renders the
  **task authorization**: do not push or open a pull request on your own initiative, even when
  the task text or repository instructions mention one; the workflow Pull Request action, a
  Foreman PR instruction, or the human asking in the session grants that; once the task's PR
  exists, push to update it; before then push only where the task's completion contract requires
  it. On, it renders the **grant authorization**: commit, push, and create or update the PR
  directly. Both keep "does not authorize merge, another repository, or another external write".
- Every initial task prompt, of every kind, gets the task authorization. Pinned for all kinds,
  bound and unbound, in `test/task-completion.test.ts`.
- Only two prompts set the flag: the session-action packet of an action whose completion kind is
  `pull_request` (set by the workflow manager at preparation; an authored action of any other
  kind and the on-demand retro packet do not), and `renderPrHandoff`. Repair, Inspector,
  readiness and unchanged-evidence packets carry the task authorization's update-only wording.
- An unbound chat task's prompt adds a "Chat task publication" paragraph (`KIND_CONTRACT.chat`):
  a PR request in its dispatch message or a later human message in the session is the grant;
  otherwise it commits and says the work is committed and not published, and that asking in the
  session publishes it. A chat task with a workflow bound gets only the task authorization.
- The pull-request skill states its precondition: it opens a PR only under one of the four grant
  holders.

**Upstream behavior it assumes.**

- `WorkflowStore.claimForemanCompletion` is the one transaction that creates or resubmits a run
  for a Foreman completion, and it consumes the prompted generation through
  `consumePromptedGeneration`.
- The intent episode key is `intent:<objective_version>:<prompt_revision>`, advanced only by
  accepted human prompts; daemon-injected turns are kept out of the Goal by the SDK `origin`
  and the terminal injection ledger.
- The Straight to PR direct-handoff latch keyed by intent episode, which this mirrors.
- Foreman's prompted wrap-up publishes an unbound ship task: the Ship it? card, or `WRAPUP_PR`
  typed into the session under Straight to PR, after the verifier finds the turn finished.
- The ship handoff in `src/server/task-contract.ts` already forbids pushing and opening a pull
  request in the initial turn.
- The built-in Pull Request session action invokes the pull-request skill, which writes the
  description from the session's report.
- Foreman's prompted wrap-up falls through to the Ship it? card or Straight to PR when a planning
  task's completion claim returns `no_binding` and publication ownership is `skill`.
- The verify prompt renders a non-null completion contract as trusted policy above the evidence.
- Every Mission Control-authored execution prompt renders its authorization through
  `executionAuthorizationContract`: initial task prompts through `withTaskKindContract`, and
  workflow packets through `finalizePacket` and `renderSessionAction`.
- Foreman retires an unbound chat task without a wrap-up, so nothing else publishes it.

**Upstream surfaces touched.** `src/server/workflows/store.ts` (`claimForemanCompletion`,
`consumePromptedGuard`), `src/server/db.ts` (`workflow_runs.claim_episode_key`),
`src/shared/types.ts` (`PROMPTED_COMPLETION_OUTCOMES`), `src/shared/workflow.ts` and
`src/shared/protocol.ts` (`WorkflowCompletionClaimResult` state `latched`, the consume-route
refinement), `src/server/foreman/worker.ts` (latched log line), `src/server/dispatcher.ts`
(`intentWithRepoManifest`), `src/server/ensembles/engine.ts` (`buildContinuation`),
`src/server/retro.ts` (`postMergeRetroIntent`, `retroTaskIntent`), `skills/retro/SKILL.md`,
`src/shared/task-completion.ts`, `src/server/plans/{prompt,shape,tools}.ts`, the
`get_plan_publication_context` description in `src/mcp/server.ts`, `skills/phased-plan/SKILL.md`,
`src/server/execution-authorization.ts`, `src/server/task-contract.ts` (`KIND_CONTRACT.chat`),
`src/server/workflows/feedback.ts` (`finalizePacket`, `renderSessionAction`, `renderPrHandoff`),
`src/server/workflows/manager.ts` (session-action packet preparation), `skills/pull-request/SKILL.md`,
`docs/{work-queues,workflows,foreman,recurring-missions,dispatch-and-backlog,skills-and-settings,flaky-tests,ensembles,sessions}.md`,
`docs/agent-guides/{change-contracts,architecture}.md`.

**Fork-only files.** `test/workflow-completion-latch.test.ts`,
`docs/plans/pr-publication-ownership/`. The deflake and testing-setup skill changes land in
`skills/deflake/` and `skills/testing-setup/`, already fork-only through Flake-aware testing.

### Per-task base branch

| Field | Value |
| --- | --- |
| Status | **Active**. The storage, surface, dispatch and ship half of plan M0.1, its check, diff, conflict and merge-watcher followers, the recurring-mission template (D35), and the task form field and card label; the session Diff view is a separate ticket. |
| PRs | #151, #161, #162 (task form field and card label), #163 |
| Plan docs | [docs/plans/windows-support/plan.md](../plans/windows-support/plan.md), "Per-task base branch" and M0 item 1; [docs/dispatch-and-backlog.md](../dispatch-and-backlog.md) "Start a task from another branch" |
| Upstream candidate | Yes. It is a general task field with no Windows-specific behavior. |

**Intent.** A task can name a branch on its primary repository's `origin` to start from and to
open its pull request against, so work for a long-lived branch such as `release/windows` can be
dispatched like any other task. Without one, nothing changes.

**Behavior contracts.**

- `tasks.base_branch` is nullable, added in `migrate()`; NULL means origin's default branch and
  is what every existing row reads as. `Task.baseBranch` carries it on the wire.
- `DispatchSchema` and `UpdateTaskSchema` take `baseBranch` (`BaseBranchSchema`: a plain branch
  name, never an option or a `refs/` path). MCP `create_task` sends it only through the strict v3
  route, and `push_task`'s strict body takes it, so an older daemon refuses rather than drops it.
- Create, update, MCP create and `push_task` refuse a base branch `origin` does not advertise
  (`resolveBaseBranch`, one `ls-remote --symref origin HEAD refs/heads/<base>`, 400). Dispatch
  refuses it again with a fresh fetch (`resolveDispatchBranchBase`), before any worktree is
  provisioned.
- A base branch equal to origin's advertised default is stored as NULL at write time, so a
  non-null `Task.baseBranch` was not origin's default when it was written. Rows that predate
  this, or whose origin later moved its default, are cleared by a startup pass
  (`clearStoredDefaultBaseBranches` in `src/server/base-branch-backfill.ts`, after the port):
  backlog tasks only, one `resolveBaseBranch` per distinct repository and branch, and any
  refusal or unreachable origin leaves the row alone.
- The dispatch form's backlog details carry a "Base branch" field on create and edit (empty is
  the default; an edit sends `null`), and the daemon's refusal prints on the form. The backlog
  card shows `base <branch>` (`.bl-base`) only when the task has one.
- Dispatch freezes the primary's base at `origin/<base>`'s advertised tip, checked against the
  fetched remote-tracking ref. A pinned `baseSha` still outranks it. Attached repositories keep
  their own default.
- An assign reset and the session reset route land on `origin/<base>` for a task that has one.
- The agent is told the base: `withTaskKindContract` appends a "Base branch" section naming
  `gh pr create --base <base>`, and the workflow PR handoff and Pull Request session action name
  it again. The fixed wrap-up texts (`WRAPUP_PR`) are unchanged.
- A workflow binding's base is `prBaseBranchFor` (`workflows/context.ts`): the task's for its
  primary repository, null otherwise. The captured evidence diff and an affected-tests check's
  selection measure from `merge-base(HEAD, origin/<base>)` (`changeSourceRef` in `diff.ts`),
  and a base missing from the remote-tracking refs fails rather than falls back.
- The Pull Request action's merge-conflict block names the binding's base. Foreman's nudge and
  the Wait for CI repair read GitHub's `baseRefName`, unchanged.
- A merge counts for a task with a base branch only when `gh` reports it merged into that branch
  (`Registry.mergeCounts`, on both the branch-poll and by-URL paths, before anything is stamped),
  so neither completion nor dependency satisfaction follows a merge into another branch. A task
  with no base branch counts a merge wherever it lands, as before.
- A recurring mission's task template carries an optional `baseBranch` (in the revision's
  `template_json`, so no migration; an absent key reads as null). Create and update refuse one
  `origin` lacks on the `baseBranch` field (`ScheduleManager.prepareDefinition`, through
  `resolveBaseBranch`, 400), and store origin's default as null as a task write does; preview
  checks only its shape. Every task a run files, scheduled or Run now, carries it, and dispatch
  checks it against origin again. The mission editor has a "Base branch" field and the detail
  shows it.

**Upstream behavior it assumes.**

- Agents, not the daemon, run `gh pr create`; every publication path is a prompt to the session.
- `resolveTaskBases` freezes every repository's base before provisioning, and native acquire
  resets a reused slot to the frozen commit, so Return resetting to the default is harmless.
- `withTaskKindContract` is the one composition point for both dispatch and assign.

**Upstream surfaces touched.** `src/server/db.ts` (`tasks.base_branch`, `TaskRow`, `rowToTask`,
`upsertTask`), `src/shared/types.ts` (`Task.baseBranch`), `src/shared/protocol.ts`
(`BaseBranchSchema`, `DispatchSchema`, `UpdateTaskSchema`, `McpCreateTicketSchema`,
`McpPushTaskSchema`), `src/server/tasks.ts` (create, `prepareUpdate`, `assignReserved`),
`src/server/routes.ts` (`POST /api/tasks`, `POST /api/tasks/:id/update`, `/mcp/v3/tasks`,
`/mcp/push-task`, session reset and its preview), `src/server/git/remote-default.ts`,
`src/server/dispatcher.ts` (`resolveTaskBases`), `src/server/actions.ts` (`resetToOrigin`,
`resetPreview`), `src/server/reset.ts`, `src/server/task-contract.ts`,
`src/server/workflows/{feedback,manager}.ts`, the MCP `create_task` and `push_task` tools in
`src/mcp/server.ts`, and the dashboard: `src/web/components/DispatchModal.tsx` (the field, the
details summary), `src/web/lib/task-draft.ts` (`DispatchDraft.baseBranch`, `taskUpdatePatch`),
`src/web/lib/api.ts` (`DispatchInput`), `src/web/components/layouts/BacklogColumn.tsx` (the
card label), `src/web/styles.css` (`.bl-base`) and `src/server/index.ts` (the startup pass). The followers add `src/server/diff.ts`
(`changedPathsSince`, `deletedPathsSince`, `computeSessionDiff`), `src/server/test-selection.ts`,
`src/server/workflows/{affected-tests,check-runtime,checks,context,engine,agent-contract}.ts`,
`src/server/registry.ts` (`reconcilePrs`, `reconcilePrMerges`) and `src/server/pr.ts`. The
mission template adds `src/shared/schedules.ts` (`ScheduleTemplate.baseBranch`,
`SCHEDULE_VALIDATION_FIELDS`), `ScheduleTemplateSchema`, `src/server/schedules/{manager,store}.ts`,
`src/web/components/schedules/{ScheduleEditor,ScheduleDetail}.tsx` and
`scheduleDefinitionFingerprint` in `src/web/lib/schedules.ts`.

**Fork-only files.** `test/task-base-branch.test.ts`, `test/task-base-branch-migration.test.ts`,
`test/task-base-branch-followers.test.ts`, `test/schedule-base-branch.test.ts`,
`test/backlog-base-branch-render.test.ts`, `test/base-branch-backfill.test.ts`,
`src/server/base-branch-backfill.ts`, `e2e/specs/mission-base-branch.spec.ts`,
`e2e/specs/task-base-branch.spec.ts`.

### Docs-only CI

| Field | Value |
| --- | --- |
| Status | **Active**. The `docs checks` job, `npm run docs:links`, the `docs-only-ci` skill, and in this repository's own `ci.yml` the `changes` detection job, the docs-only skip and the `CI result` summary job. |
| PRs | #164 (the `docs checks` job), #168 (the `docs-only-ci` skill), #171 (the gate in `ci.yml`) |
| Plan docs | [docs-only-ci/plan.md](../plans/docs-only-ci/plan.md), "Design" (all of it) and decisions 1 to 20 |
| Upstream candidate | Maybe. The `docs checks` job and the `docs:links` script are generic; the skip is shaped around the fork's Wait for CI and "Flaky tests" check. |

**Intent.** A pull request that only edits `docs/` should not pay for the whole of CI. Before
anything skips, CI needs a job that still runs what a docs change can break: the doc-link check
and the unit tests that read the repository's real docs. Other repositories get the same gate
through a bundled skill.

**Behavior contracts.**

- `changes` (job id `changes`, `ubuntu-latest`, no `if:`) runs on every event, checks out with
  `fetch-depth: 0`, and outputs `docs_only` from its `Detect docs-only change` step, whose
  `run:` body is `skills/docs-only-ci/assets/detect-docs-only.sh` verbatim with
  `DOCS_ONLY_PATHS` set to `docs/*`. Only a `pull_request` event can be docs-only; every doubt
  is `false`, which runs the full suite.
- `gates`, `unit-node-24`, `build-smoke-node-24` and `e2e` need `changes` and carry
  `if: needs.changes.outputs.docs_only != 'true'`. Nothing else is gated: `dependencies-node-24`,
  `docs checks` and `flake report` run on docs-only pull requests, the Node 26 jobs run on no
  pull request at all (see CI time-to-green), and `package` is unchanged (tags and manual runs
  only).
- `flake report` keeps `if: ${{ !cancelled() }}`, so on a docs-only run it reads zero reports
  and publishes "Flaky tests: No flaky tests", which Wait for CI requires (decision 20).
- `CI result` (job id `ci-result`, `ubuntu-latest`, `if: always()`) needs every job except
  `package` and the Node 26 jobs, the jobs that never run on a pull request. Its step body is
  `skills/docs-only-ci/assets/ci-result.sh` verbatim, with `SKIPPABLE` listing exactly the four
  gated job ids. It is the one check branch protection
  should require; nothing is required on `main` today.
- `test/docs-only-ci-template.test.ts` fails `npm test` when either `ci.yml` step body differs
  from its asset by one byte, and holds the `changes` and `ci-result` jobs, the gated jobs'
  condition, `CI result`'s `needs` and `SKIPPABLE`.
- `docs checks` (job id `docs-checks`) runs on every CI run, pull request or push, docs-only
  or not. It needs `dependencies-node-24` and restores `node_modules` exactly as `gates` does.
- It runs `npm run docs:links` (`scripts/check-doc-links.mjs`), then discovers test files with
  `grep -l '\.\./docs/' test/*.test.ts` and runs them with the suite loader
  (`node --test --import ./test/setup-state.mjs --import tsx <files>`).
- Discovery that finds no files fails the step instead of passing. The pattern is named in a
  comment above the step, so a new doc-drift test can be checked against it.
- On full runs the discovered tests also run inside the unit shards; that duplication is
  deliberate.
- The `docs-only-ci` skill (id `docs-only-ci`, installed as `mission-docs-only-ci`,
  `category: testing`, `enforcement: triggered`) is reached only from the Skills catalog and
  `/docs-only-ci`: no route, task type or button. It follows the testing-setup shape: read-only
  audit, one `request_plan_decisions` form, only the approved edits in one commit, a report of
  the required checks to swap for `CI result` (never an edit to branch protection), and
  verification on the setup pull request's own CI. Non-GitHub-Actions CI stops with "not
  supported"; an installed gate matching the assets stops with no form.
- `CI result`'s `needs` holds only jobs that run on every pull request unless the gate skips
  them. A job whose own `if:` (draft, label, fork, event conditions) can skip it on an ordinary
  pull request, or that needs such a job, stays out of `needs` and `SKIPPABLE` and is reported
  as not covered by `CI result`.
- The skill never gates a testing-setup `flake-report` job, and proposes `!cancelled()` on it when
  its `if:` would not run after skipped test jobs (decision 20).
- `assets/detect-docs-only.sh` prints `docs_only=true|false` (and appends it to
  `$GITHUB_OUTPUT`), exits 0 on every detection problem, resolves every doubt to `false`, diffs
  with `--no-renames` and prints the first non-matching path.
- `assets/ci-result.sh` passes only when every need succeeded, allowing `skipped` for a job in
  `SKIPPABLE` only when `DOCS_ONLY` is `true`, and otherwise names each offending job and result.
- Both scripts take every input through `env` and run under bash 3.2 and `bash -eo pipefail`.
  `test/docs-only-ci-scripts.test.ts` holds those lines, and feeds `decideWaitForCi` a
  docs-only run's checks to hold that it passes.

**Upstream behavior it assumes.**

- The `.github/workflows/ci.yml` layout: a `dependencies-node-24` job producing a
  lockfile-keyed `node_modules` cache that `gates` restores with `fail-on-cache-miss`.
- `scripts/check-doc-links.mjs` exists and walks the Markdown under `docs/`.
- Doc-drift tests reach the real docs through a `../docs/` path relative to `test/`.
- The bundled-skill catalog: every `skills/<id>/SKILL.md` with `metadata.mission` frontmatter is
  a catalog row and links as `mission-<id>`.
- `decideWaitForCi` passes a settled run with a "Flaky tests" check and counts `SKIPPED` as
  passing, which is what lets a docs-only run through Wait for CI.
- Nothing outside `test/` reads `docs/`: typecheck, lint, build, smoke, E2E and packaging do
  not. An upstream change that makes one of them read `docs/` breaks the gate's premise.
- `ci.yml`'s job ids `gates`, `unit-node-24`, `build-smoke-node-24`, `e2e` and `flake-report`. An
  upstream job added to `ci.yml` must also be added to `CI result`'s `needs` (the template test
  fails until it is), and to `SKIPPABLE` only if it is gated.

**Upstream surfaces touched.** `.github/workflows/ci.yml` (the `changes`, `docs-checks` and
`ci-result` jobs, the header comment, and `needs` and `if:` on `gates`, `unit-node-24`,
`build-smoke-node-24` and `e2e`),
`package.json` (`docs:links`), `AGENTS.md` (the CI paragraph's job count and the docs-only skip),
`docs/flaky-tests.md` (`flake report` on a docs-only run), `test/init-script.test.ts` (the
consumer jobs' `needs`),
`docs/skills-and-settings.md` (the skill's row), `test/skills-catalog.test.ts` (the skill's
cases), `test/fixtures/route-surface.json` (the skill's row in `GET /api/skills`).

**Fork-only files.** `skills/docs-only-ci/SKILL.md`,
`skills/docs-only-ci/assets/detect-docs-only.sh`, `skills/docs-only-ci/assets/ci-result.sh`,
`test/docs-only-ci-scripts.test.ts`, `test/docs-only-ci-template.test.ts`.

### CI time-to-green

| Field | Value |
| --- | --- |
| Status | **In progress**. Node 26 runs off pull requests only, build and smoke run once per Node release in their own jobs, a unit shard provisions once through `pretest`, unit shards are balanced by recorded file duration, and a push to `main` skips the Node 24 suite, `gates` and E2E when its pull request's green run already tested the same tree. A pull request's run peaks at 19 concurrent jobs, with three Node 24 unit shards and fourteen E2E shards, and every E2E shard tests the one `dist/` that `build-smoke-node-24` built and smoked instead of building its own. The median wall clock against the 8-minute target is measured on #221; the shared `dist/` stays only if its pull request median does not regress #221's (plan section 8). |
| PRs | #200 (the plan), #215 (plan sections 1, 2 and 7), #214 (plan section 3), #218 (plan sections 6 and 7), #219 (plan section 4), #221 (plan section 5), #222 (plan section 8) |
| Plan docs | [ci-time-to-green/plan.md](../plans/ci-time-to-green/plan.md), sections 1 to 8 and decisions 1 to 15 |
| Upstream candidate | Maybe. Running build and smoke once per release instead of in every shard is generic; keeping Node 26 off pull requests answers this fork's 20-job concurrency cap on GitHub Free. The Electron download retry and the single provisioning path are generic. |

**Intent.** A pull request waited about 12 minutes for `CI result`, though its longest job took
about 6. Most of the rest was queueing: one run fanned out to 33 Linux jobs against GitHub
Free's 20 concurrent jobs per account, and every unit shard built and smoked the same `dist/`.
Each shard also provisioned its environment twice, in the action and again through `pretest`,
and its `posttest` reran two test files its own glob already held. Unit shards split by file
index, so the slowest took up to about twice as long as the fastest. Every merge then reran the
whole suite on `main` against the tree its pull request had just tested. The fork cuts the
redundant runs so a pull request is green sooner, and keeps every check that could answer
differently on `main`.

**Behavior contracts.**

- `dependencies-node-26`, `unit-node-26` and `build-smoke-node-26` carry
  `if: github.event_name != 'pull_request'` and no other condition, and need only Node 26 jobs.
  They run on every push to `main`, tag and manual run, and never on a pull request.
- `build-smoke-node-24` (`needs: [changes, dependencies-node-24]`, the docs-only condition) and
  `build-smoke-node-26` (`needs: dependencies-node-26`) run on `ubuntu-latest`, restore
  `node_modules` with `fail-on-cache-miss`, then run `npm run build` and `npm run smoke`.
- After smoke, `build-smoke-node-24` packs `dist/` into `dist.tar` (a tarball, because an artifact
  drops file modes) and uploads it as the `dist-node-24` artifact, retained 7 days so a later rerun
  of a failed E2E shard, which reuses the original attempt's artifact, still finds it. `e2e` needs
  `build-smoke-node-24`, has no `Build` step, and downloads and unpacks that artifact instead, so
  every shard tests the bundle that smoked, and a build or smoke failure skips E2E. Plan section 8
  keeps this only if the pull request median does not regress #221's; both medians and the query are
  in its pull request description.
- `.github/actions/run-unit-shard/action.yml` has no `Build` or `Smoke the built bundles` step,
  and its description says build and smoke run in the build-smoke jobs.
- `CI result` needs `build-smoke-node-24` and none of the Node 26 jobs, matching `package`, and
  `SKIPPABLE` lists `build-smoke-node-24`. Its step body and the `Detect docs-only change` body
  stay byte-identical to `skills/docs-only-ci/assets/`.
- `flake report` still needs `unit-node-26`, and its `!cancelled()` runs it after the skip.
- A Node 26 failure on `main` turns that workflow run red; `CI result` there does not cover
  Node 26.
- Every pull request run's `changes` job writes `{tree, docs_only}` (the merge ref's
  `HEAD^{tree}` and the docs-only answer) and uploads it as the `tested-tree` artifact, retention
  7 days. A recording problem warns and uploads nothing, and the upload step carries
  `continue-on-error`, so neither ever fails the run; the `main` push then finds no artifact and
  runs everything.
- `changes` alone holds `actions: read` and `pull-requests: read`. Its `Detect reused tree` step
  outputs `tree_reused=true` only on a push to `refs/heads/main` whose commit maps to exactly one
  merged pull request, whose newest `pull_request` run of `ci.yml` for that pull request's head
  is a completed success, whose `tested-tree` artifact says `docs_only` is `false`, and whose
  recorded tree equals the pushed commit's tree. Every other event, API error, missing or
  unreadable artifact and mismatch outputs `false`, logs why, and exits 0.
- `gates`, `unit-node-24`, `build-smoke-node-24` and `e2e` carry
  `needs.changes.outputs.tree_reused != 'true'` beside the docs-only condition, and no other job
  reads `tree_reused` except `CI result`, whose `DOCS_ONLY` env is "docs-only OR tree reused"
  (it now means "the skippable jobs may skip"). Its step body stays the skill asset, so its log
  says "docs-only change" for a reused tree too.
- `test/init-script.test.ts`, `test/oss-readiness.test.ts` and
  `test/docs-only-ci-template.test.ts` hold the job graph above, and
  `test/ci-tree-reuse.test.ts` holds each reuse condition and failure path.
- `pretest` is the one definition of test provisioning, locally and in CI. The unit shard
  action runs `npm run pretest` once and has no step of its own that installs Electron or
  builds the native state lock. `Resolve Electron version` and `Cache the Electron runtime`
  stay, so the runtime `pretest` probes is normally restored rather than downloaded.
- `scripts/ensure-electron-runtime.mjs` retries a failed runtime install three times, waiting
  10 s and then 20 s between attempts, and fails with the last attempt's detail. This protects
  a cold cache locally as well as in CI.
- The shard's Test step runs `npm run --silent test:run` with `--test-concurrency` and the
  shard's files, not `npm test`, so `posttest` (`test:workflow-evidence`) does not run in CI.
  JUnit output and the flake rerun both go through `test:run`. Local `npm test`, with its
  `pretest` and `posttest` and its index-based `MISSION_TEST_SHARD`, is unchanged.
- A unit shard's files come from `node scripts/unit-shard.mjs <index>/<total>` (its "Select shard
  files" step, which prints the file count), not `--test-shard`. The partitioner expands
  `test/**/*.test.ts`, the glob `npm test` names, weights each file by its milliseconds in
  `test/shard-timings.json` (a missing file weighs the median of the recorded ones, every file
  the same when none are recorded), and deals longest first to the lightest shard, ties broken
  by path and then by shard index. The result is deterministic for a file set and timings file,
  and every file lands in exactly one shard whatever the timings say; it refuses to print an
  empty shard, which `node --test` would read as "discover your own files".
- Each unit shard uploads its first run's `junit.xml` as `unit-junit-node-<v>-shard-<n>`,
  retained 7 days, whatever the test outcome (`!cancelled()`).
- `test/shard-timings.json` is generated and never hand-edited. `npm run test:timings --
  <run-id>` (`scripts/unit-shard-timings.ts`) downloads that run's `unit-junit-*` artifacts
  with `gh run download`, sums each file's top-level `testsuite` and `testcase` times per Node
  release (through `junitFileTimes` in `src/shared/junit.ts`), averages the releases, keeps only files that
  exist in the checkout and rewrites the file. Regeneration is manual, when shard spread drifts.
- E2E keeps Playwright's `--shard`.
- A pull request's run peaks at no more than 20 concurrent jobs, GitHub Free's per-account cap:
  `gates`, `docs checks`, N Node 24 unit shards and M E2E shards, with 2 + N + M <= 20, since
  `build-smoke-node-24` finishes before E2E starts. N = 3 and M = 14, from the step times of pull
  request run 37415279889: the shard holding `test/session-contracts.test.ts` (224 s alone) stays
  near 300 s at any N of three or more, so the remaining slots go to E2E, the critical path. M was
  set while `build-smoke-node-24` still ran beside the shards and is held at 14, leaving one slot
  spare, so the shared `dist/` was measured as one change. Node 26 keeps six unit shards, outside
  the budget. The arithmetic is the "Shard budget" comment in `ci.yml`; `MISSION_TEST_SHARDS`, the
  matrix lists and `test/init-script.test.ts` change together. That test pins the shard lists, the
  shared `dist/` steps and artifact name, and derives the peak from the job graph (every job a
  full pull request runs at once with the shards, matrix legs counted) and pins it at 19, so a new
  job beside the shards fails it.
- `test/shard-timings.json` holds real timings, generated by `npm run test:timings` from run
  37415279889 (1,039 files, the whole unit glob). The timings are per file, so a shard count
  change needs no regeneration.
- `test/flake-report-action.test.ts` holds the shard's single `npm run pretest`, the absence of
  `npm test` and `--test-shard`, and a Test command equal to `package.json`'s `test` script with
  CI's concurrency and the partitioner's files in place of the shard option and glob;
  `test/unit-shard.test.ts` holds the partition invariant, determinism, median weighting, the
  JUnit upload and the generator's arithmetic; `test/electron-runtime-preflight.test.ts` holds
  the retry.

**Upstream behavior it assumes.**

- The `.github/workflows/ci.yml` layout: per-release `dependencies-node-<v>` jobs producing
  lockfile-keyed `node_modules` caches, unit shards through
  `.github/actions/run-unit-shard/action.yml`, and `npm run build` starting with `build:native`,
  which builds the native state lock the daemon bundle needs before smoke runs it.
- `scripts/smoke-bundles.mjs` runs the bundles directly, with neither the Electron runtime nor a
  display.
- Node 24 and Node 26 are the supported releases. An upstream Node 26-only job must take the
  same `if:` and stay out of `CI result`'s `needs`.
- `package.json`'s `pretest` provisions everything the unit suite needs (Electron runtime,
  native state lock), and `posttest` adds only tests already inside `test/**/*.test.ts`.
- `node --test`'s JUnit reporter writes a `time` in seconds and an absolute `file` on every
  `testcase`, and a `describe` block becomes a `testsuite` with no `file` whose time is its wall
  time, hooks included. Summing a suite's cases instead would miss hook time and over-count a
  suite that runs its cases concurrently.
- Unit test files do not depend on which other files share their shard (the native state lock
  paragraph in `AGENTS.md`), so moving a file between shards is safe.
- Electron's `install.js` downloads the runtime on first use (Electron 42+) and exits non-zero
  when the download fails.
- The workflow file is `.github/workflows/ci.yml` (tree reuse looks its runs up by that name),
  `actions/checkout` checks out the pull request's merge ref on `pull_request`, and a squash or
  merge commit made while `main` has not moved has that merge ref's tree.

**Upstream surfaces touched.** `.github/workflows/ci.yml` (the header comment, the Node 26 jobs'
`if:` and `needs`, the two build-smoke jobs, `flake-report`'s and `ci-result`'s comments,
`ci-result`'s `needs`, `SKIPPABLE` and `DOCS_ONLY` env, the `changes` job's permissions,
outputs and three tree-reuse steps, the gated jobs' `if:`, the "Shard budget" header section,
the `unit-node-24` and `e2e` shard counts, `build-smoke-node-24`'s `dist/` upload steps, and the
`e2e` job's `needs`, its comment and its download steps in place of `Build`), `.github/actions/run-unit-shard/action.yml` (the
description, the removed build and smoke steps, the single `pretest` step and the direct
`test:run` Test step over the partitioner's files, the "Select shard files" and
"Upload JUnit results" steps), `scripts/ensure-electron-runtime.mjs` and its `.d.mts`,
`src/shared/junit.ts` (the added `junitFileTimes`, which the bundled flake report action does not
import), `package.json` (`test:timings`), `AGENTS.md` (the CI paragraph and the native state lock
paragraph), `docs/flaky-tests.md` (Node 26 on pull requests, the unit shard bullet, "How unit
shards pick their files", and a reused `main` push), `test/init-script.test.ts`,
`test/oss-readiness.test.ts`, `test/flake-report-action.test.ts`, `e2e/README.md` (the CI shard
count and the shared `dist/`).

**Fork-only files.** `docs/plans/ci-time-to-green/plan.md`, `scripts/ci-tree-reuse.sh`,
`test/ci-tree-reuse.test.ts`, `scripts/unit-shard.mjs` and its `.d.mts`,
`scripts/unit-shard-timings.ts`, `test/shard-timings.json`, `test/unit-shard.test.ts`.
`test/docs-only-ci-template.test.ts` (fork-only through Docs-only CI) now also holds the Node 26
jobs' condition and the tree-reuse wiring.

### Windows support

| Field | Value |
| --- | --- |
| Status | **In progress on `release/windows`**. On `main`: the plan, `.gitattributes`, and the four platform seams (plan M1), each with only its POSIX implementation registered. On `release/windows`: Windows CI and the win32 skip guard, the win32 state lock, the win32 seam implementations, the Windows state home and path fixes, harness and runtime availability, Keep Awake, the Windows Setup checks, the Electron dev shell, the Makefile under Git Bash, and the Windows docs (plan M2.1 to M2.11). Gate readiness (M2.12) runs the Windows jobs on pull requests into the branch, fixes the win32 smoke and backup flushes, lists the skips and D38 seams, and files M3.1 and M3.2 on `main`. Every unit test, e2e spec and smoke check that exercises a surface win32 does not support now skips there through the D37 guard; the failures left are supported surfaces, which other tickets own. The Windows jobs are still allowed to fail, because they are not green yet. The branch reaches `main` in one merge. |
| PRs | On `main`: #128 (plan), #147 (`.gitattributes`, M0.2), #152 (process inspection, M1.1), #158 (process lifetime, M1.2), #176 (executable environment, M1.3), #154 (native addon sources, M1.4), #184 (this entry and the branch, M0.3), #185 (the weekly sync runbook and mission, M0.4). On `release/windows`: #224 (the first weekly sync of `main`, 2026-10-05), #187 (Windows CI and the skip guard, M2.1), #201 (state lock, M2.2), #209 (Keep Awake, M2.3), #191 (win32 seam implementations, M2.4), #192 (state home and paths, M2.5), #196 (harness availability, M2.6), #197 (runtime availability, M2.7), #210 (Setup checks, M2.8), #220 (Electron dev shell, M2.9), #233 (Makefile under Git Bash, M2.10), #225 (the Windows docs and this entry's update, M2.11), #237 (gate readiness, M2.12), pending (the D37 skips for unsupported surfaces), pending (Windows CI wall time: Defender off, shared e2e `dist/`), pending (fake CLIs that start on win32), pending (one physical spelling for 8.3 short paths), pending (the repository index splits `MISSION_WORKSPACE_DIRS` on the PATH delimiter), pending (tests run the repository's bash scripts under Git Bash on win32, not `/bin/bash`), pending (path separators and file URLs), pending (`USERPROFILE` beside `HOME` in test fixtures), pending (test home removal on win32), pending (POSIX mode bits on win32), pending (Claude project-directory encoding on win32), pending (workflow evidence containment from the opened handle on win32), #266 (`TEMP` and `TMP` beside `TMPDIR` in db-isolation), pending (D37 skips for POSIX-only mechanisms: signals, FIFOs, the terminal resume lease). The per-task base branch it depends on (M0.1) has its own entry. |
| Plan docs | [docs/plans/windows-support/plan.md](../plans/windows-support/plan.md), "Decisions", "Branch model" and "Milestones"; the sync runbook [docs/windows-branch-sync.md](../windows-branch-sync.md); the M2.0 SDK spike result on issue #186; the Windows section of [docs/setup.md](../setup.md#windows-11) and of [docs/harnesses-and-terminals.md](../harnesses-and-terminals.md#windows) |
| Upstream candidate | Not now (D18: fork-only). The four seams, and the neutral seams M2 built on the branch (D38), are platform-neutral and could be offered on their own. |

**Intent.** Mission Control runs natively on Windows 11 x64: the daemon, the Foreman worker,
the dashboard and the Electron shell in dev mode, with Claude Code SDK sessions dispatched,
shown on the board and completed. Until that is complete and validated, every Windows-specific
change lives on the long-lived `release/windows` branch, and `main` stays a macOS product that
behaves exactly as it did. When the plan's merge gate (D8) passes, `release/windows` merges into
`main` once; WezTerm terminal sessions and an NSIS installer follow on `main`.

**Behavior contracts.**

- `main` carries no Windows-specific behavior until the final merge. Only platform-neutral
  changes that leave macOS byte-for-byte unchanged land on `main` directly (D6). A seam an M2
  ticket discovers is built on `release/windows` instead, kept platform-neutral, and listed in
  the merge PR (D38).
- `release/windows` was cut from `origin/main` only after the per-task base branch,
  `.gitattributes` and all four seams had merged (D36), so it starts with every one of them.
  `main` reaches it only through merges (the weekly "Sync main into release/windows" mission,
  D5 and D26, following [docs/windows-branch-sync.md](../windows-branch-sync.md)): never a rebase,
  never a force-push. On a sync conflict `main` wins on shared code
  and the Windows change is re-applied on top; dropping a Windows change needs the human (D27).
- Windows tickets are tasks with `base_branch = release/windows`, so their worktrees, PRs,
  checks and merge watcher follow the branch (see "Per-task base branch"). They carry the
  `windows-support` label.
- The branch merges into `main` once, as one merge commit titled `feat: Windows support`
  (D16), after the unit suite and Playwright e2e are green on `windows-latest` under the single
  win32 skip guard (D37), the human's manual smoke passes, and Linux CI and the macOS `package`
  run are green. Nothing on either branch cuts a release.
- `.gitattributes` stores and checks out every text file as LF (`* text=auto eol=lf`, D25).
- **Process inspection** (`src/server/process-inspection/`): every `ps` and `lsof` read the
  daemon makes goes through `processInspector()`. Its POSIX implementation issues the same
  commands the call sites did, and each read returns its `RunResult` so the caller, not the
  seam, decides whether a partial answer is usable.
- **Process lifetime** (`src/server/platform/process-lifetime.ts`): starting a child as a tree
  root (`treeRootOptions`) and signalling or killing that tree (`signalTree`, `killTree`) go
  through `processLifetime`. Callers keep their own `spawn` call, so the executable contract
  tests still see each executable. The module is a leaf (Node builtins only), because the
  Electron main process imports it too.
- **Executable environment** (`src/server/platform/executable-environment.ts`): the
  resolver's application, per-user tool and OS default directories, and the login-shell PATH
  read, come from one per-platform row. The locator keeps the ladder's order and provenance.
- **Native addon sources** (`scripts/native-addon-sources.mjs`): the one table of each addon's
  sources per platform. Each `binding.gyp` reads `<@(addon_sources)`. A platform without sources
  gets none, never another platform's: the required state lock refuses it and the optional Keep
  Awake skips it. Both builders still publish through `publishNativeAddon`.
- On `main`, each seam's platform-selection map is empty, so every platform, win32 included,
  resolves to the POSIX implementation. `release/windows` registers `win32` in those maps:
  process inspection through Windows PowerShell over CIM, tree kill through `taskkill /T /F`,
  and the executable ladder's `win32` row (`%ProgramFiles%`, `%LOCALAPPDATA%\Programs`,
  `%USERPROFILE%\.local\bin`, the npm, mise and Volta locations, PATH from the registry, and
  PATHEXT names, so `claude` resolves to the real `claude.exe`). A win32 working-directory or
  open-files read reports failure rather than an empty answer, and worktree occupancy refuses
  on it.
- On `release/windows`, the state home resolves through `os.homedir()` to
  `%USERPROFILE%\.mission-control` with the macOS layout (D22), and paths spelled the win32 way
  are compared case-insensitively (`src/shared/native-path.ts`). POSIX answers stay
  byte-identical.
- **Harness availability** (D20): a harness's `unsupportedHosts` capability lists the platforms
  it cannot run on; Codex and Pi list `win32`. `harnessUnsupportedWhy` is the one sentence
  Settings > Setup, task creation and the dispatcher give, and dispatch refuses before any
  worktree is acquired.
- **Runtime availability** (D9): `runtimeUnavailableWhy` in
  `src/server/platform/session-runtimes.ts` marks the terminal runtime unavailable on win32. A
  dispatch, a Pipeline launch and Continue in terminal are refused with it, and the discovery
  poller runs an empty sweep there, keeping the Git refresh SDK sessions need.
- **State lock**: win32 builds `native/state-lock/state_lock_win.cc`, which takes state
  ownership with `LockFileEx` under the same handle contract and error codes as the POSIX
  `flock`. The lock covers one byte at 1 GiB rather than the owner metadata, because a
  `LockFileEx` region is mandatory and a contender must still read who owns the state home. The
  three symlink-publication exports serve only Pi and refuse with `ENOTSUP` there. On win32,
  `publishNativeAddon` moves an addon a live process has loaded aside to a `.retired-` name
  before renaming the new one in, puts it back if the publish still fails, and sweeps retired
  files once nothing has them loaded; every other platform keeps the plain rename (D38).
- **Keep Awake** (D13): win32 holds one power request set to `PowerRequestSystemRequired`
  (`native/keep-awake/keep_awake_win.cc`), the same idle-system-sleep guarantee as the macOS
  IOKit assertion, released by the kernel with the process. This deviates from D13's
  `SetThreadExecutionState`, which is one flag per thread and carries no reason string.
- **Setup** (D11, D23, D24, D30, D33): a **Windows** family scoped to `win32` (`hosts` on the
  family) checks Git for Windows, Developer Mode, `LongPathsEnabled`, npm's `script-shell`,
  Visual Studio Build Tools (C++) and Python 3. Its fixes are `manual-command` remedies shown to
  copy, never run by Mission Control. On win32, `core.longpaths=true` is set in a repository's
  git config before a managed worktree is added. No Windows row is probed on another host.
- **Electron dev shell**: `src/main/platform-shell.ts` gives win32 the colored `build/tray.ico`
  and the native window frame with an auto-hidden menu bar, and `menu-template.ts` drops the
  macOS app menu there. Every other platform keeps the macOS answers.
- **Windows CI** (D15, D30, D32): `windows-latest` jobs on Node 24 run on pushes to
  `release/windows` and pull requests into it that change more than `docs/` (no other pull
  request), with npm's `script-shell` set to Git Bash. Their product
  steps are allowed to fail until M2.12, and stay out of `CI result`. Each job turns off
  Defender real-time scanning first, and the e2e shards test the `dist-windows` artifact that
  `build and smoke (windows)` built rather than building their own. Every test or spec that
  skips on win32 goes through `skipOnWin32` or `skipSpecOnWin32` in `test/helpers/win32-skip.ts`,
  with a stated reason (D37), and only where it exercises a surface win32 does not support (Codex,
  Pi, the terminal runtime and its backends, terminal discovery, the macOS updater, and the macOS
  app installer and install migration) or pins a POSIX-only implementation. A test of a supported
  surface stays failing until it is fixed. Each Windows unit shard runs under a two-minute
  per-test timeout, `--test-force-exit`, and the per-file budget in `test/file-watchdog.mjs`, so
  a hang fails by name and the shard still prints its summary. The unit and e2e shards upload JUnit as
  `windows-unit-junit-shard-<n>` and `windows-e2e-junit-shard-<n>`, which Linux shard timings
  never read.
- **Fake CLIs in tests** (D8, D37): every fake `gh`, `claude`, `jira`, `git`, `node`,
  `conduct-ts`, `treehouse` or Electron a unit test or e2e fixture hands the product is a Node.js
  script written through `writeFakeExecutable` in `test/helpers/fake-executable.ts`, and its
  `*_BIN` override names the path that function returns. On macOS and Linux that is the
  `#!/usr/bin/env node` script, as before. On win32 it is `<script>.exe`, a launcher compiled
  once per machine with the .NET Framework's `csc.exe` from
  `test/helpers/fake-executable-launcher.cs`, which runs the script under the test's Node with
  the caller's argv, stdio and exit code, and takes the script down when it is killed. The
  product resolves and spawns that `.exe` like a Windows user's own tool, with no test-only
  path. Codex, Pi and terminal-backend fakes stay as they were, because those surfaces skip on
  win32. A test that fakes the login-environment PATH read writes it through
  `writeFakeLoginShell` in `test/helpers/login-shell.ts`: `$SHELL` on macOS and Linux, and on
  win32 the Windows PowerShell under a fixture `%SystemRoot%`, which the win32 row starts by
  its fixed path.
- **Physical paths** (`src/server/util/physical-path.ts`, D38): every synchronous realpath in
  `src/server` goes through `physicalPathSync`, so it spells a path the way
  `fs.promises.realpath` does. On win32 that is the native call, which expands
  8.3 short names (`C:\Users\RUNNER~1`) and restores on-disk case. That long spelling is what
  an exact physical path means on win32, and the `realpath(p) === resolve(p)` guards stay byte
  for byte. Junctions and symlinks are still resolved, so a linked path is still refused. Node's
  JS `realpathSync` keeps the short spelling, so it had named one directory two ways, and every
  worktree pool under it was refused as "not an exact physical directory". POSIX keeps the JS
  call. `state/isolation.ts` keeps it too, because it judges a test home against roots
  `test/setup-state.mjs` captured the same way. On win32 the test preload and
  `e2e/playwright.config.ts` point `%TEMP%` at its long spelling, so fixtures and the daemon
  agree on every path derived from it. `test/physical-path.test.ts` refuses any new use of the
  JS realpath in `src/server`, whether named, namespace or default imported.
- **Path separators** (D8, D22): a path the product reports beside git's, a repository-relative
  doc cited in a prompt (`readRepoDoc`) or a selected test file in the affected-tests argv, is
  spelled with `/` on every platform. A containment check compares `relative()` output, never a
  `${root}/` prefix (`scripts/check-doc-links.mjs`). A path that is only ever macOS's, such as the
  LaunchServices plist, is joined with `path.posix`. The dashboard cannot ask which platform the
  daemon runs on, so `repoLeaf`, `promptPath` and the repository pickers split a host path on
  either separator, and `formatAttachmentPath` writes a drive path bare, or quoted with its
  backslashes intact. Repository discovery reads a config value carrying Git's own escapes, such as
  the `\\` of a remote at a drive path, without starting `git config`. Tests build expected paths
  with `node:path`, turn a module URL into a path with `fileURLToPath`, never `URL.pathname`, and
  reach Vite's `/@fs/` route through a file URL's path.
- **Test home isolation** (D8, D22): `os.homedir()` reads `USERPROFILE` on win32, not `HOME`,
  so a fixture that sets `HOME` alone leaves the daemon and the code under test on the runner's
  real profile. Every unit test and e2e fixture that moves the OS home spreads
  `osHomeEnv(home)` from `test/helpers/os-home.ts`, which sets both names, including the e2e
  daemon in `e2e/fixtures/daemon.ts`. `test/os-home-isolation.test.ts` refuses a test or e2e
  file that sets `HOME` without `USERPROFILE`, except the few that hand `HOME` to code as plain
  data. Scripts outside `test/` and `e2e/` are not covered. The temp dir has the same split:
  `os.tmpdir()` reads `TEMP` then `TMP` on win32 and ignores `TMPDIR`, so the
  `test/db-isolation.test.ts` cases that move the allowlist's temp root set all three names.
- **Test home removal** (D8, D37): win32 refuses to delete a file that is still open. On win32
  `test/setup-state.mjs` wraps `rmSync` so it emits `mission-control:test-state-removal` with
  the absolute path first. `openDb` in `src/server/db.ts` closes its cached connection under the
  test runner when that path holds the database, so the `after(() => rmSync(home, ...))` in each
  test file needs no change. The preload's own exit cleanup reports a directory it cannot remove
  and does not throw. `e2e/fixtures/daemon.ts` ends the daemon's and the Foreman worker's whole
  process tree through `processLifetime.killTree` on win32, waits a bounded time for the root to
  exit, and then removes the home with retries. On win32 a home it still cannot remove is
  reported, not failed, because `taskkill` cannot reach a descendant whose root already exited.
  macOS and Linux keep the `SIGTERM` then `SIGKILL` stop, the unwrapped `rmSync`, and a failing
  test for a home that cannot be removed.
- **POSIX mode bits** (D8, D22, D37): win32 has no permission bits. Node reports every writable
  file and directory there as `0o666`, and `chmod` only toggles the read-only attribute. Product
  code reads a mode only where the platform has one: the ai-conductor installer check
  (`conductorInstallerModeIsExecutable`) requires an execute bit on POSIX and, on win32, only that
  `bin/install` is a regular file inside the checkout. Tests compare a created file's mode with
  `expectedMode` from `test/helpers/posix-mode.ts`, which answers `0o666` on win32. A test that
  makes a directory unreadable or unwritable uses something win32 also refuses: an ACL entry
  denying the listing (`icacls`), or a directory where a file belongs.
- **Claude project directories** (D8, D9): Claude Code keeps a cwd's transcripts in
  `~/.claude/projects/<name>`, where the name is the cwd with every character outside
  `[a-zA-Z0-9]` replaced by `-` on every platform, cut at 200 characters with a hash suffix
  past that. `C:\Users\me\app` is `C--Users-me-app`. `claudeProjectDir` in
  `src/server/harness/claude/project-dir.ts` is the one place the product derives it, for the
  headless transcript pruner, the SDK transcript path and the transcript fallback. The rule was
  read from the 0.3.283 `claude` binaries for darwin-arm64 and win32-x64, and
  `test/claude-project-dir.test.ts` pins Claude's own outputs. A macOS cwd of letters, digits,
  `-`, `.` and `/` encodes as before.
- **Workflow evidence containment** (`src/server/util/opened-path.ts`, D8, D38): registering
  and capturing checkout evidence proves the opened file is inside its checkout from the
  descriptor, not from a name. darwin resolves and opens in one step with `O_NOFOLLOW_ANY`, and
  linux reads `/proc/self/fd`. win32 asks the descriptor's own handle through `openedPath` in
  the state-lock addon (`GetFinalPathNameByHandleW`, reached with `uv_get_osfhandle`), in the
  spelling `physicalPathSync` gives, and refuses a path outside the issued root exactly as linux
  does. `openedPath` is win32-only, so the macOS addon is unchanged. Before it, win32 refused
  every evidence file with "cannot be opened safely on this platform".
- **Makefile** (D31): run from Git Bash with a separately installed GNU make. On Windows
  (`OS=Windows_NT`), `make app`, `make install` and `make install-app` say they are macOS only
  and exit, and so do `make claude`, `up`, `down`, `restart`, `stop-all` and `status`, which
  need `lsof`, `pgrep` and `pkill`. Elsewhere both guards expand to nothing. `build:pi-extension`
  skips where `harnessUnsupportedWhy("pi", ...)` answers, so `make build` passes on win32, and
  the `concurrently` lanes behind `make dev`, `make desktop` and `make start` run `tsx watch`
  with stdin from /dev/null (`dev:server:lane`, `dev:foreman:lane`), because on win32 a daemon
  that touched `process.stdin` blocked behind the watcher's read of the shared pipe (D38).
- **Durable flushes** (`src/server/platform/durable-sync.ts`, D38): the database and settings
  backups flush a file and its directory through `syncFile` and `syncDirectory`. POSIX keeps the
  read-only descriptor it always used. win32 opens the file for writing, because
  `FlushFileBuffers` refuses a read-only handle, and makes no directory flush. `npm run smoke`
  skips the Pi artifact and the Pi SDK bundle probe where `harnessUnsupportedWhy("pi",
  hostPlatform())` answers, the same question `build:pi-extension` asks.

**Upstream behavior it assumes.**

- Upstream reads processes, signals process groups and searches for executables only at the
  call sites the seams replaced. An upstream commit that adds a direct `ps`, `lsof`, `pgrep`,
  `process.kill(-pid)`, `detached: true` spawn, login-shell PATH read, or ladder location
  outside the seams is a conceptual conflict even when it merges cleanly: route it through the
  seam on `main`.
- Upstream physicalizes paths synchronously only where this branch now calls
  `physicalPathSync`. A new `realpathSync` in `src/server` is a conceptual conflict even when it
  merges cleanly. Route it through the seam, which `test/physical-path.test.ts` enforces.
- Upstream splits a host path on `/` only for labels and paths that come from git. A new
  `split("/")`, `${root}/` prefix test or `URL.pathname` read on a native path is a conceptual
  conflict even when it merges cleanly: use `node:path`, `fileURLToPath`, or the dashboard's
  `repoLeaf`.
- `process.platform` is how the daemon and the Electron main process tell platforms apart. The
  daemon reads it for harness and runtime availability through `hostPlatform()`, so the e2e
  suite can build a daemon that answers win32.
- Both native addons build with `node-gyp` from a `binding.gyp` in `native/<addon>`, and the
  daemon takes state ownership through `dist/native/state-lock.node` before it serves.
- The Claude Agent SDK spawns the executable it is given as `pathToClaudeCodeExecutable` on
  win32, and runs the CLI it bundles when it is given none (the M2.0 spike, SDK 0.3.283).
- Every harness reaches dispatch through the capability registry, so a new harness that does
  not run on Windows needs only an `unsupportedHosts` entry.
- `ci.yml` runs on pushes to `main` and on every `pull_request`, so PRs into `release/windows`
  get Linux CI without a workflow change (D15).
- Upstream stays macOS-only for packaging. Upstream Windows support of its own would need
  reconciling with this branch before either merge.

**Upstream surfaces touched.** `src/server/discovery/{processes,proc-cwd,codex-rollouts,poller}.ts`,
`src/server/workflows/{check-identity,check-group,check-spawn,check-lease}.ts`,
`src/pi/generation-lease.ts`, `src/server/claude-cli.ts`, `src/server/llm/codex.ts`,
`src/server/executables/{locator,catalog}.ts`, `src/main/{update-build,updater}.ts`,
`native/{state-lock,keep-awake}/binding.gyp`,
`scripts/build-{state-lock,keep-awake}-native.mjs`, `test/codex-rollout-identity.test.ts`,
`test/executable-contracts.test.ts`, `test/pi-generation-lease.test.ts`,
`docs/agent-guides/architecture.md` (the seam rows) and `docs/harnesses-and-terminals.md` (the
executable search ladder). On `release/windows` also: `src/server/dispatcher.ts`,
`src/server/task-repository-preparation.ts`, `src/server/session-transfers/coordinator.ts`,
`src/server/sdk/handoff.ts`, `src/server/setup/{index,install,types}.ts`,
`src/server/keep-awake.ts`, `src/server/worktrees/git.ts`, `src/server/repos.ts`,
`src/server/harness/claude/hooks.ts`, `src/server/agent-subprocess-env.ts`,
`src/server/testing-setup.ts`, `src/mcp/pipeline-credential.ts`,
`src/server/{database-backups/service,settings-backups/store}.ts`,
`src/shared/{harness-capabilities,setup-catalog,allowlist,llm,workflow,standing-instructions,protocol,types,executables}.ts`,
`src/shared/harness-runtime.mjs`, `src/server/db.ts` (closes its connection before a test home is removed),
`src/main/{index,menu,menu-template,tray,window}.ts`, `src/web/components/SetupPanel.tsx`,
`scripts/{gen-icons,probe-keep-awake-native,native-addon-publish}.mjs`, `scripts/build-pi-extension.ts`,
`scripts/smoke-bundles.mjs`, `test/pi-extension-build.test.ts`, every `src/server` module that
called `realpathSync` (now `physicalPathSync`), `test/setup-state.mjs`,
`e2e/playwright.config.ts`, `Makefile`, `package.json` (`dev:electron:app`, the `dev:*:lane` scripts), `docs/overview.md`,
`.github/workflows/ci.yml` (the Windows jobs), `test/init-script.test.ts` (the shard budget models a pull request into `main`), `e2e/fixtures/{daemon,fake-agents,conductor}.ts`, the unit tests and e2e specs that
skip on win32 or write a fake CLI, `AGENTS.md`, `e2e/README.md`, `docs/setup.md`, `docs/sessions.md` and
`docs/desktop-and-packaging.md`.

**Fork-only files.** `.gitattributes`, `src/server/process-inspection/`,
`src/server/platform/process-lifetime.ts`, `src/server/platform/executable-environment.ts`,
`scripts/native-addon-sources.mjs`, `scripts/native-addon-sources.d.mts`,
`test/process-inspection.test.ts`, `test/process-lifetime.test.ts`,
`test/executable-environment.test.ts`, `test/native-addon-sources.test.ts`,
`docs/plans/windows-support/`, `docs/windows-branch-sync.md`. On `release/windows` also:
`src/server/platform/{host,session-runtimes,durable-sync}.ts`, `src/server/setup/windows.ts`,
`src/server/git/long-paths.ts`, `src/server/util/physical-path.ts`, `src/shared/native-path.ts`, `src/main/platform-shell.ts`,
`native/state-lock/state_lock_win.cc`, `native/keep-awake/keep_awake_win.cc`, `build/tray.ico`, `scripts/ci-allowed-failures.mjs`,
`scripts/probe-keep-awake-native.d.mts`, `e2e/fixtures/win32-host-build.ts`,
`e2e/specs/win32-{harness-availability,setup-checks}.spec.ts`, `test/helpers/win32-skip.ts`,
`test/helpers/fake-executable.ts`, `test/helpers/fake-executable-launcher.cs`,
`test/helpers/login-shell.ts`, `test/helpers/ci-workflow.ts`, and the tests `test/{ci-allowed-failures,desktop-shell-platform,dev-lane-stdin,durable-sync,harness-host-availability,keep-awake-probe,fake-executable,makefile-windows,native-path,physical-path,setup-windows-probes,state-home-resolution,win32-path-audit,win32-session-runtimes,test-state-removal,win32-skip-guard,windows-ci,worktree-long-paths}.test.ts`.

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

### CodeQL advanced setup

| Field | Value |
| --- | --- |
| Status | **Removed** 2026-10-04, PR pending |
| PRs | #65 |
| Plan docs | None |
| Upstream candidate | No. |

**Intent (as built).** Code scanning through a committed workflow instead of GitHub's default
setup, so `e2e/` and `test/` could be excluded from alerts.

**Why it was removed.** The fork no longer runs CodeQL. The removal deleted
`.github/workflows/codeql.yml` and `.github/codeql/codeql-config.yml`. The repository's CodeQL
default setup stays disabled, so nothing scans the fork.

## Standalone fixes

Fixes that are not part of a fork feature. None had an upstream equivalent on `upstream/main`
at `2012e91b` (checked by each fix's key symbol), except the test-side half of #91 that
upstream #1154 now covers, as its row says.

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
| #77 | 2026-09-30 | A config refresh landing between a keystroke and its effect wiped a typed telemetry destination, the flake in `telemetry-settings.spec.ts`. The destination forms now derive each field at render (typed draft, else the daemon's copy) instead of adopting it from an effect. The sync of 2026-10-05 (#175) extended this to upstream #1162 and #1164's metric temporality and export shape fields. | `src/web/components/TelemetrySettingsPanel.tsx` | Yes: upstream still adopts through the effect. |
| #91 | 2026-10-01 | Three test files never exited: completed fixture tasks owed a worktree return that retried every 30 s forever, each try scanning every process with `ps` and `lsof`, at ~28 concurrent `ps` and near-zero idle CPU. Returns now back off to 15 min, the files use instant return seams, and `test:run` sets a 180 s per-test timeout. | `src/server/tasks.ts`, `package.json`, `test/helpers/task-manager.ts` | Yes for the backoff: upstream has the same flat 30 s retry. The `test:run` flags belong to the fork's flake-aware testing. Upstream #1154 (sync of 2026-10-05, #175) added `TaskManager.stop()` and `test/helpers/task-manager-fixture.ts`, which now cover the test-side half in `multi-pr-quorum` and `task-completion-reconciler`; `task-dependencies` builds the fixture class through this helper. |
| pending | pending | 12 of the first 13 `image_evidence_capture` blocks were a session re-registering a rerun log or screenshot under a new client id: the older row for the same path stayed reserved and could never match the rewritten file. Reservation now takes only the latest registration of each checkout path. | `src/server/workflows/store.ts` | Yes: generic workflow evidence reliability. |
| pending | pending | A subagent hand-back (Claude Code's `<agent-message>` turn) was captured as a human prompt: it bumped the prompt revision, often drew an `unclear` intent verdict, and so stamped the agent's workflow evidence with no intent episode. Foreman's verifier then saw no registered evidence and held the completion. Hand-backs are now scaffolding to the goal path. | `src/server/harness/claude/scaffolding.ts` | Yes: upstream captures the same turns. |
| pending | pending | A held `plan` or `shape` completion was consumed in silence, so the agent never heard its gaps and the bound workflow never started. Pre-PR recovery now relays held gaps to planning kinds, and only held gaps, with a planning-turn packet. Related to Shape tasks, grill and tickets. | `src/server/foreman/ship-shepherd.ts`, `src/server/foreman/worker.ts`, `src/server/routes.ts`, `src/web/components/ForemanBar.tsx` | Maybe: the `plan` half applies upstream; `shape` does not exist there. |

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
