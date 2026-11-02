# Phase 4: a closed PR's leftover findings say they were left at close (Fix 3)

**Source plan:** `docs/plans/inspector-findings-relay-gaps/plan.md` (revision 2), Fix 3 and D3
**Index:** `docs/plans/inspector-findings-relay-gaps/phased-plan.md`

This file is the proposed route. Follow it where the repository agrees, use your judgement where it
does not, and record any deviation and its reasoning in the pull request.

## 1. Outcome

In the GitHub Inspector panel, a merged PR with drafted findings reads "3 unresolved at merge" in
place of "3 findings". Its Findings modal says the findings are kept as a record and will not be
reviewed again. 25 of the 41 unresolved findings on 2026-11-02 were on closed PRs.

## 2. Entry criteria

- Phase 3 has merged. This dependency follows the source plan's order. There is no code dependency.

## 3. Scope

In scope:

- One shared answer to "did this closed PR merge?", read from `observedState`.
- `inspectionSummary` wording.
- One record line in `InspectorFindingsModal` with an exported helper.
- The modal header's state word, so the header and the record line agree.
- Unit and e2e coverage, and the Fix 3 documentation.

Non-goals:

- Any `inspector_comments` change.
- Resolving closed PRs' findings, since `resolveInspectorFindings` still refuses them.
- Bucket changes (`inspectionBucket` already files closed PRs under **Closed**).
- Any change to `mergedAt` or what YOLO mode records.

## 4. Repository findings and inherited contracts

**The merged signal is `observedState`, not `mergedAt`.**

- `mergedAt` (`src/shared/types.ts:3047`, column `merged_at`) is set only when YOLO mode merged the
  PR itself. Its own comment says a human merge looks like the row simply going `closed`. On the
  operator's ledger on 2026-11-02:
  - 40 closed rows have `observed_state = 'MERGED'`, and all 40 have `merged_at` NULL;
  - 1 closed row has `observed_state = 'CLOSED'`.

  A rule on `mergedAt` would therefore read "at close" for every one of those merged PRs.
- `observedState` is GitHub's own state as of the last poll (`src/shared/types.ts:3071`, type
  `InspectorObservedState` from `INSPECTOR_OBSERVED_STATES = ["OPEN", "CLOSED", "MERGED"]` at
  `:2975`):
  - stored in `inspector_prs.observed_state` (`src/server/db.ts:2104`, added by the migration at
    `:4129`);
  - mapped by `rowToInspectorPr` (`:14046`);
  - written on every poll at `src/server/inspector/worker.ts:581`, before the same tick retires a
    non-open row at `:598`, so the final observation of a closed PR is always `MERGED` or `CLOSED`.
- The panel and the modal already receive it:
  - `rowToInspection` (`src/server/db.ts:14512`) spreads `rowToInspectorPr` (`:14020`), so every
    `InspectorInspection` from `GET /api/inspector/prs` carries `observedState` and `mergedAt`;
  - the wire schema `InspectorInspectionSchema` (`src/shared/protocol.ts:2635`) declares both
    (`:2657`, `:2660`).
- `inspectorPrStateWord` (`src/web/components/InspectorFindingsModal.tsx:11`) reads `mergedAt` only.
  It renders the modal header's state at `:117`, so today it says "closed" for a human-merged PR.
  Left as is, the header would say "closed" right above a record line that says "merged".
- `inspectionBucket` (`src/web/components/InspectorSettingsPanel.tsx:67`) and `inspectionSummary`
  (`:96`).
- `nothingPostedLine` (`InspectorFindingsModal.tsx:29`) is the precedent for an exported, testable
  modal line.
- The modal inset belongs to `.modal`, so the new line must not re-declare it.

## 5. Implementation steps

1. `InspectorFindingsModal.tsx`: export
   `inspectorPrClosedAs(pr: Pick<InspectorInspection, "state" | "observedState" | "mergedAt">): "merged" | "closed" | null`.
   - It returns null for an open PR.
   - It returns `"merged"` when `observedState === "MERGED"` or `mergedAt !== null`.
   - Otherwise it returns `"closed"`, including a closed row whose `observedState` is null from a
     build before the column existed.

   `inspectorPrStateWord` returns `"open"` for an open PR and `inspectorPrClosedAs(pr)` otherwise.
