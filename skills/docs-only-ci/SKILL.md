---
name: docs-only-ci
description: Install a docs-only CI gate in a GitHub Actions repository - a `changes` job that decides whether a pull request touched only docs paths, the heavy jobs gated on it, and one always-reporting `CI result` check that branch protection can require. Audits read-only, proposes every change in one approval form, applies only what the human approved in one commit (which Mission Control publishes as a pull request), reports which required checks to swap for `CI result` without editing branch protection, and verifies on the setup pull request's own CI. Use when asked to skip, gate or speed up CI for docs-only or Markdown-only pull requests, or to stop a docs change from running the full test suite.
metadata:
  mission:
    category: testing
    enforcement: triggered
---

# Docs-only CI

This installs, in one repository, the gate Mission Control's own CI uses so a pull request that
only edits docs does not pay for the whole suite:

- **`changes`** decides, for a pull request, whether every changed path matches the docs
  patterns, and outputs `docs_only=true|false`. Pushes, tags and manual runs are never docs-only.
- **The heavy jobs** (typecheck, lint, unit, E2E, builds) need `changes` and skip when
  `docs_only` is `true`.
- **`CI result`** needs every job that runs on a pull request, always runs, and passes only when
  each one succeeded or was a gated job skipped on a docs-only run. It is the one check a
  protected branch requires.

A plain `paths-ignore` filter is not used on purpose: a filtered workflow never reports, so a
required check would sit in Pending forever. The gate always reports.

The rule that shapes every step below: **apply only what was approved.** You audit, you ask
once, and you change exactly what the human selected in that one form - nothing else, not even
an obvious fix you noticed on the way.

## The assets

The two step bodies live next to this file and are pasted **verbatim** as the `run:` block of
their step. Resolve this skill's directory (the one holding this `SKILL.md`, following
symlinks) and read them from there:

- `assets/detect-docs-only.sh` - the `Detect docs-only change` step in `changes`.
- `assets/ci-result.sh` - the `CI result` step.

Never edit them. Every input arrives through the step's `env` block, so the script text is the
same in every repository and only `env` differs. Both run under bash 3.2 and under the
`bash -eo pipefail` GitHub Actions uses for `shell: bash`. `ci-result.sh` needs `jq`, which
GitHub-hosted runners ship; on a self-hosted runner, confirm it is installed.

`DOCS_ONLY_PATHS` holds one shell `case` pattern per line. In a `case` pattern `*` matches
across `/`, so `docs/*` covers every depth under `docs/`, and `*.md` means Markdown anywhere.

## 1. Audit

Read the repository; change nothing yet. Record a finding for each item, with the evidence
(file and line) behind it:

1. **CI system.** Only GitHub Actions is supported. If the repository's CI is anything else
   (GitLab CI, CircleCI, Jenkins, Buildkite, Azure Pipelines, ...), stop and report "not
   supported": no form, no commit.
2. **Pull request workflows and their jobs.** Every workflow under `.github/workflows/` that
   triggers on `pull_request`, and each job's id, `name:`, `needs`, `if:` and matrix. Note jobs
   that never run on a pull request (release, deploy, tag-only): they stay out of the gate and
   out of `CI result`'s `needs`, because a job skipped on every pull request would fail it. When
   heavy jobs sit in more than one pull request workflow, the gate goes into the one holding most
   of them, and the others are listed as unchanged.
3. **Docs patterns.** Propose `docs/*` when `docs/` exists, plus what the repository shows: root
   or nested Markdown (`*.md`), a docs site directory (`website/*`, `site/*`, `mkdocs.yml`), and
   nothing that a build, test or package step reads.
4. **What reads the docs.** Tests, scripts or build steps that read files matching the patterns
   (doc-drift tests, link checkers, a docs site build). If any exist, propose a `docs checks` job
   that runs them on every run; if none do, propose none.
5. **Existing path filters.** Any `paths` or `paths-ignore` on a pull request trigger. The gate
   replaces it.
6. **Required checks.** Read them with
   `gh api repos/{owner}/{repo}/branches/{default}/protection/required_status_checks`, and the
   rulesets that apply to the default branch with `gh api repos/{owner}/{repo}/rules/branches/{default}`.
   A 403 or 404 means "could not read branch protection", never "no required checks".
7. **The testing-setup `flake-report` job.** When the repository has one, it is **never gated**:
   Mission Control's Wait for CI needs its "Flaky tests" check on every run, docs-only included,
   and with zero reports it publishes "No flaky tests". Its `if:` must let it run after its test
   jobs were skipped - `!cancelled()` or `always()`. If it has no `if:`, or one without a status
   function (`success()` is then implied, and skipped needs skip it too), propose
   `if: ${{ !cancelled() }}`.
