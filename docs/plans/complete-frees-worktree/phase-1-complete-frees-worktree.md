# Phase 1: Complete frees the task's worktree

**Source plan:** [`plan.md`](./plan.md) · **Index:** [`phased-plan.md`](./phased-plan.md)\
**Dependencies:** none (the only phase). Released when the planning pull request that
publishes these files merges.

## 1. Outcome

The Complete dialog offers **"Free this task's worktree"** ("worktrees" for a multi-repo task),
with **"Also closes this task's terminal"** under it. It is checked by default when freeing is
provably safe. Confirming with it checked records `done` and then runs the existing Clean up
(`TaskManager.reclaim`) in the same request, so the task's pool slot returns to `available` and
any `git` fallback worktree is removed. This fixes the everyday build-up of leased slots held by
finished tasks.

## 2. Entry criteria

- The approved plan and this file are on the default branch.
- No schema migration is needed; nothing below adds persisted state.

## 3. Scope and non-goals

**In scope:**

- A path-level "would this lose work" Git check shared with reset.
- A task-level freeability read.
- The preview route.
- The `freeWorktree` option on the complete route.
- Client API additions.
- The `CompleteModal` checkbox.
- Docs.
- Unit tests and an e2e spec.

**Non-goals** (from the plan):

- Freeing on automatic completions (merge, pipeline, mission, retro no-change).
- Changing the 30-day retention.
- Foreman or MCP use of the option.
- A new "free" action elsewhere.
- Remembering the checkbox state.

## 4. Repository findings and inherited contracts

- **Complete route** (`src/server/routes.ts:8121`) parses `CompleteTaskSchema`
  (`src/shared/protocol.ts:1311`), awaits `tasks.complete(...)`, and returns **the task object
  itself** (`c.json(t)`). It does not kill the session: `CompleteModal.tsx:118-145` calls
  `api.completeTask` and then `api.kill(session.id)` from the browser, in that order, so a failed
  kill never loses the outcome.
- **`TaskManager.reclaim(id)`** (`src/server/tasks.ts:5729`):
  - takes the cleanup reservation, and refuses with "already being cleaned up" when one is held;
  - stops the launched agent (`quiesceLaunchedAgentBeforeCapture`);
  - settles archives;
  - runs provider-aware `teardownWorktree`;
  - clears the home and `sessionId`;
  - returns `Ok`.
  It never changes the status, and it handles native, `git` and multi-repo trees and partial
  release. This is the Clean up the plan reuses; do not write a second teardown path.
- **`resetWouldDestroyWork(session)`** (`src/server/actions.ts:2417`) reads
  `git status --porcelain` and `git rev-list --count HEAD --not --remotes=origin` from
  `session.cwd`. It is session-shaped, but the checks are purely per path.
- **`TaskManager.mergedPrFor(taskId)`** (`tasks.ts:1959`) is **private**. It reads current and
  historical work-episode bindings for a merged PR and returns only the URL. The same bindings
  (`taskWorkEpisodeForTask`, `historicalTaskWorkEpisodeBindingsForTask`) also carry
  `pr_head_sha` and `merged_at`, which is what scoping the excuse to specific commits needs.
- **Task shape:**
  - `worktreePath`, `provider` and `worktreeLeaseId` describe the primary checkout;
  - `extraRepos[]` carries the same for attached repositories;
  - `pipelineProvider` is set on pipeline tasks;
  - an assigned task has `worktreePath: null`.
- **`CompleteTaskResult`** (`src/web/lib/api.ts:236`) extends `ActionResult`.
- **The dialog opens from** `App.tsx:4298` (footer and Kill's "complete instead") and from
  `ConversationTerminal.tsx`. Both render the same `CompleteModal`.
- **e2e patterns to follow:**
  - `e2e/specs/board-card-worktree.spec.ts` for a task with a worktree;
  - `e2e/specs/conversation-terminal-view.spec.ts` for session views;
  - `e2e/README.md` for fixtures;
  - `e2e/fixtures/modal-inset.ts` for `expectContentClearsBorder`.

## 5. Implementation steps (in order)

1. **Shared Git check.** In `src/server/actions.ts`, extract the body of `resetWouldDestroyWork`
   into an exported `checkoutWouldLoseWork(path, { excuseLocalCommits })`. It returns
   `{ uncommitted: number, localOnlyCommits: number, reason: string | null }`, or an
   "unreadable" reason when Git fails. `resetWouldDestroyWork` becomes a thin wrapper, and its
   strings and behaviour must stay identical because the reset preview relies on them.
2. **Task freeability.** Add to `TaskManager` a public
   `async worktreeFreeability(id): Promise<{ applicable: boolean; freeable: boolean; reasons: string[] }>`.
   - `applicable` is false when the task has no `worktreePath` and no `extraRepos[].worktreePath`,
     or has `pipelineProvider`.
   - Run the check for every checkout, prefixing each reason with the repository name for
     multi-repo tasks.
   - Local-only commits are excused only when a merged binding's recorded `prHeadSha` (read
     from the same bindings as `mergedPrFor`) equals the checkout's HEAD or has HEAD as an
     ancestor: `git merge-base --is-ancestor HEAD <prHeadSha>` exits 0. A commit made after the
     merged head is therefore never excused. A missing `prHeadSha`, or a SHA Git cannot find
     locally, means not excused. Pass the candidate SHAs into the path-level check rather than a
     boolean. Uncommitted or untracked files are never excused.
   - Any unreadable checkout means not freeable, with that reason.
   - Living inside `TaskManager` keeps the binding reads private.
