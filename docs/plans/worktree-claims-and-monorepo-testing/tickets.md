# Worktree claims, Warm, and monorepo testing settings - tickets

Sliced from the approved [plan](plan.md), merged in #515. The breakdown review was approved on
2026-10-13: fifteen new tasks, kept in Mission Control only, because no task source is
configured for this repository. All fifteen tickets are filed as Mission Control backlog tasks. The Task column holds each task's id.

Every ticket is also gated on the session that filed it, so none starts before the pull request
that adds this file merges. The tasks are created enabled, so the backlog autopilot may pick
each one up once that pull request and its own blockers have merged.

## How these tickets were filed

The plan's own shape task chose "Create tickets after the plan merges" in its plan review, but
its tickets choice ended `lapsed`: no follow-up task started when #515 merged, and **Create
tickets** was not offered on its card. A new shape task was dispatched instead. Its contract
leaves filing to a follow-up, so the human was asked first, and chose to file the tickets from
that session, gated on its own pull request (round 1, `ticket-route`).

## Tickets

Two tracks run in parallel. The worktree track is tickets 2 to 8 (plan slices 1 and 2). The
testing track is tickets 9 to 15 (plan slices 3 to 5). Ticket 1 stands alone.

| # | Title | Kind | Labels | Blocked by | Task |
| --- | --- | --- | --- | --- | --- |
| 1 | Loopback boundary and MCP-only Command write, stated in the docs | ship | worktree-claims | None | `5d7d284b-f0b3-40bf-8a57-78c8bb152f4c` |
| 2 | Pool claim steps run on every task lease | ship | worktree-claims | None | `8aeb847d-b2f7-4d86-a36b-d8dc2d5edd1d` |
| 3 | Claim settings and slot dependency state in Settings › Worktrees | ship | worktree-claims | 2 | `eae7ae2c-57b7-4901-a5e4-b9ed339e4cb5` |
| 4 | Stopping a running claim from the slot and task cards | ship | worktree-claims | 3 | `c4547422-baf5-4bad-9395-53a5626de097` |
| 5 | Check leases run the pool's claim | ship | worktree-claims | 2 | `f807f13e-045c-4490-9ada-e5fcd81b40d0` |
| 6 | Manual leases claim through 202-and-poll | ship | worktree-claims | 2 | `85747d45-9e3e-4a9d-99ff-25c7200b9105` |
| 7 | Copy-on-write seeding of cold slots from an idle sibling | ship | worktree-claims | 4, 5 | `c027be56-cce1-4a88-8afa-5ad162355af3` |
| 8 | Warm and Warm idle slots | ship | worktree-claims | 7 | `7ae7686f-810b-405b-967c-e38460ebc260` |
| 9 | Stored testing settings at the repository root | ship | worktree-claims | None | `8dee7115-2942-4bb1-96db-c3de9649ce18` |
| 10 | Subdirectory testing scopes | ship | worktree-claims | 9 | `00c43fc5-7fff-470e-8796-104ea34cc94d` |
| 11 | Per-app import resolution for affected-test selection | ship | worktree-claims | 10 | `651bf2fb-5026-411d-96ba-9b665cd19ed0` |
| 12 | Partitioned affected-tests gate per app | ship | worktree-claims | 10 | `340cc707-0fd3-4de0-9c0c-7a55c8fc6cd6` |
| 13 | Commands documents: import, preview, apply and export | ship | worktree-claims | 10 | `8662aa03-6482-49aa-98c6-2ecf3617a706` |
| 14 | Agent-proposed Commands documents | ship | worktree-claims | 13 | `d95bb078-2ef9-49f1-b37a-205a50e671e3` |
| 15 | Set up testing chooses committed or stored settings | ship | worktree-claims | 14 | `f5b782f9-09c9-45fd-88b5-58ec163f0bb6` |

**What can run at once:**

- Tickets 1, 2 and 9 have no blockers.
- Once ticket 2 merges, tickets 3, 5 and 6 can run side by side.
- Ticket 7 waits on tickets 4 and 5, and ticket 8 waits on ticket 7.
- Once ticket 10 merges, tickets 11, 12 and 13 can run side by side.
- Ticket 14 waits on ticket 13, and ticket 15 waits on ticket 14.

