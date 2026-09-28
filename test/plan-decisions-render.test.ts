import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DecisionForm, draftedAnswers, recommendedAnswers, toDecisionAnswers } from "../src/web/components/PlanDecisions.tsx";
import type { PlanDecision } from "../src/shared/types.ts";
import { hasTooltip } from "./helpers/markup.ts";

// Rendered rather than driven through a browser: the dashboard's SSE stream holds the
// connection open, which hangs headless automation. Static markup is enough to prove the
// form renders each question with the right control type, the recommended/detail hints,
// an "Other" field only where asked, and a Submit that starts disabled so the agent can't
// unblock on an empty form. (The form is rendered directly rather than through ReviewModal
// because this unit only needs the decision form, not the surrounding review protocols.)

const decisions: PlanDecision[] = [
  {
    id: "store",
    question: "Where should sessions live?",
    options: [
      { id: "redis", label: "Use Redis", detail: "one more service to run", recommended: true },
      { id: "pg", label: "Postgres table" },
    ],
  },
  {
    id: "providers",
    question: "Which providers ship first?",
    options: [
      { id: "google", label: "Google" },
      { id: "github", label: "GitHub" },
    ],
    multiSelect: true,
    allowOther: true,
  },
];

function render(ds: PlanDecision[] = decisions): string {
  return renderToStaticMarkup(
    createElement(DecisionForm, { decisions: ds, busy: false, onSubmit: () => {} }),
  );
}

test("renders every question and option", () => {
  const html = render();
  assert.match(html, /Where should sessions live\?/);
  assert.match(html, /Which providers ship first\?/);
  assert.match(html, /Use Redis/);
  assert.match(html, /Postgres table/);
  assert.match(html, /Google/);
  assert.match(html, /GitHub/);
});

test("single-select renders radios, multi-select renders checkboxes", () => {
  const html = render();
  // The group name is the decision id under a per-form prefix, because a `name` is
  // document-scoped and several forms can share one document - see `namePrefix`.
  assert.match(html, /type="radio"[^>]*name="[^"]*-store"/);
  assert.match(html, /type="checkbox"[^>]*name="[^"]*-providers"/);
});

test("a recommended option shows the hint and details render", () => {
  const html = render();
  assert.match(html, /recommended/);
  assert.match(html, /one more service to run/);
  assert.ok(hasTooltip(html, "one more service to run"));
  assert.ok(hasTooltip(html, "Postgres table"));
});

