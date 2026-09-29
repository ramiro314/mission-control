# Upstream sync: tickets

Source plan: [plan.md](plan.md). The breakdown was approved on 2026-09-29. Every ticket is
gated on the planning session and mirrored to GitHub issues.

| # | Title | Kind | Labels | Blocked by | Task | Issue |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Fork sync with upstream 1.26.0 and upstream-sync runbook | ship | upstream-sync | None | TBD | TBD |
| 2 | Weekly upstream-sync recurring mission | ship | upstream-sync | 1 | TBD | TBD |

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

## Ticket 2: Weekly upstream-sync recurring mission

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
