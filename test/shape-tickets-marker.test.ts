import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShapeTicketsState, Task, TaskKind } from "../src/shared/types.ts";
import { SHAPE_TICKETS_STATES } from "../src/shared/types.ts";
import { shapeTicketsMarker } from "../src/web/lib/shape-tickets.ts";
import { PENDING_TASK_OPEN_MS, pendingTaskOpenState, taskOpenTarget } from "../src/web/lib/open-task.ts";
import { ShapeTicketsMarker } from "../src/web/components/ShapeTicketsMarker.tsx";
import { SessionTile } from "../src/web/components/layouts/SessionTile.tsx";
import { shapeTaskForSession } from "../src/web/components/layouts/types.ts";
import { ReportPanel } from "../src/web/components/ReportPanel.tsx";
import { RECENT_TASKS_CAP } from "../src/shared/session.ts";
import { mkSession, mkTask, mkTaskSummary } from "./helpers/session-fixture.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

/**
 * A shape task's tickets marker: which state draws what, and the one shape a browser cannot
 * pin cheaply - a marker that opens the follow-up is a control with the link role, and one
 * that does not is a note, never a control. The Playwright spec `shape-tickets-marker.spec.ts`
 * drives the same states through a real daemon.
 */

function shape(state: ShapeTicketsState | null, followupTaskId: string | null = "followup", kind: TaskKind = "shape"): Task {
  return mkTask({
    id: "shape-1",
    kind,
    shapeTickets: kind === "shape" ? { state, followupTaskId, canCreate: false } : null,
  });
}

const markup = (task: Task, onOpenTask?: (id: string) => void): string =>
  renderToStaticMarkup(createElement(ShapeTicketsMarker, { task, onOpenTask, variant: "chip" }));

test("each drawn state says its own words, and only queued and started point at the follow-up", () => {
  assert.deepEqual(
    Object.fromEntries(SHAPE_TICKETS_STATES.map((state) => {
      const view = shapeTicketsMarker(shape(state));
      return [state, view && { label: view.label, followupTaskId: view.followupTaskId }];
    })),
    {
      "awaiting-review": null,
      pending: { label: "Tickets after merge", followupTaskId: null },
      stop: null,
      lapsed: { label: "Tickets lapsed", followupTaskId: null },
      queued: { label: "Tickets queued", followupTaskId: "followup" },
      started: { label: "Tickets", followupTaskId: "followup" },
    },
  );
});

test("no recorded choice, no follow-up to open, or any other kind draws nothing", () => {
  assert.equal(shapeTicketsMarker(shape(null)), null);
  assert.equal(shapeTicketsMarker(mkTask({ kind: "shape", shapeTickets: undefined })), null);
  assert.equal(shapeTicketsMarker(shape("queued", null)), null);
  assert.equal(shapeTicketsMarker(shape("started", null)), null);
  for (const kind of ["ship", "plan", "bugfix"] as const) {
    assert.equal(shapeTicketsMarker(shape("pending", null, kind)), null, kind);
    // A hand-built row carrying the field anyway is still not a shape task.
    const forged = { ...mkTask({ kind }), shapeTickets: { state: "pending" as const, followupTaskId: null, canCreate: false } };
    assert.equal(shapeTicketsMarker(forged), null, kind);
    assert.equal(markup(forged), "");
  }
  assert.equal(markup(shape("stop")), "");
});

test("a marker that opens the follow-up is a link-role control; the others are named notes", () => {
  const open = (): void => {};
  for (const [state, label] of [["queued", "Tickets queued"], ["started", "Tickets"]] as const) {
    const html = markup(shape(state), open);
    assert.match(html, new RegExp(`<button type="button" role="link" class="shape-tickets-chip shape-tickets-${state} shape-tickets-open"[^>]*>${label}</button>`));
    // Without a way to open a task (the Settings card preview), it is a note instead.
    assert.match(markup(shape(state)), new RegExp(`<span class="shape-tickets-chip shape-tickets-${state}" role="note" aria-label="${label}"`));
  }
  for (const [state, label] of [["pending", "Tickets after merge"], ["lapsed", "Tickets lapsed"]] as const) {
    const html = markup(shape(state), open);
    assert.doesNotMatch(html, /<button/);
    assert.match(html, new RegExp(`<span class="shape-tickets-chip shape-tickets-${state}" role="note" aria-label="${label}"[^>]*>${label}</span>`));
  }
});

test("the board card draws the marker among its flags, from the whole task the view holds", () => {
  const task = shape("pending");
  const session = mkSession({ task: mkTaskSummary({ id: task.id, kind: "shape" }) });
  assert.equal(shapeTaskForSession({ tasks: [mkTask({ id: "other" }), task] }, session), task);
  assert.equal(shapeTaskForSession({ tasks: [task] }, mkSession({ task: mkTaskSummary({ id: task.id, kind: "ship" }) })), null);

  const html = renderToStaticMarkup(createElement(SessionTile, {
    session,
    onOpen: () => {},
    draggingRepo: null,
    onDropped: () => {},
    onDropError: () => {},
    onDropConfirm: () => {},
    shapeTask: task,
    onOpenTask: () => {},
  }));
  assert.match(html, /<span class="tile-marks">.*<span class="tile-flag tf-shape-tickets shape-tickets-pending" role="note" aria-label="Tickets after merge"/s);
});

// The Tickets link on a finished follow-up opens the Sitrep on that follow-up's own row
// (`ReportPanel.focusTask`). The row a person asked for has to be there to land on, even
// when it has aged out of Recent outcomes, and must not be drawn twice when it has not.
const finishedRows = (count: number): Task[] =>
  Array.from({ length: count }, (_, i) =>
    mkTask({ id: `done-${i}`, title: `Finished ${i}`, status: "done", updatedAt: 10_000 - i }));

