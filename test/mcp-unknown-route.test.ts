import assert from "node:assert/strict";
import test from "node:test";

import { isUnknownRoute } from "../src/mcp/unknown-route.ts";

// The MCP bridge tells "this daemon does not know the route" (update it) apart from "the route
// ran and a task or session was missing" (relay the daemon's own error). Getting it backwards
// would report every real "no such task to adopt" as a stale daemon.

test("a 404 carrying a JSON error is the route's own answer, and its body stays readable", async () => {
  const res = new Response(JSON.stringify({ error: "no such task to adopt" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
  assert.equal(await isUnknownRoute(res), false);
  assert.equal(await res.text(), JSON.stringify({ error: "no such task to adopt" }));
});

test("a plain or bodiless 404 is a route this daemon does not know", async () => {
  assert.equal(await isUnknownRoute(new Response("404 Not Found", { status: 404 })), true);
  assert.equal(await isUnknownRoute(new Response(null, { status: 404 })), true);
  assert.equal(await isUnknownRoute(new Response(JSON.stringify({ message: "x" }), { status: 404 })), true);
});

test("anything but a 404 is never an unknown route", async () => {
  assert.equal(await isUnknownRoute(new Response("nope", { status: 409 })), false);
  assert.equal(await isUnknownRoute(new Response("{}", { status: 200 })), false);
});
