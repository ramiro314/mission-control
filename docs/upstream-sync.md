# Syncing the fork with upstream

This repository is a fork. `ramiro314/mission-control` (`origin`) is upstream
`teamupstart/mission-control` (`upstream`) plus a small, deliberate layer of fork changes. This
runbook is how an agent brings upstream's new commits into the fork. It is the source of truth
for every sync; the plan that set it up is [docs/plans/upstream-sync/plan.md](plans/upstream-sync/plan.md).

## Remotes

| Remote | Repository | Role |
| --- | --- | --- |
| `origin` | `https://github.com/ramiro314/mission-control.git` | The fork. Sync PRs land on its `main`. |
| `upstream` | `https://github.com/teamupstart/mission-control.git` | The original. Read only: never push to it. |

Add `upstream` if a checkout lacks it:

```sh
git remote add upstream https://github.com/teamupstart/mission-control.git
```

## 1. Check for anything new

```sh
git fetch origin
git fetch upstream
git rev-list --count origin/main..upstream/main
```

If the count is `0`, upstream has nothing the fork lacks. Stop here: no branch, no PR. Report
that the fork is already current and end the task.

## 2. Merge, never rebase

Every sync is a merge commit on a fresh branch off `origin/main`, landed by pull request:

```sh
git switch -c sync/upstream-$(date +%F) origin/main
git merge --no-ff upstream/main
```

- Never rebase the fork onto upstream, and never force-push. Upstream's SHAs are kept, so
  `git merge-base --is-ancestor upstream/main HEAD` holds after the merge and the next sync
  only sees newer commits.
- The merge commit is the whole sync. Follow-up commits on the same branch carry any removal
  or repair the merge needs, each with its own message.

## 3. Resolve conflicts: upstream wins

The conflict policy for every sync:

1. **Upstream wins.** Take upstream's side of a textual conflict first.
2. **Re-apply a fork change on top of upstream** when it still makes sense against upstream's
   new code. Keep the re-application as small as the fork change was.
3. **Ask before removing or reworking a fork feature.** If upstream's change makes a fork
   feature redundant, contradictory, or impossible to keep as it is, stop and call
   `request_input` with the conflict, the options, and a recommendation. Do not delete or
   redesign a fork feature on your own. A conflict the approved sync plan already resolves
   does not need to be asked again.

Also look for **design conflicts** that merge cleanly as text. A file can merge without markers
and still carry two behaviors for the same control. Read upstream's new commits, their PR
titles and any plan docs they add, and ask whether a fork feature touches the same routes,
protocol types, UI views or database columns.

### Worked example: Complete and the worktree (sync of 2026-09-29)

Fork PR #17 made freeing a task's worktree on **Complete** an opt-in checkbox, with a safety
preview at `GET /api/tasks/:id/free-preview`. Upstream #1148 made Complete always reset and
return task-owned worktrees, and added a safe automatic return after Kill.

- Text conflicts: `src/server/routes.ts` (the complete handler), `docs/dispatch-and-backlog.md`
  and `docs/worktrees-and-checks.md`. Each took upstream's side.
- Design conflict: `CompleteModal.tsx`, `App.tsx`, `api.ts`, `protocol.ts`, `tasks.ts` and
  `actions.ts` merged cleanly as text but would have shipped both behaviors. The human decided
  to adopt upstream's, so the sync removed the rest of #17: the checkbox, the preview route,
  the `freeWorktree` request field, `TaskFreePreview`, `worktreeFreeability`, their tests, e2e
  spec and route-surface entry. The removal was checked with this search, which returns
  nothing (it skips plan history and this page, which name the symbols on purpose):
  `git grep -e free-preview -e freeWorktree -e TaskFreePreview -e worktreeFreeability -- . ':!docs/plans' ':!docs/upstream-sync.md'`
- Because removing #17 was a decision about a fork feature, it was asked first and recorded in
  the plan (decision D1), which is exactly what rule 3 requires.

## 4. Dependencies: upstream's versions plus fork-only entries

Every dependency takes upstream's version. The fork adds entries but never moves a version
upstream already pins. The fork's `package.json` differs from upstream's only by:

| Entry | Why the fork has it |
| --- | --- |
| `scripts.test` (routes through `test:run`) | Flake-aware testing: one JUnit-capable test invocation. |
| `scripts["test:run"]` | Flake-aware testing: the shared `node --test` invocation with optional JUnit output. |
| `scripts["build:flake-report-action"]` | Regenerates `.github/actions/mission-flake-report/`. |
| `devDependencies.esbuild` | Used by `scripts/build-flake-report-action.ts`; pinned to the version upstream's lockfile already resolves. |

When `package.json` or `package-lock.json` conflicts, do not resolve it hunk by hunk:

```sh
git show upstream/main:package.json > package.json
# re-add only the fork-only entries in the table above
git show upstream/main:package-lock.json > package-lock.json
npm install
git diff upstream/main -- package.json package-lock.json
```

The final diff must show only the fork-only entries. Bumping a dependency is upstream's job;
the fork has no Dependabot and takes new versions through this sync.

## 5. Fork-only surface a sync must preserve

These exist only in the fork. A sync keeps them working, and a conflict with one follows rule 3:

- **Flake-aware testing and its report action**: `.github/actions/mission-flake-report/`,
  the fork's changes to `.github/workflows/ci.yml` and `.github/actions/run-unit-shard/`,
  `skills/testing-setup/` (with its copy of the action), `skills/deflake/`, the
  `set_affected_tests_command` MCP tool and `src/server/testing-setup.ts`.
- **Shape tasks**: the `shape` task kind, **Shape this**, `src/server/plans/shape.ts`, and
  `skills/grill/`.
- **Tickets**: `skills/tickets/`, ticket creation and adoption through `create_task`, and
  mirroring a shape task's tickets to a task source.
- **Wait for CI**: the workflow block that waits for pull-request CI and reads flakes in the
  Inspector (`src/shared/wait-for-ci.ts`).
- **The fork-only `package.json` entries** in section 4.
- **Fork-only docs**: this runbook, `.agents/memory/upstream-sync.md`, and the plans under
  `docs/plans/` that upstream does not have.

## 6. Gates

Run every gate locally before opening the PR. `npm run smoke` and `npm run test:e2e` need
`npm run build` first.

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

Also record for the PR:

```sh
git merge-base --is-ancestor upstream/main HEAD && echo "upstream/main is an ancestor"
git diff upstream/main -- package.json
```

## 7. Pull request and CI hand-off

- Push `sync/upstream-<date>` to `origin` and open one PR against the fork's `main`, following
  the `mission-pull-request` skill. List upstream's new PRs, every conflict and how it was
  resolved, anything asked under rule 3, and any deviation from this runbook.
- Wait for the PR's CI to go green and fix what fails.
- **The human merges.** The agent never merges a sync PR.

## The fork's Release workflow is disabled

`.github/workflows/release.yml` is upstream's release pipeline. It needs Upstart's
`mission-control-release` GitHub App and conventional squash titles, and the fork has neither,
so it failed on every push to the fork's `main`. It is disabled in the fork through GitHub:

```sh
gh workflow disable release.yml -R ramiro314/mission-control
```

The file itself stays byte-identical to upstream's, so it never conflicts in a sync. Do not
edit or delete it, and do not re-enable it.