8. **Jobs downstream of a gated job.** A job that needs a gated job is skipped with it unless its
   `if:` uses a status function. Either add it to the gated set or leave it running with
   `!cancelled()`, and say which.
9. **History size.** `changes` checks out with `fetch-depth: 0` so the merge base is reachable.
   On a very large repository, note it; the form can propose fetching only the base and head
   commits instead.
10. **Already installed.** If the workflow already has a `changes` job whose `Detect docs-only
    change` step body equals `assets/detect-docs-only.sh` and a `CI result` step whose body equals
    `assets/ci-result.sh`, and the audit finds nothing else to change, report that the gate is
    installed and stop: no form, no commit. If the bodies differ from the assets, propose
    replacing them as the only change.

## 2. Propose, in one form

Call the Mission Control MCP tool **`request_plan_decisions`** once, with every proposed change.
Never ask in prose, and never split the proposal across several forms. The `plan` markdown
carries the audit findings and the exact workflow edits as a diff; the `decisions` let the human
choose. Every decision allows Other (`allowOther: true`).

The decisions (omit one whose change is not needed, and keep ids stable):

- `docs-patterns`: the proposed `DOCS_ONLY_PATHS`, one pattern per line. Other edits them.
- `gated-jobs`: `multiSelect: true`, one option per heavy job, all recommended. Never offer
  `flake-report`, a `docs checks` job, or `changes`.
- `docs-checks`: whether to add a `docs checks` job, and the command it runs.
- `flake-report-if`: whether to set `flake-report`'s `if:` to `${{ !cancelled() }}`.
- `apply`: apply the workflow edits shown in the plan (yes / no).

A dismissed form, or one where `apply` was declined, means nothing is applied. Report that and
stop.

## 3. Apply only what was approved

Edit the one workflow, in this repository only, adapting job ids and the checkout version to the
repository's own:

```yaml
  changes:
    name: changes
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
    outputs:
      docs_only: ${{ steps.detect.outputs.docs_only }}
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - name: Detect docs-only change
        id: detect
        shell: bash
        env:
          EVENT_NAME: ${{ github.event_name }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          DOCS_ONLY_PATHS: |
            docs/*
        run: |
          <assets/detect-docs-only.sh, verbatim>
```

Each approved gated job adds `changes` to its `needs` and the condition below. An existing `if:`
is kept and joined with `&&`.

```yaml
    needs: [changes, <its existing needs>]
    if: needs.changes.outputs.docs_only != 'true'
```

```yaml
  ci-result:
    name: CI result
    needs: [changes, <every other job that runs on a pull request>]
    if: always()
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions: {}
    steps:
      - name: CI result
        shell: bash
        env:
          NEEDS_JSON: ${{ toJSON(needs) }}
          DOCS_ONLY: ${{ needs.changes.outputs.docs_only }}
          SKIPPABLE: |
            <each approved gated job id, one per line>
        run: |
          <assets/ci-result.sh, verbatim>
```

Then, as approved: add the `docs checks` job (no `changes` need, no gate: it runs on every run),
set `flake-report`'s `if:`, and remove a replaced `paths` or `paths-ignore` filter. `SKIPPABLE`
lists the gated jobs and nothing else; `flake-report`, `docs checks` and `changes` are never in
it.

**Commit all of it** on the task branch, in one commit. Do not push or open a pull request
yourself: the task's bound workflow opens it with its Pull Request action, or Foreman's wrap-up
does when no workflow is bound. Say in your report what the audit found and what the human
approved, so the pull request description can carry it.

## 4. Report required checks

You never edit branch protection or rulesets. When they require a check that a docs-only run
now skips, the report names each one and says to replace it with `CI result`, and so does the
pull request description through your report. When protection could not be read, list every
check name the workflow produces so the operator can compare. Until the swap, a docs-only pull
request in a protected repository waits on a skipped required check.

## 5. Verify

Once Mission Control's publish instruction has opened the setup pull request, wait for its CI
(`gh pr checks <pr> --watch`) and confirm:

- `changes` ran and logged `docs_only=false`: the setup pull request edits a workflow, which is
  not a docs path.
- Every heavy job ran, and `CI result` passed.
- If the repository has `flake-report`, a **Flaky tests** check is on the head commit.

When the operator wants proof of the skip, open a throwaway pull request based on the setup
branch that changes one docs file, confirm `changes` logged `docs_only=true`, the gated jobs
were skipped and `CI result` passed, record its `gh pr checks` output, and close it unmerged.

## The report

End with a short report: what the audit found, what was approved and committed, the required
checks to swap for `CI result` (or that protection could not be read), the verification result,
and anything left for the human.