3. **Preview route.** Add `GET /api/tasks/:id/free-preview` in `routes.ts` beside the other
   task routes. It returns the freeability, or 404 for an unknown task. It is read-only.
4. **Wire contract.**
   - Extend `CompleteTaskSchema` with `freeWorktree: z.enum(["ifSafe", "discardWork"]).optional()`.
   - Extend the complete route's success body additively to `{ ...task, freed?: boolean, freeError?: string }`.
   - When the option is absent, the response must be byte-identical to today's.
5. **Reclaim guard and complete route.**
   - Give `reclaim` an optional second argument, `{ beforeTeardown?: () => Promise<string | null> }`.
     `reclaimReserved` calls it **after** `quiesceLaunchedAgentBeforeCapture` and
     `settleArchivesBeforeTeardown`, immediately before `teardownWorktree`, all under the same
     cleanup reservation. A non-null result skips teardown and returns
     `{ ok: false, error: "worktree kept: " + reason }`, leaving every resource recorded. The
     agent stays stopped, which is what Complete does anyway. Existing callers pass nothing and
     behave exactly as before.
   - Why here: the agent is still running until reclaim stops it, so a check made before
     `reclaim` would miss anything the agent writes in between. Only a check after the stop
     sees the final tree.
   - After `tasks.complete(...)` succeeds and the option is present:
     - Not applicable (from `worktreeFreeability`): return `freed: false` with no error.
     - `ifSafe`: `await tasks.reclaim(id, { beforeTeardown })`, where the guard re-runs
       `worktreeFreeability(id)` and returns its reasons when not freeable.
     - `discardWork`: `await tasks.reclaim(id)` with no guard.
   - A reclaim returning `{ ok: false }` becomes `freeError`.
   - The status stays `done` in every branch. Re-read the task after reclaim so the returned row
     shows the released resources.
6. **Client API.**
   - `api.completeTask` in `src/web/lib/api.ts` gains a trailing optional `freeWorktree` and
     spreads it only when set, like `satisfyDependents`.
   - `CompleteTaskResult` gains `freed?` and `freeError?`.
   - Add `api.taskFreePreview(id)` via `fetchJson`.
7. **Dialog.** In `src/web/components/CompleteModal.tsx`:
   - On open, when `task` exists, fetch the preview. While it is pending, show a disabled checkbox
     labelled "checking…".
   - Render nothing when the preview is not applicable or failed to load. A failed preview must not
     block completing.
   - Label the checkbox "Free this task's worktree" (plural when `extraRepos` has entries), with the
     note "Also closes this task's terminal".
   - Initial state is `freeable`. When the task is not freeable, list the reasons under the box.
   - On confirm:
     - checked: send `freeWorktree` = `ifSafe` if the preview was freeable, otherwise
       `discardWork`, and **do not** call `api.kill` (reclaim stops the agent).
       - If `freeError` comes back, keep the dialog open and show "Task completed, but the
         worktree could not be freed: <freeError>" in the existing error slot.
       - Otherwise close and flash "Task completed · worktree freed".
     - unchecked: keep today's complete-then-kill exactly.
   - Follow the modal inset rule in `AGENTS.md`: no horizontal padding on the new row.
8. **Docs.**
   - In `docs/dispatch-and-backlog.md`, near "When a task's agent goes away", describe the
     checkbox, the safety rule (uncommitted files never excused; local commits excused by a merged
     PR), and that it closes the task's terminal.
   - In `docs/worktrees-and-checks.md` "Task worktree retention", add one sentence pointing at it
     as the immediate alternative to waiting 30 days.

## 6. API and compatibility

