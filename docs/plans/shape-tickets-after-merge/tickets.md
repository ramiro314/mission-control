# Shape: create tickets after the plan merges - tickets

Sliced from the approved [plan](plan.md). The breakdown review was approved on 2026-09-30: four
new tasks, mirrored to GitHub issues. Workflow repair round 1 revised the bodies of tickets 2, 3
and 4 to match the repaired plan, and the filed tasks and issues were updated to match (see
Filed text below). Every ticket is gated on the shaping session, so none
starts before the plan's pull request merges. The tickets form one chain, because each builds
on the machinery the previous one adds.

| # | Title | Kind | Labels | Blocked by | Task | Issue |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Tickets follow-up links its tickets to the merged shape task | ship | shape-tickets-after-merge | None | `64153ddd-3ae3-435d-bc9e-80f7d1fca1a5` | [#79](https://github.com/ramiro314/mission-control/issues/79) |
| 2 | Create tickets from a merged shape task | ship | shape-tickets-after-merge | 1 | `9eb46013-dcc1-42fc-8c3b-3c8fb6dac1a9` | [#80](https://github.com/ramiro314/mission-control/issues/80) |
| 3 | Plan review's Create tickets starts the follow-up when the plan merges | ship | shape-tickets-after-merge | 2 | `3af50049-129d-4427-9b9c-08c6194db71f` | [#81](https://github.com/ramiro314/mission-control/issues/81) |
| 4 | Ticket choice marker on shape tasks | ship | shape-tickets-after-merge | 3 | `64e5c4a6-8365-4f09-b357-dcb5cf781b71` | [#82](https://github.com/ramiro314/mission-control/issues/82) |

## Ticket 1: Tickets follow-up links its tickets to the merged shape task

**What to build:** a shape task can have linked tickets follow-ups, recorded in a relation beside the Retro follow-up's. When an agent in a tickets follow-up session files a ticket with `create_task` and `dependsOnCurrentSession`, the ticket gets an already-satisfied dependency on the original, merged shape task, not on the follow-up. So it is eligible as soon as its own blockers allow. `push_task` from that follow-up session accepts those tickets and files each item under the shape task's item, exactly as tickets filed from the shaping session are today.

**Blocked by:** None - can start immediately.

**Acceptance criteria:**
- [ ] A relation records each tickets follow-up against its source shape task, with the source's merged episode and PR URL. It allows a retry after a cancelled or failed follow-up, and a follow-up id appears in it at most once.
- [ ] From a follow-up session, `dependsOnCurrentSession: true` yields a task edge to the source shape task, pinned to its merged episode and already satisfied. No edge to the follow-up is created.
- [ ] From any other session, `dependsOnCurrentSession` behaves exactly as before.
- [ ] `push_task` from the follow-up session accepts a ticket linked this way and parents its item under the shape task's item. It still refuses a task that waits on neither the caller nor the caller's source shape task.
- [ ] An existing database opens with the new relation.

**Test seams:** unit tests for MCP `create_task` and task dependencies with a seeded follow-up relation; a push-route test for the gate and the parent; a migration test.

Context: read docs/plans/shape-tickets-after-merge/plan.md (sections 3 and 5) first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 2: Create tickets from a merged shape task

**What to build:** on a shape task that completed through its plan PR merge, and that has no live or done tickets follow-up, the operator can choose **Create tickets** from the task's action menu on the board card or in the drawer. Mission Control creates and dispatches a linked `Tickets: <shape title>` shape task in tickets-only mode: it runs only the tickets skill against the merged plan. The tickets it files link to the shape task (ticket 1). It completes, and its session closes, once tickets are filed or the breakdown is dismissed, through a completion tool only follow-ups are granted. In a follow-up the tickets skill skips the tickets file. Every other caller, including old-prompt shaping sessions, keeps the current flow.

**Blocked by:** ticket 1 (Tickets follow-up links its tickets to the merged shape task).

**Acceptance criteria:**
- [ ] The action is offered, and its route accepted, only for a `shape` task that is done with a merged PR posture (the post-merge Retro's check) and no live or done follow-up. Otherwise it is refused with a 409 and a reason, and duplicates are refused.
- [ ] The wire task carries a derived `shapeTickets` field with the newest follow-up's id and whether Create tickets is allowed. The menu item reads it, and a follow-up status change re-sends the source task.
- [ ] The follow-up keeps the source's repositories, has After work explicitly None (not the shape Dispatch default), and uses the source's agent, or the default when that agent cannot run the tickets skill.
- [ ] A refused dispatch leaves it in the backlog with the reason.
- [ ] The tickets-only contract names the source task, its merged PR and branch. It invokes only the tickets skill, and asks with `request_input` when the merged PR does not show exactly one plan file.
- [ ] A new MCP tool, granted only to follow-up launches, completes the follow-up with outcome `filed` or `dismissed` and requests session closure. It is refused for other sessions and idempotent on replay. A test proves the follow-up reaches `done` after filing and after a dismissed breakdown.
- [ ] The tickets skill gains a follow-up mode that skips the tickets file, its commit and push, and the "record the ids" step, and ends by calling that tool. In-session mode is unchanged.
- [ ] Shape docs and the fork ledger's shape entry (re-rendered page) describe the manual action.
- [ ] A Playwright spec clicks **Create tickets** on a merged shape task and sees the follow-up card, with every agent faked.

**Test seams:** unit tests for the follow-up service, the route, the completion tool and the wire field; shape prompt and skill contract tests for both modes; an e2e spec for the menu action.

Context: read docs/plans/shape-tickets-after-merge/plan.md (sections 4, 5, 6, 7 and 9) first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 3: Plan review's Create tickets starts the follow-up when the plan merges

**What to build:** a newly dispatched shape task no longer files tickets in its shaping turn. Its plan review offers **Create tickets after the plan merges** or **Stop**, and Mission Control records the answer on the task. When the shape task completes through its plan PR merge with Create tickets recorded, the tickets follow-up from ticket 2 is created and dispatched automatically. The choice reads as started only once dispatch succeeds, or as queued while a refused follow-up waits in the backlog. If the task ends any other way, or its PR is closed unmerged, the choice lapses and nothing is created. Shape sessions dispatched before this ships keep today's behavior.

**Blocked by:** ticket 2 (Create tickets from a merged shape task).

**Acceptance criteria:**
- [ ] A new task field records the choice. It is stamped as awaiting review when a shape task is dispatched under the new contract, and stays empty for every existing row and every other kind.
- [ ] A resolved plan review carrying `shape-follow-up` sets the choice to pending or stop. The latest resolved review wins, a dismissal writes nothing, and an unstamped task is never written.
- [ ] Before the lapse work: confirm how a task-bound PR's closed, unmerged state can be read (today the PR poller treats it as no PR), and record it in the pull request.
- [ ] Merge-quorum completion of a pending shape task starts exactly one follow-up. The choice becomes started only after dispatch succeeds. A refused dispatch makes it queued, and queued becomes started when that follow-up is dispatched later. A merge with the shape task's workflow run still open or failed still starts it.
- [ ] Completion or cancellation without the merge marks a pending choice lapsed. A new task-level PR-closed signal does the same for an unmerged close. Nothing is created. A lapsed task that later merges (a replaced PR) still starts it.
- [ ] The shaping contract shows the new copy (same decision and option ids) and no longer invokes the tickets skill. The workflow-bound shape completion contract no longer expects ticket or phase tasks. The plan kind's contract is unchanged.
- [ ] The recorded choice fills the wire task's `shapeTickets` state. Shape docs and the fork ledger entry describe the automatic path.
- [ ] The shape-kind Playwright spec reads the new copy.

**Test seams:** shape prompt and completion-contract unit tests; a review-resolution stamping test; a merge-completion test beside the task completion reconciler tests (started, queued, lapsed); a closed-PR signal test beside the PR poller tests; a migration test; the shape-kind e2e spec.

Context: read docs/plans/shape-tickets-after-merge/plan.md (sections 1, 2, 4 and 9, Data and compatibility, and Assumptions to confirm during implementation) first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 4: Ticket choice marker on shape tasks

**What to build:** a shape task's board card and drawer show what will happen, or what happened, to its tickets. **Tickets after merge** shows while Create tickets is pending. **Tickets queued** with a link shows while a refused follow-up waits in the backlog. Once the follow-up is dispatched, a link to it shows. **Tickets lapsed** shows when the choice lapsed. Nothing shows otherwise.

**Blocked by:** ticket 3 (Plan review's Create tickets starts the follow-up when the plan merges).

**Acceptance criteria:**
- [ ] Pending shows "Tickets after merge" on the card and in the drawer.
- [ ] Queued shows "Tickets queued" and started shows "Tickets", each with a link that opens the follow-up task.
- [ ] Lapsed shows "Tickets lapsed".
- [ ] Any other value, and every non-shape task, shows no marker.
- [ ] A Playwright spec covers all four states, selected by role and accessible name, with every agent faked.
- [ ] The fork ledger's shape entry lists the marker.

**Test seams:** a Playwright spec driving a shape task through pending, queued, started and lapsed; a static-markup test where it pins a shape the browser cannot.

Context: read docs/plans/shape-tickets-after-merge/plan.md (section 8) first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Filed text

The four tasks and issues #79 to #82 were first filed from the pre-repair breakdown. After
Plan Validation repair round 1 and GitHub Inspector's review on PR #83, with the human's
approval, the intents of tickets 2, 3 and 4 were replaced in Mission Control (task update
route) and issues #80 to #82 were edited to match, before the plan PR merged. Every filed task
intent and issue body now equals its ticket body above. Ticket 1 was never changed.
