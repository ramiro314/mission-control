import { hasNativeAddonSources } from "./native-addon-sources.mjs";

export const MIN_NODE_MAJOR = 24;

export function nodeMajor(version) {
  const match = /^v?(\d+)/.exec(version);
  return match ? Number(match[1]) : null;
}

export function nodePrerequisiteMessage(version) {
  const major = nodeMajor(version);
  if (major !== null && major >= MIN_NODE_MAJOR) return null;
  return `Mission Control requires Node.js ${MIN_NODE_MAJOR} or newer (found ${version || "an unknown version"}). Install Node.js ${MIN_NODE_MAJOR}+ and rerun \`make init\`.`;
}

export function chromiumPrerequisiteMessage() {
  return "Playwright Chromium is required for end-to-end tests. Run `npx playwright install chromium`, then rerun `make init ARGS=\"--with-e2e\"`.";
}

/**
 * The architecture the packaged app can be built for.
 *
 * `electron-builder.yml` pins `arch: arm64` for both the dmg and the dir target, so an Intel
 * host would build an app it cannot run. That is a refusal, not a warning.
 */
export const REQUIRED_ARCH = "arm64";

export function archPrerequisiteMessage(arch) {
  if (arch === REQUIRED_ARCH) return null;
  return `Mission Control packages for Apple Silicon only (found ${arch || "an unknown architecture"}). Install it on an ${REQUIRED_ARCH} Mac.`;
}

export function gitPrerequisiteMessage(installed) {
  if (installed) return null;
  return "git is not installed - install the Xcode command line tools (`xcode-select --install`) or git itself, then rerun `make install`.";
}

/**
 * The `gh` prerequisite, in the app's own words.
 *
 * The two phrasings are copied verbatim from `preflight` in
 * `src/server/task-sources/github-issues.ts`, which is the only other place this application
 * tells someone their `gh` is not usable. One wording, so the installer and the running app
 * cannot describe the same broken dependency differently.
 */
export function ghPrerequisiteMessage({ installed, authenticated }) {
  if (!installed) return "the gh CLI is not installed - install it and run `gh auth login`";
  if (!authenticated) return "gh is not authenticated - run `gh auth login`";
  return null;
}

/**
 * The native build toolchain, asked for before anything long-running starts.
 *
 * Both `npm run build` and `npm run package` compile the state-lock addon with node-gyp
 * (`scripts/build-native.mjs`), and node-gyp cannot run without a toolchain. Without this check
 * that fails at the very end of a clone, a `npm ci`, and a full Electron package - and it fails
 * as node-gyp's own text buried in inherited output, under a generic "failed" line, after
 * which the daemon refuses to start on an artifact that was never produced.
 *
 * Keyed on the state-lock build target, because that addon is required: wherever it has
 * sources, the toolchain is asked for, and a platform it has no sources for has nothing to be
 * missing. Each probe is a command that exits 0 when its tool is usable.
 *
 * On darwin `git` being present is not evidence of the Xcode tools: Homebrew's git needs none
 * of them. That is why this is a check of its own rather than a sentence inside
 * `gitPrerequisiteMessage`.
 *
 * On Linux the probes name what node-gyp itself will run: the C++ compiler its Makefile uses
 * (`CXX_target`, then `CXX`, then make's default `g++`), `make`, and the Python it looks for
 * (`PYTHON`, then `python3`).
 */
export function buildToolchain(platform, env = {}) {
  if (!hasNativeAddonSources("state-lock", platform)) return null;
  if (platform === "darwin") {
    return {
      heading: "Xcode command line tools prerequisite",
      available: "Xcode command line tools available",
      probes: [{ tool: "the Xcode command line tools", command: ["xcode-select", "-p"] }],
    };
  }
  const cxx = env.CXX_target || env.CXX || "g++";
  const python = env.PYTHON || "python3";
  return {
    heading: "Native build tools prerequisite",
    available: `C++ compiler (${cxx}), make and ${python} available`,
    probes: [
      { tool: `a C++ compiler (${cxx})`, command: [cxx, "--version"] },
      { tool: "make", command: ["make", "--version"] },
      { tool: python, command: [python, "--version"] },
    ],
  };
}

/** The refusal for the `missing` probe tools of `buildToolchain(platform)`, or null. */
export function buildToolsPrerequisiteMessage({ platform, missing }) {
  if (missing.length === 0) return null;
  if (platform === "darwin") {
    return "the Xcode command line tools are not installed - run `xcode-select --install`, let it finish, then rerun this command. Mission Control compiles a small native module during the build, and node-gyp cannot do that without them.";
  }
  return `the native build tools are missing: ${missing.join(", ")} - install them with your distribution's package manager (for example \`build-essential python3\` on Debian or Ubuntu, \`gcc-c++ make python3\` on Fedora, \`base-devel python\` on Arch), then rerun this command. Mission Control compiles a small native module during the build, and node-gyp cannot do that without them.`;
}
