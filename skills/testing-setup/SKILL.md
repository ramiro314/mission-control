---
name: testing-setup
description: Bring a repository into Mission Control's flake-aware testing contract, in the mode the task names. Committed - audit its test runner, JUnit output, CI flake reporting, permissions and testing settings, propose every change in one approval form, apply only what the human approved (one commit with the CI and test-script changes, the copied report action and .mission/testing.json, which Mission Control publishes as a pull request, plus the repository's affected-tests Command), then prove it with a local affected-tests run and the "Flaky tests" check on the setup pull request's own CI. Stored, for a repository that will not commit a testing file - change no file, work out per-app affected-tests Commands and testing settings, submit them as one Command document with propose_command_document for the human to apply from the preview, and prove each template with a local run. Use when a "Set up flake-aware testing" task arrives, or when asked to set up, audit or update flake-aware testing or the mission-flake-report action in a repository.
metadata:
  mission:
    category: testing
    enforcement: triggered
---

# Testing setup

This brings one repository into Mission Control's flake-aware testing contract:

- **Locally**, a workflow's `affected-tests` Check runs only the tests a change touched, chosen
  from the committed `.mission/testing.json`, and reruns failures once.
- **In CI**, the full suite runs with JUnit output; the `mission-flake-report` action reruns
  failed test files once, keeps the job green when flakes are the only failures, publishes a
  **"Flaky tests"** check on the commit, and keeps one GitHub issue per flaky test.

The rule that shapes every step below: **apply only what was approved.** You audit, you ask
once, and you change exactly what the human selected in that one form - nothing else, not even
an obvious fix you noticed on the way. If the audit finds nothing to change, you say so and stop:
no commit, no pull request, no form.

## Choose the mode

The human chose where this repository's testing configuration lives before the task started,
and the task intent says which in one line:

- **`Testing setup mode: committed.`** Follow sections 1 to 4 below. The repository commits
  `.mission/testing.json` and the CI changes, and you set the `affected-tests` Command with
  `set_affected_tests_command`.
