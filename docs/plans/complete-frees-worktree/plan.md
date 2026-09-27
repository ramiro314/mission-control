# Complete frees the task's worktree

**Status:** Approved on 2026-09-27\
**Scope:** One phase\
**Background:** the worktree pool investigation and task lifecycle explainer from the planning session (local reports, not committed)

## Problem

Completing a task records `done` and stops its session, but never releases its checkout. "Mark
done must not discard work" (`TaskManager.complete`, `src/server/tasks.ts:4875`), so the tree
stays leased until someone runs **Clean up** or 30 days pass with no Git-visible change. In
practice every completed task pins a pool slot. With `maxSlots: 8`, eight finished tasks fill a
pool, and every later dispatch falls back to a throwaway `git` worktree that is held for 30 days
too.

## Goal

The Complete dialog gets a checkbox, **"Free this task's worktree"** ("worktrees" for a
multi-repo task), with the note **"Also closes this task's terminal"** under it. When it is
ticked, completing the task also runs Clean up. It is on by default whenever freeing is safe.

## Adopted decisions

| # | Decision |
| --- | --- |
| Scope | Frees every checkout Mission Control provisioned for the task (native slots, `git` fallback worktrees, every repository of a multi-repo task) through the existing Clean up path. |
| Safety default | On by default only when the task is safe to free. When it is not, the box starts off with each reason listed, and the operator may still tick it. |
| What "safe" means | No uncommitted or untracked (non-ignored) files, and no commits that no `origin` ref holds. Committed work also counts as safe when Mission Control recorded the task's PR as merged and the checkout's HEAD is that merged PR's recorded head commit or an ancestor of it, even if the branch was deleted from origin. Commits made after the merged head are never excused. |
| Multi-repo | One checkbox for the task. Any unsafe checkout makes the default off, and every unsafe checkout's reason is listed. |
| Failure | Completion is never rolled back. If freeing fails, the task stays `done` and the dialog reports "Task completed, but the worktree could not be freed: <reason>". The tree is left to Clean up or retention. |
| Nothing to free | The checkbox is hidden when the task records no Mission Control-provisioned worktree. That covers assigned tasks, which use the session's own checkout, and pipeline tasks, whose workspace the provider owns. |
| Entry points | Every place the shared `CompleteModal` opens: the session footer, Kill's "complete instead", and the conversation terminal. Automatic completions (merge, pipeline, mission conclusion, retro no-change) are unchanged. |
| Default memory | On every time the dialog opens, subject to the safety default. No remembered choice. |
| Where it runs | On the server, in one request. The complete route takes `freeWorktree` and runs Clean up after recording `done`. Clean up already stops the agent, so it replaces the dialog's separate kill. |
| Intent on the wire | `freeWorktree: "ifSafe" \| "discardWork"`. `ifSafe` re-checks after the agent is stopped, immediately before teardown, and keeps the tree if it has become unsafe. `discardWork` is sent only when the operator ticked a box that the preview reported unsafe. |
| Preview | A new read-only `GET /api/tasks/:id/free-preview` returns `{ applicable, freeable, reasons[] }`; `applicable` is false when the task has no Mission Control-provisioned worktree. The dialog calls it on open and shows "checking…" until it answers. It is not added to every task broadcast. |
| Terminal | Accepted: freeing closes the task's own terminal home, including any extra panes in it. |

Unchanged:

- Unchecked means today's flow exactly: complete, then kill, with the worktree kept.
- Scout tasks get no special handling. `complete` already waits for the report archive, and Clean up settles archives before teardown.
- "Satisfy dependents" and the retro offer behave as before.
- Foreman and MCP callers do not use the new option in this change.
- Success feedback reads "Task completed · worktree freed".

## Flow

```mermaid
sequenceDiagram
  participant D as Complete dialog
  participant S as Daemon
  D->>S: GET /api/tasks/:id/free-preview
  S-->>D: { applicable, freeable, reasons[] }  (sets checkbox default)
  alt box ticked
    D->>S: POST /api/tasks/:id/complete { ..., freeWorktree: "ifSafe" | "discardWork" }
    S->>S: finishCompletion -> done
    S->>S: reclaim: stop agent, settle archives
    S->>S: ifSafe: re-check now; if unsafe keep the tree, else (or discardWork) teardownWorktree
    S-->>D: { ok, freed, freeError? }
  else box unticked (today)
    D->>S: POST /api/tasks/:id/complete
    D->>S: POST /api/sessions/:id/kill
  end
```

## Implementation

