---
name: tickets
description: Slice an approved plan into tracer-bullet tickets with blocking edges, get the breakdown approved in one Mission Control decision form, then file each ticket as a dependency-gated backlog task. Use when a shape task's plan review chooses Create tickets, or whenever you are asked to break an approved plan into tickets or tasks an agent can build unattended.
metadata:
  mission:
    category: planning
    enforcement: triggered
---

# Tickets

Turn an approved plan into **tickets**: vertical slices an agent can build one at a time, each
declaring the tickets that **block** it. **1 ticket = 1 task = 1 pull request.** The human
approves the breakdown before anything exists, and only then are the tickets filed as Mission
Control tasks.

This skill adapts Matt Pocock's `to-tickets` skill (MIT License, Copyright (c) 2026 Matt Pocock,
<https://github.com/mattpocock/skills>). The slicing method is his. What changes here is the
delivery: the breakdown is approved in a Mission Control decision form, and the tickets become
backlog tasks with dependency edges rather than files or tracker issues.

## Two modes

- **Follow-up mode**, when the delivered contract says this session is a **tickets follow-up**
  of a merged shape task (tickets-only mode). The plan has already merged, so the plan pointer
  resolves on the default branch, and the tasks and any mirrored items are the record. Section 4
  says what this mode skips, and the session ends by calling `complete_shape_tickets`.
- **In-session mode**, every other caller, including a shaping session that reaches this skill
  from its own plan review. Everything below applies as written.

## 1. Slice the plan

Work from the approved plan and the decisions it records. Read the code it touches, so ticket
titles use the repository's own vocabulary.

- **Tracer bullets.** Each ticket cuts a narrow but complete path through every layer it needs
  (schema, API, UI, tests). A finished ticket is demoable or verifiable on its own. A ticket that
  is one horizontal layer of several is not a ticket.
- **One fresh context window.** Size each ticket so one agent, starting cold, can build and verify
  it in one context window. Split anything larger.
- **Refactoring first.** When a change is hard because of the code's current shape, the refactor
  that makes it easy is its own ticket, and it blocks the work it enables. Make the change easy,
  then make the easy change.
- **Wide refactors use expand-contract.** A mechanical change whose blast radius spans the codebase
  (a rename, a retyped shared symbol) cannot land green as one vertical slice. Sequence it instead:
  **expand** (add the new form beside the old), then **migrate** the callers in batches sized by
  blast radius, each batch a ticket blocked by the expand, then **contract** (delete the old form)
  in a ticket blocked by every batch.
- **Blocking edges are real gates only.** A ticket is blocked by another only when it cannot start
  until that one merges. Tickets with no blockers run in parallel, so do not chain them for tidiness.
- **Test seams come from the plan.** Record the seams the interview agreed for each ticket. Where
  the plan has none, name the narrowest seam that proves the behavior.

Choose each ticket's `kind`: `bugfix` when it fixes a defect, `ship` otherwise. Choose `labels`
only when they help the human filter the set (the plan's name is a good one). Priority is the
human's call; never set it.

## 2. Write each ticket body

The body becomes the task's `intent`: the implementing agent's opening prompt and the requirement
its review judges. Keep it at goal altitude, in exactly this shape:

```markdown
**What to build:** the end-to-end behavior this ticket makes work, from the user's side.

**Blocked by:** ticket <n> (<title>), or "None - can start immediately".

**Acceptance criteria:**
- [ ] ...

**Test seams:** the seams this ticket is proved through.

Context: read <plan.md path> (section <x>) first. The plan is the proposed route, not a
specification: follow it where the repository agrees, use your judgement where it doesn't,
and record any deviation in the pull request. Implement only this ticket.
```

- **No file paths**, other than the one pointer to the plan. Paths go stale, and a path in the
  requirement hardens into a contract clause the agent is failed for leaving.
- **Under 3000 characters.** Detail belongs in the plan the ticket points at.
- The title names the work: no "Implement", no "We should".

## 3. The breakdown review

The breakdown review is the human's **final approval**. It is **one** `request_plan_decisions`
form, and nothing is written or created before it is submitted.

First call `list_backlog_tasks` to read the repository's open backlog. When the tickets belong to
another repository than this session's, pass that one as `repository` (an absolute path or a
unique repository directory name): the tasks and the `mirror` choice then both come from it, and
an unknown or ambiguous name is refused. Any of those tasks may
already cover a ticket; the human decides whether it does. Its `mirror` field says whether the
tickets can also be mirrored to a task source (for example as GitHub issues): `mirror.sources`
lists the sources that can receive them, and `mirror.unavailable` says why none can.

