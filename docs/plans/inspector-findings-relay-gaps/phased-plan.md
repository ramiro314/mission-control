# Phased implementation: GitHub Inspector findings that never reach their session

**Source plan:** `docs/plans/inspector-findings-relay-gaps/plan.md` (managed plan
`0200edfb-baa9-497f-99e4-6194dcbfbff6`, revision 2)

**Date:** 2026-11-02, revised in workflow repair rounds 1 and 2

**Shape:** four phases, one per fix, in the source plan's order (Fix 1, Fix 2, Fix 4, Fix 3). Each
phase is one task and one pull request labelled `fork:inspector-findings`.

## Incorporated decisions

Submitted through the dashboard decision form on revision 1. All of them are requirements here.

| Decision | Adopted option |
| --- | --- |
| D1 | Blocked runs on a spent budget (`workflowRunGaveUp`), `unchanged_evidence_exhausted` or `session_disappeared` stop holding the review follow-through. Every other blocked phase, and any phase added later, keeps holding it. |
| D2 | An Inspector-adopted PR is relayed only when its head branch is the session's current branch. |
| D3 | A closed PR's leftover findings read "N unresolved at merge" (or "at close"), with one record line in the Findings modal. No ledger change. |
| D4 | One Foreman log line per session, PR, round and reason when a PR with unresolved findings is held. |
| Follow-up | Create this phased plan. |

The source plan's "Order and merge shape" section is also binding: Fix 1, Fix 2, Fix 4, Fix 3, each
as its own pull request labelled `fork:inspector-findings`. This phased plan keeps that shape. The
source plan's signatures are binding too: `reviewFollowupPrs(session, adopted)` and
`inspectorSummaryOf(row, inspectorConfig, codeRabbit)`.

## Findings from the repository

Checked against `3393606ab`. None of these changes a requirement in the source plan.

1. **`routes.ts:6456` stays unchanged, so a released session gets no CodeRabbit work.**
   - A Foreman nudge carrying a CodeRabbit claim reaches the daemon's CodeRabbit guard. The guard
     first builds the candidate, whose decision is `code-rabbit-delivery.ts:41`. It then refuses
     with "An active workflow owns this session" at `routes.ts:6456`.
   - The source plan switches `:41` and keeps `:6456` on `activeWorkflowOwnsSession`, so `:6456`
     still refuses a CodeRabbit nudge into a session held only by a released blocked run.
   - The source plan's behavior table releases "findings, CI and conflicts" for those runs.
     CodeRabbit is not on that list.
   - **Phase 1 therefore decides with CodeRabbit auto-resolve off** whenever the session's runs are
     open (`activeWorkflowOwnsSession`) but released (`!workflowHoldsReviewFollowup`). The worker
     never sends a claim `:6456` would refuse, and CodeRabbit follow-up waits for the run to finish,
     as it does today. `:6456` and every other retained caller stay as the source plan lists them.
2. **The summary projection reads two daemon-only inputs.** `Registry.inspectorSummaryForUrl`
   (`src/server/registry.ts:9228`) reads `getInspectorConfig()` and `codeRabbitSummary`, and
   Foreman's worker never touches SQLite. That is why the source plan's
   `inspectorSummaryOf(row, inspectorConfig, codeRabbit)` takes both as arguments:
   - `codeRabbit` is optional;
   - the registry passes `codeRabbitSummary(...)`;
   - the worker passes `undefined`, so an adopted-only entry never carries CodeRabbit work.

   The worker gets `inspectorConfig` from the existing `GET /api/inspector/config`, parsed with
   `InspectorConfigSchema` (`src/shared/protocol.ts:2533`).
3. **`reviewFollowupPrs(session, adopted)` takes projected rows.** `adopted` is
   `readonly AdoptedInspection[]`, where `AdoptedInspection = { row: InspectorInspection; inspector: InspectorSummary }`.
   The worker builds each entry with `inspectorSummaryOf(row, inspectorConfig, undefined)`, so the
   two-argument signature holds and the function stays pure.
4. **The response schema already exists.** `InspectorInspectionSchema` (`src/shared/protocol.ts:2635`)
   is pinned to `InspectorInspection` by a two-way type check, so `GET /api/inspector/prs?state=open`
   is parsed with `z.array(InspectorInspectionSchema)`.
5. **`loadOpenInspectorPrs` carries no tallies** (`src/server/db.ts:14272`), so Phase 2 adds
   `loadOpenInspectorInspections()` on `INSPECTION_TALLY_FROM`, as the source plan says.
6. **The relay tests pin exact client call sequences** (`test/foreman-review-followup-relay.test.ts:159`,
   `:241`, `:351`, `:363`). Phase 2's two new reads change those sequences, and updating them is
   part of Phase 2.
7. **The fake client's workflow runs carry `status` only.** A run with no `phase` holds the
   follow-through, so the existing fixtures keep their meaning in Phase 1.
8. **The `code-rabbit-delivery.ts:41` switch is observable at the candidate, not at the route.**
   - `codeRabbitCandidate` returns the decision's skip reason as its `error`
     (`code-rabbit-delivery.ts:50`).
   - After the switch, a session held only by a released blocked run gets a candidate with no
     error. The unchanged `routes.ts:6456` then refuses the delivery.
   - Phase 1 pins both halves, and that nothing is typed or claimed, in
     `test/code-rabbit-routing.test.ts`, with the fixture's existing `setRuns` and `post`.
