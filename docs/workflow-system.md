# Workflows, personas, actions, and ensembles

The workflow system turns a repeatable review or delivery process into durable runs. A
workflow has versioned definitions and nodes. Nodes can invoke a persona, run a check, or
perform a session action. The [workflow manager](../src/server/workflows/manager.ts) owns
run orchestration and recovery; its [store](../src/server/workflows/store.ts) owns the
durable workflow records.

The machine policy `skipPassedJudges` defaults to true. At claim time the engine looks up the
latest executed, completed verdict for the same Persona node in an earlier round of the same
run. Only a pass is reusable: an explicit recheck that fails supersedes an older pass even if
reuse is enabled again. The engine records a completed attempt with `reusedPassAttemptId` and
atomically emits the usual pass receipts without a model call. The original attempt remains
the authority, including after daemon recovery; no second pass ledger is stored. Runs resolves
that reference to display the original round. Checks and Session actions continue through
their existing execution paths.
Reuse also requires the current directive to match the earned attempt's snapshot, including
revision, timestamps, and text. This applies changed feedback once without making an unchanged
directive force perpetual rechecks; removing and recreating a directive cannot revive a pass
from its earlier revision sequence.
A Persona node also carries an optional `executionOverride` - one explicit
`{ runner, model, effort? }` choice made by the workflow rather than by the reviewer. The
override lives on the node in both the draft and published graph JSON, is frozen beside the
Persona snapshot at publish rather than folded into it, and is absent when the node inherits,
so no migration touches an existing graph.
[`resolveWorkflowNodeExecution`](../src/server/workflows/personas.ts) composes it over
`resolvePersonaExecution`, which keeps the app and environment fallback ladder in its
existing single owner and leaves every non-workflow Persona caller unchanged.
Effort, on the override and on the Persona, uses the shared `THINKING_LEVELS` vocabulary and
is checked with `personaEffortLevels`, which reads the same `launchEffortLevels` capability
table sessions and tasks use. An unsupported override level is an `unsupported_effort` graph
diagnostic rather than a parse failure, so stored graphs stay readable. The Persona's own
`effort` is frozen into its snapshot only when set, so a Persona with none publishes
byte-identically to a pre-effort version.

Personas and session actions are editable catalogs managed by
[`personas.ts`](../src/server/workflows/personas.ts) and
[`session-actions.ts`](../src/server/workflows/session-actions.ts). The repository's builtin
Markdown sources are compiled into generated modules by
[`scripts/builtin-personas.ts`](../scripts/builtin-personas.ts) and
[`scripts/builtin-session-actions.ts`](../scripts/builtin-session-actions.ts), so installed
defaults and operator-managed copies remain distinct.

The built-in catalog contains General Review, Bug Fix Review, Plan Validation, and No-Mistakes
Review (High Rigor). The latter's current version is 19. General Review and Bug Fix Review version 2
and No-Mistakes version 19 run typecheck, test, and lint together in their first All-pass gate.
No-Mistakes retains its verified Pull Request action and uses the existing `inspector` completion policy
with `inspector_only` repairs and `wait` for a missing PR. Earlier versions remain immutable.
General and Bug Fix use the same check, Persona, and Session action primitives with fewer roles.
Plan Validation uses only Personas and completes locally. Its task contract requests complete
registered plan text because Persona calls cannot read checkout files. No new engine node,
submission format, or database table is introduced.

Task workflow defaults resolve through `taskDefaultWorkflowId` in `src/shared/task.ts`, used by
the dispatch form, the Recurring Mission editor, **Shape this**, and server task creation. It
reads the operator's per-kind rows (`WorkflowPolicy.kindWorkflowDefaults`, edited under Settings
→ Workflows → Dispatch defaults) and falls back to `BUILTIN_KIND_WORKFLOW_DEFAULTS`: Ship
defaults to No-Mistakes Review, Bugfix to Bug Fix Review, Plan and Shape to Plan Validation,
and Scout and Chat to None. Pipeline always resolves to None. Explicit IDs and null opt-outs
win. The map replaced the single `defaultWorkflowId`, which `StoredWorkflowPolicySchema`
migrates into the Ship row on read (a stored No-Mistakes reads as the built-in), including for
settings backups written before it; `PUT /api/workflows/config` refuses the old field.
Bugfix shares Ship's completion contract, automatic wrap-up, backlog eligibility, and recovery
through the existing registries and `isShippingTaskKind` predicate.

Ensembles coordinate multiple agent attempts and hand a selected result back through
workflow and task seams. The [ensemble manager](../src/server/ensembles/manager.ts) owns
that coordination. The extension surface, strategies, and limits already have their own
authoritative guide: [Multi-agent ensembles](ensembles.md).

For product behavior, see [Workflows, Personas, and session actions](workflows.md). Before
changing persisted IDs, workflow evidence, action adapters, or registries, follow the
[change contracts](agent-guides/change-contracts.md#persisted-identifiers) and
[session-action contract](agent-guides/change-contracts.md#session-actions) rather than
copying their rules here.

## Runtime continuity

Continue in terminal transfers every active binding of the same native conversation,
including each repository sibling, while preserving binding IDs, published version pins,
repository scopes, active runs, rounds, segments and frozen evidence. An existing capture
finishes before the source stops; new captures wait for verified ownership and reread the
binding. Evaluators may finish immutable work while transport is held.

Only prepared delivery destinations move. Delivered, refused, cancelled and uncertain
packets retain their attribution and acknowledgement policy. A transfer does not authorize
retry, resubmit, a new workflow publication, or manual reattach. Historical delivery observers
follow committed successor links, while ordinary consent and delivery gates still run before
an unsent packet can cross the terminal boundary.

Source removal and first discovery both honor the durable reservation. On definite failure,
the existing orphan policy applies. Unknown launch, ownership conflict or missing proof stays
visible in Sitrep without manufacturing a replacement workflow or agent. Evidence registration
returns a retryable `handoff_awaiting_discovery` refusal until the live successor is verified;
then the existing active Persona binding and issued checkout-scope checks apply unchanged.
