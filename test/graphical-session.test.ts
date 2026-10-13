import assert from "node:assert/strict";
import test from "node:test";

import {
  graphicalSessionEnv,
  guiSpawn,
  NO_GRAPHICAL_SESSION,
  parseManagerEnvironment,
  unscoped,
  userScope,
  type GraphicalSessionDeps,
} from "../src/server/graphical-session.ts";
import { openFile } from "../src/server/open-targets/index.ts";
import type { OpenDeps } from "../src/server/open-targets/types.ts";
import { createHerdrClient, HERDR_MIN_PROTOCOL, HERDR_MIN_VERSION } from "../src/server/terminal/herdr-client.ts";
import { HERDR_BIN } from "../src/server/terminal/herdr.ts";
import { ghosttyEmulator } from "../src/server/terminal/ghostty.ts";
import { SEP, tmuxMultiplexer } from "../src/server/terminal/tmux.ts";
import { xdgTerminalEmulator, type XdgTerminalLauncher } from "../src/server/terminal/xdg-terminal.ts";
import type { TerminalExec } from "../src/server/terminal/exec.ts";
import { stubRun } from "../src/server/util/exec.ts";

// What is at stake: on Linux a daemon started by the systemd user manager has no display of its
// own, and one started from a desktop keeps a display that goes stale after a re-login. Every GUI
// program the daemon starts must get a display that is actually there, as one coherent set, or
// fail with the one sentence that says why. And every process that must outlive the daemon - the
// tmux and Herdr servers, a terminal window, a browser - must leave the daemon's cgroup, or a
// restart kills it and every agent inside.

const RUNTIME = "/run/user/1000";
const WAYLAND_SOCKET = `${RUNTIME}/wayland-0`;
const X0 = "/tmp/.X11-unix/X0";
const X1 = "/tmp/.X11-unix/X1";

/** A desktop session's full display set. */
function desktop(over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    XDG_RUNTIME_DIR: RUNTIME,
    WAYLAND_DISPLAY: "wayland-0",
    DISPLAY: ":0",
    XAUTHORITY: "/run/user/1000/xauth_old",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_CURRENT_DESKTOP: "KDE",
    XDG_SESSION_TYPE: "wayland",
    ...over,
  };
}

function sources(opts: {
  own: NodeJS.ProcessEnv;
  manager: NodeJS.ProcessEnv | null;
  sockets: readonly string[];
  platform?: NodeJS.Platform;
}): GraphicalSessionDeps & { managerReads: () => number } {
  let reads = 0;
  return {
    platform: opts.platform ?? "linux",
    env: opts.own,
    managerEnvironment: async () => {
      reads += 1;
      return opts.manager;
    },
    socketExists: (path) => opts.sockets.includes(path),
    managerReads: () => reads,
  };
}

const BASE = { PATH: "/usr/bin", HOME: "/home/op" };

test("under the user manager its current environment wins over a set own environment", async () => {
  const deps = sources({
    own: desktop({ INVOCATION_ID: "abc", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }),
    manager: desktop({ WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":1", XAUTHORITY: "/run/user/1000/xauth_new" }),
    sockets: [WAYLAND_SOCKET, `${RUNTIME}/wayland-1`, X0, X1],
  });
  const session = await graphicalSessionEnv(BASE, deps);
  assert.equal(session.ok, true);
  assert.ok(session.ok);
  assert.equal(session.env.WAYLAND_DISPLAY, "wayland-1");
  assert.equal(session.env.DISPLAY, ":1");
  assert.equal(session.env.XAUTHORITY, "/run/user/1000/xauth_new");
  assert.equal(session.env.PATH, "/usr/bin", "the rest of the spawn's environment is kept");
});

test("outside the user manager the daemon's own environment wins, and the manager is never asked", async () => {
  const deps = sources({
    own: desktop(),
    manager: desktop({ WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":1" }),
    sockets: [WAYLAND_SOCKET, `${RUNTIME}/wayland-1`, X0, X1],
  });
  const session = await graphicalSessionEnv(BASE, deps);
  assert.ok(session.ok);
  assert.equal(session.env.WAYLAND_DISPLAY, "wayland-0");
  assert.equal(session.env.DISPLAY, ":0");
  assert.equal(deps.managerReads(), 0);
});

