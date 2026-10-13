import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What the sweep deletes once the headless dir is encoded the way Claude encodes it.
//
// With the old `[/.]` rule, a temp dir containing `_`, `+` or a space named a directory Claude
// never writes, so the sweep found nothing and deleted nothing. Now it reaches Claude's real
// directory, so this pins exactly what one sweep removes there and what it leaves alone.
//
// `HEADLESS_CWD` is fixed at import - `tmpdir()` on macOS, `<state dir>/headless` on Linux -
// and the projects root is `~/.claude/projects` at import, so all three are redirected here,
// before the modules load, each through a name Claude's encoding rewrites.

const base = mkdtempSync(join(tmpdir(), "prune-encoding-"));
const tmpRedirect = join(base, "mc_tmp+x y");
const stateRedirect = join(base, "mc_state+x y");
const home = join(base, "home");
mkdirSync(tmpRedirect, { recursive: true });
mkdirSync(home, { recursive: true });
process.env.TMPDIR = tmpRedirect;
process.env.HARNESS_HOME = stateRedirect;
process.env.HOME = home;
after(() => rmSync(base, { recursive: true, force: true }));

const { HEADLESS_CWD, ensureHeadlessCwd, headlessCwdFor } = await import("../src/server/headless-cwd.ts");
const { headlessTranscriptDir, pruneHeadlessTranscripts } = await import("../src/server/goal/prune.ts");
const { CLAUDE_PROJECTS_DIR, claudeProjectDir } = await import("../src/server/harness/claude/project-dir.ts");

const DAY = 24 * 60 * 60 * 1000;

/** Write a file with a given age. */
function seed(dir: string, name: string, ageMs: number): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, '{"type":"user"}\n');
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(p, t, t);
  return p;
}

test("one sweep removes exactly the old transcript in Claude's encoded directory", () => {
  assert.equal(
    HEADLESS_CWD,
    headlessCwdFor(process.platform, stateRedirect, tmpRedirect),
    "the redirect did not reach HEADLESS_CWD",
  );
  ensureHeadlessCwd();
  assert.equal(CLAUDE_PROJECTS_DIR, join(home, ".claude", "projects"));

  const realCwd = realpathSync(HEADLESS_CWD);
  const swept = headlessTranscriptDir();
  assert.equal(swept, claudeProjectDir(realCwd));
  assert.doesNotMatch(swept, /[_+ ]/, "the encoded name kept a character Claude replaces");

  const old = seed(swept, "old.jsonl", 3 * DAY);
  const fresh = seed(swept, "fresh.jsonl", 60_000);
  const notes = seed(swept, "notes.txt", 3 * DAY);

  // The directory the old `[/.]` rule named, and one for a cwd that does not encode the same.
  const buggy = join(CLAUDE_PROJECTS_DIR, realCwd.replace(/[/.]/g, "-"));
  const other = claudeProjectDir(join(base, "elsewhere"));
  assert.notEqual(buggy, swept);
  assert.notEqual(other, swept);
  const buggyOld = seed(buggy, "old.jsonl", 3 * DAY);
  const otherOld = seed(other, "old.jsonl", 3 * DAY);

  assert.equal(pruneHeadlessTranscripts(), 1);
  assert.equal(existsSync(old), false, "the old headless transcript survived");
  assert.equal(existsSync(fresh), true, "a fresh transcript was deleted");
  assert.equal(existsSync(notes), true, "a non-JSONL file was deleted");
  assert.equal(existsSync(buggyOld), true, "the sweep reached the old rule's directory");
  assert.equal(existsSync(otherOld), true, "the sweep reached a neighbouring project directory");
});
