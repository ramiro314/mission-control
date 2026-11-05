import { useEffect, useRef, useState } from "react";
import type { PlanDecision, PlanDecisionAnswer } from "@shared/types.ts";
import { CHAT_ABOUT_IT, formatResponse, selectedOptions } from "@shared/review-item.ts";
import { isAnswered } from "../lib/reviews.ts";
import { ForemanPickMark } from "./ForemanRecommendation.tsx";
import { Tooltip } from "./Tooltip.tsx";
import type { DecisionAnswer, DecisionAnswers } from "../lib/review-drafts.ts";

/**
 * Per-decision answer state: the review draft's shape (`DecisionAnswer`), with `note`
 * optional because the opening state never has one.
 *
 * `otherChosen` means something only on a single-choice question, where Other is one more
 * radio in the group: true when Other is the choice, in which case `selected` is empty. The
 * text is kept when a listed option is chosen instead, so switching back does not lose it,
 * but it is not sent. A multi-choice question's Other is additive and ignores the flag. A
 * draft parked before the flag existed reads Other as chosen when nothing listed is and the
 * box has text - see `otherIsChosen`.
 */
type Answer = Omit<DecisionAnswer, "note"> & { note?: string };
type Answers = Record<string, Answer>;

const EMPTY: Answer = { selected: [], other: "", note: "", otherChosen: false };

function otherIsChosen(a: Answer): boolean {
  return a.otherChosen ?? (a.selected.length === 0 && a.other.trim() !== "");
}

/** Mirrors the review-draft store's emptiness rule: an answer map it would forget. */
function isUntouched(answers: Answers): boolean {
  return Object.values(answers).every(
    (a) => a.selected.length === 0 && !a.other && !a.note && !a.chat && !a.otherChosen,
  );
}

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
 * like one that never asked. Blank "Other" text normalizes to null and a blank note is
 * omitted, so "typed nothing" and "typed and cleared it" are the same record.
 */
