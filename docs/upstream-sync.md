# Syncing the fork with upstream

This repository is a fork. `ramiro314/mission-control` (`origin`) is upstream
`teamupstart/mission-control` (`upstream`) plus a small, deliberate layer of fork changes. This
runbook is how an agent brings upstream's new commits into the fork. It is the source of truth
for every sync; the plan that set it up is [docs/plans/upstream-sync/plan.md](plans/upstream-sync/plan.md).

What the fork changes, feature by feature, is recorded in the
[fork ledger](fork/ledger.md) ([rendered](fork/ledger.html)). Every sync reads it before
merging (section 2) and updates it afterwards (section 7).

## When a sync runs

A [recurring mission](recurring-missions.md) named **Sync fork with upstream** runs this runbook
weekly, **Mondays at 09:00** in the operator's local time zone (cron `0 9 * * 1`,
`America/Los_Angeles`). It lives on the operator's daemon, not in this repository, so open
**Missions** to see or edit it. Each run files one ordinary backlog task against this repository
whose body tells the agent to follow this runbook and to exit without a branch or PR when upstream
has nothing new (section 1).

| Setting | Value | Why |
| --- | --- | --- |
| Missed runs | Coalesce to latest | A laptop closed for weeks files one catch-up sync, not one per Monday. |
| Overlap | Skip if active | A sync still open, for example a PR waiting for the human to merge, is not stacked on. |
| Agent | Inherit | The `ship` kind's agent in Settings -> Models runs it. |
| After work | None | The runbook already ends at the PR and CI hand-off (section 9). |
| Completion | Complete the task automatically | A "nothing new" run opens no PR, so no merge would ever close its task, and Skip if active would then skip every later Monday. |

A sync can also be started by hand with **Run now** on the mission, or by filing the same task
yourself.

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

## 2. Check the new commits against the fork ledger

Before merging, read what upstream is bringing in and compare it with every **active** entry in
[docs/fork/ledger.md](fork/ledger.md):

```sh
git log --oneline --no-merges origin/main..upstream/main
git diff --stat origin/main...upstream/main
```

For each active entry, check the new commits, their PR titles and any plan docs they add against
the entry's three lists:

- **Behavior contracts**: does an upstream change break or duplicate something the fork promises?
- **Upstream behavior it assumes**: does upstream change a behavior the entry relies on? This is
  the check that catches a design conflict with no textual conflict, as #1148 did for the
  fork's "Complete frees the worktree".
- **Upstream surfaces touched**: does upstream change a module, route, protocol type, database
  column or UI view the entry lists?

