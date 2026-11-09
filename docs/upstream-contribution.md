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

Start from the feature's tracking issue, read as the refresh will see it once every merged fork
pull request has applied:

```sh
gh issue list --repo ramiro314/mission-control --label fork-feature --state open --limit 100
node scripts/fork-delta.mjs show <slug>
```

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
  --json files --jq '.[].files[].path' | sort -u | while read -r p; do
  git cat-file -e "origin/main:$p" 2>/dev/null || continue
  git cat-file -e "upstream/main:$p" 2>/dev/null && echo "changed   $p" || echo "fork-only $p"
done | tee "$SCRATCH/scope"
grep '^fork-only' "$SCRATCH/scope" | cut -c11- > "$SCRATCH/fork-only-paths"
```

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
owns; an import into another feature's file shows up when the port branch fails to typecheck
(section 3). Four fork-only foundations are the usual ones:

| Foundation | Recognize it by | Usual treatment |
| --- | --- | --- |
| Linux support (#463) | Linux platform branches, `src/web/lib/platform.ts`, `scripts/require-macos.mjs`, Linux-only e2e specs | Drop the Linux rows and keep upstream's behavior, unless Linux is the point of the pull request. |
| Platform seams (#422) | `src/server/process-inspection/`, `src/server/platform/process-lifetime.ts`, `src/server/platform/executable-environment.ts`, `scripts/native-addon-sources.mjs` | Call the POSIX implementation directly, the way upstream's code at that site still does. |
| Flake-aware testing (#296) | `test:run`, JUnit output, `.mission/testing.json`, the `affected-tests` Command, Wait for CI, `mission-flake-report` | Drop the hooks. The port's tests run under upstream's own `npm test`. |
| Decision forms (#292) | `src/server/foreman/decision-draft.ts`, recommended options preselected, Other as its own radio | Build on upstream's decision form as it stands, and drop the Foreman draft paths. |

Record each prerequisite and its treatment for the pull request's "Known gaps" (section 4). A
prerequisite that cannot be stripped without breaking the feature is the human's call: ask
whether to propose it upstream first, and do not fold it into this pull request.

## 2. Port the final state

Branch from upstream, never from fork `main`. Fork `main` is about 1,276 commits ahead of
upstream (2026-11-08), so a branch from it would propose the whole fork:

```sh
git fetch origin
git fetch upstream
git switch -c upstream/<slug> upstream/main
npm ci
```

`npm ci` is needed because upstream's lockfile is not the fork's; the fork's `node_modules`
do not belong to this branch. A local branch named `upstream/<slug>` sits beside the
`upstream/*` remote-tracking refs, and git resolves the name to the local branch first; once
`teamupstart` holds a branch named `<slug>`, `git` warns that the name is ambiguous and still
uses the local branch.

Re-apply the feature **as it stands on fork `main`**, not by replaying its pull requests. The
fork's history carries reverts, repairs and other features' edits that upstream should never
see.

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

Before handing off, confirm the branch carries nothing from the fork beyond the feature:

```sh
git diff --stat upstream/main...HEAD
git diff upstream/main...HEAD | grep '^+' | grep -n -E 'docs/fork|Fork feature changes|fork(-status)?:[a-z]|ramiro314'
```

The second command searches only the lines the port adds, and should print nothing, or only a
`ramiro314/mission-control#<n>` citation you meant to keep.

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
```

The rebase comes before the reset, so the squashed commit sits on current `upstream/main` and
does not revert upstream's newer commits. The count is `1`, the title check accepts the
subject, and the last command prints nothing. Rebasing is fine here: the never-rebase rule
belongs to sync branches, and this branch is not merged anywhere in the fork.

Push the branch to the fork, and only to the fork:

```sh
git push -u origin upstream/<slug>
```

Never push to the `upstream` remote, and never open the upstream pull request from this
machine. Report to the human the branch, the scope, the prerequisites and how each was treated,
and the commands for the work machine with `<slug>` filled in. They run in a clone of
`teamupstart/mission-control` whose `origin` is `teamupstart`; the fork is public, so the fetch
needs no credentials:

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

```sh
git fetch origin
PREV=$(git rev-parse origin/upstream/<slug>)   # the port commit the work machine last pushed
git add -A
git commit --amend --cleanup=whitespace -F "$SCRATCH/upstream-<slug>.msg"
git fetch upstream
git rebase upstream/main            # only when upstream moved or the pull request conflicts
git push --force-with-lease="refs/heads/upstream/<slug>:$PREV" origin upstream/<slug>
```

Update the message file whenever the change alters what the body says (verification, known
gaps). Force-pushing is allowed for `upstream/*` port branches on `origin` and nothing else:
this runbook is the request `AGENTS.md` requires, and the target is verified by its name. Never
force-push fork `main`, a fork feature branch, or a sync branch.

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

**While the upstream pull request is open**, record it in the feature's tracking issue. Do not
edit the issue: the next fork pull request that touches the feature carries an
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

Avoid changing the feature in the fork while the proposal is open, because every fork change is
one more difference between the two versions. A fix that cannot wait goes into both: the fork
pull request, and a review round (section 5) on the upstream one. If upstream closes the pull
request without merging it, record that the same way, with the reason.

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
