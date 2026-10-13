import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  archPrerequisiteMessage,
  buildToolchain,
  buildToolsPrerequisiteMessage,
  chromiumPrerequisiteMessage,
  ghPrerequisiteMessage,
  gitPrerequisiteMessage,
  MIN_NODE_MAJOR,
  nodeMajor,
  nodePrerequisiteMessage,
  REQUIRED_ARCH,
} from "../scripts/init-prerequisites.mjs";
import { stateLockBuildTarget } from "../scripts/build-state-lock-native.mjs";

test("init prerequisite checks accept supported Node versions", () => {
  assert.equal(nodeMajor("v24.0.0"), 24);
  assert.equal(nodePrerequisiteMessage("24.0.0"), null);
  assert.equal(nodePrerequisiteMessage("26.6.0"), null);
});

test("init prerequisite checks give the Node installation fix", () => {
  assert.equal(nodeMajor("not-node"), null);
  assert.equal(
    nodePrerequisiteMessage("23.11.0"),
    `Mission Control requires Node.js ${MIN_NODE_MAJOR} or newer (found 23.11.0). Install Node.js ${MIN_NODE_MAJOR}+ and rerun \`make init\`.`,
  );
});

test("init prerequisite checks give the Playwright installation fix", () => {
  assert.equal(
    chromiumPrerequisiteMessage(),
    'Playwright Chromium is required for end-to-end tests. Run `npx playwright install chromium`, then rerun `make init ARGS="--with-e2e"`.',
  );
});

test("the install refuses a non-arm64 host rather than warning", () => {
  assert.equal(archPrerequisiteMessage(REQUIRED_ARCH), null);
  assert.equal(
    archPrerequisiteMessage("x64"),
    `Mission Control packages for Apple Silicon only (found x64). Install it on an ${REQUIRED_ARCH} Mac.`,
  );
  assert.match(String(archPrerequisiteMessage("")), /unknown architecture/);
});

test("the install prerequisite checks give the git installation fix", () => {
  assert.equal(gitPrerequisiteMessage(true), null);
  assert.match(String(gitPrerequisiteMessage(false)), /xcode-select --install/);
});

test("the installer and the running app describe a broken gh identically", () => {
  // Same two sentences as `preflight` in src/server/task-sources/github-issues.ts, so a person
  // whose gh is not usable reads one wording whichever surface tells them.
  assert.equal(ghPrerequisiteMessage({ installed: true, authenticated: true }), null);
  assert.equal(
    ghPrerequisiteMessage({ installed: false, authenticated: false }),
    "the gh CLI is not installed - install it and run `gh auth login`",
  );
  assert.equal(
    ghPrerequisiteMessage({ installed: true, authenticated: false }),
    "gh is not authenticated - run `gh auth login`",
  );
});

test("a missing Xcode command line toolchain is refused before the build, by name", () => {
  // git via Homebrew needs no command line tools, so `gitPrerequisiteMessage` passing says
  // nothing about whether node-gyp can run. This is the check that does.
  const toolchain = buildToolchain("darwin", {});
  assert.deepEqual(toolchain, {
    heading: "Xcode command line tools prerequisite",
    available: "Xcode command line tools available",
    probes: [{ tool: "the Xcode command line tools", command: ["xcode-select", "-p"] }],
  });
  assert.equal(buildToolsPrerequisiteMessage({ platform: "darwin", missing: [] }), null);
  assert.equal(
    buildToolsPrerequisiteMessage({ platform: "darwin", missing: ["the Xcode command line tools"] }),
    "the Xcode command line tools are not installed - run `xcode-select --install`, let it finish, then rerun this command. Mission Control compiles a small native module during the build, and node-gyp cannot do that without them.",
  );
});

