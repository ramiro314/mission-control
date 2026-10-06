import assert from "node:assert/strict";
import test from "node:test";

import type { SetupDependencyId } from "../src/shared/setup-catalog.ts";
import { SETUP_PROBES, setupChecksView, setupProbeResult } from "../src/server/setup/index.ts";
import type { SetupDeps } from "../src/server/setup/types.ts";
import { registryDword, VC_TOOLS_COMPONENT, vswherePath } from "../src/server/setup/windows.ts";
import { stubRun, type RunResult } from "../src/server/util/exec.ts";

const WINDOWS_IDS = [
  "git-for-windows",
  "windows-developer-mode",
  "windows-long-paths",
  "npm-script-shell",
  "vs-build-tools",
  "python3",
] as const satisfies readonly SetupDependencyId[];

const VSWHERE = vswherePath();
const VS_INSTALL = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools";

const regValue = (name: string, value: string) =>
  `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Example\r\n    ${name}    REG_DWORD    ${value}\r\n\r\n`;
const REG_MISSING = "ERROR: The system was unable to find the specified registry key or value.";

/** A Windows 11 machine with every prerequisite in place; each test breaks one thing. */
function healthy(bin: string, args: string[]): RunResult {
  if (bin === "reg") {
    return stubRun({ stdout: regValue(args[3]!, "0x1"), stderr: "", code: 0 });
  }
  if (bin === "C:\\Program Files\\Git\\cmd\\git.exe") {
    return stubRun({ stdout: "git version 2.47.1.windows.1\n", stderr: "", code: 0 });
  }
  if (bin === "cmd.exe") {
    return stubRun({ stdout: "C:\\Program Files\\Git\\bin\\bash.exe\r\n", stderr: "", code: 0 });
  }
  if (bin === VSWHERE) return stubRun({ stdout: `${VS_INSTALL}\r\n`, stderr: "", code: 0 });
  if (bin === "C:\\Python313\\python.exe") return stubRun({ stdout: "Python 3.13.1\r\n", stderr: "", code: 0 });
  return stubRun({ stdout: "", stderr: `unexpected ${bin}`, code: 1 });
}

const HEALTHY_PATHS: Record<string, string> = {
  git: "C:\\Program Files\\Git\\cmd\\git.exe",
  [VSWHERE]: VSWHERE,
  python: "C:\\Python313\\python.exe",
};

function deps(overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    hostPlatform: () => "win32",
    environment: {
      homeDir: "C:\\Users\\operator",
      readText: async () => ({ ok: false, missing: true, reason: "missing" }),
      subdirectories: async () => [],
    },
    agentBin: (agent) => `/tools/${agent}`,
    installedBackend: async () => null,
    herdrServer: async () => ({ state: "stopped", socket: "" }),
    cmuxControl: async () => ({ state: "stopped" }),
    ghBin: () => "gh",
    resolveBinPath: async (bin) => HEALTHY_PATHS[bin] ?? null,
    runCommand: async (bin, args) => healthy(bin, args),
    installedPlugins: async () => ({ ok: false, missing: true, reason: "missing", recordPath: "" }),
    skills: () => ({ enabled: true, readable: true, configured: 0, directories: [], problems: [] }),
    conductorProbe: async () => ({
      provider: "ai-conductor", found: false, bin: "conduct-ts", binPath: null, version: null,
      registryPath: "", projects: [], error: "missing", checkedAt: 1,
    }),
    terminalTargets: () => [],
    environmentChecks: async () => [],
    readBannerDismissal: () => ({ firstLaunchAcknowledged: false, acknowledged: [] }),
    writeBannerDismissal: () => {},
    ...overrides,
  };
}

async function probe(id: SetupDependencyId, overrides: Partial<SetupDeps> = {}) {
  return setupProbeResult(await SETUP_PROBES[id](deps(overrides))).status;
}

/** `healthy`, with one command answering differently. */
function answering(match: (bin: string, args: string[]) => boolean, result: Partial<RunResult>) {
  const answer: RunResult = { stdout: "", stderr: "", code: 0, outcomeUnknown: false, overflowed: false, ...result };
  return async (bin: string, args: string[]) => match(bin, args) ? answer : healthy(bin, args);
}

