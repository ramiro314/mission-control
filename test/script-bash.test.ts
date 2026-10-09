import assert from "node:assert/strict";
import test from "node:test";
import { jqSkip, onScriptPath, scriptBash, scriptEnv } from "./helpers/script-bash.ts";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const MSYS_BASH = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";

test("macOS and Linux run scripts under /bin/bash, whatever npm's script-shell is", () => {
  for (const platform of ["darwin", "linux"] as const) {
    assert.equal(scriptBash({ npm_config_script_shell: GIT_BASH }, platform, () => true), "/bin/bash");
  }
});

test("win32 runs Git Bash's own bash, not the launcher that reorders PATH", () => {
  const seen: string[] = [];
  const exists = (path: string) => (seen.push(path), path === MSYS_BASH);
  assert.equal(scriptBash({ npm_config_script_shell: GIT_BASH }, "win32", exists), MSYS_BASH);
  assert.deepEqual(seen, [MSYS_BASH]);
});

test("win32 falls back to the script-shell as named, then to bash from PATH", () => {
  assert.equal(scriptBash({ npm_config_script_shell: GIT_BASH }, "win32", () => false), GIT_BASH);
  const other = "D:\\tools\\bash.exe";
  assert.equal(scriptBash({ npm_config_script_shell: other }, "win32", () => true), other);
  assert.equal(scriptBash({}, "win32", () => true), "bash");
  assert.equal(scriptBash({ npm_config_script_shell: " " }, "win32", () => true), "bash");
});

test("a script sees its stubs first on PATH and only the env it is given", () => {
  const base = { PATH: "/usr/bin:/bin", HOME: "/home/me", SYSTEMROOT: "C:\\Windows", TEMP: "C:\\Temp" };
  assert.deepEqual(scriptEnv("/stubs", { A: "1" }, base, "linux"), { PATH: "/stubs:/usr/bin:/bin", A: "1" });
  const windows = { ...base, PATH: "C:\\Git\\usr\\bin;C:\\Windows" };
  assert.deepEqual(scriptEnv("D:\\stubs", { A: "1" }, windows, "win32"), {
    SYSTEMROOT: "C:\\Windows",
    TEMP: "C:\\Temp",
    PATH: "D:\\stubs;C:\\Git\\usr\\bin;C:\\Windows",
    A: "1",
  });
});

test("a command is on the script's PATH only when that bash resolves it", () => {
  assert.equal(onScriptPath("cd"), true);
  assert.equal(onScriptPath("mission-control-no-such-command"), false);
});

test("a missing jq skips locally with how to install it, and is an error on CI", () => {
  assert.equal(jqSkip(() => true, {}), false);
  assert.equal(jqSkip(() => true, { CI: "true" }), false);
  assert.match(String(jqSkip(() => false, {})), /^jq is not installed: install it \(brew install jq, winget install jqlang\.jq\)/);
  assert.throws(() => jqSkip(() => false, { CI: "true" }), /jq is not on PATH: .* every CI runner must provide it/);
});