Then call `request_plan_decisions` once:

- `title`: `<plan name>: breakdown review`.
- `plan`: a markdown table of every ticket, in dependency order, with its number, title,
  **Blocked by**, **What it delivers**, kind and labels. Below it, say plainly that submitting
  files these tickets as backlog tasks gated on this session, and that Dismiss files nothing.
- `decisions`: one per ticket, id `ticket-<n>`, asking "Ticket <n>: <title> - file a new task, or
  adopt an open backlog task?"
  - The first option is `new` ("New task"), with `detail` holding its blocked-by and what it
    delivers. It is `recommended: true` unless a backlog task plainly covers the ticket, in which
    case recommend that one instead.
  - Then one option per open backlog task, id `adopt:<task id>`, labelled `Adopt: <task title>`.
    Adopting keeps that task exactly as it is (its title, intent, kind and labels); it only gains
    this ticket's edges, and the tickets it blocks wait on it.
  - `allowOther: true`, so the human can ask for a change to the breakdown itself.
- One last decision, id `mirror`, asking "Mirror the tickets to <source label>?", with `allowOther:
  false` and two options:
  - When `mirror.sources` is not empty: `yes` ("Yes, mirror them"), `recommended: true`, with
    `detail` naming the source, and saying whether it also links each ticket to its blockers and
    to the planning task's item (`relates`); then `no` ("No, keep them in Mission Control only").
    With more than one source, offer one `yes:<source id>` option per source instead of `yes`,
    and recommend the first.
  - When it is empty: `no` ("No, keep them in Mission Control only"), `recommended: true`, with
    `detail` holding `mirror.unavailable` word for word, so the human sees why; then `yes`
    ("Yes, mirror them") with `detail` "Not available: <mirror.unavailable>". A `yes` submitted
    here is a change request: say mirroring is unavailable and why, and ask whether to go on
    without it.
  Never decide availability yourself, and never offer a source `mirror.sources` did not list.

The tool blocks until the human submits or dismisses:

- **Dismissed:** stop. Write nothing, commit nothing, create nothing. Never read a dismissal as
  approval, and never fall back to your recommendations. Say the breakdown was dismissed. In
  follow-up mode, then call `complete_shape_tickets` with outcome `dismissed`.
- **Submitted with Other text on any ticket:** that is a change request, not an approval. Revise
  the breakdown and ask again with a fresh breakdown review. Nothing is filed from a form that
  asked for changes.
- **Submitted with one backlog task adopted by two tickets:** ask again; a task stands in for one
  ticket.
- **Submitted:** the breakdown is approved as shown. Go on.

## 4. On submit

**In follow-up mode, skip steps 1, 2 and 5**: write no tickets file, commit and push nothing, and
record no ids in a file. The plan the tickets point at has already merged. File and mirror the
tickets (steps 3 and 4) exactly as below, with one difference: `dependsOnCurrentSession: true`
links each ticket to the **merged shape task** with an edge that is already satisfied, so a
ticket waits only on its own blockers. Your final report (step 6) is the record.

1. **Write** `docs/plans/<name>/tickets.md` beside the plan: every ticket in dependency order with
   its title, kind, labels, blocked-by and full body, and a **Task** column that will hold its
   Mission Control task id, or `adopted <task id>` for an adopted ticket. When mirroring was chosen,
   add an **Issue** column that will hold each ticket's item URL. Render `tickets.html`
   beside it the way the html-plans skill renders a plan page.
