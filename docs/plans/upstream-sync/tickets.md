# Upstream sync: tickets

Source plan: [plan.md](plan.md). The breakdown was approved on 2026-09-29 and amended the same day to add ticket 3 (the fork ledger). Every ticket is
gated on the planning session and mirrored to GitHub issues.

| # | Title | Kind | Labels | Blocked by | Task | Issue |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Fork sync with upstream 1.26.0 and upstream-sync runbook | ship | upstream-sync | None | 934cd306-299f-4a3a-add6-176216b75bad | https://github.com/ramiro314/mission-control/issues/56 |
| 3 | Fork ledger | ship | upstream-sync | 1 | TBD | TBD |
| 2 | Weekly upstream-sync recurring mission | ship | upstream-sync | 1, 3 | 497e6b23-880c-45e9-9b1f-6a42dcf5b969 | https://github.com/ramiro314/mission-control/issues/57 |

## Ticket 1: Fork sync with upstream 1.26.0 and upstream-sync runbook

<!-- ticket-1-body -->
**What to build:** The fork's `main` becomes upstream `teamupstart/mission-control` `main` plus
the fork's own layer, landed as one reviewable PR that merges upstream as a real merge. After
it lands:

- Complete behaves exactly like upstream's (upstream #1148 replaces the fork's opt-in
  "Free this task's worktree" checkbox and its preview route).
- Every dependency version matches upstream's, apart from the fork-only entries.
- Dependabot is gone.
- A runbook exists that any agent can follow to repeat the sync.

**Blocked by:** None - can start immediately.

**Acceptance criteria:**
- [ ] The sync branch comes off fresh `origin/main` and merges `upstream/main` with a merge commit, with no rebase or force-push. `upstream/main` is an ancestor of the PR head.
- [ ] Fork PR #17's surface is fully removed: the checkbox, the free-preview route, the `freeWorktree` request field, `TaskFreePreview`, their docs, tests and e2e spec. A search for those symbols finds nothing.
- [ ] Dependency and devDependency versions equal upstream's. The only differences are the fork-only entries. The lockfile is regenerated starting from upstream's.
- [ ] The Dependabot config is deleted.
- [ ] The upstream-sync runbook covers every point in plan section "Ticket 1", step 5. It is linked from the docs index and has an agent-memory pointer.
- [ ] typecheck, lint, the unit suite, build, smoke and e2e all pass locally, and PR CI is green. The PR is left for the human to merge.
- [ ] Once the PR is open: Dependabot PRs #38, #39 and #42 are closed with a comment linking it, and the fork's Release workflow is disabled through `gh workflow disable`, with the file unchanged.
- [ ] Any conflict outside the ones the plan resolves follows decision D6: upstream wins, and a fork feature is not removed or reworked without asking the human first.

**Test seams:** The existing suites carry the proof. Upstream's own tests and e2e specs for worktree
return, requeue and board column widths must pass, and the unit and e2e suites must stay green once
the removed feature's test and spec are gone. Include a `git merge-base --is-ancestor` check and a
dependency diff against `upstream/main` in the PR evidence.

Context: read docs/plans/upstream-sync/plan.md (sections "Decisions" and "Ticket 1") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.
<!-- /ticket-1-body -->

## Ticket 3: Fork ledger

<!-- ticket-3-body -->
**What to build:** A fork ledger that documents everything this fork changes against the
original Mission Control, as one entry per fork feature. It has two jobs: an agent can use it
to detect conceptual conflicts with new upstream commits, and the human can see where the fork
stands at a glance.

**Blocked by:** Ticket 1 (Fork sync with upstream 1.26.0 and upstream-sync runbook).

**Acceptance criteria:**
- [ ] The ledger (markdown plus a self-contained HTML rendering, in light and dark) lives at the location plan decision D15 names. It is linked from the docs index and from the upstream-sync runbook.
- [ ] A status header shows the last synced upstream version and SHA, the sync date, fork commits ahead and upstream commits behind, and the active feature count. The numbers match git at the time of writing.
- [ ] One entry per fork feature records: intent; behavior contracts and the upstream behavior it assumes; upstream surfaces touched (modules, routes, protocol types, DB columns, UI views); status (active, superseded by upstream, removed, or upstreamed, with the date and the sync PR); the PRs and plan docs behind it; and whether it is an upstream candidate.
- [ ] Every merged fork PR from #1 to #53 appears in exactly one feature entry or in the "Standalone fixes" table. "Complete frees the worktree" (#11, #17) is marked superseded by upstream #1148, and Dependabot is marked removed, both through the ticket 1 sync PR.
- [ ] The upstream-sync runbook gains the ledger steps. Before merging, check the new upstream commits against each active entry's contracts, assumptions and surfaces, and write a "Conceptual conflicts" section in the sync PR; any hit follows the ask-before-removing policy. After merging, update statuses and the header, then re-render the HTML.
- [ ] AGENTS.md ends with a short "Fork" section. It points to the ledger and the runbook, and says that any fork PR adding or changing a feature updates its ledger entry and re-renders the page in the same PR.

**Test seams:** Documentation only. Include in the PR evidence a PR-coverage check: the list of merged fork PRs from `gh pr list`, compared against the PR numbers cited in the ledger, with none missing. Also include the git counts behind the header.

Context: read docs/plans/upstream-sync/plan.md (decisions D12 to D19 and section "Ticket 3") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.
<!-- /ticket-3-body -->

## Ticket 2: Weekly upstream-sync recurring mission

Note: ticket 2 was filed before ticket 3 existed, so its task intent says it is blocked by ticket 1 only. When the amendment was filed, a blocker edge on ticket 3 was added to its task.

<!-- ticket-2-body -->
**What to build:** Every Monday at 09:00 local time, Mission Control files a task that brings the
fork up to date with upstream by following the upstream-sync runbook. When upstream has
nothing new, the run ends without a branch or PR. When it has, the run ends with a sync PR
that the human merges.

**Blocked by:** Ticket 1 (Fork sync with upstream 1.26.0 and upstream-sync runbook).

**Acceptance criteria:**
- [ ] A recurring mission named "Sync fork with upstream" exists on the operator's daemon for this repository. It is enabled, weekly on Mondays at 09:00 in the operator's local time zone, collapses missed runs into one catch-up, skips when a previous run's task is still open, inherits the agent from the task kind, and has After work set to None.
- [ ] Its task template tells the agent to follow the runbook, and to exit without a branch or PR when upstream has nothing new.
- [ ] The preview shows the next occurrences on Mondays at 09:00 local. A manual Run now files a backlog task that references the runbook.
- [ ] The runbook records the mission's name and cadence, and that change lands in this ticket's PR.

**Test seams:** The daemon's schedule preview and Run now through the Missions overlay or the schedules
API. The filed backlog task is the proof. No code change is expected beyond the runbook update.

Context: read docs/plans/upstream-sync/plan.md (sections "Decisions" D8 and D9, and "Ticket 2") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.
<!-- /ticket-2-body -->
