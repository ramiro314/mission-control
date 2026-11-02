# Phase 1: a blocked run that cannot act stops silencing the follow-through (Fix 1)

**Source plan:** `docs/plans/inspector-findings-relay-gaps/plan.md` (revision 2), Fix 1 and D1
**Index:** `docs/plans/inspector-findings-relay-gaps/phased-plan.md`

This file is the proposed route. Follow it where the repository agrees, use your judgement where it
does not, and record any deviation and its reasoning in the pull request.

## 1. Outcome

A session whose only open workflow run is blocked on a spent budget, `unchanged_evidence_exhausted`
or `session_disappeared` receives Foreman's PR follow-through again: unresolved GitHub Inspector
findings, failing CI and merge conflicts. PR #13935 is the live example. Its run blocked on
`round_limit` and none of its three findings reached the session.

## 2. Entry criteria

- The planning pull request that adds `docs/plans/inspector-findings-relay-gaps/` has merged.
- No earlier implementation phase.

## 3. Scope

In scope:

- `WORKFLOW_FOLLOWUP_RELEASE_PHASES` and `workflowRunReleasesFollowup` in `src/shared/workflow.ts`.
- `workflowHoldsReviewFollowup` in `src/server/foreman/review-followup.ts`.
- Its three call sites, and CodeRabbit auto-resolve off for released sessions.
- The Fix 1 documentation.

Non-goals:

- Leave every other `activeWorkflowOwnsSession` caller alone: `registry.ts:5739`,
  `routes.ts:6456`, `routes.ts:7354`, `worker.ts:1324` and `worker.ts:1546`.
- Leave the Shipping veto, `WORKFLOW_RUN_TERMINAL_STATUSES` and every workflow lifecycle
  transition alone.
- Fix 2, Fix 3 and Fix 4 belong to later phases.

## 4. Repository findings and inherited contracts

- Gate 6 of `decideReviewFollowup` (`review-followup.ts:535`) skips on
  `workflowOwnsSession: true`. The decision does not change. Its input does.
- `activeWorkflowOwnsSession` (`review-followup.ts:416`) counts every status except `completed`,
  `cancelled` and `failed`.
- `workflowRunGaveUp` (`src/shared/workflow.ts:2663`) and `WORKFLOW_RUN_SPENT_PHASES` (`:2648`).
- `WorkflowRunSummary` carries `status`, `phase`, `round` and `maxRepairRounds` (`:5112`).
- The daemon's CodeRabbit guard computes `codeRabbitCandidate` (whose decision is
  `code-rabbit-delivery.ts:41`), then refuses at `routes.ts:6456` while any run is open. Because
  `:6456` stays unchanged (phased plan finding 1), a released session must not be sent a CodeRabbit
  claim.
- What the `:41` switch changes on the daemon:
  - `codeRabbitCandidate` (`code-rabbit-delivery.ts:14`) returns `{ error: decision.why }` when
    its decision skips (`:50`).
  - Today, for a session held by any open run, that error is gate 6's "an active workflow owns
    this session".
  - After the switch, a session held only by a released blocked run passes gate 6, so the
    candidate can come back without an error.
  - The inject route then refuses at `routes.ts:6456` regardless.

  The switch is therefore observable at the candidate, and harmless at the route.
- `test/code-rabbit-routing.test.ts` already has the fixture to pin this:
  - `setRuns` (`:73`) feeds `registry.initializeWorkflowRuns`;
  - `post` (`:67`) calls the real inject route;
  - `codeRabbitCandidate(f.registry, f.session.id, f.request)` is already asserted at `:152`;
  - a workflow-owned session is already refused at `:278`.
- The relay test's fake runs carry `status` only (`test/foreman-review-followup-relay.test.ts:114`).

## 5. Implementation steps

1. In `src/shared/workflow.ts`, beside `WORKFLOW_RUN_SPENT_PHASES`, export
   `WORKFLOW_FOLLOWUP_RELEASE_PHASES = ["unchanged_evidence_exhausted", "session_disappeared"] as const`
   and `workflowRunReleasesFollowup(run)`. It is true only for `status === "blocked"` with
   `workflowRunGaveUp(run)` or a listed phase. Add a one-line comment that the list is an allowlist,
   so a new blocked phase keeps holding the follow-through.
