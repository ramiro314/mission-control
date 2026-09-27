import { useEffect, useState } from "react";
import type { PlanDecision, PlanDecisionAnswer } from "@shared/types.ts";
import { formatResponse, selectedOptions } from "@shared/review-item.ts";
import { isAnswered } from "../lib/reviews.ts";
import { ForemanPickMark } from "./ForemanRecommendation.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** Per-decision answer state: chosen option ids plus any free-text "Other". */
type Answers = Record<string, { selected: string[]; other: string }>;

/** Stable inside one review form, shared with its Foreman recommendation matcher. */
export function decisionChoiceKey(decisionId: string, optionId: string): string {
  return `${decisionId}:${optionId}`;
}

/**
 * The form's state as the wire shape, in the order the questions were asked.
 *
 * One conversion at the edge rather than holding `PlanDecisionAnswer[]` throughout: the
 * form indexes by decision id on every keystroke, which a map does well and an array does
 * not. Every decision is emitted, answered or not - an unanswered one is a real fact about
 * a submission, and dropping it would make a form that could not have been submitted look
 * like one that never asked. Blank "Other" text normalizes to null so "typed nothing" and
 * "typed and cleared it" are the same record.
 */
function toDecisionAnswers(
  decisions: PlanDecision[],
  answers: Answers,
  draftOthers: ReadonlyMap<string, string> = new Map(),
): PlanDecisionAnswer[] {
  return decisions.map((d) => {
    const a = answers[d.id];
    const other = a?.other.trim() ? a.other.trim() : null;
    return {
      decisionId: d.id,
      selected: a?.selected ?? [],
      other,
      // Provenance: this Other text is still exactly Foreman's draft. Edited by a single
      // character, it is the human's words, and it goes out unmarked.
      ...(other !== null && draftOthers.get(d.id) === other ? { foremanDraftAccepted: true } : {}),
    };
  });
}

/**
 * The recommended opening state with Foreman's draft laid over it, decision by decision.
 *
 * A decision the draft does not mention keeps the agent's recommendation, so a draft that
 * answers one question of five changes one question of five.
 */
export function draftedAnswers(
  decisions: PlanDecision[],
  draft: readonly PlanDecisionAnswer[] | null | undefined,
): Answers {
  const answers = recommendedAnswers(decisions);
  for (const d of draft ?? []) {
    const decision = decisions.find((x) => x.id === d.decisionId);
    if (!decision) continue;
    const offered = new Set(decision.options.map((o) => o.id));
    const selected = d.selected.filter((id) => offered.has(id));
    answers[d.decisionId] = {
      selected: decision.multiSelect ? selected : selected.slice(0, 1),
      other: decision.allowOther ? (d.other ?? "") : "",
    };
  }
  return answers;
}

/** Whether two form states would submit the same answer. */
function sameAnswers(decisions: PlanDecision[], a: Answers, b: Answers): boolean {
  return decisions.every((d) => {
    const x = a[d.id] ?? { selected: [], other: "" };
    const y = b[d.id] ?? { selected: [], other: "" };
    return (
      x.other.trim() === y.other.trim() &&
      x.selected.length === y.selected.length &&
      x.selected.every((id) => y.selected.includes(id))
    );
  });
}

/**
 * The form's opening state: each decision's `recommended` option(s) already selected.
 *
 * An untouched submit therefore returns exactly the agent's recommendation. A radio group
 * takes only its first recommended option, since it can hold one; a checkbox group takes all
 * of them. A decision with no recommendation opens empty, as before, so Submit stays gated on
 * the human choosing.
 */
export function recommendedAnswers(decisions: PlanDecision[]): Answers {
  const answers: Answers = {};
  for (const d of decisions) {
    const ids = d.options.filter((o) => o.recommended).map((o) => o.id);
    if (ids.length) answers[d.id] = { selected: d.multiSelect ? ids : ids.slice(0, 1), other: "" };
  }
  return answers;
}

/**
 * What Submit would send, as one line a person can read before pressing it.
 *
 * Needed because the form now opens preselected: without it an untouched Submit sends a
 * choice the human may never have looked at. Null when nothing is chosen yet.
 */
