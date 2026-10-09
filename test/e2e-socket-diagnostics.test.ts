import assert from "node:assert/strict";
import test from "node:test";

import {
  hostSocketSummary,
  summarizeWin32Sockets,
  withSocketDiagnostics,
} from "../e2e/fixtures/socket-diagnostics.ts";

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1204
  TCP    127.0.0.1:50001        127.0.0.1:7317         TIME_WAIT       0
  TCP    127.0.0.1:50002        127.0.0.1:7317         TIME_WAIT       0
  TCP    127.0.0.1:50003        127.0.0.1:61000        ESTABLISHED     4242
  TCP    127.0.0.1:50004        127.0.0.1:61000        ESTABLISHED     4242
  TCP    127.0.0.1:50005        127.0.0.1:61000        ESTABLISHED     4242
`;
const TASKLIST = `"System Idle Process","0","Services","0","8 K"
"svchost.exe","1204","Services","0","12,000 K"
"node.exe","4242","Console","1","80,000 K"`;

test("a win32 socket picture separates churn from a process holding sockets", () => {
  assert.equal(
    summarizeWin32Sockets(NETSTAT, TASKLIST, 2),
    "TCP sockets: 6 (ESTABLISHED 3, TIME_WAIT 2, LISTENING 1); most held by: node.exe (pid 4242) 3, System Idle Process (pid 0) 2",
  );
});

test("an owner tasklist cannot name is still counted", () => {
  assert.match(summarizeWin32Sockets(NETSTAT, "", 1), /most held by: \? \(pid 4242\) 3$/);
});

test("a network-layer navigation failure carries the socket picture; anything else is untouched", async () => {
  const refused = new Error("page.goto: net::ERR_NO_BUFFER_SPACE at http://127.0.0.1:1/#/fleet");
  const summary = () => "TCP sockets: 3 (TIME_WAIT 3); most held by: ? (pid 0) 3";
  await assert.rejects(withSocketDiagnostics(() => Promise.reject(refused), summary), (error: Error) =>
    error === refused && error.message.endsWith(`/#/fleet\n\n${summary()}`));
  const timeout = new Error("page.goto: Timeout 30000ms exceeded.");
  await assert.rejects(withSocketDiagnostics(() => Promise.reject(timeout), summary), (error: Error) =>
    error.message === "page.goto: Timeout 30000ms exceeded.");
  assert.equal(await withSocketDiagnostics(async () => "loaded", summary), "loaded");
});

test("this host's real socket picture can be read", { skip: process.platform !== "win32" }, () => {
  assert.match(hostSocketSummary(), /^TCP sockets: \d+ \(.*\); most held by: /);
});