2. In `review-followup.ts`, export
   `workflowHoldsReviewFollowup(runs: readonly Pick<WorkflowRunSummary, "status" | "phase" | "round" | "maxRepairRounds">[]): boolean`.
   It is true when some run is open and does not release. A run with no `phase` holds.
3. Pass `workflowOwnsSession: workflowHoldsReviewFollowup(runs)` at `worker.ts:1050` and `:1114`,
   and at `code-rabbit-delivery.ts:41`.
4. At `worker.ts:1050` and `:1114`, set `codeRabbitAutoResolve` to false when
   `activeWorkflowOwnsSession(runs) && !workflowHoldsReviewFollowup(runs)`. Put the expression in one
   small helper so both call sites read the same answer.
5. Documentation:
   - `docs/work-queues.md`, "Keeping a PR on track": the workflow stand-down bullet names the
     three release cases and says CodeRabbit follow-up still waits for the run.
   - `docs/workflows.md`, "Blocked runs are recoverable, not terminal": one paragraph saying such a
     run keeps its Shipping veto but no longer silences Foreman's follow-through.

## 6. Data, API and compatibility

No schema, route or wire change. A missing `phase`, from older fixtures or a partial summary, holds
the follow-through, which is today's behavior.

## 7. Tests and verification

- `test/foreman-review-followup.test.ts`:
  - Predicate table:
    - running and waiting statuses hold;
    - spent `round_limit` releases, and the same run with `round <= maxRepairRounds` holds;
    - `unchanged_evidence_exhausted` and `session_disappeared` release;
    - `check_cleanup_unresolved`, an unknown phase and a run with no phase hold;
    - terminal statuses release.
  - `decideReviewFollowup` with a released blocked run and unresolved findings returns
    `read-findings`.
- `test/foreman-review-followup-relay.test.ts`:
  - A spent `round_limit` run with unresolved findings gets one inject carrying the findings' text,
    with no CodeRabbit claim.
  - A run released at the first read and `waiting_for_new_head` at the recheck types nothing.
- `test/code-rabbit-routing.test.ts`, one new test, "a released blocked run passes the CodeRabbit
  candidate decision but the route guard still refuses". It uses the existing fixture with
  `setRuns([{ noteKey: f.owner.noteKey, sessionId: f.session.id, status: "blocked", phase: "round_limit", round: 4, maxRepairRounds: 3 }])`:
  - `codeRabbitCandidate(f.registry, f.session.id, f.request).error` is undefined. This is the
    `:41` switch, and before this phase the same call returns "an active workflow owns this
    session".
  - `await f.post()` answers with a status of 400 or more, and its body names "An active workflow
    owns this session". This is `routes.ts:6456`, unchanged.
  - `f.messages` stays empty and `readCodeRabbit(f.key)!.receipts` stays empty, so nothing is typed
    and no claim is recorded.
  - A control case uses the same fixture with `phase: "check_cleanup_unresolved"`, which still
    holds the follow-through. Its candidate's `error` is "an active workflow owns this session".
- Commands: each file above, then `npm run typecheck` and `npm run lint`.

## 8. Merge and exit criteria

- The tests, typecheck and lint pass.
- `git grep -n activeWorkflowOwnsSession src` shows the five retained callers unchanged.
- Docs updated, and `npm run docs:links` passes.
- One PR labelled `fork:inspector-findings` with a "Fork feature changes" section, merged with CI
  green.

## 9. Downstream handoff

Phase 2 may rely on:

- `workflowHoldsReviewFollowup`;
- the CodeRabbit-off helper for released sessions;
- the worker call sites at `:1050` and `:1114` using both.

Phase 2 must keep every decision it builds, including the ones for adopted entries, on those
two. No later phase may widen `activeWorkflowOwnsSession` or the terminal-status list to get the
same effect.

## 10. Cross-phase audit record

- Revision 3: this was one combined phase.
- Repair round 1: split out as Fix 1. Kept `routes.ts:6456` unchanged, as the source plan says.
  Added CodeRabbit-off for released sessions so the unchanged guard never refuses a Foreman nudge.
- Repair round 2: added a daemon-side test of the `code-rabbit-delivery.ts:41` switch in
  `test/code-rabbit-routing.test.ts`. It shows the candidate releases for a released blocked run,
  `routes.ts:6456` still refuses, nothing is typed and no claim is recorded.