- **`Testing setup mode: stored.`** Follow [Stored mode](#stored-mode) instead of sections 2 to
  4. The repository will not commit a testing file, so you change no file in it. You propose the
  per-app `affected-tests` Commands and testing settings as one Command document with
  `propose_command_document`, and the human applies it from its preview.

Never switch modes on your own. If the chosen mode cannot work (for example, stored mode on a
repository whose tests cannot write JUnit XML), report why and stop; the human starts the other
mode from the Trust row if they want it.

## What you are installing

In committed mode (stored mode installs nothing in the repository):

```
<repo>/
  .github/actions/mission-flake-report/   # copied from this skill's assets, never edited
    action.yml
    index.mjs
  .github/workflows/<ci>.yml              # test jobs rerun failures; one job publishes
  .mission/testing.json                   # test patterns, smoke set, flake labels (committed)
  .gitignore                              # + .mission/testing.local.json
```

Plus one thing outside the repository: the **`affected-tests` Command** for this repository in
Mission Control, a template with `{files}` and `{junit}` placeholders, set with
`set_affected_tests_command`.

The action's source copy lives next to this file, in `assets/mission-flake-report/`. Resolve
this skill's directory (the one holding this `SKILL.md`, following symlinks) and copy from
there. Its version is on the first line of both files: `// mission-flake-report X.Y.Z` in
`index.mjs` and `# mission-flake-report X.Y.Z` in `action.yml`.

## 1. Audit

Read the repository; change nothing yet. Record a finding for each item, with the evidence
(file and line) behind it:

1. **Test runner and JUnit XML.** Which runner runs the tests (`node --test`, Vitest, Jest,
   Playwright, pytest, go test, ...), how CI invokes it, and whether it can write JUnit XML.
   Most can with a reporter flag: `node --test --test-reporter=junit
   --test-reporter-destination=<path>`, `vitest run --reporter=junit --outputFile=<path>`,
   `jest --reporters=default --reporters=jest-junit` (with `JEST_JUNIT_OUTPUT_FILE`),
   `pytest --junitxml=<path>`, `gotestsum --junitfile <path>`. Name the exact flag, and whether
   the runner writes a `file` attribute on each test case (the rerun needs to know which file
   failed). For Playwright, note whether CI already retries (`retries` in the config); the
   action then reads its JSON report instead of rerunning.
2. **Rerun command template.** The command that runs only some test files and writes JUnit XML,
   with `{files}` as a whole argument (one argument per file) and `{junit}` where the results
   path goes. Prefer reusing the repository's own test script so the first run and the rerun
   share one invocation. Check that it really accepts a file list.
3. **The report action in CI.** Whether `.github/actions/mission-flake-report/` exists, and its
   version against this skill's asset. Whether each test job runs it in `mode: rerun` after the
   test step (which must record its exit code instead of failing), uploads the per-job report as
   a `flake-report-*` artifact, and whether one job after all test jobs runs `mode: publish`.
4. **Permissions.** The publish job, and only that job, needs job-level `checks: write` and
   `issues: write`. Note the workflow's top-level `permissions` and whether a broader grant
   exists that should not.
5. **The check on the PR head commit.** The publish job must run on `pull_request` events (not
   only on push to the default branch) and with `if: ${{ !cancelled() }}`, so the "Flaky tests"
   check lands on the pull request's head commit even when a test job fails. The action already
   uses the head commit, never the merge commit.
6. **`.mission/testing.json`.** Whether it exists and is valid (keys: `tests.patterns`,
   `tests.includeImporters`, `tests.smokeSet`, and the `flakes` block: `label`,
   `actionableLabel`, `actionableAfter`, `windowDays`). An unknown key is refused by Mission
   Control, so do not invent any.
7. **The `.gitignore` entry** for `.mission/testing.local.json`, the per-checkout override.
8. **Test-file patterns.** Repository-relative globs matching every test file and nothing else
   (for example `test/**/*.test.ts`, `src/**/*.spec.ts`, `tests/**/test_*.py`). Count the files
   each matches.
9. **A proposed smoke set.** Tests that should run on every change because any change can break
   them: registry-style tests that enumerate every route, command, tool, setting or schema;
   generated-file drift tests; cross-cutting contract tests. Give the reason for each one. Keep
   it short; every entry runs on every change.
10. **The current `affected-tests` Command.** The task intent says whether Mission Control
    already has one for this repository, and what it is. Propose a template only when there is
    none or it disagrees with the rerun template above.

If the repository is not on GitHub, stop and say so: the report action needs GitHub Actions and
the GitHub API.

## 2. Propose, in one form

Call the Mission Control MCP tool **`request_plan_decisions`** once, with every proposed change.
Never ask in prose, and never split the proposal across several forms. The `plan` markdown
carries the audit findings and the full proposed content; the `decisions` let the human choose.

The plan shows:

- **The CI diff summary**: which workflow files change, which jobs gain which steps, the exact
  permissions added to which job, and the action version being copied.
- **The `.mission/testing.json` content**, in full.
- **The `.gitignore` line.**
- **The `affected-tests` template**, as the exact argv it will be set to.
- Anything already in place, marked as unchanged.

The decisions (omit one whose change is not needed, and keep ids stable):

- `apply-ci`: apply the CI and test-script changes and copy the action (yes / no).
- `testing-json`: write `.mission/testing.json` and the `.gitignore` entry as shown (yes / no).
- `smoke-set`: `multiSelect: true`, one option per proposed smoke test with its reason as the
  option detail, all recommended; the human unticks what should not run every time.
- `affected-tests-command`: set this template as the repository's `affected-tests` Command
  (yes / no, `allowOther: true` so the human can correct the argv).
- `recommend-workflow`: whether to recommend binding the **No-Mistakes Review (Affected tests)**
  workflow (`builtin-workflow:no-mistakes-review-affected-tests`) for this repository's work.
  You only recommend it in the report; you never change dispatch defaults.

A dismissed form, or one where nothing was selected, means nothing is applied. Report that and
stop.

## 3. Apply only what was approved

Change exactly what was selected, in this repository only:

1. **Copy the action**: the two files from this skill's `assets/mission-flake-report/` into
   `.github/actions/mission-flake-report/`, byte for byte. Never edit them; a later run of this
   skill replaces them whole.
2. **Edit CI and test scripts.** In each test job: make the test step write JUnit XML and record
   its exit code instead of failing, then run the action in `mode: rerun` and upload the report.
   Add one publish job after every test job. The shape, adapted to the repository's own jobs:

   ```yaml
   - name: Test
     id: test
     shell: bash
     run: |
       mkdir -p "$RUNNER_TEMP/flake"
       set +e
       <the test command, writing JUnit XML to $RUNNER_TEMP/flake/junit.xml>
       echo "exit-code=$?" >> "$GITHUB_OUTPUT"

   - name: Rerun failed test files once
     uses: ./.github/actions/mission-flake-report
     with:
       mode: rerun
       job: <a label for this job>
       junit: ${{ runner.temp }}/flake/junit.xml
       exit-code: ${{ steps.test.outputs.exit-code }}
       rerun-command: <the rerun template with {files} and {junit}>
       report: ${{ runner.temp }}/flake/report.json

   - name: Upload flake report
     if: ${{ !cancelled() }}
     uses: actions/upload-artifact@v4
     with:
       name: flake-report-<unique per job>
       path: ${{ runner.temp }}/flake/report.json
   ```

   ```yaml
   flake-report:
     name: flake report
     needs: [<every test job>]
     if: ${{ !cancelled() }}
     runs-on: ubuntu-latest
     permissions:
       contents: read
       checks: write
       issues: write
     steps:
       - uses: actions/checkout@v5
       - name: Download flake reports
         continue-on-error: true
         uses: actions/download-artifact@v4
         with:
           pattern: flake-report-*
           path: flake-reports
       - name: Publish flake report
         uses: ./.github/actions/mission-flake-report
         with:
           mode: publish
           reports: flake-reports
           report: flake-report.json
   ```

   For Playwright with CI retries, pass `playwright-json: <path>` (and add Playwright's JSON
   reporter) instead of `junit`, `exit-code` and `rerun-command`.
3. **Write `.mission/testing.json`** with the approved patterns and only the smoke tests the
   human kept, and **add `.mission/testing.local.json` to `.gitignore`**.
4. **Commit all of it** on the task branch. Do not push or open a pull request yourself: the
   task's bound workflow opens it with its Pull Request action, or Foreman's wrap-up (its Ship
   it? card, or Straight to PR) does when no workflow is bound. Say in your report what the
   audit found and what the human approved, so the pull request description can carry it.
5. **Set the Command**: call **`set_affected_tests_command`** with the exact approved argv, and
   only when `affected-tests-command` was approved. The tool writes this task's repository's
   `affected-tests` Command and nothing else. It is the only way you change Mission Control's
   settings in this task.

## 4. Verify

Two proofs. Report the first when you report the task complete; the second needs the pull
request, so it comes once Mission Control's publish instruction has opened it:

1. **One local `affected-tests` run.** Run the approved template once in your worktree against a
   small sample of the selection: two or three test files matched by the patterns, preferably
   including one smoke test, with `{files}` replaced by those files and `{junit}` by a temporary
   path. Confirm the command exits and the JUnit file exists and names each test with its file.
   Report the exact command, the exit code, and the test count.
2. **The "Flaky tests" check on the setup pull request's own CI.** After the publish
   instruction opens the pull request, it runs the new CI, so wait for its run
   (`gh pr checks <pr-url> --watch`, or `gh run watch <id> --repo "$repo"` after setting
   `$repo` from origin with `repo=$(git remote get-url origin | sed -E 's#^.*github\.com[:/]##; s#\.git$##')`) and confirm a check named
   **Flaky tests** appears on the pull request's head commit, with conclusion `success` or
   `neutral`. Report its link. If it does not appear, read the publish job's log: a missing
   `checks: write` or `issues: write` (GitHub answers 403), a publish job skipped because a test
   job was cancelled, or a fork pull request with a read-only token are the usual causes. A
   repository whose CI does not publish this check makes the Wait for CI node block with
   `ci_flake_report_missing`; CI that never starts blocks with `ci_missing`, and one still
   running at its limit with `ci_timeout`.

## Stored mode

Use this section, not sections 2 to 4, when the intent says **`Testing setup mode: stored.`** The
repository will not commit a testing file, so its affected-tests gate is configured entirely in
Mission Control: one `affected-tests` Command per app folder, and stored testing settings for
those folders. The rule here: **change no file in the repository and make no commit.** No
`.mission/testing.json`, no `.gitignore` line, no CI edit, no copied report action. Anything you
create while verifying goes in a temporary directory outside the repository.

You do not ask in a decision form. The proposal writes nothing live, and its preview in Library ›
Commands is where the human approves every change: one ask, as in committed mode.

### Audit

Read the repository and record a finding, with its evidence (file and line), for each of these
items from section 1: the test runner and JUnit XML (1), the rerun command template (2),
`.mission/testing.json` (6, only to note that a committed file exists; stored settings overlay it
key by key), the test-file patterns (8), the proposed smoke set (9) and the current
`affected-tests` Commands (10). The intent lists every current Command at the repository root
and in its folders. Skip items 3, 4, 5 and 7: they concern files this mode does not commit.

Then work out the layout, per app:

- **The folders that need their own Command.** In a workspace monorepo (`workspaces` in the root
  `package.json`, `pnpm-workspace.yaml`, a Turbo or Nx layout), each app or package whose tests
  run with its own runner, config or import aliases gets an `affected-tests` Command at its own
  folder. A repository with one runner at the root gets one Command at the root (`""`).
- **Each Command's argv**, run from that folder, with `{files}` as a whole element (the selected
  test files, relative to that folder) and `{junit}` inside one element (where the runner writes
  JUnit XML). Prefer the folder's own test script, and check that it accepts a file list.
