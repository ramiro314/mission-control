# Moving an in-flight task's base branch after its base merges

Issue [#771](https://github.com/ramiro314/mission-control/issues/771), part of the per-task
base branch feature ([#301](https://github.com/ramiro314/mission-control/issues/301)).

A task stacked on another feature's branch keeps that branch as its base. Once the branch's
pull request merges, the task's own merge into the branch it merged into never counts, its
dependents stay blocked, and its diffs, checks, resets and instructions keep measuring from and
naming a branch that may already be gone.

## Decision: both, through one move

PR #780 shipped the automatic half. This plan adds the operator half beside it, on the same
lookup and the same write, and closes two gaps #780 recorded.

- **Automatic** (`moveMergedBaseBranches`, about once a minute): the base is gone from origin
  and `gh` reports a merged pull request from it. That is the state GitHub's delete-on-merge
  leaves, so nobody has to act. A base that still exists is never moved automatically, because a
  long-lived branch such as `release/2.0` merges onward regularly and stays the base.
- **Operator** (`moveBaseBranchNow`, the session footer's **move base**): the same move on
  request. It is the only way to move a base origin still has, for example a stacked pull
  request retargeted by hand with its branch kept, which #780 listed as undetected. A move
  changes where a reset lands, so moving a live branch stays a person's decision, and even then
  only once that base has landed in its target.

Both store the new base as every base write does (origin's default as null) and record it with
#780's `baseBranchMovedFrom`. No reader of `Task.baseBranch` changes.

## Behavior

1. **Who may move.** The sweep moves any candidate `Registry.baseBranchMoveCandidates` lists,
   including a finished dependency source. The operator path uses one shared predicate,
   `baseBranchMoveRefusal` in `src/shared/task.ts`, for both the route and the footer: running,
   cancelled or failed, with a base branch. The daemon adds only "being assigned"
   (`TaskManager.operatorMoveRefusal`). 404 for an unknown task, 409 for a refusal.
2. **Where to.** One lookup, `newestMergedPullRequest` (`gh pr list --head <base> --state
   merged`), returns the newest merged pull request by `mergedAt`, with its base, head commit and
   URL. No merged pull request is a refusal; a `gh` failure, or a newest merge naming no base,
   is a 502.
3. **The merge must be this base's.** `gh` lists by head name, so a reused branch name answers
   with an older pull request. Its head commit must contain the commit the base was taken at
   (`commitCarries`): `Task.baseSha` for the base dispatch started from, or `baseBranchMovedSha`
   for a base an earlier move put there. That second anchor is the fetched tip of the new base
   at the move, which already holds the merge; a squash leaves `baseSha` out of the next
   branch's history, so anchoring every hop on it would strand a squash-merged stack at its
   second move. A head missing locally is fetched by id once, and a failed fetch is a 502, never
   a verdict. Both paths apply this check, which closes #780's reused-name gap.
4. **The base must have landed** (operator only; the sweep's base is gone by definition).
   `branchLandedIn` reads the base's tip from origin: deleted, equal to the merged head (which is
   what vouches for a squash merge), or inside the fetched `origin/<target>` has landed. A tip
   not in the local store after that fetch is outside the target. Anything else is refused ("has
   moved on since ... merged it").
5. **The write.** `TaskManager.moveBaseBranch(id, from, to, movedSha)`, #780's single write,
   re-checks the row synchronously, stores `to` (null for the default), `baseBranchMovedFrom`,
   and `baseBranchMovedSha` (new column `tasks.base_branch_moved_sha`, schema version 20). An
   edit of a backlog task's base clears both records.
6. **Chains.** The sweep follows a merged-and-deleted chain up to five branches. The operator
   follows one merge; a target origin no longer has is refused with the reason.
7. **The live session is not messaged.** The next Pull Request action names the new base.

## Dashboard

The session footer (`ActionBar`) shows **move base** exactly when `movableBaseBranch` allows,
which is `baseBranchMoveRefusal` plus the task's base from `TaskSummary.baseBranch`. A click
posts the move; the flash prints "base moved from X to Y" from the reply's
`baseBranchMovedFrom` and `movedTo` (the target's name, even when the task stores null), or the
daemon's refusal. A move onto origin's default leaves no base, so the control disappears; a
move onto another branch keeps it, so a stack is walked down one merge at a time.

## Tests

- `test/task-base-branch-move.test.ts` (#780's sweep, extended): newest-merge parsing; a reused
  name, a task with no start commit and a failed check move nothing; a second hop is checked
  against `baseBranchMovedSha` and records the new tip.
- `test/task-base-branch-move-operator.test.ts`: the operator route and its refusals; a move
  onto the default and onto another branch; cancelled and failed tasks; newest merge wins; a
  failed fetch; a kept base that landed, squash-vouched or not, and one that moved on; a reused
  name, an unfetchable head and a missing start commit; a squash-merged stack walked down in two
  moves; `commitCarries` with a failing `git`; the footer offering exactly what the route allows.
- `e2e/specs/task-base-branch-move.spec.ts`: refusal then a move onto `main` hiding the control,
  a move onto `feat/mid` keeping it, and a restacked task offered the move again.

## Out of scope

Moving attached repositories' bases (they keep their own default), and telling a running agent
its base moved.
