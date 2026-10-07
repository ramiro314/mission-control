import { test } from "node:test";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { claudeProjectDir } from "../src/server/harness/claude/project-dir.ts";

// Every expected name here is what Claude Code's own encoder returned for the same cwd, read
// out of `@anthropic-ai/claude-agent-sdk` 0.3.283 (`vc`, shared with the bundled CLI). They are
// literals on purpose: a test that re-derived them would agree with any rule at all.

const name = (cwd: string): string => basename(claudeProjectDir(cwd, "/projects"));

test("a win32 cwd encodes its drive colon and backslashes, the way Claude does", () => {
  assert.equal(name("C:\\Users\\me\\work\\app"), "C--Users-me-work-app");
  assert.equal(name("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp"), "C--Users-RUNNER-1-AppData-Local-Temp");
  assert.equal(name("\\\\server\\share\\repo"), "--server-share-repo");
});

test("the name is one directory under the projects root, never a nested path", () => {
  // The bug this replaced: the old rule kept `C:` and `\`, so the join below named
  // `projects\C:\Users\…`, a directory no transcript is in and NTFS will not create.
  assert.equal(claudeProjectDir("C:\\Users\\me\\app", "/projects"), join("/projects", "C--Users-me-app"));
});

test("a POSIX cwd of letters, digits, dots and slashes encodes as it always did", () => {
  assert.equal(name("/Users/me/.treehouse/x/4/app"), "-Users-me--treehouse-x-4-app");
  assert.equal(name("/private/var/folders/ab/T"), "-private-var-folders-ab-T");
});

test("every other non-alphanumeric character becomes a dash too", () => {
  assert.equal(name("/Users/me/my_app v2"), "-Users-me-my-app-v2");
});

test("a name past 200 characters is cut and suffixed with Claude's hash of the cwd", () => {
  const long = "/" + "deep/".repeat(60) + "app";
  const encoded = long.replace(/[^a-zA-Z0-9]/g, "-");
  assert.equal(name(long), `${encoded.slice(0, 200)}-flo65q`);

  // Hashed over UTF-16 code units of the unencoded cwd, so two cwds that encode alike past
  // the cut still get their own directory.
  const unicode = "C:\\" + "Ünïcode\\".repeat(30);
  assert.equal(name(unicode), `${unicode.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200)}-k0vt35`);
});
