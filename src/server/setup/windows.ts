import { win32 } from "node:path";

import type { SetupStatus } from "@shared/setup-catalog.ts";

import type { RunResult } from "../util/exec.ts";
import type { SetupDeps } from "./types.ts";

// The Windows prerequisites Settings > Setup checks on win32 (D11, D23, D24, D30 and D33 in
// `docs/plans/windows-support/plan.md`). Each probe reads the machine through `SetupDeps`, so
// the tests drive every reading without a Windows host, and none of them runs anywhere else:
// their catalog rows carry `hosts: ["win32"]`.

function outputOf(result: RunResult): string | null {
  return `${result.stdout}\n${result.stderr}`.trim() || null;
}

/** The DWORD `name` in `reg query` output, or null when the output does not carry one. */
export function registryDword(stdout: string, name: string): number | null {
  const match = new RegExp(`^\\s*${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)\\s*$`, "im").exec(stdout);
  return match ? Number.parseInt(match[1]!, 16) : null;
}

/** A registry flag that must read 1, answered from `reg query`. */
async function registryFlagStatus(
  deps: SetupDeps,
  key: string,
  value: string,
  unset: string,
): Promise<SetupStatus> {
  const result = await deps.runCommand("reg", ["query", key, "/v", value]);
  const evidence = outputOf(result);
  if (result.outcomeUnknown) {
    return { state: "unknown", why: `Reading ${value} from the registry did not finish.`, evidence };
  }
  const dword = registryDword(result.stdout, value);
  if (dword === 1) return { state: "satisfied", evidence: `${key}\\${value} = 1` };
  if (dword !== null) return { state: "needs-setup", why: `${unset} ${value} is ${dword}.`, evidence };
  if (/unable to find/i.test(result.stderr)) {
    return { state: "needs-setup", why: `${unset} ${value} is not set.`, evidence };
  }
  return { state: "unknown", why: `${value} could not be read from the registry.`, evidence };
}

export function developerModeStatus(deps: SetupDeps): Promise<SetupStatus> {
  return registryFlagStatus(
    deps,
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock",
    "AllowDevelopmentWithoutDevLicense",
    "Developer Mode is off:",
  );
}

export function longPathsStatus(deps: SetupDeps): Promise<SetupStatus> {
  return registryFlagStatus(
    deps,
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem",
    "LongPathsEnabled",
    "Windows still limits paths to 260 characters:",
  );
}

/**
 * Git for Windows, told apart from any other git by its version string
 * (`git version 2.47.1.windows.1`). It is the one that installs Git Bash.
 */
export async function gitForWindowsStatus(deps: SetupDeps): Promise<SetupStatus> {
  const path = await deps.resolveBinPath("git");
  if (!path) return { state: "missing" };
  const result = await deps.runCommand(path, ["--version"]);
  const version = /^git version (\S+)/m.exec(result.stdout)?.[1];
  if (result.outcomeUnknown || result.code !== 0 || !version) {
    return { state: "unknown", why: "The installed git did not report its version.", evidence: outputOf(result) ?? path };
  }
  if (!/\.windows\./.test(version)) {
    return {
      state: "needs-setup",
      why: `The git on PATH (${version}) is not Git for Windows, which is the one that installs Git Bash.`,
      evidence: path,
    };
  }
  return { state: "satisfied", evidence: `${path} (git ${version})` };
}

/**
 * npm's `script-shell`, read through `cmd.exe` because `npm` on Windows is a `.cmd` shim,
 * which Node refuses to start without a shell.
 */
export async function npmScriptShellStatus(deps: SetupDeps): Promise<SetupStatus> {
  const result = await deps.runCommand("cmd.exe", ["/d", "/s", "/c", "npm config get script-shell"]);
  const value = result.stdout.trim();
  if (result.outcomeUnknown || result.code !== 0) {
    return { state: "unknown", why: "npm's script-shell setting could not be read.", evidence: outputOf(result) };
  }
  if (!value || value === "undefined" || value === "null") {
    return { state: "needs-setup", why: "npm's script-shell is not set, so npm runs package scripts through cmd.exe.", evidence: null };
  }
  if (!/^bash(\.exe)?$/i.test(win32.basename(value))) {
    return { state: "needs-setup", why: `npm's script-shell is ${value}, not bash.`, evidence: value };
  }
  return { state: "satisfied", evidence: `script-shell = ${value}` };
}

/** Where the Visual Studio Installer keeps `vswhere.exe`, the tool node-gyp asks too. */
export function vswherePath(env: NodeJS.ProcessEnv = process.env): string {
  const programFiles = env["ProgramFiles(x86)"]?.trim() || "C:\\Program Files (x86)";
  return win32.join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
}

export const VC_TOOLS_COMPONENT = "Microsoft.VisualStudio.Component.VC.Tools.x86.x64";

export async function vsBuildToolsStatus(deps: SetupDeps): Promise<SetupStatus> {
  const vswhere = await deps.resolveBinPath(vswherePath());
  if (!vswhere) return { state: "missing" };
  const result = await deps.runCommand(vswhere, [
    "-latest", "-products", "*", "-requires", VC_TOOLS_COMPONENT, "-property", "installationPath",
  ]);
  if (result.outcomeUnknown || result.code !== 0) {
    return { state: "unknown", why: "The Visual Studio Installer could not be queried.", evidence: outputOf(result) };
  }
  const installation = result.stdout.trim().split(/\r?\n/)[0]?.trim();
  if (!installation) {
    return {
      state: "needs-setup",
      why: "Visual Studio is installed without the C++ build tools (the Desktop development with C++ workload).",
      evidence: vswhere,
    };
  }
  return { state: "satisfied", evidence: installation };
}

/** node-gyp's own search order: `python3`, then `python`, then the `py` launcher. */
const PYTHON_CANDIDATES: ReadonlyArray<{ bin: string; args: string[] }> = [
  { bin: "python3", args: ["--version"] },
  { bin: "python", args: ["--version"] },
  { bin: "py", args: ["-3", "--version"] },
];

/**
 * Windows' App Execution Alias for `python`/`python3`, which opens the Microsoft Store instead
 * of running. Never started, so Setup does not open the Store on every check; node-gyp skips
 * it the same way.
 */
const STORE_ALIAS = /[\\/]Microsoft[\\/]WindowsApps[\\/]/i;

export async function python3Status(deps: SetupDeps): Promise<SetupStatus> {
  const answered: string[] = [];
  for (const candidate of PYTHON_CANDIDATES) {
    const path = await deps.resolveBinPath(candidate.bin);
    if (!path) continue;
    if (STORE_ALIAS.test(path)) {
      answered.push(`${path}: the Microsoft Store alias, not run`);
      continue;
    }
    const result = await deps.runCommand(path, candidate.args);
    // Python 2 printed its version to stderr, so read both streams.
    const version = /Python (3\.\d+(?:\.\d+)?)/.exec(`${result.stdout} ${result.stderr}`)?.[1];
    if (!result.outcomeUnknown && result.code === 0 && version) {
      return { state: "satisfied", evidence: `${path} (Python ${version})` };
    }
    answered.push(`${path}: ${outputOf(result) ?? `exit ${result.code}`}`);
  }
  if (answered.length === 0) return { state: "missing" };
  return { state: "needs-setup", why: "No Python 3 interpreter was found.", evidence: answered.join("\n") };
}