function selectionSummary(decisions: PlanDecision[], payload: PlanDecisionAnswer[]): string | null {
  const parts = decisions.flatMap((d, i) => {
    const a = payload[i];
    const labels = selectedOptions(d, a).map((o) => o.label);
    if (a?.other) labels.push(`Other: ${a.other}${a.foremanDraftAccepted ? " (Foreman's draft)" : ""}`);
    return labels.length ? [labels.join(", ")] : [];
  });
  return parts.length ? `Selected: ${parts.join(" · ")}` : null;
}

/**
 * Where Foreman's draft stands on one open form - one state, not flags compared by hand.
 *
 * - `none`: no draft has been applied; the form shows the recommendation (or nothing).
 * - `applied`: the form was filled from `draft`. `edited` records whether the human has
 *   changed anything since; the banner and its revert stay either way.
 * - `set-aside`: the human reverted, or took the form over before any draft arrived. No
 *   draft is applied to this form again.
 */
export type DraftState =
  | { kind: "none" }
  | { kind: "applied"; draft: readonly PlanDecisionAnswer[]; key: string; edited: boolean }
  | { kind: "set-aside" };

function keyOf(draft: readonly PlanDecisionAnswer[] | null | undefined): string | null {
  return draft?.length ? JSON.stringify(draft) : null;
}

/** The state a form opens in: applied when it opens with a draft, else none. */
export function openingDraftState(draft: readonly PlanDecisionAnswer[] | null | undefined): DraftState {
  const key = keyOf(draft);
  return key && draft ? { kind: "applied", draft, key, edited: false } : { kind: "none" };
}

/** A hand edit: a form with no draft yet is the human's now; an applied one is edited. */
export function draftAfterEdit(state: DraftState): DraftState {
  if (state.kind === "none") return { kind: "set-aside" };
  if (state.kind === "applied" && !state.edited) return { ...state, edited: true };
  return state;
}

/**
 * What a change in the incoming draft does to an open form, or null for nothing.
 *
 * A draft is applied only to a form nobody has touched: a new one lands, a changed one
 * replaces it, and a vanished one (the invite was withdrawn) puts the recommendation back
 * rather than leaving unlabelled Foreman answers. Once the human has edited an applied
 * draft, a change to it sets the draft aside and leaves their answers exactly as they are.
 */
export function draftOnChange(
  state: DraftState,
  incoming: readonly PlanDecisionAnswer[] | null | undefined,
): { next: DraftState; answers: "drafted" | "recommended" | "kept" } | null {
  const key = keyOf(incoming);
  if (state.kind === "set-aside") return null;
  if (state.kind === "applied" && state.key === key) return null;
  if (state.kind === "applied" && state.edited) return { next: { kind: "set-aside" }, answers: "kept" };
  if (key && incoming) return { next: { kind: "applied", draft: incoming, key, edited: false }, answers: "drafted" };
  if (state.kind === "applied") return { next: { kind: "none" }, answers: "recommended" };
  return null;
}

/**
 * Renders each decision as a radio group (choose one) or checkbox group (choose many),
 * with an optional free-text "Other". Its Submit hands up both the formatted response the
 * agent will read and the structured selections behind it, so the caller can resolve the
 * review with `action: "answer"` and the conversation can later replay the form. When
 * `onDismiss` is supplied, Dismiss resolves the whole request without submitting any
 * selections.
 */
