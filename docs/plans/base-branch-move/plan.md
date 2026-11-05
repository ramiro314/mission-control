# Moving an in-flight task's base branch after its base merges

Issue [#771](https://github.com/ramiro314/mission-control/issues/771), part of the per-task
base branch feature ([#301](https://github.com/ramiro314/mission-control/issues/301)).

A task stacked on another feature's branch keeps that branch as its base for its whole life.
Once the branch's pull request merges, the task's own merge into the branch it merged into
never counts, its dependents stay blocked, and its diffs, checks, resets and instructions keep
measuring from and naming a branch that may already be gone.

## Decision: an operator action, not an automatic move

Mission Control moves the base only when the operator asks, from the session running the task.
It does not move it on its own when it sees the base branch's pull request merge.

- **A move changes what a reset discards.** After it, the session's reset lands on a different
  branch. Every other change to where a task's checkout points is a person's click; this stays
  one.
- **Automatic detection is a new poller.** The merge watcher reads the pull requests of the
  task's own branch. Watching every in-flight task's base branch for a merge is a second set
  of `gh` calls per tick for an event that happens once per stack.
- **The merge-counting rule is deliberate.** `mergeCounts` refuses a merge into any branch
  other than the base so a task never completes on work that landed elsewhere. A watcher that
  retargeted the base on its own would make that refusal quietly self-healing, and the rule
  would stop meaning anything.

The daemon still decides *where* the base moves, so the operator cannot point a task at an
arbitrary branch from an in-flight state: the target is the branch the base branch's own
pull request merged into, as `gh` reports it. A base whose pull request has not merged is
refused. Automatic moving can be added later on the same server path if stacks become common.

## Behavior

`POST /api/tasks/:id/base-branch/move`, no body, through `TaskManager.moveBaseBranch`.

1. **Who may move.** A task in `running`, `cancelled` or `failed` with a base branch (a
   cancelled or failed task can still be completed by a merge). Refused with 409: a backlog
   task (edit its base branch instead, as today), a `dispatching` or assigning task, a `done`
   task, and a task with no base branch. 404 for an unknown task.
2. **Where to.** `gh pr list --repo <repo> --head <base> --state merged`, run in the task's
   primary repository (`mergedPullRequestForBranch` in `src/server/pr.ts`), newest merged pull
   request first. No merged pull request, or one `gh` reports with no base, is refused. A
   `gh` failure is refused with its reason.
3. **The target must exist.** One `ls-remote` (`resolveBaseBranch`) confirms it and says
   whether it is origin's default, and `fetchOrigin` then refreshes the repository's
   remote-tracking refs so `origin/<target>` carries the base branch's merge before anything
   measures from it. Either failing refuses the move with nothing written.
4. **The write.** `baseBranch` becomes the target **by name, even when it is origin's
   default.** That is the one exception to "origin's default is stored as NULL", and it is
   what makes every reader follow without a change of its own: the merge watcher counts only
   a merge into the target, the Diff view, evidence diff and affected-tests selection measure
   from `merge-base(HEAD, origin/<target>)`, resets land on `origin/<target>`, and the task
   contract, the workflow's pull-request handoff and the Pull Request action name it. A NULL
   would instead let a merge into any branch complete the task. The startup backfill touches
   only backlog tasks, so it leaves a moved in-flight task alone; a moved task that returns to
   the backlog is normalized like any other.
5. **The record.** `Task.baseBranchMove` (`tasks.base_branch_move`, JSON, added in
   `migrate()`): `{ from, to, toDefault, prUrl, movedAt }` for the latest move, `toDefault`
   saying whether the target was origin's default when it moved. NULL on every task that was
   never moved.
6. **The live session is not messaged.** Its pull request, if already open against the old
   branch, is retargeted by GitHub when the old branch is deleted; otherwise the next Pull
   Request action names the new base.

A task without a base branch, and a backlog task, take exactly the paths they take today.

## Dashboard

The session footer (`ActionBar`) shows a **move base** control only when the session's task
has a base branch, is past the backlog and not done, and its base did not already move onto
origin's default (`TaskSummary.baseBranch`, `TaskSummary.baseBranchMove`). Its tooltip names
the current base. A click posts the move; the footer's flash prints "base moved from X to Y"
or the daemon's refusal. After a move onto another non-default branch the control stays,
naming the new base, so a stack of three can be walked down one merge at a time.

## Tests

- `test/task-base-branch-move.test.ts`: the route's refusals (backlog, dispatching, done, no
  base, unknown, no merged pull request, `gh` failure, a merge `gh` names no base for, missing
  target); a successful move storing the target
  by name and the record; after the move, a merge into the target completing the task and
  satisfying its dependent; the Diff view and changed paths measuring from the target after
  the old branch is deleted on origin; reset preview, the contract and the Pull Request
  action naming the target; a backlog task's edit still storing origin's default as null.
- `e2e/specs/task-base-branch-move.spec.ts`: dispatch a task on a base branch, press **move
  base** and read the refusal, then script the fake `gh` to report the base branch's pull
  request merged into `main`, delete the branch on origin, press again, and read the flash, the
  control's disappearance and the stored move.

## Out of scope

Moving attached repositories' bases (they keep their own default), moving the base of a
backlog task through this route, and the automatic move.
