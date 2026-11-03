import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationMessages } from "../src/web/components/TranscriptPanel.tsx";
import { transcriptRows } from "../src/web/lib/tools.ts";
import type { TranscriptMessage } from "../src/shared/types.ts";

/**
 * The live view's message rendering, extracted so History's read-only reader draws a
 * transcript read from disk exactly as the live panel draws a streamed one. It takes rows
 * built from messages, never a session.
 */

const messages: TranscriptMessage[] = [
  { id: "u1", role: "user", text: "Why is the build red?", tools: [], ts: Date.UTC(2026, 9, 20, 10, 0) },
  { id: "a1", role: "assistant", text: "", tools: [{ name: "Bash", input: "npm test" }], ts: Date.UTC(2026, 9, 20, 10, 1) },
  { id: "a2", role: "assistant", text: "", tools: [{ name: "Read", input: "src/x.ts" }], ts: Date.UTC(2026, 9, 20, 10, 2) },
  { id: "a3", role: "assistant", text: "A missing import in src/x.ts.", tools: [], ts: Date.UTC(2026, 9, 20, 10, 3) },
];

function render(terminal: boolean): string {
  return renderToStaticMarkup(createElement(ConversationMessages, {
    rows: transcriptRows(messages),
    agentLabel: "claude",
    terminal,
    sessionId: "history:claude:00000000-0000-4000-8000-000000000001",
    cwd: "~/work",
    fullCwd: "/home/me/work",
  }));
}

test("renders a message list from messages alone: turns in order, tool-only turns folded into one run", () => {
  const html = render(false);
  const question = html.indexOf("Why is the build red?");
  const run = html.indexOf("turn-toolrun");
  const answer = html.indexOf("A missing import in src/x.ts.");
  assert.ok(question >= 0 && run > question && answer > run, "user turn, then the folded tool run, then the reply");
  assert.equal(html.match(/turn-toolrun/g)?.length, 1, "two tool-only turns fold into one run");
  assert.match(html, /claude executed/);
  assert.equal(html.match(/<article /g)?.length, 2, "one article per prose turn");
  assert.doesNotMatch(html, /<textarea/, "the message list carries no composer");
});

test("the terminal rendering draws the same rows as terminal traffic", () => {
  const html = render(true);
  assert.ok(html.includes("Why is the build red?"));
  assert.ok(html.includes("A missing import in src/x.ts."));
  assert.doesNotMatch(html, /turn-toolrun/, "the chat run's markup is not used");
});