2. `inspectionSummary`: after the `lastError` and closed-and-never-reviewed branches, add one more.
   A closed row with `openFindings > 0` returns `"N unresolved at merge"` when
   `inspectorPrClosedAs(row) === "merged"`, and `"N unresolved at close"` otherwise. Import the
   helper rather than repeating the rule.
3. `InspectorFindingsModal.tsx`: export
   `closedRecordLine(pr, unresolvedCount): string | null`. For a closed PR with at least one
   unresolved finding, it returns "This pull request merged with N findings unresolved. They are
   kept as a record and will not be reviewed again." It says "closed" in place of "merged" when
   `inspectorPrClosedAs(pr)` says so. Render it once, above the list, in the modal's existing body.
4. `docs/inspector-and-shipping.md`:
   - describe the closed-PR wording beside the existing findings view text;
   - say that "merged" follows GitHub's observed state, so a PR you merged by hand reads "merged"
     too.

## 6. Data, API and compatibility

There is no route, wire or storage change. `observedState` is already stored, mapped, on
`InspectorInspection` and in `InspectorInspectionSchema` (section 4).

The one visible change beyond the new wording: the modal header's state word now says "merged",
not "closed", for a PR that merged without YOLO mode. `inspectionSummary` and `inspectionBucket`
never read `inspectorPrStateWord`, so nothing else moves.

## 7. Tests and verification

- `test/inspector-panel.test.ts` (or a new `test/inspector-findings-modal.test.ts` for the modal
  helpers):
  - `inspectorPrClosedAs`:
    - an open row gives null;
    - `observedState: "MERGED"` with `mergedAt: null` (a human merge) gives `"merged"`;
    - `mergedAt` set gives `"merged"`;
    - `observedState: "CLOSED"` gives `"closed"`;
    - a closed row with `observedState: null` gives `"closed"`.
  - `inspectionSummary`: a human-merged row with findings reads "N unresolved at merge", a
    closed-unmerged row reads "N unresolved at close", and the open, closed-with-zero-findings and
    failed rows are unchanged.
  - `closedRecordLine` for the merged, closed, open and zero-findings cases.
  - `inspectorPrStateWord` says "merged" for a human-merged row.
- `e2e/specs/inspector-findings.spec.ts`:
  - The fixture is a human-merged PR, `observed_state = 'MERGED'` and `merged_at` NULL, with
    drafted findings. Its row shows "unresolved at merge", and its Findings modal shows "merged" in
    the header and the record line.
  - A closed-unmerged PR shows "unresolved at close".
  - An open PR's row and modal are unchanged.

  Select by role and label, and add no `data-testid`.
- Commands:

```sh
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run test:e2e -- inspector-findings
```

## 8. Merge and exit criteria

- The unit tests, typecheck, lint, build, smoke and the e2e spec pass.
- Docs updated, and `npm run docs:links` passes.
- One PR labelled `fork:inspector-findings` with a "Fork feature changes" section, merged with CI
  green.

## 9. Downstream handoff

This is the last phase. Later work may rely on `inspectorPrClosedAs` as the one answer to whether a
closed PR merged, and on `closedRecordLine` and the closed-row wording. It must not:

- read `mergedAt` alone for that answer, since `mergedAt` means only that YOLO mode merged it;
- resolve or rewrite closed PRs' ledger rows to change what the panel shows.

## 10. Cross-phase audit record

- Revision 3: part of one combined phase.
- Repair round 1: split out as Fix 3, last in the source plan's order.
- Repair round 2:
  - The merged signal moved from `mergedAt`, which is YOLO-only, to `observedState`. Sources are
    in section 4.
  - The rule lives in one helper, `inspectorPrClosedAs`. The modal header uses it as well, so it
    agrees with the record line.
  - It is still no wire or storage change.
- Final audit over all four phases:
  - every source-plan requirement and decision has exactly one owner (Fix 1 in Phase 1, Fix 2 in
    Phase 2, Fix 4 in Phase 3, Fix 3 in Phase 4);
  - the signatures match the source plan;
  - `routes.ts:6456` is unchanged throughout;
  - each phase consumes only what an earlier phase hands off.
