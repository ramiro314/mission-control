import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(repo, "scripts", "install-service.mjs");
const serviceEntry = join(repo, "scripts", "start-service.mjs");

// These cases wait for a newly spawned Node process to record readiness. Under the full
// concurrent suite, process scheduling can take several seconds before any fixture code runs.
// Keep the wait bounded without mistaking host contention for a service-entry failure.
const NATIVE_PROCESS_READY_TIMEOUT_MS = 15_000;

function plistProgramArguments(plist: string): string[] {
  const block = plist.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
  )?.[1];
  assert.ok(block, "the generated plist must contain ProgramArguments");
  return [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]!);
}

test("a fresh LaunchAgent enters through the native-build daemon entry", () => {
  const root = mkdtempSync(join(tmpdir(), "mission-install-service-native-"));
  const home = join(root, "home");
  const state = join(root, "state");
  const fakeBin = join(root, "bin");
  const launchctlLog = join(root, "launchctl.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "launchctl"),
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FAKE_LAUNCHCTL_LOG\"\n",
    { mode: 0o755 },
  );

  try {
    // Force the macOS branch so this contract remains testable on Linux CI. The child has an
    // isolated HOME, state directory, and launchctl, so it cannot touch an operator's service.
    const importInstaller = [
      'Object.defineProperty(process, "platform", { value: "darwin", configurable: true });',
      `await import(${JSON.stringify(pathToFileURL(installer).href)});`,
    ].join("\n");
    execFileSync(process.execPath, ["--input-type=module", "-e", importInstaller], {
      cwd: repo,
      env: {
        ...process.env,
        HOME: home,
        MISSION_HOME: state,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        FAKE_LAUNCHCTL_LOG: launchctlLog,
      },
      stdio: "pipe",
    });

    const plistPath = join(
      home,
      "Library",
      "LaunchAgents",
      "com.mission-control.daemon.plist",
    );
    const plist = readFileSync(plistPath, "utf8");
    assert.deepEqual(
      plistProgramArguments(plist),
      [process.execPath, serviceEntry],
      "launchd must enter through the checked-in native-build service entry",
    );
    assert.ok(existsSync(serviceEntry), "the LaunchAgent service entry must be checked in");

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A fake `systemctl` that records each call and answers `is-active` from FAKE_UNIT_ACTIVE, so
// the installer's systemd branch runs on any host without reaching a real user manager.
function runLinuxInstaller(
  root: string,
  args: string[],
  unitActive = false,
): { calls: string[]; stdout: string } {
  const home = join(root, "home");
  const fakeBin = join(root, "bin");
  const systemctlLog = join(root, "systemctl.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "systemctl"),
    "#!/bin/sh\n" +
      "printf '%s\\n' \"$*\" >> \"$FAKE_SYSTEMCTL_LOG\"\n" +
      'case "$2" in is-active) [ "$FAKE_UNIT_ACTIVE" = 1 ] || exit 3 ;; esac\n',
    { mode: 0o755 },
  );
  rmSync(systemctlLog, { force: true });
  const importInstaller = [
    'Object.defineProperty(process, "platform", { value: "linux", configurable: true });',
    `await import(${JSON.stringify(pathToFileURL(installer).href)});`,
  ].join("\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    MISSION_HOME: join(root, "state"),
    PATH: `${fakeBin}:/usr/bin:/bin`,
    FAKE_SYSTEMCTL_LOG: systemctlLog,
    FAKE_UNIT_ACTIVE: unitActive ? "1" : "0",
  };
  delete env.XDG_CONFIG_HOME;
  const stdout = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", importInstaller, "--", ...args],
    { cwd: repo, env, encoding: "utf8", stdio: "pipe" },
  );
  const calls = existsSync(systemctlLog)
    ? readFileSync(systemctlLog, "utf8").trim().split("\n")
    : [];
  return { calls, stdout };
}

test("on Linux a systemd user unit runs the native-build daemon entry and stops on exit 75", () => {
  const root = mkdtempSync(join(tmpdir(), "mission-install-service-systemd-"));
  const unitPath = join(root, "home", ".config", "systemd", "user", "mission-control.service");
  try {
    const { calls, stdout } = runLinuxInstaller(root, []);
    const quote = (value: string) => `"${value.replaceAll("%", "%%").replace(/[\\"]/g, "\\$&").replaceAll("$", "$$$$")}"`;
    const pathEnv = [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":");
    assert.equal(
      readFileSync(unitPath, "utf8"),
      [
        "[Unit]",
        "Description=Mission Control daemon",
        "",
        "[Service]",
        `ExecStart=${quote(process.execPath)} ${quote(serviceEntry)}`,
        `WorkingDirectory=${repo.replaceAll("%", "%%")}`,
        `Environment="PATH=${pathEnv.replaceAll("%", "%%")}"`,
        "Restart=always",
        "RestartSec=2",
        "RestartPreventExitStatus=75",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    );
    assert.deepEqual(calls, [
      "--user is-active --quiet mission-control.service",
      "--user daemon-reload",
      "--user enable --now mission-control.service",
    ]);
    assert.match(stdout, /journalctl --user -u mission-control/);
    assert.ok(
      !existsSync(join(root, "home", "Library")),
      "the Linux branch must not write a LaunchAgent",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("on Linux reinstalling restarts a running unit and --uninstall removes it", () => {
  const root = mkdtempSync(join(tmpdir(), "mission-install-service-systemd-"));
  const unitPath = join(root, "home", ".config", "systemd", "user", "mission-control.service");
  try {
    const reinstall = runLinuxInstaller(root, [], true);
    assert.deepEqual(reinstall.calls, [
      "--user is-active --quiet mission-control.service",
      "--user daemon-reload",
      "--user enable --now mission-control.service",
      "--user restart mission-control.service",
    ]);
    assert.ok(existsSync(unitPath));

    const removal = runLinuxInstaller(root, ["--uninstall"], true);
    assert.deepEqual(removal.calls, [
      "--user disable --now mission-control.service",
      "--user daemon-reload",
    ]);
    assert.equal(existsSync(unitPath), false, "--uninstall must delete the unit file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a systemd unit quotes a checkout path that systemd would otherwise split or expand", () => {
  // Run a copy of the installer from a checkout whose name has a space, a specifier and a
  // variable, with a stub runtime module so nothing else of the checkout is needed.
  const root = mkdtempSync(join(tmpdir(), "mission-install-service-quote-"));
  const checkout = join(root, "odd 50% $HOME dir");
  try {
    mkdirSync(join(checkout, "scripts"), { recursive: true });
    mkdirSync(join(checkout, "src", "shared"), { recursive: true });
    copyFileSync(installer, join(checkout, "scripts", "install-service.mjs"));
    writeFileSync(
      join(checkout, "src", "shared", "harness-runtime.mjs"),
      'export const BASE_URL = "http://127.0.0.1:7317";\nexport const stateDir = () => "/nonexistent";\n',
    );
    const fakeBin = join(root, "bin");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const importInstaller = [
      'Object.defineProperty(process, "platform", { value: "linux", configurable: true });',
      `await import(${JSON.stringify(pathToFileURL(join(checkout, "scripts", "install-service.mjs")).href)});`,
    ].join("\n");
    execFileSync(process.execPath, ["--input-type=module", "-e", importInstaller], {
      env: { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), PATH: `${fakeBin}:/usr/bin:/bin` },
      stdio: "pipe",
    });
    const unit = readFileSync(join(root, "config", "systemd", "user", "mission-control.service"), "utf8");
    assert.match(unit, /^ExecStart=".+" "\S*odd 50%% \$\$HOME dir\/scripts\/start-service\.mjs"$/m);
    assert.match(unit, /^WorkingDirectory=\S*odd 50%% \$HOME dir$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the LaunchAgent entry builds first and runs the daemon at its exact PID", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-start-service-native-"));
  const scripts = join(root, "scripts");
  const tsxDir = join(root, "node_modules", "tsx");
  const serverDir = join(root, "src", "server");
  const copiedEntry = join(scripts, "start-service.mjs");
  const eventsPath = join(root, "events.jsonl");
  const server = join(serverDir, "index.ts");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(tsxDir, { recursive: true });
  mkdirSync(serverDir, { recursive: true });
  copyFileSync(serviceEntry, copiedEntry);
  writeFileSync(
    join(scripts, "build-native.mjs"),
    `import { appendFileSync } from "node:fs";\n` +
      `appendFileSync(process.env.SERVICE_EVENT_LOG, JSON.stringify({ stage: "build", pid: process.pid }) + "\\n");\n`,
  );
  writeFileSync(
    join(tsxDir, "package.json"),
    JSON.stringify({
      name: "tsx",
      type: "module",
      exports: { "./esm/api": "./index.mjs" },
    }),
  );
  writeFileSync(join(tsxDir, "index.mjs"), "export const register = () => {};\n");
  // The daemon record is the parent's readiness signal, so publish it only after the fixture
  // can handle the SIGTERM the parent sends immediately after observing that record.
  writeFileSync(
    server,
    `import { appendFileSync } from "node:fs";\n` +
      `const record = (event) => appendFileSync(process.env.SERVICE_EVENT_LOG, JSON.stringify(event) + "\\n");\n` +
      `process.on("SIGTERM", () => { record({ stage: "signal", pid: process.pid, signal: "SIGTERM" }); process.exit(0); });\n` +
      `record({ stage: "daemon", pid: process.pid, args: process.argv.slice(1) });\n` +
      `setInterval(() => {}, 1_000);\n`,
  );

  try {
    const child = spawn(process.execPath, [copiedEntry], {
      cwd: root,
      env: { ...process.env, SERVICE_EVENT_LOG: eventsPath },
      stdio: "pipe",
    });
    const servicePid = child.pid;
    assert.ok(servicePid, "the service entry must start");
    const exitPromise = once(child, "exit");

    const deadline = Date.now() + NATIVE_PROCESS_READY_TIMEOUT_MS;
    let recorded = "";
    while (!recorded.includes('"stage":"daemon"') && Date.now() < deadline) {
      await delay(20);
      recorded = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "";
    }
    assert.match(recorded, /"stage":"daemon"/, "the daemon must record its start");
    child.kill("SIGTERM");

    const [code, signal] = (await exitPromise) as [number | null, NodeJS.Signals | null];
    assert.equal(signal, null);
    assert.equal(code, 0);

    const events = readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) =>
        JSON.parse(line) as { stage: string; pid: number; args?: string[]; signal?: string },
      );
    assert.deepEqual(events.map((event) => event.stage), ["build", "daemon", "signal"]);
    assert.notEqual(events[0]!.pid, servicePid, "the bounded build runs as a child");
    assert.equal(events[1]!.pid, servicePid, "the daemon keeps launchd's exact service PID");
    assert.notEqual(events[1]!.pid, events[0]!.pid, "the build exits before the daemon starts");
    assert.deepEqual(events[1]!.args, [realpathSync(server)]);
    assert.deepEqual(events[2], {
      stage: "signal",
      pid: events[1]!.pid,
      signal: "SIGTERM",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function assertBuildStopSignal(testedSignal: NodeJS.Signals): Promise<void> {
  const root = mkdtempSync(
    join(tmpdir(), `mission-start-service-build-${testedSignal.toLowerCase()}-`),
  );
  const scripts = join(root, "scripts");
  const tsxDir = join(root, "node_modules", "tsx");
  const serverDir = join(root, "src", "server");
  const copiedEntry = join(scripts, "start-service.mjs");
  const eventsPath = join(root, "events.jsonl");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(tsxDir, { recursive: true });
  mkdirSync(serverDir, { recursive: true });
  copyFileSync(serviceEntry, copiedEntry);
  writeFileSync(
    join(scripts, "build-native.mjs"),
    `import { appendFileSync } from "node:fs";\n` +
      `const record = (event) => appendFileSync(process.env.SERVICE_EVENT_LOG, JSON.stringify(event) + "\\n");\n` +
      `const signal = process.env.SERVICE_TEST_SIGNAL;\n` +
      `process.on(signal, () => { record({ stage: "build-signal", pid: process.pid, signal }); process.exit(0); });\n` +
      `record({ stage: "build-start", pid: process.pid });\n` +
      `setInterval(() => {}, 1_000);\n`,
  );
  writeFileSync(
    join(tsxDir, "package.json"),
    JSON.stringify({
      name: "tsx",
      type: "module",
      exports: { "./esm/api": "./index.mjs" },
    }),
  );
  writeFileSync(join(tsxDir, "index.mjs"), "export const register = () => {};\n");
  writeFileSync(
    join(serverDir, "index.ts"),
    `import { appendFileSync } from "node:fs";\n` +
      `appendFileSync(process.env.SERVICE_EVENT_LOG, JSON.stringify({ stage: "daemon", pid: process.pid }) + "\\n");\n`,
  );

  let child: ReturnType<typeof spawn> | null = null;
  let closePromise: ReturnType<typeof once> | null = null;
  let buildProcessGroupPid: number | null = null;
  let cleanupError: unknown = null;
  try {
    child = spawn(process.execPath, [copiedEntry], {
      cwd: root,
      env: {
        ...process.env,
        SERVICE_EVENT_LOG: eventsPath,
        SERVICE_TEST_SIGNAL: testedSignal,
      },
      stdio: "pipe",
    });
    closePromise = once(child, "close");
    const servicePid = child.pid;
    assert.ok(servicePid, "the service entry must start");
    const exitPromise = once(child, "exit");

    // Native build startup competes with other process-heavy files in the full suite. Keep
    // polling because this assertion is about signal forwarding after the build starts, not
    // scheduler latency before the fixture child gets its first turn.
    const deadline = Date.now() + NATIVE_PROCESS_READY_TIMEOUT_MS;
    let recorded = "";
    while (!recorded.includes('"stage":"build-start"') && Date.now() < deadline) {
      await delay(20);
      recorded = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "";
    }
    assert.match(recorded, /"stage":"build-start"/, "the native build must start");
    buildProcessGroupPid = (
      recorded
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { stage: string; pid: number })
        .find((event) => event.stage === "build-start")?.pid ?? null
    );
    child.kill(testedSignal);

    const [code, signal] = (await exitPromise) as [number | null, NodeJS.Signals | null];
    assert.equal(signal, null);
    assert.equal(code, 0);

    const events = readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { stage: string; pid: number; signal?: NodeJS.Signals },
      );
    assert.deepEqual(events.map((event) => event.stage), ["build-start", "build-signal"]);
    assert.notEqual(events[0]!.pid, servicePid, "the bounded build runs as a child");
    assert.equal(events[1]!.signal, testedSignal);
  } finally {
    // Let start-service forward SIGTERM to its detached native-build group. If the fixture is
    // itself wedged, kill the recorded group and service only after the grace, then wait for its
    // pipes to close before removing the directory they reference.
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const closed = closePromise
        ? await Promise.race([
            closePromise.then(() => true, () => true),
            delay(1_000).then(() => false),
          ])
        : true;
      if (!closed) {
        if (buildProcessGroupPid !== null) {
          try {
            process.kill(-buildProcessGroupPid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupError = error;
          }
        }
        child.kill("SIGKILL");
      }
    }
    if (closePromise) await closePromise.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
  if (cleanupError) throw cleanupError;
}

test("the LaunchAgent entry stops cleanly on every supported signal during the build", async (t) => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] as const) {
    await t.test(signal, () => assertBuildStopSignal(signal));
  }
});