- **Additive only.** Omitting `freeWorktree` must leave today's behaviour and response unchanged
  for every existing caller (tours, ensembles, Foreman, MCP retro). The preview route is new and
  read-only.
- **No persistence changes, no migration.**
- **`resetWouldDestroyWork` keeps its signature and messages.**

## 7. Tests and verification

**`test/`** (`node:test`), in a new `test/complete-frees-worktree.test.ts` or next to existing
reclaim and complete tests. Use real temporary Git repositories as the existing
reset and worktree tests do.

- **Git check:**
  - a clean, pushed checkout loses nothing;
  - uncommitted and untracked files are counted;
  - a local-only commit is counted;
  - a local-only commit is excused when excusing is on;
  - an unreadable path yields a reason;
  - `resetWouldDestroyWork` output is unchanged.
- **Freeability:**
  - an assigned task and a pipeline task are not applicable;
  - a clean single-repo task is freeable;
  - a dirty task is not freeable, even with a merged PR;
  - a local-only commit that is the merged PR's recorded head, or an ancestor of it, is freeable;
  - a local-only commit made after the merged PR's head is not freeable, even though a PR merged;
  - a merged binding with no `prHeadSha` excuses nothing;
  - a multi-repo task with one dirty checkout is not freeable, with a repo-prefixed reason.
- **Route:**
  - no option gives an unchanged body;
  - `ifSafe` on a safe task gives `done`, `freed: true`, and worktree fields cleared;
  - `ifSafe` on a dirty task gives `done`, `freed: false`, `freeError`, and the tree still recorded;
  - `ifSafe` where the tree becomes dirty after the preview but before the agent stop (simulate
    with a quiesce seam that writes a file) keeps the tree, because the guard runs after the stop;
  - `reclaim` with no guard is unchanged (existing reclaim tests keep passing);
  - `discardWork` on a dirty task gives `freed: true`;
  - a reclaim refusal (reservation held) gives `done` plus `freeError`.

**`e2e/`**: a new spec `e2e/specs/complete-frees-worktree.spec.ts`, using the fake agents only
(never spend tokens) and selecting by role and label (no `data-testid`).

- Dispatch a task. Open Complete. The checkbox "Free this task's worktree" is visible and checked.
  Confirm. The task reads done and its card no longer shows a worktree; where the fixture exposes
  the Worktrees view, the slot reads available.
- Make the checkout dirty, open Complete. The box is unchecked and the uncommitted-file reason is
  visible.
- For an assigned task (no worktree), the checkbox is absent.
- Call `expectContentClearsBorder` on the dialog.

**Commands:**

```sh
npm run typecheck
npm run lint
node --test --import ./test/setup-state.mjs --import tsx test/complete-frees-worktree.test.ts
npm test
npm run build && npm run smoke
npm run test:e2e -- e2e/specs/complete-frees-worktree.spec.ts
```

## 8. Merge and exit criteria

- All commands above pass. CI is green.
- Unchecked Complete behaves exactly as before, as shown by the unchanged-body route test.
- Checked Complete on a clean, pushed or merged task leaves the task `done` with no worktree, and
  the slot is available.
- No path frees a checkout that has uncommitted or untracked files unless the operator ticked an
  unsafe box (`discardWork`).
- Docs updated. The pull request attaches e2e evidence per `AGENTS.md`, not committed.

## 9. Downstream handoff

There are no later phases. Future callers (Foreman, MCP) may rely on:

- `freeWorktree` on `POST /api/tasks/:id/complete`;
- `GET /api/tasks/:id/free-preview`;
- `TaskManager.worktreeFreeability`.

They must not bypass `reclaim` for teardown.

## 10. Cross-phase audit record

- **2026-09-27, planning audit:** single phase; every source-plan decision is owned here.
  Reconciled against the code:
  - the complete route returns the task object, so the result fields are additive on that object
    rather than a new envelope;
  - `mergedPrFor` is private, so freeability lives in `TaskManager`;
  - the plan's `worktreeFreeability(task)` next to `actions.ts` is split into a path-level Git
    check (actions.ts) plus the task-level method (tasks.ts).
- **2026-09-27, review round 1 (GitHub Inspector on PR #11):**
  - the `ifSafe` re-check moved from before `reclaim` into a `beforeTeardown` guard that runs
    after the agent is stopped, closing the window in which a still-running agent could write
    unseen work;
  - the merged-PR excuse is scoped to commits contained in a merged PR's recorded head
    (`prHeadSha`), not to "any PR for this task merged";
  - `plan.md`'s preview contract now includes `applicable`, matching this file.
