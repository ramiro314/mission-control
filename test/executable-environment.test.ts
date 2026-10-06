import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

import { executableSpec } from "../src/server/executables/catalog.ts";
import { ExecutableLocator, probeLoginShellPath } from "../src/server/executables/locator.ts";
import {
  executableEnvironmentFor,
  posixExecutableEnvironment,
  win32ExecutableEnvironment,
  windowsPowerShellPath,
} from "../src/server/platform/executable-environment.ts";
import { skipOnWin32 } from "./helpers/win32-skip.ts";

const HOME = "/fixture/home";
const POSIX_PLATFORMS = ["darwin", "linux"] as const;

/** The PATH read every POSIX platform ran before the table existed, byte for byte. */
const LOGIN_SHELL_ARGS = ["-ilc", `printf '__MISSION_PATH__%s__MISSION_PATH__' "$PATH"`];

async function ladder(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<Array<[string, string, string]>> {
  const locator = new ExecutableLocator({
    env: { HOME, ...env },
    platform,
    executable: () => false,
    probeLoginShell: async () => ({ path: "/login/bin:/usr/bin", problem: null }),
  });
  const snapshot = await locator.initialize();
  return snapshot.entries.map((entry) => [entry.directory, entry.source, entry.detail]);
}

test("win32 resolves to the win32 row, and every other platform to the POSIX row", () => {
  assert.equal(executableEnvironmentFor("win32"), win32ExecutableEnvironment);
  for (const platform of [...POSIX_PLATFORMS, "freebsd"] as const) {
    assert.equal(executableEnvironmentFor(platform), posixExecutableEnvironment, platform);
  }
});

/** The POSIX pins below lay paths out with the host's `node:path`, which on win32 rewrites them. */
const POSIX_HOST_PATHS = skipOnWin32("pins POSIX paths, which the win32 host's path rules rewrite to backslashes");

for (const platform of POSIX_PLATFORMS) {
  test(`${platform} keeps the search ladder's exact order and provenance`, { skip: POSIX_HOST_PATHS }, async () => {
    assert.deepEqual(
      await ladder(platform, {
        MISSION_EXECUTABLE_PATHS: "/operator/bin",
        PATH: "/inherited/bin:/repo/node_modules/.bin:/usr/bin",
        SHELL: "/bin/bash",
      }),
      [
        ["/operator/bin", "operator-directory", "MISSION_EXECUTABLE_PATHS"],
        [`${HOME}/.local/bin`, "version-manager", "supported per-user tool locations"],
        [`${HOME}/.local/share/mise/shims`, "version-manager", "supported per-user tool locations"],
        [`${HOME}/.asdf/shims`, "version-manager", "supported per-user tool locations"],
        [`${HOME}/.volta/bin`, "version-manager", "supported per-user tool locations"],
        [`${HOME}/go/bin`, "version-manager", "supported per-user tool locations"],
        ["/inherited/bin", "inherited-path", "PATH inherited by Mission Control"],
        ["/usr/bin", "inherited-path", "PATH inherited by Mission Control"],
        ["/login/bin", "login-shell", "/bin/bash"],
        ["/opt/homebrew/bin", "os-default", `${platform} supported defaults`],
        ["/opt/homebrew/sbin", "os-default", `${platform} supported defaults`],
        ["/usr/local/bin", "os-default", `${platform} supported defaults`],
        ["/bin", "os-default", `${platform} supported defaults`],
        ["/usr/sbin", "os-default", `${platform} supported defaults`],
        ["/sbin", "os-default", `${platform} supported defaults`],
        [
          "/repo/node_modules/.bin",
          "project-local",
          "project-local node_modules/.bin, ranked after every installation",
        ],
      ],
    );
  });

  test(`${platform} version-manager overrides relocate their rungs in place`, { skip: POSIX_HOST_PATHS }, async () => {
    const entries = await ladder(platform, {
      PATH: "",
      XDG_DATA_HOME: "/xdg",
      ASDF_DATA_DIR: "/asdf",
      VOLTA_HOME: "/volta",
    });
    assert.deepEqual(
      entries.filter(([, source]) => source === "version-manager").map(([directory]) => directory),
      [`${HOME}/.local/bin`, "/xdg/mise/shims", "/asdf/shims", "/volta/bin", `${HOME}/go/bin`],
    );
    const shims = await ladder(platform, { PATH: "", MISE_DATA_DIR: "/mise", XDG_DATA_HOME: "/xdg" });
    assert.equal(shims[1]?.[0], "/mise/shims");
    const explicit = await ladder(platform, { PATH: "", MISE_SHIMS_DIR: "/shims", MISE_DATA_DIR: "/mise" });
    assert.equal(explicit[1]?.[0], "/shims");
  });

  test(`${platform} checks the system then per-user application roots before PATH`, { skip: POSIX_HOST_PATHS }, () => {
    const candidates = executableSpec("wezterm").candidates({ env: {}, home: HOME, platform });
    assert.deepEqual(candidates, [
      "/Applications/WezTerm.app/Contents/MacOS/wezterm",
      `${HOME}/Applications/WezTerm.app/Contents/MacOS/wezterm`,
    ]);
  });

  test(`${platform} reads PATH through the same interactive login-shell command`, () => {
    const row = executableEnvironmentFor(platform);
    assert.deepEqual(row.loginShellPathRead({ SHELL: " /bin/bash " }), {
      command: "/bin/bash",
      args: LOGIN_SHELL_ARGS,
    });
    assert.deepEqual(row.loginShellPathRead({}), { command: "/bin/zsh", args: LOGIN_SHELL_ARGS });
  });
}

test("the login-shell probe spawns the table's command with the table's arguments", {
  skip: skipOnWin32("spawns a POSIX shebang script as the login shell, which win32 cannot execute"),
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-executable-environment-"));
  const shell = join(root, "shell");
  const argv = join(root, "argv");
  writeFileSync(
    shell,
    [
      `#!${process.execPath}`,
      `require("node:fs").writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)));`,
      `process.stdout.write("noise__MISSION_PATH__/probed/bin__MISSION_PATH__noise");`,
      "",
    ].join("\n"),
  );
  chmodSync(shell, 0o755);
  try {
    for (const platform of POSIX_PLATFORMS) {
      assert.deepEqual(await probeLoginShellPath({ SHELL: shell }, 10_000, platform), {
        path: "/probed/bin",
        problem: null,
      });
      assert.deepEqual(JSON.parse(readFileSync(argv, "utf8")), LOGIN_SHELL_ARGS, platform);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- win32 ----

const WIN_HOME = "C:\\Users\\Ramiro";
const WIN_ENV: NodeJS.ProcessEnv = {
  SystemRoot: "D:\\Windows",
  ProgramFiles: "D:\\Program Files",
  LOCALAPPDATA: "E:\\Local",
  APPDATA: "E:\\Roaming",
};
const POWERSHELL_FLAGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"];
const PRELUDE = "$ErrorActionPreference = 'Stop'\ntry { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}\n";

test("win32 ranks the per-user tool locations the Windows installers use", () => {
  assert.deepEqual(win32ExecutableEnvironment.userToolDirectories(WIN_HOME, WIN_ENV), [
    "C:\\Users\\Ramiro\\.local\\bin",
    "E:\\Roaming\\npm",
    "E:\\Local\\mise\\shims",
    "E:\\Local\\Volta\\bin",
  ]);
  assert.deepEqual(
    win32ExecutableEnvironment.userToolDirectories(WIN_HOME, { LOCALAPPDATA: "  ", APPDATA: "" }),
    [
      "C:\\Users\\Ramiro\\.local\\bin",
      "C:\\Users\\Ramiro\\AppData\\Roaming\\npm",
      "C:\\Users\\Ramiro\\AppData\\Local\\mise\\shims",
      "C:\\Users\\Ramiro\\AppData\\Local\\Volta\\bin",
    ],
    "an unset or blank profile folder falls back to its default under the home directory",
  );
  assert.deepEqual(
    win32ExecutableEnvironment.userToolDirectories(WIN_HOME, { ...WIN_ENV, MISE_DATA_DIR: "F:\\mise", VOLTA_HOME: "F:\\volta" }),
    ["C:\\Users\\Ramiro\\.local\\bin", "E:\\Roaming\\npm", "F:\\mise\\shims", "F:\\volta\\bin"],
  );
  assert.equal(
    win32ExecutableEnvironment.userToolDirectories(WIN_HOME, { MISE_SHIMS_DIR: "F:\\shims", MISE_DATA_DIR: "F:\\mise" })[2],
    "F:\\shims",
  );
});

test("win32 application roots are Program Files then the per-user Programs folder", () => {
  assert.deepEqual(win32ExecutableEnvironment.applicationDirectories(WIN_HOME, WIN_ENV), [
    "D:\\Program Files",
    "E:\\Local\\Programs",
  ]);
  assert.deepEqual(win32ExecutableEnvironment.applicationDirectories(WIN_HOME, {}), [
    "C:\\Program Files",
    "C:\\Users\\Ramiro\\AppData\\Local\\Programs",
  ]);
});

test("win32 OS defaults are System32, Windows, Windows PowerShell and Git for Windows' bin", () => {
  assert.deepEqual(win32ExecutableEnvironment.osDefaultDirectories(WIN_ENV), [
    "D:\\Windows\\System32",
    "D:\\Windows",
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    "D:\\Program Files\\Git\\bin",
  ]);
  assert.deepEqual(win32ExecutableEnvironment.osDefaultDirectories({}), [
    "C:\\Windows\\System32",
    "C:\\Windows",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    "C:\\Program Files\\Git\\bin",
  ]);
});

test("win32 looks a bare command up by each PATHEXT name, never as the extensionless file", () => {
  const names = (command: string, env: NodeJS.ProcessEnv = {}) =>
    win32ExecutableEnvironment.executableNames(command, env);
  assert.deepEqual(names("claude"), ["claude.com", "claude.exe", "claude.bat", "claude.cmd"]);
  assert.deepEqual(
    names("claude", { PATHEXT: " .EXE; .cmd;;.EXE;bogus;.a.b;.JS " }),
    ["claude.exe", "claude.cmd", "claude.js"],
    "trimmed, lowercased, deduplicated, and only well-formed extensions",
  );
  assert.deepEqual(names("claude.exe"), ["claude.exe"], "an extension already named is looked up as written");
  assert.deepEqual(names("Claude.EXE"), ["Claude.EXE"], "matched without regard to case, as Windows does");
  assert.deepEqual(names("conduct-ts"), ["conduct-ts.com", "conduct-ts.exe", "conduct-ts.bat", "conduct-ts.cmd"]);
  assert.deepEqual(posixExecutableEnvironment.executableNames("claude", { PATHEXT: ".EXE" }), ["claude"]);
});

test("the win32 locator returns claude.exe, ranks directories before extensions, and skips npm's shell script", async () => {
  const first = resolve("/fixture/first");
  const second = resolve("/fixture/second");
  const present = new Set([
    join(first, "claude"), // npm's POSIX shell script: present, and never chosen on win32
    join(second, "claude.exe"),
    join(first, "gh.cmd"),
    join(second, "gh.exe"),
  ]);
  const locator = (platform: NodeJS.Platform) => new ExecutableLocator({
    env: { HOME: HOME, PATH: [first, second].join(delimiter), PATHEXT: ".EXE;.CMD" },
    platform,
    executable: (path) => present.has(path),
    probeLoginShell: async () => ({ path: null, problem: null }),
  });

  const windows = locator("win32");
  await windows.initialize();
  assert.equal(windows.resolveSync(executableSpec("claude"))?.path, join(second, "claude.exe"));
  assert.equal(
    windows.resolveSync(executableSpec("gh"))?.path,
    join(first, "gh.cmd"),
    "the earlier directory wins, as Windows' own search does, whatever the extension",
  );

  const posix = locator("darwin");
  await posix.initialize();
  assert.equal(posix.resolveSync(executableSpec("claude"))?.path, join(first, "claude"), "POSIX looks the name up as written");
  assert.equal(posix.resolveSync(executableSpec("gh")), null);
});

test("win32 reads PATH from the machine and user environment through Windows PowerShell", () => {
  const read = win32ExecutableEnvironment.loginShellPathRead(WIN_ENV);
  assert.equal(read.command, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(read.args.slice(0, -1), POWERSHELL_FLAGS);
  const script = Buffer.from(read.args.at(-1) ?? "", "base64").toString("utf16le");
  assert.equal(
    script,
    PRELUDE + [
      "$machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
      "$user = [Environment]::GetEnvironmentVariable('Path', 'User')",
      "$path = (@($machine, $user) | Where-Object { $_ }) -join ';'",
      "[Console]::Out.Write('__MISSION_PATH__' + $path + '__MISSION_PATH__')",
    ].join("\n"),
  );
  assert.equal(
    win32ExecutableEnvironment.loginShellPathRead({}).command,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
});

test("the catalog finds powershell at its fixed win32 path, and nowhere else on POSIX", () => {
  const spec = executableSpec("powershell");
  assert.equal(spec.overrideEnv, "POWERSHELL_BIN");
  assert.deepEqual(spec.candidates({ env: WIN_ENV, home: WIN_HOME, platform: "win32" }), [windowsPowerShellPath(WIN_ENV)]);
  assert.deepEqual(spec.candidates({ env: {}, home: HOME, platform: "darwin" }), []);
});

const noPowerShell = existsSync(windowsPowerShellPath(process.env)) ? false : "Windows PowerShell is not installed";

test("the win32 PATH read answers through the real Windows PowerShell", { skip: noPowerShell }, async () => {
  const result = await probeLoginShellPath(process.env, 30_000, "win32");
  assert.equal(result.problem, null);
  assert.match(result.path ?? "", /\\System32(;|$)/i, "the machine PATH carries System32");
});
