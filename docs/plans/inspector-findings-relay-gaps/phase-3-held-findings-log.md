# Phase 3: say why a PR's findings are being held (Fix 4)

**Source plan:** `docs/plans/inspector-findings-relay-gaps/plan.md` (revision 2), Fix 4 and D4
**Index:** `docs/plans/inspector-findings-relay-gaps/phased-plan.md`

This file is the proposed route. Follow it where the repository agrees, use your judgement where it
does not, and record any deviation and its reasoning in the pull request.

## 1. Outcome

When Foreman's follow-through skips a PR that has unresolved Inspector findings, its log says
which PR, how many findings, which round and why. It says so once per round and reason, so the
next investigation does not have to rebuild every gate from current state.

## 2. Entry criteria

- Phase 2 has merged.
- The worker iterates `reviewFollowupPrs(session, adopted)`.

## 3. Scope

In scope:

- Exported skip-reason constants in `review-followup.ts`.
- The dedupe map and log call in `worker.ts`.
- The Fix 4 documentation sentence.

Non-goals:

- A Foreman errors (health) entry. D4 rejected it.
- Logging the normal waiting skips.
- Any decision or gate change.

## 4. Repository findings and inherited contracts

- `worker.ts:1062` drops the reason with `if (decision.kind === "skip") continue;`.
- `reviewNudged` (`worker.ts:941`) is pruned for departed sessions at `:1011` and for sessions with
  no PR at `:1021`.
- Skip reasons are string literals passed to `skip()` in `review-followup.ts`. Two of them are
  normal waiting states: "still working" (`:611`) and "already nudged this round of feedback"
  (`:629`).
- From Phase 2: every `FollowupPr` carries `inspector` with `open` and `round`.

## 5. Implementation steps

1. In `review-followup.ts`, export constants for the two normal waiting reasons. Use them in
   `skip()` and export a set of them, for example `ROUTINE_FOLLOWUP_SKIPS`.
2. In `worker.ts`, add `heldLogged = new Map<string, string>()`, keyed by `${session.id}|${prKey}`,
   with the value `${round}|${why}`. Prune it wherever `reviewNudged` is pruned.
3. On a `skip` for a PR with `inspector.open > 0` whose reason is not routine, and whose value
   changed, log
   `` `${session.name}: holding ${open} GitHub Inspector finding(s) on ${prKey} (round ${round}) - ${why}` ``.
   Sessions that never reach the per-PR decision, such as those with no PR, log nothing.
4. `docs/work-queues.md`, "Keeping a PR on track": one sentence on the held-findings log line and
   when it is written.

## 6. Data, API and compatibility

There is no persistence, route or wire change. The log goes to the worker's stdout through `log()`,
like every other Foreman line.

## 7. Tests and verification

- `test/foreman-review-followup-relay.test.ts`, with a captured `console.log`:
  - two passes with the same held state log one line;
  - a new round logs again;
  - a changed reason logs again;
  - a PR without findings logs nothing;
  - a routine skip logs nothing.
- `test/foreman-review-followup.test.ts`: the exported constants are the strings `skip()` returns.
- Commands: each file above, then `npm run typecheck` and `npm run lint`.

## 8. Merge and exit criteria

- The tests, typecheck and lint pass.
- Docs updated, and `npm run docs:links` passes.
- One PR labelled `fork:inspector-findings` with a "Fork feature changes" section, merged with CI
  green.

## 9. Downstream handoff

Phase 4 does not consume this phase. Later work may rely on the log format and the exported
routine-skip set. It must not log routine skips, because that would turn the line into noise.

## 10. Cross-phase audit record

- Revision 3: part of one combined phase.
- Repair round 1: split out as Fix 4, third in the source plan's order, after Phase 2's
  `reviewFollowupPrs` loop.
