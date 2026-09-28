# Decision forms: Other as its own radio choice - tickets

Plan: [plan.md](plan.md). Breakdown approved in Mission Control on 2026-09-28. Not mirrored:
no task source is configured for this repository.

| # | Title | Kind | Labels | Blocked by | Task |
| --- | --- | --- | --- | --- | --- |
| 1 | Decision forms: Other as its own radio choice | bugfix | decision-other-radio | Planning session (its PR must merge first) | 2c8ebe69-6489-4f11-8029-0b66b6280b53 |

## Ticket 1: Decision forms: Other as its own radio choice

**What to build:** on a single-choice decision question that allows Other, Other is a real
choice in the same radio group instead of a free-text box beside the radios. A human answering
a plan review or input request can send "Other only": typing in Other, or clicking its radio or
its text box, selects Other and clears the preselected recommended option. Picking a listed
option deselects Other, and the typed text stays visible but is not sent. Multi-choice questions
keep today's additive Other.

**Blocked by:** No other ticket. Gated on the planning session: it starts only after the planning pull request merges, because that merge is what puts docs/plans/decision-other-radio/plan.md on main for this ticket to read.

**Acceptance criteria:**
- [ ] A single-choice question with Other renders an Other radio in the same group as the listed options. Multi-choice questions are unchanged.
- [ ] Typing in Other, clicking the Other radio, or a pointer click in its text box selects Other and unchecks the listed option. A click on the radio moves focus into the box.
- [ ] Choosing a listed option deselects Other. The kept text stays in the box, and the submitted answer and "Selected:" summary contain only the listed option.
- [ ] Tabbing into the text box with the keyboard does not change the selection.
- [ ] Other selected with blank text leaves the question unanswered, so Submit is disabled.
- [ ] Submitting with Other selected sends no listed option and only the Other text. The answer's wire shape is unchanged (no synthetic option id).
- [ ] A Foreman draft carrying Other text for a single-choice question opens with Other selected. Undo Foreman restores the recommended option.
- [ ] The existing Foreman decision-draft e2e spec still passes.

**Test seams:** the form's exported pure helpers and static markup, in the plan-decisions unit test file. A new Playwright spec drives a single-choice question through typing, switching back, Tab versus click, and empty-Other Submit, using fake agents only.

Context: read docs/plans/decision-other-radio/plan.md (sections "Behavior" and "Implementation") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

Note: the filed task's intent text was created before this correction and still reads "None -
can start immediately". The gate is still enforced: the task was created with
`dependsOnCurrentSession: true`, so Mission Control keeps it in the backlog until this planning
session's pull request merges. This file is the corrected record.
