# Proposing a fork feature upstream

This runbook is how an agent proposes one fork feature to upstream
`teamupstart/mission-control` as one pull request. It is the counterpart of
[the upstream-sync runbook](upstream-sync.md), which brings upstream's commits into the fork;
this one sends a fork feature the other way. The remotes are the ones that runbook's
[Remotes](upstream-sync.md#remotes) table names: `origin` is the fork, and `upstream` is read
only from this machine.

The agent ports the feature and pushes a ready-to-open branch to the fork. It does not open the
upstream pull request itself. Upstream accepts pull requests only from its collaborators
(upstream's `CONTRIBUTING.md`), and only the operator's work machine holds a GitHub token
authorized for the `teamupstart` organization's single sign-on. The work machine pushes the
branch to `teamupstart` and opens the pull request (section 4).

One upstream pull request carries one fork feature, as the feature's
[tracking issue](fork/README.md#tracking-issue) records it. Two features are two pull requests,
each reviewed and merged on its own.

## 1. Pick the scope

Fetch both remotes first. Every command from here on reads `origin/main`, `upstream/main` or a
fork pull request's merge commit, and a stale checkout gets them wrong without an error: a
recently merged feature pull request has no local merge commit, and a file upstream added since
the last fetch looks fork-only.

```sh
git fetch origin
git fetch upstream
```

Then read the feature's tracking issue as the refresh will see it once every merged fork pull
request has applied:

```sh
gh issue list --repo ramiro314/mission-control --label fork-feature --state open --limit 100
node scripts/fork-delta.mjs show <slug>
```

`show` may warn `not overlaid, their sections do not parse: #423, ...`. Those are merged pull
requests the refresh has not applied because their "Fork feature changes" sections are
malformed, so their edits are missing from what `show` prints. The warning is harmless for
scoping unless one of them names this feature: `node scripts/fork-delta.mjs pending` prints each
as `#<n> invalid <features>`, and a line naming `fork:<slug>` means that pull request's intended
edits to the issue are not in the output, so read its section by hand with `gh pr view <n>`.

Its **Upstream candidate** section decides the scope:

- **No** (for example "It exists only because this is a fork"): stop and call `request_input`.
  Do not port a feature the issue says should stay in the fork without the human's decision.
- **Yes**: the scope is the whole feature.
- **Partly** (for example "Yes for #2 and #30, Maybe for #6"): the scope is the pieces it names
  as yes. A piece marked maybe or not decided is the human's call, so ask before including it.

Then list the feature's merged pull requests and every file they touched that still exists on
fork `main`, split into files upstream lacks and upstream files the feature changed. `$SCRATCH`
is any directory outside the checkout, such as the session's scratch directory:

```sh
gh pr list --repo ramiro314/mission-control --label fork:<slug> --state merged --limit 100 \
  --json number,title,mergedAt --jq 'sort_by(.mergedAt)[] | "#\(.number) \(.title)"'
gh pr list --repo ramiro314/mission-control --label fork:<slug> --state merged --limit 100 \
  --json mergeCommit --jq '.[].mergeCommit.oid' | while read -r m; do
  git diff --name-only "$m^1" "$m" || echo "STOP: merge commit $m is missing; fetch origin" >&2
done | sort -u | while read -r p; do
  git cat-file -e "origin/main:$p" 2>/dev/null || continue
  git cat-file -e "upstream/main:$p" 2>/dev/null && echo "changed   $p" || echo "fork-only $p"
done | tee "$SCRATCH/scope"
grep '^fork-only' "$SCRATCH/scope" | cut -c11- > "$SCRATCH/fork-only-paths"
```

The files come from each pull request's merge commit, diffed against its first parent, which
is fork `main` just before the merge. `gh pr list --json files` is not used: it returns at most
100 files per pull request and says nothing when it cuts the list (#770 changed 822 files and
returned 100).

The list holds only what the feature's own pull requests touched. Sync pull requests carry no
feature label, so a fix a sync made for the feature is not in it. The pilot, the first port run
through this runbook (`fork:persona-reasoning-effort`, 2026-11-09), found that syncs had added
`effort: null` to the Persona fixtures of five `test/residents-*.test.ts` files. Those surface as
typecheck errors in section 3.

Drop the paths that never go upstream, from the list and from `fork-only-paths`: fork plans
under `docs/plans/` and anything else the sync runbook's
[fork-only surface](upstream-sync.md#6-fork-only-surface-a-sync-must-preserve) lists. When the
scope is part of the feature, drop the files of the pieces left out as well.

### Prerequisites on other fork features

A fork feature is often built on other fork features. Upstream has none of them, so every
dependency is either stripped, replaced with what upstream already does, or proposed upstream
first as its own pull request. List them before porting. Search the "Fork-only files" section
of every open tracking issue for each fork-only path in scope and its directory:

```sh
gh issue list --repo ramiro314/mission-control --label fork-feature --state open --limit 100 \
  --json number,title,body > "$SCRATCH/features.json"
while read -r p; do
  jq -r --arg f "$p" --arg d "$(dirname "$p")/" '.[]
    | (.body | capture("### Fork-only files\\s*(?<s>[\\s\\S]*?)(\\n### |$)").s // "") as $own
    | select(($own | contains("`" + $f + "`")) or ($own | contains("`" + $d + "`")))
    | "\($f): #\(.number) \(.title)"' "$SCRATCH/features.json"
done < "$SCRATCH/fork-only-paths"
```

Every hit other than the feature itself is a prerequisite. The search finds files a feature
owns, and an import into another feature's file shows up when the port branch fails to typecheck
(section 3). It cannot find another feature's lines in an upstream file both features changed.
Those arrive through the conflict regions of a three-way apply (section 2), and not all of them
fail to typecheck: a fork-only test case or an added list entry compiles on its own. Watch for
them while resolving each conflict, using the "Recognize it by" column below. Four fork-only
foundations are the usual ones:

| Foundation | Recognize it by | Usual treatment |
| --- | --- | --- |
| Linux support (#463) | Linux platform branches, `src/web/lib/platform.ts`, `scripts/require-macos.mjs`, Linux-only e2e specs | Drop the Linux rows and keep upstream's behavior, unless Linux is the point of the pull request. |
| Platform seams (#422) | `src/server/process-inspection/`, `src/server/platform/process-lifetime.ts`, `src/server/platform/executable-environment.ts`, `scripts/native-addon-sources.mjs` | Call the POSIX implementation directly, the way upstream's code at that site still does. |
| Flake-aware testing (#296) | `test:run`, JUnit output, `.mission/testing.json`, the `affected-tests` Command and its `AFFECTED_TESTS_*` placeholders, Wait for CI (`wait_for_ci` nodes, `wait_for_ci_placement`), `mission-flake-report` | Drop the hooks. The port's tests run under upstream's own `npm test`. |
| Decision forms (#292) | `src/server/foreman/decision-draft.ts`, recommended options preselected, Other as its own radio | Build on upstream's decision form as it stands, and drop the Foreman draft paths. |

Record each prerequisite and its treatment for the pull request's "Known gaps" (section 4). A
prerequisite that cannot be stripped without breaking the feature is the human's call: ask
whether to propose it upstream first, and do not fold it into this pull request.

## 2. Port the final state

Branch from upstream, never from fork `main`. Fork `main` is about 1,276 commits ahead of
upstream (2026-11-08), so a branch from it would propose the whole fork.

This runbook is fork-only, so it is not on disk once the switch below runs. Read the rest of it
from the fork's ref instead, including after a context summary or in a later review round:

```sh
git show origin/main:docs/upstream-contribution.md
```

```sh
git switch --no-track -c upstream/<slug> upstream/main   # the upstream/main section 1 fetched
npm ci
```

`--no-track` keeps the branch from tracking `upstream/main`, which would aim a plain `git push`
or `git pull` at `teamupstart` until the hand-off's `git push -u origin` (section 4) sets the
fork as its upstream.

`npm ci` is needed because upstream's lockfile is not the fork's; the fork's `node_modules`
do not belong to this branch. On npm 11 it warns that install scripts not covered by
`allowScripts` were skipped (`esbuild` and others). That is harmless for a port: esbuild's binary
comes from its platform package (`@esbuild/<platform>`), which installs without a script, and the
other scripts are Windows-only (`electron-winstaller`), version-scheme warnings (`protobufjs`) or
no-ops (`@google/genai`). The native state-lock addon and the Electron runtime are provisioned
by `pretest` and `pretest:electron`, not by install scripts (checked 2026-11-09, npm 11.20.0,
Linux).

A local branch named `upstream/<slug>` sits beside the `upstream/*` remote-tracking refs, and git
resolves the name to the local branch first; once `teamupstart` holds a branch named `<slug>`,
`git` warns that the name is ambiguous and still uses the local branch.

The port carries the feature **as it stands on fork `main`**. The fork's history carries
reverts, repairs and other features' edits that upstream should never see, so whichever way it
is built, the port is checked against fork `main`'s final state, not against its pull requests.

### Apply each pull request's diff

The quicker way is a three-way apply of each in-scope pull request's merge diff onto
`upstream/main`, in merge order. Limit each diff to the paths in `$SCRATCH/scope`, which drops
the fork plans and every path fork `main` no longer has: a pull request's diff can carry
fork-only files deleted since, as the pilot's did with `docs/fork/ledger.*`.

```sh
git diff --binary <merge>^1 <merge> -- $(cut -c11- "$SCRATCH/scope") > "$SCRATCH/pr<n>.diff"
git apply -3 "$SCRATCH/pr<n>.diff"
```

Resolve every conflict before applying the next pull request's diff, and resolve each region by
hand. In a conflict region, `ours` is upstream and `theirs` is the fork's whole version of that
region, surrounding lines included, and those lines include other fork features: the pilot found
`wait_for_ci_placement`, the `AFFECTED_TESTS_*` imports and fork-only SDK tests there. Keep only
this feature's lines, and keep upstream's side of everything else.

Then verify against fork `main`'s final state, since a later fork pull request may have changed
the feature's files after its own pull requests merged. `<last merge>` is the merge commit of the
feature's newest pull request:

```sh
git diff <last merge> origin/main -- $(cat "$SCRATCH/fork-only-paths")   # later fork-only changes
git diff upstream/main...origin/main -- <changed upstream path>          # the fork's final hunks
git diff upstream/main -- <changed upstream path>                        # the port's hunks
```

Skip the first command when `fork-only-paths` is empty: with no paths it diffs the whole tree.
Bring each later change to a fork-only file in when it belongs to this feature. For each upstream
file the feature changed, the feature's lines in the second diff and the port's lines in the third
describe the same change.

### Re-apply by hand

When the pull request diffs no longer apply, re-apply the final state by hand:

- A fork-only file in scope: copy it as it is on fork `main`, then adapt it.

  ```sh
  git checkout origin/main -- <path>
  ```

- An upstream file the feature changed: read the fork's changes to it, measured from the last
  synced upstream commit so upstream's newer commits are not shown as reversed, and re-apply
  only this feature's hunks by hand. Other features' hunks in the same file stay out.

  ```sh
  git diff upstream/main...origin/main -- <path>
  ```

- Upstream may have moved past the fork's last sync (`git rev-list --count
  origin/main..upstream/main`). The port is written against current `upstream/main`, so adapt
  it to anything upstream changed since.

### Strip the fork

Remove everything that only makes sense in the fork:

- links to and mentions of `docs/fork/`, this runbook and the sync runbook;
- "Fork feature changes" sections, `fork:<slug>` and `fork-status:*` labels, and tracking
  issue numbers;
- fork pull request numbers. On upstream `#2` names upstream's pull request 2, so cite a fork
  pull request as `ramiro314/mission-control#2`, or leave it out;
- the fork-only foundations section 1 stripped or replaced.

Follow upstream's conventions, read from `upstream/main` itself, because the fork's copies of
these files carry fork-only rules (fork CI, the fork section of `AGENTS.md`):

```sh
git show upstream/main:AGENTS.md
git show upstream/main:CONTRIBUTING.md
git show upstream/main:.github/PULL_REQUEST_TEMPLATE.md
```

In particular: user documentation changes in the same pull request as the behavior, a UI
change carries a Playwright spec in `e2e/`, `CHANGELOG.md` is never edited (Release Please
owns it), and prose has no em dash.

## 3. Verify on the port branch

Run the checks on `upstream/<slug>`, with the dependencies `npm ci` installed in section 2.
Never run the full suite locally; upstream's CI runs it on the pull request.

```sh
npm run typecheck
npm run lint
node --test --import ./test/setup-state.mjs --import tsx test/<file>.test.ts
```

A typecheck error in a file the port did not touch is usually expected adaptation, not a missing
prerequisite: a file upstream added since the fork's last sync (the pilot hit
`test/dispatch-persona.test.ts`), or a file a sync pull request already fixed for the feature in
the fork (section 1). `git diff upstream/main...origin/main -- <file>` shows how the fork fixed
one it has; fix a file upstream added the same way. A prerequisite instead shows up as an import
of a module upstream lacks.

Run each test file the feature adds or changes by name. When the port changes a build or
runtime surface (the daemon, the Electron shell, the MCP server, hooks, a bundle), also:

```sh
npm run build
npm run smoke
```

When it changes the UI, run its specs against that build:

```sh
npm run test:e2e -- e2e/specs/<spec>.spec.ts
```

Before handing off, confirm the port carries nothing from the fork beyond the feature. The port is
usually not committed yet (section 4 commits it), so compare the working tree with
`upstream/main`, which covers committed and uncommitted work alike, after staging so that new
files count:

```sh
git add -A
git diff --stat upstream/main
git diff upstream/main | grep '^+' | grep -n -E 'docs/fork|Fork feature changes|fork(-status)?:[a-z]|ramiro314'
```

The last command searches only the lines the port adds, and should print nothing, or only a
`ramiro314/mission-control#<n>` citation you meant to keep. Section 4 repeats it on the commit.
`upstream/main...HEAD` would see only committed work, and before section 4 that is usually
nothing, so it would pass on an empty diff.

A check that fails may be upstream's own failure rather than the port's. Tell them apart with a
clean `upstream/main` baseline, exactly as the sync runbook's
[When a gate fails](upstream-sync.md#when-a-gate-fails-the-sync-upstream-or-the-machine)
section describes, and record a failure that also happens on the baseline under "Known gaps".

## 4. Hand off

Squash the port into **one** commit. Its subject is the upstream pull request's title and its
body is the upstream pull request's body, so the work machine opens the pull request from the
commit alone.

- **Subject**: a Conventional Commit, for example `feat(web): make Other its own radio on
  single-choice decisions`. Upstream's pull-request-title check runs
  `scripts/assert-release-commit.mjs`, because Release Please omits a squash subject it cannot
  parse.
- **Body**: upstream's pull request template, filled in. At least the summary (why and what
  changed), the verification actually run from section 3, and known gaps, including each
  prerequisite section 1 stripped or replaced. No "Fork feature changes" section and no fork
  links. No agent `Co-Authored-By` trailer: both repositories' `AGENTS.md` forbid one.

Write the message to a file outside the checkout and commit with `-F`. Never let the editor
open: `git commit` strips every line that starts with `#` from a message it edits, which
deletes the template's Markdown headings, while a message given with `-F` keeps them. Commit
any uncommitted work on the branch first, then:

```sh
git fetch upstream
git rebase upstream/main
git reset --soft upstream/main
git commit --cleanup=whitespace -F "$SCRATCH/upstream-<slug>.msg"
git rev-list --count upstream/main..HEAD
RELEASE_COMMIT_SUBJECT="$(git log -1 --format=%s)" node scripts/assert-release-commit.mjs
git log -1 --format=%b | grep -n -i -e co-authored-by -e 'fork feature changes' -e 'docs/fork'
git diff upstream/main...HEAD | grep '^+' | grep -n -E 'docs/fork|Fork feature changes|fork(-status)?:[a-z]|ramiro314'
```

The rebase comes before the reset, so the squashed commit sits on current `upstream/main` and
does not revert upstream's newer commits. The count is `1`, the title check accepts the
subject, and the two `grep` commands print nothing (the last one, section 3's fork-reference
check now run on the commit, may print a `ramiro314/mission-control#<n>` citation you meant to
keep). Rebasing is fine here: the never-rebase rule belongs to sync branches, and this branch is
not merged anywhere in the fork.

### Review: the Upstream Port Review workflow

Under Mission Control, a port task binds the **Upstream Port Review** workflow, published in the
operator's Library (workflow `a24168b2-871b-408d-b522-ad438553ccfb`, version 1). It runs the
`typecheck` and `lint` checks, then two Personas side by side: Port Fidelity Judge
(`a7bd9d33-2e4e-4b97-9432-a199ac4b28b5`), which judges that the port carries exactly this
feature as fork `main` holds it, and Port Handoff Judge (`74ab25cd-b257-466a-8928-8b6830a127f8`),
which judges the commit's shape and message. A failure returns the task for changes. It ends
without a pull request, since the upstream one is opened from the work machine.

The checks run `make check` and `make lint` in the check worktree, which reinstall dependencies
there first, because the port's upstream lockfile differs from the fork's.

Both judges ignore the captured diff. Mission Control measures a submission from its merge base
with `origin/main`, which is the fork's last sync, not from `upstream/main`: the pilot's
57-file port would have been captured as 515 files, upstream's 45 commits since that sync
included. A task's base branch can only name an `origin/<branch>`, so there is no way to point
it at `upstream/main`. The judges therefore read only registered evidence, and fail with a
request for the exact missing command when an item is absent or truncated.

Before completing the task, after the commit above, register this evidence with
`submit_workflow_evidence`, as command outputs with their exit codes or as text artifacts. Run
each command from the repository root, since a `-- .` pathspec run from a subdirectory covers
only that subdirectory, and wrap it in `bash -o pipefail -c '...'` when you record its exit
code, since zsh does not set `PIPESTATUS`:

- **Port Fidelity Judge**
  - The port: `git diff upstream/main...HEAD`.
  - The fork reference: each in-scope pull request's `git diff <merge>^1 <merge>`, plus the later
    fork changes to the feature's files (`git diff <last merge> origin/main -- <fork-only paths>`,
    and this feature's hunks of `git diff upstream/main...origin/main -- <changed upstream path>`).
  - The scope: `fork-delta.mjs show <slug>`, run from fork `main`'s copy. The script is
    fork-only, so the port branch does not have it, and copying the file alone fails because it
    imports `scripts/checkout-repository.mjs`, which imports `src/shared/`:

    ```sh
    T=$(mktemp -d); git archive origin/main scripts src/shared | tar -x -C "$T"; node "$T/scripts/fork-delta.mjs" show <slug>
    ```
  - The prerequisites from section 1, with each one's treatment.
- **Port Handoff Judge**
  - `git rev-parse --abbrev-ref HEAD`.
  - `git rev-list --count upstream/main..HEAD`.
  - `git merge-base HEAD upstream/main` and `git rev-parse upstream/main`, after a fresh
    `git fetch upstream`.
  - `git log -1 --format=%B`.
  - The `assert-release-commit.mjs` run.
  - The fork-reference `grep` on `upstream/main...HEAD`.
  - `git diff --stat upstream/main...HEAD`.
  - `git show upstream/main:.github/PULL_REQUEST_TEMPLATE.md`.
  - The output of every check the body says was run.

Each command output and each text artifact holds at most 64 KiB, so a larger diff, such as the
pilot's 131 KiB port, goes in as several text artifacts under the gitignored `.evidence/`
directory, split by path with `git diff upstream/main...HEAD -- <paths>`. The total is capped too,
command outputs and artifacts together, at 48 items and 384 KiB (`WORKFLOW_TEXT_EVIDENCE_LIMITS`
in `src/shared/workflow.ts`), and the cap is enforced at registration. Every
`submit_workflow_evidence` call goes through `stageWorkflowEvidence` in
`src/server/workflows/store.ts`, which adds the call's items to every item already staged under
another `clientItemId`. When the total is over a limit it refuses the whole call with a 409 and
stages nothing from it: `artifact_count` past 48 items, and `artifact_aggregate` past 384 KiB,
which is the refusal the pilot hit. Registering across several calls therefore does not raise the
cap. The submission counts again what applies to it, and can refuse a submission whose
registrations all passed when that count takes in:

- an item registered again unchanged under its existing ID, as the repair advice below allows,
  because a call that only does that returns before the limit check;
- an item an earlier submission of the same evidence group reserved;
- an item a retained coverage claim still links.

Carried items never refuse one: they compete last for what is left, and
what does not fit is dropped and recorded as `evidence_carry_truncated`. The freeze in
`captureSubmissionTextArtifacts` (`src/server/workflows/images.ts`) re-counts the same reserved
bytes, so it adds no refusal of its own. The Port Fidelity list fills the cap fastest,
since the port, each pull request's merge diff and the fork's final hunks overlap. Keep it under
the cap by registering only what the judge reads line by line:

- each merge diff limited to the paths in `$SCRATCH/scope`, as section 2 applies it;
- only this feature's hunks of `git diff upstream/main...origin/main`, never the whole diff;
- `git diff --stat` instead of the full text for a path the port copies unchanged from fork
  `main`, with a note saying so.

After a repair or a rebase, register every changed item under a new `clientItemId`, for example
with a `-<short sha>` suffix. Staged items are replaced by `clientItemId`, not by path. Once a
submission has frozen an item, registering different content under its ID is refused with a 409
`evidence_reserved`, and a new caption counts as different content, because
`stageWorkflowEvidence` compares the caption along with the bytes. Unchanged content can be
registered again under its existing ID, which returns it to the tray for the next submission. A
new ID adds to the tray rather than replacing anything: an earlier staged item at the same path
keeps counting toward the cap at registration, although a submission drops it once a later
registration of that path has changed its bytes. A repair round's submission also carries
forward the frozen items it did not supply again, as the carry-forward rules in
[Workflows](workflows.md) describe, so items describing an older commit can appear beside the
new ones. Put the commit SHA in every caption.

The Personas' guidance lives in the daemon's database, not in this repository, and names the
commands above. If a change to this runbook changes one of them, ask the operator before
updating the Personas, in the Library or through `PATCH /api/personas/:id` with its
`expectedRevision`.

### Push and hand off

Push the branch to the fork, and only to the fork, but not in the task's first turn. A Mission
Control ship task forbids pushing then: commit locally, register the evidence, report, and end
the turn. Run the push only when Foreman or the workflow later instructs it:

```sh
git push -u origin upstream/<slug>
```

Never push to the `upstream` remote, and never open the upstream pull request from this
machine. Report to the human the branch, the scope, the prerequisites and how each was treated,
and the commands for the work machine with `<slug>` filled in. They run once the push has
happened, in a clone of `teamupstart/mission-control` whose `origin` is `teamupstart`; the fork
is public, so the fetch needs no credentials:

```sh
git fetch https://github.com/ramiro314/mission-control.git upstream/<slug>
git push origin FETCH_HEAD:refs/heads/<slug>
gh pr create --repo teamupstart/mission-control --base main --head <slug> \
  --title "$(git log -1 --format=%s FETCH_HEAD)" --body "$(git log -1 --format=%b FETCH_HEAD)"
```

The human reports the upstream pull request's number back, which section 6 records. Switching
this checkout back to a fork branch needs `npm ci` again.

## 5. Review rounds

Address upstream review by amending the one port commit, not by adding commits, so the work
machine always pushes one commit whose message is the current title and body. Read the review
with `gh pr view <n> --repo teamupstart/mission-control --comments`, or from what the human
passes on when that read is refused.

A round usually runs days later, in another session or checkout, so start it from the fork's
copy of the port branch, which every hand-off pushes. If a local `upstream/<slug>`
already exists, `git log origin/upstream/<slug>..upstream/<slug>` must print nothing first:
`switch -C` resets the local branch to the fork's copy.

```sh
git fetch origin
PREV=$(git rev-parse origin/upstream/<slug>)   # the port commit the work machine last pushed
git switch -C upstream/<slug> origin/upstream/<slug>
npm ci
git log -1 --format=%B > "$SCRATCH/upstream-<slug>.msg"   # the current title and body
```

Make the change, run the section 3 checks it affects, update the message file, then:

```sh
git add -A
git commit --amend --cleanup=whitespace -F "$SCRATCH/upstream-<slug>.msg"
git fetch upstream
git rebase upstream/main            # only when upstream moved or the pull request conflicts
git push --force-with-lease="refs/heads/upstream/<slug>:$PREV" origin HEAD:refs/heads/upstream/<slug>
```

The push names `HEAD` as its source rather than the bare name `upstream/<slug>`, which resolves
to the `refs/remotes/upstream/<slug>` ref that `git fetch upstream` refreshes whenever no local
branch of that name exists, and would send `teamupstart`'s commit instead of the amended port.

Update the message file whenever the change alters what the body says (verification, known
gaps). Force-pushing is allowed for `upstream/*` port branches on `origin` and nothing else,
as the standing exception in the [Fork section of `AGENTS.md`](../AGENTS.md#fork) records
against its force-push rule. Never force-push fork `main`, a fork feature branch, or a sync
branch. Under Mission Control the push waits for an instruction exactly as in section 4: register
fresh evidence for the amended commit, report, and push when Foreman or the workflow says so.

Then give the human the work-machine commands again, with `<previous sha>` filled in as the
full `$PREV`:

```sh
git fetch https://github.com/ramiro314/mission-control.git upstream/<slug>
git push --force-with-lease=refs/heads/<slug>:<previous sha> origin FETCH_HEAD:refs/heads/<slug>
gh pr edit <slug> --repo teamupstart/mission-control \
  --title "$(git log -1 --format=%s FETCH_HEAD)" --body "$(git log -1 --format=%b FETCH_HEAD)"
```

Both leases name the commit expected on the remote explicitly. A bare `--force-with-lease`
compares against the clone's remote-tracking ref instead, and on the work machine, the
operator's everyday `teamupstart` checkout, any `git fetch` or `git pull` between rounds moves
that ref onto a maintainer's commit, so the lease would pass and overwrite it.

If the work-machine lease refuses the push, the upstream branch no longer holds the last port
commit: someone else pushed to it, for example a maintainer's suggested change, or the previous
round's commands were never run. Do not force past it. Read the branch with
`git fetch upstream <slug>` and `git log upstream/main..FETCH_HEAD`, bring any commit that is
not the port's into the port commit, and hand off again with the SHA the branch holds now.

## 6. Close the loop

**While the upstream pull request is open**, record it in the feature's tracking issue, so the
fork status snapshot shows the proposal and the sync that brings it in can tie the upstream
merge to the feature. Do not edit the issue: a fork pull request carries an
`#### Upstream candidate` block in its "Fork feature changes" section
([format](fork/README.md#fork-feature-changes-in-a-pull-request)), which the refresh applies
after it merges. The block replaces the whole section, so keep what still holds and add the
proposal:

```markdown
### fork:<slug>
#### Upstream candidate
base: <from `node scripts/fork-delta.mjs base <slug> "Upstream candidate"`>
Proposed as teamupstart/mission-control#<n> (opened <date>): <the pieces it carries>. <What
stays in the fork, and why.>
```

Record it as soon as the human reports the upstream pull request's number, without waiting for
a fork change to the feature, since the next paragraph asks for none. If a fork pull request
that touches the feature is already open, add the block to it. Otherwise open a record pull
request against fork `main` that carries only the record: an empty commit on a branch off
`origin/main`, the `fork:<slug>` label, and a "Fork feature changes" section holding just this
block. Like any fork pull request, it needs a pull-request grant.

```sh
git switch -c upstream-record/<slug> origin/main
git commit --allow-empty -m "docs(fork): record the upstream proposal of <feature>"
```

Avoid changing the feature in the fork while the proposal is open, because every fork change is
one more difference between the two versions. A fix that cannot wait goes into both: the fork
pull request, and a review round (section 5) on the upstream one. If upstream closes the pull
request without merging it, record that the same way, with the reason, in another record pull
request when no fork pull request touching the feature is open.

**After upstream merges it**, the weekly sync brings it in, and upstream's version wins
([section 4 of the sync runbook](upstream-sync.md#4-resolve-conflicts-upstream-wins)). That
sync's feature check (its section 2) sees the feature's surfaces touched. Its "Fork feature
changes" section then records the outcome
([section 7 of the sync runbook](upstream-sync.md#7-record-the-feature-changes-in-the-pr)):

- The whole feature went upstream: a `#### Status` block of `upstreamed` with a note naming
  the upstream pull request. The refresh closes the issue with `fork-status:upstreamed`.
- Only some pieces went upstream: the feature stays active, and replacement blocks drop what
  upstream now owns from its contracts, surfaces and fork-only files.

Removing the fork's remaining copy of what upstream took is a change to a fork feature, so it
follows rule 3 of the sync runbook's conflict policy and is asked first.
