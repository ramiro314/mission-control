import assert from "node:assert/strict";
import test from "node:test";

import { setDaemonHome, shortenCwd } from "../src/web/lib/format.ts";

test("shortenCwd writes the daemon's home as ~ on both home shapes", () => {
  for (const home of ["/Users/jo", "/home/jo"]) {
    assert.equal(shortenCwd(`${home}/src/api`, home), "~/src/api");
    assert.equal(shortenCwd(home, home), "~");
    // A sibling that merely shares the prefix is someone else's directory.
    assert.equal(shortenCwd(`${home}rdan/src`, home), `${home}rdan/src`);
  }
});

test("shortenCwd leaves another account's home and an unknown home in full", () => {
  // The old `/Users/<anyone>` pattern rewrote a path on a Linux daemon that is not under its home.
  assert.equal(shortenCwd("/Users/someone/src", "/home/jo"), "/Users/someone/src");
  assert.equal(shortenCwd("/home/someone/src", "/Users/jo"), "/home/someone/src");
  assert.equal(shortenCwd("/home/jo/src", ""), "/home/jo/src");
  assert.equal(shortenCwd(null, "/home/jo"), "-");
});

test("shortenCwd defaults to the home the daemon's snapshot named", () => {
  setDaemonHome("/home/jo");
  try {
    assert.equal(shortenCwd("/home/jo/work/repo"), "~/work/repo");
  } finally {
    setDaemonHome("");
  }
  assert.equal(shortenCwd("/home/jo/work/repo"), "/home/jo/work/repo");
});