- **Each folder's testing settings**: `tests.patterns` and `tests.smokeSet` relative to that
  folder (`src/**/*.test.ts` at `apps/web` means `apps/web/src/**/*.test.ts`), and
  `tests.includeImporters` only when it should differ from the default (on). Count the files each
  pattern matches.

### Propose one Command document

Submit everything with **`propose_command_document`**, as one version 1 document:

```json
{
  "version": 1,
  "commands": {
    "affected-tests": [
      { "path": "apps/web", "argv": ["yarn", "vitest", "run", "--reporter=junit", "--outputFile={junit}", "{files}"] },
      { "path": "apps/admin", "argv": ["env", "JEST_JUNIT_OUTPUT_FILE={junit}", "yarn", "jest", "--reporters=default", "--reporters=jest-junit", "{files}"] }
    ]
  },
  "testing": [
    { "path": "apps/web", "settings": { "tests": { "patterns": ["src/**/*.test.{ts,tsx}"], "smokeSet": ["src/routes.test.ts"] } } },
    { "path": "apps/admin", "settings": { "tests": { "patterns": ["src/**/*.spec.ts"] } } }
  ]
}
```

- `path` is repository-relative, and `""` is the root. Name only folders the main checkout has.
- Use only the `affected-tests` slot under `commands`. The other slots (`test`, `lint`,
  `typecheck`, `build`, `documentation`) are not part of testing setup.
