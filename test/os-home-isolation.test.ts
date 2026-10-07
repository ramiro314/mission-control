import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { osHomeEnv } from "./helpers/os-home.ts";

// `os.homedir()` reads `HOME` on macOS and Linux and `USERPROFILE` on win32. A fixture that
// isolates the operator's home by setting `HOME` alone isolates nothing on Windows: the
// daemon and the code under test resolve the runner's real profile, which is how two unit
// files and fifteen e2e specs failed on the first Windows run. Every test that moves the
// home goes through `osHomeEnv`, and this file refuses one that does not.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCANNED = ["test", "e2e"];
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;

/**
 * Files that write a `HOME` key as plain data handed to the code under test, never into a
 * process environment, so there is no `os.homedir()` for it to move.
 */
const DATA_ONLY: Readonly<Record<string, string>> = {
  "test/executable-environment.test.ts": "an injected env for executable-search planning",
  "test/open-target-contract.test.ts": "an injected env for browser launch planning",
  "test/workflow-check-env.test.ts": "an input to scrubCheckEnv, compared as data",
  "test/os-home-isolation.test.ts": "this file's matcher cases",
};

/**
 * A `HOME` that reaches an environment: an object key (`HOME: x`, `{ HOME }`) or an
 * assignment (`env.HOME = x`, `env["HOME"] = x`). `MISSION_HOME` and the other prefixed
 * names are a different setting and do not match, and neither does a `${HOME}` template.
 */
const HOME_WRITE =
  /(?<![\w$.])HOME\s*:(?!:)|(?<!\$)[{,]\s*HOME\s*(?=[,}])|\benv\.HOME\s*=(?!=)|\benv\[\s*["']HOME["']\s*\]\s*=(?!=)/;

/** A line moves `HOME` without moving `USERPROFILE` with it. */
function setsHomeAlone(line: string): boolean {
  const code = line.trim();
  if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return false;
  return HOME_WRITE.test(line) && !/USERPROFILE|osHomeEnv\(/.test(line);
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (SOURCE.test(entry.name)) yield path;
  }
}

test("the matcher sees every way a test writes HOME, and only HOME", () => {
  for (const line of [
    "  HOME: home,",
    "const env = { ...process.env, HOME: jail };",
    "spawn(bin, { env: { HOME } });",
    "process.env.HOME = decoy;",
    'env["HOME"] = home;',
  ]) {
    assert.equal(setsHomeAlone(line), true, line);
  }
  for (const line of [
    "  ...osHomeEnv(home),",
    "process.env.HOME = process.env.USERPROFILE = decoy;",
    "  MISSION_HOME: state,",
    "  XDG_DATA_HOME: xdg,",
    "evidence: `${HOME}/.local/bin/claude`,",
    "if (process.env.HOME === home) return;",
    "  // HOME: the OS home, not the state dir",
  ]) {
    assert.equal(setsHomeAlone(line), false, line);
  }
});

test("no test or e2e fixture isolates the home through HOME alone", () => {
  const offenders: string[] = [];
  for (const dir of SCANNED) {
    for (const path of sourceFiles(join(REPO_ROOT, dir))) {
      const file = relative(REPO_ROOT, path).split("\\").join("/");
      if (file in DATA_ONLY) continue;
      readFileSync(path, "utf8").split("\n").forEach((line, index) => {
        if (setsHomeAlone(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Set the home with `...osHomeEnv(home)` from test/helpers/os-home.ts, so win32's " +
      "USERPROFILE moves with HOME. A file that only hands HOME to code as data belongs in DATA_ONLY.",
  );
});

test("a child given osHomeEnv resolves os.homedir() to that home on this platform", () => {
  const home = mkdtempSync(join(tmpdir(), "mission-os-home-"));
  try {
    const resolved = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", 'process.stdout.write((await import("node:os")).homedir())'],
      { env: { ...process.env, ...osHomeEnv(home) }, encoding: "utf8" },
    );
    assert.equal(resolved, home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
