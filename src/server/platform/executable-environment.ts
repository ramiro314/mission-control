import { join, win32 } from "node:path";

// Executable environment: where the executable resolver looks, which file names a command may
// have, and how it reads PATH from the operator's login environment.
//
// The locator owns the ladder's ORDER and provenance (`src/server/executables/locator.ts`); this
// table owns only the platform's LOCATIONS and its PATH read, so a platform whose tools live
// elsewhere, or whose PATH does not come from a POSIX login shell, has one row to fill.
//
// Like `process-lifetime.ts`, this stays a leaf: Node builtins only.
// `test/executable-environment.test.ts` pins the POSIX row and the win32 row.

/** Brackets the PATH a login shell prints, so startup-file output around it is ignored. */
export const LOGIN_SHELL_PATH_MARKER = "__MISSION_PATH__";

export interface LoginShellPathRead {
  command: string;
  args: readonly string[];
}

export interface ExecutableEnvironmentPlatform {
  /** Roots holding application bundles, whose supported locations are checked before PATH. */
  applicationDirectories(home: string, env: NodeJS.ProcessEnv): readonly string[];
  /** Per-user tool and version-manager directories, ranked ahead of every inherited PATH. */
  userToolDirectories(home: string, env: NodeJS.ProcessEnv): readonly string[];
  /** The OS defaults, the ladder's last installed rung. */
  osDefaultDirectories(env: NodeJS.ProcessEnv): readonly string[];
  /** The file names a bare command may have in a search directory, in the order they are tried. */
  executableNames(command: string, env: NodeJS.ProcessEnv): readonly string[];
  /** The command whose stdout carries the login environment's PATH between two markers. */
  loginShellPathRead(env: NodeJS.ProcessEnv): LoginShellPathRead;
}

const POSIX_OS_DEFAULTS: readonly string[] = Object.freeze([
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
]);

/** darwin and linux: the macOS app roots, Unix version managers, and an interactive login shell. */
export const posixExecutableEnvironment: ExecutableEnvironmentPlatform = {
  applicationDirectories: (home) => ["/Applications", join(home, "Applications")],
  userToolDirectories(home, env) {
    const dataHome = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
    const miseData = env.MISE_DATA_DIR?.trim() || join(dataHome, "mise");
    const miseShims = env.MISE_SHIMS_DIR?.trim() || join(miseData, "shims");
    const asdfData = env.ASDF_DATA_DIR?.trim() || join(home, ".asdf");
    const voltaHome = env.VOLTA_HOME?.trim() || join(home, ".volta");
    return [
      join(home, ".local", "bin"),
      miseShims,
      join(asdfData, "shims"),
      join(voltaHome, "bin"),
      join(home, "go", "bin"),
    ];
  },
  osDefaultDirectories: () => POSIX_OS_DEFAULTS,
  executableNames: (command) => [command],
  loginShellPathRead: (env) => ({
    command: env.SHELL?.trim() || "/bin/zsh",
    args: ["-ilc", `printf '${LOGIN_SHELL_PATH_MARKER}%s${LOGIN_SHELL_PATH_MARKER}' "$PATH"`],
  }),
};

// win32 paths are built with `path.win32` rather than the host's `path`, so the row answers the
// same on every machine and its tests run on macOS and Linux too.

/** A Windows variable, trimmed, or the documented default when it is unset or blank. */
function windowsVariable(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  return env[name]?.trim() || fallback;
}

function systemRoot(env: NodeJS.ProcessEnv): string {
  return windowsVariable(env, "SystemRoot", "C:\\Windows");
}

function localAppData(home: string, env: NodeJS.ProcessEnv): string {
  return windowsVariable(env, "LOCALAPPDATA", win32.join(home, "AppData", "Local"));
}

/** Windows PowerShell 5.1, which every Windows 11 install ships, by its fixed path. */
export function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  return win32.join(systemRoot(env), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * The arguments that run `script` in PowerShell with no profile and no prompt.
 *
 * The script travels as `-EncodedCommand` (base64 of UTF-16LE), because Node quotes argv by the
 * C runtime's rules and PowerShell's `-Command` re-parses quotes by its own, and the two disagree.
 * The script sets UTF-8 output itself: redirected, PowerShell otherwise writes the OEM code page.
 */
export function powerShellArgs(script: string): string[] {
  // A PowerShell with no console handle at all refuses the encoding change; it then writes the
  // OEM code page, which still carries every ASCII answer, so the refusal is not fatal.
  const prelude = "$ErrorActionPreference = 'Stop'\n"
    + "try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}\n";
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(prelude + script, "utf16le").toString("base64"),
  ];
}

