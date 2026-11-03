import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * `history_changed`'s two ends, on `archive-events.test.ts`'s model. Typecheck already fails
 * when the hook's switch misses a `ServerEvent` variant; what it cannot see is a counter
 * bumped on the event but not on reconnect, which leaves an open History page on whatever it
 * showed before the stream dropped, since the catalog rides no snapshot.
 */

const hook = readFileSync(new URL("../src/web/useEventStream.ts", import.meta.url), "utf8");
const types = readFileSync(new URL("../src/shared/types.ts", import.meta.url), "utf8");
const registry = readFileSync(new URL("../src/server/registry.ts", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/web/App.tsx", import.meta.url), "utf8");

test("history_changed is on the wire and carries no rows", () => {
  assert.match(types, /\|\s*\{\s*type:\s*"history_changed"\s*\}/);
  assert.match(registry, /emitHistoryChanged\(\): void \{\s*\n\s*this\.emitEvent\(\{ type: "history_changed" \}\);/);
});

test("the browser bumps a revision on the event AND on reconnect, and hands it to the History page", () => {
  assert.match(hook, /case "history_changed":\s*\n\s*setHistoryRevision\(\(n\) => n \+ 1\);/);
  const onOpen = hook.slice(hook.indexOf("es.onopen"), hook.indexOf("es.onerror"));
  assert.match(onOpen, /setHistoryRevision\(\(n\) => n \+ 1\);/, "regaining the stream must re-read");
  assert.match(hook, /\n    historyRevision,\n/);
  assert.match(app, /<HistoryPage\s[^>]*revision=\{historyRevision\}[^>]*\/>/);
});
