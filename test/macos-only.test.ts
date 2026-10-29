import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { MACOS_ONLY_MESSAGE, macOSOnlyRefusal } from "../src/shared/macos-only.mjs";

const root = resolve(import.meta.dirname, "..");

/** Run a script as if on `platform`, so both branches are exercised on any test host. */
function runAs(platform: string, script: string, args: string[] = []) {
  const preload = `data:text/javascript,Object.defineProperty(process,"platform",{value:${JSON.stringify(platform)}})`;
  return spawnSync(process.execPath, ["--import", preload, join(root, script), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("packaged-app commands refuse every platform but macOS with the one message", () => {
  assert.equal(macOSOnlyRefusal("darwin"), null);
  assert.equal(macOSOnlyRefusal("linux"), MACOS_ONLY_MESSAGE);
  assert.equal(
    MACOS_ONLY_MESSAGE,
    "The packaged app is macOS only; on Linux run from a checkout (see docs/setup.md).",
  );
});

test("both bootstrap installers carry the shared message word for word", () => {
  // They run before any checkout exists, so they cannot import the module and hold a copy.
  // install.sh is generated from install-bootstrap.sh, so the template carries it too.
  for (const script of ["scripts/install.sh", "scripts/install-bootstrap.sh", "scripts/install-source.sh"]) {
    const shell = readFileSync(join(root, script), "utf8");
    assert.ok(shell.includes(`echo "${MACOS_ONLY_MESSAGE}" >&2`), script);
  }
});

test("npm run package refuses before it builds anything", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.match(pkg.scripts.package, /^node scripts\/require-macos\.mjs && npm run build && /);

  const linux = runAs("linux", "scripts/require-macos.mjs");
  assert.equal(linux.status, 1);
  assert.equal(linux.stderr.trim(), MACOS_ONLY_MESSAGE);
  const mac = runAs("darwin", "scripts/require-macos.mjs");
  assert.equal(mac.status, 0, mac.stderr);
  assert.equal(mac.stderr, "");
});

test("make install refuses off macOS before any installer step, and keeps its help", () => {
  const linux = runAs("linux", "scripts/install-app.mjs", ["--dry-run"]);
  assert.equal(linux.status, 1);
  assert.equal(linux.stdout, "", "no installer step ran");
  assert.equal(linux.stderr.trim(), MACOS_ONLY_MESSAGE);
  const help = runAs("linux", "scripts/install-app.mjs", ["--help"]);
  assert.equal(help.status, 0);
});

test("recover-database refuses off macOS before it builds or reads its arguments", () => {
  // `npm run recover:database` builds the state-lock addon in its pre hook, so the guard runs first.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.match(pkg.scripts["prerecover:database"], /^node scripts\/require-macos\.mjs && /);

  const linux = runAs("linux", "scripts/recover-database.mjs");
  assert.equal(linux.status, 1);
  assert.equal(linux.stderr.trim(), MACOS_ONLY_MESSAGE);
  // On macOS the same empty invocation reaches argument parsing, as it always has.
  const mac = runAs("darwin", "scripts/recover-database.mjs");
  assert.ok(!mac.stderr.includes(MACOS_ONLY_MESSAGE), mac.stderr);
  assert.match(mac.stderr, /Usage:/);
});

test("make help marks the packaged-app targets [macOS] and nothing else", () => {
  const help = spawnSync("make", ["--no-print-directory", "-s", "help"], { cwd: root, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  // Strip the colour codes the help target prints around each name.
  const lines = stripVTControlCharacters(help.stdout).split("\n");
  const marked = lines
    .filter((line) => line.includes("[macOS]"))
    .map((line) => line.trim().split(/\s+/)[0])
    .sort();
  assert.deepEqual(marked, ["app", "install", "install-app"]);
});