export function toDecisionAnswers(
  decisions: PlanDecision[],
  answers: Answers,
  draftOthers: ReadonlyMap<string, string> = new Map(),
): PlanDecisionAnswer[] {
  return decisions.map((d) => {
    const a = answers[d.id] ?? EMPTY;
    const note = a.note?.trim() ?? "";
    // Moved to chat: nothing picked before the move is an answer, only the note travels.
    if (a.chat) {
      return { decisionId: d.id, selected: [], other: null, chat: true, ...(note ? { note } : {}) };
    }
    // Single choice: Other is a radio of its own, so its text goes out only while it is the
    // choice, and then alone. Kept text beside a listed option is not an answer.
    const single = !d.multiSelect;
    const chosen = single && otherIsChosen(a);
    const text = a.other.trim();
    const other = text && (!single || chosen) ? text : null;
    return {
      decisionId: d.id,
      selected: chosen ? [] : a.selected,
      other,
      // Present only when typed, so an answer without one keeps the shape it always had.
      ...(note ? { note } : {}),
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
    const other = decision.allowOther ? (d.other ?? "") : "";
    // A drafted Other on a single-choice question is chosen, exactly as typing it would be.
    const otherChosen = !decision.multiSelect && other.trim() !== "";
    answers[d.decisionId] = {
      selected: otherChosen ? [] : decision.multiSelect ? selected : selected.slice(0, 1),
      other,
      otherChosen,
    };
  }
  return answers;
}

/**
 * Whether two form states would submit the same answer.
 *
 * Compared as payloads, so Other text kept beside a listed option - shown, never sent - does
 * not count as a difference.
 */
function sameAnswers(decisions: PlanDecision[], a: Answers, b: Answers): boolean {
  const pa = toDecisionAnswers(decisions, a);
  const pb = toDecisionAnswers(decisions, b);
  return decisions.every((_, i) => {
    const x = pa[i]!;
    const y = pb[i]!;
    return (
      x.other === y.other &&
      x.note === y.note &&
      x.chat === y.chat &&
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
    if (ids.length) answers[d.id] = { selected: d.multiSelect ? ids : ids.slice(0, 1), other: "", otherChosen: false };
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
    if (a?.chat) return [CHAT_ABOUT_IT];
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
 * A single-choice question's Other: one more radio in the group, with its text box in the row.
 *
 * A pointer click on the radio, a pointer press in the box, or typing chooses Other. Focus
 * alone never does, so tabbing through the form leaves the selection as it was - which is why
 * the box listens for `pointerdown` and not `focus`. A pointer click on the radio moves focus
 * into the box; a keyboard-driven click (`detail === 0`, from Space or the arrow keys) leaves
 * focus on the radio, as a radio group normally does.
 */
function OtherChoice({
  name,
  value,
  chosen,
  busy,
  onChoose,
  onText,
}: {
  name: string;
  value: string;
  chosen: boolean;
  busy: boolean;
  onChoose: () => void;
  onText: (text: string) => void;
}): React.JSX.Element {
  const box = useRef<HTMLInputElement>(null);
  return (
    <div className="decision-option decision-other-choice">
      <label className="decision-other-choice-label">
        <Tooltip label="Answer with your own text instead of a listed option">
          <input
            type="radio"
            // Named outright: the tooltip's hidden description sits inside the label too.
            aria-label="Other"
            name={name}
            checked={chosen}
            onChange={onChoose}
            onClick={(e) => {
              if (e.detail > 0) box.current?.focus();
            }}
            disabled={busy}
          />
        </Tooltip>
        <span className="decision-option-label">Other</span>
      </label>
      <input
        ref={box}
        className="decision-other"
        placeholder="Other…"
        aria-label="Other answer"
        value={value}
        onPointerDown={onChoose}
        onChange={(e) => onText(e.target.value)}
        disabled={busy}
      />
    </div>
  );
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
  /**
   * Draw an optional note box under every decision, so the human can pick an option AND send
   * instructions with it. Off by default: a form whose resolution never reaches an agent as
   * prose - the product-issue confirmation, which acts on the selection alone - must not
   * offer a box whose text would go nowhere.
   */
  allowNote = false,
  /**
   * Offer "Chat about it" on every question, plus "Chat about all" when there are several.
   *
   * A moved question counts as answered, so the human can submit what they know and take the
   * rest to the conversation in one go; `formatResponse` tells the agent to explain those and
   * wait rather than decide them. Off by default, like the note: a form rendered on its own
   * has no conversation to move anything into.
   */
  allowChat = false,
  foremanRecommended,
  foremanDraft,
  besideSubmit,
  answers: heldAnswers,
  onAnswersChange,
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
  allowNote?: boolean;
  allowChat?: boolean;
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
  /** A control drawn next to Submit, such as the final-bundle form's standing approval. */
  besideSubmit?: React.ReactNode;
  /**
   * The answers, held by the caller instead of by this mount.
   *
   * A review card passes its parked draft here so picks and typed text survive the form
   * unmounting - the modal closing, the inbox folding, the page reloading. Left out, the form
   * keeps its own state, as a standalone form with nothing to outlive has always done.
   *
   * Only the human's edits are written here. Until the first one, the form shows its opening
   * state - the recommendation, or Foreman's draft over it - derived on every render, so a
   * draft landing later never has to overwrite anything the store holds.
   */
  answers?: DecisionAnswers;
  onAnswersChange?: (change: (prev: DecisionAnswers) => DecisionAnswers) => void;
}): React.JSX.Element {
  const [ownAnswers, setOwnAnswers] = useState<Answers>({});
  const held: Answers = heldAnswers ?? ownAnswers;
  // Edited here, or by another card showing the same review: the held answers are the form.
  const [touched, setTouched] = useState(false);
  const handled = touched || !isUntouched(held);
  const [draft, setDraft] = useState<DraftState>(() => {
    const opening = openingDraftState(foremanDraft);
    // Answers already held were the human's, from before a close or a reload.
    return isUntouched(held) ? opening : draftAfterEdit(opening);
  });
  // By content, so a re-render carrying the same draft is not a new one.
  const draftKey = foremanDraft?.length ? JSON.stringify(foremanDraft) : null;

  // Foreman's review takes minutes, so its draft usually lands on a form already open, and
  // an invite withdrawn takes it away again. `draftOnChange` decides what that does to the
  // form; see its rules. The answers follow from the state: an untouched form shows its
  // opening state, and a touched one keeps the held answers.
  useEffect(() => {
    const current = handled ? draftAfterEdit(draft) : draft;
    const step = draftOnChange(current, foremanDraft);
    setDraft(step ? step.next : current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the draft's content
  }, [draftKey]);

  const activeDraft = draft.kind === "applied" ? draft.draft : null;
  const draftOthers = new Map(
    (activeDraft ?? []).flatMap((d) => (d.other?.trim() ? [[d.decisionId, d.other.trim()] as const] : [])),
  );
  const recommended = recommendedAnswers(decisions);
  const opening = activeDraft ? draftedAnswers(decisions, activeDraft) : recommended;
  const answers = handled ? held : opening;
  const draftChangesSomething =
    activeDraft != null && !sameAnswers(decisions, draftedAnswers(decisions, activeDraft), recommended);

  /** Write to whoever holds the answers, in the store's shape. */
  function store(change: (prev: Answers) => Answers): void {
    if (!onAnswersChange) {
      setOwnAnswers(change);
      return;
    }
    onAnswersChange((prev) =>
      Object.fromEntries(
        Object.entries(change(prev)).map(([id, a]) => [id, { ...a, note: a.note ?? "" }]),
      ),
    );
  }

  /**
   * The human changed something by hand. The first edit starts from what the form shows - the
   * opening state - rather than from the empty store behind it.
   */
  function edit(change: (prev: Answers) => Answers): void {
    const wasHandled = handled;
    setTouched(true);
    setDraft(draftAfterEdit);
    store((prev) => change(wasHandled || !isUntouched(prev) ? prev : opening));
  }

  function revert(): void {
    // Only the decisions Foreman's draft touched go back to the recommendation. An answer
    // you gave to any other question is yours, and undoing Foreman must not undo it.
    const drafted = new Set((activeDraft ?? []).map((d) => d.decisionId));
    if (handled) {
      store((prev) => {
        const next = { ...prev };
        for (const id of drafted) {
          if (recommended[id]) next[id] = recommended[id];
          else delete next[id];
        }
        return next;
      });
    }
    setDraft({ kind: "set-aside" });
  }

  function get(id: string): Answer {
    return answers[id] ?? EMPTY;
  }

  function choose(d: PlanDecision, optionId: string, checked: boolean): void {
    edit((prev) => {
      const cur = prev[d.id] ?? EMPTY;
      let selected: string[];
      if (d.multiSelect) {
        selected = checked
          ? [...cur.selected, optionId]
          : cur.selected.filter((x) => x !== optionId);
      } else {
        selected = [optionId]; // radio: single choice replaces
      }
      // Picking a listed radio deselects Other; its text stays in the box, unsent.
      return { ...prev, [d.id]: { ...cur, selected, otherChosen: false, chat: false } };
    });
  }

  /** Single choice: make Other the choice, clearing the listed option. */
  function chooseOther(d: PlanDecision): void {
    const cur = get(d.id);
    if (otherIsChosen(cur) && !cur.chat) return;
    edit((prev) => ({
      ...prev,
      [d.id]: { ...(prev[d.id] ?? EMPTY), selected: [], otherChosen: true, chat: false },
    }));
  }

  function moveToChat(id: string, chat: boolean): void {
    edit((prev) => {
      const cur = prev[id] ?? EMPTY;
      return {
        ...prev,
        [id]: chat ? { ...cur, selected: [], other: "", otherChosen: false, chat: true } : { ...cur, chat: false },
      };
    });
  }

  function setText(d: PlanDecision, field: "other" | "note", text: string): void {
    edit((prev) => {
      const cur = prev[d.id] ?? EMPTY;
      if (field === "note") return { ...prev, [d.id]: { ...cur, note: text } };
      // Typing an answer outside the options is answering, so non-blank text leaves chat. On a
      // single-choice question it also chooses Other, as a pointer click in the box does; blank
      // text on a question moved to chat is no answer, so the question stays in chat.
      const leaves = !cur.chat || text.trim() !== "";
      const next = d.multiSelect || !leaves
        ? { ...cur, other: text, chat: leaves ? false : cur.chat }
        : { ...cur, other: text, selected: [], otherChosen: true, chat: false };
      return { ...prev, [d.id]: next };
    });
  }

  // Built once per render and used for both the completeness test and the submit, so the
  // button's enabled state is decided over exactly the payload it would send.
  const payload = toDecisionAnswers(decisions, answers, draftOthers);
  const complete = decisions.length > 0 && decisions.every((d, i) => isAnswered(d, payload[i]));
  const summary = selectionSummary(decisions, payload);
  const chatCount = allowChat ? payload.filter((a) => a.chat).length : 0;

  function chatAboutAll(): void {
    const all = toDecisionAnswers(
      decisions,
      Object.fromEntries(decisions.map((d) => [d.id, { ...get(d.id), chat: true }])),
    );
    onSubmit(formatResponse(decisions, all, lead), all);
  }

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
      {decisions.map((d, i) => (
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
              {/*
                No `Tooltip`: it repeated the detail printed below, and picking an option
                focuses the radio, so the bubble stayed up over the question until blur. The
                enclosing label already names the radio. "Chat about it" keeps its bubble.
              */}
              <input
                type={d.multiSelect ? "checkbox" : "radio"}
                name={`${namePrefix}-${d.id}`}
                checked={get(d.id).selected.includes(o.id)}
                onChange={(e) => choose(d, o.id, e.target.checked)}
                disabled={busy}
              />
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
          {d.allowOther && !d.multiSelect && (
            <OtherChoice
              name={`${namePrefix}-${d.id}`}
              value={get(d.id).other}
              chosen={otherIsChosen(get(d.id)) && !get(d.id).chat}
              busy={busy}
              onChoose={() => chooseOther(d)}
              onText={(text) => setText(d, "other", text)}
            />
          )}
          {d.allowOther && d.multiSelect && (
            <input
              className="decision-other"
              placeholder="Other…"
              value={get(d.id).other}
              onChange={(e) => setText(d, "other", e.target.value)}
              disabled={busy}
            />
          )}
          {payload[i]?.foremanDraftAccepted && (
            <span className="decision-other-draft">◆ Foreman&apos;s draft</span>
          )}
          {allowChat && (
            <label className={`decision-option decision-chat${get(d.id).chat ? " is-chat" : ""}`}>
              <Tooltip label="Skip choosing for now: the agent explains this question in the conversation and waits for you">
                <input
                  type={d.multiSelect ? "checkbox" : "radio"}
                  name={`${namePrefix}-${d.id}`}
                  checked={get(d.id).chat === true}
                  onChange={(e) => moveToChat(d.id, e.target.checked)}
                  disabled={busy}
                />
              </Tooltip>
              <span className="decision-option-body">
                <span className="decision-option-label">
                  <ChatGlyph />
                  {CHAT_ABOUT_IT}
                </span>
              </span>
            </label>
          )}
          {allowNote && (
            <textarea
              className="decision-note"
              aria-label={`Note to the agent: ${d.question}`}
              placeholder="Optional note to the agent…"
              rows={3}
              value={get(d.id).note ?? ""}
              onChange={(e) => setText(d, "note", e.target.value)}
              disabled={busy}
            />
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
        {besideSubmit}
        {allowChat && decisions.length > 1 && (
          <Tooltip label="Move every question to the conversation: the agent explains them and waits for you">
            <button
              className={`btn btn-chat${besideSubmit ? "" : " decisions-chat-all"}`}
              disabled={busy}
              onClick={chatAboutAll}
            >
              Chat about all
            </button>
          </Tooltip>
        )}
        <Tooltip
          label={
            !complete
              ? `Answer every decision above${allowChat ? ", or move it to chat," : ""} first`
              : chatCount
                ? "Send these answers, and ask the agent to discuss the rest in the conversation"
                : "Send these decisions back to the agent"
          }
        >
          <button
            className="btn btn-approve"
            disabled={busy || !complete}
            aria-describedby={summary ? `${namePrefix}-selected` : undefined}
            onClick={() => onSubmit(formatResponse(decisions, payload, lead), payload)}
          >
            {chatCount ? `Submit & chat (${chatCount})` : "Submit"}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

export function ChatGlyph(): React.JSX.Element {
  return (
    <svg className="chat-glyph" viewBox="0 0 16 14" aria-hidden="true" focusable="false">
      <path
        d="M2 1.5h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7l-3.5 2.7V10.5H2a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