**Fork tracking,** from the plan's fork-tracking section:

- Ticket 2 creates the `fork:worktree-dependency-claims` label and its tracking issue, and
  tickets 3 to 8 carry that label.
- Ticket 13 creates `fork:commands-bulk-config`, and ticket 14 carries it.
- Tickets 1, 9 to 12 and 15 extend #296 `fork:flake-aware-testing`.

## Decisions

Recorded as answered. "Rec." marks an answer that took the recommended option. The plan's own
decisions, plan review and repair rounds were not reopened.

### Round 1: route and slicing

| Id | Question | Answer |
| --- | --- | --- |
| `ticket-route` | How the tickets get filed, given that this session's shape contract leaves filing to a follow-up | File them from this session, gated on its pull request, with this file beside the plan. The human authorized this departure from the shape contract (rec.) |
| `granularity` | How finely to cut the plan's five slices | Tickets sized to one agent's context window, about fifteen (rec.) |
| `tracks` | Whether the worktree work and the testing work block each other | Two parallel tracks: slice 1 then 2, and slice 3 then 4 and 5 (rec.) |
| `docs-ticket` | Where section 7's docs fixes that are already true today go | One small docs ticket with no blockers. The claim docs and the "build rather than an install" rewrite stay with the claim tickets (rec.) |
| `labels` | Backlog labels | One label for the whole set, `worktree-claims`. Fork labels stay on the pull requests (rec.) |
| `follow-ups` | Whether the plan's follow-ups become tasks now | No, only the plan's five slices (rec.) |

### Round 2: draft breakdown

| Id | Question | Answer |
| --- | --- | --- |
| `lease-kind-rollout` | Whether ticket 2 claims on task leases only, with check and manual leases claiming in tickets 5 and 6 | Yes: each lease kind starts claiming in the ticket that makes waiting on it safe (rec.) |
| `derived-details` | Whether the seven derived details stand | Accepted as written (rec.) |

The seven derived details, accepted as written:

1. Ticket 2 has no UI. It is proved through the worktrees settings API and unit tests, and
   ticket 3 adds the editor and the slot states.
2. The claim registry, maintenance skipping a claiming slot and shutdown killing claims land
   in ticket 2. Without them, the first long claim would block maintenance and hang shutdown.
3. Ticket 4 waits on ticket 3, because the slot card's Stop sits on ticket 3's "installing"
   state.
4. Ticket 7 waits on tickets 4 and 5: a Stop during a seed sets `interrupted`, and the cold
   check fallback seeds too.
5. Slice 3 is split by scope: the root first (ticket 9), then subdirectories (ticket 10).
6. Ticket 13 waits on ticket 10, not only ticket 9, because a document carries subdirectory
   testing rows.
7. The tickets are created enabled.

### Breakdown review

Every ticket was approved as a new task. None of the seven open backlog tasks, all labelled
`inspector-findings`, was adopted. Mirroring was declined, because no task source is
configured for this repository.

## Ticket 1: Loopback boundary and MCP-only Command write, stated in the docs

Kind: `ship`. Labels: `worktree-claims`. Blocked by: None. Plan slice: 7. Task: `5d7d284b-f0b3-40bf-8a57-78c8bb152f4c`.

**What to build:** The docs and code comments stop overstating what keeps an agent from writing settings. The security docs say plainly that the loopback boundary has no token on `/api/*`, so any local process, an agent's shell included, can call settings routes, and they name the write-hardening follow-up. Every place that calls `set_affected_tests_command` the one Command write an agent may make says instead that it bounds what an agent may do through MCP.

**Blocked by:** None - can start immediately.

**Acceptance criteria:**
- [ ] The security docs state that `/api/*` accepts any loopback caller without a token, and name the tokenless-loopback-writes follow-up from the plan.
- [ ] The protocol, testing-setup and route comments and the flaky-tests docs that describe `set_affected_tests_command` as the only agent Command write say it bounds agents through MCP, and that `/api/*` routes accept any loopback caller.
- [ ] No behavior changes. The docs link check passes, and every unit test that reads these docs still passes.
- [ ] The PR follows the plan's fork-tracking section: the `set_affected_tests_command` wording belongs to #296 `fork:flake-aware-testing`.