test("Linux asks for the compiler, make and Python node-gyp will run, in Linux terms", () => {
  const toolchain = buildToolchain("linux", {});
  assert.equal(toolchain?.heading, "Native build tools prerequisite");
  assert.equal(toolchain?.available, "C++ compiler (g++), make and python3 available");
  assert.deepEqual(toolchain?.probes, [
    { tool: "a C++ compiler (g++)", command: ["g++", "--version"] },
    { tool: "make", command: ["make", "--version"] },
    { tool: "python3", command: ["python3", "--version"] },
  ]);
  // The same overrides node-gyp honors, in the same order.
  assert.deepEqual(
    buildToolchain("linux", { CXX: "clang++", PYTHON: "/usr/bin/python3.12" })?.probes.map(
      ({ command }) => command[0],
    ),
    ["clang++", "make", "/usr/bin/python3.12"],
  );
  // node-gyp's Makefile runs the setting through a shell, so a wrapper form builds and must
  // be probed whole: `ccache g++ --version` still fails when g++ itself is absent.
  assert.deepEqual(buildToolchain("linux", { CXX: "ccache g++" })?.probes[0], {
    tool: "a C++ compiler (ccache g++)",
    command: ["ccache", "g++", "--version"],
  });
  assert.equal(
    buildToolchain("linux", { CXX_target: "g++-14", CXX: "clang++" })?.probes[0]?.tool,
    "a C++ compiler (g++-14)",
  );

  assert.equal(buildToolsPrerequisiteMessage({ platform: "linux", missing: [] }), null);
  const missing = String(
    buildToolsPrerequisiteMessage({ platform: "linux", missing: ["a C++ compiler (g++)", "make"] }),
  );
  assert.match(missing, /^the native build tools are missing: a C\+\+ compiler \(g\+\+\), make - /);
  assert.match(missing, /build-essential/);
  assert.match(missing, /node-gyp/);
  assert.doesNotMatch(missing, /Xcode|xcode-select/);
});

test("the toolchain is asked for wherever the required state-lock addon builds", () => {
  for (const platform of ["darwin", "linux"]) {
    assert.doesNotThrow(() => stateLockBuildTarget(platform, "x64"));
    assert.notEqual(buildToolchain(platform, {}), null);
  }
  assert.throws(() => stateLockBuildTarget("win32", "x64"));
  assert.equal(buildToolchain("win32", {}), null);
});

/** Run `make init`'s script in dry-run with only `tools` on PATH, each a stub exiting `status`. */
function initPreflight(tools: string[], status = 0) {
  const bin = mkdtempSync(join(tmpdir(), "mission-init-preflight-"));
  try {
    for (const tool of tools) {
      writeFileSync(join(bin, tool), `#!/bin/sh\nexit ${status}\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    const env: Record<string, string | undefined> = { ...process.env, PATH: bin };
    for (const name of ["CXX", "CXX_target", "PYTHON"]) delete env[name];
    return spawnSync(
      process.execPath,
      [join(import.meta.dirname, "..", "scripts", "init.mjs"), "--dry-run", "--skip-hooks"],
      { cwd: join(import.meta.dirname, ".."), encoding: "utf8", env },
    );
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

test("make init refuses a missing toolchain before the build, in this platform's terms", {
  skip: !["darwin", "linux"].includes(process.platform),
}, () => {
  const result = initPreflight([]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /✓ .*available/);
  assert.doesNotMatch(result.stdout, /dry-run\] npm run build/);
  if (process.platform === "darwin") {
    assert.match(result.stdout, /Xcode command line tools prerequisite/);
    assert.match(result.stderr, /xcode-select --install/);
  } else {
    assert.match(result.stdout, /Native build tools prerequisite/);
    assert.match(result.stderr, /the native build tools are missing: a C\+\+ compiler \(g\+\+\), make, python3 - /);
    assert.doesNotMatch(result.stdout + result.stderr, /Xcode/);
  }
});

test("make init passes a present toolchain and goes on to the build", {
  skip: !["darwin", "linux"].includes(process.platform),
}, () => {
  const result = initPreflight(["xcode-select", "g++", "make", "python3"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    process.platform === "darwin"
      ? /✓.* Xcode command line tools available/
      : /✓.* C\+\+ compiler \(g\+\+\), make and python3 available/,
  );
  if (process.platform !== "darwin") assert.doesNotMatch(result.stdout, /Xcode/);
  assert.match(result.stdout, /\[dry-run\] npm run build/);
});
