# GitHub Inspector findings: tickets

Sliced from the approved [plan](plan.md), merged in
[#514](https://github.com/ramiro314/mission-control/pull/514). The breakdown review was
approved on 2026-10-13: eight new tasks, kept in Mission Control only, because no task source
is configured for this repository.

The plan's own shape task completed without a merged pull request recorded against it, so its
"Create tickets after the plan merges" choice (D-27) lapsed and no follow-up could start. These
tickets were filed instead from a later shaping session, at the operator's request, through the
tickets skill's in-session mode.

## How the breakdown was settled

- **Every phase splits in two**, so each pull request fits one agent's context window.
  Phase 1 becomes tickets 1 and 2, phase 2 tickets 3 and 4, phase 3 tickets 5 and 6, and phase 4
  tickets 7 and 8.
- **Phase 4 splits only at the UI.** Today a review GitHub refuses leaves the head unadvanced, and
  the Inspector reviews it again after every backoff. Carrying drafts without D-28's refusal
  handling would turn one bad draft into a model review on every backoff. So ticket 7 ships the
  carry, the classifier and the pinning together, and ticket 8 adds only how a refusal is shown.
- **Edges are the real gates only**, which the human chose over D-25's strict phase gates. Ticket 2
  runs beside tickets 3 and 5, because they read the link field ticket 1 adds and show "link not
  captured yet" until ticket 2 fills it. Ticket 7 waits on Foreman's relay (ticket 4), as the plan
  requires, but not on the modal. Everything the plan says phase 4 needs from phase 3 is in ticket
  8, which waits on ticket 6.
- **Ticket 1 can start right away.** No ticket waits on the session that filed them, because the
  plan they point at was already on `main`.
- **Ticket 1 creates** the `fork:inspector-findings` label and its tracking issue. Every ticket's
  pull request carries the label.

**Run in parallel:** tickets 2, 3 and 5 once ticket 1 merges; then tickets 4 and 6 beside each
other. Ticket 7 follows ticket 4, and ticket 8 follows tickets 6 and 7.

| # | Title | Kind | Labels | Blocked by | Task |
| --- | --- | --- | --- | --- | --- |
| 1 | GitHub Inspector findings ledger: posted state and read route | ship | inspector-findings | None | `40d0a02c-d273-4b63-8553-85bd71e843d1` |
| 2 | GitHub Inspector findings link to their GitHub comments | ship | inspector-findings | 1 | `c1271aff-5361-4011-acb2-e89e2039814b` |
| 3 | Shared GitHub Inspector findings renderer with posted markers | ship | inspector-findings | 1 | `aaec8418-48e9-4ddf-ac42-0cff840a0181` |
| 4 | Foreman relays every unresolved GitHub Inspector finding as text | ship | inspector-findings | 1, 3 | `fed0cc48-692b-43a0-92f4-190a2132e510` |
| 5 | Shared GitHub Inspector findings table with a Posted column | ship | inspector-findings | 1 | `ef173762-abfb-41ca-83b4-3c28381d9973` |
| 6 | Findings modal in Settings, GitHub Inspector, Inspections | ship | inspector-findings | 1, 5 | `eaa135ed-62e5-494a-92b4-1eb21b78a58e` |
| 7 | Drafted GitHub Inspector findings are posted after a switch to live | bugfix | inspector-findings | 4 | `093ba188-a632-47bd-9e03-23288548fcc7` |
| 8 | Refused GitHub Inspector drafts show their refusal count and reason | ship | inspector-findings | 6, 7 | `4f8554f2-e263-44e1-8a23-3732863ccb27` |

## Ticket 1: GitHub Inspector findings ledger: posted state and read route

**What to build:** Every GitHub Inspector finding records whether and when it was posted to GitHub, and one read-only daemon route returns a pull request's individual findings with that posted state, so Foreman and the dashboard can read them over HTTP. A finding recorded before this change reports only what its row proves, and "unknown" otherwise.

**Blocked by:** None - can start immediately.

**Acceptance criteria:**
- [ ] The findings ledger gains `posted_at`, `github_url` (empty until ticket 2 fills it) and `legacy_posted`, each added through the migration path, with the one-time `legacy_posted` backfill the plan specifies.
- [ ] `posted_at` is stamped when an accepted review promotes its rows to open, and when posting reconciliation finds a row published. It is never cleared, and it is carried forward through re-raising and resolution.
- [ ] One browser-safe derivation, `findingPublication`, returns the phase 1 states (posted, posting, not-posted, unknown), the link, the post time and `earlierPost`, by the plan's rule table. It has no refusal state yet.
- [ ] `GET /api/inspector/findings?pr=<prKey>` answers 400 for a missing or malformed key, 404 for an unknown pull request, and otherwise the pull request and every finding in every status, in the renderer's order, through one response schema that Foreman's client and the web client both parse. Both clients gain the call.
- [ ] A single upsert is still the only writer of finding rows.
- [ ] This PR creates the `fork:inspector-findings` label and its `fork-feature` tracking issue from the draft in the plan's "Fork feature tracking" section, and carries the label.

**Test seams:** migrating a database created before the columns existed, for every legacy status; stamping at both confirmation points and carry-through on resolution; the route's 400, 404 and 200 cases; `findingPublication`'s phase 1 rule table, including `earlierPost` from `posted_at` and from `legacy_posted = posted`; the existing single-writer test.

Context: read docs/plans/inspector-findings/plan.md (Design sections 1 and 2, Phases, and Tests and verification for phase 1) first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 2: GitHub Inspector findings link to their GitHub comments

**What to build:** Once a GitHub Inspector finding is on GitHub, its ledger row holds the URL of its review comment, or, for a finding demoted into the review summary, the URL of the review that carried it. The link is captured from the pull request snapshot the Inspector already reads every tick, so the findings route returns working links at no extra GitHub cost.

**Blocked by:** ticket 1 (GitHub Inspector findings ledger: posted state and read route).

**Acceptance criteria:**
- [ ] The thread and review reads the Inspector already makes also request each comment's and review's URL. No GitHub call is added to a tick.
- [ ] Each tick writes `github_url` on every row whose marker thread it sees and whose stored link is missing or different.
- [ ] A demoted finding takes the URL of our own review whose body carries the body-only findings marker and that row's round header, by the same ownership rule threads use. A finding that matches nothing keeps no link and still reads as posted.
- [ ] The link is carried forward when a finding is raised again, so a drafted row whose earlier version was posted still links to that earlier comment.
- [ ] The PR carries the `fork:inspector-findings` label.

**Test seams:** URL capture from a snapshot fixture, for an inline finding and for a demoted one; a tick makes the same GitHub calls as before.

Context: read docs/plans/inspector-findings/plan.md (Design section 1, "Capturing `github_url`") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 3: Shared GitHub Inspector findings renderer with posted markers

**What to build:** The findings section of the workflow `inspector_feedback` packet comes from one pure renderer that Foreman's relay will also use. Each finding says whether it is on GitHub, and a packet over its byte budget drops whole findings and says how many, instead of clipping text mid-finding.

**Blocked by:** ticket 1 (GitHub Inspector findings ledger: posted state and read route).

**Acceptance criteria:**
- [ ] A pure renderer, with no database or network imports so Foreman's worker can load it, renders the findings section with today's dedupe and sort plus one posted line per finding from `findingPublication`. It covers every phase 2 line in the plan, including "Not posted again. An earlier version was posted on GitHub: <url>" for `earlierPost`, and never calls such a row the only copy.
- [ ] Fields still clip at the per-field limit. Past the budget, whole findings drop from the tail, lowest severity first, and a closing line gives the count.
- [ ] The workflow packet keeps its own header and closing and hands the renderer what is left of the payload limit. Its failed count stays the total.
- [ ] Before the text changes, confirm nothing renders a stored packet again or compares its hash (the delivery transition, restart recovery). Deliveries already prepared keep their frozen payload and hash.
- [ ] When the gate fires, what it blocks, and how it delivers are unchanged.
- [ ] The workflows doc's `inspector_feedback` paragraph mentions posted markers and whole-finding truncation.
- [ ] The PR carries the `fork:inspector-findings` label.

**Test seams:** renderer unit tests for every phase 2 marker, the `earlierPost` line, the budget, the whole-finding drops and the omitted count; the existing workflow Inspector feedback test updated for the new text; a frozen delivery is not rendered again.

Context: read docs/plans/inspector-findings/plan.md (Design section 3, and Risks, "Workflow packet idempotency") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 4: Foreman relays every unresolved GitHub Inspector finding as text

**What to build:** Foreman's review follow-through fires on any unresolved GitHub Inspector finding, dry-run drafts included. It reads the findings over the daemon's findings route and types their text into the session, each one marked posted or not posted, so a session can act on a finding it cannot see on GitHub.

**Blocked by:** ticket 1 (GitHub Inspector findings ledger: posted state and read route), ticket 3 (Shared GitHub Inspector findings renderer with posted markers).

**Acceptance criteria:**
- [ ] The trigger is any unresolved finding instead of posted-open findings only. Every existing gate stays, in the same order, the decision stays zero-I/O, and the relay goes out at most once per Inspector round with the full unresolved set.
- [ ] For a nudge that includes findings, the worker reads them through the daemon client. A failed read is logged, the mark is not stamped and nothing is typed. An empty set after the read drops the findings part, and the pass skips without stamping when nothing else is open.
- [ ] The payload opens with the posted and not-posted counts. Its findings step asks the agent to address each finding, says a Not posted finding exists only in this message, and says how to disagree. The `gh pr view --comments` pointer is gone. The findings come from the shared renderer, under the same 8,000-byte ceiling.
- [ ] The Foreman popover toggle reads "Keep sessions on track with GitHub Inspector findings", with the plan's hint. The setting key does not change.
- [ ] The work queues doc's "Keeping a PR on track" section matches.
- [ ] The PR carries the `fork:inspector-findings` label.

**Test seams:** Foreman review follow-up unit tests: a draft triggers; the payload carries finding text and no `gh` pointer; a failed read holds without stamping; every existing gate still refuses. The Foreman pull-request Playwright spec is updated for the popover copy.

Context: read docs/plans/inspector-findings/plan.md (Design section 4) first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 5: Shared GitHub Inspector findings table with a Posted column

**What to build:** The workflow Completion tab's GitHub Inspector findings table becomes one shared table with a Posted column, so an operator reading a gated run sees whether each finding reached GitHub, and the Settings Findings modal (ticket 6) reuses the same table.

**Blocked by:** ticket 1 (GitHub Inspector findings ledger: posted state and read route).

**Acceptance criteria:**
- [ ] The Completion tab's inline findings table and its severity, status, location and body helpers move into one shared table component. The Completion tab renders it and keeps its own caption and empty-state copy.
- [ ] A Posted column driven by `findingPublication` shows "Posted" (linked to GitHub when the link is known, plain while it is not), "Not posted", "Not posted (posted earlier)" linking to the earlier comment, "Posting", and "Unknown" with the tooltip "Recorded before Mission Control tracked posting".
- [ ] The body rule is unchanged: an unresolved finding's body is always shown, and a resolved one's opens with Show finding.
- [ ] The PR carries the `fork:inspector-findings` label.

**Test seams:** the workflow Completion pane Playwright spec asserts the Posted column on its drafted finding. Typecheck, lint, build and smoke pass.

Context: read docs/plans/inspector-findings/plan.md (Design section 5, "The shared table") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 6: Findings modal in Settings, GitHub Inspector, Inspections

**What to build:** In Settings, GitHub Inspector, Inspections, each pull request with findings gets a Findings button that opens a read-only modal listing every finding GitHub Inspector generated for it and whether each was posted, so the operator can read dry-run drafts and resolved findings in one place.

**Blocked by:** ticket 1 (GitHub Inspector findings ledger: posted state and read route), ticket 5 (Shared GitHub Inspector findings table with a Posted column).

**Acceptance criteria:**
- [ ] A Findings button sits beside Resolve, labelled "View GitHub Inspector's findings on owner/repo#N", on every row with at least one finding, open or closed. A row with none shows no button.
- [ ] The modal has the heading "GitHub Inspector findings", the pull request link and state, and the round count. It shows "Dry run: nothing on this pull request was posted" when the review posture was not live, holds the shared table in a bleed band, and has Close in its footer.
- [ ] It fetches when it opens and refreshes on the Inspector panel's tick while open. It is read-only, with no Resolve inside it.
- [ ] The table footer reads the plan's new copy.
- [ ] The Inspector and Shipping doc's Dry run section says where to read drafts, and the doc gains a "Reading a pull request's findings" section.
- [ ] The PR carries the `fork:inspector-findings` label.

**Test seams:** a new Playwright spec seeds six findings (posted with a link, posted without one, a draft, a draft whose earlier version was posted, a resolved posted finding, a legacy unknown row), opens the modal by its accessible label, asserts every Posted cell and every body that should show, and calls `expectContentClearsBorder`.

Context: read docs/plans/inspector-findings/plan.md (Design section 5, "Settings" and "The modal", and Tests and verification for phase 3) first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 7: Drafted GitHub Inspector findings are posted after a switch to live

**What to build:** After GitHub Inspector switches from dry run to live, findings drafted in dry run are posted by the next review instead of staying unposted for good. A GitHub refusal counts only against the draft that caused it, a draft stops being offered after 3 refusals, and a refused round finishes so the same head is not reviewed again on every backoff.

**Blocked by:** ticket 4 (Foreman relays every unresolved GitHub Inspector finding as text).

**Acceptance criteria:**
- [ ] First, a `node:test` integration test drives the real worker with the fake `gh` and fake model runner and reproduces the bug (dry-run drafts, switch to live, forced re-review). Commit it failing and attach its run output to the PR. If drafts do get posted, record that, keep the test as a guard, and ship only the prompt change.
- [ ] The review prompt lists drafted findings in their own section, worded as the plan says.
- [ ] In a live round the planner carries a draft the model neither resolved nor raised again when its path is still in the diff, its line snaps, and it has under 3 refusals, through the same scrub, sort and per-round cap, new findings first at equal severity.
- [ ] One classifier alone splits a refused review into whole-review (rate limit, auth or SSO, server error, moved head, any other non-422) and validation (422 on an unmoved head).
- [ ] Whole-review runs today's failure path with no retry and nothing counted. Validation follows D-21 and D-28: one retry without drafts when new findings rode along; one draft records the refusal; several are each retried alone. Lost responses never count. Retries reuse the round's verdict.
- [ ] After pinning, the round finishes and the head advances. Refused drafts stay drafted until the next push.
- [ ] Refusal count and last error are ledger columns written by the single upsert and carried forward.
- [ ] The Inspector and Shipping doc explains drafts after a switch to live, and the cap.
- [ ] The PR carries the `fork:inspector-findings` label.

**Test seams:** the plan's phase 4 `node:test` regression list for the worker, planner, prompt and classifier, including the fake model runner called once, not once per backoff.

Context: read docs/plans/inspector-findings/plan.md (Design section 6 and Tests and verification for phase 4) first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.

## Ticket 8: Refused GitHub Inspector drafts show their refusal count and reason

**What to build:** A draft GitHub refused shows how many times and why, from the first refusal, in Foreman's relay, in the workflow packet and in the findings table, and reads Refused once it reaches the cap of 3.

**Blocked by:** ticket 6 (Findings modal in Settings, GitHub Inspector, Inspections), ticket 7 (Drafted GitHub Inspector findings are posted after a switch to live).

**Acceptance criteria:**
- [ ] `findingPublication` gains the `refused` state at 3 refusals and the `refusals` and `reason` fields. A draft with one or two refusals stays not-posted and carries its count and reason.
- [ ] The shared renderer adds the plan's two refusal lines. The table's Posted cell adds "Not posted" with "GitHub refused it N time(s)", the reason in a tooltip and in the detail row, and "Refused" at 3. Both consumers switch over the state exhaustively.
- [ ] Refused drafts stay unresolved: they still block Shipping and YOLO, and Foreman still relays them.
- [ ] The PR carries the `fork:inspector-findings` label.

**Test seams:** `findingPublication` cases for the reason shown from the first refusal and for `refused` at 3; the renderer tests extended with both refusal lines; the Findings modal Playwright spec extended with a once-refused row and a row refused 3 times.

Context: read docs/plans/inspector-findings/plan.md (Design section 1, "Phase 4 extends it", sections 3 and 5, and section 6, "Refusal state") first. The plan is the proposed route, not a specification: follow it where the repository agrees, use your judgement where it doesn't, and record any deviation in the pull request. Implement only this ticket.
