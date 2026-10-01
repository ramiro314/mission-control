import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShapeTicketsState, Task, TaskKind } from "../src/shared/types.ts";
import { SHAPE_TICKETS_STATES } from "../src/shared/types.ts";
import { shapeTicketsMarker } from "../src/web/lib/shape-tickets.ts";
import { ShapeTicketsMarker } from "../src/web/components/ShapeTicketsMarker.tsx";
import { SessionTile } from "../src/web/components/layouts/SessionTile.tsx";
import { shapeTaskForSession } from "../src/web/components/layouts/types.ts";
import { mkSession, mkTask, mkTaskSummary } from "./helpers/session-fixture.ts";

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
