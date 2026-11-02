# Phase 2: follow the Inspector's adoption when the session card has no PR (Fix 2)

**Source plan:** `docs/plans/inspector-findings-relay-gaps/plan.md` (revision 2), Fix 2 and D2
**Index:** `docs/plans/inspector-findings-relay-gaps/phased-plan.md`

This file is the proposed route. Follow it where the repository agrees, use your judgement where it
does not, and record any deviation and its reasoning in the pull request.

## 1. Outcome

When a session's card shows no PR, Foreman still relays unresolved findings on an open PR the
Inspector adopted under that session, provided the session's checkout is on that PR's head branch.
Session `sdk:5e44203f` and PR #13934 are the live example.

## 2. Entry criteria

- Phase 1 has merged.
- The worker's decisions use `workflowHoldsReviewFollowup` and the CodeRabbit-off helper.

## 3. Scope

In scope:

- `loadOpenInspectorInspections()`.
- `GET /api/inspector/prs?state=open`.
- `inspectorSummaryOf(row, inspectorConfig, codeRabbit)`.
- `AdoptedInspection` and `reviewFollowupPrs(session, adopted)`.
- Two `ForemanClient` reads, and the worker wiring.
- The Fix 2 documentation sentence.

Non-goals:

- Leave `acceptPrForEpisode`, the session card's PR rule and task completion alone.
- Leave `followupPrs` and its other callers alone (`worker.ts:1326`, `:1547`, `code-rabbit-delivery.ts`).
- No CodeRabbit or CI dimension for adopted-only entries.
- PRs on another branch are out of scope (D2).

## 4. Repository findings and inherited contracts

- `followupPrs(session)` (`review-followup.ts:272`) reads only the session card.
- `acceptPrForEpisode` (`src/server/registry.ts:4910`) rejects a PR created before the episode
  started.
- `inspectorSummaryForUrl` (`registry.ts:9228`) is the projection to move.
- `GET /api/inspector/prs` (`src/server/routes.ts:7735`), `INSPECTION_TALLY_FROM` and
  `loadInspectorInspections` (`src/server/db.ts:14548`).
- `InspectorInspectionSchema` (`src/shared/protocol.ts:2635`) and `InspectorConfigSchema` (`:2533`).
- The relay tests assert call sequences (`test/foreman-review-followup-relay.test.ts:159`, `:241`,
  `:351`, `:363`).
- From Phase 1: `workflowHoldsReviewFollowup` and the CodeRabbit-off helper.

## 5. Implementation steps

1. `src/server/db.ts`: `loadOpenInspectorInspections()` is `INSPECTION_TALLY_FROM` with
   `WHERE p.state = 'open'`, grouped and ordered like `loadInspectorInspections`.
2. `src/server/routes.ts:7735`: parse `state` with `z.enum(["open"]).optional()`.
   - `state=open` returns those rows with `codeRabbit` added, as the unfiltered branch does.
   - Any other value is a 400.
   - `state` together with `adoptedSince` is a 400.
3. `src/shared/inspector.ts`: add
   `inspectorSummaryOf(row: InspectorInspection, inspectorConfig: Pick<InspectorConfig, "mode" | "enabled">, codeRabbit?: CodeRabbitSummary): InspectorSummary`.
   It carries the fields `inspectorSummaryForUrl` builds today. `codeRabbit` is included only when
   given. `registry.ts:9228` calls it with `getInspectorConfig()` and `codeRabbitSummary(...)`.
4. `review-followup.ts`:
   - Export `type AdoptedInspection = { row: InspectorInspection; inspector: InspectorSummary }`.
   - Export `reviewFollowupPrs(session, adopted: readonly AdoptedInspection[]): FollowupPr[]`. It
     returns `followupPrs(session)`, then appends one entry per `adopted` item where all of these
     hold:
     - `row.state === "open"`
     - `row.sessionId === session.id`
     - `row.repoRoot === session.repoRoot`
     - `row.headRefName !== null && row.headRefName === session.gitBranch`
     - `row.key` is not already present

     The appended entry is `{ prKey: row.key, url: row.url, number: row.number, repoRoot: null, inspector, checks: null, mergeable: null, baseRef: null, headSha: null, conflictEscalated: false }`.
5. `src/server/foreman/client.ts`: add `openInspections()`, which parses
   `z.array(InspectorInspectionSchema)`, and `inspectorConfig()`, which parses `InspectorConfigSchema`.
6. `src/server/foreman/worker.ts:999`:
   - After `sessions()`, read both once per pass.
   - Build `AdoptedInspection[]` with `inspectorSummaryOf(row, cfg, undefined)`.
   - Use `reviewFollowupPrs(session, adopted)` at `:1019` and `:1103`.
   - If either read fails, use an empty `adopted` for the pass and log it once.
   - Every decision keeps Phase 1's predicate and CodeRabbit-off helper.
7. `docs/work-queues.md`, "Keeping a PR on track": one sentence saying that an Inspector-adopted PR
   on the session's current branch is followed through even when the card shows no PR.

## 6. Data, API and compatibility

- No migration.
- The new `state` value is additive. Without it, the route behaves as before.
- `InspectorSummary` keeps its shape, and the session card is unchanged.
- An older daemon ignores `state` and returns the latest 50 rows. `reviewFollowupPrs` filtering on
  `row.state === "open"` covers that.

## 7. Tests and verification

- `test/foreman-review-followup.test.ts`:
  - `reviewFollowupPrs` keeps the card's PR first and appends a matching row.
  - It ignores another session, another repository, another branch, a null `headRefName`, a
    duplicate key and a closed row.
  - An adopted-only entry with findings yields `read-findings`. Without findings it yields the
    "nothing to act on" skip.
- `test/foreman-review-followup-relay.test.ts`:
  - The fake client gains `openInspections` and `inspectorConfig`, and the call sequences are
    updated.
  - An adopted-only PR is relayed with its findings' text.
  - A failed `openInspections` read still relays the card's PR.
  - A session held by an open run relays nothing for its adopted PR.
- `test/inspector-findings-route.test.ts`, or a new `test/inspector-prs-route.test.ts`:
  - `?state=open` returns only open rows, with `codeRabbit`.
  - `?state=closed`, `?state=` and `?state=open&adoptedSince=1` are 400s.
- A registry test confirms the session card's `inspector` summary is unchanged after the move, for
  a PR with CI and CodeRabbit state.
- Commands: each file above, then `npm run typecheck` and `npm run lint`.

## 8. Merge and exit criteria

- The tests, typecheck and lint pass.
- Docs updated, and `npm run docs:links` passes.
- One PR labelled `fork:inspector-findings` with a "Fork feature changes" section, merged with CI
  green.

## 9. Downstream handoff

Phase 3 may rely on:

- `reviewFollowupPrs(session, adopted)` as the follow-through's PR list;
- every entry carrying `inspector.open` and `inspector.round`;
- the worker's per-pass reads.

Later phases must not make `followupPrs` read Inspector adoption, and must not change
`inspectorSummaryOf`'s signature.

## 10. Cross-phase audit record

- Revision 3: part of one combined phase, with `reviewFollowupPrs(session, adopted, cfg)` and
  `inspectorSummaryOf(row, { mode, enabled })`.
- Repair round 1: split out as Fix 2, and both signatures restored to the source plan's:
  - `reviewFollowupPrs(session, adopted)`, which takes projected rows;
  - `inspectorSummaryOf(row, inspectorConfig, codeRabbit)`, with `codeRabbit` optional and passed
    as `undefined` by the worker.