- Under `testing`, set only `tests.patterns`, `tests.smokeSet` and `tests.includeImporters`.
  Never `flakes`: it is refused, because only CI reads it.
- Leave out a Command or setting that is already exactly as proposed. Add a `remove` entry
  (`{ "path": "apps/old", "remove": true }`) only for a row whose folder no longer exists, and say
  why in the report.

A document that breaks a rule (a template without `{files}` or `{junit}`, a path listed twice,
an unknown key) is refused with every problem listed, and nothing is stored. An accepted one is
answered with the preview the human will see: its adds, changes and removals, and any problem
that blocks applying it, such as a folder the main checkout does not have or a slot over its
override cap. Fix every problem and submit again: a newer proposal replaces the pending one, so
the human only ever sees your latest. Never call
`set_affected_tests_command` in this mode (Mission Control refuses it for a stored setup), and
never write a Command or setting any other way.

### Verify

Run each proposed `affected-tests` argv once, in its folder of your worktree, against two or
three test files its patterns match (preferably including one smoke test), with `{files}`
replaced by those paths relative to the folder and `{junit}` by a path in a temporary
directory. Confirm the command exits and the JUnit file exists and names each test with its
file. When the document has more than five Commands, run one per distinct argv shape and list
the folders you did not run. Report each exact command, its exit code and its test count.

There is no pull request and no "Flaky tests" check in this mode. CI flake reporting needs the
report action committed to the repository, so say in the report that it is not set up.

### Report

End with a short report: what the audit found, the folders and their Commands and settings as
proposed, the preview's change summary, the local verification results, and what the human does
next: open the proposal from its banner in Library › Commands (or the attention inbox), review
the preview, and apply or dismiss it. The gate starts running only once it is applied. Mention
the laptop settings below, whether you recommend the **No-Mistakes Review (Affected tests)**
workflow (`builtin-workflow:no-mistakes-review-affected-tests`), and that the committed mode is
the way to get CI flake reporting later.

## Running again later

When `.github/actions/mission-flake-report/` exists and its version is older than this skill's
asset, propose the update as the **only** change: one form with one decision, the version it
moves from and to, then copy both files, commit them for Mission Control to publish as one pull
request, and verify the check again once it is open. When
the versions match and the audit finds nothing else, report that the repository is already set
up and stop.

## Laptop settings

Mention these in your report; you do not change them. **Settings → Workflows → Test checks**
holds `checkTestLease` (one test Check at a time on this machine, on by default) and
`checkTestConcurrency` (the `MISSION_TEST_CONCURRENCY` a test Check's command receives, default
3). A test script that reads `MISSION_TEST_CONCURRENCY` runs lighter under a workflow.

## The report

End with a short report: what the audit found, what was approved and committed, the Command
set, the local verification result, whether you recommend the Affected tests workflow,
and anything left for the human (for example a runner that cannot write JUnit XML yet).
