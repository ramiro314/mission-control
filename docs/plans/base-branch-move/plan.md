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
4. **The base must have landed.** A merged pull request with the base's name is not enough:
   a long-lived `develop` that once merged into `main`, or a reused feature branch name, carries
   old merged pull requests while it still has work of its own. Two checks follow the fetch.
   First, the pull request must be the merge of the branch this task was stacked on: its head
   commit (`headRefOid`) has to carry `Task.baseSha`, the commit dispatch started the task from
   (`commitCarries`; a head missing locally is fetched by id once). An older pull request on a
   reused name predates that commit, and a task that recorded no start commit cannot be
   confirmed, so both are refused. Second, `branchLandedIn` asks origin for the base's tip
   again. A deleted branch, a tip equal to the merged pull request's head commit (which is
   what vouches for a squash merge), or a tip already in `origin/<target>` has landed; anything
   else is refused ("has moved on since ... merged it"). Every refusal writes nothing.
5. **The write.** `baseBranch` becomes the target **by name, even when it is origin's
   default.** That is the one exception to "origin's default is stored as NULL", and it is
   what makes every reader follow without a change of its own: the merge watcher counts only
   a merge into the target, the Diff view, evidence diff and affected-tests selection measure
   from `merge-base(HEAD, origin/<target>)`, resets land on `origin/<target>`, and the task
   contract, the workflow's pull-request handoff and the Pull Request action name it. A NULL
   would instead let a merge into any branch complete the task. The startup backfill touches
   only backlog tasks, so it leaves a moved in-flight task alone; a moved task that returns to
   the backlog is normalized like any other.
6. **The record.** `Task.baseBranchMove` (`tasks.base_branch_move`, JSON, added in
   `migrate()`): `{ from, to, toDefault, prUrl, movedAt }` for the latest move, `toDefault`
   saying whether the target was origin's default when it moved. NULL on every task that was
   never moved.
7. **The live session is not messaged.** Its pull request, if already open against the old
   branch, is retargeted by GitHub when the old branch is deleted; otherwise the next Pull
   Request action names the new base.

A task without a base branch, and a backlog task, take exactly the paths they take today.

## Dashboard

The session footer (`ActionBar`) shows a **move base** control only when the session's task
has a base branch, is past the backlog and not done, and that base is not itself the target
of a move onto origin's default (`movableBaseBranch` in `src/shared/task.ts`, reading
`TaskSummary.baseBranch` and `TaskSummary.baseBranchMove`). The record is the latest move and
survives a return to the backlog, so it hides the control only while it describes the base the
task has now: a task moved onto `main`, sent back and stacked on a new branch is offered the
move again. Its tooltip names
the current base. A click posts the move; the footer's flash prints "base moved from X to Y"
or the daemon's refusal. After a move onto another non-default branch the control stays,
naming the new base, so a stack of three can be walked down one merge at a time.

## Tests

- `test/task-base-branch-move.test.ts`: the route's refusals (backlog, dispatching, done, no
  base, unknown, no merged pull request, `gh` failure, a merge `gh` names no base for, missing
  target, a failed origin fetch, a base still on origin with work newer than its merged pull
  request, a base deleted unmerged beside an older same-named merged pull request, a head that
  cannot be found, a task with no recorded start commit); a base still on origin moving when its tip is in the target or is a squash-merged
  pull request's head; the footer's offer for the current base, not a stale record; a successful move storing the target by name and the record,
  onto origin's default and onto another branch (`toDefault` false), from a running, cancelled
  or failed task, and to the newest of several merged pull requests; after the move, a merge
  into the target completing the task and satisfying its dependent; the Diff view and changed
  paths measuring from the target after the old branch is deleted on origin; reset preview,
  the contract and the Pull Request action naming the target; a backlog task's edit still
  storing origin's default as null.
- `e2e/specs/task-base-branch-move.spec.ts`: dispatch a task on a base branch, press **move
  base** and read the refusal, then script the fake `gh` to report the base branch's pull
  request merged into `main`, delete the branch on origin, press again, and read the flash, the
  control's disappearance and the stored move; and a move onto a non-default branch, after
  which the control stays and names the new base; and a task moved onto `main`, sent back,
  restacked and dispatched again, which is offered the move again.

## Out of scope

Moving attached repositories' bases (they keep their own default), moving the base of a
backlog task through this route, and the automatic move.
