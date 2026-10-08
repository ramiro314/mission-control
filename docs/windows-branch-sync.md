# Syncing `release/windows` with `main`

Windows support is built on the long-lived `release/windows` branch, and `main` keeps moving
underneath it: upstream syncs, neutral seams, fork features. This runbook is how an agent brings
`main`'s new commits into `release/windows`. It is the source of truth for every such sync; the
plan behind it is [docs/plans/windows-support/plan.md](plans/windows-support/plan.md), "Weekly
sync (D5, D26, D27, D28)". It has the same shape as the
[upstream-sync runbook](upstream-sync.md), one level down: `main` plays upstream's part, and
`release/windows` plays the fork's.

This file lives on `main`. A sync task's worktree starts from `release/windows`, which only has
the copy its last sync brought in, so read the current one from `main`:

```sh
git fetch origin
git show origin/main:docs/windows-branch-sync.md
```

## When a sync runs

A [recurring mission](recurring-missions.md) named **Sync main into release/windows** runs this
runbook weekly, **Tuesdays at 09:00** (cron `0 9 * * 2`, `America/Los_Angeles`), the day after
the Monday upstream sync, so upstream's changes reach `release/windows` within a day. It lives on
the operator's daemon, not in this repository, so open **Missions** to see or edit it. Each run
files one ordinary backlog task against this repository whose body tells the agent to follow
this runbook and to exit without a branch or PR when `main` has nothing new (section 1).