test("every Windows check passes on a prepared machine, with evidence", async () => {
  assert.deepEqual(await probe("git-for-windows"), {
    state: "satisfied",
    evidence: "C:\\Program Files\\Git\\cmd\\git.exe (git 2.47.1.windows.1)",
  });
  assert.deepEqual(await probe("windows-developer-mode"), {
    state: "satisfied",
    evidence: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock\\AllowDevelopmentWithoutDevLicense = 1",
  });
  assert.deepEqual(await probe("windows-long-paths"), {
    state: "satisfied",
    evidence: "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\\LongPathsEnabled = 1",
  });
  assert.deepEqual(await probe("npm-script-shell"), {
    state: "satisfied",
    evidence: "script-shell = C:\\Program Files\\Git\\bin\\bash.exe",
  });
  assert.deepEqual(await probe("vs-build-tools"), { state: "satisfied", evidence: VS_INSTALL });
  assert.deepEqual(await probe("python3"), { state: "satisfied", evidence: "C:\\Python313\\python.exe (Python 3.13.1)" });
});

test("the probes ask Windows the questions node-gyp and Git for Windows depend on", async () => {
  const calls: string[] = [];
  await Promise.all(WINDOWS_IDS.map((id) => probe(id, {
    runCommand: async (bin, args) => {
      calls.push([bin, ...args].join(" "));
      return healthy(bin, args);
    },
  })));
  assert.deepEqual(calls.sort(), [
    "C:\\Program Files\\Git\\cmd\\git.exe --version",
    "C:\\Python313\\python.exe --version",
    `${VSWHERE} -latest -products * -requires ${VC_TOOLS_COMPONENT} -property installationPath`,
    "cmd.exe /d /s /c npm config get script-shell",
    "reg query HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock /v AllowDevelopmentWithoutDevLicense",
    "reg query HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem /v LongPathsEnabled",
  ].sort());
  assert.equal(vswherePath({ "ProgramFiles(x86)": "D:\\Apps" }), "D:\\Apps\\Microsoft Visual Studio\\Installer\\vswhere.exe");
  assert.equal(vswherePath({}), "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe");
});

test("Git for Windows: missing, another git, and an unreadable version", async () => {
  assert.deepEqual(await probe("git-for-windows", { resolveBinPath: async () => null }), { state: "missing" });

  const other = await probe("git-for-windows", {
    runCommand: answering((bin) => bin.endsWith("git.exe"), { stdout: "git version 2.43.0\n" }),
  });
  assert.equal(other.state, "needs-setup");
  assert.match(other.state === "needs-setup" ? other.why : "", /2\.43\.0\) is not Git for Windows/);

  const silent = await probe("git-for-windows", {
    runCommand: answering((bin) => bin.endsWith("git.exe"), { code: 1, stderr: "boom" }),
  });
  assert.equal(silent.state, "unknown");
});

test("registry checks fail when the value is 0 or absent, and say unknown when reg cannot answer", async () => {
  for (const id of ["windows-developer-mode", "windows-long-paths"] as const) {
    const off = await probe(id, {
      runCommand: async (bin, args) => bin === "reg" ? stubRun({ stdout: regValue(args[3]!, "0x0"), stderr: "", code: 0 }) : healthy(bin, args),
    });
    assert.equal(off.state, "needs-setup", id);
    assert.match(off.state === "needs-setup" ? off.why : "", / is 0\.$/, id);

    const absent = await probe(id, { runCommand: answering((bin) => bin === "reg", { code: 1, stderr: REG_MISSING }) });
    assert.equal(absent.state, "needs-setup", id);
    assert.match(absent.state === "needs-setup" ? absent.why : "", / is not set\.$/, id);

    const noReg = await probe(id, {
      runCommand: answering((bin) => bin === "reg", { code: 1, stderr: 'executable "reg" was not found in the executable environment' }),
    });
    assert.equal(noReg.state, "unknown", id);

    const hung = await probe(id, { runCommand: answering((bin) => bin === "reg", { code: null, outcomeUnknown: true }) });
    assert.equal(hung.state, "unknown", id);
  }
  assert.match((await probe("windows-developer-mode", {
    runCommand: answering((bin) => bin === "reg", { code: 1, stderr: REG_MISSING }),
  }) as { why: string }).why, /^Developer Mode is off/);
});

test("registryDword reads only the named REG_DWORD", () => {
  assert.equal(registryDword(regValue("LongPathsEnabled", "0x1"), "LongPathsEnabled"), 1);
  assert.equal(registryDword(regValue("LongPathsEnabled", "0x0"), "LongPathsEnabled"), 0);
  assert.equal(registryDword(regValue("Other", "0x1"), "LongPathsEnabled"), null);
  assert.equal(registryDword("", "LongPathsEnabled"), null);
});

