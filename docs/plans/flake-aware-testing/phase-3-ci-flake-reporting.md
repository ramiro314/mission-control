# Phase 3: Flake reporting in CI

Part of [flake-aware testing](plan.md). Index: [phased-plan.md](phased-plan.md).

## 1. Outcome

CI tells flaky tests apart from real failures and reports them. A test that fails and then passes
on one rerun of its file is a flake: the test job stays green, a neutral **"Flaky tests"** check on
the PR's head commit lists it, and a GitHub issue for that test records the occurrence. A test that
fails twice still fails the job. This repository's CI is the first user.

## 2. Entry criteria and dependencies

- Phase 2 merged: `src/shared/junit.ts`, `src/shared/testing-config.ts` (with the `flakes` block),
  the `{files}`/`{junit}` placeholders, and this repository's `.mission/testing.json`.

## 3. Scope and non-goals

In scope:

- The flake report v1 format.
- The report action: its source, its generator, and the generated, committed action.
- Rerunning failed test files once in each test job, and runner-native retry reading for Playwright.
- Publishing the "Flaky tests" check, a job summary and an artifact.
- Flake history as GitHub issues, with the actionable label and the window.
- Wiring it into this repository's CI (`.github/workflows/ci.yml` and the unit shard action), which
  this task explicitly puts in scope.

Non-goals:

- Anything in the daemon that reads the check (Phase 4).
- Copying the action into other repositories (Phase 5 packages it for the setup skill).
- Task source changes or the `deflake` skill (Phase 6).

## 4. Repository findings and inherited contracts

- `.github/actions/` holds only the composite `run-unit-shard`. There is no JavaScript action and no
  committed bundle anywhere. `dist/` is gitignored.
- The generated-file precedent is a generator script plus a committed output plus a test asserting
  the committed file equals the generator's output (`scripts/builtin-session-actions.ts`,
  `test/builtin-session-actions.test.ts`). The repository rule: never hand-edit generated files.
- esbuild is a pinned dev dependency and already bundles `src/` with the `@shared` alias for other
  targets (`package.json` `build:*` scripts).
- CI: `pull_request` with no filters (fork PRs trigger it), top-level `permissions: contents: read`
  only. Unit tests run as 6 shards on Node 24 and 6 on Node 26 via
  `.github/actions/run-unit-shard/action.yml` (`xvfb-run -a npm test`, then build, then smoke). E2E
  runs 15 shards; Playwright retries once in CI and uploads its report only on failure.
- `npm test` hard-codes the `test/**/*.test.ts` glob and reads `MISSION_TEST_CONCURRENCY` and
  `MISSION_TEST_SHARD`.
- On `pull_request` events `github.sha` is the merge commit. The Inspector reads the **PR head
  commit's** check runs (Phase 4), so the check must be created on
  `github.event.pull_request.head.sha` for PRs and `github.sha` for pushes.
- Label convention: lowercase kebab-case and `prefix:value`. Body-marker precedent for upserts:
  `PRODUCT_ISSUE_BODY_MARKER` in `src/shared/product-issues.ts`.
- Fork PR tokens are read-only whatever the permissions block says.

## 5. Implementation steps

1. **Report format** in `src/shared/flake-report.ts` (browser-safe):
   - `FLAKY_TESTS_CHECK_NAME = "Flaky tests"`.
   - `FlakeReportSchema` v1: `{ version: 1, commit, ref, pullRequest?, runUrl, runner,
     flakes: [{ key, file, name, message, shard? }], failures: [{ key, file, name, message }],
     issues: [{ key, url, occurrences, actionable }] }`.
   - `flakeKey(runner, file, name)`: a stable, short hash that identifies a test across runs.
   - `renderFlakeSummary(report)`: the Markdown used for the check output and the job summary, ending
     with a hidden machine-readable marker `<!-- mission-flake-report:v1 {json} -->` holding the
     report (capped so the summary fits GitHub's 65,535-character limit; flakes beyond the cap
     are counted, not listed).
   - `parseFlakeSummary(markdown)`: reads the marker back. Phase 4 uses this.
2. **Action source** in `src/flake-report-action/` (Node script run by GitHub Actions, using only
   Node built-ins and `fetch` with `GITHUB_TOKEN`; it imports `junit.ts`, `testing-config.ts` and
   `flake-report.ts`). Two modes:
   - `mode: rerun` (a step in each test job): read the first run's JUnit, rerun only the failed
     files once from the `rerun-command` template (`{files}`, `{junit}`), classify flakes and real
     failures, write a per-job report file, and exit non-zero only for real failures. With
     `playwright-json` set, read Playwright's JSON report (tests with outcome `flaky`) instead of
     rerunning.
   - `mode: publish` (one job after all test jobs): collect every per-job report, merge them,
     create the "Flaky tests" check run on the head commit (conclusion `success` with no flakes,
     `neutral` with flakes; output title and summary from `renderFlakeSummary`), write the job
     summary, upload nothing itself (the workflow uploads the merged report as an artifact), and
     update issues (step 4).
   - Without `checks: write` or `issues: write` (fork PRs), write the job summary only and say
     which writes were skipped.
