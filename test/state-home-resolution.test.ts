import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveStateDir } from "../src/shared/harness-runtime.mjs";

// Where the daemon keeps its state on each platform (D22 in
// `docs/plans/windows-support/plan.md`): `~/.mission-control` on macOS and Linux, and
// `%USERPROFILE%\.mission-control` on win32, with the same layout under it.

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

// `override: ""` stands for "no MISSION_HOME": the test preload sets one for this process.
const NO_OVERRIDE = "";

test("win32 resolves the state home under %USERPROFILE%", () => {
  const resolved = resolveStateDir({
    override: NO_OVERRIDE,
    home: "C:\\Users\\Ramiro",
    exists: () => false,
    pathApi: path.win32,
  });
  assert.equal(resolved, "C:\\Users\\Ramiro\\.mission-control");
});

test("win32 keeps an older state dir where it lies, as macOS does", () => {
  const resolved = resolveStateDir({
    override: NO_OVERRIDE,
    home: "C:\\Users\\Ramiro",
    exists: (p) => p === "C:\\Users\\Ramiro\\.fleet-control",
    pathApi: path.win32,
  });
  assert.equal(resolved, "C:\\Users\\Ramiro\\.fleet-control");
});

test("macOS still resolves the state home under $HOME", () => {
  const resolved = resolveStateDir({
    override: NO_OVERRIDE,
    home: "/Users/ramiro",
    exists: () => false,
    pathApi: path.posix,
  });
  assert.equal(resolved, "/Users/ramiro/.mission-control");
});

test("an explicit MISSION_HOME wins on every platform", () => {
  const resolved = resolveStateDir({
    override: "D:\\state",
    home: "C:\\Users\\Ramiro",
    exists: () => true,
    pathApi: path.win32,
  });
  assert.equal(resolved, "D:\\state");
});

test("the daemon creates and opens its database under the platform's home", (t) => {
  // A real child with no home override, so `os.homedir()` decides. HOME and USERPROFILE name
  // different directories, which is what tells the two platforms apart: Node reads
  // USERPROFILE on win32 and HOME everywhere else. On the Windows runner this is the win32
  // case end to end; on macOS and Linux it pins that USERPROFILE changes nothing.
  const posixHome = mkdtempSync(join(tmpdir(), "mission-home-posix-"));
  const userProfile = mkdtempSync(join(tmpdir(), "mission-home-win32-"));
  t.after(() => {
    rmSync(posixHome, { recursive: true, force: true });
    rmSync(userProfile, { recursive: true, force: true });
  });
  const db = pathToFileURL(join(repo, "src/server/db.ts")).href;
  const code = `const { openDb } = await import(${JSON.stringify(db)});
const { DB_PATH } = await import(${JSON.stringify(pathToFileURL(join(repo, "src/server/config.ts")).href)});
openDb().close();
process.stdout.write(DB_PATH);`;
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: posixHome, USERPROFILE: userProfile };
  // Windows processes expect SystemRoot; without it some system calls fail before ours run.
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const dbPath = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
    cwd: repo,
    env,
    encoding: "utf8",
  }).trim();

  const home = process.platform === "win32" ? userProfile : posixHome;
  // Printed so a run's output says which platform's case it proved, and from which variable.
  t.diagnostic(`platform=${process.platform} home=${process.platform === "win32" ? "USERPROFILE" : "HOME"} db=${dbPath}`);
  assert.equal(dbPath, join(home, ".mission-control", "harness.db"));
  assert.ok(existsSync(dbPath), "the database was created there");
});
