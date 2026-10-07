import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * The one way a unit test runs one of the repository's bash scripts: the way a GitHub Actions
 * `run:` step does, `bash -eo pipefail <file>`, under the bash CI uses on that platform.
 *
 * On macOS and Linux that is `/bin/bash`. It is bash 3.2 on macOS, so a local run also proves
 * a script never reaches for a newer bash.
 *
 * Windows has no `/bin/bash`. Its scripts run under Git Bash, npm's `script-shell`, which every
 * Windows job sets through `npm_config_script_shell` and a Windows developer sets with
 * `npm config set script-shell` (D30 in `docs/plans/windows-support/plan.md`), and `bash` from
 * PATH stands in when it is unset. Git for Windows' `bin\bash.exe` is a launcher that puts Git's
 * own `mingw64\bin` and `usr\bin` ahead of PATH, where `mingw64\bin\git.exe` would shadow a stub
 * `git` a test puts first, so `usr\bin\bash.exe` beside it, the same bash without the launcher,
 * is used when it exists.
 */
export function scriptBash(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform !== "win32") return "/bin/bash";
  const shell = env.npm_config_script_shell?.trim();
  if (!shell) return "bash";
  const bin = win32.dirname(shell);
  if (win32.basename(bin).toLowerCase() === "bin") {
    const bash = win32.join(win32.dirname(bin), "usr", "bin", "bash.exe");
    if (exists(bash)) return bash;
  }
  return shell;
}

/**
 * The environment a script runs with: `env`, and `PATH` with `stubs` first. Nothing else of
 * the test process's own environment reaches the script, except on Windows the variables a
 * process there needs to start at all, and the temporary directory `mktemp` writes to.
 */
export function scriptEnv(
  stubs: string,
  env: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const join = platform === "win32" ? win32.delimiter : posix.delimiter;
  const windows: Record<string, string> = {};
  if (platform === "win32") {
    for (const name of ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
      const value = base[name];
      if (value) windows[name] = value;
    }
  }
  return { ...windows, PATH: `${stubs}${join}${base.PATH ?? ""}`, ...env };
}

/** Run `script` with `args` as CI does, with `stubs` first on PATH and only `env` set. */
export function runBashScript(
  script: string,
  args: readonly string[],
  stubs: string,
  env: Record<string, string>,
) {
  return spawnSync(scriptBash(), ["-eo", "pipefail", script, ...args], {
    encoding: "utf8",
    env: scriptEnv(stubs, env),
  });
}
