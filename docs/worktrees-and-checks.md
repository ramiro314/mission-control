# Isolated worktrees

Running several agents in **one** working tree is a recipe for clobbering - one
agent's branch switch or edit lands under another's feet. Mission Control therefore gives every
new task, Workflow check, and approved manual development session an isolated checkout through
one daemon-owned native allocator.

The owner may be an ordinary checkout or a bare clone. A bare clone owns its native pool
through its physical Git directory, and tasks execute in linked working checkouts. The
disposable Git fallback supports the same owners. Bare metadata named `.git` is still the
owner itself, not its parent folder. For bare metadata named `.bare` or `.git`, pool and
checkout names use the containing repository folder's name so working checkouts are not
named like hidden metadata.

One tree per session, with one exception. A
[multi-repo task](dispatch-and-backlog.md#attaching-more-than-one-repository) is dispatched
with a worktree per attached repository. Each comes from that repository's native pool, or
from a disposable Git worktree when native allocation is disabled or positively cannot
reserve a slot, and all of them are handed to one session. Everything on this page then
applies per tree: each is leased, pinned and reclaimed on its own. Provisioning is
all-or-nothing, so a dispatch that cannot cut one of them hands back the ones it already took
rather than starting an agent with half its repositories.

### Where a dispatch starts

An ordinary task - one whose caller named no commit - freezes a base before anything is
provisioned. Mission Control proves whether the repository has a remote named exactly `origin`,
fetches it, then asks that remote for both halves of one answer: which branch it advertises as
HEAD, and the commit that branch is on. The frozen base is the commit the remote stated, and the
local remote-tracking ref has to agree with it - which is what proves the fetch brought that exact
object down. A remote that advanced between the fetch and the observation disagrees, and is
refused for retry rather than quietly frozen at the older commit. Every repository the task
attaches is frozen the same way
and before the first worktree is taken, so a failure in the third repository costs an error rather
than two leases to unwind.

The refusals are deliberate. A configured `origin` that cannot be fetched, a remote HEAD that
cannot be proved, and a default branch that was advertised but not fetched all fail the dispatch
before any tree or agent exists. So does a `git remote` listing that never answered - only a
listing that succeeded and did not name `origin` establishes a repository with no remote, and only
that repository freezes its current local `HEAD` instead. The remote is asked rather than the
checkout's cached `refs/remotes/origin/HEAD`, because a fetch does not refresh that cache after a
server-side default-branch rename. When another fetch wins Git's remote-tracking-ref update race,
Mission Control retries that known-safe local refusal up to two times. Authentication, network,
timeout, overflow, and every other fetch failure still fail closed without an automatic retry.
A fetch stopped by its 30-second limit says so, with the limit, rather than reporting an exit
status Git never returned.

A repository with `origin` configured but no refs at all is refused before anything is fetched.
That is what a `git clone` looks like while it is still downloading, since it writes config and
`origin` first and its refs only once the whole pack has arrived. It is also what a repository
that was initialized and given a remote but never fetched looks like. Fetching either would
download the entire history inside a limit sized for an incremental update, beside any clone
still writing the same object store, and a large repository cannot finish. The task returns to
Backlog saying the repository has no commits yet: let a running clone finish, or run
`git fetch origin` in it once, then launch again.

Bare clones are fetched into `refs/remotes/origin/*` explicitly, since `git clone --bare`
does not create that fetch mapping. The same rule keeps mirror fetch configuration from
rewriting local branches used by linked worktrees. Remote-default freshness checks remain
the same as for ordinary clones, and the verified branch is recorded as `origin/HEAD` for
local status and reset operations.

An explicit pinned base bypasses all of this: it is verified to be a real full commit ID in that
repository and used unchanged, with no fetch. A pin names one commit in one repository, so a
task's attached repositories still resolve their own remote defaults.

### Native pools

Native pooling is enabled by default. The daemon lazily creates exact-commit, detached Git
worktrees beneath `MISSION_HOME/worktree-pools`, keyed by Git's physical common directory rather
than by the checkout path used to reach it. Released slot directories remain in place so ignored
dependencies and build caches stay warm for the next lease. A repository-specific disable uses a
cold disposable Git worktree beneath `MISSION_HOME/worktrees` instead.

A slot never crosses a task boundary holding a branch. Reset detaches the checkout at the exact
requested commit before it hard-resets and cleans, and both state transitions that hand a slot on
- finalizing a lease and marking a returned slot available - independently prove path, repository,
exact HEAD, cleanliness and detached HEAD from Git before they complete. An attached slot, or one
whose detached state cannot be proved, is quarantined rather than leased. That makes acquisition
repair a warm slot left attached by an older build on its next use.

Detaching releases the checkout, never the name: the previous occupant's branch ref stays exactly
where it was, and the reset's clean step still spares ignored files, so warm caches survive.

Every slot carries a random lease ID and an exact task, check, or manual owner. Task and check
rows persist that ID before work starts. Cleanup reads the recorded provider and lease ID rather
than deciding again from current configuration, and refuses a stale lease or any slot whose
process occupancy cannot be proved empty. Startup reconciliation uses the same rules.

An observation read gets one retry before it counts as unknown. The process and cwd listings
behind occupancy and an owner lookup that throws each try once more in the same pass, 2 seconds
later and with double the timeout. A listing too large to buffer is not retried, because asking
again cannot make it smaller. So do `git worktree list` and each Git read of a slot
inspection when they timed out or were killed; a Git that exited with its own error is answered
at once, because it would say the same again. A PID that an otherwise healthy cwd listing
omitted is first re-read on its own, one at a time and stopping at the first re-read that does
not answer, and only one that is still unresolved, and still alive with the same start time,
leaves occupancy unknown. A read
that fails twice records both attempts, for example "git status timed out after 15 s, and after
30 s on retry". A command killed at its timeout is named as a timeout, and one killed by another
signal names that signal, so neither reads as "exit 1".

A read that still fails proves nothing about a slot, so it never quarantines one. Reconcile,
including a pool whose `git worktree list` or pool marker cannot be read at all, and the idle
screening that acquisition, Warm and seed-source selection share leave every slot they could not
read in the state it was in: leased stays leased, available stays available, quarantined stays
quarantined. The slot's last error records "Last observation failed: `<reason>`", its card shows
that on its own line, and the next read that succeeds clears it. A quarantined slot keeps the
detail of its quarantine under that line. Such a slot is never leased, reset or returned while it
is unknown: acquisition does not lease a slot it could not prove idle in this pass, and Lease,
Return, reset, Recover, Prune and Destroy still refuse on unknown, exactly as before. The reasons
that count as a failed read, including the ones older builds quarantined with, are one exported
set in `src/server/worktrees/quarantine-reasons.ts`, so rows already in the database qualify
without a migration.

Only a proven fault quarantines: an inexact path, a missing registration once listing succeeded,
a bare, locked or prunable registration, a different common directory, an interrupted
provisioning or prune (judged before any Git or process read, and even when the pool's listing
or marker cannot be read, so a failed read never keeps one; only a prune whose folder is already
gone waits for a listing to tell a finished removal from a fault), an interrupted return proven
occupied, dirty or off its target commit (one whose read failed waits for the next pass to prove
and complete it), a dirty available slot, an available slot whose HEAD moved or that carries an active lease identity, an incomplete identity, a leased slot whose owner is positively
gone, a reset or verification that failed, and a pool identity or marker that is missing,
malformed or belongs to another pool. A process inside an available slot is not a fault: the slot
stays available, acquisition passes over it, and its card lists the process as an
[orphan process](#orphan-processes) with **Kill**. A reservation that a
read refused before anything in the slot changed - its occupancy became unknown, or a process
entered it, before the reset - goes back to available as it was, and the acquisition reports it
as not acquired, so a task falls back as it does for any refusal. One whose mutation outcome is
unknown is still quarantined, and so is a reservation that could not be handed back, as "a
refused reservation could not be handed back to available"; only those report an unknown
outcome. That reason is deliberately outside the failed-read set, because whether the hand-back
landed is unknown.

Each quarantine, each recovery, each restore to `leased`, each automatic-recovery refusal and
each slot left unchanged after a failed read writes one `[worktrees]` line to the daemon's output,
naming the pool and slot. A refusal or failed read is logged only when the slot's reason changes, so a pass repeating
the same one stays quiet.

A reservation quarantined before its lease is granted - a failed or unproven reset, creation,
setup command, or verification, or a lost lease commit - drops its active owner in the same
transition, because that owner never received the lease ID and could never return it. The slot
stays quarantined and Destroy removes it through the ordinary revalidation. Reconcile repairs the
same state left by an earlier build: a quarantined slot whose owner is positively proven not to
reference its active lease loses that identity and stays quarantined. Unknown ownership is left
untouched.

A slot an earlier build quarantined only because a read failed, while its owner was alive, goes
back to that owner. Reconcile returns a quarantined slot to `leased` when its reason is in the
failed-read set, its active lease was granted, its active identity is complete, its owner is
positively referenced, and this pass read it: registration exact, Git readable, path and common
directory matching, occupancy known. Granted means `finalizeLease` ran, which the row shows as
`last_used_at` no earlier than `leased_at`. The reason cannot prove that, because earlier builds
took these reasons in any state, and a manual owner's row answers for itself. A reservation
quarantined before its grant therefore stays quarantined, for its card's Return. An interrupted
return leaves no such mark, so it resumes as a lease too, and its owner's ordinary return, which
proves the tree again, finishes it. The compare-and-swap, `WorktreeStore.restoreLease`, changes the slot's state and clears its
quarantine fields, and nothing on disk is touched: HEAD, the index and every file stay as they
were, and a slot may be dirty and occupied, as any live lease may. A slot whose owner cannot be
read stays quarantined and records that on its card. One whose owner is positively gone loses its
identity as above and stays quarantined; it is not restored.

`make session` is a loopback client for that daemon-owned inventory:

```sh
make session                                  # acquire, warm, and open your shell
make session ARGS="--label review -- claude" # label it and launch a command
make session ARGS="--return <lease-id>"       # return one exact durable lease
make session ARGS="--return-lease <lease-id>" # explicit spelling of the same action
```

Under the hood (`scripts/new-session.mjs`):

1. **Acquire** a manual lease from the running daemon's loopback API. When the pool has a
   [dependency claim](#dependency-claims), this waits for the claim, as described below.
2. **Warm** it (`scripts/worktree-setup.mjs`): install dependencies so the session starts fast.
3. **Hand it over** with `MISSION_WORKTREE` and `MISSION_WORKTREE_LEASE_ID` set, opening your
   `$SHELL` or the command after `--` in the tree.

**Waiting on a claim: 202, then poll.** A claim can run far longer than one HTTP request: up to
its `timeoutMinutes`, which may be 240. Node's `fetch` gives up after 300 seconds without
response headers, and a lease granted after its caller gave up would belong to nobody. So
`POST /api/worktrees/manual/acquire` has two answers. `make claude` goes through the same script
and gets the same handling.

- **The pool has no claim.** The route answers `201` with `{path, leaseId, baseSha}` straight
  away, as it always has, so a `make session` from an older checkout keeps working against a
  newer daemon.
- **The pool has a claim.** The route pins `HEAD` as before, answers `202` with
  `{requestId, baseSha}`, and runs the acquire in the background, claim included, under the same
  `manual:<key>` owner. `make session` polls `GET /api/worktrees/manual/requests/<requestId>`
  every 2 seconds. Each poll gets one of three states:
  - `claiming`, with `elapsedMs` and the running `step` (its number, the step count, the
    command and its own `elapsedMs`). `step` is null while the slot is still being chosen,
    reset or set up. The script prints the step and the elapsed time as it goes.
  - `granted`, with the `lease` and, when the claim failed, a `claimWarning` with the failing
    step and its output tail. A failed claim still hands the slot over, so the script prints
    the warning and opens the session anyway.
  - `failed`, with the `reason` the acquire was refused or could not be proven. The script
    prints it and exits without launching anything.

Pending requests live in daemon memory, never in the database:

- **A restart.** A poll after a restart answers `404`, and the script reports that the daemon
  restarted during the claim. Startup reconcile recovers the slot the claim was preparing (see
  "Crash and restart recovery" under [Dependency claims](#dependency-claims)). A grant made before the restart and never picked
  up is an ordinary manual lease, which **Settings > Worktrees** shows and can Return.
- **The pickup window.** A poll that reads `granted` picks the lease up. A grant nobody picks up
  within 10 minutes is returned by the daemon through the ordinary owner-authorized return, with
  its clean and occupancy checks, so a lease nobody received does not leak. A slot that is dirty
  or has a process in it stays leased, and Settings can return it. A poll that arrives after the
  window answers `failed`, never the returned slot.
- **Brief outages.** Each poll gets 5 seconds to answer, headers and body together, so a daemon
  that accepts a poll and never answers cannot hold the script. The script rides out a daemon
  that stops answering for up to a minute, counted from the first unanswered poll, so a restart
  reaches the `404` above instead of a connection error.

The lease stays durable after the shell exits. Return it explicitly with either command above,
using the lease ID printed by `make session` or exported as `MISSION_WORKTREE_LEASE_ID`. A slot path
is reusable and never authorizes a return. If the daemon is unavailable, `make session` tells you
to start it and exits without allocating a standalone worktree. **Settings > Worktrees** reads
and acts on the same durable lease. The command is useful from a shell; the panel adds the safety
preview and the surrounding pool, Git, process, and owner state.

Native capacity and enablement are configuration policy. The shipped policy is enabled with 16
slots per physical repository. A repository override affects its next acquisition, never an
active lease.

### Dependency claims

A warm slot keeps whatever its last occupant installed, which is not necessarily what the next
commit needs. A pool's **claim** closes that gap. It is an ordered list of dependency steps that
runs inside every task lease, every check lease and every manual lease, after the reset or add
and after the setup command on a new slot, and before the final proof. A dispatched task's slot,
a check's, and a `make session` slot therefore have dependencies for the commit they were leased
at. A check that falls back to a throwaway Git worktree runs the same claim there (see
[Check leases](#check-leases)). A manual lease waits on its claim through the 202-and-poll
described under [Native pools](#native-pools).

The claim is per pool, with no global default. It is stored beside `setupArgv` in that
repository's `worktrees` entry, so settings backups capture it, and it is set through
`PUT /api/worktrees/config`:

```json
{
  "repositories": {
    "/Users/me/code/web/.git": {
      "claim": {
        "steps": [
          { "argv": ["yarn", "install", "--immutable", "--mode=skip-build"], "env": ["ARTIFACTORY_AUTH_TOKEN"] },
          { "argv": ["yarn", "rebuild"], "env": [] }
        ],
        "timeoutMinutes": 10,
        "fingerprintPaths": ["yarn.lock", ".yarnrc.yml", "package.json", "apps/*/package.json", ".yarn/releases/**"],
        "seed": {
          "paths": ["node_modules", "apps/*/node_modules", "packages/*/node_modules", ".yarn/install-state.gz"],
          "exclude": ["**/node_modules/.cache"]
        }
      }
    }
  }
}
```

- `steps` holds 1 to 16 argvs, never a shell, each bounded like `setupArgv`. `env` lists up to 32
  variable **names**; Mission Control never stores a value. `PATH` and names starting with
  `MISSION_`, `FLEET_` or `HARNESS_` are refused, because those are the daemon's own.
- `timeoutMinutes` covers the whole claim, every step together, including the time spent
  building each step's environment and resolving its executable (either may wait on a
  login-shell read). A step only starts with time left, and gets only that remainder. It
  defaults to 10 and may be at most 240.
- `fingerprintPaths` holds up to 64 repository-relative globs. They are matched with Node's
  `path.matchesGlob`, so a wildcard does not match a segment that starts with a dot, and a
  dotfile directory is named literally (`.yarn/releases/**`). A glob that cannot be a
  repository-relative path is refused: a leading `/`, a `.` or `..` segment, an empty segment,
  or a backslash.
- `seed` is optional. `seed.paths` holds 1 to 64 repository-relative globs naming the ignored
  dependency trees a cold slot clones from a sibling (see "Seeding" below). Each segment is a
  literal name or a one-level pattern such as `apps/*/node_modules`. `**` is refused, because
  matching it would mean walking every installed tree to find what to clone. `seed.exclude` holds
  up to 64 globs removed from the clone before it is placed, and these may use `**`
  (`**/node_modules/.cache`). The seed is not a fingerprint input: it changes how a cold slot
  gets its dependencies, never which dependencies a commit needs.
- A patch's `claim` replaces the whole claim, and `"claim": null` removes it.

**Fingerprints.** Before a claim runs, Mission Control hashes three inputs:

- the Git object ids of every path at the leased commit that matches `fingerprintPaths`, read
  with `git ls-tree` from objects rather than from the checkout;
- every step's argv;
- every step's variable names.

The hash is recorded on the slot only after every step succeeds. When the next claimed lease
computes the same hash, the steps are skipped, so a slot that already matches costs nothing. Any
change to a matching file, an argv or a name runs the steps again. An empty `fingerprintPaths`
means the claim runs on every lease.

**Seeding.** A full monorepo install is the slow part of a cold slot, and an idle sibling slot
usually holds the very trees it needs. A claim whose pool configures `seed.paths` therefore
seeds before its steps run when either of these holds:

- the slot is cold: it is new, was never claimed, its last claim failed, or its last claim or
  seed was interrupted. A slot whose last claim succeeded is not cold, even when its claim lists
  no fingerprint paths and so recorded no fingerprint, or every lease would copy a sibling's tree
  over its own fresh install;
- its fingerprint is stale, **and** an idle sibling's fingerprint matches the leased commit's
  exactly. A slot whose last claim succeeded with no fingerprint, before fingerprint paths were
  configured, is stale as soon as the claim can compute one.

Otherwise the claim runs in place, so a small lockfile change stays an incremental install.

- **The source** is an idle sibling: an available slot of the same pool, with no active lease,
  whose last owner is provably gone, with no process inside, and whose last claim succeeded. It
  is screened by the same code acquisition screens an available slot with, so a sibling
  acquisition would quarantine is quarantined here too, and is never a source. A sibling whose
  read failed is left available with the failure recorded, and is not a source this time. The first choice
  is one whose fingerprint matches the leased commit's, and the next is the one most recently
  claimed successfully, including one whose claim recorded no fingerprint. A stale slot takes
  only the first choice. The main checkout is never a source. With no idle sibling
  there is no seed, and the steps run alone.
- **The `warm` lease.** The source is leased to a `warm` owner for the length of the copy,
  through the same reservation, `finalizeLease` and release paths as any lease. Nothing can
  lease, reset or quarantine it meanwhile: a process in a leased slot does not quarantine it, and
  another acquisition never sees it as available. Settings shows the owner as **warm**, "Seeding
  another slot's dependencies" (or, for a slot a Warm holds, "Warming this slot ahead of time";
  see [Warm](#warm)), with no Return or Destroy, and never as a task. The owner is
  referenced exactly while its seed runs in this daemon. Nothing about it is stored anywhere
  else, so at startup every `warm` owner is definitely not referenced. The source goes back to
  the pool through the ordinary owner-authorized return as soon as its clone is staged, before
  anything is placed in the target. A source is only read, so its fingerprint stays valid.
- **Copy-on-write only.** Each path is cloned with `cp -c -R` on macOS (clonefile) or
  `cp -R --reflink=always` on Linux. Where the filesystem cannot clone, `cp` refuses and there is
  no seed. It is never replaced by a byte copy, which would be slower than the install. The clone
  runs from the pool's directory, never from inside a slot. `cp` is the pinned `/bin/cp`, never
  a PATH search, because those flags are the platform's own: a GNU `cp` found first on a Mac
  would not clone.
- **Only ignored paths.** Every matched path must be ignored by Git in the target and hold
  nothing tracked (`git ls-files`, then `git check-ignore`, asked with a trailing slash for a
  directory). A path whose parent directory the target's commit does not have is left out.
  `.git`, in any letter case and at any depth, is never a seed path: the schema refuses it, and
  expansion drops it whether it was named or matched by a pattern, because on a case-insensitive
  disk `.Git` is the checkout's own Git administrative pointer.
- **Staging, then rename.** Each matched path is cloned into
  `<pool directory>/.seed-staging/<id>/`, on the same volume and outside every checkout, and the
  exclusions are removed there. Only then is each path renamed into the target, with any existing
  tree renamed aside first. A path in the checkout is therefore the old tree, absent for one
  rename, or the whole new one. The staging directory is removed when the seed ends. A Stop
  and the claim's deadline are checked before every rename and once more after the last, so a
  seed either one ends while it is being placed is recorded `interrupted`, never `current`, even
  when its source matched the leased commit.
- **After a seed** the target inherits the source's fingerprint, and the ordinary skip rule
  decides. A source that matched the leased commit records `current`, and the steps are skipped.
  Any other seed is followed by every step.
- **An incomplete seed inherits nothing.** A seed inherits the source's fingerprint only when
  it replaced every seed path the target has with the source's own. It is incomplete when an
  exclusion removes a whole matched path (the target keeps its own copy), when a source path is
  left out because the target's commit lacks its parent directory, or when the target holds a
  seed path the source does not have (the target's own, possibly stale, copy stays). Then what
  was placed is not the source's tree, the target inherits no fingerprint, and every step runs.
  Exclusions that remove every path are no seed at all: the target is untouched and the steps
  run.
- **A failed clone** abandons the seed, removes its staging, and the steps run. It is not a
  failed claim, and the target was never touched. So does a placement whose first rename fails
  before anything in the target changed, as when the cold check fallback's tree sits on another
  volume than the pool's staging and the rename is refused with `EXDEV`. A rename that fails
  after something was placed or moved aside records `interrupted`.
- **One deadline.** The seed spends the claim's `timeoutMinutes` together with the steps. Every
  phase of a seed checks the Stop and that deadline: expanding the globs, proving the paths
  ignored (each Git call is bounded by what is left of the claim's time, and by a minute at
  most), each clone, the exclusion walk, and placement. Whichever lands first ends the seed as
  `interrupted`. The interrupted wipe works within the same budget: it checks both before each
  Git call and between the entries of every seed path it removes, so a large `node_modules`
  cannot hide a Stop, and a wipe that a Stop or the deadline ends leaves the slot `interrupted`.
- **An exclusion walk that cannot read** a directory in the clone, or cannot look up the staged
  clone itself, for any reason other than it having vanished, abandons the seed and the steps
  run. The excluded content may
  still be in that directory, so the clone is never placed.
- **A tree that cannot be inspected is never read as empty.** Expanding the seed paths treats
  only a path that is genuinely not there as no match. A permission or I/O error while listing a
  directory or looking up a path abandons the seed, so the steps run, and fails an interrupted
  wipe without removing anything, so the slot stays `interrupted` and its next claim tries
  again.

**The environment.** Each step gets the same scrubbed base a check command gets (see "A trimmed
environment" under [Running a check command](#running-a-check-command)), plus only the variables
its own `env` names:

- A named value comes from the daemon's environment, or else from the operator's login shell.
  The locator's login-shell read, the same one that reads `PATH`, captures the named variables
  alongside it. A value that is empty everywhere is missing, and so is one that carries the
  daemon's own token.
- A credential reaches only the step that names it. Another step, the setup command and a check
  never receive it by accident.
- Stdin is closed, so a step that stops to ask a question fails at once.

**The setup command's environment changed too.** Setup still runs once, when a slot is created,
for every lease kind, with its 120-second limit. It now runs on the same scrubbed base, plus the
union of every name the pool's claim lists. A setup command that relied on a credential-shaped
variable from the daemon's environment, such as `NPM_TOKEN`, no longer receives it. List the name
on a claim step to give it back.

**Output, timeout and failure.**

- Each step's stdout and stderr stream into one 4,000-byte tail, the same bound checks use.
  Output size never fails a claim.
- A step may print the variables it was given. Before a failure is stored, shown in Settings
  or written into the agent's note, every value the step received is replaced in its tail and
  reason with `[NAME redacted]`. The tail keeps only the end of the output, so a tail that
  starts partway through a value has that leading piece redacted too, when it is at least four
  characters long. Every match is found in the original output before anything is replaced, so
  values that overlap or contain one another are all removed, and overlapping matches become one
  marker naming each variable, such as `[A_TOKEN, B_TOKEN redacted]`. A value the step transformed before printing, for example by encoding it,
  is not recognized.
- The slot row records a failure as a versioned JSON record: the step, the step count, the
  command (cut to 512 bytes), the reason, the tail and how many bytes the tail dropped.
  Settings reads those fields directly. A failure an earlier build stored as plain text shows
  only its first line, the command and the reason. Its output is never sent to the browser,
  because it was stored before redaction existed and may hold a value that cannot be
  recognized now, for example one since rotated. The card says the output is withheld, and the
  slot's next claim replaces the record.
- A timeout sends SIGTERM to the step's process group, then SIGKILL after five seconds, and
  counts as a failed claim.
- A failure is a non-zero exit, a timeout, or a step that cannot start. The remaining steps do
  not run. The slot is **handed over with a warning and never quarantined for the exit code**.
  The slot's fingerprint stays cleared, so the next lease runs the claim again.
- The agent's launch prompt then opens with a "Dependency install warning" note. It names the
  failing step, its command cut to 512 bytes, and its output tail, so the agent can install or
  repair dependencies itself, and can tell a dependency failure from one its own change caused.
- Claim steps must not rewrite tracked files. A claim that leaves a tracked file modified, an
  untracked file Git does not ignore, or a branch attached fails the final proof, and the slot
  is quarantined as any other unproven materialization is. `yarn install --immutable` is one way
  to honor that.

**Crash and restart recovery.** Before anything touches the tree, one durable write records the
slot's `deps_state` as `claiming` and clears its fingerprint. A seed writes `seeding` the same
way once its source is held, before any clone starts. Success then records `current` with the
new fingerprint, and failure records `failed` with the failing step and its tail. A daemon that
dies anywhere after that write leaves no fingerprint for a later lease to trust. Startup finds
the slot still `provisioning` and quarantines it as an interrupted provisioning intent, exactly
as it does after a restart during setup, and marks its `deps_state` as `interrupted`, whether it
found `claiming` or `seeding`. That marking happens on every reconciliation path, including one
that quarantines the whole pool because its identity or marker cannot be proven, and one that
leaves every slot as it was because the pool's registrations or marker could not be read. If that slot
ever returns to the pool, its next claim first removes the pool's seed paths, then starts cold:
it seeds if a sibling qualifies, and runs every step either way. That recovering claim never
skips the steps on an inherited fingerprint, even from an exact match. The write-ahead does not
record which seed paths the cut-off seed touched, and the operator may have narrowed
`seed.paths` since, so the wipe can only remove the paths configured now. The steps repair
whatever an older configuration's seed left behind.

- **The interrupted wipe** removes a seed path only once Git confirms it is ignored and holds
  nothing tracked. A matched path that is tracked, or not ignored, is never removed, and then
  nothing else is either: the claim fails with a warning naming the path, and the lease is
  granted with it. A wipe that fails partway, after removing some paths, fails the same way.
  Either way the slot stays `interrupted` rather than `failed`, so the obligation to remove its
  seed paths stays with it and its next claim tries the wipe again before anything else. A pool
  with no `seed.paths` has nothing to remove, and the claim runs every step.
- **A seed source** that a crash left leased to its `warm` owner is returned at startup through
  the ordinary return path: the occupancy check, the reset to origin's default, and the clean,
  detached proof. It becomes available with its fingerprint intact. A source the return cannot
  prove, for example one a process is still inside, is quarantined.
- **A Warm's target** that a crash left leased to its `warm:<operationId>` owner is returned the
  same way. Its claim ran with the slot leased rather than provisioning, so startup finds the
  lease with a `claiming` or `seeding` write-ahead, records `deps_state = interrupted`, and the
  ordinary return makes it available. Its next claim removes the seed paths and starts cold.
  A target the return cannot prove, such as one an orphaned step is still running in, is
  quarantined. No Warm survives a restart: its operation lived only in daemon memory, so startup
  finds every `warm` owner definitely unreferenced, never unknown.
- **Warm logs** under `logs/worktree-warm/` that no slot row names are removed once startup has
  reconciled the pools. A slot row keeps naming its most recent Warm's log, so that log survives.
- **Seed staging** under `<pool directory>/.seed-staging/` that no live seed owns is removed by
  every reconciliation, first, before any check that can fail the whole pool. A pool whose
  identity or marker cannot be proven still loses its leftover staging, because removing it
  touches no checkout. It is removed only when the pool's directory lies inside the daemon's
  pools directory and the staging root is a real directory there, never a symlink.

A claim step's process group that outlived the daemon still has its working directory inside
the slot. The occupancy check therefore sees it, and the slot is never handed out while it runs.

**Maintenance and shutdown.** The manager keeps an in-memory registry of the claims running
right now. Periodic maintenance skips a slot whose claim is running instead of waiting for it,
because a claim may run for hours. The pool's reconciliation record names the skipped slot, and
the next pass retries it. Shutdown kills every running claim's process group before anything
else stops, and grants no claimed lease from then on. The slot is left `provisioning` with
`deps_state = claiming`, and the next startup recovers it as above.

**Stop and task cancel.** A running claim can be stopped from its slot card in Settings and from
the task card of the dispatch waiting on it. Both send `POST /api/worktrees/:slotId/claim/stop`
with the running claim's own id, so a Stop can never land on a later claim in the same slot. The
manager finds the claim through its claim registry, sends SIGTERM to the step's process group
(SIGKILL after five seconds), and fails the claim with the reason "was stopped". The slot is
handed over as for any failed claim: the lease is granted with the warning, `deps_state`
becomes `failed`, and the next claim reruns the steps in place. The dispatch then continues and
launches its agent with the warning note. A route answer of 404 means that claim had already
finished. A manual lease's claim has only the slot card's Stop, and `make session` then receives
the grant with the warning.

Cancelling a task whose dispatch is waiting on a claim stops that claim too, once the task is
recorded as cancelled. The stopped claim hands its slot over at once, the dispatch finds the
task settled, and it tears the tree down exactly as it does for any cancel it notices. A task
with attached repositories provisions them one at a time, and stops provisioning further
repositories once the task is no longer dispatching, so no later repository's claim starts in
place of the stopped one. A Stop, a cancel or the claim's timeout decides `deps_state` by when it
lands. During a step it records `failed`, like any failed claim, and the next claim reruns the
steps in place. During a seed, including while its paths are renamed into place, it records
`interrupted`, because the renames may be half done,
and the next claim removes the seed paths and starts cold. Either way the lease is granted with
the warning.

**What the task shows.** While a dispatch waits on a claim step, its placeholder in the Board's
and the Console rail's Working group says **Installing dependencies**, with the step, the
elapsed time and **Stop**, in place of "Provisioning its worktree". It is the task's
`provisioning` field, a projection of the claim registry that the daemon derives on every
`task_upsert` and re-sends as the claim starts a step or ends. It is never stored, so a restart
drops it with the claim. A dispatching task stays `dispatching` while it claims, so Foreman keeps
counting it against its session limit. After the lease, each failed claim is recorded on the task
as `claimWarnings` (the `tasks.claim_warnings` column, cleared by the next dispatch), and the
session's task band shows it as **Dependency install failed in `<repository>`**, with the step,
its reason, the command and the output tail.

**Editing a claim and watching it.** Open a pool's disclosure in **Settings > Worktrees** to
edit its claim under **Dependency claim, run on every task lease**:

- Each step's command is entered one argument per line, so an argument keeps its spaces. Blank
  lines are dropped, because the schema refuses an empty argument anyway. Variable names are
  separated by spaces, commas or newlines, which no name can contain.
- **Save claim** sends the whole claim through `PUT /api/worktrees/config`. The daemon's schema
  is the only validator. A refusal is placed beside the field it names: a variable name under
  its step, a glob under the fingerprint paths or the seed field that holds it, a timeout under
  the timeout. Nothing is saved while any field is refused. **Remove claim** sends
  `"claim": null`.
- **Seed paths** and **Seed exclusions** take one glob per line. Leaving both blank saves a claim
  that never seeds. Exclusions with no seed paths are refused beside the seed paths, rather than
  dropped.
- Each saved variable name shows **present** or **missing**, and where a present one was found:
  in the daemon's environment, or in the login shell. This is the same rule a step's
  environment uses, so the two cannot disagree. The value itself never leaves the daemon. A
  name typed since the last save says "save to check", because only saved names are looked up.

Each slot card of a pool with a claim shows the slot's dependency state:

| State | Meaning |
|---|---|
| never installed | No claim has run in this slot. Its next task or check lease runs every step. |
| current | The last claim succeeded, and its fingerprint matches the claim's fingerprint at the fetched default branch. Also shown when no default can be read, or when the claim lists no fingerprint paths, since neither is evidence of staleness. |
| stale | The last claim succeeded, but the fetched default branch's fingerprint differs from the slot's. The next lease runs the claim again. |
| installing | A claim is running in the slot right now, with its step, its command, the elapsed time and **Stop**. |
| failed | The last claim failed, timed out or was stopped. The card shows the failing step, its reason, its command and the output tail, with claim variable values redacted. |
| interrupted | A restart, or a stop or timeout during a seed, cut off the slot's last claim. Its next claim removes the seed paths and starts cold. |

The card also names the commit the slot's fingerprint was taken at. **Stale is judged against
the last fetched `origin/<default>` ref**, the same cached ref the card's "Default" relation uses.
Building the inventory never fetches. The default branch's fingerprint is read once per default
commit and claim with `git ls-tree` in the main checkout, and reused until either changes. A claim
publishes the ordinary `worktrees_changed` revision bump as it starts, as each step starts, and as
it settles. That bump is how the card moves between states, and the elapsed time counts up in the
browser between bumps.

#### Warm

A claim runs when something leases a slot, so the first lease after a lockfile change pays for
the install. **Warm** pays it ahead of time, on idle slots, so the next lease finds a matching
fingerprint and skips the steps. A pool with a claim offers two triggers in **Settings >
Worktrees**:

- **Warm** on an available slot's card warms that slot.
- **Warm idle slots** among a pool's maintenance actions warms every available slot of the pool,
  one at a time, so a later slot can seed from one warmed before it.

Both are ordinary worktree actions (`"action": "warm"`, with a `slot` or `pool` target) and go
through the same preview and execute as Return and Destroy. The preview lists the slots it will
warm. Idle means exactly what it means to acquisition: the preview, the slot card's **Warm**
button and the check each slot gets when its turn comes all apply acquisition's one idle rule
(`idleSlotRefusal`), the preview to its last observation and the turn to a fresh screening. A
slot that is leased, quarantined, mid-transition, occupied, not proven clean, still referenced by
its last owner, or already covered by a queued operation is never a target: named directly it
blocks the preview with the rule's own reason, and in a pool Warm it is left out and counted in
the preview. A slot whose fresh screening fails to read it when its turn comes is skipped, not
quarantined, and records the failed read. A pool with no claim, or with native
worktrees disabled, has nothing to warm. Nothing in a Warm discards work, so it asks for no
acknowledgement.

For each slot, in order, a Warm:

1. checks the slot again. A slot that is no longer available and idle by acquisition's own
   screening, for example one a task leased after the Warm was queued, is **skipped**, untouched,
   and listed as skipped in the Warm's report;
2. holds it under a `warm` lease owned by `warm:<operationId>`, through the ordinary reservation
   and `finalizeLease`, so nothing else can lease, reset or quarantine it, and the claim's own
   processes never count as occupancy of an available slot;
3. fetches origin and resets the slot to its current default branch;
4. runs the pool's claim under its usual rules: a matching fingerprint skips the steps, a cold
   slot (or a stale one an idle sibling matches exactly) is seeded copy-on-write, and the steps
   run otherwise;
5. proves the tree exactly as an acquired slot is proved before its grant, and quarantines it if
   a step modified a tracked file or attached a branch;
6. returns it through the ordinary owner-authorized return: the occupancy check, a fresh fetch,
   the reset to origin's default, and the clean, detached proof.

A failed claim is recorded on the slot as any failed claim is, and the slot is still returned.
Warms run one after another on a queue of their own, so a long install never holds up a
Destroy or Return queued behind it. Each one's targets are pending to every other operation, so
the two never share a slot.

**Watching a Warm.** The operations list above the pools shows each Warm with its slots and what
became of each one (waiting, warming, warmed, claim failed, skipped, cancelled or failed), and,
while it runs, a live output tail: the last 4,000 bytes of the claim's output, with every claim
variable value removed. The value is removed even when the pipe splits it across two writes, and
even when the step's other pipe writes between the two halves: stdout and stderr are redacted
separately, each holding back what could still be the start of a value, and each releases whole
lines, so the two interleave at line boundaries. The
tail reaches the dashboard through the ordinary `worktrees_changed` bump, at most once a second
while output arrives. A finished Warm stays listed, with its report and its log, until you
dismiss it, and counts toward the 64 operations that may be listed at once.

**Cancel** on a queued Warm finishes it at once, with every slot cancelled and none touched. On a
running Warm it stops the claim, which sends SIGTERM to the running step's process group and
SIGKILL after five seconds. The slot it holds is returned to the pool as available through the
ordinary return, whose reset discards whatever the stopped step had changed, tracked files
included: only that Warm's own step ran there since the slot was held idle and clean. The return
still proves the reset tree clean and detached, and quarantines the slot if it cannot. (A claim
that changes a tracked file and finishes on its own, uncancelled, still fails the proof and is
quarantined, exactly as at acquisition.) Its
`deps_state` follows the Stop rule: `failed` when the Cancel landed during a step, so the next
claim reruns the steps in place, and `interrupted` when it landed during a seed, so the next claim
removes the seed paths and starts cold. Slots the Warm had not reached are listed as cancelled.
The slot card's **Stop** stops the same claim, but the Warm then carries on with its next slot.

**The full log.** Each Warm writes everything it did and every line of claim output, redacted,
to `logs/worktree-warm/<operationId>.log` under the daemon's state directory, created the first
time the Warm holds a slot. What happened to a slot before that, such as one skipped because it
was leased meanwhile, is written right after the log's header, and every slot a Cancel kept the
Warm from reaching is logged as cancelled. A Warm that never holds a slot writes no log. The log is never cut, and the daemon never holds it in memory: when
the disk falls behind a step that prints faster than it can be written, the step's output pipes
are paused until the log drains, so the step blocks on its own pipe while its time limit keeps
running. The operation links it, and each slot it held records the path as
its `deps_log_path`, so the slot card keeps a **Last Warm log** link after the Warm is dismissed
and after a restart. Both links download through `GET /api/worktrees/warm-logs/<operationId>`,
which serves only a log a listed operation or a slot row names, streamed from the file in bounded
chunks with the length the log had when the download began. A log that neither names is
removed when a Warm finishes, when one is dismissed, after every cleanup operation (a Destroy
or Prune can remove the last slot row naming a log), and once at startup. A slot's earlier log
therefore goes as soon as a later Warm replaces its link and the operation that wrote it is
dismissed, and a slot's last log goes with the slot.

### Settings > Worktrees

Open **Settings > Worktrees** to configure and inspect the allocator. The page answers one
question first - do I have room, and what is holding the rest? - and is split into three groups, in
this order:

- **Pools** leads. Each repository gets one full-width capacity bar whose *track width is that
  pool's configured maximum*, so free capacity, leased slots, quarantine, and overflow read in one
  glance. The bar's segments are leased, available, and quarantined, and the hatched remainder is
  room to grow. Because the track is the maximum and not the occupancy, one slot is the same
  fraction of every bar sharing a maximum, and a bar cannot grow past its own ceiling. Over
  capacity is therefore not a fourth segment and not a wider bar: a pool past its maximum fills
  the track and spills, marked by an amber hatched cap at the track's end and counted in words
  beside it. The tradeoff, taken deliberately: when the slots that fit already consume the
  ceiling, a small trailing state has no width left to draw, so the legend - not the fill - is
  where every count is guaranteed to appear.

  Nothing on the bar is carried by colour, or by the absence of it: the legend beneath
  it names all four lifecycle counts as text in every state - **zeroes included**, because a state
  the track has no width to draw is still one you came here to ask about - the bar itself is an
  image with a composed label naming those same four counts and the maximum, and over capacity is
  spelled **over the maximum** in words. An over-capacity pool offers its right-size preview on
  that row.

  Opening a pool's disclosure shows its effective override, an optional setup argv, the pool's
  dependency claim editor (see "Editing a claim and watching it" under
  [Dependency claims](#dependency-claims)), the maintenance actions, and the bounded slot detail. The argv is operator-authored, stored as separate arguments,
  and runs only when Mission Control creates a new slot. It never runs when a warm slot is leased
  again. It runs on the scrubbed environment described under
  [Dependency claims](#dependency-claims). Each slot carries its exact manager path, observed HEAD, relationship to the remote
  default, cleanliness, process count, disk estimate, and owner, and in a pool with a claim, its
  dependency state. **Copy path** stays in the browser.
  **Open terminal** asks the daemon's registered terminal launcher to open a login shell in the
  manager-known path. On an available slot it first takes a manual lease, so acquisition cannot
  hand out a slot with an unowned shell in it. The lease takes the slot exactly as it stands, with
  no reset and no claim, so HEAD and every file stay as they were, and the shell opens only once
  the lease is held. The card then shows a manual lease labelled "Terminal from Settings", with
  **Return**. The slot must pass acquisition's idle rule on a fresh read, under the slot lock, and
  a slot that does not is refused with the reason and no shell opens: one that is occupied stays
  available, and one that is dirty is quarantined, as acquisition would leave it. A slot attached
  to a branch is refused too, since only a reset can undo that. On a leased or quarantined slot
  Open terminal opens a shell and takes no lease. Closing the shell does not return the lease, as
  with any manual lease, and [Stale live leases](#stale-live-leases) applies to it. A terminal that
  is unknown or unavailable is refused before anything is launched, so the lease is given back with
  no fetch or reset and the slot is available again as it was. A launcher that tried and failed may
  still have opened a shell, so that lease stands and the error says to Return it.

  Each slot card ends in a **History** disclosure: what happened to the slot, newest first, 50
  entries at a time through `GET /api/worktrees/:slotId/history`, each with its state change, its
  reason and detail, and who caused it: the operator (an action run from this page, whichever
  domain owns the lease), automatic (a decision the daemon made on its own, such as retention or
  reclaiming a leaked check lease), or the owner. The list is read only while open, and follows
  the slot while it stays open. Every state transition writes one
  entry in the same transaction as the change, and a failed read adds an entry only when it starts
  and when it clears. See [the database guide](database-and-migrations.md) for retention.

  History also holds the timed steps, and the card shows the last of each as **Last provisioning**,
  **Last claim** and **Last seed**:

  - A **provisioning** entry runs from reservation to granted lease, for a new slot and for a reused
    one. An acquisition that never reached a lease has none, and neither has a Warm or Open
    terminal's lease, which provision nothing.
  - A **claim** entry records the claim's duration, its seed included, and its outcome: succeeded,
    failed, skipped on a matching fingerprint, or stopped by a shutdown. A failed one keeps the
    failing step's command and reason, never its output.
  - A **seed** entry names its source slot and duration. One that placed nothing says why: no idle
    sibling held a current install or matched a stale slot's commit, its siblings could not be read,
    none could be held, the clone was abandoned or cut off, the paths of an earlier cut-off seed
    could not be removed, or the pool's claim configures no seed. A slot that wants no seed, because
    its install still matches, adds no entry, so the last seed stays readable.

  The pool row shows the **median new slot** provisioning time and the **seed hit rate** over the
  pool's last 10 new slots, computed from history whenever it is read, so retention can shorten
  the window. A new slot counts once it is granted, a claim that failed included, and it is a hit
  when a seed placed anything in it before the grant. Acquisition leases an idle sibling before it
  makes a new slot, so a new slot rarely finds a seed source, and a low rate there is the fault
  this number exists to show. A reused slot's seed is in its History and not in the rate.

  The group states loading, empty, and unavailable separately, and never renders a heading over
  nothing. An inventory that could not be observed says so and offers Refresh; it is never drawn as
  zero pools.
- **Defaults** controls the default enablement and maximum, and affects future acquisitions only.
  Each bar above is drawn against its own pool's *effective* maximum, which is **Default maximum
  slots** for every repository that has not set an override - so changing the default visibly
  reflows those bars, and leaves an overridden pool's bar where its own maximum puts it. Lowering
  a maximum below the pool's current count marks the difference **over the maximum** and offers a
  right-size preview; saving policy never deletes a slot. **Stale lease after (days)** (default 7,
  1 to 90) is the one default that is not about acquisition; see
  [Stale live leases](#stale-live-leases).
- **Treehouse** classifies historical Treehouse resources as exact, unverifiable, foreign, or
  unreadable, and shows the four classification counts only when at least one is non-zero. Only an
  exact durable owner with a clean, process-free checkout offers Return.

All mutations begin with a server preview. The dialog lists the fixed paths, owners, disk estimate,
risks, blockers, and consequences. The disk estimate has a short budget: a warm slot with its
dependency install can take seconds to measure, so a preview measures at most four paths at a
time within one budget for the whole set, and any path it could not measure in time reads
"size unknown" instead of holding the dialog. Dirty or unlanded exact targets require an explicit
acknowledgement.

**Execute runs in the background.** The daemon answers as soon as it has consumed the
short-lived token and checked that it is still allowed and that the acknowledgements are exactly
the ones the preview asked for. The dialog then closes, and the rest of the work goes into one
ordered queue: it observes the lease, task or check owner, processes, Git state, and slot version
again, then mutates. You can keep previewing and executing while earlier cleanups finish. Queued
and running cleanups are listed above the pools, and each affected slot shows the pending action
and offers no second one. A Warm is listed there too, with its own live view, and runs on a queue
of its own (see [Warm](#warm)). A preview that names a slot which already has a cleanup queued is
blocked for that slot, and Safe prune leaves such a slot to its own cleanup, so no dialog offers
an Execute that could only be refused. At most 64 operations may be listed at once, counting queued and running
cleanups and failure reports you have not dismissed. Beyond that, Execute says so and leaves the
preview open, so it can be executed again once there is room. A failure report is never removed
to make room: it leaves only through **Dismiss** or an accepted retry.

A changed target fact or affected set refuses with a stale preview message. Because the recheck
runs after Execute has answered, that refusal appears in the same list above the pools, with
**Preview again** to build a new preview of the same request from current state, and **Dismiss**.
A report stays listed until you dismiss it or its **Preview again** is executed; cancelling that
retry keeps it. A stale refusal changes nothing on disk. A failure partway through a set of removals is reported
as **partly done**: it lists each worktree already removed, says how many were left in place, and
its **Preview again** asks only for the ones it left. A destroy is always retried as the fixed
set of slots it was accepted with, minus those already removed, so a pool destroy's retry never
picks up a slot that joined the pool after the failure. Process churn in unrelated slots and inventory reconciliation
timestamps do not invalidate an unchanged target. Unknown process occupancy is never
acknowledgeable.

The operations have deliberately narrow meanings:

- **Return** hands an active lease back through its owner. Task Return uses the ordinary task
  cleanup, including multi-repository accounting and required archive or snapshot capture. Its
  preview therefore lists every native, legacy, or disposable Git path that task cleanup will
  touch, even when Return began from one slot. Check Return uses the recorded check provider and
  process-group recovery. Manual Return uses the exact durable lease. A successful native Return
  resets to the freshly fetched remote default - the branch the remote advertises now, proved the
  same way dispatch proves it - leaves the slot detached and clean, and keeps the warm slot.

  A quarantined slot whose active owner is still referenced offers Return too, since the owner's
  own return accepts a quarantined lease. Its card names the owner (the task's title, the check,
  or the manual lease with the label `make session --label` gave it) and says "Its owner's return
  brings this slot back." The preview is that owner's ordinary Return preview, so a task Return
  still lists every tree the task holds. It is refused while any process is inside the
  quarantined slot, the task's own agent included, and when the owner's reference is gone or
  unknown. An owner that is gone leaves the slot to Recover instead.

  A `warm` lease is the one owner neither Return nor Destroy can act on, whatever its state. While
  its seed runs, the preview says the seed returns the slot when its copy ends. A seed interrupted
  by a restart is not coming back: reconcile returns its lease, the preview says so until then,
  and if the lease cannot be returned the slot is quarantined with that dead owner still on it.
  Its preview then points at Recover, which clears it.
- **Prune** removes only the clean, merged, process-free, unreferenced available slots enumerated in
  its preview. Right-size is the same safety rule restricted to capacity above the configured
  maximum.
- **Reconcile** re-observes durable state, Git registration, ownership, and processes. It repairs
  only states whose result is positively proven and quarantines only a proven fault; a slot whose
  read failed keeps its state and says so on its card, and a slot quarantined only by a failed
  read goes back to its referenced owner (see [Native pools](#native-pools)).
- **Destroy** removes one exact manager-owned slot, the fixed slot set enumerated for one pool, or
  a bulk selection. Each destroyable slot has a checkbox, and a pool's **Select all slots** adds
  every destroyable slot in it; the selection may span pools. **Destroy selected** previews exactly
  the ticked slots as one fixed set, so one Execute queues the whole cleanup. The selection is
  exactly what you ticked and is never narrowed for you: a selected slot that has since
  disappeared stays in it, the selection bar counts it as no longer available, and the preview
  names it and is blocked until you clear or change the selection - even when every selected
  slot is gone. One selection holds at most 128 slots, the most one bulk request may name:
  **Select all slots** fills the remaining room and says how many did not fit, and an unticked
  slot cannot be added while the selection is full.
  Destroy may discard dirty or unlanded work only after those risks are acknowledged. It has no target
  meaning every pool and cannot override unknown identity, ownership, registration, or process
  state.
- **Recover** brings back a quarantined slot that no live owner references. It is offered on
  every such slot's card, and Settings > Storage lists each quarantined slot as a problem whose
  **Open slot** link jumps to that card. Its preview names the slot's `index.lock` (under the Git
  directory its `.git` file names), any Git process whose working directory is in the slot, and
  each entry the reset would discard, which must be acknowledged. Execute runs the same
  owner-authorized reset Return ends in, and the slot becomes available. It removes `index.lock`
  as the reset's last check, once the target is fetched and the work check has passed, and only
  when no Git process uses the worktree and `lsof` shows nothing holding the lock. A slot with a
  live or unknown owner, any process inside it, or a lock it cannot prove free is refused, and a
  refusal leaves the lock in place.

  Recover keeps the slot's folder, so it counts work by the **reset rule**, against origin's
  default fetched for the preview. A reset runs `checkout --force`, `reset --hard` and
  `clean -fd`, never `-fdx`, so it keeps an ignored file while that file stays ignored and
  nothing the default tracks lands on it. Work is an uncommitted change, an untracked file that is
  not ignored (other than ai-conductor's disposable `.pipeline/` scratch), unpushed commits, or an
  ignored entry outside the regenerable directories (`node_modules/`, `dist/`, `build/`,
  `coverage/`, `.cache/`, `.turbo/`, `.next/`) that the reset would overwrite or delete:
  - the default tracks a path at, under or above it, where above means a file, symlink or
    submodule in place of one of its parent directories. Paths are compared after Unicode
    normalization and case folding, always, so `.Idea/x` in the default overlaps an ignored
    `.idea/` whatever `core.ignorecase` says;
  - the default's `.gitignore` files no longer ignore it, so `clean -fd` deletes it.

  A warm install (`node_modules/`, `.yarn/install-state.gz`), an IDE folder, build info, `.env` or
  evidence that the default still ignores and does not track is therefore not work: Recover asks
  for no acknowledgement and the reset keeps each file where it is. The preview names each entry
  that is work and why, such as "ignored .idea/ (the target tracks .idea/codeStyles/Project.xml)".
  The check writes nothing in the slot. It reads a bounded listing of the default's tracked paths
  and a `.gitignore` diff, and only when a `.gitignore` differs, or the slot has a `.gitignore`
  of its own that is changed, staged or untracked, evaluates the default's rules with
  `git check-ignore` in a private temporary repository, holding the default's `.gitignore` files,
  the common directory's `info/exclude`, and the slot's `core.excludesFile` and `core.ignorecase`.
  Any of those steps that fails, overflows or times out counts the entries it could not clear as
  work. The reset checks the work set again once it has fetched its own target, and Execute
  refuses when the default moved to a commit whose work set differs from the preview's. The
  preview names at most 20 entries, but that comparison covers every one. Safe Kill
  and the other return checks keep the stricter rule, which counts every ignored file outside the
  regenerable directories.

  Recover is the
  way out of the stale-lock quarantine: a Git command that dies holding `index.lock` makes the
  next reset fail with Git's "Unable to create '...index.lock': File exists", and the slot is
  quarantined with that text as its last error.

  Each maintenance pass also runs Recover's automatic half, with no operator, on every quarantine
  that a fresh read can disprove: one whose last error is that lock text, one whose reason is a
  failed read (the set in `src/server/worktrees/quarantine-reasons.ts`, older builds' reasons
  included), and "available slot is dirty" or the "available slot is occupied or dirty" that older
  builds wrote. A slot quarantined for its identity is never cleared here, however healthy it
  reads and whatever its last error says, because a read that happens to succeed repairs nothing.
  A slot quarantined for its registration takes **Repair** instead, which tries Git's own fixes
  first and then applies the same safety line.

  The safety line is the same for all of them. The slot's active and last-released owners must be
  positively gone, its occupancy known and empty, its registration exact, a fresh Git read must
  succeed, and it must hold no work by the reset rule above, against origin's default. The slot
  then takes the ordinary owner-authorized reset and becomes available, keeping its warm install.
  The reset rule is judged again inside the reset, against the commit it fetched, so a default
  that moved between the check and the reset is refused with every file unchanged. The pass never
  discards work: a slot with an occupant, a live or unknown owner, a failed read or any work stays
  quarantined, exactly as it was, until someone runs Recover and reads its preview.

  The `index.lock` checks apply only to a lock-caused quarantine. There the slot comes back when
  the lock is gone, or when the lock is more than 10 minutes old and the same no-Git-process and
  no-holder check passes. Any other quarantine leaves a lock alone, and a reset that lock then
  refuses records Git's text, so the next pass judges the slot as lock-caused.

  Each refusal is recorded with the exact path that blocked it, when there is one: the first entry
  the reset would discard, with its kind (an uncommitted change, an untracked file, an ignored
  file or unpushed commits on `HEAD`), or the slot's `index.lock` for a lock-caused refusal. The
  record is kept in memory for the quarantine it judged, so a restart drops it until the next
  pass.

  A slot's card shows why it is in its state, each fact on its own line: the quarantine reason,
  the detail behind it (such as Git's own error), why its last observation failed, why its
  processes are unknown, the last
  automatic-recovery refusal with the path that blocked it, and the processes inside the slot
  with PID, command and start time. The inventory carries at most 16 of those processes per slot,
  each command bounded to 512 bytes, and the card counts the rest. A process already listed with
  its own Kill is not listed twice.

  A quarantined slot raises the bannered storage problem `quarantined-slot:<slot id>:<entered>`,
  where the entry time is the slot's own `quarantined_at` column, so the id survives a daemon
  restart. A slot quarantined before that column existed is stamped once by the first start that
  finds it.
- **Repair** is the way out for a slot quarantined because Git's registration of it is bare,
  locked, prunable, or names another path. Each maintenance pass tries it with no operator, on
  every such slot, and a quarantined slot's card offers it once the slot's owner is positively
  gone. Recover needs a proven registration, so Repair is the one that can start from a broken
  one.

  It runs only when no owner is referenced, no process is in the slot (which covers a Git
  process with its working directory there), and no claim runs. An unknown owner or unknown
  occupancy refuses it. It then applies only Git's own fixes, each decided from the files Git
  itself reads:

  - a registration locked `initializing`, which an interrupted `git worktree add` leaves, is
    unlocked with `git worktree unlock`. Any other lock refuses Repair. That includes a lock an
    earlier build left in another language, because Git translates that word and a translated
    lock cannot be told from a reason someone wrote. Slots are now added with `LANGUAGE=C`, so
    new locks always read `initializing`;
  - a `.git` file that is missing or wrong, while an administrative directory under
    `<common>/worktrees/` still names this path, is fixed with `git worktree repair`;
  - a `.git` file naming an administrative directory whose `gitdir` points elsewhere is fixed
    with `git worktree repair <path>` from the main checkout. A pass reads this as a missing
    registration, because Git lists it under the path it names. If the folder it names still
    exists, even without its `.git`, the registration may belong to that checkout, and Repair
    refuses.

  Neither form of `git worktree repair` stops at one worktree: each also rewrites any other
  worktree's `.git` file in the repository that is already broken, and the preview says so.

  A bare registration, a folder that is gone, a `.git` that is not a file, and a registration no
  administrative directory can be traced to all refuse, and the card shows why, with **Forget**
  as the fallback where it applies. A `git worktree
  list` that fails says nothing about the slot, so its preview asks you to try again, and nothing
  runs. Moving a folder aside to register it again never happens here. After a fix, Repair reads
  the registration again instead of trusting Git's exit code, then takes automatic recovery's
  checks and reset. The
  preview names each fix, and Execute refuses a registration or an occupant that changed after
  it. Repair asks for no acknowledgement, because it never discards work.

  A slot that holds work by the reset rule is not reset. It stays quarantined as "registration
  repaired; holds work", with that entry as its detail, and no pass touches it again until
  someone reads Recover's preview. A `git worktree add` cut off before its checkout usually lands
  here too: without an index every tracked file reads as a change, which cannot be told from
  work. A recovery refused for any other reason, such as an unreachable origin, leaves the fix in
  place and the reason as it was, so the next pass, finding the registration healthy, finishes it.
- **Forget** is the fallback when Repair refuses or cannot prove a result. A quarantined slot's card
  offers it, once the slot's owner is positively gone, in four cases: the folder is gone, the slot
  belongs to a different Git common directory, the slot's registration belongs to another path that
  still exists, or a prune was interrupted with files still present (including one whose removal
  could not be verified). These are read from the slot as it stands, because a quarantine keeps its
  first reason whatever happens to the folder later. A registration that is gone while its folder
  remains is not one of them. No maintenance pass runs Forget: it runs only from the card.

  The preview names the path and states that the folder and the slot's row are deleted. It lists
  the work it can see: the delete rule, with the pool's `seed.paths` counted as regenerable, when
  Git can read the tree, and otherwise up to ten files, as Unowned trees does. Execute always
  requires the discard acknowledgement, even with nothing listed, because a tree Git cannot read
  cannot be proven empty and the row does not come back.

  It refuses a slot with an occupant, a live or unknown owner or a running claim. A Git listing
  that fails refuses too, because a registration may name the path, and so does a folder whose
  contents cannot be read, because its work cannot be named. Execute refuses a changed
  preview: the preview binds a signature of the folder's entries, as Unowned trees does, so a write
  the list does not show still stops it. Execute refuses a running claim, then takes the owner, pool
  and occupancy proofs again under the slot lock. It records "a Forget was cut off before its folder
  was gone" as the quarantine reason, deletes the folder without following a symlink, in the tree or
  at its path, removes any registration that names the path, a locked one included, and deletes the
  row. A registration that names another path is that checkout's and stays. The pool's ordinal
  high-water mark stays too, so the ordinal is never reused.

  A delete is not atomic, and it can take the `.git` file a cause was read from. That recorded
  reason keeps Forget on the card however far the delete got, a restart included, so the slot can
  always be finished. No maintenance pass clears it or repairs the slot, and the card stops offering
  Recover, which refuses it: a reset keeps ignored files and the slot's dependency state, so it could
  hand a partly deleted install to the next lease as a warm one. Forget or Destroy finishes it.
- **Return legacy lease** delegates to the task or check owner and then the conditional Treehouse
  adapter. There is no force action for unverifiable or foreign resources.
- **Warm** prepares idle slots ahead of time: it holds each under a `warm` lease, fetches, resets
  it to origin's default branch, seeds or claims it under the pool's claim, and returns it. It is
  offered on an available slot's card and, as **Warm idle slots**, among a pool's maintenance
  actions. It never touches a leased or quarantined slot. See [Warm](#warm).
- **Kill** stops one orphan process: a process still running inside a tree whose owner has
  finished, or inside an available slot, which has no owner. It is offered on the process's row in the slot card, behind a confirmation. With
  more than one killable process listed, **Kill all** confirms every one of them in a single
  dialog. A live Mission Control session's process offers **Open session** instead, and neither
  action reaches it. See [Orphan processes](#orphan-processes).

#### Orphan processes

A tree whose owner has finished is one a completed task still owes a return, a check lease left in
`returning`, or a quarantined slot. An available slot with no lease, and an unreferenced folder the
[orphan tree sweep](#orphan-tree-sweep) left in place because it is kept or occupied, have no owner
at all and count the same way. After each maintenance pass (`MISSION_WORKTREE_SWEEP_MS`,
5 minutes by default), and whenever Settings > Storage is opened, Mission Control runs the same
occupancy inspection the return guard uses (`ps` plus one batched `lsof`, with its one retry)
over every such tree.
Only pool slots and children of `worktrees/` and `check-worktrees/` are inspected. A pool slot
counts only while it holds the finished owner's own lease, or holds no lease and is quarantined or
available. A completed task can keep owing a return after its slot was reset and leased to a live
task, and a quarantine can keep a live lease, and none of those processes are orphans. A Warm holds
its slot under a lease, so a Warm's processes are never listed. A slot a dependency claim is running
in is skipped too, and the trees are listed again once the inspection answers, so a claim that
started during the inspection is not reported. A claim step that outlives its claim, such as one a
daemon restart left behind, has no claim running any more and is an orphan. An owner still
finishing is skipped too: a task whose session closure is still taking its agent down, and a check lease this daemon still
owns or is working on. Each process
found is reported as a bannered `orphan-process` problem in Settings > Storage, with its PID,
parent PID, command, start time and tree. Its id is
`orphan-process:<tree>:<pid>:<start time>`, so it survives a daemon restart. A pass that cannot
inspect a tree keeps the last report for it rather than dropping it.

Such a process blocks the tree's return, because the return guard refuses an occupied tree. In an
available slot, which has no return, it keeps the slot from being leased, because acquisition
passes over an occupied slot. Its problem says the tree is one no task or check owns.
The Storage problem's Open slot link lands on the slot's card, which lists each orphan process
with **Kill**. The confirmation names the process and what happens. A process that belongs to a
live Mission Control session stays in the list, because it still holds the tree, but it shows
the session's name and **Open session** instead of Kill, so a session still leaves only through
the registry's eviction path. When the card lists more than one process that offers Kill,
**Kill all** opens one confirmation naming those processes and sends one guarded request per
process, all at once. It never counts, confirms or signals a session's process, and with fewer
than two killable processes it is not offered. Any it could not kill stay in the dialog with
their reasons, so a retry never signals a process that is already gone.
`POST /api/worktrees/processes/kill` takes `{ path, pid, startedAt, command }` and signals nothing
unless all of these hold:

1. `path` resolves through `realpath` to a tree in the current report. A request naming `$HOME`, or
   a symlink that resolves anywhere else, is refused before any process is inspected.
2. That report lists the same PID with the same start time and command.
3. A fresh inspection still finds that PID inside the tree with the same start time and command.
4. That inspection does not name the PID as a live session's, and could read the live sessions at
   all. Otherwise the refusal says `belongs to live session <name>; end it from the session`, or
   that the process could not be checked. This is read fresh, not from the report, so a Kill all
   built from a stale list cannot reach a session. Until the first discovery sweep after a
   restart the sessions are unread, so every Kill is refused.

It then sends `SIGTERM`, and `SIGKILL` 5 seconds later if the same process (same start time) is
still running. It retries the tree's pending task or check return at once, skipping that
return's backoff (an available slot has none, and the next acquisition screens it afresh), and
scans again, so the problem clears with the next `storage_health` event.
For an unreferenced folder the retry is another orphan tree sweep. A refusal answers 409 with its
reason. A tree that is not a pool slot has no slot card, so its Storage link, Open tree, lands on
its row under [Unowned trees](#unowned-trees), which lists the same processes with the same Kill.

Unlike the inventory, the storage report carries each orphan process's command line, bounded to
512 bytes, because the confirmation must show what will be signalled.

A slot card names the processes it can identify, on the process's own line in the list and on its
orphan row:

- **`Session <name>`** is a live Mission Control session's own process or a descendant of it: a
  terminal pane's process, or an SDK session's driver child and what that runs. Process ancestry
  alone decides this, with the session's process matched by PID and start time, so a reused PID is
  not the session. A process that only shares a session's cwd, pane or hook coordinates is not named
  as that session. An SDK session with no recorded process names nothing.
- **`<agent> background process`** is a process the harness's own background vocabulary recognizes,
  such as `claude daemon` or `claude mcp serve`, or a descendant of one, such as an MCP server. A
  background process a session spawned is named as that session.
- **An IDE helper**, such as `VS Code helper`, `JetBrains IDE helper` or `IDE language server`, is
  matched by its executable name against a small table. Its children are not named.

A name never makes a process safe to ignore. Occupancy, every refusal and the orphan report count
a named process exactly as they count any other, and a process with no name is only one nothing
identified. The only thing a name changes is Kill, and only a `Session <name>` name changes it: a
session's process offers **Open session**, on its row in **Processes inside** as well as in the
orphan list, and the Kill route refuses it. When the names cannot be read, the occupants are still counted, without them.

Native slot cleanliness allows a narrow set of untracked ai-conductor scratch files at the
checkout root: `.pipeline/.memory-count-at-start`, `conduct-state.json`, `engineer-run.json`,
`HALT`, `HALT.class`, `DONE`, `events.jsonl`, and `.pipeline/gates/<step>.json` (all files are
under `.pipeline/`). Inspection leaves them in place. Safe removal cleans only those files,
then asks Git to remove the worktree without force. Tracked changes, symlinks, and unknown
untracked paths, including other files under `.pipeline/`, still block safe pruning. The
merge, process, lease, and owner checks apply as usual.

Inventory is an observation, not a second owner database. Open dashboards receive only a
content-free change signal and fetch the bounded view again. They do not receive raw process
commands, Git diffs, environment values, or unbounded errors.

### Legacy Treehouse compatibility

Treehouse is not an installation, configuration, or runtime prerequisite. New tasks, checks,
and manual sessions never probe or acquire from it, and the repository has no `treehouse.toml`.
The persisted provider value remains valid only so upgraded databases can account for resources
that an older Mission Control acquired.

The compatibility bridge reads only repositories named by durable Treehouse task or check rows.
It never scans workspace roots or reaps an external pool in the background. Treehouse v2.1.1 or
newer supplies JSON status and conditional return. A return requires the persisted lease ID,
exact path, expected holder, a matching live status row, a clean checkout, and proven-empty
occupancy. It then passes both `--if-lease-id` and `--if-lease-holder` and confirms the lease
disappeared or changed before the task or check owner clears its fields.

Most historical rows predate lease-ID persistence. Those resources are reported as
`identityUnverifiable`; a path and familiar holder cannot distinguish the original lease from a
later same-holder lease. Missing binaries, old versions, malformed status, foreign status rows,
dirty trees, and uncertain occupancy are also read-only. Mission Control keeps their rows and
prints an actionable diagnostic instead of guessing. A missing Treehouse binary blocks only
cleanup of those historical resources. Native allocation continues normally.

To investigate one, run `treehouse status --json` in the recorded repository. Resolve foreign or
unverifiable leases with Treehouse itself after verifying their current owner. Remove the external
Treehouse pool and installation only after **Settings > Worktrees** reports no durable legacy rows
and every foreign lease has been reviewed. `MISSION_POOL_REAP_MS` is retired and ignored; if it remains set, startup names
`MISSION_WORKTREE_SWEEP_MS` as the native maintenance replacement.

### Stale live leases

A slot whose owner is still live (a running task, a check in flight, or a manual lease nobody has
returned) but whose checkout has had no Git-visible change for **Stale lease after (days)** under
**Settings > Worktrees > Defaults** is flagged as stale. It is **never reclaimed**: nothing returns,
resets or removes it on this signal, because a live owner may simply be waiting on a person.

- "Git-visible change" is the same probe the task retention clock below uses: HEAD, the whole
  index, tracked changes and untracked files that are not ignored. A warm `node_modules` or a new
  build output does not count as activity, and neither does a title edit or pull request polling.
- The daemon probes every live lease hourly and as soon as the pool changes, and keeps each
  lease's clock in the operational `worktrees.leaseActivity` record, so a restart keeps it. A
  lease's clock starts at its first successful probe and is never backdated to when the lease
  began. A probe that cannot read the checkout, or an owner that cannot be read, moves nothing.
  A new lease on the same slot starts a new clock.
- A stale slot shows a **stale** chip on its slot card and one `stale-lease` problem in
  **Settings > Storage**, whose link opens the slot card. It is listed in Storage only and never
  raises the dashboard's storage banner.
- The threshold is read whenever the aggregate is recomputed, including on save, so raising it
  above a lease's quiet time clears the chip and the problem at once, and lowering it flags one
  at once. A `warm` owner (a Warm or seed running inside the daemon) is not a live lease and is
  never flagged.

### Task worktree retention

Final task completion closes its owned session, saves required archives, and resets and returns
all task-owned worktrees. Remaining local changes are discarded. The initial agent handoff to
a shipping workflow keeps the checkout until the task reaches final completion. Native slots
become available only after the allocator verifies the reset. A refused or uncertain return
keeps its resource records for retry or manual reconciliation; a failed native reset may quarantine
the slot rather than making it available.

**Kill** keeps its existing failed-task outcome. Once the session has actually left, Mission
Control returns its worktrees automatically only if **every** attached checkout is clean
(including untracked and ignored files), its commits are reachable from freshly fetched origin refs, and
no session or process still occupies it. Unreadable Git state, an unreachable origin, ambiguous
ownership or unknown occupancy all preserve the checkout. Reset retains its lease and session;
a subsequent safe Kill can return it even after Reset detached the task binding. Cancel keeps
its existing immediate cleanup behavior. Ignored files also block safe Kill because provider
removal or a reset onto a different commit can discard them; this includes ignored caches.

Retained work remains available through **Clean up** and **Settings > Worktrees**. The fallback
is unchanged: **Mission Control removes a terminal task's retained worktrees automatically after
30 days without a Git-visible change.** The best-effort safe-Kill intent is in memory; a daemon
restart before it runs falls back to that retention policy. New final completions record an
explicit return obligation atomically with completion and any session closure. Those durable
obligations resume after discovery, with refused returns retried at a bounded cadence. Tasks
completed before this policy keep their existing retained checkouts and 30-day activity window;
upgrade never infers return permission from an old done status or session-closure record.
Another live session or process always blocks automatic return.

A cancelled or failed task can leave that window early. When a session ends inside a tree such a
task holds, Mission Control reclaims all of the task's trees at once if they hold no work and no
session or process remains in any of them, the same check a restart runs. A tree with work stays
for the 30 days and is listed in **Settings > Storage**. A process still inside keeps the trees
too, and the session's exit does not ask again, so they then wait for **Clean up**, a restart or
the 30 days. A task that was still running when its agent left is not reclaimed by that exit: it
settles as failed and keeps its trees. A managed Pipeline task is left out, because its provider
owns the outcome.

A return that keeps being refused is recorded rather than silent. A completed task's owed
return and a check's lease return each record when their return was first refused and the
latest refusal: its reason, plus the processes found occupying the tree when occupancy was the
cause. A successful return clears both. Once the refusals have lasted an hour, **Settings >
Storage** lists a bannered `stuck-return` problem whose id,
`stuck-return:<task|check>:<owner id>:<first refused at>`, comes from that record and so
survives a daemon restart. Its **Open slot** link opens the slot card in **Settings >
Worktrees**, which shows a `return stuck` chip and the latest refusal until the return
succeeds. A tree without a native slot links to the Worktrees page instead.

The policy is fixed and destructive at the boundary. Staged changes, unstaged changes,
untracked files, local commits, and commits that were never pushed are all deleted when the
window expires. None of them exempts a tree, and push, upstream, pull request, and merge status
are deliberately not consulted at all. What they do is **reset the clock**: any change to the
observable Git state grants another full 30 days from the moment it is observed.

What counts as a change:

- `HEAD`, including a new local commit;
- the complete index - anything staged, unstaged, or removed from staging;
- tracked worktree content, including deletions, mode changes, and symlink targets; and
- every non-ignored untracked file and its current content.

What does not: anything `.gitignore` covers. Warm dependency directories, build caches, and log
files churn without anybody working, and a tree pinned by them would never be reclaimed.

**One task has one deadline.** A multi-repository task's primary and attached checkouts are
combined into a single fingerprint in repository order, so the most recently touched tree
protects the whole set, and the task is reclaimed as one operation.

**How the clock is kept.** The daemon observes each eligible task's checkouts on a fixed
internal cadence, well inside the window, and persists the result - the fingerprint, when it
last changed, and the resulting deadline - so a restart resumes the boundary that was actually
granted rather than starting over. Final completed tasks resume explicitly recorded closure and
return obligations after session discovery.

**A restart reclaims a settled task's clean trees at once.** When a restart settles a task whose
agent did not survive it, or finds a failed or cancelled task still holding trees, it checks every
tree the task holds, by the rule of what reclaiming that tree does. This amends the earlier
settle-and-retain rule for clean trees only:

- **A pool slot keeps its folder**, so it is judged by the [reset rule](#settings--worktrees) against
  origin's default as last fetched, with no network: nothing uncommitted, untracked or unpushed,
  and no ignored entry the reset would overwrite or delete. A slot holding only ignored files is
  therefore reclaimed at once and keeps them, warm install included. The reset fetches and judges
  the rule again against that commit, so a default that moved keeps the slot, with every file
  unchanged, and the task is listed with that reset's own refusal. A checkout with no local
  default ref leaves the whole judgement to the reset. A reclaim that fails for any other reason,
  such as an unreachable origin or a locked registration, keeps the slot too and is listed as a
  tree that could not be reclaimed, because nothing says it holds work.
- **A tree that is deleted takes the delete rule.** A disposable Git worktree or a Treehouse lease
  is removed rather than reset, so **clean** means nothing uncommitted, untracked or unpushed, and
  no ignored file except under the regenerable directories `node_modules/`, `dist/`, `build/`,
  `coverage/`, `.cache/`, `.turbo/` and `.next/`, at any depth, or what its pool claim's
  `seed.paths` bring back (see "Seeding" under [Dependency claims](#dependency-claims)), matched as
  repository-relative patterns exactly as a seed matches them. In a pool whose seed paths list
  `.yarn/install-state.gz`, a tree holding it is still clean, while `.idea/` and `.env` stay
  work, as does workflow evidence under `.evidence/` or `e2e/.artifacts/`. A path `seed.exclude`
  could reach is not regenerable: a seed strips it from every clone, so it never comes back. That
  covers an excluded path, anything inside one, and a directory an exclusion could match under,
  so `**` in an exclusion takes a seeded directory out of the set (the built-in directories stay
  in it). An exclusion with a group spanning a slash, such as `.yarn/{secrets/*,keys/*}`, takes
  every seed path out. The tree is mapped to its pool by the Git common directory its `.git` file
  names. A pool with no claim or no seed, and a folder with no repository, get only the built-in
  directories.
- A clean task whose trees no process occupies is reclaimed through the same path as **Clean
  up**, keeping its status and outcome.
- **Anything else keeps the 30-day window.** So does a tree Git cannot read. The task is listed as a `dirty-settled-tree` problem in **Settings > Storage**, named
  `dirty-settled-tree:<task id>:<first seen at>` from the storage first-seen record, so a restart
  keeps its id. It is listed in Storage only and never raises the banner.
- **Discard and reclaim is the slot card's Return.** The problem links to the task's pool slot,
  and its Return preview states the discard before anything runs: "Discards the uncommitted,
  untracked or ignored work in ..." and, for commits never pushed, "Discards the commits in ...".
  Confirming reclaims every tree the task holds and the problem disappears. A task with no pool
  slot (a disposable Git worktree or a Treehouse lease) has no slot card, so its problem links to
  the **Settings > Worktrees** page instead, and **Clean up** on the task still reclaims its trees.

**The clock starts when the tree is first observed, not when the task ended.** No timestamp in
the database can prove when a checkout was last touched, so every tree that existed before this
shipped - and every tree whose resources are replaced - is seeded at its first successful
observation and gets one full window from there.

**Uncertainty retries; it never deletes.** A checkout Git cannot be read, a provider that
refuses, a process still occupying a tree, a scout report that cannot be published, or a
partial multi-repository release all keep every durable resource fact, record a bounded reason,
and try again with exponential backoff capped at a day. The tree stays past due - a failed
cleanup never buys it another 30 days - and the ordinary **Clean up** action still reaches it.
While a due cleanup is retrying, the task's card says so, separately from its outcome or
failure reason.

Cleanup runs through the same provider-aware teardown as **Clean up**, so a native slot, a
disposable Git worktree, and a historical Treehouse lease are each released under the provider
and lease identity recorded on the task. At most one automatic cleanup touches a given physical
repository at a time, and it releases at background priority, so a large stale fleet cannot
stand in front of a dispatch that needs a slot now.

This policy applies only to worktrees Mission Control provisioned for a task. Manual
development worktrees, [check leases](#check-leases), and Git worktrees Mission Control does not
own are never touched by it.

### Orphan tree sweep

The task fallback keeps its trees in `worktrees/` and the check fallback in `check-worktrees/`,
both under the state home. A folder there that no live owner references, such as one left by a
crash, a restart, or a removal that half-failed, is swept. The sweep runs once when worktree
maintenance starts, after startup reconciliation, and again on every maintenance pass
(`MISSION_WORKTREE_SWEEP_MS`, which also turns it off).

- A folder is **referenced** when any task or attached-repository row names it as its worktree,
  whatever the task's status, or a check lease in `held` or `returning` names it. A referenced
  folder is never touched, so task retention still decides when a terminal task's tree goes.
- Every other folder is taken through its real path and must sit directly inside its directory.
  A symlink is never followed, and nothing it points at is touched.
- A folder being created is skipped. Both fallbacks register their target path before
  `git worktree add` and release it once their row names the tree or their unwind removed it.
  As a backstop, a folder is also skipped while it, or its `.git` file, was modified in the last
  30 minutes. That covers a creation the registry cannot see, and after a crash it is what holds
  off a half-created tree until its grace ends.
- A folder some process is working in, or whose occupancy cannot be read, is skipped.
- A **husk**, a folder holding nothing but empty directories and a `.git` file whose Git
  directory is gone, is removed.
- A **clean** worktree is removed with `git worktree remove --force`. Clean is the delete rule:
  nothing uncommitted, untracked or unpushed, and no ignored file outside the regenerable set.
  That set is the regenerable directories (`node_modules/`, `dist/`, `build/`, `coverage/`,
  `.cache/`, `.turbo/` and `.next/`) plus the `seed.paths` of the pool whose Git common
  directory the tree's `.git` file names, so a tree holding only its pool's installed state is
  removed. A path `seed.exclude` could reach stays work. A pool with no claim or no seed gets the
  directories alone. Its `harness/*` branch is
  deleted only when a remote branch contains it.
- Anything else is kept: a dirty or unpushed worktree, one whose safety cannot be read, and a
  folder that is not a worktree but still holds files, such as a tree whose `.git` file was
  lost. **Settings > Storage** lists each one as a bannered `dirty-orphan-folder` problem, with
  the reason it was kept. Its id, `dirty-orphan-folder:<path>:<first seen at>`, takes its time
  from the operational first-seen record, keyed by the folder's path and inode, so a restart or
  a pass that skips the folder keeps the same id, and a folder removed and created again gets a
  new one. The sweep never deletes a file it cannot prove is Git's own.

The sweep also runs a **scoped prune**. For each source repository Mission Control knows (pool
repositories and the repositories of tasks and checks), it reads `git worktree list --porcelain`
and removes only the `prunable` registrations whose path is under the state home and no longer
exists. It never runs an unscoped `git worktree prune`, so the operator's own worktrees
elsewhere are untouched. A missing path that a task, check lease or native slot row still names
keeps its registration, because that owner's own cleanup or reconciliation decides it. A check
lease that deleted a [tree Git no longer recognizes](#check-leases) runs the same scoped prune
once the lease has settled.

#### Unowned trees

Trees under `worktrees/` and `check-worktrees/` have no slot card, so **Settings > Worktrees >
Unowned trees** carries their actions. It lists every tree a Storage problem links to as an
unowned tree, from the live `storage_health` aggregate: each folder the sweep kept as
`dirty-orphan-folder`, with the reason it was kept, and each tree holding an `orphan-process`.
Each Storage problem's **Open tree** link lands on that tree's row.

- A process in the tree is listed with **Kill**, through the same confirmation and guarded route
  as a slot card's, or with **Open session** when a live session owns it. A folder the sweep skipped because a process occupies it is inspected by the
  orphan process scan too, so a process holding a folder nobody owns is reported, not just
  skipped. After a kill a fresh sweep runs, one that starts after the kill rather than a pass
  already in flight that may have seen the process: a clean folder is removed, and one holding
  work is kept and offered for discard.
- A kept folder offers **Discard and remove**. Its preview, the `removeUnowned` worktree action,
  names the path and the work it discards: the reason it was kept, any unpublished commits, and up
  to ten of the paths it deletes (changed, untracked and ignored ones for a worktree, files for
  any other folder). The work it names follows the sweep's delete rule, so an ignored path in the
  regenerable set, the pool's seed paths included, is never called work: it is listed as
  `(regenerable)`, since it is deleted too but loses nothing. Execute needs the discard
  acknowledgement. Cancel leaves the row and the folder in place.
- Only a folder the sweep keeps right now can be previewed. Any other path, a pool slot, a live
  task's tree or `$HOME`, is answered 404 before anything on disk is inspected.
- On Execute, Mission Control rebuilds the preview and refuses one that changed. A preview is
  bound to the size and modification time of every entry under the folder, not just the paths it
  names, so any write after it, such as another edit to a file already listed as changed, refuses
  the run. The walk stops at regenerable directories (`node_modules/`, `dist/` and the rest of
  that list) and at the pool's seed paths, which count by their own entry only, since they are
  deleted either way. It goes on through a seed path `seed.exclude` could reach, so a later write
  to an excluded file refuses the run. An entry
  that vanishes or cannot be read during the walk makes the tree read as changed. The sweep then
  checks again under its own pass lock that it still keeps the folder, with the same inode, that
  no row names it, that nothing is creating it, and that no process is in it. A worktree is
  removed with `git worktree remove --force`, and its `harness/*` branch is deleted only when a
  remote branch contains it, so unpushed commits on that branch survive. Any other folder is
  deleted with every file in it. The row and the Storage problem leave with the next
  `storage_health` event.

### Check leases

A [Workflow check](workflows.md#workflows-and-personas) runs a build in an isolated worktree of its
own, pinned to the exact commit the run captured. New attempts acquire a native slot under
owner `check:<attemptId>` and persist the allocator's random lease ID before the supervisor
gate can release. A disabled repository or a positive native refusal uses a throwaway detached
Git worktree, still runs the configured command, and removes the tree afterwards. An ambiguous
native acquisition fails closed and never attempts a second provider. The gate never passes
merely because worktree allocation is unavailable.

A check has no session or task row standing in for its lifecycle. Its durable check row,
just-acquired pin, supervisor identity, process-group recovery, retries, and verdict rules remain
authoritative above the generic slot record. Cleanup first proves the process group empty, then
conditionally returns the exact native lease. A missing, stale, occupied, or uncertain lease is
kept for startup or maintenance reconciliation rather than guessed away. Native check leak
reclamation runs on the native maintenance cadence after slot startup reconciliation.

Check lease startup reconciliation does not hold the daemon back from listening. It pins every
live lease's tree synchronously, so a new check cannot take a tree a durable row still names, and
then resolves each row in the background. Releasing a tree Git no longer recognizes deletes the
whole checkout, which can take minutes for a large monorepo, and a failure is logged and retried
by the next maintenance pass.

A Git fallback tree that Git no longer recognizes is deleted rather than retried forever. Once a
tree's `.git` file is gone, `git worktree remove --force` refuses it with "validation failed",
and the orphan tree sweep leaves it because the lease still names it. So when that return fails,
the check lease deletes the folder itself, provided all of these hold:

- the folder is a real directory, not a symlink, named for its attempt, whose real path is a
  child of `check-worktrees/`;
- its `.git` file is missing, or names a Git directory that is gone or that belongs to another
  tree;
- the attempt's process group is proven empty;
- a fresh occupancy read of the folder is known and empty.

The folder is deleted without following symlinks, then the lease settles `returned`, which
clears its `stuck-return` problem, then the [scoped prune](#orphan-tree-sweep) removes the
registration in the same pass. A prune that fails is left to the next sweep, since no row names
the path any more. A deletion that fails, or any condition that does not hold, keeps the lease
`returning` with the reason recorded. A folder that is already gone, after a run cut off between
the deletion and the settle or a tree removed by hand, still completes its lease: usually through
the ordinary return, because Git removes an absent tree's registration without complaint, and
otherwise when the recorded path's parent resolves to `check-worktrees/` and nothing, not even a
symlink, exists at the path. A tree Git still recognizes keeps the ordinary failed return, and so
does a native check slot, which is a pool slot that Recover handles.

#### The dependency claim in a check lease

A check lease runs the pool's [dependency claim](#dependency-claims) under the same rules as a
task lease: the same steps, environment, deadline, fingerprint skip and final proof. The cold
fallback runs the same claim against its throwaway tree once that tree is recorded and pinned. It
runs whenever the repository's settings carry a claim, even with native pooling off, because the
claim describes the repository's dependencies, not the pool. The claim is looked up by the
repository's Git common directory, read from Git when the pool cannot identify the repository,
for example one whose metadata is relocated. A lookup that fails is infrastructure and the tree
is removed. Only settings that were read and carry no claim let the command run without one.
That tree has no slot row, so it has no recorded fingerprint and is always cold. When the
repository's pool is enabled and configures `seed.paths`, the tree seeds under the same rule as a
slot, from an idle slot of that pool, and skips its steps when the source's fingerprint matches
the check's commit. There is no write-ahead to take, because the tree is removed with the
attempt, so a seed stopped or timed out there is simply a failed claim. The final proof still applies to
a claim that succeeded: a step that rewrites a tracked file, leaves an untracked file Git does
not ignore, moves HEAD or attaches a branch leaves a tree the command is never run in. A claim
that failed is reported as a dependency failure with its tail even if it also dirtied the tree,
because the tree is removed either way.

**A failed claim does not run the check's Command.** The tree goes straight back to the pool, or
is removed, before the attempt reports anything, and the attempt records a dependency failure
with the claim's output tail. Who owns the failure is decided by the claim's fingerprint paths:

- If any blob matching them differs between the check's head and its merge base with the base
  branch (the task's base branch, or origin's default), the change owns it. The check **fails**,
  with the claim's tail as its output and a note naming the failing step and the changed inputs.
- If none differs, it is **infrastructure**, for example a registry outage or an expired token.
  The engine retries it as the same execution, up to its usual three attempts, and then blocks
  the run with `infrastructure_error`. The reason carries the tail.
- A claim with no fingerprint paths cannot trace a failure to the change, and neither can a
  merge base that cannot be read, so both count as infrastructure.

A failed claim never spends the Command's run budget, whichever way it is decided, because the
Command did not run. The comparison reads both trees from objects in the main checkout, never
from the worktree, and measures from the merge base rather than the base branch's tip, so a
lockfile the base branch changed after the branch was cut is not blamed on the change.

**The check slot while claiming.** The daemon runs two check commands at once. An attempt whose
claim runs gives its check slot up for as long as the claim runs, and takes one again before
anything else runs in its tree: affected-test selection, the test lease and the spawn. A claim
that may run for hours therefore never keeps another check queued, and a third check runs while
two claim. A claim skipped on a matching fingerprint keeps its slot throughout. The order of the
checks, the run-budget reservation taken before the lease, and the machine-wide test lease taken
after it are unchanged.

**Timeouts.** The Command's own timeout starts when it spawns, after the claim, so claim time
never counts against it. A slow install ends under the claim's own `timeoutMinutes`, as a
dependency failure, never as a timed-out check.

**Cancel.** Cancelling a run stops the claims of its running attempts, in a pool slot or a
fallback tree alike. That includes an attempt that has not reached its claim yet, for example
one still resolving its commit or resetting its slot: its claim stops before its first step the
moment it registers, and an attempt cancelled before it reaches its lease takes no worktree at
all. A stopped claim settles as a failed one: the slot records `failed` and goes back to the
pool, and the attempt is recorded as cancelled with the run. A check command that already
spawned is not signalled by a run cancel; its result is recorded as audit-only.

#### Historical Treehouse check rows

Rows that already record provider `treehouse` keep their exact provider authority and
`mission-control-check-<attemptId>` holder. Check recovery runs on the native maintenance cadence
even when there are no native pools. It keeps the row and pin on every unreadable, unverifiable,
foreign, dirty, occupied, or conditional-return failure. Only an exact persisted lease ID and
matching holder can reach the compatibility return described above. No check code can acquire a
new Treehouse lease.

### Running a check command

This is what a [Command node](workflows.md#command-nodes) does once workflow Commands are
allowed and you grant the repository, which is the gate that ships closed. New installations
ship Commands allowed; a machine whose workflow settings were stored before that switch
existed keeps them off until you turn them on, and **Settings -> Workflows** is where either
one says which it is. What a Command does with your machine is worth stating plainly before
you grant a repository.

**Workflow Commands run on Linux and macOS.** On any other platform one reports Not run and
passes. That is not an oversight: the daemon has to be able to prove afterwards that a
command and everything it spawned is gone, before it hands the leased worktree back to the
pool. It does that by recording *which exact process* the supervisor was and asking the
operating system about it later, and neither Node nor any portable API answers that question -
it is read from `/proc` on Linux and from `ps` on macOS. Somewhere it cannot be read, a check
could be started but never proven finished, so the daemon declines to start one at all.

The recorded identity is a **composite**: an operating-system start time *and* a short digest
of the supervisor's command line, which carries the attempt id. The start time alone is not
enough, because the finest value either platform will tell us is whole seconds on macOS, and
process ids get reused - two different processes born in the same second would compare equal,
and the daemon would signal a stranger's programs believing they were the check's. Pairing it
with a command line that only one supervisor ever bears makes that vanishingly unlikely
instead: a false match would need the same reused pid, in the same second, running the
daemon's own supervisor, for an attempt only one supervisor is ever created for.

The command line is stored as a truncated SHA-256 rather than in full, because the raw line
carries a few kilobytes of the supervisor's own source and this value is written to a durable
row kept for audit. Only equality is ever asked of it, and equal command lines digest equally,
so the digest answers the same question in a fraction of the space - at the cost that the
guarantee is now collision resistance rather than a literal comparison. That is a trade worth
naming rather than glossing: it is not a proof, it is a very good bet, and the durable lease
row and startup recovery are what make a wrong bet recoverable rather than silent.

What a Command gets:

- **An argv, never a shell.** `&&`, `|`, `;` and `$(…)` reach the command as ordinary
  arguments, so there is no string for a repository's configured command to break out of.
- **The captured commit, in a pooled worktree**, not your own working copy - so a check never
  sees, and can never disturb, whatever you have open. The tree is `reset --hard` to that exact
  commit and cleaned with `clean -fd`, never `-fdx`, which preserves the pool's ignored
  dependencies. That keeps whatever the slot last installed, which is not necessarily what this
  commit needs. Making it current is the pool's [dependency claim](#dependency-claims), which
  runs inside the check's lease before the command (see
  [The dependency claim in a check lease](#the-dependency-claim-in-a-check-lease)). A
  subdirectory command runs in that subdirectory *of the leased tree*.
- **A trimmed environment.** The daemon's auth token is removed, along with any variable that
  overrides where its state directory lives and anything whose name reads like a credential
  (`…_TOKEN`, `…_SECRET`, `…_PASSWORD`, `…_KEY`, `…_CREDENTIALS`). `PATH`, `HOME`, `SHELL`, the
  locale and proxy variables and everything else a build needs are passed through. This stops a
  credential being *handed* to a check; it does not hide the daemon's default state directory,
  which sits in your home folder and which anything running as you can find whatever the
  environment says.
- **A closed stdin**, so a command that stops to ask a question fails immediately instead of
  hanging until its timeout.
- **Bounded output.** The last 4,000 bytes are kept, because a failing build's useful lines are
  its last ones, and the run detail reports exactly how many bytes were dropped.

**This is not a sandbox, and the trimmed environment should not be read as one.** A check
command runs as you, with your filesystem access. Removing the token narrows what a build can
reach *back into*; it does not confine what it can do generally. That is why a repository must
be allowlisted before any of this happens - the allowlist, not the environment, is the boundary.

When a check is cancelled or times out, the whole process group is signalled: `SIGTERM` first,
then a few seconds' grace so a test runner can flush its output and clean up its own temporary
files, then `SIGKILL`. The daemon then keeps asking until the group is actually empty before
returning the worktree, because a build that leaves a server running behind it is common and
the leader exiting proves nothing about its children. A group it cannot prove is empty keeps
its lease rather than handing back a tree something may still be writing into. Test commands
get sixty minutes before this teardown begins; other Command slots keep the ten-minute default.

**A daemon shutdown skips the grace and goes straight to `SIGKILL`**, deliberately. Stopping
Mission Control mid-build would otherwise wait out the rest of the command's timeout - up to
sixty minutes for one test suite - and the output a grace period buys is output nobody is left to
read, because the attempt ends as an infrastructure failure rather than a verdict either way.
The daemon still waits for the group to be proven empty afterwards, so the worktree goes back
to the pool on the way out; stopping a daemon with a check running takes well under a second.

**A check whose worktree cannot be accounted for does not report a verdict**, whatever its
command exited with. A group that will not go away, or a return that failed, means the gate has
not been shown to have run against the commit it claims - so it is recorded as an infrastructure
failure instead, the run blocks and says so, and it clears once the lease is reclaimed. The
command's own exit code is kept in the reason, so you can still tell "the build failed and then
cleanup broke" from "the build passed and then cleanup broke".