export function DecisionForm({
  decisions,
  busy,
  onSubmit,
  onDismiss,
  /** Opening line of the response the agent receives - see `formatResponse`. */
  lead = "Plan decisions submitted:",
  /**
   * Drop the visible `<legend>`, because the caller already displays the question.
   *
   * For an `input` review the question is already above the form - as the review's title,
   * and in full as the body paragraph when the title had to be clipped - so a legend beneath
   * it says the same sentence a third time. The text still reaches assistive tech as the
   * fieldset's `aria-label` - the group needs a name whether or not one is drawn. A
   * `plan-decisions` form has several questions under one plan title and always shows them.
   */
  hideQuestions = false,
  /**
   * Namespace for the radio/checkbox `name` attributes this form emits.
   *
   * A group `name` is DOCUMENT-scoped, not component-scoped, and `ReviewModal` renders every
   * pending review of a session into one document. `request_input` hardcodes its decision id
   * as `q`, so two option-carrying `input` reviews - an abandoned ask still pending while the
   * agent asks again - would put two radio groups on screen under the same name. The browser
   * then treats them as ONE group: clicking in the second unchecks the first in the DOM,
   * while React re-renders only the card whose state changed, so the first card shows nothing
   * selected even though its state still holds a selection and its Submit stays enabled.
   *
   * Defaulted rather than required because a form rendered on its own cannot collide, and
   * because the decision id itself must stay untouched - it is echoed in the response payload.
   */
  namePrefix = "d",
  foremanRecommended,
  foremanDraft,
}: {
  decisions: PlanDecision[];
  busy: boolean;
  /**
   * `response` is the agent's tool result, `selections` the record kept beside it. Handed
   * up together, from one derivation, so the two can never describe different answers.
   */
  onSubmit: (response: string, selections: PlanDecisionAnswer[]) => void;
  /** Resolve this decision request without sending any of its options as an answer. */
  onDismiss?: () => void;
  lead?: string;
  hideQuestions?: boolean;
  namePrefix?: string;
  /**
   * Exact decision-option keys Foreman's prose names.
   *
   * The mark is deliberately NOT gated on the sidecar being open: the pick is legible at a
   * glance, and the sidecar is opened only for the reasoning behind it. Empty unless a live
   * Foreman note names this exact form, so an unmatched recommendation marks nothing.
   */
  foremanRecommended?: ReadonlySet<string>;
  /**
   * Foreman's drafted answers, when a live Foreman note in an invited session carries them
   * for this exact form. Laid over the recommendation as the form's state - visibly, as
   * "Foreman's draft", with a revert - and never submitted by anything but Submit.
   */
  foremanDraft?: readonly PlanDecisionAnswer[] | null;
}): React.JSX.Element {
  const [answers, setAnswers] = useState<Answers>(() => draftedAnswers(decisions, foremanDraft));
  const [draft, setDraft] = useState<DraftState>(() => openingDraftState(foremanDraft));
  // By content, so a re-render carrying the same draft is not a new one.
  const draftKey = foremanDraft?.length ? JSON.stringify(foremanDraft) : null;

  // Foreman's review takes minutes, so its draft usually lands on a form already open, and
  // an invite withdrawn takes it away again. `draftOnChange` decides what that does to the
  // form; see its rules.
  useEffect(() => {
    const step = draftOnChange(draft, foremanDraft);
    if (!step) return;
    if (step.answers === "drafted") setAnswers(draftedAnswers(decisions, foremanDraft));
    if (step.answers === "recommended") setAnswers(recommendedAnswers(decisions));
    setDraft(step.next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the draft's content
  }, [draftKey]);

  const activeDraft = draft.kind === "applied" ? draft.draft : null;
  const draftOthers = new Map(
    (activeDraft ?? []).flatMap((d) => (d.other?.trim() ? [[d.decisionId, d.other.trim()] as const] : [])),
  );
  const recommended = recommendedAnswers(decisions);
  const draftChangesSomething =
    activeDraft != null && !sameAnswers(decisions, draftedAnswers(decisions, activeDraft), recommended);

  /** The human changed something by hand. */
  function edited(): void {
    setDraft(draftAfterEdit);
  }

  function revert(): void {
    // Only the decisions Foreman's draft touched go back to the recommendation. An answer
    // you gave to any other question is yours, and undoing Foreman must not undo it.
    const drafted = new Set((activeDraft ?? []).map((d) => d.decisionId));
    setAnswers((prev) => {
      const next = { ...prev };
      for (const id of drafted) {
        if (recommended[id]) next[id] = recommended[id];
        else delete next[id];
      }
      return next;
    });
    setDraft({ kind: "set-aside" });
  }

  function get(id: string): { selected: string[]; other: string } {
    return answers[id] ?? { selected: [], other: "" };
  }

  function choose(d: PlanDecision, optionId: string, checked: boolean): void {
    edited();
    setAnswers((prev) => {
      const cur = prev[d.id] ?? { selected: [], other: "" };
      let selected: string[];
      if (d.multiSelect) {
        selected = checked
          ? [...cur.selected, optionId]
          : cur.selected.filter((x) => x !== optionId);
      } else {
        selected = [optionId]; // radio: single choice replaces
      }
      return { ...prev, [d.id]: { ...cur, selected } };
    });
  }

  function setOther(id: string, other: string): void {
    edited();
    setAnswers((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { selected: [], other: "" }), other },
    }));
  }

  // Built once per render and used for both the completeness test and the submit, so the
  // button's enabled state is decided over exactly the payload it would send.
  const payload = toDecisionAnswers(decisions, answers, draftOthers);
  const complete = decisions.length > 0 && decisions.every((d, i) => isAnswered(d, payload[i]));
  const summary = selectionSummary(decisions, payload);

  return (
    <div className="decisions">
      {draftChangesSomething && (
        <div className="foreman-draft-banner" role="status" aria-label="Foreman's draft">
          <span className="foreman-draft-banner-title">
            <span aria-hidden>◆</span>
            Foreman&apos;s draft
          </span>
          <span>Foreman changed the preselected answers. Nothing is sent until you submit.</span>
          <Tooltip label="Restore the agent's recommendation on the questions Foreman drafted, and clear Foreman's Other text">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={revert}>
              Revert to recommendation
            </button>
          </Tooltip>
        </div>
      )}
      {decisions.map((d) => (
        <fieldset
          key={d.id}
          className="decision"
          aria-label={hideQuestions ? d.question : undefined}
        >
          {!hideQuestions && <legend className="decision-q">{d.question}</legend>}
          {d.options.map((o) => {
            const foremanPick = foremanRecommended?.has(decisionChoiceKey(d.id, o.id));
            return (
            <label
              key={o.id}
              className={`decision-option${foremanPick ? " decision-foreman-pick" : ""}`}
            >
              <Tooltip label={o.detail ?? o.label}>
                <input
                  type={d.multiSelect ? "checkbox" : "radio"}
                  name={`${namePrefix}-${d.id}`}
                  checked={get(d.id).selected.includes(o.id)}
                  onChange={(e) => choose(d, o.id, e.target.checked)}
                  disabled={busy}
                />
              </Tooltip>
              <span className="decision-option-body">
                <span className="decision-option-label">
                  {o.label}
                  {o.recommended && <span className="decision-rec"> · recommended</span>}
                </span>
                {o.detail && <span className="decision-option-detail">{o.detail}</span>}
              </span>
              {foremanPick && <ForemanPickMark />}
            </label>
            );
          })}
          {d.allowOther && (
            <input
              className="decision-other"
              placeholder="Other…"
              value={get(d.id).other}
              onChange={(e) => setOther(d.id, e.target.value)}
              disabled={busy}
            />
          )}
          {d.allowOther && draftOthers.has(d.id) && draftOthers.get(d.id) === get(d.id).other.trim() && (
            <span className="decision-other-draft">◆ Foreman&apos;s draft</span>
          )}
        </fieldset>
      ))}
      <div className="decisions-actions">
        {onDismiss && (
          <Tooltip label="Dismiss this decision request without sending an answer">
            <button className="btn btn-ghost" disabled={busy} onClick={onDismiss}>
              Dismiss
            </button>
          </Tooltip>
        )}
        {summary && (
          <p className="decisions-selected" id={`${namePrefix}-selected`} aria-live="polite">
            {summary}
          </p>
        )}
        <Tooltip
          label={complete ? "Send these decisions back to the agent" : "Answer every decision above first"}
        >
          <button
            className="btn btn-approve"
            disabled={busy || !complete}
            aria-describedby={summary ? `${namePrefix}-selected` : undefined}
            onClick={() => onSubmit(formatResponse(decisions, payload, lead), payload)}
          >
            Submit
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