test("npm script-shell must name bash", async () => {
  const shell = (stdout: string) => probe("npm-script-shell", {
    runCommand: answering((bin) => bin === "cmd.exe", { stdout }),
  });
  for (const unset of ["\r\n", "undefined\r\n", "null\n"]) {
    const status = await shell(unset);
    assert.equal(status.state, "needs-setup", JSON.stringify(unset));
    assert.match(status.state === "needs-setup" ? status.why : "", /not set/);
  }
  const powershell = await shell("C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\n");
  assert.equal(powershell.state, "needs-setup");
  assert.match(powershell.state === "needs-setup" ? powershell.why : "", /pwsh\.exe, not bash/);
  assert.equal((await shell("C:/Program Files/Git/usr/bin/bash\n")).state, "satisfied");
  assert.equal((await probe("npm-script-shell", {
    runCommand: answering((bin) => bin === "cmd.exe", { code: 1, stderr: "'npm' is not recognized" }),
  })).state, "unknown");
});

test("Visual Studio Build Tools: no installer, no C++ workload, and a failed query", async () => {
  assert.deepEqual(await probe("vs-build-tools", { resolveBinPath: async (bin) => bin === VSWHERE ? null : HEALTHY_PATHS[bin] ?? null }), { state: "missing" });

  const noCpp = await probe("vs-build-tools", { runCommand: answering((bin) => bin === VSWHERE, { stdout: "" }) });
  assert.equal(noCpp.state, "needs-setup");
  assert.match(noCpp.state === "needs-setup" ? noCpp.why : "", /without the C\+\+ build tools/);

  assert.equal((await probe("vs-build-tools", { runCommand: answering((bin) => bin === VSWHERE, { code: 87 }) })).state, "unknown");
});

test("Python 3 follows node-gyp's order and skips the Store alias", async () => {
  assert.deepEqual(await probe("python3", { resolveBinPath: async () => null }), { state: "missing" });

  // Windows' Store alias resolves as `python3` and `python` on a machine with no Python, and
  // starting it opens the Microsoft Store. It is never run; the `py` launcher still is.
  const alias = (name: string) => `C:\\Users\\operator\\AppData\\Local\\Microsoft\\WindowsApps\\${name}.exe`;
  const paths: Record<string, string> = { python3: alias("python3"), python: alias("python"), py: "C:\\Windows\\py.exe" };
  const asked: string[] = [];
  const answer = async (bin: string, args: string[]) => {
    asked.push([bin, ...args].join(" "));
    return stubRun({ stdout: "Python 3.12.4\r\n", stderr: "", code: 0 });
  };
  const launcher = await probe("python3", { resolveBinPath: async (bin) => paths[bin] ?? null, runCommand: answer });
  assert.deepEqual(launcher, { state: "satisfied", evidence: "C:\\Windows\\py.exe (Python 3.12.4)" });
  assert.deepEqual(asked, [`${paths.py} -3 --version`], "only the launcher ran; the Store alias never started");

  asked.length = 0;
  const onlyAlias = await probe("python3", {
    resolveBinPath: async (bin) => bin === "py" ? null : paths[bin] ?? null,
    runCommand: answer,
  });
  assert.deepEqual(onlyAlias, {
    state: "needs-setup",
    why: "No Python 3 interpreter was found.",
    evidence: `${paths.python3}: the Microsoft Store alias, not run\n${paths.python}: the Microsoft Store alias, not run`,
  });
  assert.deepEqual(asked, []);

  const onlyTwo = await probe("python3", {
    resolveBinPath: async (bin) => bin === "python" ? "C:\\Python27\\python.exe" : null,
    runCommand: async () => stubRun({ stdout: "", stderr: "Python 2.7.18\r\n", code: 0 }),
  });
  assert.equal(onlyTwo.state, "needs-setup");
  assert.match(onlyTwo.state === "needs-setup" ? onlyTwo.evidence ?? "" : "", /Python 2\.7\.18/);
});

test("Setup reports the Windows rows on win32 only, and never probes them elsewhere", async () => {
  const windowsRows = (rows: Awaited<ReturnType<typeof setupChecksView>>["rows"]) =>
    rows.filter((row) => row.family === "windows").map((row) => row.rowId.id);

  const onWindows = await setupChecksView(deps());
  assert.deepEqual(windowsRows(onWindows.rows), [...WINDOWS_IDS]);
  assert.ok(onWindows.rows.filter((row) => row.family === "windows").every((row) => row.status.state === "satisfied"));

  for (const host of ["darwin", "linux"] as const) {
    const ran: string[] = [];
    const view = await setupChecksView(deps({
      hostPlatform: () => host,
      runCommand: async (bin, args) => {
        ran.push(bin);
        return healthy(bin, args);
      },
    }));
    assert.deepEqual(windowsRows(view.rows), [], host);
    for (const bin of ["reg", "cmd.exe", VSWHERE]) assert.ok(!ran.includes(bin), `${host} ran ${bin}`);
  }
});
