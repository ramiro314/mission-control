# Decision forms: Other as its own radio choice

- **Status:** Approved on 2026-09-28; follow-up: create tickets
- **Date:** 2026-09-28
- **Scope:** Planning only. This document proposes no application changes by itself.
- **Surface:** `src/web/components/PlanDecisions.tsx`, its `.decision-other` rules in
  `src/web/styles.css`, `test/plan-decisions-render.test.ts`, and a new Playwright spec.
- **Decision record:** Two interview rounds were submitted in Mission Control on 2026-09-28:
  - **Single-choice model:** Other becomes its own radio choice.
  - **Multi-choice:** Other stays additive with the checkboxes (no change).
  - **Foreman draft:** a drafted Other on a single-choice question preselects Other, the same
    as typing does.
  - **Empty Other:** Other selected with an empty box counts as unanswered.
  - **Reselecting kept text:** clicking the Other radio, clicking into the text box, or typing
    reselects Other with the kept text intact. Only a pointer click or typing does this.
    Keyboard focus from tabbing must not change the selection, so the reselect is bound to
    `pointerdown`/`click`, never to `focus`.

## The problem

Every question opens with its `recommended` option preselected (`recommendedAnswers`). On a
single-choice question that option is a radio, and a checked radio cannot be unchecked. The
`Other…` text box sits beside the radios with no link to them. So on a single-choice question,
typing Other always sends **both** the recommended option and the Other text. Nothing in the
form can send "Other only".

The operator's screenshot shows this: "Run install.sh inside WSL · recommended" stays checked
while "Test" is typed into Other.

The rest of the system already accepts an Other-only answer, so this is a UI-only fix:

- `isAnswered` (`src/web/lib/reviews.ts`) counts non-empty Other as answered.
- `formatResponse` (`src/shared/review-item.ts`) prints only `Other: …` when nothing is
  selected.
- The conversation replay (`ReviewAnswer.tsx`) renders an Other-only answer.

`PlanDecisions` is the only form, so the fix covers plan reviews and `request_input` alike.
Multi-choice questions use checkboxes, which you can already uncheck, and they stay as they
are.

## Behavior

This applies only to single-choice questions with `allowOther`.

1. The form renders one more row in the radio group, **Other**, after the listed options. Its
   radio shares the group's `name`, and the text box sits inside that row.
2. **Selecting Other.** Any of these selects the Other radio and clears the listed option:
   - clicking the Other radio,
   - a pointer click in the text box (`pointerdown`),
   - typing in the text box.

   A pointer click on the Other radio also moves focus into the text box. Reaching Other with
   the arrow keys selects it (native radio behavior) and leaves focus on the radio.
3. **Selecting a listed option** deselects Other. The typed text stays in the box but is not
   sent. The box stays editable, and editing it selects Other again (rule 2).
4. **Keyboard focus is inert.** Tabbing into the text box changes nothing. Only a pointer click
   or typing does.
5. **Completeness.** When Other is selected and its text is blank, the question is unanswered
   and Submit stays disabled ("Answer every decision above first").
6. **Payload shape does not change.** Other selected sends `{ selected: [], other: "<text>" }`.
   A listed option sends `{ selected: [id], other: null }`, even when kept text is in the box.
   No synthetic "other" option id is added, so the agent-facing text, stored selections, and
   replay are unchanged.

### Foreman drafts

When `draftedAnswers` receives a draft whose Other text is non-empty for a single-choice
question, it preselects Other and clears any listed option in that draft, the same as typing.
**Undo Foreman** (`revert`) restores the recommended option and deselects Other, as today.
Multi-choice drafts are unchanged.

## Implementation

All in `PlanDecisions.tsx`:

- Extend the per-decision state to `{ selected: string[]; other: string; otherChosen: boolean }`.
  `otherChosen` has meaning only for single-choice questions. `recommendedAnswers` opens it as
  `false`.
- `choose` on a single-choice question sets `selected = [id]` and `otherChosen = false`.
- Add `chooseOther(d)`, which sets `selected = []` and `otherChosen = true`. It is called from
  the Other radio's `onChange` and from the text box's `onPointerDown`.
- `setOther` on a single-choice question also calls `chooseOther`.
- `toDecisionAnswers` sends `other` for a single-choice question only when `otherChosen` is
  true. Multi-choice behavior is unchanged.
- In `draftedAnswers`, a non-empty Other on a single-choice question sets `otherChosen: true`
  and `selected: []`.
- `sameAnswers` compares the submitted payloads (`toDecisionAnswers`) instead of the raw state,
  so kept but unsent text never counts as a Foreman change.
- Multi-choice questions keep today's markup: checkboxes plus a separate `Other…` box.

In `styles.css`, lay the Other row out like a `.decision-option` row with the text box in the
body. The existing `.decision-other` input styling is reused.

## Tests

- **Unit** (`test/plan-decisions-render.test.ts`), exercising the exported pure functions and
  static markup:
  - A single-choice `allowOther` question renders an `Other` radio in the same group.
    Multi-choice does not.
  - `toDecisionAnswers` returns Other only when it is chosen, and drops kept text after a
    listed option is chosen again.
  - `draftedAnswers` turns a single-choice draft that has Other into
    `otherChosen: true, selected: []`.
- **E2E** (new `e2e/specs/decision-other-choice.spec.ts`, fake agents only), on a
  single-choice question with a recommended option:
  1. The form opens with the recommended radio checked. Typing in Other unchecks it and checks
     the Other radio. The "Selected:" summary and the agent's response carry only `Other: …`.
  2. Clicking a listed option unchecks Other, and the text stays visible. Submitting sends only
     that option.
  3. Pressing Tab into the kept text box leaves the listed option checked. A pointer click in
     the box checks Other.
  4. With Other checked and an empty box, Submit is disabled.
- The existing `foreman-decision-draft.spec.ts` must still pass. Its Other text is on a
  multi-choice question, so it is unaffected.

## Out of scope

- The `request_plan_decisions` / `request_input` schemas and the server.
- Multi-choice behavior.
- The conversation replay, which already renders Other-only answers.

## Definition of done

`npm run typecheck`, `npm run lint`, the focused unit test file, and `npm run build` pass, and
`npm run test:e2e` passes with the new spec and the existing Foreman draft spec.