3. **Generator.** `scripts/build-flake-report-action.ts` bundles the source with esbuild into a
   single `index.mjs` and writes it, with a hand-written `action.yml` template (Node 24 runtime,
   inputs above), into `.github/actions/mission-flake-report/`. Add an `npm run
   build:flake-report-action` script and a test asserting the committed files equal the generator's
   output. The committed bundle carries a header naming the generator and the version.
4. **Flake issues** (in `mode: publish`, when `issues: write` is granted), using the committed
   `.mission/testing.json` `flakes` block:
   - Ensure the configured flake label and actionable label exist (create them if missing; the
     action owns these two labels).
   - Find the issue for each flake by its key: list open and closed issues with the flake label
     (paginated) and match the body marker `<!-- mission-flake:v1 key=<key> -->`.
   - No issue: create one titled `Flaky test: <name> (<file>)`, with the marker, the file and test
     name, and the first occurrence.
   - Existing issue: add an occurrence comment (marker
     `<!-- mission-flake-occurrence:v1 at=<ISO time> -->`, with branch or PR, commit, run link and
     error snippet), and reopen it if closed.
   - Count occurrences within `windowDays`, counting only comments after the most recent reopen. At
     `actionableAfter` or more, add the actionable label. Update the count in the issue body.
   - Closing an issue is done by the fix PR (`Fixes #n`); when an issue is closed, the action removes
     the actionable label on its next run if it is still present.
5. **This repository's CI.**
   - Add an npm script `test:ci` that runs the same command as `npm test` with an extra JUnit
     reporter (`--test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit
     --test-reporter-destination=<path>`), and use it in `run-unit-shard` so the test step records
     its exit code instead of failing the job, followed by the report action in `mode: rerun` with
     `rerun-command` set to the same `node --test ...` command with `{files}` and `{junit}`. Build
     and smoke run after, as today.
   - E2E: add Playwright's JSON reporter in CI, then the action in `mode: rerun` with
     `playwright-json`.
   - Every test job uploads its per-job report as an artifact.
   - A new `flake-report` job with `needs:` on the unit and e2e jobs and `if: always()`, granted
     `checks: write` and `issues: write` (job-level permissions only), downloads the per-job reports
     and runs the action in `mode: publish`, then uploads the merged report as an artifact.
6. **Docs.** A new `docs/flaky-tests.md` covering the report format, the check, the issues and
   labels, the settings, and fork PR behavior; link it from `docs/README.md` and `docs/workflows.md`.

## 6. Data, API and compatibility

- No daemon or database change.
- The report format is versioned (`version: 1`, marker `v1`). Later changes add a version rather
  than changing v1's meaning.
- The issue body marker and occurrence marker are v1 contracts Phase 6's `deflake` skill reads.
- Job-level permissions keep the rest of CI at `contents: read`.

## 7. Tests and verification

- `test/flake-report.test.ts`: key stability, render then parse round trip, the summary cap.
- `test/flake-report-action.test.ts`: `rerun` mode with fixture JUnit files and a stub rerun
  command (flake, real failure, all pass, unreadable results); Playwright JSON flaky reading;
  `publish` mode against a stubbed `fetch` (check run payload on the head SHA, neutral vs success,
  issue create, comment, reopen, actionable at the threshold, window expiry, skipped writes without
  permissions).
- The generator drift test.
- In CI itself: a throwaway branch with a deliberately flaky test (fails on first run, passes on
  rerun, keyed on an environment variable the rerun sets) shows a green unit job, a neutral "Flaky
  tests" check, and a new issue; removing it leaves a `success` check. Capture this as PR evidence
  and delete the test before merge.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.

## 8. Merge and exit criteria

- This repository's PRs show a "Flaky tests" check on the head commit for every CI run.
- Unit and e2e jobs are green when their only failures flaked, and red on a real failure.
- Flake issues open, gain occurrences, turn actionable at the threshold, and reopen after a close.

## 9. Downstream handoff

Later phases may rely on, and must not change:

- `FLAKY_TESTS_CHECK_NAME`, the v1 summary marker, and `parseFlakeSummary` (Phase 4).
- The check being created on the PR head commit.
- The issue body and occurrence markers and the label semantics (Phase 6).
- The generator as the only way the action bundle is produced. Phase 5 adds a second output
  location for the setup skill's assets; it does not fork the source.

## 10. Cross-phase audit

- Against Phase 2: imports `junit.ts` and `testing-config.ts` unchanged; both are free of `node:`
  imports, so they bundle into the action. The `flakes` defaults are Phase 2's.
- Phase 4's audit confirmed the check must be on the PR head commit, which step 2 already requires.
- Phase 6's audit confirmed the issue title and markers are enough for the `deflake` skill to find
  and read an issue's history.
