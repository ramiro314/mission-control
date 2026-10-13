import { userInfo } from "node:os";
import { basename, isAbsolute, join } from "node:path";

// Executable environment: where the executable resolver looks, and how it reads PATH from the
// operator's login shell.
//
// The locator owns the ladder's ORDER and provenance (`src/server/executables/locator.ts`); this
// table owns only the platform's LOCATIONS and its PATH read, so a platform whose tools live
// elsewhere, or whose PATH does not come from a POSIX login shell, has one row to fill.
//
// Like `process-lifetime.ts`, this stays a leaf: Node builtins only.
// `test/executable-environment.test.ts` pins the POSIX and Linux rows.

/** Brackets the PATH a login shell prints, so startup-file output around it is ignored. */
export const LOGIN_SHELL_PATH_MARKER = "__MISSION_PATH__";

export interface LoginShellPathRead {
  command: string;
  args: readonly string[];
}

export interface ExecutableEnvironmentPlatform {
  /** Roots holding application bundles, whose supported locations are checked before PATH. */
  applicationDirectories(home: string): readonly string[];
  /** Per-user tool and version-manager directories, ranked ahead of every inherited PATH. */
  userToolDirectories(home: string, env: NodeJS.ProcessEnv): readonly string[];
  /** The OS defaults, the ladder's last installed rung. */
  readonly osDefaultDirectories: readonly string[];
  /** The command whose stdout carries the login shell's PATH between two markers. */
  loginShellPathRead(env: NodeJS.ProcessEnv): LoginShellPathRead;
}

const LOGIN_SHELL_PATH_ARGS = Object.freeze([
  "-ilc",
  `printf '${LOGIN_SHELL_PATH_MARKER}%s${LOGIN_SHELL_PATH_MARKER}' "$PATH"`,
]);

/** The POSIX row: the macOS app roots, Unix version managers, and an interactive login shell. */
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
  osDefaultDirectories: Object.freeze([
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]),
  loginShellPathRead: (env) => ({
    command: env.SHELL?.trim() || "/bin/zsh",
    args: LOGIN_SHELL_PATH_ARGS,
  }),
};

/**
 * The passwd entry's login shell, when it can read PATH. No entry (`userInfo` throws), no
 * shell, and a shell that refuses every login all count as none.
 */
function passwdLoginShell(readPasswdShell: () => string | null): string | null {
  let shell: string | null;
  try {
    shell = readPasswdShell();
  } catch {
    return null;
  }
  const trimmed = shell?.trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;
  return ["nologin", "false"].includes(basename(trimmed)) ? null : trimmed;
}

/**
 * Linux: the POSIX row, plus the per-user and distribution tool directories Linux installs
 * use, and a login shell that exists there. A daemon started by systemd or a desktop launcher
 * often has no `SHELL`, and zsh is not a Linux default, so the passwd entry names the shell
 * and `/bin/sh` is the last resort.
 */
export function createLinuxExecutableEnvironment(
  readPasswdShell: () => string | null = () => userInfo().shell,
): ExecutableEnvironmentPlatform {
  return {
    ...posixExecutableEnvironment,
    userToolDirectories(home, env) {
      const cargoHome = env.CARGO_HOME?.trim() || join(home, ".cargo");
      const bunInstall = env.BUN_INSTALL?.trim() || join(home, ".bun");
      return [
        ...posixExecutableEnvironment.userToolDirectories(home, env),
        join(home, ".nix-profile", "bin"),
        join(cargoHome, "bin"),
        join(bunInstall, "bin"),
      ];
    },
    osDefaultDirectories: Object.freeze([
      "/home/linuxbrew/.linuxbrew/bin",
      ...posixExecutableEnvironment.osDefaultDirectories,
      "/snap/bin",
    ]),
    loginShellPathRead: (env) => ({
      command: env.SHELL?.trim() || passwdLoginShell(readPasswdShell) || "/bin/sh",
      args: LOGIN_SHELL_PATH_ARGS,
    }),
  };
}

export const linuxExecutableEnvironment = createLinuxExecutableEnvironment();

/**
 * The platform-selection point. Linux registers its own row; every other platform resolves
 * to the POSIX row.
 */
const byPlatform: Partial<Record<NodeJS.Platform, ExecutableEnvironmentPlatform>> = {
  linux: linuxExecutableEnvironment,
};

export function executableEnvironmentFor(platform: NodeJS.Platform): ExecutableEnvironmentPlatform {
  return byPlatform[platform] ?? posixExecutableEnvironment;
}
