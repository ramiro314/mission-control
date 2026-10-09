import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { executableSpec } from "../src/server/executables/catalog.ts";
import { ExecutableLocator, probeLoginShellPath, probePathRead } from "../src/server/executables/locator.ts";
import { execFileSync } from "node:child_process";

import {
  executableEnvironmentFor,
  type ExecutableEnvironmentPlatform,
  expandWindowsEnvironmentReferences,
  posixExecutableEnvironment,
  registryPath,
  registryExportPathValue,
  win32ExecutableEnvironment,
  windowsPowerShellPath,
  windowsRegPath,
} from "../src/server/platform/executable-environment.ts";
import { writeFakeExecutable } from "./helpers/fake-executable.ts";
import { withProcessEnv } from "./helpers/process-env.ts";
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
    assert.equal(row.directPathRead, undefined, "POSIX has no cheaper read to try first");
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

/**
 * What is at stake: a daemon started from Git Bash inherits `SYSTEMROOT`, and the locator reads
 * PATH through a plain-object copy of `process.env`, which is case-sensitive. Read by its
 * Windows spelling, the variable was missed and the PATH read ran the PowerShell under
 * `C:\Windows` whatever the environment named.
 */
test("win32 reads its Windows variables without regard to case, as Windows does", () => {
  const shouting = { SYSTEMROOT: "D:\\Windows", PROGRAMFILES: "D:\\Program Files", localappdata: "E:\\Local" };
  assert.deepEqual(win32ExecutableEnvironment.osDefaultDirectories(shouting), [
    "D:\\Windows\\System32",
    "D:\\Windows",
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    "D:\\Program Files\\Git\\bin",
  ]);
  assert.equal(windowsPowerShellPath(shouting), "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(win32ExecutableEnvironment.applicationDirectories(WIN_HOME, shouting), [
    "D:\\Program Files",
    "E:\\Local\\Programs",
  ]);
  assert.equal(
    windowsPowerShellPath({ SYSTEMROOT: "C:\\Windows", SystemRoot: "D:\\Windows" }),
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "the name as written wins when an object carries both spellings",
  );
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

test("win32 falls back to reading PATH from the machine and user environment through Windows PowerShell", () => {
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

test("win32 reads PATH with reg export first, the machine and then the user environment key, into files it removes", () => {
  const read = win32ExecutableEnvironment.directPathRead?.(WIN_ENV);
  assert.ok(read);
  try {
    assert.deepEqual(read.commands.map(({ command, args }) => [command, args[0], args[1], args[3]]), [
      ["D:\\Windows\\System32\\reg.exe", "export", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "/y"],
      ["D:\\Windows\\System32\\reg.exe", "export", "HKCU\\Environment", "/y"],
    ]);
    const files = read.commands.map(({ args }) => args[2]!);
    assert.equal(new Set(files).size, 2);
    assert.ok(files.every((file) => existsSync(dirname(file))), "each export lands in a directory that exists");
    assert.equal(read.path(), null, "no export was written, so the read cannot answer");
    read.dispose();
    assert.ok(files.every((file) => !existsSync(dirname(file))), "dispose removes the exports' directory");
  } finally {
    read.dispose();
  }
  assert.equal(windowsRegPath({}), "C:\\Windows\\System32\\reg.exe");
});

type RegValue = [name: string, kind: "sz" | "expand" | "hex1" | "multi", data: string];

/** A `reg export` value line: a quoted string, or UTF-16LE bytes wrapped as regedit wraps them. */
function regExportLine([name, kind, data]: RegValue): string {
  const quote = (text: string) => `"${text.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
  if (kind === "sz") return `${quote(name)}=${quote(data)}`;
  const type = { expand: "hex(2)", hex1: "hex(1)", multi: "hex(7)" }[kind];
  const bytes = [...Buffer.from(`${data}\0`, "utf16le")].map((byte) => byte.toString(16).padStart(2, "0"));
  const rows: string[] = [];
  for (let at = 0; at < bytes.length; at += 24) rows.push(bytes.slice(at, at + 24).join(","));
  return `${quote(name)}=${type}:${rows.join(",\\\r\n  ")}`;
}

/** The text of the `.reg` file `reg export <key>` writes. */
const regExport = (key: string, ...values: RegValue[]) =>
  ["Windows Registry Editor Version 5.00", "", `[${key}]`, ...values.map(regExportLine), "", ""].join("\r\n");
/** That text as reg.exe writes it: UTF-16LE behind a byte-order mark. */
const exportFile = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
const MACHINE_KEY = "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
const USER_KEY = "HKEY_CURRENT_USER\\Environment";

test("registryExportPathValue reads Path as GetEnvironmentVariable reports it", () => {
  const env = { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\Ramiro" };
  const value = (...values: RegValue[]) => registryExportPathValue(exportFile(regExport(USER_KEY, ...values)), env);
  assert.equal(
    registryExportPathValue(exportFile(regExport(MACHINE_KEY,
      ["ComSpec", "expand", "%SystemRoot%\\system32\\cmd.exe"],
      ["Path", "expand", "%SystemRoot%\\system32;%SYSTEMROOT%;C:\\Program Files\\Git\\cmd;C:\\Program Files\\nodejs\\;C:\\Program Files\\GitHub CLI\\"],
    )), env),
    "C:\\Windows\\system32;C:\\Windows;C:\\Program Files\\Git\\cmd;C:\\Program Files\\nodejs\\;C:\\Program Files\\GitHub CLI\\",
    "a REG_EXPAND_SZ wrapped over several lines is expanded, its names matched without regard to case",
  );
  assert.equal(value(["PATH", "sz", "%USERPROFILE%\\bin;D:\\\"quoted\""]), "%USERPROFILE%\\bin;D:\\\"quoted\"", "a REG_SZ as stored");
  assert.equal(value(["Path", "hex1", "D:\\tools"]), "D:\\tools", "a REG_SZ exported as hex(1)");
  assert.equal(
    value(["Path", "expand", "C:\\Users\\张伟\\AppData\\Roaming\\npm;C:\\Users\\Āria\\bin"]),
    "C:\\Users\\张伟\\AppData\\Roaming\\npm;C:\\Users\\Āria\\bin",
    "characters no console code page holds arrive exactly",
  );
  assert.equal(value(["TEMP", "expand", "%USERPROFILE%\\Temp"]), null, "no Path");
  assert.equal(value(["Path", "sz", ""]), "", "an empty Path");
  assert.equal(value(["Path", "expand", ""]), "", "an empty REG_EXPAND_SZ");
  assert.equal(
    registryExportPathValue(exportFile(`${regExport(USER_KEY)}[${USER_KEY}\\Sub]\r\n"Path"="D:\\\\sub"\r\n`), env),
    null,
    "a subkey's Path is not the key's",
  );
});

test("registryExportPathValue leaves to PowerShell whatever the export cannot report exactly", () => {
  const value = (...values: RegValue[]) => registryExportPathValue(exportFile(regExport(USER_KEY, ...values)), {});
  assert.equal(value(["Path", "multi", "C:\\a\0C:\\b"]), undefined, "a REG_MULTI_SZ");
  assert.equal(registryExportPathValue(exportFile(`${regExport(USER_KEY)}`.replace("]\r\n", "]\r\n\"Path\"=dword:00000001\r\n")), {}), undefined, "a DWORD");
  assert.equal(registryExportPathValue(exportFile(regExport(USER_KEY).replace("]\r\n", "]\r\n\"Path\"=hex(2):41,00,00,00,42,00,00,00\r\n")), {}), undefined, "a NUL inside the string");
  assert.equal(registryExportPathValue(exportFile(regExport(USER_KEY).replace("]\r\n", "]\r\n\"Path\"=hex(2):41,00,42\r\n")), {}), undefined, "an odd byte count");
  assert.equal(registryExportPathValue(Buffer.from(regExport(USER_KEY, ["Path", "sz", "D:\\tools"]), "latin1"), {}), undefined, "not UTF-16LE");
  assert.equal(registryExportPathValue(exportFile(regExport(USER_KEY).replace("Windows Registry Editor Version 5.00", "REGEDIT4")), {}), undefined, "another format");
  assert.equal(registryExportPathValue(exportFile("Windows Registry Editor Version 5.00\r\n\r\n"), {}), undefined, "no key at all");
  assert.equal(registryExportPathValue(Buffer.alloc(0), {}), undefined, "an empty file");
});

test("expandWindowsEnvironmentReferences follows ExpandEnvironmentStrings", () => {
  const env = { SystemRoot: "C:\\Windows", Empty: "", PATH: "C:\\bin" };
  const expand = (value: string) => expandWindowsEnvironmentReferences(value, env);
  assert.equal(expand("%systemroot%\\System32"), "C:\\Windows\\System32");
  assert.equal(expand("%UNSET%\\bin"), "%UNSET%\\bin", "an undefined name stays as written");
  assert.equal(expand("%UNSET%PATH%"), "%UNSETC:\\bin", "the closing % of an undefined name may open the next");
  assert.equal(expand("a%Empty%b"), "ab", "a defined empty value expands to nothing");
  assert.equal(expand("100%"), "100%", "an unterminated reference is kept");
  assert.equal(expand("%%PATH%"), "%C:\\bin");
  assert.equal(expand("no references"), "no references");
});

test("registryPath joins machine then user and drops a missing or empty value, as the PowerShell read did", () => {
  const machine = exportFile(regExport(MACHINE_KEY, ["Path", "sz", "C:\\Windows\\system32"]));
  const user = exportFile(regExport(USER_KEY, ["Path", "sz", "D:\\tools"]));
  assert.equal(registryPath([machine, user], {}), "C:\\Windows\\system32;D:\\tools");
  assert.equal(registryPath([machine, exportFile(regExport(USER_KEY))], {}), "C:\\Windows\\system32");
  assert.equal(registryPath([exportFile(regExport(MACHINE_KEY, ["Path", "sz", ""])), user], {}), "D:\\tools");
  assert.equal(registryPath([exportFile(regExport(MACHINE_KEY)), exportFile(regExport(USER_KEY))], {}), "");
  assert.equal(registryPath([machine, Buffer.alloc(0)], {}), null, "either file unreadable sends the read to PowerShell");
});

// The win32 row's ordering - reg export first, PowerShell when it cannot answer, one deadline for
// both - driven on every host: the row keeps its arguments, its files and its parser, and only
// the two executables it starts are fakes that log each start and answer from the environment.

const FAKE_REG = [
  "const [, key = \"\", file] = process.argv.slice(2);",
  "const hive = key.startsWith(\"HKLM\") ? \"MACHINE\" : \"USER\";",
  "const fs = require(\"node:fs\");",
  "fs.appendFileSync(process.env.MC_TEST_LOG, `reg ${hive}\\n`);",
  "setTimeout(() => {",
  "  const text = process.env[`MC_TEST_REG_${hive}`];",
  // As reg.exe writes it: UTF-16LE behind a byte-order mark.
  "  if (text !== undefined) fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, \"utf16le\")]));",
  "  process.exitCode = Number(process.env.MC_TEST_REG_EXIT ?? 0);",
  "}, Number(process.env.MC_TEST_REG_DELAY_MS ?? 0));",
  "",
].join("\n");

const FAKE_POWERSHELL = [
  "require(\"node:fs\").appendFileSync(process.env.MC_TEST_LOG, \"powershell\\n\");",
  "setTimeout(() => {",
  "  process.stdout.write(`__MISSION_PATH__${process.env.MC_TEST_PS_PATH}__MISSION_PATH__`);",
  "}, Number(process.env.MC_TEST_PS_DELAY_MS ?? 0));",
  "",
].join("\n");

const POWERSHELL_PATH = "E:\\from-powershell";

function fakePathReaders() {
  const directory = mkdtempSync(join(tmpdir(), "mission-path-read-fakes-"));
  const reg = writeFakeExecutable(join(directory, "reg"), FAKE_REG);
  const powershell = writeFakeExecutable(join(directory, "powershell"), FAKE_POWERSHELL);
  const log = join(directory, "started");
  const exportDirectories: string[] = [];
  const row = (regCommand: string, disposeThrows: boolean): ExecutableEnvironmentPlatform => ({
    ...win32ExecutableEnvironment,
    directPathRead(env) {
      const real = win32ExecutableEnvironment.directPathRead!(env);
      exportDirectories.push(dirname(real.commands[0]!.args[2]!));
      return {
        ...real,
        commands: real.commands.map((command) => ({ ...command, command: regCommand })),
        dispose() {
          real.dispose();
          // As win32 refuses to delete an export a killed reg.exe still holds open.
          if (disposeThrows) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
        },
      };
    },
    loginShellPathRead: (env) => ({ ...win32ExecutableEnvironment.loginShellPathRead(env), command: powershell }),
  });
  return {
    /** The read's result, and which fakes it started, sorted. */
    async read(vars: NodeJS.ProcessEnv, options: { timeoutMs?: number; regCommand?: string; disposeThrows?: boolean } = {}) {
      rmSync(log, { force: true });
      const result = await probePathRead(row(options.regCommand ?? reg, options.disposeThrows ?? false), {
        PATH: [dirname(process.execPath), process.env.PATH].join(delimiter),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        MC_TEST_LOG: log,
        MC_TEST_ROOT: "D:\\Root",
        MC_TEST_PS_PATH: POWERSHELL_PATH,
        ...vars,
      }, options.timeoutMs ?? 30_000);
      const started = existsSync(log) ? readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean).sort() : [];
      assert.ok(exportDirectories.every((exported) => !existsSync(exported)), "the read left its exports behind");
      return { result, started };
    },
    missingReg: join(directory, "missing", "reg.exe"),
    clean: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const MACHINE_PATH = regExport(MACHINE_KEY, ["Path", "expand", "%MC_TEST_ROOT%\\system32"]);
const USER_PATH = regExport(USER_KEY, ["Path", "sz", "D:\\tools"]);
const BOTH_REG = ["reg MACHINE", "reg USER"];

test("the win32 read answers from both reg exports and never starts PowerShell", async () => {
  const fakes = fakePathReaders();
  try {
    assert.deepEqual(await fakes.read({ MC_TEST_REG_MACHINE: MACHINE_PATH, MC_TEST_REG_USER: USER_PATH }), {
      result: { path: "D:\\Root\\system32;D:\\tools", problem: null },
      started: BOTH_REG,
    });
    assert.deepEqual(
      await fakes.read({ MC_TEST_REG_MACHINE: MACHINE_PATH, MC_TEST_REG_USER: regExport(USER_KEY, ["Path", "sz", "C:\\Users\\张伟\\AppData\\Roaming\\npm"]) }),
      { result: { path: "D:\\Root\\system32;C:\\Users\\张伟\\AppData\\Roaming\\npm", problem: null }, started: BOTH_REG },
      "a non-ASCII Path arrives exactly, without PowerShell",
    );
    assert.deepEqual(await fakes.read({ MC_TEST_REG_MACHINE: regExport(MACHINE_KEY), MC_TEST_REG_USER: regExport(USER_KEY) }), {
      result: { path: null, problem: "login shell returned no PATH" },
      started: BOTH_REG,
    }, "neither key holds a Path: the registry answered, and PowerShell would read the same nothing");
  } finally {
    fakes.clean();
  }
});

test("the win32 read falls back to PowerShell whenever reg export cannot answer exactly", async () => {
  const fakes = fakePathReaders();
  const fallback = { result: { path: POWERSHELL_PATH, problem: null }, started: [...BOTH_REG, "powershell"].sort() };
  try {
    assert.deepEqual(
      await fakes.read({ MC_TEST_REG_MACHINE: regExport(MACHINE_KEY, ["Path", "multi", "C:\\a\0C:\\b"]), MC_TEST_REG_USER: USER_PATH }),
      fallback,
      "a Path of another type",
    );
    assert.deepEqual(
      await fakes.read({ MC_TEST_REG_MACHINE: MACHINE_PATH, MC_TEST_REG_USER: USER_PATH.replace("Windows Registry Editor Version 5.00", "REGEDIT4") }),
      fallback,
      "a file in another format",
    );
    assert.deepEqual(await fakes.read({ MC_TEST_REG_MACHINE: MACHINE_PATH }), fallback, "a reg export that wrote no file");
    assert.deepEqual(
      await fakes.read({ MC_TEST_REG_MACHINE: MACHINE_PATH, MC_TEST_REG_USER: USER_PATH, MC_TEST_REG_EXIT: "1" }),
      fallback,
      "a reg export that exits non-zero",
    );
    assert.deepEqual(
      await fakes.read({}, { regCommand: fakes.missingReg }),
      { result: { path: POWERSHELL_PATH, problem: null }, started: ["powershell"] },
      "a reg.exe that does not start",
    );
  } finally {
    fakes.clean();
  }
});

test("the win32 read's reg exports and PowerShell fallback share one deadline", async () => {
  const fakes = fakePathReaders();
  const timeoutMs = 2_000;
  try {
    const started = Date.now();
    const { result } = await fakes.read(
      { MC_TEST_REG_DELAY_MS: "60000", MC_TEST_PS_DELAY_MS: "60000" },
      { timeoutMs },
    );
    assert.deepEqual(result, { path: null, problem: "login shell timed out" });
    // A fallback given a fresh budget would end near twice the timeout.
    assert.ok(Date.now() - started < timeoutMs + 1_500, `took ${Date.now() - started} ms against a ${timeoutMs} ms budget`);
  } finally {
    fakes.clean();
  }
});

test("the win32 read falls back to PowerShell when its export directory cannot be made", async () => {
  const fakes = fakePathReaders();
  const missing = join(tmpdir(), "mission-missing-temp", "absent");
  try {
    // os.tmpdir() reads TMPDIR on POSIX and TEMP, then TMP, on win32.
    const { result, started } = await withProcessEnv(
      { TMPDIR: missing, TEMP: missing, TMP: missing },
      () => fakes.read({ MC_TEST_REG_MACHINE: MACHINE_PATH, MC_TEST_REG_USER: USER_PATH }),
    );
    assert.deepEqual(result, { path: POWERSHELL_PATH, problem: null });
    assert.deepEqual(started, ["powershell"], "no reg export started without somewhere to write");
  } finally {
    fakes.clean();
  }
});

test("a cleanup the OS refuses never replaces the win32 read's answer", async () => {
  const fakes = fakePathReaders();
  try {
    assert.deepEqual(
      await fakes.read({ MC_TEST_REG_MACHINE: MACHINE_PATH, MC_TEST_REG_USER: USER_PATH }, { disposeThrows: true }),
      { result: { path: "D:\\Root\\system32;D:\\tools", problem: null }, started: BOTH_REG },
    );
    const { result } = await fakes.read(
      { MC_TEST_REG_DELAY_MS: "60000", MC_TEST_PS_DELAY_MS: "60000" },
      { timeoutMs: 1_000, disposeThrows: true },
    );
    assert.deepEqual(result, { path: null, problem: "login shell timed out" });
  } finally {
    fakes.clean();
  }
});

const noReg = existsSync(windowsRegPath(process.env)) ? false : "reg.exe is not installed";

test("the win32 PATH read answers through the real reg.exe", { skip: noReg }, async () => {
  const result = await probeLoginShellPath(process.env, 30_000, "win32");
  assert.equal(result.problem, null);
  assert.match(result.path ?? "", /\\System32(;|$)/i, "the machine PATH carries System32");
});

test("reg export reports exactly the PATH Windows PowerShell reports", { skip: noReg || noPowerShell }, () => {
  const read = win32ExecutableEnvironment.directPathRead!(process.env);
  let viaReg: string | null;
  try {
    for (const { command, args } of read.commands) execFileSync(command, args, { windowsHide: true, timeout: 30_000 });
    viaReg = read.path();
  } finally {
    read.dispose();
  }
  const powerShell = win32ExecutableEnvironment.loginShellPathRead(process.env);
  const printed = execFileSync(powerShell.command, powerShell.args, { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  const viaPowerShell = /__MISSION_PATH__([\s\S]*)__MISSION_PATH__/.exec(printed)?.[1];
  assert.notEqual(viaReg, null, "reg export could not report this machine's PATH exactly");
  assert.equal(viaReg?.trim(), viaPowerShell?.trim());
});
