import type { PlanDecision, PlanDecisionAnswer, ReviewItem } from "@shared/types.ts";

// Foreman's draft on a `plan-decisions` form: what the reviewer is asked, and how its verdict
// becomes the draft the form shows. Pure and free of I/O so both halves are unit tested.
//
// A plan's decisions stay the human's. Foreman never submits this form (the resolve route
// refuses it outright); what it may do is preload its own answers onto the form, visibly, with
// a one-click revert to the agent's recommendation. So the reviewer is told it is DRAFTING,
// and the mapping below only ever produces a draft.

/**
 * Render a `plan-decisions` review as the question the reviewer judges.
 *
 * Every decision is listed with its offered labels, which one the agent recommended, whether
 * it takes several, and whether it accepts free text - the four facts the mapping below reads
 * back. Guarding is the caller's, as for `withOfferedOptions`: `buildReviewPrompt` puts the
 * whole question through `fromChild`.
 */
export function planDecisionsQuestion(review: ReviewItem): string {
  const decisions = review.decisions ?? [];
  const blocks = decisions.map((d, i) => {
    const traits = [
      d.multiSelect ? "choose any number" : "choose one",
      ...(d.allowOther ? ["accepts your own words as Other"] : []),
    ];
    const rows = d.options.map(
      (o) =>
        `   - ${o.label}${o.recommended ? " (the agent's recommendation)" : ""}` +
        `${o.detail ? `: ${o.detail}` : ""}`,
    );
    return [`${i + 1}. ${d.question} [${traits.join("; ")}]`, ...rows].join("\n");
  });
  return [
    `The child posted a plan-decisions review titled "${review.title}".`,
    "",
    review.body,
    "",
    "The decisions it asks the human to make:",
    ...blocks,
    "",
    "You CANNOT submit this form; only the human can. Whatever you answer is shown on the form as" +
      " Foreman's DRAFT, which the human may keep, edit, or revert to the agent's recommendation." +
      " To draft, use action \"answer\" and fill \"answer.form.answers\", keyed by each question's" +
      " exact text. A value is the exact LABEL of an offered option (several labels, as an array," +
      " where the question takes several), or - only where the question accepts your own words -" +
      " your own suggestion. Leave a question out to keep the agent's recommendation for it. Put" +
      " your reasoning in \"answer.text\". Escalate instead when a decision hinges on what the" +
      " human intends.",
  ].join("\n");
}

/** Compare the reviewer's spelling of a question or label with the form's, loosely. */
function folded(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

/** The reviewer's answer for one decision: by exact question, folded question, or id. */
function answerFor(
  answers: Record<string, string | string[]>,
  d: PlanDecision,
): string | string[] | undefined {
  if (answers[d.question] !== undefined) return answers[d.question];
  const want = folded(d.question);
  for (const [question, value] of Object.entries(answers)) {
    if (folded(question) === want) return value;
  }
  return answers[d.id];
}

/**
 * Map the reviewer's form answer onto the decision form as a draft.
 *
 * Per decision, each value that names an offered option (by label, loosely, or by id) selects
 * it; anything else is the reviewer's own words and becomes the Other text - only where the
 * decision accepts Other, since a form that does not has nowhere to show it. A single-choice
 * decision keeps only the first option named.
 *
 * Own words with no option named mean none of the options fits, so that decision's draft
 * selects nothing and carries only the Other text. A decision the reviewer left out, or
 * answered with nothing usable, is omitted: the form keeps the agent's recommendation there.
 *
 * Null when nothing survives, so a verdict that answered in prose alone leaves no draft and
 * the form stays exactly as the agent preselected it.
 */
export function draftFromVerdict(
  decisions: readonly PlanDecision[],
  answer: { form?: { answers: Record<string, string | string[]> } } | undefined,
): PlanDecisionAnswer[] | null {
  const answers = answer?.form?.answers;
  if (!answers) return null;
  const draft: PlanDecisionAnswer[] = [];
  for (const d of decisions) {
    const value = answerFor(answers, d);
    if (value === undefined) continue;
    const values = (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter(Boolean);
    const selected: string[] = [];
    const own: string[] = [];
    for (const v of values) {
      const option = d.options.find((o) => folded(o.label) === folded(v) || o.id === v);
      if (!option) own.push(v);
      else if (!selected.includes(option.id)) selected.push(option.id);
    }
    const chosen = d.multiSelect ? selected : selected.slice(0, 1);
    const other = d.allowOther && own.length ? own.join("; ") : null;
    if (!chosen.length && !other) continue;
    draft.push({ decisionId: d.id, selected: chosen, other });
  }
  return draft.length ? draft : null;
}

/**
 * Decide the "Foreman draft, accepted" mark from the draft the daemon actually holds.
 *
 * The browser proposes the mark, but the record and the agent's answer are provenance, so
 * the daemon is the authority: an Other text is marked exactly when it equals, word for word
 * after trimming, the Other text of the live draft for that decision. A claim with no matching
 * draft is dropped, and a matching text the caller left unmarked gains the mark. Returns the
 * original array when nothing changes, so a caller can tell whether its response still holds.
 */
export function verifyDraftProvenance(
  selections: PlanDecisionAnswer[],
  draft: readonly PlanDecisionAnswer[] | null | undefined,
): PlanDecisionAnswer[] {
  const drafted = new Map(
    (draft ?? []).flatMap((d) => (d.other?.trim() ? [[d.decisionId, d.other.trim()] as const] : [])),
  );
  let changed = false;
  const verified = selections.map((a) => {
    const other = a.other?.trim() ?? "";
    const accepted = other !== "" && drafted.get(a.decisionId) === other;
    if (accepted === Boolean(a.foremanDraftAccepted)) return a;
    changed = true;
    const { foremanDraftAccepted: _claimed, ...rest } = a;
    return accepted ? { ...rest, foremanDraftAccepted: true as const } : rest;
  });
  return changed ? verified : selections;
}