test("a stale own display falls through to the manager's", async () => {
  // After a re-login with linger on: the daemon still holds the old session's display, whose
  // sockets are gone, and the manager learned the new one.
  const deps = sources({
    own: desktop({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }),
    manager: desktop({ WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":1", XDG_CURRENT_DESKTOP: "GNOME" }),
    sockets: [`${RUNTIME}/wayland-1`, X1],
  });
  const session = await graphicalSessionEnv(BASE, deps);
  assert.ok(session.ok);
  assert.equal(session.env.WAYLAND_DISPLAY, "wayland-1");
  assert.equal(session.env.XDG_CURRENT_DESKTOP, "GNOME");
  assert.equal(deps.managerReads(), 1);
});

test("both sources stale gives the named no-display refusal", async () => {
  for (const own of [desktop(), desktop({ INVOCATION_ID: "abc" })]) {
    const deps = sources({ own, manager: desktop({ DISPLAY: ":1" }), sockets: [] });
    assert.deepEqual(await graphicalSessionEnv(BASE, deps), { ok: false, error: NO_GRAPHICAL_SESSION });
  }
  // An unreadable manager and a daemon with no display at all is the same answer.
  const bare = sources({ own: { INVOCATION_ID: "abc" }, manager: null, sockets: [X0] });
  assert.deepEqual(await graphicalSessionEnv(BASE, bare), { ok: false, error: NO_GRAPHICAL_SESSION });
  assert.match(NO_GRAPHICAL_SESSION, /^No graphical session is reachable from the Mission Control daemon/);
});

test("the display variables come as one set from one source, never mixed", async () => {
  // The manager has only an X display: the spawn must not keep the daemon's own Wayland name,
  // XAUTHORITY or desktop, which belong to a different session.
  const deps = sources({
    own: desktop({ INVOCATION_ID: "abc" }),
    manager: { XDG_RUNTIME_DIR: RUNTIME, DISPLAY: ":1" },
    sockets: [WAYLAND_SOCKET, X0, X1],
  });
  const base = { ...BASE, ...desktop() };
  const session = await graphicalSessionEnv(base, deps);
  assert.ok(session.ok);
  assert.equal(session.env.DISPLAY, ":1");
  for (const key of ["WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE"]) {
    assert.equal(session.env[key], undefined, key);
  }
});

test("display sockets resolve the way clients resolve them", async () => {
  const absolute = sources({ own: { WAYLAND_DISPLAY: "/tmp/wl.sock" }, manager: null, sockets: ["/tmp/wl.sock"] });
  assert.equal((await graphicalSessionEnv(BASE, absolute)).ok, true, "an absolute WAYLAND_DISPLAY names its socket");
  const screen = sources({ own: { DISPLAY: ":0.0" }, manager: null, sockets: [X0] });
  assert.equal((await graphicalSessionEnv(BASE, screen)).ok, true, "a screen number still means display 0");
  const remote = sources({ own: { DISPLAY: "workstation:10" }, manager: null, sockets: [] });
  assert.equal((await graphicalSessionEnv(BASE, remote)).ok, true, "a remote display has no local socket to check");
  const noRuntime = sources({ own: { WAYLAND_DISPLAY: "wayland-0" }, manager: null, sockets: [WAYLAND_SOCKET] });
  assert.equal((await graphicalSessionEnv(BASE, noRuntime)).ok, false, "a relative name needs XDG_RUNTIME_DIR");
});

test("macOS spawns are unchanged: no display read, no refusal", async () => {
  const deps = sources({ own: {}, manager: null, sockets: [], platform: "darwin" });
  assert.deepEqual(await graphicalSessionEnv(BASE, deps), { ok: true, env: BASE });
  assert.equal(deps.managerReads(), 0);
});

test("the manager's environment is read from its KEY=VALUE lines", () => {
  assert.deepEqual(
    parseManagerEnvironment("DISPLAY=:1\nWAYLAND_DISPLAY=wayland-0\nDBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus\n\n"),
    { DISPLAY: ":1", WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
  );
});

const SYSTEMD_RUN = "/usr/bin/systemd-run";
const SCOPE_PREFIX = ["--user", "--scope", "--quiet", "--collect", "--slice=app.slice", "--"];
const BUS = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };
const scoped = userScope({ platform: "linux", systemdRun: () => SYSTEMD_RUN, socketExists: () => false });
const noSystemdRun = userScope({ platform: "linux", systemdRun: () => null, socketExists: () => true });
const macScope = userScope({ platform: "darwin", systemdRun: () => SYSTEMD_RUN, socketExists: () => true });

