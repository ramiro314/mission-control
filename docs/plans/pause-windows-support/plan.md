# Pause Windows support, and bring the platform-neutral work from `release/windows` to `main`

Status: approved 2026-10-11 after a three-round interview with the human (decisions D1 to D21 below) and a plan review that approved it as written. Follow-up chosen in the review: Create tickets after the plan merges, so Mission Control slices it into tickets in a linked follow-up task once this plan's pull request merges. Not implemented.

## Goal

Windows support for Mission Control is **paused**. Getting Mission Control on Windows to an
acceptable performance standard would take too much work. This plan:

1. **Winds down the Windows work.** It closes the open Windows issues with that reason, stops the
   weekly sync, records the pause in the fork tracking, and removes from `main` everything that
   only existed to serve `release/windows`.
2. **Ports what is worth keeping.** Six bundles of platform-neutral fixes were built on
   `release/windows` and fix problems `main` still has on macOS and Linux. Each comes to `main` as
   its own pull request.

`release/windows` itself is kept, frozen, so the work can be resumed or mined later.

## Where things stand (verified 2026-10-11 on `main` at `d44bda68`, `release/windows` at `597cc4f6`)

- **`release/windows`** forked from `main` at `5a473a17` and carries 271 commits `main` lacks: 71
  first-parent PR merges. Four of them (#224, #240, #314, #331) are syncs of `main` into the
  branch. The other 67 are Windows work, PRs #187 to #392, all merged into the branch. No pull
  request into `release/windows` is open.
- **23 open issues carry `windows-support`**: #342 to #362, #366 and #372. #366 is also labeled
  `bug`. It is the root-cause write-up for the Linux flake #369 in a `library.spec.ts` test that
  only exists on the branch.
- **Fork-feature tracking issue #304** ("Fork feature: Windows support") is open with
  `fork-status:in-progress`. Its status changes only through a merged PR's "Fork feature changes"
  `#### Status` block, applied by the daily "Refresh fork status" mission
  ([docs/fork/README.md](../../fork/README.md)). The allowed statuses are `active`,
  `in-progress`, `superseded`, `removed` and `upstreamed`; there is no `paused`.
- **The upstream-sync runbook reads only open `fork-feature` issues**
  ([docs/upstream-sync.md](../../upstream-sync.md), section 2). #304 is the issue whose
  contracts tell an upstream sync to route any new `ps`, `lsof`, `kill(-pid)` or `detached` spawn
  through the four platform seams on `main`.
- **The four platform seams on `main`**, from plan M1 of
  [docs/plans/windows-support/plan.md](../windows-support/plan.md):
  - process inspection (`src/server/process-inspection/`)
  - process lifetime (`src/server/platform/process-lifetime.ts`)
  - executable environment (`src/server/platform/executable-environment.ts`)
  - native addon sources (`scripts/native-addon-sources.mjs`)

  These and `.gitattributes` are platform-neutral consolidations. Process lifetime alone merged
  duplicated process-group code from 7 call sites, and a source guard test forbids new ad hoc
  spawns. Each seam's per-platform map is empty on `main`, so every platform resolves to POSIX.
  Three comments name `release/windows`:
  - `src/server/process-inspection/index.ts:10`
  - `src/server/platform/process-lifetime.ts:71`
  - `src/server/platform/executable-environment.ts:65`
- **The weekly "Sync main into release/windows" mission** lives on the operator's daemon, not in
  this repository. The daemon removes a mission by archiving it, through
  `POST /api/schedules/:id/archive` (`src/server/routes.ts`).
- **Two leftover remote branches** each hold one commit that never merged. Both commits are
  Windows-only:
  - `fix/win32-e2e-fast-assertions` at `87e78b6e`: a win32 skip
  - `fix/win32-ensemble-cancel-tracked` at `c90054b2`: a docs note
- **`release/windows` references on `main`, outside `docs/plans/`:**
  - the sync runbook `docs/windows-branch-sync.md`
  - links to the runbook in `docs/README.md:58` and `docs/upstream-sync.md:208`
  - two passages in `docs/fork/README.md` (lines 120-121 and 196)
  - the Windows merge-counting logic in `scripts/fork-report.mjs`
    (`WINDOWS_SLUG`, `WINDOWS_BRANCH`, `windowsIncludes`) and its tests
  - the three seam comments
  - example base branches in five places:
    - the Dispatch "Base branch" placeholder (`src/web/components/DispatchModal.tsx:3146`)
    - two MCP tool descriptions (`src/mcp/server.ts:428`, `:610`)
    - `src/shared/protocol.ts:772`
    - `docs/dispatch-and-backlog.md:147` and `:164`
    - `e2e/specs/diff-task-base-branch.spec.ts`
  - fixture strings in 12 test files (about 120 occurrences)
  - #301's Intent, which uses it as its example
- **Flaky-test issues.** 44 open `Flaky test:` issues were filed only from `release/windows` CI.
  - Every one of them failed on a **Linux** e2e shard.
  - Only #319 and #369 test code that `main` lacks. Both are `library.spec.ts` tests added by
    #309 and #338.
  - The other 42 cover tests `main` also runs. Four of those (#255, #260, #272 and #394) have
    parameterized titles, which hides that.

## Decisions

Recorded with the answer the human gave, by interview round.

| # | Decision | Answer | Round |
| --- | --- | --- | --- |
| D1 | What happens to `release/windows` | Kept, **frozen as-is** at `597cc4f6`. No more syncs or PRs into it. | 1 |
| D2 | The weekly "Sync main into release/windows" mission | **Deleted** (archived, the daemon's form of deletion). | 1 |
| D3 | Which `windows-support` issues close | **All 23.** #366 closes through the UI port (D15). The wind-down closes the other 22. | 1, 3 |
| D4 | The closing comment | The full text in [Closing comment](#closing-comment), close reason *not planned*. | 1 |
| D5 | How #304 is recorded | Closed as **`fork-status:removed`**, with a note that it is paused, the branch is preserved, and reopening resumes it. | 1 |
| D6 | Flaky-test issues filed only from `release/windows` CI | Close only those whose tests exist only on the branch, which is #319 and #369. D15 then applies to both. The other 42 stay open as Linux flakes in tests `main` runs. | 1, 2 |
| D7 | How much Windows text and code leaves `main` | **Scrub:** <ul><li>delete the sync runbook and its links</li><li>add a Paused note to the Windows plan</li><li>remove `fork-report.mjs`'s Windows logic</li><li>reword the seam comments</li><li>replace the `release/windows` examples</li></ul> | 1 |
| D8 | The two leftover `fix/win32-*` branches | **Deleted.** | 1 |
| D9 | Which bundles come to `main` | Six: P1 to P6 below. #337, #247's file watchdog, #341's duration sharding and #192's path helper are **not** ported. | 2 |
| D10 | How bundles are ported | Each bundle is re-applied on a fresh `main` as **one PR per bundle** that cites the original PRs. Cherry-pick a hunk where it applies cleanly; hand-port it where it imports a branch-only helper. Never bring Windows code or branch-only helpers (`writeFakeExecutable`, `physicalPathSync`, `skipOnWin32`). | 2 |
| D11 | The four seams once #304 closes | Kept, and tracked as their own **active fork feature, `fork:platform-seams`**. The wind-down PR creates the label and issue. | 2 |
| D12 | How far the scrub goes inside the seams | **Comments only.** Reword the three comments that name `release/windows`, and keep the empty per-platform maps. | 2 |
| D13 | Where the example branch name is replaced | **Everywhere**, including test fixtures, but never in `docs/plans/` (D17). | 2 |
| D14 | The replacement name | **`release/2.0`**. | 3 |
| D15 | #319 and #369 | The UI port PR (P3) closes #369 with `Fixes #369`, since `33a7e704` fixes its cause. #319 stays open as a real flake once its test is on `main`. | 2 |
| D16 | Who archives the sync mission | **The wind-down ticket**, through `POST /api/schedules/:id/archive` on the operator's daemon. | 2 |
| D17 | Historical plans | **Untouched.** Plans under `docs/plans/` are records. Only `docs/plans/windows-support/plan.md` and its `plan.html` get the Paused note. | 3 |
| D18 | How #366 closes | The UI port PR (P3) closes it with `Fixes #366`, alongside #369. | 3 |
| D19 | When the wind-down's external steps run | **Right away**, independent of the scrub PR. | 3 |
| D20 | Ordering | **All seven units run in parallel.** None depends on another apart from rebasing on whatever merges first. | 3 |
| D21 | The three side findings | **Recorded in this plan only** ([Out of scope](#out-of-scope)). No issues are filed. | 2 |

## Work

Seven independent units: one wind-down (W) and six ports (P1 to P6). Each port re-applies its
hunks on the current `main`, not on the `main` the branch last synced. Two rules hold for every
port:

- **Re-verify first.** Check that `main` still has the problem before porting a hunk. If `main`
  fixed it independently since 2026-10-11, skip that hunk and say so in the PR.
- **Prove it on `main`.** Where a test can show the problem, write or port it first and show it
  failing on `main`.

Port PRs are standalone fixes, not fork features. Each carries no `fork:*` label, and its "Fork
feature changes" section is `none`. Each PR body links its original `release/windows` PRs and
merge commits, so a reviewer can compare.

### W. Wind down the Windows work

**External steps, done first and independent of the PR (D19).** Approving this plan authorizes
these writes, and the ticket body restates them:

1. **Close 22 issues as *not planned*** with the [closing comment](#closing-comment):
   #342, #343, #344, #345, #346, #347, #348, #349, #350, #351, #352, #353, #354, #355, #356,
   #357, #358, #359, #360, #361, #362 and #372. Leave #366 for P3 (D18). Close no flaky-test
   issue: #369 belongs to P3, and #319 stays open (D15).
2. **Delete the two remote branches**, `fix/win32-e2e-fast-assertions` (`87e78b6e`) and
   `fix/win32-ensemble-cancel-tracked` (`c90054b2`). Record both SHAs in the PR body so they can
   be recovered while GitHub still holds the objects.
3. **Archive the "Sync main into release/windows" mission** on the operator's daemon, through
   `POST /api/schedules/:id/archive`. Find its id by its name, then confirm it no longer appears
   among active missions.

**The scrub PR:**

- **Docs:**
  - Delete `docs/windows-branch-sync.md`.
  - Remove its links from `docs/README.md` and `docs/upstream-sync.md`.
  - Remove the `release/windows` passages from `docs/fork/README.md`: the "PRs into
    `release/windows`" note and the status-snapshot sentence.
- **The Windows plan:** add a Paused note under the title of
  `docs/plans/windows-support/plan.md`, then regenerate its `plan.html`. The note says:
  - Windows support was paused on 2026-10-11, for the reason in the closing comment.
  - `release/windows` is kept, frozen at `597cc4f6`.
  - The sync runbook was deleted from `main` and survives in git history.
  - It links this plan.

  Change nothing else in `docs/plans/` (D17).
- **`scripts/fork-report.mjs`:** remove `WINDOWS_SLUG`, `WINDOWS_BRANCH`, the `windowsIncludes`
  path, the `release/windows` PR query and the header comment that describes them. Update
  `test/fork-report.test.ts` to match.
- **Seam comments (D12):** reword the three comments so they no longer name `release/windows`.
  For example: "No platform registers an override on `main`; every platform resolves to the POSIX
  implementation." Keep the maps, their lookups and their tests. Rename a test only if its title
  names `release/windows`.
- **Example branch name (D13, D14):** replace `release/windows` with `release/2.0` in:
  - `DispatchModal.tsx`'s placeholder
  - `src/mcp/server.ts`
  - `src/shared/protocol.ts`
  - `docs/dispatch-and-backlog.md`
  - `e2e/specs/diff-task-base-branch.spec.ts`
  - the 12 test files

  Regenerate, rather than hand-edit, any generated file that carries an MCP tool description.

  The placeholder change is a UI change. Extend `e2e/specs/diff-task-base-branch.spec.ts` (or
  the spec that already opens the Dispatch "Base branch" field) to assert that the field's
  placeholder reads `e.g. release/2.0`.
- **Fork feature changes section**, built with `node scripts/fork-delta.mjs` and validated with
  `node scripts/fork-delta.mjs check <pr>`:
  - `### fork:windows-support`:
    - `#### Status`: `removed`, with the note "Paused 2026-10-11: getting Mission Control on
      Windows to an acceptable performance standard would take too much work. `release/windows`
      is kept, frozen at `597cc4f6`. Set Status `in-progress` to resume. The platform seams on
      `main` are tracked in `fork:platform-seams`."
    - `#### Why it was removed` (`base: new`): the same reason. It also records that the sync
      mission was archived, the runbook was deleted, and the Windows issues were closed on
      2026-10-11.
  - `### fork:per-task-base-branch`: `#### Intent` with `release/2.0` as the example branch
    in place of `release/windows`. The base comes from `fork-delta.mjs base`.
  - **`fork:platform-seams`** is new (D11). Under the standing grant in
    [AGENTS.md](../../../AGENTS.md#fork), the PR creates the label and the tracking issue with
    the body in [The `fork:platform-seams` tracking issue](#the-forkplatform-seams-tracking-issue)
    when it opens, and labels itself. If that write is refused, the section carries the full
    body under `### fork:platform-seams` instead.
  - **Labels:** `fork:windows-support`, `fork:platform-seams`, `fork:per-task-base-branch` and
    `fork:upstream-sync-process-and-fork-ledger`. The last one is for `fork-report.mjs`,
    `docs/fork/` and `docs/upstream-sync.md`.

**Done when:**

- The 22 issues are closed as *not planned* with the comment, the two branches are gone, and the
  mission is archived.
- `git grep -n 'release/windows' -- . ':!docs/plans' ':!CHANGELOG.md'` prints nothing.
- `fork-delta.mjs check` passes on the PR.
- The touched unit tests, the placeholder e2e spec, `npm run typecheck` and `npm run lint` pass.
- After merge, the daily refresh closes #304 as `removed`. The refresh's own run, not this
  ticket, is what closes it.

### P1. Create a fresh database's schema in one transaction

From #332 (`7c1426fa`).

**What it fixes.** `upgradeDatabaseToCurrentSchema` in `src/server/db.ts` runs about 263 CREATE
statements, each its own commit. Under WAL with the default `synchronous=FULL`, every commit
syncs the WAL to disk. A synthetic test on ext4 (330 CREATE statements) took **1784 ms with one
commit per statement and 15 ms in one transaction**. Every Linux first boot, every unit test
that opens a fresh database on a real disk, and every e2e daemon boot pays that cost today.

**Port:**

- Move the CREATE block into a new `createSchemaObjects(d)` and wrap it in
  `BEGIN IMMEDIATE`/`COMMIT`, with a rollback on error.
- Keep `migrateTelemetry`, `migrate` and `markDatabaseSchemaCurrent` outside the transaction,
  so the upgrade path for existing databases is unchanged.
- Add `test/db-schema-commits.test.ts`.
- Drop the Windows inventory doc hunk.

`db.ts` is a controlled path (AGENTS.md). Upgraded databases must keep opening safely.

**Evidence.** A focused before/after timing of a fresh-database open on Linux, plus the new test.

### P2. Product bug fixes

**#273 (`10a4716b`): Claude project directories are encoded the way Claude Code encodes them.**
- **Today:** `main` encodes a cwd with `cwd.replace(/[/.]/g, "-")` in three places:
  - `src/server/goal/prune.ts:66`
  - `src/server/harness/claude/sdk.ts:165`
  - `src/server/harness/claude/transcript.ts:47`

  `e2e/fixtures/fake-claude.mjs` uses the same rule. Claude Code replaces every
  `[^a-zA-Z0-9]` with `-` and truncates names past 200 characters with a hash suffix. So any cwd
  containing `_`, a space, `+` or similar misses its transcript, and the headless pruner deletes
  nothing.
- **Port:**
  - Add `src/server/harness/claude/project-dir.ts` (`claudeProjectDir`, `CLAUDE_PROJECTS_DIR`).
  - Route the three call sites and the fake through it.
  - Add `test/claude-project-dir.test.ts`.
  - Keep `realpathSync` where the branch used `physicalPathSync`.
  - Re-check the rule against the installed `@anthropic-ai/claude-agent-sdk` before porting.

**#336 (`1d8ba7b9`): an ensemble member settles once its task is no longer live.**
- **Today:** `TaskManager.cancel` can return not-ok with the task already `cancelled`. That
  happens when archive publication fails, when `teardownWorktree` throws, or when an Engineer
  commission's cancel warns. The result: Withdraw is refused, Cancel run sticks at
  `cancelling`, and an impossible barrier sticks at `running`.
- **Port:** add `cancelMemberTask` in `src/server/ensembles/engine.ts`, used by
  `tearDownMember` and `reapLosers`, with its tests and the `ensemble-fixture.ts` change.

**#308 (`4652b3d4`): a stopped `git rev-parse` is "unanswered", not "not a git repository".**
- **Today:** `resolveRepoRoot` gives git `run()`'s 4 s default, so a stall on a loaded machine
  tells the operator their real checkout is not a repository.
- **Port:**
  - Add `probeRepoRoot`, which returns repo, not-a-repo or unanswered.
  - Set `REPO_ROOT_TIMEOUT_MS = 15_000`.
  - Use the honest "could not tell" refusal.
  - Inject the e2e ref race at `remote.origin.uploadpack` instead of a PATH-wide fake `git`, and
    add the `gitFetchRefRacePending()` assertion.
  - Write the fakes as `#!/usr/bin/env node` scripts plus `chmod`, not `writeFakeExecutable`.
  - Keep `realpathSync` in `src/server/repos.ts`.
  - The refusal text reaches the dashboard, so assert it in an e2e spec if no existing spec does.

### P3. UI race fixes

**From #309 (`55b4f344`), #338 (`d75ab396`) and commit `33a7e704` (inside #383):**

- **Library deep link.** A workflow deep link followed before the event stream announces that
  workflow opens the first workflow instead and rewrites the address bar.
  - A link to a workflow that does not exist silently opens another one. It now shows the 404
    load error with Retry.
  - The "Show archived" guard no longer treats "not found" as archived.
  - `33a7e704` adds a `restoringId` ref, so the transient `null` selection during restore no
    longer replaces the deep link with the bare shelf. That is the cause #366 documents and #369
    flakes on.
- **Command budget.** `CommandLibrary.tsx` gets `commandSync`'s `rebase` kind, so a budget chosen
  before the catalog loads no longer shows a false "newer revision" conflict with Save disabled.
- **Specs:** port `library.spec.ts`'s two early-link tests and the `CommandLibrary` spec. Both
  reproduce the races on any OS by aborting `**/events`.

**From #333 (`3a9537f9`): a comment marker keeps keyboard focus.**
`CommentMarkerWidget` in `src/web/components/FileEditor.tsx` gains `updateDOM`, so a state
change no longer replaces the marker's button and drops focus to the page. Port it with
`test/file-editor-comment-marker.test.ts` and the `file-line-comments.spec.ts` case.

**From #380 (`5f239336`): the tour spotlight follows a replaced target.**
`src/web/tour/target-registry.ts` gains `subscribe()`, and `GuidedTourController.tsx` gains a
coalesced refresh, so a run update that remounts the stage ladder no longer leaves the frame on
a detached element. Port it with the `library-tour` spec's timing injection.

**Done when:** the PR body carries `Fixes #366` and `Fixes #369`, and #319 stays open (D15,
D18). `npm run build` and the touched e2e specs pass.

### P4. Daemon hardening

**From #310 (`4124233d`):**
- **Setup checks single-flight.** Overlapping `GET /api/setup/checks` requests join one in-flight
  `setupRound` in `src/server/routes.ts`, cleared in `.finally`. Each response still gets its
  own snapshot token. Today a reload during a round, several tabs, or a Re-check click
  mid-round each run a full round of about a dozen version and auth probes.
- **`Registry.setMaxListeners(100)`** in `src/server/registry.ts`. `main` has about 11 long-lived
  subscribers at boot plus one per SSE tab, against Node's default limit of 10, so it likely
  prints a false `MaxListenersExceededWarning`. Confirm the warning by booting `main` before
  porting this. `registry.ts` is a controlled path; this change touches no ownership,
  comparator or eviction logic.
- **Leave out** `hostModelCatalogSpecs`, `usableProcessSnapshot`, `reconcileManagedResumesOnHost`
  and the Playwright worker change. They are Windows-only or need #196 and #197.
- **Tests:** the new `test/setup-checks-route.test.ts` case and `test/registry-subscriber-limit.test.ts`.

**From #380 (`5f239336`):**
- **HTTP keep-alive.** A new `src/server/http-keep-alive.ts`, called from
  `src/server/index.ts`, holds idle connections 65 s (`keepAliveTimeout`), with
  `headersTimeout` at 66 s. Today Node's default 5 s close races pooled-socket clients, such as
  Node's `http.Agent` and Playwright's request client, into ECONNRESET.
- **Telemetry ingress timeout.** `INGRESS_ATTEMPT_TIMEOUT_MS` in `src/web/lib/experience.ts`
  rises from 2 s to 10 s per attempt.

### P5. e2e race fixes

All test-only. Each race below is a step that runs before the daemon has answered:

| Source | Spec | Race |
| --- | --- | --- |
| #312 (`37a6cb53`) | `telemetry-settings.spec.ts` | Health is read before the consent `PUT` answers. |
| #318 (`c64c5b10`) | Foreman settings spec | A `toBeLessThan(1_300)` column-height guard. It is replaced by asserting that each field's explanation is a tooltip (`EXPLAINED_FIELDS`). |
| #335 (`c84d9a3d`), part | `conversation-band-optional.spec.ts` | A reload before the save lands. Use the shared `expectDaemonHides`. |
| #335 (`c84d9a3d`), part | `task-source-sync.spec.ts` | `keepUpdated()`, which also polls on uncheck. |
| #338 (`d75ab396`), part | `e2e/fixtures/display-items.ts` | Adds the `expectDaemonHides` helper and its uses in `board-card-workflow-progress` and `working-indicator`. Also measures the `workflow-round-scrubber` tile relative to its strip. |
| #365 (`14050a63`), part | `board-card-workflow-details.spec.ts` | Toggle waits through `expectDaemonHides`. |
| #371 (`c3a7ff77`) and #380 (`5f239336`) | `sdk-terminal-handoff.spec.ts` | Sitrep pagination: wait until every transfer-source lookup has finished. Port the combined change from both PRs. |
| #380 (`5f239336`), part | `foreman-cheap-tier-default` and `telemetry-primary-actions` | Wait for the PUT; inject the timing on every run. |

**Leave out:**
- the Windows skips and the `sep` assertions
- the guided-dispatch switch from Codex to Claude, which would lose Codex coverage
- #380's scout-archive piece, which needs the win32 `held-handle-rename.ts`
- `socket-diagnostics.ts`
- the `see-work-tour` diagnostics

**Done when:**
- The PR body carries `Fixes #255` and `Fixes #260`, for the two Sitrep flakes.
- For every other open `Flaky test:` issue on a spec this PR touches, the PR either closes it with
  evidence that this race was its cause, or leaves it open and says why.

### P6. Unit-test hygiene

All test-only:

- **#286 (`f22241c2`).** Two hangs in `test/prompted-wrapup-worker-e2e.test.ts`:
  - A failed test leaves its stub server open. Fix: an `openStubs` set and a file-level
    `after()` that closes them.
  - The `close` listener is registered after `child.kill`. Fix: a `closed` promise created right
    after `spawn`.

  Keep `writeFileSync` plus `chmodSync`.
- **#389 (`badedd85`).** `test/workflow-run-lifecycle.test.ts` runs its store setup before any
  test, so node:test's root `after` cannot remove the home mid-import. Check
  `ensemble-cost`, `multi-repo-provisioning` and `workflow-engine` for the same shape, and fix
  any that have it.
- **#267 (`f933db90`).** Pin `core.autocrlf=false` in:
  - `test/helpers/git-fixture.ts`
  - `test/ensemble-fixture.ts`
  - `ensemble-snapshot`
  - `dispatch-pinned-base`

  Also add the `ensemble-artifacts` regression test. Today a developer with a global
  `core.autocrlf=true` gets 6 failures. Leave out the e2e clipboard tweak.
- **`fileURLToPath`** (from #259 `4bf76914` and #368 `eb7d1e04`). These three tests use
  `new URL("..", import.meta.url).pathname` as a path, which breaks on a checkout path with a
  space:
  - `test/archive-migration.test.ts:284`
  - `test/assert-release-version.test.ts:41`
  - `test/scout-prompt-context.test.ts:210`

  Optionally, replace `multi-repo-provisioning`'s tmpdir regex with `includes`.
- **#391 (`b698d47b`), the scout-lifecycle piece only.** "A ship task's cleanup does no archive
  work at all" builds its fixture with `repoRoot: cwd`, a shape production never builds. Use the
  real checkout, and add reclaim's error to the assertion message.
- **#387 (`bcb0d83e`), the `flake-report-action.test.ts` piece only.** The rerun command
  `${process.execPath} ${fake}` breaks when Node's path contains a space. Put Node's directory
  first on `PATH` and run `node <basename>`.

## Closing comment

Posted on each issue the wind-down closes, with the close reason *not planned* (D4):

> Closing as not planned: Windows support is paused. Getting Mission Control on Windows to an acceptable performance standard would take too much work. The work done so far stays on `release/windows` (frozen at 597cc4f6); see #304.

## The `fork:platform-seams` tracking issue

Created by the wind-down PR when it opens (D11), with the labels `fork-feature` and
`fork:platform-seams` and no `fork-status:*` label (active). Title: `Fork feature: Platform seams`.
Body:

> Split from "Fork feature: Windows support" (#304) when Windows support was paused on 2026-10-11. The seams were built for Windows (plan M1) and stay on `main` as platform-neutral consolidations.
>
> ### Intent
>
> Process reads, process-tree spawning and signalling, the executable search ladder's locations, and each native addon's source list each go through one per-platform seam, so platform-specific behavior has one place to live and one place to test. On `main` every seam registers only its POSIX implementation.
>
> ### Behavior contracts
>
> - `.gitattributes` stores and checks out every text file as LF (`* text=auto eol=lf`).
> - **Process inspection** (`src/server/process-inspection/`): every `ps` and `lsof` read the daemon makes goes through `processInspector()`. Its POSIX implementation issues the same commands the call sites did, and each read returns its `RunResult`, so the caller, not the seam, decides whether a partial answer is usable.
> - **Process lifetime** (`src/server/platform/process-lifetime.ts`): starting a child as a tree root (`treeRootOptions`) and signalling or killing that tree (`signalTree`, `killTree`) go through `processLifetime`. Callers keep their own `spawn` call, so the executable contract tests still see each executable. The module is a leaf (Node builtins only), because the Electron main process imports it too.
> - **Executable environment** (`src/server/platform/executable-environment.ts`): the resolver's application, per-user tool and OS default directories, and the login-shell PATH read come from one per-platform row. The locator keeps the ladder's order and provenance.
> - **Native addon sources** (`scripts/native-addon-sources.mjs`): the one table of each addon's sources per platform. Each `binding.gyp` reads `<@(addon_sources)`. A platform without sources gets none, never another platform's: the required state lock refuses it and the optional Keep Awake skips it. Both builders still publish through `publishNativeAddon`.
> - Each seam's platform-selection map is empty, so every platform resolves to the POSIX implementation.
>
> ### Upstream behavior it assumes
>
> - Upstream reads processes, signals process groups and searches for executables only at the call sites the seams replaced. An upstream commit that adds a direct `ps`, `lsof`, `pgrep`, `process.kill(-pid)`, `detached: true` spawn, login-shell PATH read, or ladder location outside the seams is a conceptual conflict even when it merges cleanly: route it through the seam.
> - `process.platform` is how the daemon and the Electron main process tell platforms apart.
> - Both native addons build with `node-gyp` from a `binding.gyp` in `native/<addon>`, and the daemon takes state ownership through `dist/native/state-lock.node` before it serves.
>
> ### Upstream surfaces touched
>
> `src/server/discovery/{processes,proc-cwd,codex-rollouts}.ts`, `src/server/workflows/{check-identity,check-group,check-spawn}.ts`, `src/pi/generation-lease.ts`, `src/server/claude-cli.ts`, `src/server/llm/codex.ts`, `src/server/executables/{locator,catalog}.ts`, `src/main/{update-build,updater}.ts`, `native/{state-lock,keep-awake}/binding.gyp`, `scripts/build-{state-lock,keep-awake}-native.mjs`, `test/codex-rollout-identity.test.ts`, `test/executable-contracts.test.ts`, `test/pi-generation-lease.test.ts`, `docs/agent-guides/architecture.md` (the seam rows) and `docs/harnesses-and-terminals.md` (the executable search ladder).
>
> ### Fork-only files
>
> `.gitattributes`, `src/server/process-inspection/`, `src/server/platform/process-lifetime.ts`, `src/server/platform/executable-environment.ts`, `scripts/native-addon-sources.mjs`, `scripts/native-addon-sources.d.mts`, `test/process-inspection.test.ts`, `test/process-lifetime.test.ts`, `test/executable-environment.test.ts`, `test/native-addon-sources.test.ts`.
>
> ### Plan docs
>
> [docs/plans/windows-support/plan.md](https://github.com/ramiro314/mission-control/blob/main/docs/plans/windows-support/plan.md), milestone M1; [docs/plans/pause-windows-support/plan.md](https://github.com/ramiro314/mission-control/blob/main/docs/plans/pause-windows-support/plan.md), D11.
>
> ### Upstream candidate
>
> Not now. The four seams are platform-neutral and could be offered on their own, which would end this fork-only maintenance.

The wind-down ticket re-reads #304's current sections before creating the issue. If #304's
contracts or surfaces changed after 2026-10-11, the new issue carries the current text, minus
anything Windows-specific.

## Not ported, and why

**Windows-only, so they stay on `release/windows`:**
- **Platform implementations and refusals:** #187, #191, #192 (apart from the unported path
  helper), #196, #197, #201, #209, #210, #220, #320
- **Docs and Makefile:** #225, #233
- **Windows CI:** #237, #246, #247 (apart from the unported file watchdog), #341
- **Path, environment and filesystem fixes:** #252, #253, #256, #257, #258, #259 (apart from
  the `fileURLToPath` fix in P6), #262, #264, #265, #266, #268, #270
- **Skips and setup text:** #249, #289, #323, #324, #326, #327, #328, #330, #364, #377, #388
- **Fake executables, path handling and fixtures:** #367, #368 (apart from the
  `fileURLToPath` fix in P6), #375, #376, #378
- **Job objects, process owners, private storage, held handles and CRLF:** #374, #382, #383
  (apart from `33a7e704`), #390, #392

None of these fixes anything on POSIX, or each needs Windows-only helpers to compile.

**Platform-neutral but not selected (D9):**
- **#337:** the console-header rung-7 proof that holds on any font stack. It guards against font
  drift, and Linux passes today.
- **#247's `test/file-watchdog.mjs`:** preventive only, and it changes the controlled CI
  unit-shard action.
- **#341's duration-dealt e2e shards:** needs a `ci.yml` change, and the gain has not been
  measured.
- **#192's `subpathWithin` helper:** a dedupe with no bug behind it.

## Out of scope

Found during the triage and recorded here only (D21). None is verified, and none is filed.

- `test/dispatcher-runtime.test.ts:253` ("with both toggles off, Claude and Codex stay on the
  terminal branch") never sets the runtime to terminal. A fresh config defaults to SDK, so the
  test likely passes without exercising the terminal branch.
- Tour tasks hard-code Codex (`src/server/tours.ts`), so a tour fails on a host without Codex
  installed. #330's fix checks the host platform, not whether Codex is installed, so porting it
  would not help. A real fix would choose the harness by whether it is installed and ready.
- `src/server` mixes JS `realpathSync` with the native `fs.promises.realpath` in about 10 files.
  On case-insensitive APFS the two can spell a wrong-case path differently.

## Risks

- **Classifications rest on read-only analysis.** Subagents read diffs, PR bodies and
  `git merge-tree` simulations against `main`. Only #332's gain was measured, and only
  synthetically. Each port's "re-verify, then prove it on `main`" rule is the guard.
- **P4 changes production behavior on every platform.** The 65 s keep-alive holds idle loopback
  sockets longer, and the 10 s telemetry timeout keeps a slow ingress attempt open longer. The
  keep-alive reset was observed only on Windows, though the race is ordinary Node behavior.
- **#308's 15 s timeout** makes a truly hung git take 15 s to fail instead of 4 s.
- **#332 touches `db.ts`.** The upgrade path is unchanged, because `migrate` stays outside the
  transaction. The PR must still show an existing database opening safely.
- **Conflicts between units.** W's fixture rename, P2's `ensemble-fixture.ts` change, and P6's
  `ensemble-fixture.ts` and `git-fixture.ts` changes can collide. Each is mechanical, and
  whichever merges second rebases (D20).
- **The branch goes stale.** Resuming Windows work later means one large catch-up merge of `main`
  into `release/windows`. It also means restoring the sync runbook and `fork-report.mjs`'s Windows
  logic on `main`; both survive in git history.

## Human steps

None. The mission archive moved to the wind-down ticket (D16). After the wind-down PR merges,
the daily "Refresh fork status" run closes #304 and adds `fork-status:removed`. Press **Run now**
on that mission to apply it the same day.

## Ticket slicing

Mission Control slices this plan after its pull request merges. The natural tickets are the
seven units above: W and P1 to P6. They have no blocking edges between them (D20).