2. **Commit and push** the plan and the tickets files, so the pointer in every ticket body
   resolves in a pushed commit before any task names it. If you cannot push, stop and report why;
   do not file tasks that point at unpublished files.
3. **File the tickets** with `create_task`, one call per ticket, blockers before the tickets they
   block:
   - `title`, `intent` (the ticket body), `kind`, `labels`;
   - `dependsOnTaskIds`: the task ids of this ticket's blockers, as earlier calls returned them
     (an adopted blocker's id is the adopted task's id);
   - `dependsOnCurrentSession: true` on every ticket, so none starts before this planning session's
     pull request merges the plan it points at. In follow-up mode it links the ticket to the merged
     shape task instead, already satisfied;
   - for an adopted ticket, send `adoptTaskId: <task id>` with only `dependsOnTaskIds` and
     `dependsOnCurrentSession`, plus the same `repository` you passed to `list_backlog_tasks` when
     you named one. Nothing is created: those edges are added to that task and the rest
     of it is left alone. A title, intent, kind, labels or `additionalRepositories` beside
     `adoptTaskId` is refused, because the adopted task keeps its own. A task from neither this
     session's repository nor the named one is refused, and so is a cycle; report either.

   The tasks are created enabled, so the backlog autopilot may pick them up once their blockers
   merge. The human's approval of the breakdown is that consent.
4. **Mirror**, only when the `mirror` decision chose a source. Call `push_task` once per filed ticket,
   right after the tickets are filed and in the same dependency order, blockers first: `taskId` is
   the id `create_task` returned (or the adopted task's id), and `sourceId` is the chosen source's
   id. Mission Control builds the item from the task and marks it blocked by the items of its
   blockers that are already pushed, and files it under this shape task's own item when the shape
   task came from one. Pushing blockers first is what lets those links exist.
5. **Record the ids.** Fill the Task column of `tickets.md` and `tickets.html` with what each call
   returned, and the Issue column with the `url` each `push_task` returned, then commit and push
   again.

If a `create_task` call fails, stop there: do not file the tickets that depend on it. Tasks
already filed stay. Before retrying a call whose outcome you do not know, check
`list_backlog_tasks` so a retry never files a ticket twice. Record in `tickets.md` (in-session
mode) which tickets were filed and which were not, and report the failure. In follow-up mode, do
not call `complete_shape_tickets`: the follow-up stays open for the human.

If a `push_task` call fails:

- The Mission Control tasks stay. They are the source of truth; never delete or re-file them.
- Do not push the tickets that depend on the failed one, directly or through another ticket: their
  blocked-by links would be missing. Keep pushing the tickets that do not depend on it.
- Record the failure in the Issue column (`not pushed: <reason>`, in-session mode), and report
  which tickets were pushed, which failed, and which were held back.
- A retry is idempotent: `push_task` on a ticket that already has an item returns that item with
  `alreadyPushed: true` and files nothing. A failure that says nothing was published is safe to
  retry once. An `outcomeUnknown` failure means the item may exist: do not retry it. Tell the
  human to check the tracker first, because a blind retry files a duplicate.

6. **Report.** Finish by reporting the tickets file (in-session mode only), the ticket-to-task map
   (new and adopted), the blocking edges, and which tickets can run in parallel.
7. **Follow-up mode only: complete.** After the last ticket is filed, and pushed when mirroring was
   chosen, call `complete_shape_tickets` with outcome `filed`. It completes the follow-up task and
   closes this session, so it is the last call you make. When a `create_task` or `push_task` call
   failed, do not call it: report the failure and leave the follow-up open for the human.

## What not to do

- Do not write, commit, or file anything before the breakdown review is submitted.
- Do not slice by layer. A ticket that cannot be demonstrated alone is part of another ticket.
- Do not put file paths other than the plan pointer in a ticket body.
- Do not edit an adopted task's title, intent, kind or labels.
- Do not set a priority.
- Do not push a ticket when the breakdown did not choose to mirror, and do not create items in the
  tracker any other way than `push_task`.
