# Shape: create tickets after the plan merges - tickets

Sliced from the approved [plan](plan.md). The breakdown review was approved on 2026-09-30: four
new tasks, mirrored to GitHub issues. Every ticket is gated on the shaping session, so none
starts before the plan's pull request merges. The tickets form one chain, because each builds
on the machinery the previous one adds.

| # | Title | Kind | Labels | Blocked by | Task | Issue |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Tickets follow-up links its tickets to the merged shape task | ship | shape-tickets-after-merge | None | _pending_ | _pending_ |
| 2 | Create tickets from a merged shape task | ship | shape-tickets-after-merge | 1 | _pending_ | _pending_ |
| 3 | Plan review's Create tickets starts the follow-up when the plan merges | ship | shape-tickets-after-merge | 2 | _pending_ | _pending_ |
| 4 | Ticket choice marker on shape tasks | ship | shape-tickets-after-merge | 3 | _pending_ | _pending_ |

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

**What to build:** on a shape task that completed through its plan PR merge, and that has no live or done tickets follow-up, the operator can choose **Create tickets** from the task's action menu on the board card or in the drawer. Mission Control creates a linked `Tickets: <shape title>` shape task in tickets-only mode and dispatches it. Its agent is told to run only the tickets skill against the merged plan, with no grilling and no plan drafting. The tickets it files link to the shape task (ticket 1), and it completes once tickets are filed or the breakdown is dismissed. The tickets skill no longer writes or commits a tickets file.

**Blocked by:** ticket 1 (Tickets follow-up links its tickets to the merged shape task).

**Acceptance criteria:**
- [ ] The action is offered, and its route accepted, only for a `shape` task that is done through its merge quorum with no live or done follow-up. Otherwise it is refused with a 409 and a reason, and duplicates are refused.
- [ ] The follow-up keeps the source's repositories and has After work set to None explicitly (not the shape Dispatch default). It uses the source's agent, or the default when that agent cannot run the tickets skill.
- [ ] A refused dispatch leaves the follow-up in the backlog with the reason.
- [ ] The tickets-only contract names the source task, its merged PR and branch. It invokes only the tickets skill, and asks with `request_input` when the merged PR does not show exactly one plan file.
- [ ] The tickets skill drops the tickets file, its commit and push, and the "record the ids" step. Its final report is the record.
- [ ] Shape docs and the fork ledger's shape entry (with the re-rendered ledger page) describe the manual action.
- [ ] A Playwright spec clicks **Create tickets** on a merged shape task and sees the follow-up card, with every agent faked.

**Test seams:** unit tests for the follow-up service and the route's accept and refuse cases; shape prompt tests for the tickets-only variant; an e2e spec for the menu action.

Context: read docs/plans/shape-tickets-after-merge/plan.md (sections 4, 5, 6, 7 and 9) first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 3: Plan review's Create tickets starts the follow-up when the plan merges

**What to build:** a newly dispatched shape task no longer files tickets in its shaping turn. Its plan review offers **Create tickets after the plan merges** or **Stop**, and Mission Control records the answer on the task. When the shape task completes through its plan PR merge with Create tickets recorded, the tickets follow-up from ticket 2 is created and dispatched automatically. If the task ends any other way, the choice lapses and nothing is created. Shape sessions dispatched before this ships keep today's behavior and are never followed up automatically.

**Blocked by:** ticket 2 (Create tickets from a merged shape task).

**Acceptance criteria:**
- [ ] A new task field records the choice. It is stamped as awaiting review when a shape task is dispatched under the new contract, and stays empty for every existing row and every other kind.
- [ ] A resolved plan review carrying `shape-follow-up` sets the choice to pending or stop. The latest resolved review wins, a dismissal writes nothing, and an unstamped task is never written.
- [ ] Merge-quorum completion of a pending shape task starts exactly one follow-up and marks it started. Completion without the merge, or an unmerged close, marks it lapsed. A merge with the shape task's workflow run still open or failed still starts it.
- [ ] The shaping contract shows the new copy (same decision and option ids) and no longer invokes the tickets skill. The workflow-bound shape completion contract no longer expects ticket or phase tasks. The plan kind's contract is unchanged.
- [ ] The field is carried on the wire task. Shape docs and the fork ledger entry describe the automatic path.
- [ ] The shape-kind Playwright spec reads the new copy.

**Test seams:** shape prompt and completion-contract unit tests; a review-resolution stamping test; a merge-completion test beside the task completion reconciler tests; a migration test; the shape-kind e2e spec.

Context: read docs/plans/shape-tickets-after-merge/plan.md (sections 1, 2, 4 and 9, and Data and compatibility) first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 4: Ticket choice marker on shape tasks

**What to build:** a shape task's board card and drawer show what will happen, or what happened, to its tickets. **Tickets after merge** shows while Create tickets is pending. Once the follow-up is created, a link to it shows. **Tickets lapsed** shows when the choice lapsed. Nothing shows otherwise.

**Blocked by:** ticket 3 (Plan review's Create tickets starts the follow-up when the plan merges).

**Acceptance criteria:**
- [ ] Pending shows "Tickets after merge" on the card and in the drawer.
- [ ] Started shows a link that opens the follow-up task.
- [ ] Lapsed shows "Tickets lapsed".
- [ ] Any other value, and every non-shape task, shows no marker.
- [ ] A Playwright spec covers all three states, selected by role and accessible name, with every agent faked.
- [ ] The fork ledger's shape entry lists the marker.

**Test seams:** a Playwright spec driving a shape task through pending, started and lapsed; a static-markup test where it pins a shape the browser cannot.

Context: read docs/plans/shape-tickets-after-merge/plan.md (section 8) first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.