**Test seams:** the docs link check and the unit tests that read the repository's docs.

Context: read docs/plans/worktree-claims-and-monorepo-testing/plan.md (sections "Checks and affected tests", "Decisions this plan supersedes" and 7) first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 2: Pool claim steps run on every task lease

Kind: `ship`. Labels: `worktree-claims`. Blocked by: None. Plan slice: 1. Task: `8aeb847d-b2f7-4d86-a36b-d8dc2d5edd1d`.

**What to build:** A pool can be given a claim: ordered dependency steps that run inside every task lease, after reset or add and setup, and before the final proof, so a dispatched task's slot has dependencies for its commit. Steps get the scrubbed check environment plus only the variables each names. A slot whose fingerprint matches skips them, and a failed claim hands the slot over with a warning instead of quarantining it. The claim is configured through the worktrees settings API here. Check and manual leases keep today's behavior until their own tickets.

**Blocked by:** None - can start immediately.

**Acceptance criteria:**
- [ ] The pool's `worktrees` entry accepts `claim.steps` (argv plus variable names), `timeoutMinutes` (default 10, max 240) and `fingerprintPaths`, strict and bounded like `setupArgv`, and settings backups capture it.
- [ ] Each step gets the scrubbed check base plus only its named variables, from the daemon environment or the login-shell snapshot, with stdin closed. Setup moves onto the same base with the union of the pool's names, and the release notes say so.
- [ ] The fingerprint hashes the blob ids of matching paths at the leased commit (read from objects), every argv and every variable name. A match skips the steps. A mismatch, or an empty `fingerprintPaths`, runs them.
- [ ] One durable write sets `deps_state` and clears the fingerprint before any step runs. Success records `current` with the fingerprint, and failure records `failed`. Startup quarantines a slot whose claim was interrupted, with `deps_state = interrupted`, and no later claim skips on a stale fingerprint.
- [ ] Output streams into a bounded tail and never fails a claim, and a timeout kills the process group. A failure hands the slot over with a warning, and the agent's launch prompt names the failing step and its tail. A claim that dirties a tracked file still fails the final proof.
- [ ] A claim registry tracks running claims. Maintenance skips a claiming slot instead of waiting, and retries it next pass. Shutdown kills running claims and grants nothing.
- [ ] Worktree docs cover the claim, fingerprints, both environments and crash recovery, and rewrite the "build rather than an install" line.
- [ ] This PR creates the `fork:worktree-dependency-claims` label and tracking issue.

**Test seams:** unit tests on the worktree manager with fake steps: fingerprint skip and mismatch, failure handover, dirty-file quarantine, timeout, output size, per-step environments, login-shell fallback, setup environment, crash injection after the write-ahead and mid-step, maintenance skip, shutdown kill.

Context: read docs/plans/worktree-claims-and-monorepo-testing/plan.md (section 1, "Crash and restart recovery", and "Delivery order" item 1) first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 3: Claim settings and slot dependency state in Settings › Worktrees

Kind: `ship`. Labels: `worktree-claims`. Blocked by: 2. Plan slice: 1. Task: `eae7ae2c-57b7-4901-a5e4-b9ed339e4cb5`.

**What to build:** In Settings › Worktrees an operator edits a pool's claim (its steps, each step's variable names, the timeout and the fingerprint paths) and sees each name marked present or missing, never its value. Each slot card shows its dependency state: current, stale against origin's default branch, never installed, installing (with the step and elapsed time), failed (with the tail) or interrupted.

**Blocked by:** ticket 2 (Pool claim steps run on every task lease).

**Acceptance criteria:**
- [ ] The pool row edits the claim fields and saves them through the existing worktrees settings route, with schema errors shown inline.
- [ ] Each variable name shows present or missing in the daemon environment or the login-shell snapshot. No value reaches the browser.
- [ ] The slot view carries the dependency state and the fingerprint's commit. Stale is computed against the last fetched default-branch ref, so building the inventory never fetches. Changes arrive through the existing worktrees revision bump.
- [ ] A Playwright spec covers the claim editor with present and missing indicators and the slot card states, with every agent binary faked and no `data-testid`.

