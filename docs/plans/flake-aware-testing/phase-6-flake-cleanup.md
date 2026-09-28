# Phase 6: Flake cleanup

Part of [flake-aware testing](plan.md). Index: [phased-plan.md](phased-plan.md).

## 1. Outcome

Flaky tests get fixed, not just reported. A GitHub Issues task source can pick up exactly the
actionable flake issues by label combination ("all of `flaky-test` and `flaky-test:actionable`,
none of `wontfix`"), so each one becomes a backlog task. The task's agent uses a new `deflake` skill
that insists on reproducing the flake under load and fixing its cause, and closes the issue from
the fix PR.

## 2. Entry criteria and dependencies

- Phase 3 merged: flake issues exist with the v1 body and occurrence markers and the two labels.
- Independent of Phases 4 and 5; can merge before or after them.

## 3. Scope and non-goals

In scope:

- `labelsAll` and `labelsNone` on the GitHub Issues task source: schema, query, push behavior, UI,
  docs.
- The `deflake` skill.
- A documented task source recipe for flake issues.

Non-goals:

- The Jira source (JQL already combines labels).
- Automatic quarantine (the source plan rules it out).
- Creating the task source automatically. The operator configures it; the docs give the recipe.

## 4. Repository findings and inherited contracts

- `GithubIssuesConfigSchema` (`src/shared/task-source.ts`) has `labelsAny` (up to 20, deliberately
  not normalized). Zod defaults apply on read, so new fields need no migration.
- `ghIssueListArgs` (`src/server/task-sources/github-issues.ts`): one label uses `--label` (which is
  AND when repeated); several `labelsAny` become one `--search "label:a,b"` (comma is OR). Search
  terms are joined into one `--search`; `quoteTerm` quotes values with whitespace, commas, quotes or
  colons.
- Push (`ghIssueCreateArgs`) adds every `labelsAny` label to a pushed issue so it matches the
  source's filter.
- UI: `TaskSourcesPanel.tsx` `GithubFields`, the "Labels (any of)" input (comma list via
  `splitList`).
- Docs: `docs/dispatch-and-backlog.md` "GitHub issues" filter table and the push section.
- Tests: `test/github-issues-map.test.ts` (query args and create args), plus the other `labelsAny`
  references (`test/task-push-http.test.ts`, `test/gh-bin-seam.test.ts`,
  `e2e/specs/push-task-to-github.spec.ts`).
- Skills: `skills/<id>/SKILL.md` with the catalog frontmatter rules (see Phase 5).
- Phase 3 contract: issue title `Flaky test: <name> (<file>)`, body marker
  `<!-- mission-flake:v1 key=<key> -->`, occurrence comments with
  `<!-- mission-flake-occurrence:v1 at=<ISO> -->`, labels from `.mission/testing.json` `flakes`.

## 5. Implementation steps

1. **Schema.** Add `labelsAll` and `labelsNone` (same bounds as `labelsAny`, default `[]`) to
   `GithubIssuesConfigSchema`. Refuse a label that appears in both `labelsAll` or `labelsAny` and
   `labelsNone`.
2. **Query.** In `ghIssueListArgs`: each `labelsAll` label becomes a separate `label:<l>` search
   term (space is AND); each `labelsNone` label becomes `-label:<l>`; both use `quoteTerm`. They
   combine with today's `labelsAny` handling in the same `--search`. A source with only one
   `labelsAny` and nothing else keeps using `--label` exactly as today.
3. **Push.** A pushed issue carries every `labelsAny` label (unchanged) and every `labelsAll`
   label, and never a `labelsNone` label, so it still matches the source's filter.
4. **UI.** `GithubFields` gains "Labels (all of)" and "Labels (none of)" inputs beside
   "Labels (any of)", with the same comma-list editing.
5. **`deflake` skill** `skills/deflake/SKILL.md`. It tells the agent to:
   - read the flake issue and its occurrence comments (error snippets, branches, dates)
   - reproduce the flake before changing anything: repeat the test many times, raise
     concurrency, and run it alongside a CPU-heavy process; record the failure rate
   - find the timing or ordering dependency and fix its cause
   - loosen a timeout only when the limit itself is wrong, and say why in the PR
   - prove the fix with a before/after repeated run at the same load
   - open the fix PR with `Fixes #<issue>` so merging closes the issue
6. **Docs.** `docs/dispatch-and-backlog.md`: the two new filters and push behavior.
   `docs/flaky-tests.md`: the cleanup recipe (a GitHub Issues source with all of the flake and
   actionable labels, none of `wontfix`, and an intent that invokes the `deflake` skill), and the
   new skill in `docs/skills-and-settings.md`.

## 6. Data, API and compatibility

- No migration; new fields default to empty lists on read.
- Existing sources produce exactly the same `gh` arguments as before (pinned by the existing
  tests).

## 7. Tests and verification

- `test/github-issues-map.test.ts`: all-of terms, none-of terms, combined with any-of, quoting,
  unchanged args for existing configs, push labels include all-of and exclude none-of, schema
  refusal of a label in both lists.
- `test/task-sources-panel.test.ts`: the two new inputs render and round-trip.
- `test/skills-catalog.test.ts`: `deflake` parses; a content test pins "reproduce first", the
  timeout rule, and the before/after proof.
- `e2e/`: configure a GitHub Issues source with all-of and none-of labels in Settings and read the
  saved config back; sweep against the `FAKE_GH` stub and assert the `gh` search it received.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e` for the new
  spec.

## 8. Merge and exit criteria

- A source configured with all of `flaky-test` and `flaky-test:actionable` sweeps only actionable
  flake issues into the backlog, and a pushed task still matches its own source.
- The `deflake` skill is in the catalog and can be enabled.

## 9. Downstream handoff

- `labelsAll`, `labelsNone` and the skill id `deflake` are new public contracts. No later phase
  depends on them.

## 10. Cross-phase audit

- Against Phase 3: reads the issue title, markers and labels exactly as Phase 3 writes them, and
  relies on the fix PR closing the issue, which Phase 3's action treats as the end of an
  actionable period.
- Against Phase 5: follows the same skill frontmatter rules; the two skills do not reference each
  other.
