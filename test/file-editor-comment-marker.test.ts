import assert from "node:assert/strict";
import test from "node:test";

import type { EditorView } from "@codemirror/view";

import {
  CommentMarkerWidget,
  type FileEditorCommentMarker,
} from "../src/web/components/FileEditor.tsx";

/**
 * A comment marker's button across a redraw.
 *
 * A state change must repaint the SAME button: replacing it drops a keyboard user's focus to
 * the page, which is what failed the keyboard marker spec on Windows CI run 37807097380. A
 * different line must not: CodeMirror offers `updateDOM` whichever marker button it is
 * recycling, and repainting another line's button would leave focus on a control that now
 * names a comment the reader never chose. `e2e/specs/file-line-comments.spec.ts` drives the
 * first half in a browser; no route moves a sent marker to another line on demand, so the
 * second half is pinned here.
 */

/** Just enough of a `<button>` for the widget: its name, its class and its listeners. */
class FakeButton {
  type = "";
  className = "";
  textContent = "";
  contentEditable = "";
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (event: unknown) => void>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, listener);
  }

  click(): void {
    this.listeners.get("click")!({ preventDefault() {}, stopPropagation() {} });
  }
}

function drawn(widget: CommentMarkerWidget): FakeButton {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new FakeButton() } as unknown as Document;
  try {
    return widget.toDOM() as unknown as FakeButton;
  } finally {
    globalThis.document = previous;
  }
}

function update(next: CommentMarkerWidget, button: FakeButton, from: CommentMarkerWidget): boolean {
  return next.updateDOM(button as unknown as HTMLElement, null as unknown as EditorView, from);
}

const SENT: FileEditorCommentMarker = {
  line: 3,
  label: "Comment MC-8fc3 on line 3, sent",
  tone: "is-queued",
};
const NO_ANSWER: FileEditorCommentMarker = {
  line: 3,
  label: "Comment MC-8fc3 on line 3, no answer",
  tone: "is-answered",
};
const ELSEWHERE: FileEditorCommentMarker = {
  line: 5,
  label: "Comment MC-21aa on line 5, sent",
  tone: "is-queued",
};

test("a state change repaints the same button, and its click reaches the widget drawn now", () => {
  const selected: string[] = [];
  const before = new CommentMarkerWidget(SENT, (line) => selected.push(`before:${line}`));
  const after = new CommentMarkerWidget(NO_ANSWER, (line) => selected.push(`after:${line}`));
  const button = drawn(before);

  assert.equal(update(after, button, before), true, "same line: reuse the button");
  assert.equal(button.attributes.get("aria-label"), NO_ANSWER.label);
  assert.equal(button.className, `cm-file-comment-marker ${NO_ANSWER.tone}`);

  // The listener was attached by `before`; the click must still go to `after`.
  button.click();
  assert.deepEqual(selected, ["after:3"]);
});

test("a different line refuses the button, so CodeMirror draws a new one", () => {
  const selected: string[] = [];
  const onLine3 = new CommentMarkerWidget(SENT, (line) => selected.push(`line3:${line}`));
  const onLine5 = new CommentMarkerWidget(ELSEWHERE, (line) => selected.push(`line5:${line}`));
  const button = drawn(onLine3);

  assert.equal(update(onLine5, button, onLine3), false, "another line: rebuild");
  // Refused untouched: the button still names, and still opens, the comment it was drawn for.
  assert.equal(button.attributes.get("aria-label"), SENT.label);
  assert.equal(button.className, `cm-file-comment-marker ${SENT.tone}`);
  button.click();
  assert.deepEqual(selected, ["line3:3"]);
});