**Test seams:** unit tests for the inventory's dependency state and the presence check; the e2e spec.

Context: read docs/plans/worktree-claims-and-monorepo-testing/plan.md (section 1, "Environment" and "What the operator sees") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 4: Stopping a running claim from the slot and task cards

Kind: `ship`. Labels: `worktree-claims`. Blocked by: 3. Plan slice: 1. Task: `c4547422-baf5-4bad-9395-53a5626de097`.

**What to build:** While a dispatch waits on a claim, its task card shows "Installing dependencies" with the running step and elapsed time, and both the task card and the slot card offer Stop. Stop kills the claim's process group and hands the slot over as a failed claim, so the dispatch continues with the warning. Cancelling the dispatching task stops its claim too, instead of waiting it out.

**Blocked by:** ticket 3 (Claim settings and slot dependency state in Settings › Worktrees).

**Acceptance criteria:**
- [ ] The task view carries a provisioning phase while its dispatch waits on a claim, delivered through the existing task upsert event. After the lease, a failed claim leaves a warning on the task.
- [ ] Stop on either card finds the claim through the claim registry, kills its process group and hands the slot over as a failed claim. `deps_state` follows the plan's Stop rule.
- [ ] Task cancel during a claim stops it, and the dispatcher tears down as it does today.
- [ ] A dispatching task still counts toward Foreman's session limit while it claims.
- [ ] A Playwright spec shows "Installing dependencies" with Stop on the task card, and Stop on the slot card, with every agent binary faked.

**Test seams:** unit tests for Stop and task cancel through the claim registry; the e2e spec.

Context: read docs/plans/worktree-claims-and-monorepo-testing/plan.md (section 1, "Stop", "What the operator sees" and "Who waits on a claim") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 5: Check leases run the pool's claim

Kind: `ship`. Labels: `worktree-claims`. Blocked by: 2. Plan slice: 1. Task: `f807f13e-045c-4490-9ada-e5fcd81b40d0`.

**What to build:** Check attempts, including the cold fallback worktree, run the pool's claim before the check's Command. A failed claim does not run the Command. The attempt records a dependency failure with the tail, and the change owns it only when the branch changed a fingerprint input against its merge base. Otherwise it is infrastructure and is retried. While a claim runs, the attempt gives up its check-concurrency slot, and cancelling the run stops its claims.

**Blocked by:** ticket 2 (Pool claim steps run on every task lease).

**Acceptance criteria:**
- [ ] Check leases and the cold check fallback run the claim under the same rules as task leases.
- [ ] A failed claim skips the Command and records a dependency failure with the tail.
- [ ] If a fingerprint-input blob differs between head and merge base, the check fails with the tail as its output. If none differs, or the pool has no fingerprint paths, it is infrastructure, retried up to the existing infrastructure cap with the run budget handed back.
- [ ] The attempt releases its check slot while claiming and takes one again before spawn. Ladder order, budget reservation and the test lease are unchanged, and a third check runs while two claim.
- [ ] The command timeout still starts at spawn, so a slow install ends as a dependency failure, never a timed-out check.
- [ ] Run cancel stops the running claims of its attempts.
- [ ] The worktree docs' check-lease section covers the claim and the slot release.

**Test seams:** unit tests on the check-lease manager and the engine with fake claims: the verdict for changed, unchanged and absent fingerprint inputs, the cold fallback claiming, the slot release, run cancel.

Context: read docs/plans/worktree-claims-and-monorepo-testing/plan.md (section 1, "Failure", "Check verdict on a failed claim" and "Who waits on a claim") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 6: Manual leases claim through 202-and-poll

Kind: `ship`. Labels: `worktree-claims`. Blocked by: 2. Plan slice: 1. Task: `85747d45-9e3e-4a9d-99ff-25c7200b9105`.

**What to build:** `make session` and `make claude` get a slot whose dependencies match, even when the claim runs longer than one HTTP request. For a pool with a claim, the manual acquire route accepts with 202 and a request id and runs the acquire in the background, and the session script polls until the lease is granted or fails, printing the step and elapsed time. A pool with no claim still answers 201 synchronously, so older scripts keep working.

**Blocked by:** ticket 2 (Pool claim steps run on every task lease).

