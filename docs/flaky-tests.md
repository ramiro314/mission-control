# Flaky tests in CI

CI tells a flaky test from a real failure and reports it:

- A test that **fails, then passes on one rerun of its file** is a **flake**. Its job stays
  green, the **"Flaky tests"** check on the commit lists it, and its GitHub issue records the
  occurrence.
- A test that **fails twice** is a **real failure** and fails its job, as before.
- A job that fails for a reason no test explains (results that cannot be read, a non-zero
  exit with no failing test) also fails, and the report says why.

This repository's CI is the first user. The design is in
[the flake-aware testing plan](plans/flake-aware-testing/plan.md); local flakes on the laptop
are the `affected-tests` gate's business (see [Affected tests](workflows.md#affected-tests))
and are never recorded here.

## How a run is classified

The report action, `.github/actions/mission-flake-report/`, runs in two modes.

**`mode: rerun`**, a step in each test job:

- **Unit shards** (`.github/actions/run-unit-shard/action.yml`). `npm test` runs the
  `test:run` script, which writes JUnit XML when `MISSION_TEST_JUNIT` names a path, and the shard
  records its exit code instead of failing. The action reads the results, reruns only the failed
  files once with its `rerun-command` template (`test:run` again, over the failed files), and
  compares. `test:run` is the one owner of how this repository gets JUnit out of `node --test`. `{files}` becomes one argument per failed file and
  `{junit}` the rerun's results path, the same template contract as the
  [`affected-tests` gate](workflows.md#affected-tests). The rerun's environment carries
  `MISSION_FLAKE_RERUN=1`.
- **End-to-end shards.** Playwright already retries once in CI, so the action reads its JSON
  report (`MISSION_PLAYWRIGHT_JSON` adds the reporter) instead of rerunning: a test with outcome
  `flaky` is a flake and `unexpected` a real failure.

A test that passed on the full run and failed on the rerun also counts as a flake: it failed
once and passed once. The step writes a per-job report, uploaded as a `flake-report-*`
artifact, and exits non-zero only for real failures or unexplained ones.

**`mode: publish`**, the `flake report` job, runs after every test job (unless the run was
cancelled). It merges the per-job reports, updates the flake issues, publishes the check, writes
the job summary, and uploads the merged report as the `flake-report` artifact.

## The "Flaky tests" check

Published on the commit the tests ran against: the **PR's head commit** for a pull request
(never the merge commit `github.sha` names), the pushed commit otherwise. Conclusion
`neutral` when anything flaked, `success` when nothing did. It never fails, because the jobs
already fail on real failures.

The title is the flake count. The summary lists each flake with its file, job, error snippet
and history issue, then the tests that failed twice, then anything that could not be
classified, and ends with a hidden machine-readable copy of the report:

```text
<!-- mission-flake-report:v1 {"version":1,"commit":"...","flakes":[...],...} -->
```

The summary is capped below GitHub's 65,535-character limit: failures and then flakes beyond
the cap are counted in `omitted`, not listed. `parseFlakeSummary` reads the marker back.

## The report format (v1)

Defined in `src/shared/flake-report.ts`, which is browser-safe so both the action and the
daemon use it:

| Field | Meaning |
| --- | --- |
| `version` | `1`. A later change adds a version; it never changes what v1 means. |
| `commit`, `ref`, `pullRequest`, `runUrl` | The run: head commit, branch, PR number or null, run link. |
| `flakes[]`, `failures[]` | `{ key, runner, file, name, message, job? }`. `file` is repository-relative, `name` joins enclosing suites with ` > `, `message` is capped at 400 characters. |
| `errors[]` | Why a job could not be classified. |
| `issues[]` | `{ key, number, url, occurrences, actionable }` for each flake, when issues were written. |
| `omitted` | Only in a capped summary: how many flakes and failures were left out. |

`key` is `flakeKey(runner, file, name)`, 16 hex characters of FNV-1a 64. It identifies one test
across runs, Node releases and shards, and is what ties a flake to its issue.

## Flake issues

One issue per flaky test, labelled with the `flakes.label` from the committed
`.mission/testing.json` (default `flaky-test`). The action creates that label and
`flakes.actionableLabel` if they are missing, and owns both.

- **First flake**: an issue titled `Flaky test: <name> (<file>)`. Its body starts with
  `<!-- mission-flake:v1 key=<key> -->`, names the test, file and runner, shows the occurrence
  count, and records the first occurrence.
- **Each later flake**: an occurrence comment on that issue. One comment per test per run,
  listing every job that saw it.
- Every occurrence, in the body or a comment, starts with
  `<!-- mission-flake-occurrence:v1 at=<ISO time> -->` and
  `<!-- mission-flake-run:v1 url=<run URL> -->`, then the PR or branch, the commit, the run link,
  the jobs and the error snippet.
- **Re-running the publish job** for the same CI run (same run URL, a later attempt) records
  nothing twice: an issue that already holds that run's marker is reported as it stands, without
  a new comment, reopen or label change. A full re-run of the test jobs reuses the run URL too,
  so it is treated the same way.
- **Actionable**: when the occurrences within the last `flakes.windowDays` days (default 30),
  counted from the issue's most recent reopen, reach `flakes.actionableAfter` (default 3), the
  issue gains `flakes.actionableLabel` (default `flaky-test:actionable`). Occurrences are dated by
  GitHub's own timestamps.
- **Fixed**: the fix PR closes the issue (`Fixes #n`). On its next run the action removes the
  actionable label from any closed flake issue.
- **Concurrent runs**: GitHub has no conditional create, so two runs that meet the same new
  flake at once can each open an issue. Each re-lists after creating; the higher-numbered issue
  replaces its key marker with `<!-- mission-flake-duplicate:v1 of=<n> -->`, closes itself, and
  its occurrence goes to the lowest-numbered one. Removing a label that a concurrent run already
  removed (a 404) counts as done.
- **One flake at a time.** Each flake's issue update is its own unit. A GitHub error on one (an
  issue deleted, transferred or locked mid-run) is named in the job summary and the rest of the
  run is still recorded. Only a 403 is read as a missing permission, and it ends the issue pass. Occurrences are also recounted after each
  comment is posted, so two runs recording at once still cross the threshold.
- **Flakes again after a fix**: the action reopens the issue, drops the actionable label, and
  counting starts over from the reopen.

The issue body marker and the occurrence marker are v1 contracts: the `deflake` skill reads an
issue's history through them.

## Settings

The `flakes` block of the committed `.mission/testing.json` (see
[Affected tests](workflows.md#affected-tests) for the whole file). CI never has the local
override, so only the committed values apply. A repository without the file uses the defaults;
an invalid file skips the issue updates with the error in the job summary and still publishes
the check.

## Permissions and fork pull requests

Only the `flake report` job may write, with job-level `checks: write` and `issues: write`; the
rest of CI keeps `contents: read`.

A pull request from a fork runs with a read-only token whatever the workflow asks for. There the
action writes the job summary and the merged report artifact only, and the summary says which
writes it skipped. The same happens, per write, when a token lacks one of the two permissions
(GitHub answers 403).

## Changing the action

The committed `index.mjs` and `action.yml` are generated. Edit `src/flake-report-action/` (or
the shared modules it bundles: `flake-report.ts`, `junit.ts`, `testing-config.ts`,
`command-template.ts`), then run:

```sh
npm run build:flake-report-action
```

and commit the result. `test/flake-report-action.test.ts` fails when the committed files differ
from the generator's output. Raise `FLAKE_REPORT_ACTION_VERSION` in
`src/flake-report-action/version.ts` with any behaviour change; the bundle's header carries it.
