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

## Setting up a repository

Any repository on GitHub can be brought into this contract in one supervised task. In
**Settings → Trust**, each repository row has a **Set up testing** action ("Set up flake-aware
testing"). It does not start anything on its first click. It opens a choice under the row:
**Where should this repository's testing settings live?**

- **Commit a testing file** (committed). The agent commits `.mission/testing.json` and the CI
  changes, and sets the `affected-tests` Command. This is the path described below.
- **Store settings in Mission Control** (stored). For a repository that will not commit a
  testing file. The agent changes no file and proposes the gate's configuration as a Command
  document instead. See [Stored settings instead of a committed file](#stored-settings-instead-of-a-committed-file).

Neither is selected when the choice opens, and **Start testing setup** stays disabled until one
is; **Cancel** closes it without sending anything. Start calls
`POST /api/repositories/testing-setup` with the repository and the mode (`committed` or
`stored`, required: a start that names neither is refused with 400). That starts a ship task
whose intent invokes the **Testing setup** skill ([`skills/testing-setup/SKILL.md`](../skills/testing-setup/SKILL.md))
and names the mode in one line, `Testing setup mode: committed.` or `Testing setup mode: stored.`,
which the skill branches on.
The skill must be switched on in **Settings → Skills**; while it is off the action is refused on
the row with the sentence naming the toggle, and no task is created. It is also refused while an
earlier testing-setup task for the same repository is still open (in the backlog or live), in
either mode, so two agents never edit the same CI or replace each other's proposal at once; once
that task is done, failed or cancelled, the action starts a new one. The task has no review
Workflow bound: in committed mode the human approves every change in the skill's form and the
skill proves the result on its own pull request, and in stored mode there is no commit to review.

In committed mode the agent:

1. **Audits** the repository: the test runner and its JUnit XML flag, a rerun template with
   `{files}` and `{junit}`, whether CI runs the report action and at which version, the publish
   job's `checks: write` and `issues: write`, whether the check lands on the pull request's head
   commit, `.mission/testing.json`, the `.gitignore` entry for `.mission/testing.local.json`, the
   test-file patterns, and a proposed smoke set with a reason for each test.
2. **Proposes** every change in one `request_plan_decisions` form: the CI diff summary, the
   `.mission/testing.json` content, the smoke set (multi-select), the `affected-tests` template,
   and whether to recommend the **No-Mistakes Review (Affected tests)** workflow.
3. **Applies only what was approved**: copies the report action, edits CI and test scripts,
   writes `.mission/testing.json` and the `.gitignore` entry, commits it all, and sets the
   repository's `affected-tests` Command with the `set_affected_tests_command` Mission MCP tool.
   It does not open the pull request itself: Foreman's wrap-up (the Ship it? card, or Straight
   to PR) publishes the commit as one pull request.
4. **Verifies** twice: one local run of the `affected-tests` template on a few test files, and,
   once that pull request is open, the "Flaky tests" check on its own CI run.

The committed launch pre-approves `request_plan_decisions` and `set_affected_tests_command`, the
two Mission MCP tools its intent names, and not `propose_command_document`.

### Stored settings instead of a committed file

A repository that will not accept `.mission/testing.json`, such as a monorepo whose owners keep
Mission Control's configuration out of it, still gets an `affected-tests` gate. The gate can be
configured entirely in Mission Control: one `affected-tests` Command per app folder, run as its
own [partition](workflows.md#partitions), and [stored testing settings](workflows.md#testing-settings)
per [subdirectory scope](workflows.md#subdirectory-scopes). The stored mode has the agent work
that configuration out:

1. **Audits** the parts of the repository that decide the gate: each app's test runner and JUnit
   XML flag, a rerun template per app folder with `{files}` (relative to that folder) and
   `{junit}`, each folder's test-file patterns and smoke set, and the `affected-tests` Commands
   already set for the repository root and its folders, which the intent lists. It skips the CI,
   permissions and `.gitignore` items, because it commits nothing.
2. **Changes no file and makes no commit.** No `.mission/testing.json`, no CI edit, no copied
   report action, so there is no pull request.
3. **Proposes** everything as one [Command document](library-and-line.md#proposed-documents) with
   `propose_command_document`: `affected-tests` entries per folder and `testing` entries with
   `tests.patterns`, `tests.smokeSet` and, where it differs from the default,
   `tests.includeImporters`. It asks in no decision form. The proposal writes nothing live, and
   its preview is where you approve every change. A refused or blocked document is corrected and
   proposed again; the newer proposal replaces the pending one.
4. **Verifies** each proposed template with one local run in its folder on a few test files.

You then open the proposal from its banner in **Library › Commands** (or the attention inbox),
review the preview, and apply or dismiss it. The gate runs once it is applied. The stored mode
sets up no CI flake reporting: the report action and the `flakes` block have to be committed,
so a repository that wants the "Flaky tests" check runs the committed mode later.

The stored launch pre-approves only `propose_command_document`, and the task carries a second
label, `testing-setup:stored`, on which the daemon refuses `set_affected_tests_command` with 403.
A stored setup's Commands reach the catalog only through the preview you apply. Its title reads
`Set up flake-aware testing (stored): <repository>`.

### What the agent's Command tools can reach

`set_affected_tests_command` takes only the argv. The daemon refuses it from any session that is
not running a testing-setup task (the task carries the `testing-setup` label) or is running a
stored one (`testing-setup:stored`), checks the
`{files}` / `{junit}` rule, and writes only that task repository's `affected-tests` override,
keeping every other override, the default and the run budget.

That bounds what an agent may do **through MCP**: `set_affected_tests_command` is the only
Command write the Mission MCP tools offer. It is not a boundary on the agent itself. The
`/api/*` routes, the Command editor's `PUT /api/workflow-commands/:slot` among them, accept any
loopback caller without a token, so a process in the agent's shell can write any Command
override directly. See [Security](security.md#what-the-loopback-boundary-does-not-cover).

`propose_command_document` is the other Command tool an agent has, and it writes nothing live: it
stores a [proposed document](library-and-line.md#proposed-documents) for the calling session's own
task repository, which the operator applies or dismisses in Library › Commands. Its review is an
approval step on the MCP surface only, for the same reason: `POST /api/command-documents/apply`
accepts any loopback caller.

The copy the skill installs is `skills/testing-setup/assets/mission-flake-report/`, the second
output of the same generator as this repository's copy (see [Changing the action](#changing-the-action)),
because the packaged app ships `skills/` but not `.github/`. Run the setup again later and the
skill compares the version on the first line of the repository's copy with its own, and offers
the update as the only change when the repository's copy is older.

## How a run is classified

The report action, `.github/actions/mission-flake-report/`, runs in two modes.

**`mode: rerun`**, a step in each test job:

- **Unit shards** (`.github/actions/run-unit-shard/action.yml`). The shard provisions once
  with `npm run pretest`, asks `scripts/unit-shard.mjs` for its files (see
  [How unit shards pick their files](#how-unit-shards-pick-their-files)), then calls the
  `test:run` script directly over them (so `posttest` does not repeat files the shard already
  ran). `test:run` writes JUnit XML when `MISSION_TEST_JUNIT`
  names a path, and the shard records its exit code instead of failing. The action reads the results, reruns only the failed
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

On a docs-only pull request (every changed path under `docs/`), the unit and E2E jobs are
skipped and upload no reports. `flake report` is deliberately not skipped with them: its
`!cancelled()` condition runs it after skipped needs, it reads zero reports, and it publishes
"Flaky tests" with conclusion `success` and title "No flaky tests", so a docs-only run still
records its (empty) flake report. See the "Docs-only pull requests" comment at the top of
`.github/workflows/ci.yml`.

The Node 26 unit shards run only on pushes to `main`, tags and manual runs, so on every pull
request they are skipped and upload no reports, and "Flaky tests" covers the Node 24 shards and
E2E alone. `flake report` still needs them and runs after the skip the same way. A test that
flakes only on Node 26 is reported from the `main` run, against the merged commit. When that
push reuses the tree its pull request already tested, the Node 24 shards and E2E skip there
too, and "Flaky tests" on the merged commit covers the Node 26 shards alone.

### How unit shards pick their files

Unit shards are balanced by how long each test file takes, not by file index. The shard's
"Select shard files" step runs `node scripts/unit-shard.mjs <index>/<total>`, which expands
`test/**/*.test.ts` (the glob `npm test` names), weights each file by its milliseconds in
`test/shard-timings.json`, and deals the files longest first to whichever shard is lightest so
far. A file the timings do not name weighs the median of those they do, and with no timings at
all every file weighs the same. The output depends only on the file set and the timings file,
and the step prints how many files the shard runs.

The timings only steer balance. The file set always comes from the glob, so a stale, partial or
empty timings file can make one shard slower than the rest but never drops a test file or runs
one twice. `test/unit-shard.test.ts` holds that invariant. E2E shards are unaffected: they keep
Playwright's `--shard`.

A pull request runs three Node 24 unit shards and fourteen E2E shards, and a push to `main` runs
six Node 26 unit shards. With `gates` and `docs checks`, the pull request counts make 19 of
GitHub Free's 20 concurrent jobs; `build-smoke-node-24` has finished by then, since the E2E
shards download its `dist/`. The "Shard budget" comment in `.github/workflows/ci.yml` holds the
arithmetic. The timings are per file, so changing a count
needs no regeneration.

`test/shard-timings.json` is generated; never edit it by hand. Each unit shard uploads its first
run's JUnit results as the `unit-junit-node-<v>-shard-<n>` artifact (kept 7 days). When the
slowest unit shard drifts well above the others, pick a recent green run and regenerate:

```sh
npm run test:timings -- <run-id>
```

It downloads that run's `unit-junit-*` artifacts with `gh run download` from the checkout's own
repository, its gh default pin else `origin` (set `GH_REPO` to read another repository), sums
each file's top-level suite and test times per Node release (a `describe` suite counts at its
own time, so its hooks are included), averages the releases the run covered, keeps only files
that exist in the checkout, and rewrites the file. Commit the
result on its own.

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

### Who reads it

Mission Control reads the check through the GitHub Inspector's pull request query, which stores
the head commit's check runs with the pull request. `parseFlakeSummary` parses the report from
the full summary before anything is trimmed, so the marker at its end survives.

- **[Wait for CI](workflows.md#wait-for-ci)** treats "Flaky tests" as an ordinary check: it
  is not required, and a repository without it passes once every check has passed and stayed
  settled for the quiet period. When the check is present, the node records its flake list on
  a pass and shows it on the run.
- **The Inspector's review** lists the flakes and raises one only when the pull request touched
  the flaky test's file or plausibly introduced the flakiness. See
  [CI and flaky tests](inspector-and-shipping.md#ci-and-flaky-tests).

A fork pull request whose token could not publish the check has no flake report, so Wait for CI
judges its other checks and passes without a flake list.

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

## Fixing flakes from the backlog

Issues only report a flake. To get each actionable one fixed, add a
[GitHub Issues task source](dispatch-and-backlog.md#github-issues) for the repository, once:

- **Labels (all of)**: `flaky-test, flaky-test:actionable` (your `flakes.label` and
  `flakes.actionableLabel`).
- **Labels (none of)**: `wontfix`, or whatever label marks a flake you have decided to live with.
- **Labels (any of)**: blank.
- **Default kind**: ship, so each task ends in a fix pull request.
- **Workflow**: a lightweight review Workflow such as a Deflake Review you published, rather than
  **Kind default**, which binds the Ship row (No-Mistakes Review unless you changed it). A
  deflake changes little code, and binding it here means no one has to rebind each flake task by
  hand while ordinary Ship tasks keep their own review.

Each sweep then files one backlog task per open actionable flake issue, and nothing for a flake
that has not reached the threshold yet. The task's intent carries the issue's URL and body, and
the `Flaky test:` title and flake markers in it are what trigger the **Deflake** skill, so the
source needs no intent of its own. With that skill switched on (see
[Skills](skills-and-settings.md#skills-every-session-mixed-reload-behavior)), the agent reads the
issue and its occurrence comments, reproduces the flake under load before changing anything,
fixes its cause, proves the fix with a before and after repeated run at the same load, and
commits it with `Fixes #<n>` in the commit message and its completion report. The task's bound
workflow (the source's **Workflow**, or the kind's when left on Kind default) opens the fix pull request with its Pull Request action, or Foreman's wrap-up does when
the kind has no workflow, and the pull-request skill carries `Fixes #<n>` into the description.
Merging it closes the issue, and the next CI run drops the actionable label. Mission Control does not create this source for you.

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

and commit the result. It writes both `.github/actions/mission-flake-report/` and the testing-setup
skill's copy in `skills/testing-setup/assets/mission-flake-report/`, and
`test/flake-report-action.test.ts` fails when either committed copy differs from the generator's
output. Raise `FLAKE_REPORT_ACTION_VERSION` in
`src/flake-report-action/version.ts` with any behaviour change; the bundle's header carries it,
and it is what the testing-setup skill compares to offer other repositories the update.