test("with systemd-run each command runs in its own scope in app.slice", () => {
  assert.deepEqual(scoped("/usr/bin/tmux", ["new-session", "-d"], BUS), {
    bin: SYSTEMD_RUN,
    args: [...SCOPE_PREFIX, "/usr/bin/tmux", "new-session", "-d"],
  });
  // The bus socket under XDG_RUNTIME_DIR is as good as the address.
  const viaRuntime = userScope({
    platform: "linux",
    systemdRun: () => SYSTEMD_RUN,
    socketExists: (path) => path === `${RUNTIME}/bus`,
  });
  assert.equal(viaRuntime("/usr/bin/herdr", ["server"], { XDG_RUNTIME_DIR: RUNTIME }).bin, SYSTEMD_RUN);
});

test("without systemd-run, or a user bus to reach the manager, a command starts as today", () => {
  const raw = { bin: "/usr/bin/tmux", args: ["new-session"] };
  assert.deepEqual(noSystemdRun("/usr/bin/tmux", ["new-session"], BUS), raw);
  assert.deepEqual(scoped("/usr/bin/tmux", ["new-session"], {}), raw);
  assert.deepEqual(macScope("/usr/bin/tmux", ["new-session"], BUS), raw, "macOS is unchanged");
  assert.deepEqual(unscoped("/usr/bin/tmux", ["new-session"], BUS), raw);
});

/** A GUI preparation over a live desktop, with or without systemd-run. */
const liveDesktop = () => sources({ own: desktop(), manager: null, sockets: [WAYLAND_SOCKET, X0] });
const noDesktop = () => sources({ own: {}, manager: null, sockets: [] });