9. **"Merged" comes from `observedState`, not `mergedAt`.**
   - `mergedAt` (`src/shared/types.ts:3047`) is set only when YOLO mode merged the PR itself. On
     the operator's ledger, all 40 merged rows have `merged_at` NULL and `observed_state = 'MERGED'`.
   - `observedState` (`:3071`) is written on every poll at `src/server/inspector/worker.ts:581`,
     before the row retires at `:598`. `rowToInspection` (`src/server/db.ts:14512`) maps it onto
     every `InspectorInspection`, and `InspectorInspectionSchema` (`src/shared/protocol.ts:2660`)
     declares it.
   - Phase 4 therefore needs no wire or storage change. It adds one helper,
     `inspectorPrClosedAs`, which the panel row, the record line and the modal header's
     `inspectorPrStateWord` all share. Today that header reads `mergedAt` alone and says "closed"
     for a human-merged PR.

## Sizing

Estimated non-test implementation lines, added or materially changed:

| Phase | Estimate | Assumptions |
| --- | --- | --- |
| 1, Fix 1 | 35 to 50 | One phase list and predicate in `src/shared/workflow.ts`, one predicate in `review-followup.ts`, three call sites, CodeRabbit off for released sessions |
| 2, Fix 2 | 100 to 130 | Loader, route branch, moved projection, `reviewFollowupPrs`, two client reads, worker wiring |
| 3, Fix 4 | 25 to 40 | Exported skip-reason constants, a dedupe map, one log call |
| 4, Fix 3 | 20 to 35 | One shared closed-as helper, copy changes in two components, one record-line helper |
| Total | 180 to 255 | |

**Why four phases, not one.** Sizing alone would put this in one phase. The approved source plan
fixes the delivery as four pull requests in a stated order, and no decision has changed that.

## Phases

| Phase | File | Outcome | Direct prerequisite |
| --- | --- | --- | --- |
| 1 | `phase-1-relay-held-inspector-findings.md` | A blocked run that only you or the session can restart stops silencing findings, CI and conflicts | Planning merge |
| 2 | `phase-2-adopted-pr-relay.md` | Findings on an Inspector-adopted PR reach the session on its branch when the card shows no PR | Phase 1 |
| 3 | `phase-3-held-findings-log.md` | A held relay logs why, once per round | Phase 2 |
| 4 | `phase-4-closed-pr-wording.md` | A closed PR's leftover findings read as a record | Phase 3 |

Dependency graph: `planning session -> Phase 1 -> Phase 2 -> Phase 3 -> Phase 4`.

The chain is serial because the source plan states the order. The real code dependencies are
narrower:

- Phases 1 to 3 all edit the follow-through loop in `src/server/foreman/worker.ts:999-1140`.
- Phase 4 touches only the web components. It follows Phase 3 only because of the stated order.

## Cross-phase contracts

| Contract | Owner | Consumers |
| --- | --- | --- |
| `WORKFLOW_FOLLOWUP_RELEASE_PHASES` and `workflowRunReleasesFollowup(run)` in `src/shared/workflow.ts` | Phase 1 | Phase 2 and Phase 3 (the worker loop they extend) |
| `workflowHoldsReviewFollowup(runs)` in `review-followup.ts`, used at `worker.ts:1050`, `:1114` and `code-rabbit-delivery.ts:41` only | Phase 1 | Phase 2, which keeps those call sites, and Phase 3, whose log reports the skip they produce |
| CodeRabbit auto-resolve is off for a session whose open runs are all released | Phase 1 | Phase 2, which keeps the rule when it builds decisions for adopted entries |
| `inspectorSummaryOf(row, inspectorConfig, codeRabbit?)` in `src/shared/inspector.ts` | Phase 2 | Registry and worker |
| `reviewFollowupPrs(session, adopted)` with `AdoptedInspection[]` | Phase 2 | Phase 3, which logs skips for every entry it returns |
| `GET /api/inspector/prs?state=open` | Phase 2 | Foreman worker |
| Exported skip-reason constants in `review-followup.ts` | Phase 3 | Phase 3's log filter |
| `inspectorPrClosedAs(pr)`, read from `observedState` with `mergedAt` as a fallback, plus the closed-PR wording and `closedRecordLine` | Phase 4 | Panel row, Findings modal header and record line |

Every retained `activeWorkflowOwnsSession` caller stays as the source plan lists them:
`registry.ts:5739`, `routes.ts:6456`, `routes.ts:7354`, `worker.ts:1324` and `worker.ts:1546`.

## Final verification

- Each phase runs its own focused tests with `node --test --import ./test/setup-state.mjs --import tsx <file>`,
  plus `npm run typecheck` and `npm run lint`.
- Phase 4 also runs `npm run build`, `npm run smoke` and `npm run test:e2e -- inspector-findings`.
- After Phase 2 merges, on the operator's daemon:
  - PR #13935 (blocked `round_limit`, session `sdk:2be86cf6`) gets one follow-through carrying its
    drafted findings the next time the session settles idle. This already holds after Phase 1.
  - PR #13934 (session `sdk:5e44203f`) gets the same.
- After Phase 3, a held PR's log line appears once per round.