const sitrep = (tasks: Task[], focusTaskId: string): string =>
  renderToStaticMarkup(withOverlayHost(createElement(ReportPanel, {
    sessions: [],
    tasks,
    backlogPlan: null,
    onClose: () => {},
    onOpenReviews: () => {},
    onEditTask: () => {},
    focusTask: { taskId: focusTaskId, nonce: 1 },
  })));

const recentRowCount = (html: string): number => (html.match(/<div class="report-row[ "]/g) ?? []).length;
const focusedRow = (title: string): RegExp =>
  new RegExp(`<div class="report-row is-focused" tabindex="-1" aria-current="true"><div class="report-row-main"><span class="report-name">${title}</span>`);

test("a focused task past the Recent outcomes cap is still drawn, once, as the current row", () => {
  const tasks = finishedRows(RECENT_TASKS_CAP + 1);
  const oldest = `Finished ${RECENT_TASKS_CAP}`;

  const unfocused = sitrep(tasks, "no-such-task");
  assert.equal(recentRowCount(unfocused), RECENT_TASKS_CAP);
  assert.doesNotMatch(unfocused, new RegExp(`>${oldest}<`));
  assert.doesNotMatch(unfocused, /aria-current/);

  const html = sitrep(tasks, `done-${RECENT_TASKS_CAP}`);
  assert.equal(recentRowCount(html), RECENT_TASKS_CAP + 1);
  assert.match(html, focusedRow(oldest));
  assert.equal(html.match(/aria-current="true"/g)?.length, 1);
});

test("a focused task already within the cap is marked in place, not appended again", () => {
  const html = sitrep(finishedRows(RECENT_TASKS_CAP + 1), "done-3");
  assert.equal(recentRowCount(html), RECENT_TASKS_CAP);
  assert.equal(html.match(/>Finished 3</g)?.length, 1);
  assert.match(html, focusedRow("Finished 3"));
  assert.equal(html.match(/aria-current="true"/g)?.length, 1);
});

// Where the follow-up link (and every other "open task") lands. The Sitrep draws finished
// tasks only, so a task in flight with no session up must never be sent there to land on
// nothing: it waits for its session, or for its outcome.
test("opening a task lands on its live session, its editor, a finished row, or waits", () => {
  const running = mkTask({ id: "f", status: "running", sessionId: "s1" });
  const up = mkSession({ id: "s1", state: "working" });
  const exited = mkSession({ id: "s1", state: "exited" });
  assert.deepEqual(taskOpenTarget(running, [up]), { kind: "session", sessionId: "s1" });
  // A session that exited and is not yet evicted is not somewhere to land.
  assert.deepEqual(taskOpenTarget(running, [exited]), { kind: "wait" });
  // Provisioning, before the session exists, matched by the session's task when unbound.
  const dispatching = mkTask({ id: "f", status: "dispatching", sessionId: null });
  assert.deepEqual(taskOpenTarget(dispatching, []), { kind: "wait" });
  assert.deepEqual(
    taskOpenTarget(dispatching, [mkSession({ id: "s2", state: "idle", task: mkTaskSummary({ id: "f" }) })]),
    { kind: "session", sessionId: "s2" },
  );
  assert.deepEqual(taskOpenTarget(mkTask({ status: "backlog", sessionId: null }), []), { kind: "editor" });
  for (const status of ["done", "failed", "cancelled"] as const) {
    assert.deepEqual(taskOpenTarget(mkTask({ status, sessionId: "s1" }), [exited]), { kind: "sitrep" }, status);
  }
});

// A click that had to wait lands only while the person is still where it left them, and only
// briefly: a slow launch must never move someone who has since chosen something else.
test("a waiting open lands only on the view it left, and only briefly", () => {
  const left = { page: "fleet", selectedId: "s-mine", sitrepOpen: false, modalOpen: false };
  const pending = { taskId: "f", view: left, fromPage: "ensembles", at: 1_000 };
  assert.equal(pendingTaskOpenState(pending, left, 1_000), "stands");
  assert.equal(pendingTaskOpenState(pending, left, 1_000 + PENDING_TASK_OPEN_MS), "stands");
  assert.equal(pendingTaskOpenState(pending, left, 1_001 + PENDING_TASK_OPEN_MS), "drop");
  // The route still names the page the click came from until its hash change lands.
  assert.equal(pendingTaskOpenState(pending, { ...left, page: "ensembles" }, 1_500), "settling");
  // They moved on: another page, another session, the Sitrep, a modal.
  assert.equal(pendingTaskOpenState(pending, { ...left, page: "library" }, 1_500), "drop");
  assert.equal(pendingTaskOpenState(pending, { ...left, selectedId: "s-other" }, 1_500), "drop");
  assert.equal(pendingTaskOpenState(pending, { ...left, sitrepOpen: true }, 1_500), "drop");
  assert.equal(pendingTaskOpenState(pending, { ...left, modalOpen: true }, 1_500), "drop");
  // Still on the page it came from, but having done something there, is moving on too.
  assert.equal(pendingTaskOpenState(pending, { ...left, page: "ensembles", modalOpen: true }, 1_500), "drop");
  // From the fleet itself there is nothing to settle.
  const fromFleet = { ...pending, fromPage: "fleet" };
  assert.equal(pendingTaskOpenState(fromFleet, { ...left, selectedId: null }, 1_500), "drop");
});
