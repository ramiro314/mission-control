import assert from "node:assert/strict";
import test from "node:test";
import { cwdAllowlisted } from "../src/shared/allowlist.ts";
import {
  isAbsoluteNativePath,
  pathWithin,
  stripTrailingSeparator,
  subpathWithin,
} from "../src/shared/native-path.ts";
import { PersonaSourcePathSchema } from "../src/shared/protocol.ts";
import { resolveStandingInstructions } from "../src/shared/standing-instructions.ts";
import { checkCommandRoot, checkCommandSubpath } from "../src/shared/workflow.ts";

// The browser-safe path rules in `src/shared/native-path.ts`: win32 paths (`C:\...`, UNC) are
// absolute and contain their children there, and every POSIX answer is what it was before.

test("a POSIX path is absolute on every platform, a drive path only on win32", () => {
  assert.equal(isAbsoluteNativePath("/Users/ramiro", "darwin"), true);
  assert.equal(isAbsoluteNativePath("/Users/ramiro", "win32"), true);
  assert.equal(isAbsoluteNativePath("C:\\Users\\Ramiro", "win32"), true);
  assert.equal(isAbsoluteNativePath("C:/Users/Ramiro", "win32"), true);
  assert.equal(isAbsoluteNativePath("\\\\server\\share\\repo", "win32"), true);
  // On macOS a drive path is relative, which is what the OS would make of it.
  assert.equal(isAbsoluteNativePath("C:\\Users\\Ramiro", "darwin"), false);
  assert.equal(isAbsoluteNativePath("relative\\dir", "win32"), false);
  assert.equal(isAbsoluteNativePath("C:relative", "win32"), false);
  assert.equal(isAbsoluteNativePath("", "win32"), false);
});

test("containment matches whole components in both spellings", () => {
  assert.equal(subpathWithin("C:\\code\\mono\\packages\\web", "C:\\code\\mono"), "packages/web");
  assert.equal(subpathWithin("C:\\code\\mono\\", "C:\\code\\mono"), "");
  assert.equal(subpathWithin("C:\\code\\mono-backup", "C:\\code\\mono"), null);
  assert.equal(subpathWithin("D:\\code\\mono\\web", "C:\\code\\mono"), null);
  assert.equal(subpathWithin("/repo/packages/web", "/repo"), "packages/web");
  assert.equal(subpathWithin("/repo-backup", "/repo"), null);
  assert.equal(pathWithin("packages/web/src", "packages/web"), true);
});

test("a win32 path compares case-insensitively, as NTFS does, and keeps its own spelling", () => {
  assert.equal(subpathWithin("c:\\code\\mono\\Web", "C:\\code\\mono"), "Web");
  assert.equal(subpathWithin("C:\\Code\\Mono", "c:\\code\\mono\\"), "");
  assert.equal(subpathWithin("c:\\code\\mono-backup", "C:\\code\\mono"), null);
  assert.equal(cwdAllowlisted("c:\\code\\mono\\packages\\web", ["C:\\Code"]), true);
  assert.equal(checkCommandSubpath("C:\\code\\mono", "c:\\code\\mono\\Packages\\Web"), "Packages/Web");
});

test("a win32 path spelled with either separator is the same path", () => {
  // Git reports a toplevel as `C:/...` beside a native `C:\...` cwd.
  assert.equal(subpathWithin("C:/code/mono/web/app.ts", "C:\\code\\mono"), "web/app.ts");
  assert.equal(subpathWithin("C:\\code\\mono\\web", "c:/Code/Mono"), "web");
  assert.equal(subpathWithin("C:/code/mono", "C:\\code\\mono\\"), "");
  assert.equal(subpathWithin("C:/code/mono-backup", "C:\\code\\mono"), null);
});

test("a POSIX path stays case-sensitive", () => {
  assert.equal(pathWithin("/Repo/web", "/repo"), false);
  assert.equal(pathWithin("/repo", "/Repo"), false);
  assert.equal(pathWithin("//x", "/"), true);
  assert.equal(pathWithin("/x", "/"), false);
});

test("a backslash in a POSIX path is still a filename character", () => {
  assert.equal(pathWithin("/repo\\sub", "/repo"), false);
  assert.equal(stripTrailingSeparator("/repo\\"), "/repo\\");
});

test("a bare root keeps its separator", () => {
  assert.equal(stripTrailingSeparator("/"), "/");
  assert.equal(stripTrailingSeparator("C:\\"), "C:\\");
  assert.equal(stripTrailingSeparator("C:\\code\\"), "C:\\code");
  assert.equal(stripTrailingSeparator("/repo/"), "/repo");
});

test("an allowlisted win32 folder covers the repositories beneath it", () => {
  assert.equal(cwdAllowlisted("C:\\code\\mono\\packages\\web", ["C:\\code"]), true);
  assert.equal(cwdAllowlisted("C:\\code-old\\repo", ["C:\\code"]), false);
  assert.equal(cwdAllowlisted("/Users/ramiro/code/repo", ["/Users/ramiro/code"]), true);
});

test("standing instructions keyed on a win32 package apply inside it", () => {
  const resolved = resolveStandingInstructions(
    {
      default: "",
      repositories: { "C:\\code\\mono": "repo", "C:\\code\\mono\\packages\\api": "package" },
    },
    "C:\\code\\mono\\packages\\api\\src",
  );
  assert.equal(resolved.matchedKey, "C:\\code\\mono\\packages\\api");
});

test("a nested win32 check-command entry resolves to a git-style subpath", () => {
  assert.equal(checkCommandSubpath("C:\\code\\mono", "C:\\code\\mono\\packages\\web"), "packages/web");
  assert.equal(checkCommandSubpath("C:\\code\\mono", "C:\\code\\mono-backup"), "");
  assert.equal(
    checkCommandRoot("C:\\code\\mono", "C:\\code\\mono\\packages\\web\\"),
    "C:\\code\\mono\\packages\\web",
  );
});

test("a persona source path is judged absolute by the daemon's own platform", () => {
  assert.equal(PersonaSourcePathSchema.safeParse("/Users/ramiro/persona.md").success, true);
  assert.equal(
    PersonaSourcePathSchema.safeParse("C:\\Users\\Ramiro\\persona.md").success,
    process.platform === "win32",
  );
});