| Setting | Value | Why |
| --- | --- | --- |
| Base branch | `release/windows` | Every task the mission files starts its worktree from `origin/release/windows`, opens its PR against it, diffs its checks against it, and is closed by the merge watcher when that PR merges into it (see [start a task from another branch](dispatch-and-backlog.md#start-a-task-from-another-branch)). |
| Missed runs | Coalesce to latest | A laptop closed for weeks files one catch-up sync, not one per Tuesday. |
| Overlap | Skip if active | A sync still open, for example a PR waiting for the human to merge, is not stacked on. |
| Agent | Inherit | The `ship` kind's agent in Settings -> Models runs it. |
| After work | None | The runbook already ends at the PR and CI hand-off (section 5). |
| Completion | Complete the task automatically | A "nothing new" run opens no PR, so no merge would ever close its task, and Skip if active would then skip every later Tuesday. |

A sync can also be started by hand with **Run now** on the mission, or by filing the same task
yourself with base branch `release/windows`.

## 1. Check for anything new

```sh
git fetch origin
git rev-list --count origin/release/windows..origin/main
```

If the count is `0`, `release/windows` already has every commit on `main`. Stop here: no branch,
no PR. Report that `release/windows` is already current and end the task.

Otherwise, read what `main` is bringing in, and what `release/windows` carries that `main` does
not. The second list is the Windows work a conflict must not lose (section 3):

```sh
git log --oneline --no-merges origin/release/windows..origin/main
git diff --stat origin/release/windows...origin/main
git diff --stat origin/main...origin/release/windows
```

## 2. Merge, never rebase

Every sync is a merge commit on a fresh branch off `origin/release/windows`, landed by pull
request:

```sh
git switch -c sync/windows-$(date +%F) origin/release/windows
git merge --no-ff origin/main
```

- Never rebase `release/windows` onto `main`, and never force-push either branch. `main`'s SHAs
  are kept, so `git merge-base --is-ancestor origin/main HEAD` holds after the merge and the
  next sync only sees newer commits.
- The merge commit is the whole sync. Follow-up commits on the same branch carry any re-applied
  Windows change or repair the merge needs, each with its own message.
- The task's worktree may sit on a branch Mission Control named for it. Create the
  `sync/windows-<YYYY-MM-DD>` branch from `origin/release/windows` as above and work there.

## 3. Resolve conflicts: `main` wins, Windows is re-applied

The conflict policy for every sync (plan decision D27):

1. **`main` wins on shared code.** Take `main`'s side of a textual conflict first. Shared code is
   anything both branches have: the seams, their POSIX implementations, routes, the UI, tests
   and docs.
2. **Re-apply the Windows change on top of `main`.** A win32 implementation, a win32 entry in a
   seam's platform map, a Windows CI job or skip guard, a Setup check, or Windows docs is
   re-applied against `main`'s new code, kept as small as it was. Use
   `git diff origin/main...origin/release/windows -- <file>` to see exactly what the Windows side
   changed in a conflicted file.
3. **Ask before dropping any Windows change.** If `main`'s change makes a Windows change
   redundant, contradictory, or impossible to keep as it is, stop and call `request_input` with
   the conflict, the options, and a recommendation. Do not delete or redesign a Windows change on
   your own.

Record the conflicted files before resolving them, for section 4 and the PR:

```sh
git diff --name-only --diff-filter=U
```

Also look for **design conflicts** that merge cleanly as text. A seam on `main` can gain a new
call site, a new function or a changed signature that the branch's win32 implementation does
not cover yet. Check every commit from section 1 that touches a seam or its platform map:
`src/server/process-inspection/`, `src/server/platform/`, `scripts/native-addon-sources.mjs`,
and the call sites listed under "Upstream surfaces touched" in the `fork:windows-support`
tracking issue (`node scripts/fork-delta.mjs show windows-support`), together with
`docs/plans/windows-support/merge-delta.md` on this branch when it changes that section. A new direct `ps`, `lsof`, `process.kill(-pid)`, `detached: true` spawn or
login-shell PATH read on `main` belongs behind the seam; route it through the seam on this
branch and note it in the PR.

### The deleted fork ledger

`main` no longer has `docs/fork/ledger.md` or `docs/fork/ledger.html`: the fork's features moved
to GitHub tracking issues ([docs/fork/README.md](fork/README.md)). The first sync after that
change meets a modify/delete conflict on both files wherever `release/windows` edited them.
**`main`'s deletion wins**, but the branch's Windows support entry is kept, not dropped, so rule
3 does not apply:

1. Before resolving, copy the branch's "Windows support" entry out of
   `git show origin/release/windows:docs/fork/ledger.md` into
   `docs/plans/windows-support/merge-delta.md`, rewritten in the "Fork feature changes" format:
   a `### fork:windows-support` block with one `####` block per issue section the branch
   changed, each carrying the full new text. Compare against
   `node scripts/fork-delta.mjs show windows-support` and keep only the sections that differ.
2. Resolve the conflict by deleting both files: `git rm docs/fork/ledger.md docs/fork/ledger.html`.
3. Say so in the PR, as a conflict resolved by this rule.

### Dependencies

`package.json` and `package-lock.json` take `main`'s versions; `release/windows` may add entries
but never moves a version `main` pins. On a conflict, do not resolve hunk by hunk:

```sh
git diff origin/main...origin/release/windows -- package.json   # the Windows-only entries
git show origin/main:package.json > package.json
# re-add only the Windows-only entries shown above
git show origin/main:package-lock.json > package-lock.json
npm install
git diff origin/main -- package.json package-lock.json
```

The final diff must show only the Windows-only entries.

## 4. Focused tests

Run the tests for the areas that conflicted or that section 3 changed, not the whole suite: CI
runs the whole suite, plus the Windows jobs, on the PR. For each such area, run its test files
one at a time:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/<file>.test.ts
```

Then the cheap whole-repo gates:

```sh
npm run typecheck
npm run lint
```

A merge with no conflicts and no section 3 changes still runs typecheck and lint. When a
focused test fails, work out whether the sync, `main`, or the machine caused it before changing
anything, as [the upstream-sync runbook](upstream-sync.md#when-a-gate-fails-the-sync-upstream-or-the-machine)
describes, with `origin/main` as the baseline in place of `upstream/main`.

Also record for the PR:

```sh
git merge-base --is-ancestor origin/main HEAD && echo "origin/main is an ancestor"
git diff origin/main -- package.json
```

## 5. Pull request and CI hand-off

- Push `sync/windows-<YYYY-MM-DD>` to `origin` and open one PR **into `release/windows`**,
  following the `mission-pull-request` skill. The task already carries base branch
  `release/windows`, so Mission Control's PR path targets it; a PR opened by hand passes
  `--base release/windows`. List `main`'s new commits, every conflict and how it was resolved,
  every Windows change that was re-applied, anything asked under rule 3, the focused tests that
  ran, and any deviation from this runbook.
- Wait for the PR's CI to go green and fix what fails. PRs into `release/windows` get the Linux
  jobs and the branch's own Windows jobs.
- **The human merges, with "Create a merge commit".** Never squash or rebase a sync PR: either
  one rewrites `main`'s commits, so they never become ancestors of `release/windows`, and every
  later sync conflicts on the same lines again. The agent never merges a sync PR.

## Fork feature tracking on this branch

Windows support is one fork feature, tracked by the open `fork:windows-support` issue labeled
`fork-status:in-progress` ([docs/fork/README.md](fork/README.md)). Only PRs merged into `main`
change that issue, so work on `release/windows` reaches it once, through the merge PR:

- **Every PR into `release/windows` carries the `fork:windows-support` label**, sync PRs
  included. The status snapshot counts those PRs on the merge PR's row and never lists them as
  `main` changes.
- **Never edit `docs/fork/` on this branch**, and never edit the tracking issue from it.
- **A PR that changes a Windows contract, assumption or surface updates
  `docs/plans/windows-support/merge-delta.md`** in the same PR, in the "Fork feature changes"
  format, as the full replacement text of each issue section it changes. The file lives only in
  this branch's plan folder, so it never conflicts with `main`.
- **At the merge into `main`**, the "feat: Windows support" PR carries `fork:windows-support`,
  and its "Fork feature changes" section is `merge-delta.md`'s content, each block's `base:`
  line taken then with `node scripts/fork-delta.mjs base windows-support "<section>"`, plus a
  `#### Status` block saying `active`. The refresh applies it after the human merges, which
  clears `fork-status:in-progress`.

A sync whose re-applied Windows change (section 3) moves a surface updates `merge-delta.md` too.