**Acceptance criteria:**
- [ ] For a pool with a claim, manual acquire pins HEAD, returns 202 with a request id, and runs the acquire under the same manual owner.
- [ ] A request status route returns `claiming` (step and elapsed time), `granted` (the lease and any claim warning) or `failed` (the reason). A request unknown after a restart is a 404.
- [ ] A grant not picked up within 10 minutes is returned through the ordinary owner-authorized return, with the clean and occupancy checks. An occupied slot stays leased.
- [ ] A pool with no claim answers 201 with the lease, as today.
- [ ] The session script accepts 201 and 202, polls every 2 seconds, and reports a 404 after a 202 as a daemon restart during the claim.
- [ ] The `make session` docs describe the 202-and-poll.

**Test seams:** route tests for 202 through claiming to granted and to failed, the pickup window, 201 compatibility and 404 after a restart; a script test against both 201 and 202.

Context: read docs/plans/worktree-claims-and-monorepo-testing/plan.md (section 1, "Who waits on a claim" and "The manual route, when the pool has a claim") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 7: Copy-on-write seeding of cold slots from an idle sibling

Kind: `ship`. Labels: `worktree-claims`. Blocked by: 4, 5. Plan slice: 2. Task: `c027be56-cce1-4a88-8afa-5ad162355af3`.

**What to build:** A claim on a slot with no fingerprint, or with a stale one where an idle sibling matches exactly, first clones the pool's seed paths copy-on-write from an idle sibling, so a cold slot inherits a sibling's dependency trees instead of paying a full install. The source is held under a new `warm` lease while it is copied. Where the filesystem cannot clone there is no seed, never a byte copy. A slot interrupted mid-seed loses its verified-ignored seed paths and starts cold.

