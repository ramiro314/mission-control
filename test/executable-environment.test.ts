import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executableSpec } from "../src/server/executables/catalog.ts";
import { ExecutableLocator, probeLoginShellPath } from "../src/server/executables/locator.ts";
import {
  createLinuxExecutableEnvironment,
  executableEnvironmentFor,
  linuxExecutableEnvironment,
  posixExecutableEnvironment,
} from "../src/server/platform/executable-environment.ts";

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

/** The rungs the Linux row adds to the POSIX row, by ladder section. */
const LINUX_ONLY = {
  versionManagers: [`${HOME}/.nix-profile/bin`, `${HOME}/.cargo/bin`, `${HOME}/.bun/bin`],
  osDefaultsFirst: ["/home/linuxbrew/.linuxbrew/bin"],
  osDefaultsLast: ["/snap/bin"],
};
const linuxOnly = (platform: NodeJS.Platform, key: keyof typeof LINUX_ONLY) =>
  platform === "linux" ? LINUX_ONLY[key] : [];

test("linux registers its own row, and darwin and win32 resolve to the POSIX row", () => {
  assert.equal(executableEnvironmentFor("linux"), linuxExecutableEnvironment);
  for (const platform of ["darwin", "win32"] as const) {
    assert.equal(executableEnvironmentFor(platform), posixExecutableEnvironment, platform);
  }
});

for (const platform of POSIX_PLATFORMS) {
  test(`${platform} keeps the search ladder's exact order and provenance`, async () => {
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
        ...linuxOnly(platform, "versionManagers").map(
          (directory): [string, string, string] => [directory, "version-manager", "supported per-user tool locations"],
        ),
        ["/inherited/bin", "inherited-path", "PATH inherited by Mission Control"],
        ["/usr/bin", "inherited-path", "PATH inherited by Mission Control"],
        ["/login/bin", "login-shell", "/bin/bash"],
        ...linuxOnly(platform, "osDefaultsFirst").map(
          (directory): [string, string, string] => [directory, "os-default", `${platform} supported defaults`],
        ),
        ["/opt/homebrew/bin", "os-default", `${platform} supported defaults`],
        ["/opt/homebrew/sbin", "os-default", `${platform} supported defaults`],
        ["/usr/local/bin", "os-default", `${platform} supported defaults`],
        ["/bin", "os-default", `${platform} supported defaults`],
        ["/usr/sbin", "os-default", `${platform} supported defaults`],
        ["/sbin", "os-default", `${platform} supported defaults`],
        ...linuxOnly(platform, "osDefaultsLast").map(
          (directory): [string, string, string] => [directory, "os-default", `${platform} supported defaults`],
        ),
        [
          "/repo/node_modules/.bin",
          "project-local",
          "project-local node_modules/.bin, ranked after every installation",
        ],
      ],
    );
  });

  test(`${platform} version-manager overrides relocate their rungs in place`, async () => {
    const entries = await ladder(platform, {
      PATH: "",
      XDG_DATA_HOME: "/xdg",
      ASDF_DATA_DIR: "/asdf",
      VOLTA_HOME: "/volta",
    });
    assert.deepEqual(
      entries.filter(([, source]) => source === "version-manager").map(([directory]) => directory),
      [
        `${HOME}/.local/bin`,
        "/xdg/mise/shims",
        "/asdf/shims",
        "/volta/bin",
        `${HOME}/go/bin`,
        ...linuxOnly(platform, "versionManagers"),
      ],
    );
    const shims = await ladder(platform, { PATH: "", MISE_DATA_DIR: "/mise", XDG_DATA_HOME: "/xdg" });
    assert.equal(shims[1]?.[0], "/mise/shims");
    const explicit = await ladder(platform, { PATH: "", MISE_SHIMS_DIR: "/shims", MISE_DATA_DIR: "/mise" });
    assert.equal(explicit[1]?.[0], "/shims");
  });

  test(`${platform} checks the system then per-user application roots before PATH`, () => {
    const candidates = executableSpec("wezterm").candidates({ env: {}, home: HOME, platform });
    assert.deepEqual(candidates, [
      "/Applications/WezTerm.app/Contents/MacOS/wezterm",
      `${HOME}/Applications/WezTerm.app/Contents/MacOS/wezterm`,
    ]);
  });

  test(`${platform} reads PATH through SHELL with the same interactive login-shell command`, () => {
    assert.deepEqual(executableEnvironmentFor(platform).loginShellPathRead({ SHELL: " /bin/bash " }), {
      command: "/bin/bash",
      args: LOGIN_SHELL_ARGS,
    });
  });
}

test("darwin falls back to zsh when SHELL is unset", () => {
  assert.deepEqual(executableEnvironmentFor("darwin").loginShellPathRead({}), {
    command: "/bin/zsh",
    args: LOGIN_SHELL_ARGS,
  });
});

test("linux falls back to the passwd login shell, then /bin/sh, when SHELL is unset", () => {
  const command = (passwd: string | null, env: NodeJS.ProcessEnv = {}) =>
    createLinuxExecutableEnvironment(() => passwd).loginShellPathRead(env);
  assert.deepEqual(command("/usr/bin/fish"), { command: "/usr/bin/fish", args: LOGIN_SHELL_ARGS });
  assert.equal(command("/usr/bin/fish", { SHELL: "/bin/bash" }).command, "/bin/bash", "SHELL still wins");
  assert.equal(command("/usr/bin/fish", { SHELL: "  " }).command, "/usr/bin/fish", "a blank SHELL is unset");
  for (const passwd of [null, "", "bash", "/usr/sbin/nologin", "/sbin/nologin", "/bin/false"]) {
    assert.deepEqual(command(passwd), { command: "/bin/sh", args: LOGIN_SHELL_ARGS }, String(passwd));
  }
  assert.equal(
    createLinuxExecutableEnvironment(() => { throw new Error("no passwd entry"); }).loginShellPathRead({}).command,
    "/bin/sh",
  );
});

test("linux cargo and bun rungs follow CARGO_HOME and BUN_INSTALL", () => {
  assert.deepEqual(
    linuxExecutableEnvironment.userToolDirectories(HOME, { CARGO_HOME: "/cargo", BUN_INSTALL: "/bun" }).slice(-2),
    ["/cargo/bin", "/bun/bin"],
  );
});

test("the login-shell probe spawns the table's command with the table's arguments", async () => {
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