function recordingExec(stdout = "") {
  const calls: { bin: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const exec: TerminalExec = async (bin, args, opts) => {
    calls.push({ bin, args, env: opts?.env });
    return stubRun({ stdout, stderr: "", code: 0 });
  };
  return { calls, exec };
}

test("the Linux Ghostty raise runs scoped with the live display, or unscoped without systemd-run", async () => {
  const spec = { argv: ["tmux", "attach", "-t", "work"], title: "work", cwd: null };
  const withScope = recordingExec();
  await ghosttyEmulator(withScope.exec, "linux", guiSpawn(liveDesktop(), scoped)).spawn!.tab(spec);
  assert.equal(withScope.calls[0]!.bin, SYSTEMD_RUN);
  assert.deepEqual(withScope.calls[0]!.args.slice(0, SCOPE_PREFIX.length), SCOPE_PREFIX);
  assert.match(withScope.calls[0]!.args[SCOPE_PREFIX.length]!, /ghostty$/);
  assert.deepEqual(withScope.calls[0]!.args.slice(SCOPE_PREFIX.length + 1), ["+new-window", "--title=work", "-e", ...spec.argv]);
  assert.equal(withScope.calls[0]!.env?.WAYLAND_DISPLAY, "wayland-0");

  const without = recordingExec();
  await ghosttyEmulator(without.exec, "linux", guiSpawn(liveDesktop(), noSystemdRun)).spawn!.tab(spec);
  assert.match(without.calls[0]!.bin, /ghostty$/);
  assert.equal(without.calls[0]!.args[0], "+new-window");
});

test("the Linux Ghostty raise with no display fails with the named message and runs nothing", async () => {
  const { calls, exec } = recordingExec();
  const opened = await ghosttyEmulator(exec, "linux", guiSpawn(noDesktop(), scoped)).spawn!.tab({
    argv: ["sh"],
    title: "t",
    cwd: null,
  });
  assert.deepEqual(opened, { ok: false, error: NO_GRAPHICAL_SESSION, outcomeUnknown: false, target: null });
  assert.equal(calls.length, 0);
});

test("the default terminal runs each launcher scoped, and stops at no display", async () => {
  const XDG: XdgTerminalLauncher = { name: "xdg-terminal-exec", path: "/usr/bin/xdg-terminal-exec", env: {}, prefix: [] };
  const TERM: XdgTerminalLauncher = { name: "$TERMINAL (konsole)", path: "/usr/bin/konsole", env: {}, prefix: ["-e"] };
  const launch = (prepareGui: ReturnType<typeof guiSpawn>, answers: Record<string, boolean>) => {
    const started: { path: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const emulator = xdgTerminalEmulator({
      launchers: () => [XDG, TERM],
      launch: async (launcher, args) => {
        started.push({ path: launcher.path, args: [...launcher.prefix, ...args], env: launcher.env });
        const ok = answers[args[SCOPE_PREFIX.length] ?? ""] ?? true;
        return ok ? { ok: true, outcomeUnknown: false } : { ok: false, error: "refused", outcomeUnknown: false };
      },
      settleMs: 0,
      prepareGui,
    });
    return { emulator, started };
  };

  // xdg-terminal-exec refuses, so `$TERMINAL -e` is tried, each in its own scope.
  const { emulator, started } = launch(guiSpawn(liveDesktop(), scoped), { "/usr/bin/xdg-terminal-exec": false });
  const opened = await emulator.spawn!.tab({ argv: ["/usr/bin/tmux", "attach"], title: "w", cwd: null });
  assert.equal(opened.ok, true);
  assert.deepEqual(started.map((s) => [s.path, ...s.args]), [
    [SYSTEMD_RUN, ...SCOPE_PREFIX, "/usr/bin/xdg-terminal-exec", "/usr/bin/tmux", "attach"],
    [SYSTEMD_RUN, ...SCOPE_PREFIX, "/usr/bin/konsole", "-e", "/usr/bin/tmux", "attach"],
  ]);
  assert.equal(started[0]!.env.DISPLAY, ":0");

  const unscopedRun = launch(guiSpawn(liveDesktop(), noSystemdRun), {});
  await unscopedRun.emulator.spawn!.tab({ argv: ["/usr/bin/tmux", "attach"], title: "w", cwd: null });
  assert.deepEqual(unscopedRun.started.map((s) => [s.path, ...s.args]), [
    ["/usr/bin/xdg-terminal-exec", "/usr/bin/tmux", "attach"],
  ]);

  const headless = launch(guiSpawn(noDesktop(), scoped), {});
  assert.deepEqual(
    await headless.emulator.spawn!.tab({ argv: ["/usr/bin/tmux", "attach"], title: "w", cwd: null }),
    { ok: false, error: NO_GRAPHICAL_SESSION, outcomeUnknown: false, target: null },
  );
  assert.equal(headless.started.length, 0, "no launcher is tried without a display");
});

function openDeps(platform: NodeJS.Platform, prepareGui: OpenDeps["prepareGui"], installed: string[]) {
  const calls: { bin: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const deps: OpenDeps = {
    platform,
    env: { HOME: "/home/op", PATH: "/usr/bin" },
    installed: (bin) => installed.includes(bin),
    prepareGui,
    run: async (bin, args, opts) => {
      calls.push({ bin, args, env: opts?.env });
      if (bin === "plutil") return stubRun({ stdout: "", stderr: "", code: 1 });
      return stubRun({ stdout: "", stderr: "", code: 0 });
    },
  };
  return { deps, calls };
}

test("xdg-open runs scoped with the live display, or unscoped without systemd-run", async () => {
  const scopedOpen = openDeps("linux", guiSpawn(liveDesktop(), scoped), ["xdg-open"]);
  assert.equal((await openFile("browser", "/w/mock.html", scopedOpen.deps)).ok, true);
  assert.deepEqual(scopedOpen.calls, [
    { bin: SYSTEMD_RUN, args: [...SCOPE_PREFIX, "xdg-open", "/w/mock.html"], env: scopedOpen.calls[0]!.env },
  ]);
  assert.equal(scopedOpen.calls[0]!.env?.XDG_CURRENT_DESKTOP, "KDE");

  const plain = openDeps("linux", guiSpawn(liveDesktop(), noSystemdRun), ["xdg-open"]);
  await openFile("browser", "/w/mock.html", plain.deps);
  assert.deepEqual(plain.calls.map((c) => [c.bin, ...c.args]), [["xdg-open", "/w/mock.html"]]);
});

test("gtk-launch runs scoped too", async () => {
  const { deps, calls } = openDeps("linux", guiSpawn(liveDesktop(), scoped), ["gtk-launch", "xdg-settings"]);
  deps.run = async (bin, args, opts) => {
    calls.push({ bin, args, env: opts?.env });
    return stubRun({ stdout: bin === "xdg-settings" ? "firefox.desktop\n" : "", stderr: "", code: 0 });
  };
  await openFile("browser", "/w/mock.html", deps);
  assert.deepEqual(calls.at(-1)!.args, [...SCOPE_PREFIX, "gtk-launch", "firefox.desktop", "/w/mock.html"]);
  assert.equal(calls.at(-1)!.bin, SYSTEMD_RUN);
});

test("an open target with no display fails with the named message where open-target errors appear", async () => {
  const { deps, calls } = openDeps("linux", guiSpawn(noDesktop(), scoped), ["xdg-open"]);
  assert.deepEqual(await openFile("browser", "/w/mock.html", deps), {
    ok: false,
    label: "Browser",
    detail: null,
    error: NO_GRAPHICAL_SESSION,
    status: 409,
  });
  assert.equal(calls.length, 0);
});

test("macOS open is unchanged", async () => {
  const mac = sources({ own: {}, manager: null, sockets: [], platform: "darwin" });
  const { deps, calls } = openDeps("darwin", guiSpawn(mac, macScope), []);
  assert.equal((await openFile("browser", "/w/mock.html", deps)).ok, true);
  assert.deepEqual(calls.at(-1), {
    bin: "open",
    args: ["-b", "com.apple.Safari", "/w/mock.html"],
    env: { HOME: "/home/op", PATH: "/usr/bin" },
  });
});

test("tmux starts its session, and so its server, in a scope; later commands are plain", async () => {
  // The address `new-session -P` prints, so the side pane is split into the new session.
  const { calls, exec } = recordingExec(["/tmp/test-tmux.sock", "123", "456", "$7"].join(SEP));
  // `binEnv` copies the daemon's own environment, whose bus would decide; pin it.
  const withBus: typeof scoped = (bin, args, env) => scoped(bin, args, { ...env, ...BUS });
  await tmuxMultiplexer(exec, withBus).sessions!.spawnDetached({
    name: "api",
    cwd: "/w/api",
    argv: ["claude"],
    sidePane: true,
    select: false,
  });
  assert.equal(calls[0]!.bin, SYSTEMD_RUN);
  assert.deepEqual(calls[0]!.args.slice(0, SCOPE_PREFIX.length), SCOPE_PREFIX);
  assert.match(calls[0]!.args[SCOPE_PREFIX.length]!, /tmux$/);
  assert.equal(calls[0]!.args[SCOPE_PREFIX.length + 1], "new-session");
  assert.notEqual(calls[1]!.bin, SYSTEMD_RUN, "the side pane joins the server; it starts nothing");

  const plain = recordingExec();
  await tmuxMultiplexer(plain.exec, noSystemdRun).sessions!.spawnDetached({
    name: "api", cwd: "/w/api", argv: ["claude"], sidePane: false, select: false,
  });
  assert.equal(plain.calls[0]!.args[0], "new-session");
});

test("Herdr starts its server in a scope, or plainly without systemd-run", async () => {
  const status = (running: boolean) => stubRun({
    stdout: JSON.stringify({
      status: running ? "running" : "not_running",
      running,
      version: running ? HERDR_MIN_VERSION : null,
      protocol: running ? HERDR_MIN_PROTOCOL : null,
      capabilities: {},
      compatible: running ? true : null,
      socket: "/tmp/herdr.sock",
      session: null,
      restart_needed: false,
    }),
    stderr: "",
    code: 0,
  });
  for (const [scope, expected] of [
    [scoped, SYSTEMD_RUN],
    [noSystemdRun, null],
  ] as const) {
    let probes = 0;
    let clock = 0;
    const started: { bin: string; args: readonly string[] }[] = [];
    const client = createHerdrClient(async () => status(++probes > 1), HERDR_BIN, {
      scope: (bin, args, env) => scope(bin, args, { ...env, ...BUS }),
      spawnDetached: (bin, args) => {
        started.push({ bin, args });
        return { unref() {} };
      },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      actionTimeoutMs: 500,
      readyPollMs: 10,
    });
    assert.equal((await client.ensureReady()).ok, true);
    assert.equal(started.length, 1);
    if (expected) {
      assert.equal(started[0]!.bin, expected);
      assert.deepEqual(started[0]!.args.slice(0, SCOPE_PREFIX.length), SCOPE_PREFIX);
      assert.deepEqual(started[0]!.args.slice(-1), ["server"]);
    } else {
      assert.match(started[0]!.bin, /herdr$/);
      assert.deepEqual(started[0]!.args, ["server"]);
    }
  }
});