test("allowOther adds a free-text field only where asked", () => {
  // Exactly one "Other…" input: the providers decision, not the store decision.
  assert.equal(render().match(/placeholder="Other/g)?.length, 1);
});

test("Submit starts disabled so the agent can't unblock on an empty form", () => {
  const html = render();
  assert.match(html, /<button[^>]*disabled[^>]*>Submit<\/button>/);
});

test("a review can expose Dismiss without treating it as a submitted choice", () => {
  const html = renderToStaticMarkup(
    createElement(DecisionForm, {
      decisions,
      busy: false,
      onSubmit: () => {},
      onDismiss: () => {},
    }),
  );
  assert.match(html, /<button[^>]*>Dismiss<\/button>/);
  assert.match(html, /<button[^>]*disabled[^>]*>Submit<\/button>/);
});

test("zero decisions leave Submit disabled rather than vacuously complete", () => {
  // A degraded `decisions` blob reaches the form as an empty list; "every decision is
  // answered" is trivially true for none of them, so Submit must be gated on having
  // something to submit or the agent unblocks on a content-free response.
  assert.match(render([]), /<button[^>]*disabled[^>]*>Submit<\/button>/);
});

// Preselection: a form opens with the agent's `recommended` option(s) already chosen, so an
// untouched Submit returns exactly the recommendation.

const allRecommended: PlanDecision[] = [
  {
    id: "store",
    question: "Where should sessions live?",
    options: [
      { id: "redis", label: "Use Redis" },
      { id: "pg", label: "Postgres table", recommended: true },
      { id: "sqlite", label: "SQLite", recommended: true },
    ],
  },
  {
    id: "providers",
    question: "Which providers ship first?",
    options: [
      { id: "google", label: "Google", recommended: true },
      { id: "github", label: "GitHub" },
      { id: "gitlab", label: "GitLab", recommended: true },
    ],
    multiSelect: true,
    allowOther: true,
  },
];

/** The `value`-less input for one option label, as rendered. */
function inputFor(html: string, label: string): string {
  const at = html.indexOf(label);
  assert.ok(at > 0, `${label} is rendered`);
  const open = html.lastIndexOf("<input", at);
  return html.slice(open, html.indexOf(">", open) + 1);
}

test("recommendedAnswers preselects the first recommended radio and every recommended checkbox", () => {
  assert.deepEqual(recommendedAnswers(allRecommended), {
    store: { selected: ["pg"], other: "", otherChosen: false },
    providers: { selected: ["google", "gitlab"], other: "", otherChosen: false },
  });
  // A decision with no recommendation contributes nothing and opens empty.
  assert.deepEqual(recommendedAnswers([decisions[1]!]), {});
});

test("the form opens with recommended options checked, radio and multi-select alike", () => {
  const html = render(allRecommended);
  assert.match(inputFor(html, "Postgres table"), /checked/);
  assert.doesNotMatch(inputFor(html, "SQLite"), /checked/, "a radio holds one recommendation");
  assert.doesNotMatch(inputFor(html, "Use Redis"), /checked/);
  assert.match(inputFor(html, "Google"), /checked/);
  assert.match(inputFor(html, "GitLab"), /checked/);
  assert.doesNotMatch(inputFor(html, "GitHub"), /checked/);
});

test("a fully recommended form can be submitted untouched and says what it will send", () => {
  const html = render(allRecommended);
  assert.doesNotMatch(html, /<button[^>]*disabled[^>]*>Submit<\/button>/);
  assert.match(html, /Selected: Postgres table · Google, GitLab/);
  assert.match(html, /<button[^>]*aria-describedby="d-selected[ "][^>]*>Submit<\/button>/);
});

test("a form without any recommendation opens as before: nothing checked, no summary", () => {
  const html = render([decisions[1]!]);
  assert.doesNotMatch(html, /checked/);
  assert.doesNotMatch(html, /Selected:/);
  assert.match(html, /<button[^>]*disabled[^>]*>Submit<\/button>/);
});

// Single choice with Other: Other is one more radio in the group, and its text is sent only
// while it is the choice - and then alone. Multi-choice keeps its additive Other box.

const singleOther: PlanDecision[] = [
  {
    id: "install",
    question: "How should the installer run?",
    options: [
      { id: "wsl", label: "Run install.sh inside WSL", recommended: true },
      { id: "ps", label: "PowerShell script" },
    ],
    allowOther: true,
  },
];

test("a single-choice question with Other renders an Other radio in the same group", () => {
  const html = render(singleOther);
  assert.equal(html.match(/type="radio"[^>]*name="d-install"/g)?.length, 3, "two options plus Other");
  assert.match(html, /<input type="radio" name="d-install"[^>]*\/><span class="decision-option-label">Other<\/span>/);
  assert.doesNotMatch(inputFor(html, ">Other<"), /checked/, "the recommendation opens chosen, not Other");
  assert.match(html, /placeholder="Other…"/);
  // Multi-choice is unchanged: checkboxes and a separate box, no Other radio.
  const multi = render([decisions[1]!]);
  assert.doesNotMatch(multi, /type="radio"/);
  assert.equal(multi.match(/placeholder="Other/g)?.length, 1);
});

test("single choice sends Other alone while chosen, and drops kept text once a listed option is", () => {
  const chosen = { install: { selected: [], other: "  Test  ", otherChosen: true } };
  assert.deepEqual(toDecisionAnswers(singleOther, chosen), [{ decisionId: "install", selected: [], other: "Test" }]);

  // A listed option chosen again: the text is kept in state (and the box) but not sent.
  const back = { install: { selected: ["ps"], other: "Test", otherChosen: false } };
  assert.deepEqual(toDecisionAnswers(singleOther, back), [{ decisionId: "install", selected: ["ps"], other: null }]);

  // Other chosen with a blank box is unanswered, so Submit stays disabled.
  const blank = { install: { selected: [], other: "  ", otherChosen: true } };
  assert.deepEqual(toDecisionAnswers(singleOther, blank), [{ decisionId: "install", selected: [], other: null }]);

  // Multi-choice Other stays additive, whatever the flag says.
  const multi = { providers: { selected: ["google"], other: "Okta", otherChosen: false } };
  assert.deepEqual(toDecisionAnswers([decisions[1]!], multi), [
    { decisionId: "providers", selected: ["google"], other: "Okta" },
  ]);
});

test("a Foreman draft with Other on a single-choice question opens with Other chosen", () => {
  const drafted = draftedAnswers(singleOther, [{ decisionId: "install", selected: ["wsl"], other: "Use a VM" }]);
  assert.deepEqual(drafted.install, { selected: [], other: "Use a VM", otherChosen: true });

  const html = renderToStaticMarkup(
    createElement(DecisionForm, {
      decisions: singleOther,
      busy: false,
      onSubmit: () => {},
      foremanDraft: [{ decisionId: "install", selected: ["wsl"], other: "Use a VM" }],
    }),
  );
  assert.match(inputFor(html, ">Other<"), /checked/);
  assert.doesNotMatch(inputFor(html, "Run install.sh inside WSL"), /checked/);
  assert.match(html, /Selected: Other: Use a VM \(Foreman&#x27;s draft\)/);

  // A draft without Other text keeps its listed choice.
  const listed = draftedAnswers(singleOther, [{ decisionId: "install", selected: ["ps"], other: null }]);
  assert.deepEqual(listed.install, { selected: ["ps"], other: "", otherChosen: false });
});
