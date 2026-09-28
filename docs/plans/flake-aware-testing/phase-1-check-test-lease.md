# Phase 1: Check test lease and concurrency

Part of [flake-aware testing](plan.md). Index: [phased-plan.md](phased-plan.md).

## 1. Outcome

A workflow's test checks stop piling up on the laptop. Only one test-running Command runs at a
time across the whole machine, including across several daemons, and it runs at a lower test
concurrency. Other test checks wait for the lease instead of competing for CPU. This is the
immediate relief for the timeouts that cost three repair rounds on PR #21.

## 2. Entry criteria and dependencies

- No phase dependencies.
- `main` builds and `npm test` passes.

## 3. Scope and non-goals

In scope:

- A machine-wide, user-scoped test lease that a daemon acquires around every test-running check.
- A lower test concurrency passed to a test-running check's command.
- Both as settings, on by default.

Non-goals:

- The `affected-tests` slot (Phase 2). This phase defines the predicate Phase 2 extends.
- Leasing tests that agents run directly in their own terminals. Only workflow checks take the lease.
- Changing e2e behavior. The e2e host lease keeps its own port and semantics.

## 4. Repository findings and inherited contracts

- `e2e/host-lease.ts` implements a user-scoped, machine-wide lease: an exclusive loopback TCP
  listen on `127.0.0.1` at `21800 + hash(uid) % 1000`, owner metadata JSON in the temp dir, and
  polling with a 45-minute wait. It lives under `e2e/`, is not imported by `src/server`, and is
  tested in `test/e2e-host-lease.test.ts`.
- The native state-lock addon (`native/state-lock`) is non-blocking and scoped per state directory,
  so it is not a fit.
- Only the daemon runs checks (`runCheck` is called only from `engine.ts`), but more than one daemon
  can run on a machine (one per `MISSION_HOME`, as e2e and tests do). A daemon-internal queue alone
  is not machine-wide.
- Execution path: `engine.ts runCheckAttempt` calls `checks.ts runCheck`, which reserves the run
  budget and then calls the per-attempt executor from `check-runtime.ts` (`executorFor`). The
  comment at `checks.ts` near the reservation requires **no await between the reservation and the
  spawn**. The lease therefore belongs inside the executor, around the supervised spawn, not
  between reservation and `execute()`.
- `check-supervisor.ts` builds the child env through `scrubCheckEnv` (`check-env.ts`), a deny-list
  that preserves ordinary variables.
- This repository's `npm test` reads `MISSION_TEST_CONCURRENCY` (default 6; CI pins 4).
- Settings for workflows live in `WorkflowPolicy` (`src/shared/workflow.ts`, stored in `app_config`;
  defaults near `DEFAULT_WORKFLOW_POLICY`), edited in `WorkflowSettingsPanel.tsx`.

## 5. Implementation steps

1. **Lift the lease into a shared module.** Move the TCP-listen lease mechanism from
   `e2e/host-lease.ts` into `src/server/util/host-lease.ts` with a small API:
   `acquireHostLease({ name, waitMs, onWaiting }) -> { release() }`. The port is derived from the
   lease `name` plus the user id, so the e2e lease and the test-check lease never collide. Keep
   `e2e/host-lease.ts` as a thin caller with its existing name and behavior (its tests must pass
   unchanged).
2. **Define which slots run tests.** In `src/shared/workflow.ts`, add
   `slotRunsTests(slot: WorkflowCheckSlot): boolean`, true for `test` only in this phase. Phase 2
   extends it.
3. **Take the lease in the executor.** In `check-runtime.ts`, when `slotRunsTests(slot)` and the
   setting is on, acquire the `mission-check-tests` lease after the worktree lease is acquired and
   before `runSupervisedCheck`, and release it in the same `finally` path that settles the tree.
   Waiting for the lease must not count against the command's own timeout: start the command
   timeout after the lease is held. Waiting has its own ceiling (the check slot's timeout); on
   expiry the attempt fails as infrastructure with a clear reason, so the engine's existing
   infrastructure retry handles it.
4. **Pass a lower concurrency.** When `slotRunsTests(slot)` and a concurrency setting is set,
   `check-supervisor.ts` adds `MISSION_TEST_CONCURRENCY=<n>` to the child env. The variable is this
   repository's convention. Document that other repositories can read it or ignore it.
5. **Settings.** Add to `WorkflowPolicy`: `checkTestLease: boolean` (default `true`) and
   `checkTestConcurrency: number | null` (default `3`, range 1-32, `null` means do not set the
   variable). Add both to the policy schema with defaults applied on read, to the settings search
   keywords, and to `WorkflowSettingsPanel.tsx`.
6. **Run detail.** When a check waited for the lease, its outcome note says how long it waited
   (for example "Waited 3m 12s for another test check to finish."), so a slow check is explained.
7. **Docs.** Update `docs/workflows.md` (Commands section) with the lease and concurrency behavior,
   and the settings table in `docs/skills-and-settings.md` if it lists workflow settings.

## 6. Data, API and compatibility

- No database migration: the two settings live in the existing `app_config` policy blob, and
  defaults apply on read.
- Settings backups include the policy blob already. A backup from before this phase restores with
  defaults.
- The e2e lease's port and file names do not change.

## 7. Tests and verification

- `test/host-lease.test.ts`: two acquirers with the same name serialize; different names do not;
  release frees the port; a crashed holder (closed socket) frees it; the wait ceiling fails cleanly.
- `test/e2e-host-lease.test.ts` passes unchanged.
- A check-runtime test (stub executor) proving: the lease is held only for `test` slot checks,
  released on success, failure and infrastructure error, the command timeout starts after the
  lease, and `MISSION_TEST_CONCURRENCY` reaches the child env only for test-running slots.
- Settings: schema defaults, and the panel renders both controls (render test plus a Playwright
  spec in `e2e/` that changes the concurrency and reads it back from `/api/workflows/config`).
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e` for the new spec.

## 8. Merge and exit criteria

- Two test checks started at once, from two worktrees, run one after the other, and the second's
  note states the wait.
- Lint, typecheck and build checks are never blocked by the lease.
- All verification above passes.

## 9. Downstream handoff

Later phases may rely on:

- `slotRunsTests(slot)` in `src/shared/workflow.ts`. Phase 2 appends `affected-tests` to it; no
  later phase changes its meaning.
- The lease being taken inside the executor around each spawn. Phase 2's select, run and rerun
  loop runs inside one lease hold, not one per spawn.
- The setting names `checkTestLease` and `checkTestConcurrency`. Phase 5's setup skill mentions
  them.
- `src/server/util/host-lease.ts` as the one lease mechanism.

## 10. Cross-phase audit

- Written first. The Phase 2 audit confirmed the rerun loop runs inside a single lease hold, which
  is what this phase provides.
