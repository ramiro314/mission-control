import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BacklogColumn } from "../src/web/components/layouts/BacklogColumn.tsx";
import type { Task } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";

// A backlog card names its base branch only when it has one. The daemon writes origin's
// default branch as null (`resolveBaseBranch`), so "set" means "not the default when it was
// written", and a card for the common default-branch task carries no extra chip.
//
// `createElement` rather than JSX because the runner's glob only matches .test.ts.

const noop = (): void => {};

function column(tasks: Task[]): string {
  return renderToStaticMarkup(
    createElement(BacklogColumn, {
      tasks,
      allTasks: tasks,
      plan: null,
      onAssignError: noop,
      onDragging: noop,
      onEdit: noop,
    }),
  );
}

test("a backlog card shows a set base branch and nothing for the default", () => {
  const based = column([mkTask({ id: "t-based", baseBranch: "release/windows" })]);
  assert.match(based, /<span class="bl-base"[^>]*>base release\/windows<\/span>/);

  for (const baseBranch of [null, undefined]) {
    const plain = column([mkTask({ id: "t-plain", baseBranch })]);
    assert.doesNotMatch(plain, /bl-base/);
  }
});
