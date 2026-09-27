# Complete frees the task's worktree: phased implementation

**Source plan:** [`plan.md`](./plan.md) (approved 2026-09-27)\
**Submitted decision:** implementation follow-up → *Create phased implementation plan*. No other
open choices; every design decision was settled before approval and is recorded in the source
plan's "Adopted decisions" table.

## Findings that shaped the phase

- **The complete route returns the task object** (`src/server/routes.ts:8121`), and the browser,
  not the server, kills the session afterwards (`CompleteModal.tsx:118-145`). The new result
  fields are therefore additive on that object, and the checked path drops the browser kill
  because `reclaim` already stops the agent.
- **`TaskManager.reclaim`** (`src/server/tasks.ts:5729`) already provides every teardown the plan
  needs:
  - a cleanup reservation;
  - stopping the agent;
  - settling archives;
  - provider-aware teardown for native, `git` and multi-repo trees;
  - partial release.

  No new teardown path is needed.
- **`TaskManager.mergedPrFor` is private** (`tasks.ts:1959`). The task-level freeability method
  therefore lives on `TaskManager`, while the Git reads move into a path-level helper extracted
  from `resetWouldDestroyWork` (`src/server/actions.ts:2417`).
- **No persisted state changes and no migration.**

## Sizing

Estimated **230 to 290 lines** of non-test production code:

| Area | Lines |
| --- | --- |
| Git check extraction | ~40 |
| `worktreeFreeability` | ~50 |
| Preview and complete route changes | ~45 |
| Schema and client API | ~25 |
| `CompleteModal` checkbox, preview state and confirm branch | ~80-120 |

Docs and tests are extra. The work is slightly above the one-phase threshold, but it is a single
vertical slice. A server-only first phase would ship an option no caller uses, and a UI-only phase
cannot exist without the route. There are few edge cases, and they are enumerated in the phase
file. **One phase.**

## Phases

| Phase | File | Depends on | Delivers |
| --- | --- | --- | --- |
| 1 | [`phase-1-complete-frees-worktree.md`](./phase-1-complete-frees-worktree.md) | planning PR merge | Checkbox, preview route, `freeWorktree` on complete, docs, unit and e2e tests |

**Dependency graph:** planning session → Phase 1.\
**Concurrency:** none; there is a single phase.\
**Merge order:** the planning PR (these artifacts), then Phase 1.

## Cross-phase contracts

These are the contracts other callers may rely on after Phase 1:

- `POST /api/tasks/:id/complete` accepts `freeWorktree: "ifSafe" | "discardWork"`.
- The response gains optional `freed` and `freeError`. With the option absent it is unchanged.
- `GET /api/tasks/:id/free-preview` returns `{ applicable, freeable, reasons[] }`.
- Teardown always goes through `TaskManager.reclaim`.

## Final verification

The phase's exit criteria are the feature's:

- typecheck, lint, the full unit suite, build and smoke all pass;
- the new e2e spec passes;
- CI is green;
- unchecked Complete behaves exactly as before.
