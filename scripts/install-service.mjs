#!/usr/bin/env node
// Install (or remove) the Mission Control daemon as a per-user service so it starts at
// login and stays running: a launchd LaunchAgent on macOS, a systemd user unit on Linux.
// Opt-in: the user runs `npm run install-service`.

import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { BASE_URL, stateDir } from "../src/shared/harness-runtime.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const serviceEntry = join(repo, "scripts", "start-service.mjs");
const uninstall = process.argv.includes("--uninstall");

// The service manager starts with a minimal PATH; include node's dir + common tool dirs so
// the daemon can shell out to ps / tmux / git / wezterm.
const pathDirs = (extra) => [dirname(node), ...extra, "/usr/local/bin", "/usr/bin", "/bin"].join(":");

function installLaunchAgent() {
  const LABEL = "com.mission-control.daemon";
  // Prior label(s) we may still need to unload/remove on an in-place upgrade so a
  // stale daemon under the old label doesn't linger (or double-bind the port).
  // Every name this app has gone by, oldest included: an install from any of them is
  // still out there running, and a leftover would double-bind the port.
  const LEGACY_LABELS = ["com.fleet-control.daemon", "com.ai-harness.daemon"];
  const state = stateDir();
  const logFile = join(state, "daemon.log");
  const plistFor = (label) => join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const plistPath = plistFor(LABEL);

  function tryLaunchctl(...args) {
    try {
      execFileSync("launchctl", args, { stdio: "ignore" });
    } catch {
      /* ignore - unload of a not-loaded job errors harmlessly */
    }
  }

  /** Unload + delete a label's plist, if present. */
  function removeLabel(label) {
    const p = plistFor(label);
    tryLaunchctl("unload", p);
    if (existsSync(p)) rmSync(p);
  }

  // Always clear any prior-label install first, so an upgrade never leaves a
  // second daemon running (both would fight over the port).
  for (const legacy of LEGACY_LABELS) removeLabel(legacy);

  if (uninstall) {
    removeLabel(LABEL);
    console.log(`Removed LaunchAgent ${LABEL}`);
    return false;
  }

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${serviceEntry}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${repo}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathDirs(["/opt/homebrew/bin"])}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
</dict>
</plist>
`;

  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(plistPath, plist);
  tryLaunchctl("unload", plistPath);
  execFileSync("launchctl", ["load", plistPath], { stdio: "inherit" });

  console.log(`Installed and started LaunchAgent ${LABEL}`);
  console.log(`  plist: ${plistPath}`);
  console.log(`  logs:  ${logFile}`);
  return true;
}

// systemd expands `%` specifiers in every value, and `$` variables in ExecStart. Quote each
// value so a checkout path with spaces stays one word.
const specifierSafe = (value) => value.replaceAll("%", "%%");
const quoted = (value) => `"${specifierSafe(value).replace(/[\\"]/g, "\\$&")}"`;
const execArg = (value) => quoted(value).replaceAll("$", "$$$$");

function installSystemdUnit() {
  const UNIT = "mission-control.service";
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const unitPath = join(configHome, "systemd", "user", UNIT);
  const systemctl = (...args) => execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  const isActive = () => {
    try {
      execFileSync("systemctl", ["--user", "is-active", "--quiet", UNIT], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  if (uninstall) {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", UNIT], { stdio: "ignore" });
    } catch {
      /* ignore - disabling a unit that was never installed errors harmlessly */
    }
    if (existsSync(unitPath)) rmSync(unitPath);
    systemctl("daemon-reload");
    console.log(`Removed systemd user unit ${UNIT}`);
    return false;
  }

  // The unit carries no display variables and is wanted by default.target rather than
  // graphical-session.target: GUI spawns read the user manager's environment at spawn time,
  // and a window manager that never reaches graphical-session.target would never start it.
  // Exit 75 is state-lock contention (another daemon owns this state home): stop instead of
  // restart-looping into the failed state.
  const unit = `[Unit]
Description=Mission Control daemon

[Service]
ExecStart=${execArg(node)} ${execArg(serviceEntry)}
WorkingDirectory=${specifierSafe(repo)}
Environment=${quoted(`PATH=${pathDirs([])}`)}
Restart=always
RestartSec=2
RestartPreventExitStatus=75

[Install]
WantedBy=default.target
`;

  const wasActive = isActive();
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, unit);
  systemctl("daemon-reload");
  systemctl("enable", "--now", UNIT);
  // `enable --now` leaves an already-running daemon on the previous unit's command line, so a
  // reinstall restarts it, as the LaunchAgent's unload and load do.
  if (wasActive) systemctl("restart", UNIT);

  console.log(`Installed and started systemd user unit ${UNIT}`);
  console.log(`  unit: ${unitPath}`);
  console.log(`  logs: journalctl --user -u mission-control -f`);
  console.log(`\nWithout linger the unit stops when you log out; \`loginctl enable-linger\` keeps it running.`);
  return true;
}

const os = platform();
if (os !== "darwin" && os !== "linux") {
  console.error("This installer supports macOS (launchd) and Linux (systemd user units).");
  process.exit(1);
}

if (os === "darwin" ? installLaunchAgent() : installSystemdUnit()) {
  console.log(`\nThe dashboard is at ${BASE_URL}`);
  console.log(`Stop/remove with:  npm run install-service -- --uninstall`);
  // The desktop app has its own "Start at login" and adopts a running daemon rather than
  // double-binding the port, so the two coexist safely - but pick one to avoid two "start at
  // login" mechanisms. This service is best for a headless daemon (no app window).
  console.log(`\nNote: if you also run the Mission Control desktop app, it will ADOPT this`);
  console.log(`daemon (no double-bind). Use one "start at login" mechanism to avoid confusion.`);
}