**Blocked by:** ticket 4 (Stopping a running claim from the slot and task cards), ticket 5 (Check leases run the pool's claim).

**Acceptance criteria:**
- [ ] The pool claim gains `seed.paths` and `seed.exclude`, editable in the claim editor.
- [ ] A `warm` lease owner kind is granted and released through the ordinary lease paths and never shown as a task. Its owner is referenced exactly while its operation runs, and definitely not referenced at startup.
- [ ] The source is an idle sibling whose fingerprint matches the target commit, else the most recently claimed idle sibling, never the main checkout. With none idle there is no seed.
- [ ] Each path is cloned into staging in the pool directory and renamed into place, with exclusions removed first, so the checkout never holds a half tree. A failed clone abandons the seed and the steps run. After a seed the target inherits the source's fingerprint.
- [ ] A Stop during a seed sets `interrupted`. The next claim removes only seed paths git confirms are ignored, fails with a warning on a tracked or not-ignored match, and reruns every step when no seed paths are configured.
- [ ] Startup applies the plan's crash-recovery rows for seeds and sources and removes leftover staging. The cold check fallback seeds under the same rule.
- [ ] A Playwright spec covers the seed fields, with every agent binary faked. Worktree docs cover seeding.

**Test seams:** unit tests with a fake copy command that refuses reflink: source order, the `warm` lease preventing an occupancy quarantine, staging and rename, exclusions, no seed without copy-on-write, the interrupted wipe, crash injection between renames and mid-copy with a source held.

Context: read docs/plans/worktree-claims-and-monorepo-testing/plan.md (section 2 up to "Warm", and "Crash and restart recovery") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 8: Warm and Warm idle slots

Kind: `ship`. Labels: `worktree-claims`. Blocked by: 7. Plan slice: 2. Task: `7ae7686f-810b-405b-967c-e38460ebc260`.

**What to build:** An operator prepares idle slots ahead of time. **Warm** on an available slot's card, and **Warm idle slots** on a pool row, queue an operation that takes a `warm` lease on each target, fetches, resets it to origin's current default branch, seeds or claims under the existing rules, then releases it. The operation shows a live output tail and a Cancel control, and its full log stays reachable from the slot card after a restart.

**Blocked by:** ticket 7 (Copy-on-write seeding of cold slots from an idle sibling).

**Acceptance criteria:**
- [ ] The worktree action vocabulary gains `warm`, through preview and execute, per slot and per pool.
- [ ] Warm never touches a leased or quarantined slot. A slot leased while a pool Warm is queued is skipped and listed as skipped.
- [ ] The operation view shows a live tail, refreshed through the worktrees revision bump at most once a second, and links the full log under the state directory. The slot keeps the path of its most recent log.
- [ ] Cancel kills the process group and returns the slot as available, with `deps_state` following the Stop rule.
- [ ] Startup returns a slot still held by a `warm` owner through the ordinary return path with `deps_state = interrupted`, quarantining only on doubt. A log no live operation or slot references is removed.
- [ ] A Playwright spec covers Warm and Warm idle slots with the live tail and Cancel, and calls `expectContentClearsBorder` for any new modal, with every agent binary faked.
- [ ] Worktree docs cover Warm.

**Test seams:** unit tests on the worktree operations service: idle-only targeting, Cancel during a seed and during a step, crash injection mid-Warm and with leftover logs; the e2e spec.

Context: read docs/plans/worktree-claims-and-monorepo-testing/plan.md (section 2, "Warm" and "Crash and restart recovery") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 9: Stored testing settings at the repository root

Kind: `ship`. Labels: `worktree-claims`. Blocked by: None. Plan slice: 3. Task: `8dee7115-2942-4bb1-96db-c3de9649ce18`.

**What to build:** A repository can have an affected-tests gate configured entirely in Mission Control. On the affected-tests page in Library › Commands, a "Testing settings" section edits the root's `tests.patterns`, `tests.includeImporters` and `tests.smokeSet`. Stored settings overlay the committed testing file key by key, and the local file stays the operator's last word. The gate runs with stored settings and no committed file, and run detail says where every effective key came from.

**Blocked by:** None - can start immediately.

**Acceptance criteria:**
- [ ] A new stored testing settings catalog, keyed by the same canonical path as Command overrides and carrying a revision, is added through the migration path.
- [ ] Its schema allows only the three `tests.*` keys, strict and within today's limits, and refuses `flakes`. The committed and local schemas and the merge stay compatible, so the CI action still bundles them.
- [ ] At the root, layers merge committed, then stored, then local. The gate runs when any layer exists and is skipped when none does. An invalid stored row cannot be saved, and the committed and local file rules are unchanged.
- [ ] Run detail labels each effective key `committed`, `stored (<scope>)` or `local`, extending today's local-keys line.
- [ ] A stale save is refused with 409 and the row reloads.
- [ ] A `testing-settings` settings-backup domain ships with a missing-domain migration, so older snapshots restore with it empty.
- [ ] Workflow docs cover stored settings, layering and the supersession of "committed and reviewed like code" for `tests.*`.
- [ ] A Playwright spec edits the root row and sees the run detail sources, with every agent binary faked.
- [ ] The PR extends #296 `fork:flake-aware-testing`, whose behavior contract changes.

**Test seams:** unit tests for layer order and per-key sources, the gate with no committed file, the schema refusing `flakes` and the backup migration; a route test for the 409; the e2e spec.

Context: read docs/plans/worktree-claims-and-monorepo-testing/plan.md (section 3 up to "Scopes and the test universe") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 10: Subdirectory testing scopes

Kind: `ship`. Labels: `worktree-claims`. Blocked by: 9. Plan slice: 3. Task: `00c43fc5-7fff-470e-8796-104ea34cc94d`.

**What to build:** Testing settings can be stored for a subdirectory, such as one app of a monorepo, and they take effect on which tests the gate selects. A subdirectory's keys replace the root's for files inside it, its patterns and smoke set are relative to it, and keys it does not set fall through. Selected files still run through today's single invocation until per-app partitioning lands.

**Blocked by:** ticket 9 (Stored testing settings at the repository root).

**Acceptance criteria:**
- [ ] A server resolver produces a browser-safe `TestingScopes` value: ordered scopes, each with its repository-relative path, effective settings and the source of every key, plus a nearest-scope lookup. Nested scopes apply nearest first, and the local file stays root-only.
- [ ] Per scope, the test universe is the tracked files matching that scope's effective patterns, resolved relative to the scope that set them. `includeImporters` and `smokeSet` apply per scope.
- [ ] Test selection takes `TestingScopes` in place of one flat config. Selected files run through the one override the session's cwd resolves, as today, and the selection diagnostics record that per-app aliases are not yet resolved.
- [ ] The Testing settings section lists the root and every subdirectory with stored settings or an affected-tests override, each editable.
- [ ] A Playwright spec edits a subdirectory row, with every agent binary faked.

**Test seams:** unit tests on a fixture monorepo with two subdirectory scopes and no root tsconfig, including relative patterns and smokeSet; `TestingScopes` shape tests that tickets 11 and 12 reuse; the e2e spec.

Context: read docs/plans/worktree-claims-and-monorepo-testing/plan.md (section 3, "Layers" and "Scopes and the test universe") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 11: Per-app import resolution for affected-test selection

Kind: `ship`. Labels: `worktree-claims`. Blocked by: 10. Plan slice: 4. Task: `651bf2fb-5026-411d-96ba-9b665cd19ed0`.

**What to build:** An import inside a monorepo app selects its importer's tests even when it goes through that app's own path aliases or a workspace package name. Selection resolves each file's imports through the nearest tsconfig or jsconfig at or above it, following `extends`, and through the root workspaces' package names.

**Blocked by:** ticket 10 (Subdirectory testing scopes).

**Acceptance criteria:**
- [ ] Each scanned file uses the nearest `tsconfig.json` or `jsconfig.json` up to the tree root, following relative `extends` and any package `extends` resolvable inside the tree, with its `paths` and `baseUrl` and today's extension swaps. An unresolvable `extends` is a diagnostic, not fatal. Parsed configs are cached per gate.
- [ ] Wildcard replacement handles every `*`, not only the first.
- [ ] Workspace globs, in array or `{packages}` form, map package names to directories. A bare name resolves through a string `exports`, else `main`, else `index`, and `name/sub` resolves inside the workspace. Richer `exports` maps are reported in diagnostics.
- [ ] Resolution still refuses anything outside the tree, and scope universes are unchanged.
- [ ] The diagnostics no longer report per-app aliases as unresolved.

**Test seams:** unit tests on test selection: the nearest tsconfig with relative `extends`, workspace names bare and with a subpath, the wildcard fix.

Context: read docs/plans/worktree-claims-and-monorepo-testing/plan.md (section 4, "Resolving imports") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 12: Partitioned affected-tests gate per app

Kind: `ship`. Labels: `worktree-claims`. Blocked by: 10. Plan slice: 4. Task: `340cc707-0fd3-4de0-9c0c-7a55c8fc6cd6`.

**What to build:** A monorepo change runs each touched app's tests in that app. The gate selects once, assigns each selected test to the deepest affected-tests override whose subdirectory contains it, runs one invocation per partition in its subdirectory, and passes only if every partition passes. Run detail lists every partition, and any selected test no command could run.

**Blocked by:** ticket 10 (Subdirectory testing scopes).

**Acceptance criteria:**
- [ ] A test outside every subdirectory override goes to the root override or the slot's global default. A test none of them can run is listed as selected but unrun, and the gate decides on the partitions that ran.
- [ ] Each partition runs its override's command in its subdirectory, with files relative to it and its own temporary JUnit path mapped back to tree paths, and reruns its failed files once.
- [ ] Partitions run sequentially, all of them, inside the one check-test lease.
- [ ] One gate attempt spends one run of the budget however many partitions it has. An attempt that selects nothing hands the run back.
- [ ] Partitioning does not depend on the session's cwd, which still picks the test, lint, typecheck and build overrides.
- [ ] Run detail lists each partition's subdirectory, command, file count, outcome and output tail, and the unrun tests.
- [ ] Workflow docs cover partitions.
- [ ] A Playwright spec shows partitions in run detail, with every agent binary faked.

**Test seams:** unit tests on a fixture monorepo with two apps and a package: partitions, one budget run per attempt, sequential execution, the unrun listing; the e2e spec.

Context: read docs/plans/worktree-claims-and-monorepo-testing/plan.md (section 4, "Partitioning") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 13: Commands documents: import, preview, apply and export

Kind: `ship`. Labels: `worktree-claims`. Blocked by: 10. Plan slice: 5. Task: `8662aa03-6482-49aa-98c6-2ecf3617a706`.

**What to build:** An operator configures a repository's Command overrides and stored testing settings from one document. In Library › Commands they paste or upload a versioned JSON document, pick the repository, review a preview of every add, change and removal, and apply it in one step. They can also export a repository's current overrides and testing settings as a document, and importing it back changes nothing.

**Blocked by:** ticket 10 (Subdirectory testing scopes).

**Acceptance criteria:**
- [ ] A versioned document schema sits in the shared wire contracts, with repository-relative paths (empty for the root), command overrides per slot, testing settings and explicit removal entries. It never touches global defaults, run budgets or pool settings.
- [ ] Each entry is checked against its catalog's existing rules: the affected-tests template rule, duplicate refusal and the override cap.
- [ ] Unmentioned rows are untouched, listed rows are added or replaced, and only explicit removals remove.
- [ ] Apply writes everything in one transaction, using each slot's compare-and-swap and the testing catalog's revisions. A stale preview is refused with 409 and recomputed.
- [ ] Export, then import, round-trips.
- [ ] Library and settings docs cover documents and export.
- [ ] A Playwright spec covers import preview and apply, and export. Every new modal calls `expectContentClearsBorder`, and every agent binary stays faked.
- [ ] This PR creates the `fork:commands-bulk-config` label and tracking issue.

**Test seams:** unit tests for schema validation, the merge with removals, the template rule, the stale 409 and the round trip; the e2e spec.

Context: read docs/plans/worktree-claims-and-monorepo-testing/plan.md (section 5, "Format", "Applying", and the import and export parts of "Two producers, one screen") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 14: Agent-proposed Commands documents

Kind: `ship`. Labels: `worktree-claims`. Blocked by: 13. Plan slice: 5. Task: `d95bb078-2ef9-49f1-b37a-205a50e671e3`.

**What to build:** An agent session can propose a Commands document for its own task repository through a new MCP tool, `propose_command_document`, without writing any live row. The proposal shows as a banner on that repository in Library › Commands and as an attention item, and opens the same preview, where the operator applies or dismisses it.

**Blocked by:** ticket 13 (Commands documents: import, preview, apply and export).

**Acceptance criteria:**
- [ ] The tool accepts only the calling session's own task repositories, using the guard `set_affected_tests_command` uses, without its testing-setup label restriction.
- [ ] It stores one pending proposal per repository, and a newer one replaces the older. Pending proposals are not in backups.
- [ ] The banner and the attention item lead to the import preview. Applying or dismissing clears the proposal.
- [ ] Docs say the approval step bounds the MCP surface only, because `/api/*` accepts any loopback caller.
- [ ] A Playwright spec covers the banner, the attention item and applying a proposal, with every agent binary faked.
- [ ] The PR carries `fork:commands-bulk-config`.

**Test seams:** unit tests for the guard refusing another repository and for a newer proposal replacing an older one; the e2e spec.

Context: read docs/plans/worktree-claims-and-monorepo-testing/plan.md (section 5, the proposal part of "Two producers, one screen") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 15: Set up testing chooses committed or stored settings

Kind: `ship`. Labels: `worktree-claims`. Blocked by: 14. Plan slice: 5. Task: `f5b782f9-09c9-45fd-88b5-58ec163f0bb6`.

**What to build:** The "Set up testing" action asks the operator to choose committed or stored before the task starts. Committed is today's path. Stored has the agent work out per-app overrides and testing settings and submit them as a Commands document proposal, which the operator applies from the preview, so a repository that will not commit a testing file still gets a gate.

**Blocked by:** ticket 14 (Agent-proposed Commands documents).

**Acceptance criteria:**
- [ ] The action offers committed or stored before the task starts.
- [ ] The testing-setup skill text and the task's launch prompt carry the choice. Committed still writes the testing file and calls `set_affected_tests_command` unchanged. Stored submits with `propose_command_document`.
- [ ] Docs describe both paths.
- [ ] A Playwright spec covers the choice, with every agent binary faked.
- [ ] The PR extends #296 `fork:flake-aware-testing`.

**Test seams:** prompt and skill contract tests for both choices; the e2e spec.

Context: read docs/plans/worktree-claims-and-monorepo-testing/plan.md (section 6) first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.