/** What Windows uses when PATHEXT is unset: the extensions that start a program. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * win32: per-user installs under the profile, the npm, mise and Volta Windows locations, and
 * PATH as the registry holds it rather than as a login shell prints it.
 *
 * - **Applications.** `%ProgramFiles%` and `%LOCALAPPDATA%\Programs` are the system and
 *   per-user install roots, the counterparts of `/Applications` and `~/Applications`.
 * - **Tools.** `%USERPROFILE%\.local\bin` holds Claude Code's native `claude.exe`;
 *   `%APPDATA%\npm` is npm's global prefix; mise keeps its shims under `%LOCALAPPDATA%\mise`
 *   and Volta its shims under `%LOCALAPPDATA%\Volta\bin`, each relocatable the way its own
 *   documentation says.
 * - **Defaults.** System32, the Windows directory, Windows PowerShell, and Git for Windows'
 *   `bin` (git and the bash Claude Code needs) rank last, as `/usr/bin` does on POSIX.
 * - **Names.** Windows starts a file by its extension, so a bare `claude` is looked up as each
 *   PATHEXT name in turn (`claude.com`, `claude.exe`, ...) and never as the extensionless file:
 *   npm writes a POSIX shell script by that name beside its `claude.cmd`, and spawning that
 *   script fails. A command that already ends in a PATHEXT extension is looked up as written.
 * - **PATH.** There is no login shell to ask. A Windows process takes PATH from the machine and
 *   user environment in the registry, machine first, and that is what is read here. A PATH
 *   edited by an installer after Mission Control started reaches it the same way a new login
 *   shell's would on macOS. The read keeps its `login-shell` provenance in the ladder: it is the
 *   same rung, filled from the platform's own source.
 */
export const win32ExecutableEnvironment: ExecutableEnvironmentPlatform = {
  applicationDirectories: (home, env) => [
    windowsVariable(env, "ProgramFiles", "C:\\Program Files"),
    win32.join(localAppData(home, env), "Programs"),
  ],
  userToolDirectories(home, env) {
    const local = localAppData(home, env);
    const roaming = windowsVariable(env, "APPDATA", win32.join(home, "AppData", "Roaming"));
    const miseData = env.MISE_DATA_DIR?.trim() || win32.join(local, "mise");
    const miseShims = env.MISE_SHIMS_DIR?.trim() || win32.join(miseData, "shims");
    const voltaHome = env.VOLTA_HOME?.trim() || win32.join(local, "Volta");
    return [
      win32.join(home, ".local", "bin"),
      win32.join(roaming, "npm"),
      miseShims,
      win32.join(voltaHome, "bin"),
    ];
  },
  osDefaultDirectories(env) {
    const root = systemRoot(env);
    return [
      win32.join(root, "System32"),
      root,
      win32.join(root, "System32", "WindowsPowerShell", "v1.0"),
      win32.join(windowsVariable(env, "ProgramFiles", "C:\\Program Files"), "Git", "bin"),
    ];
  },
  executableNames(command, env) {
    const extensions = windowsVariable(env, "PATHEXT", DEFAULT_PATHEXT)
      .split(";")
      .map((extension) => extension.trim().toLowerCase())
      .filter((extension) => /^\.[^.\\/]+$/.test(extension));
    const lower = command.toLowerCase();
    if (extensions.some((extension) => lower.endsWith(extension))) return [command];
    return [...new Set(extensions)].map((extension) => `${command}${extension}`);
  },
  loginShellPathRead: (env) => ({
    command: windowsPowerShellPath(env),
    args: powerShellArgs([
      "$machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
      "$user = [Environment]::GetEnvironmentVariable('Path', 'User')",
      "$path = (@($machine, $user) | Where-Object { $_ }) -join ';'",
      `[Console]::Out.Write('${LOGIN_SHELL_PATH_MARKER}' + $path + '${LOGIN_SHELL_PATH_MARKER}')`,
    ].join("\n")),
  }),
};

/**
 * The platform-selection point. `win32` gets its own row; every other platform, macOS and
 * Linux included, resolves to the POSIX row.
 */
const byPlatform: Partial<Record<NodeJS.Platform, ExecutableEnvironmentPlatform>> = {
  win32: win32ExecutableEnvironment,
};

export function executableEnvironmentFor(platform: NodeJS.Platform): ExecutableEnvironmentPlatform {
  return byPlatform[platform] ?? posixExecutableEnvironment;
}
