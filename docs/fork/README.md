# Tracking the fork's features

`ramiro314/mission-control` is a fork of
[`teamupstart/mission-control`](https://github.com/teamupstart/mission-control). What the fork
changes against upstream is recorded on GitHub, one **tracking issue** per fork feature, joined
to the pull requests that built it by a **`fork:<slug>` label**. Nothing in this repository
lists the features, so no two pull requests ever edit the same lines to record them. The plan
behind this is [docs/plans/fork-tracking/plan.md](../plans/fork-tracking/plan.md); it replaced
the fork ledger that lived here before.

There are two readers:

- **The upstream-sync agent** checks each new upstream commit against every active feature's
  contracts, assumptions and surfaces ([the upstream-sync runbook](../upstream-sync.md),
  section 2).
- **The human** reads the fork status snapshot that `scripts/fork-report.mjs` renders (see
  [The status snapshot](#the-status-snapshot)).

## Labels

| Label | On | Meaning |
| --- | --- | --- |
| `fork-feature` | Tracking issues | This issue is a fork feature's record. |
| `fork:<slug>` | The tracking issue and every PR of that feature | The join key. A PR may carry several. |
| `fork-status:in-progress` | An open tracking issue | The feature is not finished on `main`. |
| `fork-status:superseded`, `fork-status:removed`, `fork-status:upstreamed` | A closed tracking issue | Why the feature is no longer active. Exactly one per closed issue. |
| `fork-delta:applied` | A merged PR | The refresh has applied this PR's "Fork feature changes" section. |

An open issue without a `fork-status:*` label is an active feature. A closed issue carries one
closing status and a comment naming the date and the PR that closed it.

A slug is the feature's name lowercased, with every run of other characters one hyphen
("Per-task base branch" is `fork:per-task-base-branch`). GitHub refuses a label longer than 50
characters, so a long name gets a shorter slug. List the existing features and their labels with:

```sh
gh issue list --repo ramiro314/mission-control --label fork-feature --state all
```

## Tracking issue

Title `Fork feature: <name>`, labels `fork-feature`, `fork:<slug>` and, when the feature is not
plainly active, its `fork-status:*` label. The body is a short preamble followed by these
sections, in this order, each a `###` heading so the refresh can replace it by name:

```markdown
### Intent
### Behavior contracts
### Upstream behavior it assumes
### Upstream surfaces touched
### Fork-only files
### Plan docs
### Upstream candidate
```

- **Intent**: what the feature does and why the fork needs it. Its first sentence is the
  feature's one-line summary in the snapshot.
- **Behavior contracts**: what the fork promises. A sync must keep these true.
- **Upstream behavior it assumes**: an upstream commit that changes one of these is a
  conceptual conflict even when it merges cleanly.
- **Upstream surfaces touched**: modules, routes, protocol types, database columns, MCP tools
  and UI views the feature changes.
- **Fork-only files**: paths upstream does not have.

An issue may carry further `###` sections after these, such as "Why it was removed". The
issue body holds no PR list: the PRs are whatever GitHub returns for the label.

## "Fork feature changes" in a pull request

Every PR into `main` that adds or changes a fork feature carries the feature's `fork:<slug>`
label and a `## Fork feature changes` section in its body. The section is either the single
word `none`, or one `###` block per feature it changes, holding one `####` block per issue
section it replaces:

```markdown
## Fork feature changes

### fork:per-task-base-branch
#### Behavior contracts
base: 3f9a1c07be42
- (the complete new list, not a diff)
#### Upstream surfaces touched
base: 9d02e6a4c1f8
(the complete new text)

### fork:windows-support
#### Status
base: 51c0e8d2a7b3
active
```

- Each `####` block replaces the issue section of the same name **in full**.
- Its first line, `base: <hash>`, records the text it replaces, so two PRs that edit the same
  section are caught instead of the second silently overwriting the first. Print it with
  `node scripts/fork-delta.mjs base <slug> "<section>"`. It is computed over the issue as the
  refresh will see it once every merged, unapplied PR has applied, which
  `node scripts/fork-delta.mjs show <slug>` prints; edit against that text. `base: new` means
  the section or the issue does not exist yet.
- A `#### Status` block holds one of `active`, `in-progress`, `superseded`, `removed` or
  `upstreamed`, plus an optional note. Its base comes from
  `node scripts/fork-delta.mjs base <slug> Status`.
- `node scripts/fork-delta.mjs check <pr>` validates a PR's section and reports a stale base.

**A new feature.** The PR creates the `fork:<slug>` label and its tracking issue with the full
body when it opens, and labels itself. Its section is then `none`, unless it changed the issue
after creating it. [`AGENTS.md`](../../AGENTS.md#fork) records the standing grant for those
writes, and the fallback: when a session's authorization still refuses them, the PR's section
carries the full issue body under `### fork:<slug>`, and the refresh creates the label and the
issue after the merge.

**A held PR.** When the refresh finds a stale base, it applies nothing from that PR, holds back
every later PR that names any feature the held PR names, and reports them. To repair it,
rewrite the block in the merged PR's body against `node scripts/fork-delta.mjs show <slug> --pr
<n>`, keeping both changes, and set its base from `node scripts/fork-delta.mjs base <slug>
"<section>" --pr <n>`. The next refresh applies it, then the PRs held behind it.

PRs into `release/windows` carry `fork:windows-support` too, but they are not `main` changes
and are never applied; see [docs/windows-branch-sync.md](../windows-branch-sync.md).

## Refreshing the issues

Issue bodies have one writer: the refresh, which applies merged PRs' sections in merge order.
The cut-over is the day the PR that deleted the fork ledger merged into `main`. PRs merged
before it edited the ledger, and the migration carried their changes into the issues. Print the
date with:

```sh
git log -1 --first-parent --format=%cs origin/main -- docs/fork/ledger.md
```

The procedure, with `<cut-over>` that date:

1. **List the pending PRs.** `node scripts/fork-delta.mjs pending --since <cut-over>` lists
   every PR merged into `main` on or after the cut-over that lacks `fork-delta:applied` and
   carries a `fork:*` label or a "Fork feature changes" section, oldest merge first, each
   marked apply or held.
2. **Apply each one that may apply.** Run `node scripts/fork-delta.mjs check <pr> --since
   <cut-over>` first; it exits 1 for a stale or held PR, which gets no writes. For the others:
   replace each named issue section; apply any Status block (labels, close or reopen, and a
   closing comment with the date and the PR number, only when the issue is not already in that
   state); create a missing `fork:<slug>` label or tracking issue from the section, after
   checking it does not exist; add any `fork:*` label the PR is missing; then add
   `fork-delta:applied` last. A labeled PR whose section is `none`, or missing, gets
   `fork-delta:applied` too, and a missing section is reported so the human can backfill it.
   Every write is safe to repeat, because a run that fails partway repeats that PR next time.
3. **Render the snapshot** with `node scripts/fork-report.mjs`.
4. **Publish it.** Replace the fork status doc's whole content with `.tmp/fork-report.md`. If
   that fails, report the failure and leave the file in place; steps 1 and 2 have already
   happened.

Report every held PR, and every PR held behind it, in the run's summary.

### The "Refresh fork status" mission

A [recurring mission](../recurring-missions.md) runs the procedure above. It lives on the
operator's daemon, not in this repository.

| Setting | Value |
| --- | --- |
| Schedule | Daily at 08:00 local time |
| Missed runs | Coalesce to latest |
| Overlap | Skip if active |
| Completion | Complete the task automatically |
| Pull request | None: the mission writes no repository files |

Its task body grants the issue, label and doc writes the procedure makes. Press **Run now** on
it after merging an upstream-sync PR, so the sync's status changes reach the issues the same
day; otherwise the next daily run applies them.

## The status snapshot

`node scripts/fork-report.mjs` writes `.tmp/fork-report.md` (gitignored), built from GitHub
and `git` alone:

- **Status header**: the last synced upstream version and SHA (the merge-base of
  `upstream/main` and `origin/main`), the last sync PR, commits ahead and behind, the active
  feature count, and when it was measured.
- **Features**: one row per tracking issue, with its status, the first sentence of its Intent,
  and the PRs merged into `main` that carry its label.
- **Standalone fixes**: PRs merged into `main` with no `fork:*` label, apart from upstream-sync
  and bot-authored PRs. A feature PR that forgot its label shows up here; label it to fix that.

It shows only PRs merged into `main`: no open PRs, and nothing that is only on
`release/windows`.

## Pull requests open across the cut-over

A PR that edited the ledger and was still open when the ledger was deleted meets a
modify/delete conflict on `docs/fork/ledger.md` or `docs/fork/ledger.html` on its next update
from its base branch. Resolve it the same way every time:

1. Keep the deletion (`git rm docs/fork/ledger.md docs/fork/ledger.html`).
2. Move the PR's ledger edit into a "Fork feature changes" section in its body, in the format
   above.
3. Add the feature's `fork:<slug>` label to the PR.
