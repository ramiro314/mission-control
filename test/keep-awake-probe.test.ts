import assert from "node:assert/strict";
import test from "node:test";

import { keepAwakeObserver, powercfgSections } from "../scripts/probe-keep-awake-native.mjs";

const REASON = "Mission Control native Keep Awake verification 4242";

/** `powercfg /requests` as Windows prints it, CRLF and all, with one request in `section`. */
function powercfgListing(section: string): string {
  return ["DISPLAY", "SYSTEM", "AWAYMODE", "EXECUTION", "PERFMODE", "ACTIVELOCKSCREEN"]
    .map((name) =>
      name === section
        ? `${name}:\r\n[PROCESS] \\Device\\HarddiskVolume3\\hostedtoolcache\\node.exe\r\n${REASON}\r\n`
        : `${name}:\r\nNone.\r\n`,
    )
    .join("\r\n");
}

test("the probe verifies macOS and Windows, and refuses anywhere else by name", () => {
  assert.equal(keepAwakeObserver("darwin").command, "/usr/bin/pmset");
  assert.equal(keepAwakeObserver("win32").command, "powercfg");
  assert.throws(() => keepAwakeObserver("linux"), /requires macOS or Windows, not linux/);
  assert.throws(() => keepAwakeObserver("toString"), /not toString/);
});

test("on Windows only a SYSTEM request with the exact reason counts as held", () => {
  const { held } = keepAwakeObserver("win32");
  assert.equal(held(powercfgListing("SYSTEM"), REASON), true);
  // A display request would keep the screen on, which Keep Awake promises never to do.
  assert.equal(held(powercfgListing("DISPLAY"), REASON), false);
  assert.equal(held(powercfgListing("SYSTEM"), `${REASON}0`), false);
  assert.equal(held(powercfgListing("NONE"), REASON), false);
});

test("powercfg output splits into its request-type blocks", () => {
  const sections = powercfgSections(powercfgListing("SYSTEM"));
  assert.deepEqual([...sections.keys()], [
    "DISPLAY", "SYSTEM", "AWAYMODE", "EXECUTION", "PERFMODE", "ACTIVELOCKSCREEN",
  ]);
  assert.match(sections.get("SYSTEM") ?? "", /node\.exe\n.*verification 4242/);
});

test("on macOS the probe still demands the idle-system-sleep assertion with its reason", () => {
  const { held } = keepAwakeObserver("darwin");
  const listing = `pid 4242(node): [0x1] 00:00:01 PreventUserIdleSystemSleep named: "${REASON}"`;
  assert.equal(held(listing, REASON), true);
  assert.equal(held(listing.replace("PreventUserIdleSystemSleep", "PreventUserIdleDisplaySleep"), REASON), false);
});