1. **Safety predicate (server).** Add a task-level `worktreeFreeability(task)` next to
   `resetWouldDestroyWork` (`src/server/actions.ts:2417`), and reuse its Git reads per checkout
   path: the primary `worktreePath` plus every `extraRepos[].worktreePath`. It returns
   `{ freeable: boolean, applicable: boolean, reasons: string[] }`. `applicable` is false when
   the task has no provisioned worktree or is a pipeline task. A local-only commit is excused
   only when the task has a merged work-episode PR (the bindings `mergedPrFor`,
   `src/server/tasks.ts:1959`, reads) whose recorded `pr_head_sha` equals the checkout's HEAD or
   has HEAD as an ancestor (`git merge-base --is-ancestor HEAD <pr_head_sha>`). A missing head
   SHA or an object Git cannot find means not excused. Uncommitted files are never excused.
2. **Preview route.** `GET /api/tasks/:id/free-preview` in `src/server/routes.ts` returns the
   predicate's result. 404 for an unknown task.
3. **Complete route.** Extend `CompleteTaskSchema` (`src/shared/protocol.ts:1311`) with an
   optional `freeWorktree: z.enum(["ifSafe", "discardWork"])`. In the route (`routes.ts:8121`),
   after a successful `tasks.complete(...)`:
   - `ifSafe`: call `tasks.reclaim(id, { beforeTeardown })`. `reclaim` gains an optional guard
     that runs after the agent is stopped and archives are settled, immediately before
     `teardownWorktree`. The guard re-runs the predicate; if it is not freeable, reclaim skips
     teardown (the agent stays stopped, as Complete would have left it) and the reasons become
     `freeError`.
   - `discardWork`: call `tasks.reclaim(id)`.
   - Return `freed: boolean` and `freeError?: string` alongside the existing result. The status
     stays `done` in every case.
4. **Client.** `api.completeTask` in `src/web/lib/api.ts` gains the option and omits it when
   unset, so every existing caller sends an unchanged body. Add `api.taskFreePreview(id)`.
5. **Dialog.** In `src/web/components/CompleteModal.tsx`:
   - fetch the preview on open;
   - render the checkbox and the terminal note only when the preview says the task has something to free (`applicable`);
   - default the box to `freeable`, and list the reasons when it is not freeable;
   - on confirm:
     - ticked: send `freeWorktree` (`ifSafe` if the preview was freeable, `discardWork` if the operator ticked an unsafe box) and skip `api.kill`;
     - unticked: keep today's complete-then-kill.
   - report `freeError` in the dialog's existing error slot, worded as above.
6. **Docs.** Describe the checkbox and its safety rule in `docs/dispatch-and-backlog.md` (near
   "When a task's agent goes away") and add a cross-reference from
   `docs/worktrees-and-checks.md` "Task worktree retention".

## Tests

- **`test/`, predicate:**
  - clean and pushed → freeable;
  - uncommitted file → not freeable, even if the PR is merged;
  - local-only commit → not freeable;
  - local-only commit that is the merged PR's head (or an ancestor) → freeable;
  - local-only commit made after the merged PR's head → not freeable;
  - multi-repo with one unsafe checkout → not freeable, with that checkout's reason;
  - assigned task or pipeline task → not applicable.
- **`test/`, route:**
  - `ifSafe` on a safe task → `done` and reclaimed;
  - `ifSafe` on a tree that became dirty → `done`, tree kept, `freeError` set;
  - a file written by the agent after the preview but before it was stopped → tree kept (the guard runs after the stop);
  - `discardWork` → reclaimed;
  - reclaim refused → `done` kept, `freeError` set;
  - no option → body and behaviour unchanged.
- **`e2e/` spec** (required for the UI change):
  - the box renders checked for a clean task;
  - it renders unchecked with the reason for a dirty task;
  - it is absent for an assigned task;
  - confirming with it checked shows the slot back as available in the Worktrees view;
  - a refused free shows the error while the task reads done;
  - `expectContentClearsBorder` on the dialog.

## Risks

| Risk | Mitigation |
| --- | --- |
| Default-on deletes work | The default is on only when the predicate proves safety, and the server re-checks after stopping the agent, immediately before teardown, under `ifSafe`. |
| Preview and teardown disagree | `ifSafe` makes the server's check the one that decides; the preview only sets the default. |
| Merged-PR excuse is too broad | It excuses committed work only; uncommitted and untracked files always block. |
| Closing the terminal surprises the operator | The note under the checkbox says so. |

## Non-goals

- Freeing on automatic completions (merge, pipeline, mission).
- Changing the 30-day retention rule.
- Exposing the option to Foreman or MCP.
- Adding a "free" action outside the Complete dialog (Clean up already exists).