Record every hit, and every entry you checked with no hit, for the PR's "Conceptual conflicts"
section (section 9). A hit that would remove or rework a fork feature follows rule 3 of
section 4: stop and `request_input` before acting on it. A hit that needs no change (upstream
touched a surface, the fork's contract still holds) is recorded with the reason.

## 3. Merge, never rebase

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

## 4. Resolve conflicts: upstream wins

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
protocol types, UI views or database columns. The ledger check in section 2 is how that
question gets asked systematically.

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

## 5. Dependencies: upstream's versions plus fork-only entries

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

## 6. Fork-only surface a sync must preserve

These exist only in the fork. A sync keeps them working, and a conflict with one follows rule 3.
The full list, with each feature's contracts and surfaces, is the
[fork ledger](fork/ledger.md); the highlights are:

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
- **The fork-only `package.json` entries** in section 5.
- **Fork-only docs**: this runbook, `.agents/memory/upstream-sync.md`, and the plans under
  `docs/plans/` that upstream does not have.
- **CodeQL advanced setup**: `.github/workflows/codeql.yml` and
  `.github/codeql/codeql-config.yml`, which exclude `e2e/` and `test/` from code scanning so
  upstream's test code is not reported as new at each sync. The repository's CodeQL default
  setup stays disabled. If upstream adds its own CodeQL workflow, the conflict policy applies.

## 7. Update the fork ledger

After the merge commit and any follow-up commits are on the sync branch, and before opening the
PR, update [docs/fork/ledger.md](fork/ledger.md) on the same branch:

1. **Statuses.** An entry upstream replaced becomes `superseded by upstream`, and a fork
   feature the sync removed becomes `removed`, each with the date and the sync PR (for example
   "superseded by upstream #1148, 2026-09-29, sync PR #62"). An entry upstream accepted from
   the fork becomes `upstreamed`. An active entry whose surfaces moved gets its paths corrected.
   The sync PR's number exists only once the PR is open, so fill it in with a follow-up commit
   on the same branch right after opening it.
2. **Status header.** Measure it on the sync branch after the merge, with `HEAD` in place of
   the ledger's `origin/main` (the ledger explains each number):

   ```sh
   git show upstream/main:package.json | grep '"version"'
   git rev-parse --short upstream/main
   git rev-list --count upstream/main..HEAD
   git rev-list --count --no-merges upstream/main..HEAD
   git rev-list --count HEAD..upstream/main
   ```

   Update the synced version and SHA, the sync date, the counts, the SHA they were measured at,
   and the active feature count.
3. **Re-render** `docs/fork/ledger.html` from the updated markdown, as described at the end of
   the ledger. The two must say the same thing.

## 8. Gates

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

When a gate fails, do not fix anything yet. First work out where the failure comes from, with
[When a gate fails: the sync, upstream, or the machine](#when-a-gate-fails-the-sync-upstream-or-the-machine).

## 9. Pull request and CI hand-off

- Push `sync/upstream-<date>` to `origin` and open one PR against the fork's `main`, following
  the `mission-pull-request` skill. List upstream's new PRs, every conflict and how it was
  resolved, anything asked under rule 3, and any deviation from this runbook.
- The PR has a **Conceptual conflicts** section from section 2: one line per active ledger
  entry, naming either the upstream commit that touches its contracts, assumptions or surfaces
  and how that was resolved, or "no hit". It also lists the ledger status changes from
  section 7.
- Wait for the PR's CI to go green and fix what fails.
- **The human merges.** The agent never merges a sync PR.

## When a gate fails: the sync, upstream, or the machine

A gate that fails on the sync branch has one of three causes, and each has a different answer:
the sync broke it, it was already failing on upstream, or the machine is the problem. Decide
which before changing any file. In the first sync (PR #62) this was the most expensive work:

- Two unit files hung and `desktop-startup` timed out only because the machine was at a load
  average near 250. They passed unmodified after a reboot, and the fixes written for them were
  reverted.
- `board-empty-columns` and `workflow-builder-electron` failed on a clean `upstream/main`
  checkout too.
- A quick baseline checkout that shared the branch's `node_modules` produced 35 failures of its
  own, so it could not be trusted.

### First checks

Record the machine load, then rerun the failing file or spec alone:

```sh
uptime
sysctl -n hw.ncpu   # core count on macOS; `nproc` on Linux
node --test --import ./test/setup-state.mjs --import tsx test/<file>.test.ts
npm run test:e2e -- e2e/specs/<spec>.spec.ts
```

A load average above the core count is heavy load. A failure seen only under heavy load is
suspect: do not act on it until it has been rerun on an idle machine. If the load does not come
down (other sessions, a stuck process), ask the human instead of patching the test.

### A clean upstream baseline

If the failure survives the rerun, build a baseline: a separate worktree at `upstream/main`
with its own `npm ci` and its own `npm run build`. Never symlink or copy the sync branch's
`node_modules` or `dist` into it. The baseline is only evidence if nothing in it comes from the
branch under test.

From the sync branch's checkout:

```sh
git fetch upstream
BASELINE=../mission-control-upstream-baseline
git worktree add --detach "$BASELINE" upstream/main
(cd "$BASELINE" && npm ci && npm run build)
```

The sync branch needs its own `npm run build` too, which the gates in section 8 already ran.

### Compare both trees

Run the same test on both trees with repeats, one tree at a time, and record `uptime` before
each run. A single pass or a single failure says nothing about a flake. Two things skew the
comparison if they are skipped:

- **Let the load settle between runs.** The first tree's run raises the load average on its
  own, so wait until `uptime` is back under the core count before starting the second tree.
- **Run the test once in the baseline with its output visible before repeating it.** The first
  run in a fresh worktree does one-time setup (an Electron test downloads the Electron binary),
  and that must not be counted as a failure of the test.

A Playwright spec, run once in the sync branch's checkout and once in `$BASELINE`:

```sh
uptime
npm run test:e2e -- e2e/specs/<spec>.spec.ts --repeat-each=10
```

The last lines of the output give the failure rate: `failed` over `failed` plus `passed`.

A `node --test` file, run once in each tree:

```sh
uptime
fail=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  node --test --import ./test/setup-state.mjs --import tsx test/<file>.test.ts > /dev/null 2>&1 || fail=$((fail + 1))
done
echo "failed $fail/10"
```

Remove the baseline worktree when the comparison is done, and confirm it is gone:

```sh
git worktree remove "$BASELINE"
git worktree list
```

No `--force` is needed: `node_modules`, `dist` and `test-results` are ignored, so the baseline
counts as clean. If git refuses, the baseline holds a tracked change or an untracked file, which
means something edited it; look at that before removing it. Remove only the worktree this
procedure created, and leave any other worktree in the list alone.

### What to do in each case

| Result | Cause | Action |
| --- | --- | --- |
| Fails only on the sync branch | The sync | Fix it in the sync PR, as a follow-up commit on the sync branch (section 3). |
| Fails on both trees | An upstream flake | Do not patch upstream's files unless the fix is small and clearly correct. Record it in the PR's "Known gaps" with both failure rates, and suggest sending it upstream under "Follow-up work". |
| Fails on neither tree once the machine is idle | The machine | Change nothing, and undo any fix already made for it. |

A patch to an upstream-owned file is a deviation from this runbook. It can conflict in the next
sync, so list it in the PR (section 9) along with the failure rates before and after the patch.

### Evidence for the PR

Put in the PR description, under "Evidence" or "Known gaps", for each test that was compared:

- The SHA of each tree (`git rev-parse --short HEAD` in both).
- The exact commands that were run.
- The failure rate on the sync branch and on `upstream/main`, as `failed/runs`.
- The `uptime` line recorded before each run.

## The fork's Release workflow is disabled

`.github/workflows/release.yml` is upstream's release pipeline. It needs Upstart's
`mission-control-release` GitHub App and conventional squash titles, and the fork has neither,
so it failed on every push to the fork's `main`. It is disabled in the fork through GitHub:

```sh
gh workflow disable release.yml -R ramiro314/mission-control
```

The file itself stays byte-identical to upstream's, so it never conflicts in a sync. Do not
edit or delete it, and do not re-enable it.
